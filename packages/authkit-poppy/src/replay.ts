/**
 * Proteção contra replay (`jti` de asserções, client assertions, provas DPoP e
 * asserções de navegador) e limites de taxa do Poppy.
 */
import { createHash } from 'node:crypto';
import type { PoppyLimiter, PoppyReplayStore } from './config.js';

export const JTI_TABLE = 'auth_poppy_jtis';

/** Chave curta e de tamanho fixo para um `jti` de um tipo/agente. */
export function replayKey(kind: string, ...parts: string[]): string {
  return `${kind}:${createHash('sha256').update(parts.join('\u0000')).digest('base64url')}`;
}

/** Em memória, por processo. Só serve com uma instância. */
export function memoryReplayStore(
  options: { max?: number; now?: () => number } = {},
): PoppyReplayStore {
  const seen = new Map<string, number>();
  const max = options.max ?? 100_000;
  const now = options.now ?? Date.now;
  let claims = 0;
  return {
    async claim(key, expiresAt) {
      const t = now();
      if (++claims % 1000 === 0 || seen.size >= max) {
        for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
      }
      const existing = seen.get(key);
      if (existing !== undefined && existing > t) return false;
      if (seen.size >= max) seen.delete(seen.keys().next().value as string);
      seen.set(key, expiresAt.getTime());
      return true;
    },
  };
}

/**
 * Na tabela lib-owned `auth_poppy_jtis` (PK = chave): o INSERT de uma chave que
 * já existe falha — atômico entre instâncias. Linhas vencidas saem aos poucos.
 */
export function databaseReplayStore(
  conn: () => any,
  options: { now?: () => Date } = {},
): PoppyReplayStore {
  const now = options.now ?? (() => new Date());
  let claims = 0;
  return {
    async claim(key, expiresAt) {
      const t = now();
      if (++claims % 200 === 1) {
        await conn().from(JTI_TABLE).where('expires_at', '<', t).delete();
      }
      try {
        await conn().table(JTI_TABLE).insert({ key, expires_at: expiresAt });
        return true;
      } catch (error) {
        // Chave já usada — a não ser que a linha vencida ainda não tenha saído.
        const row = await conn().from(JTI_TABLE).where('key', key).first();
        if (!row) throw error;
        const exp =
          row.expires_at instanceof Date
            ? row.expires_at
            : new Date(Number(row.expires_at) || row.expires_at);
        if (exp.getTime() > t.getTime()) return false;
        const updated = await conn()
          .from(JTI_TABLE)
          .where('key', key)
          .where('expires_at', '<=', t)
          .update({ expires_at: expiresAt });
        return (
          (typeof updated === 'number' ? updated : Array.isArray(updated) ? updated.length : 0) > 0
        );
      }
    },
  };
}

/** Numa conexão Redis (`SET key 1 PX ttl NX`). */
export function redisReplayStore(redis: {
  set: (...args: any[]) => Promise<unknown>;
}): PoppyReplayStore {
  return {
    async claim(key, expiresAt) {
      const ttl = Math.max(1000, expiresAt.getTime() - Date.now());
      const result = await redis.set(`authkit:poppy:jti:${key}`, '1', 'PX', ttl, 'NX');
      return result === 'OK';
    },
  };
}

/** Janelas fixas em memória, por processo: `sessionsPerMinute` por agente, `mediatedPerHour` por (agente, usuário). */
export function memoryLimiter(
  limits: { sessionsPerMinute: number; mediatedPerHour: number },
  now: () => number = Date.now,
): PoppyLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return async ({ action, key }) => {
    const [limit, windowMs] =
      action === 'session'
        ? [limits.sessionsPerMinute, 60_000]
        : [limits.mediatedPerHour, 3_600_000];
    const t = now();
    const id = `${action}:${key}`;
    let w = windows.get(id);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(id, w);
      if (windows.size > 50_000) {
        for (const [k, v] of windows) if (t - v.start >= 3_600_000) windows.delete(k);
      }
    }
    if (w.count >= limit) return Math.ceil((w.start + windowMs - t) / 1000);
    w.count++;
    return null;
  };
}
