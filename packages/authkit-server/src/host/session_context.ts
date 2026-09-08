import type { ResolvedServerConfig } from '../define_config.js';
import { ADMIN_LIST_MAX_SIZE, LIST_FIRST_PAGE } from '../pagination.js';
import type { AdminSession } from './admin_sessions_service.js';
import { resolveGeoSafe } from './geo.js';
import { parseUserAgent } from './user_agent.js';

/**
 * ENRIQUECE sessões ativas com contexto de dispositivo (user-agent → browser/SO),
 * IP e localização, SEM tocar no payload da `Session` do oidc-provider (que não é
 * extensível de forma portátil entre adapters).
 *
 * A FONTE do contexto é o próprio audit log: cada `login.success` carrega o `ip` e
 * o `userAgent` (em `metadata.userAgent`, gravado por `notifyLoginSuccess`). Como a
 * `Session` carrega o `loginTs` (epoch do login), correlacionamos cada sessão ao
 * evento `login.success` da MESMA conta cujo timestamp é o mais próximo do `loginTs`
 * — um join barato em memória sobre uma janela recente de eventos.
 *
 * CAPABILITY-PROBED + FAIL-SAFE: degrada para os campos vazios (sem quebrar a
 * listagem) quando o sink de auditoria não suporta consulta (`list` ausente). A
 * geolocalização usa o hook plugável `resolveGeo` (ausente = só IP, sem location),
 * com timeout curto.
 *
 * LIMITAÇÃO: a correlação por timestamp é uma APROXIMAÇÃO — duas sessões da mesma
 * conta criadas no mesmo segundo podem trocar de contexto entre si. É suficiente
 * para exibição (não para decisões de segurança).
 */
export async function enrichSessionsWithContext(
  cfg: Pick<ResolvedServerConfig, 'audit' | 'resolveGeo'>,
  accountId: string,
  sessions: AdminSession[],
): Promise<AdminSession[]> {
  if (sessions.length === 0) return sessions;

  // Sem consulta de audit não há de onde puxar o contexto → devolve como veio.
  if (typeof cfg.audit?.list !== 'function') return sessions;

  // Janela recente de login.success da conta (limite são para não estourar memória).
  const page = await cfg.audit.list({
    type: 'login.success',
    subject: accountId,
    page: LIST_FIRST_PAGE,
    size: ADMIN_LIST_MAX_SIZE,
  });

  const events = page.data.map((e) => ({
    ts: toEpochSeconds(e.createdAt),
    ip: e.ip ?? null,
    userAgent: (e.metadata?.userAgent as string | undefined) ?? null,
  }));

  return Promise.all(
    sessions.map(async (s) => {
      const match = closestEvent(events, s.loginTs);
      if (!match) return s;
      const { browser, os } = parseUserAgent(match.userAgent);
      const location = await resolveGeoSafe(cfg.resolveGeo, match.ip);
      return {
        ...s,
        userAgent: match.userAgent,
        browser: match.userAgent ? browser : null,
        os: match.userAgent ? os : null,
        ip: match.ip,
        location,
      };
    }),
  );
}

/** Evento de login.success projetado para o join (ts em epoch-segundos). */
interface LoginEvent {
  ts: number | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Escolhe o evento cujo timestamp é o MAIS PRÓXIMO do `loginTs` da sessão. Quando a
 * sessão não tem `loginTs`, devolve o evento mais recente com algum contexto. `null`
 * quando não há eventos úteis.
 */
function closestEvent(events: LoginEvent[], loginTs: number | undefined): LoginEvent | null {
  const usable = events.filter((e) => e.ip !== null || e.userAgent !== null);
  if (usable.length === 0) return null;
  if (loginTs === undefined) {
    // Sem loginTs: o primeiro (a listagem do sink vem desc por createdAt).
    return usable[0];
  }
  let best: LoginEvent | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const e of usable) {
    if (e.ts === null) continue;
    const delta = Math.abs(e.ts - loginTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = e;
    }
  }
  return best ?? usable[0];
}

/** Normaliza o createdAt do audit (Date | ISO string) para epoch-segundos. */
function toEpochSeconds(createdAt: Date | string | null): number | null {
  if (!createdAt) return null;
  const ms = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
