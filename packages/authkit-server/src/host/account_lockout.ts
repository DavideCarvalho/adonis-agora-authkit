import type { AuditSink } from '../audit/audit_sink.js';
import type { ResolvedLockoutConfig } from '../define_config.js';
import { normalizeEmailIdentifier } from './email_identifier.js';

/**
 * Bloqueio progressivo de conta (anti-brute-force keyed por EMAIL, não por IP).
 *
 * Construído sobre o `@adonisjs/limiter` do HOST (peer/opt-in), exatamente como o
 * `rate_limit.ts`: o service do limiter é importado de forma preguiçosa e fail-safe.
 * Se o `@adonisjs/limiter` não estiver instalado/configurado, TODOS os métodos viram
 * no-op (lockout desligado) e `isLocked` devolve `{ locked: false }` — NUNCA lança no
 * caminho da request, e NÃO há migração/DB envolvido (usa o store do limiter do host).
 *
 * Esquema de chaves (todas namespaced + email normalizado):
 * - `authkit_lockout_fail:{email}` — contador de falhas dentro da janela deslizante.
 * - `authkit_lockout:{email}`      — chave bloqueada (TTL = duração progressiva do lock).
 * - `authkit_lockout_count:{email}`— quantos locks já ocorreram (alimenta o backoff).
 */

/** Service do `@adonisjs/limiter` resolvido preguiçosamente. `any` de propósito (peer/opt-in). */
type LimiterService = any;

let limiterServicePromise: Promise<LimiterService | null> | undefined;

/**
 * Importa o service do limiter do HOST de forma preguiçosa e fail-safe (mesmo
 * padrão de `rate_limit.ts`). Resolve `null` quando o limiter não está disponível.
 */
async function loadLimiter(): Promise<LimiterService | null> {
  if (!limiterServicePromise) {
    const specifier = '@adonisjs/limiter/services/main';
    limiterServicePromise = import(specifier)
      .then((mod) => (mod as any).default ?? null)
      .catch(() => null);
  }
  return limiterServicePromise;
}

/**
 * Permite reapontar/limpar o loader do limiter (usado em testes).
 * @internal
 */
export function __setLockoutLimiterLoaderForTests(
  fn: (() => Promise<LimiterService | null>) | undefined,
): void {
  if (fn) {
    limiterServicePromise = fn();
  } else {
    limiterServicePromise = undefined;
  }
}

/**
 * Normaliza o email para virar chave estável. Delega à normalização ÚNICA da
 * identidade ({@link normalizeEmailIdentifier}) para que a chave do lockout e a
 * do lookup da conta nunca divirjam.
 */
function normalizeEmail(email: string | undefined | null): string {
  return normalizeEmailIdentifier(email);
}

/**
 * Backoff progressivo PURO (sem I/O — fácil de testar): a duração do lock cresce
 * com o número de locks já ocorridos para a chave: `base * 2^(lockCount-1)`,
 * limitada a `maxLockoutSec`. `lockCount` é 1-based (1 = primeiro lock).
 */
export function computeLockoutSec(lockCount: number, cfg: ResolvedLockoutConfig): number {
  const n = Math.max(1, lockCount);
  const grown = cfg.baseLockoutSec * 2 ** (n - 1);
  return Math.min(grown, cfg.maxLockoutSec);
}

/** Resultado de uma checagem de bloqueio. */
export interface LockState {
  locked: boolean;
  /** Segundos até a conta destravar (presente quando `locked`). */
  retryAfterSec?: number;
}

/** Contexto opcional de auditoria para o evento `account.locked`. */
export interface LockoutAuditContext {
  sink?: AuditSink;
  ip?: string | null;
}

/**
 * Helper de lockout amarrado a uma config resolvida. Cada método é fail-safe:
 * resolve o limiter preguiçosamente e degrada para no-op quando ele está ausente
 * ou quando `cfg.enabled === false`.
 */
export class AccountLockout {
  constructor(private cfg: ResolvedLockoutConfig) {}

  private failKey(email: string) {
    return `authkit_lockout_fail:${email}`;
  }
  private lockKey(email: string) {
    return `authkit_lockout:${email}`;
  }
  private countKey(email: string) {
    return `authkit_lockout_count:${email}`;
  }

  /**
   * Resolve o limiter (ou `null`). Retorna `null` também quando lockout está
   * desligado por config — assim o caminho de no-op é o mesmo.
   */
  private async limiter(): Promise<LimiterService | null> {
    if (!this.cfg.enabled) return null;
    return loadLimiter();
  }

