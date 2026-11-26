import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { DEFAULT_ALGS, getJwks } from './jwks.js';

/** Event type da claim `events` exigido pelo OIDC Back-Channel Logout. */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Erro tipado lançado quando o logout_token não satisfaz as regras do spec. */
export class InvalidLogoutTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLogoutTokenError';
  }
}

export interface ValidateLogoutTokenOptions {
  /** Issuer esperado (deve bater com a claim `iss`). */
  issuer: string;
  /** clientId do RP; deve estar contido na claim `aud`. */
  clientId: string;
  /**
   * `jwks_uri` do IdP. Usado para montar um remote JWKS quando `keys` não é
   * fornecido. Default: `${issuer}/jwks` (rota padrão do oidc-provider).
   */
  jwksUri?: string;
  /**
   * Função de chave já resolvida (ex.: `createLocalJWKSet`).
   * Tem precedência sobre `jwksUri`; útil em testes para injetar uma chave local.
   */
  keys?: JWTVerifyGetKey;
  /** Algoritmos aceitos. Default: assimétricos. */
  algorithms?: string[];
}

/** Resultado da validação: as claims relevantes p/ localizar a sessão local. */
export interface ValidatedLogoutToken {
  sid?: string;
  sub?: string;
}

/**
 * Valida um `logout_token` (JWT) recebido no Back-Channel Logout, conforme
 * https://openid.net/specs/openid-connect-backchannel-1_0.html#Validation.
 *
 * Verifica a assinatura contra o JWKS do IdP e aplica as regras do spec:
 * - `iss` bate com o issuer configurado, `aud` inclui o clientId, `iat` presente;
 * - claim `events` é um objeto contendo a chave do evento de back-channel logout;
 * - possui ao menos `sid` ou `sub`;
 * - NÃO contém a claim `nonce` (proibida no logout_token).
 *
 * Lança {@link InvalidLogoutTokenError} em qualquer violação.
 */
export async function validateLogoutToken(
  token: string,
  opts: ValidateLogoutTokenOptions,
): Promise<ValidatedLogoutToken> {
  const keys = opts.keys ?? getJwks(opts.jwksUri ?? `${opts.issuer}/jwks`);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, keys, {
      issuer: opts.issuer,
      audience: opts.clientId,
      algorithms: opts.algorithms ?? DEFAULT_ALGS,
    });
    payload = verified.payload;
  } catch (err) {
    throw new InvalidLogoutTokenError(
      `Invalid logout_token (signature/iss/aud): ${(err as Error).message}`,
    );
  }

  // `iat` é obrigatório no logout_token.
  if (typeof payload.iat !== 'number') {
    throw new InvalidLogoutTokenError('logout_token is missing the iat claim');
  }

  // `nonce` é PROIBIDO no logout_token (evita confusão com id_token).
  if ('nonce' in payload) {
    throw new InvalidLogoutTokenError('logout_token must not contain the nonce claim');
  }

  // `events` deve ser objeto contendo a chave do evento de back-channel logout.
  const events = payload.events;
  if (
    typeof events !== 'object' ||
    events === null ||
    Array.isArray(events) ||
    !(BACKCHANNEL_LOGOUT_EVENT in events)
  ) {
    throw new InvalidLogoutTokenError(
      `logout_token sem o evento "${BACKCHANNEL_LOGOUT_EVENT}" na claim events`,
    );
  }

  const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : undefined;

  // Pelo menos um de sid/sub deve estar presente.
  if (!sid && !sub) {
    throw new InvalidLogoutTokenError('logout_token must contain at least sid or sub');
  }

  return { sid, sub };
}

/** Registro de uma sessão local indexada por sid/sub do OP. */
export interface SessionIndexEntry {
  sid?: string;
  sub: string;
  sessionId: string;
  /**
   * Quando a sessão local expira (Date ou epoch em ms). Depois disso a entrada sai
   * do índice sozinha. Sem ele, o índice usa o próprio TTL default.
   */
  expiresAt?: Date | number;
}

/**
 * Mapeia `sid`/`sub` do OP para os ids de sessão locais do RP. É a peça central do
 * Back-Channel Logout: ao receber um logout_token, o handler consulta este índice
 * para descobrir QUAIS sessões locais destruir.
 *
 * A implementação default ({@link InMemorySessionIndex}) é em memória — adequada para
 * testes e instâncias únicas. Em PRODUÇÃO, hosts com múltiplas instâncias devem
 * implementar esta interface sobre um store compartilhado (Redis/DB), já que o POST
 * de logout pode chegar em uma instância diferente da que criou a sessão.
 */
