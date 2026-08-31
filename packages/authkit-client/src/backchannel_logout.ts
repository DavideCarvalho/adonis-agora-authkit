import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';

/** Event type da claim `events` exigido pelo OIDC Back-Channel Logout. */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Algoritmos de assinatura aceitos no logout_token (defesa contra alg-confusion). */
const DEFAULT_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

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
   * Função de chave já resolvida (ex.: `createRemoteJWKSet` ou `createLocalJWKSet`).
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
  const keys = opts.keys ?? createRemoteJWKSet(new URL(opts.jwksUri ?? `${opts.issuer}/jwks`));

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
}

/**
 * Implementação default em memória do {@link SessionIndex}. Mantém o mapeamento
 * sid -> sessionId e sub -> Set<sessionId>. NÃO use em produção multi-instância.
 */
export class InMemorySessionIndex implements SessionIndex {
  #bySid = new Map<string, string>();
  #bySub = new Map<string, Set<string>>();

  register(entry: SessionIndexEntry): void {
    if (entry.sid) {
      this.#bySid.set(entry.sid, entry.sessionId);
    }
    const set = this.#bySub.get(entry.sub) ?? new Set<string>();
    set.add(entry.sessionId);
    this.#bySub.set(entry.sub, set);
  }

  revokeBySid(sid: string): string[] {
    const sessionId = this.#bySid.get(sid);
    if (!sessionId) return [];
    this.#bySid.delete(sid);
    // Mantém os índices coerentes: remove o sessionId de qualquer bucket de sub.
    for (const [sub, set] of this.#bySub) {
      if (set.delete(sessionId) && set.size === 0) this.#bySub.delete(sub);
    }
    return [sessionId];
  }

  revokeBySub(sub: string): string[] {
    const set = this.#bySub.get(sub);
    if (!set) return [];
    const sessionIds = [...set];
    this.#bySub.delete(sub);
    // Remove as entradas de sid que apontavam p/ essas sessões.
    for (const [sid, sessionId] of this.#bySid) {
      if (set.has(sessionId)) this.#bySid.delete(sid);
    }
    return sessionIds;
  }
}