  /** Store de contagem de falhas (janela deslizante de `windowSec`). */
  private failStore(limiter: LimiterService) {
    const opts = { requests: this.cfg.maxAttempts, duration: this.cfg.windowSec };
    return this.cfg.store ? limiter.use(this.cfg.store, opts) : limiter.use(opts);
  }

  /**
   * Store da contagem de locks. A janela é longa (mantém o histórico de locks por
   * um tempo para o backoff progressivo crescer entre locks sucessivos).
   */
  private countStore(limiter: LimiterService) {
    const opts = { requests: 1_000_000, duration: this.cfg.maxLockoutSec * 4 };
    return this.cfg.store ? limiter.use(this.cfg.store, opts) : limiter.use(opts);
  }

  /**
   * Store dedicado a marcar a chave como bloqueada. `requests: 1` + `block(...)`
   * com a duração progressiva; `isBlocked`/`availableIn` consultam o estado.
   */
  private lockStore(limiter: LimiterService) {
    const opts = { requests: 1, duration: this.cfg.maxLockoutSec };
    return this.cfg.store ? limiter.use(this.cfg.store, opts) : limiter.use(opts);
  }

  /** `true`/retryAfter quando a conta está bloqueada. Fail-safe: `{ locked: false }`. */
  async isLocked(email: string): Promise<LockState> {
    const key = normalizeEmail(email);
    if (!key) return { locked: false };
    const limiter = await this.limiter();
    if (!limiter) return { locked: false };
    try {
      const store = this.lockStore(limiter);
      const blocked = await store.isBlocked(this.lockKey(key));
      if (!blocked) return { locked: false };
      const retryAfterSec = await store.availableIn(this.lockKey(key));
      return { locked: true, retryAfterSec };
    } catch {
      // Falha do limiter NUNCA derruba o login — degrada para "não bloqueado".
      return { locked: false };
    }
  }

  /**
   * Registra uma falha de login. Ao cruzar `maxAttempts` dentro da janela, marca
   * a chave como bloqueada com TTL progressivo e incrementa a contagem de locks.
   * Emite `account.locked` UMA vez (na transição), não a cada tentativa bloqueada.
   */
  async recordFailure(email: string, audit?: LockoutAuditContext): Promise<void> {
    const key = normalizeEmail(email);
    if (!key) return;
    const limiter = await this.limiter();
    if (!limiter) return;
    try {
      // Se já está bloqueada, não conta de novo nem reemite o evento.
      const lockStore = this.lockStore(limiter);
      if (await lockStore.isBlocked(this.lockKey(key))) return;

      const failStore = this.failStore(limiter);
      const res = await failStore.increment(this.failKey(key));
      // `consumed` = falhas acumuladas na janela. Bloqueia ao atingir o teto.
      const consumed = res?.consumed ?? 0;
      if (consumed < this.cfg.maxAttempts) return;

      // Transição para bloqueado: incrementa a contagem de locks e calcula o TTL.
      const countStore = this.countStore(limiter);
      const countRes = await countStore.increment(this.countKey(key));
      const lockCount = countRes?.consumed ?? 1;
      const lockoutSec = computeLockoutSec(lockCount, this.cfg);

      await lockStore.block(this.lockKey(key), lockoutSec);
      // Zera o contador de falhas (a contagem recomeça após o lock).
      await failStore.delete(this.failKey(key));

      await audit?.sink?.record({
        type: 'account.locked',
        email: key,
        ip: audit?.ip ?? null,
        metadata: { lockCount, lockoutSec },
      });
    } catch {
      // Best-effort: nunca propaga erro do limiter para o caminho da request.
    }
  }

  /**
   * Limpa o estado de falhas após um login bem-sucedido. Remove o contador de
   * falhas e o lock; mantém a contagem de locks (histórico para o backoff) — ela
   * expira naturalmente pela janela longa do `countStore`.
   */
  async clearFailures(email: string): Promise<void> {
    const key = normalizeEmail(email);
    if (!key) return;
    const limiter = await this.limiter();
    if (!limiter) return;
    try {
      await this.failStore(limiter).delete(this.failKey(key));
      await this.lockStore(limiter).delete(this.lockKey(key));
    } catch {
      // no-op fail-safe
    }
  }
}

/** Fabrica o helper de lockout a partir da config resolvida. */
export function createAccountLockout(cfg: ResolvedLockoutConfig): AccountLockout {
  return new AccountLockout(cfg);
}