export interface SessionIndex {
  /** Registra o vínculo OP(sid/sub) -> sessão local. Chamado após o login. */
  register(entry: SessionIndexEntry): Promise<void> | void;
  /** Remove e retorna os sessionIds vinculados ao sid (sessão SSO específica). */
  revokeBySid(sid: string): Promise<string[]> | string[];
  /** Remove e retorna TODOS os sessionIds vinculados ao sub (todas as sessões do usuário). */
  revokeBySub(sub: string): Promise<string[]> | string[];
  /**
   * Esquece uma sessão local que acabou sem o OP (logout local). O `POST {prefix}/logout`
   * embutido chama com `ctx.session.sessionId`; chame você mesmo se registrou outro id.
   */
  unregister?(sessionId: string): Promise<void> | void;
}

export interface InMemorySessionIndexOptions {
  /** Teto de sessões indexadas; no teto, a mais antiga sai. Default 10 000. */
  maxEntries?: number;
  /** Vida de uma entrada registrada sem `expiresAt`, em ms. Default 24 h. */
  ttlMs?: number;
  /** Relógio (testes). Default `Date.now`. */
  now?: () => number;
}

/**
 * Implementação default em memória do {@link SessionIndex}. NÃO use em produção
 * multi-instância: o POST de back-channel pode chegar em outra instância.
 *
 * Tem teto (`maxEntries`, a mais antiga sai primeiro) e esquece as entradas vencidas
 * (`expiresAt` da entrada ou `ttlMs`) e as sessões encerradas por `unregister`.
 */
export class InMemorySessionIndex implements SessionIndex {
  // sessionId -> entrada; a ordem de inserção é a ordem de registro (a mais antiga primeiro).
  #sessions = new Map<string, { sid?: string; sub: string; expiresAt: number }>();
  #bySid = new Map<string, string>();
  #bySub = new Map<string, Set<string>>();
  #maxEntries: number;
  #ttlMs: number;
  #now: () => number;
  #writes = 0;

  constructor(options: InMemorySessionIndexOptions = {}) {
    const { maxEntries = 10_000, ttlMs = 24 * 60 * 60 * 1000 } = options;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(
        `[authkit-client] InMemorySessionIndex: maxEntries must be a positive integer (got ${maxEntries}).`,
      );
    }
    if (!(ttlMs > 0)) {
      throw new Error(
        `[authkit-client] InMemorySessionIndex: ttlMs must be a positive number (got ${ttlMs}).`,
      );
    }
    this.#maxEntries = maxEntries;
    this.#ttlMs = ttlMs;
    this.#now = options.now ?? Date.now;
  }

  /** Quantas sessões estão indexadas agora. */
  get size(): number {
    return this.#sessions.size;
  }

  register(entry: SessionIndexEntry): void {
    const t = this.#now();
    const expiresAt =
      entry.expiresAt === undefined
        ? t + this.#ttlMs
        : entry.expiresAt instanceof Date
          ? entry.expiresAt.getTime()
          : entry.expiresAt;
    this.#forget(entry.sessionId);
    if (++this.#writes % 1000 === 0 || this.#sessions.size >= this.#maxEntries) this.#prune(t);
    while (this.#sessions.size >= this.#maxEntries) {
      this.#forget(this.#sessions.keys().next().value as string);
    }
    if (expiresAt <= t) return;
    this.#sessions.set(entry.sessionId, { sid: entry.sid, sub: entry.sub, expiresAt });
    if (entry.sid) {
      // Um sid reapontado para outra sessão: a antiga perde o vínculo com ele.
      const previous = this.#bySid.get(entry.sid);
      if (previous !== undefined && previous !== entry.sessionId) {
        const old = this.#sessions.get(previous);
        if (old) old.sid = undefined;
      }
      this.#bySid.set(entry.sid, entry.sessionId);
    }
    const set = this.#bySub.get(entry.sub) ?? new Set<string>();
    set.add(entry.sessionId);
    this.#bySub.set(entry.sub, set);
  }

  unregister(sessionId: string): void {
    this.#forget(sessionId);
  }

  revokeBySid(sid: string): string[] {
    const sessionId = this.#bySid.get(sid);
    if (sessionId === undefined) return [];
    const live = this.#isLive(sessionId);
    this.#forget(sessionId);
    return live ? [sessionId] : [];
  }

  revokeBySub(sub: string): string[] {
    const set = this.#bySub.get(sub);
    if (!set) return [];
    const sessionIds = [...set].filter((id) => this.#isLive(id));
    for (const id of [...set]) this.#forget(id);
    return sessionIds;
  }

  #isLive(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    return entry !== undefined && entry.expiresAt > this.#now();
  }

  #prune(t: number): void {
    for (const [id, entry] of this.#sessions) if (entry.expiresAt <= t) this.#forget(id);
  }

  #forget(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return;
    this.#sessions.delete(sessionId);
    if (entry.sid && this.#bySid.get(entry.sid) === sessionId) this.#bySid.delete(entry.sid);
    const set = this.#bySub.get(entry.sub);
    if (set?.delete(sessionId) && set.size === 0) this.#bySub.delete(entry.sub);
  }
}
