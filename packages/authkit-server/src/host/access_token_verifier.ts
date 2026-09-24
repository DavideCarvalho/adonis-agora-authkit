import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  type JWTPayload,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import { errors as providerErrors } from 'oidc-provider';

/**
 * Token recusado (assinatura, `iss`, `exp`, formato…) vira `null` → 401. Falha de
 * infraestrutura (banco fora, rede, JWKS inalcançável) SOBE: responder
 * `invalid_token` num apagão ensinaria o cliente a jogar fora um token bom.
 */
function rejectedJwt(error: unknown): boolean {
  return (
    error instanceof joseErrors.JOSEError &&
    !(error instanceof joseErrors.JWKSTimeout) &&
    !(error instanceof joseErrors.JWKSInvalid)
  );
}

/**
 * Access token já verificado — a forma comum que o `oidcBearerGuard` consome,
 * qualquer que seja o modo de verificação (in-process ou resource server remoto)
 * e o formato do token (opaco ou JWT RFC 9068).
 */
export interface VerifiedAccessToken {
  /** `opaque` (referência no adapter / introspecção) ou `jwt` (RFC 9068, auto-contido). */
  format: 'opaque' | 'jwt';
  /** `sub` — o id da conta. */
  sub: string;
  /** Client que recebeu o token. */
  clientId: string | null;
  /** Escopos concedidos. */
  scopes: string[];
  /** Audience(s) do token (resource indicators, RFC 8707). Vazio = sem `aud`. */
  audience: string[];
  /** Expiração (epoch em segundos), quando conhecida. */
  exp: number | null;
  /** Id do token (`jti`), quando conhecido. */
  jti: string | null;
}

/**
 * Estratégia de verificação de access token plugável no `oidcBearerGuard`.
 * `verify` devolve `null` para QUALQUER token não aceitável (desconhecido,
 * expirado, revogado, assinatura inválida, sender-constrained) — o guard não
 * distingue os motivos na resposta (401 genérico).
 */
export interface AccessTokenVerifier {
  verify(token: string): Promise<VerifiedAccessToken | null>;
  /**
   * Emite um access token de verdade para `accountId` — usado pelo
   * `authenticateAsClient` do guard em testes. Só existe no modo in-process.
   */
  issue?(accountId: string, options?: IssueAccessTokenOptions): Promise<string>;
}

/** Opções de {@link AccessTokenVerifier.issue}. */
export interface IssueAccessTokenOptions {
  /** Client "dono" do token. Default: `'authkit-test-client'`. */
  clientId?: string;
  /** Escopos do token. Default: `['openid']`. */
  scopes?: string[];
}

/** O mínimo do `OidcService` que a verificação in-process usa. */
export interface InProcessIssuer {
  readonly provider: any;
  readonly publicJwks: { keys: Record<string, any>[] };
  readonly config: { issuer: string };
}

/** `header.payload.signature` em base64url — o formato compacto de um JWS. */
const JWS_COMPACT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function looksLikeJwt(token: string): boolean {
  return JWS_COMPACT.test(token);
}

function splitScope(scope: unknown): string[] {
  return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
}

function toAudience(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === 'string');
  return [];
}

/**
 * JWT access token (RFC 9068) → {@link VerifiedAccessToken}. Recusa token com
 * `cnf` (DPoP / mTLS): ele é sender-constrained e apresentá-lo como Bearer puro,
 * sem a prova de posse, é exatamente o que o `cnf` existe para impedir.
 */
function fromJwtPayload(payload: JWTPayload): VerifiedAccessToken | null {
  if ((payload as { cnf?: unknown }).cnf) return null;
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  const clientId = (payload as { client_id?: unknown }).client_id;
  return {
    format: 'jwt',
    sub: payload.sub,
    clientId: typeof clientId === 'string' ? clientId : null,
    scopes: splitScope((payload as { scope?: unknown }).scope),
    audience: toAudience(payload.aud),
    exp: typeof payload.exp === 'number' ? payload.exp : null,
    jti: typeof payload.jti === 'string' ? payload.jti : null,
  };
}

/**
 * Verificação IN-PROCESS: o app hospeda o issuer (`authkit.server`).
 *
 *   - token opaco → `AccessToken.find` do oidc-provider (mesma rota do
 *     {@link TokenVerifyService}). Revogação (`/revoke`, logout, revogação de
 *     grant/sessão pelo admin) apaga o artefato, então revogado = não encontrado.
 *   - JWT (RFC 9068, `accessTokens.format: 'jwt'`) → assinatura contra o JWKS
 *     PÚBLICO do provider atual, `iss` e `typ: at+jwt`. JWT AT é auto-contido: o
 *     oidc-provider não o persiste, então ele vale até o `exp` mesmo após revogar o
 *     grant — mantenha o TTL do access token curto.
 *
 * `resolveIssuer` é chamado a cada verificação (e não guardado): o `OidcService`
 * troca a instância do provider em `reloadKeys`/rotação de chaves.
 */
export function inProcessAccessTokenVerifier(
  resolveIssuer: () => Promise<InProcessIssuer>,
): AccessTokenVerifier {
  // JWKS local memoizado por identidade: o `publicJwks` só muda (novo objeto)
  // quando o provider é reconstruído.
  let cachedJwks: { keys: Record<string, any>[] } | undefined;
  let cachedKeySet: ReturnType<typeof createLocalJWKSet> | undefined;
  const keySetFor = (jwks: { keys: Record<string, any>[] }) => {
    if (jwks !== cachedJwks || !cachedKeySet) {
      cachedJwks = jwks;
      cachedKeySet = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
    }
    return cachedKeySet;
  };

  return {
    async verify(token) {
      if (!token) return null;
      const issuer = await resolveIssuer();

      if (looksLikeJwt(token)) {
        try {
          const { payload } = await jwtVerify(token, keySetFor(issuer.publicJwks), {
            issuer: issuer.config.issuer,
            typ: 'at+jwt',
          });
          return fromJwtPayload(payload);
        } catch (error) {
          if (rejectedJwt(error)) return null;
          throw error;
        }
      }

      let at: any;
      try {
        at = await issuer.provider?.AccessToken?.find(token);
      } catch (error) {
        // Só erro do próprio provider (token malformado) é recusa; erro do adapter sobe.
        if (error instanceof providerErrors.OIDCProviderError) return null;
        throw error;
      }
      if (!at) return null;
      // O oidc-provider já recusa artefato expirado no `find`; isto é guarda extra.
      if (at.isExpired === true) return null;
      if (typeof at.exp === 'number' && at.exp <= Math.floor(Date.now() / 1000)) return null;
      // Sender-constrained (DPoP `jkt` / mTLS `x5t#S256`): sem a prova, não aceita.
      if (at.jkt || at['x5t#S256']) return null;
      if (typeof at.accountId !== 'string' || !at.accountId) return null;
      return {
        format: 'opaque',
        sub: at.accountId,
        clientId: typeof at.clientId === 'string' ? at.clientId : null,
        scopes: splitScope(at.scope),
        audience: toAudience(at.aud),
        exp: typeof at.exp === 'number' ? at.exp : null,
        jti: typeof at.jti === 'string' ? at.jti : null,
      };
    },

    async issue(accountId, options = {}) {
      const { provider } = await resolveIssuer();
      const at = new provider.AccessToken({
        accountId,
        clientId: options.clientId ?? 'authkit-test-client',
        scope: (options.scopes ?? ['openid']).join(' '),
        gty: 'authorization_code',
      });
      return at.save();
    },
  };
}

/** Opções do modo resource server REMOTO. */
export interface RemoteAccessTokenVerifierOptions {
  /** Issuer do authkit (o mesmo `issuer` do `config/authkit.ts` do IdP). */
  issuer: string;
  /**
   * URL do JWKS. Default: o `jwks_uri` da discovery
   * (`{issuer}/.well-known/openid-configuration`).
   */
  jwksUri?: string;
  /**
   * Introspecção (RFC 7662) para tokens OPACOS, autenticada com as credenciais de
   * um client CONFIDENCIAL do issuer (o resource server). Sem isto, só JWT access
   * tokens (RFC 9068) são aceitos.
   */
  introspection?: {
    clientId: string;
    clientSecret: string;
    /** Default: o `introspection_endpoint` da discovery. */
    endpoint?: string;
  };
  /** `fetch` alternativo (testes, proxy). Default: o global. */
  fetch?: typeof fetch;
}

interface DiscoveryDocument {
  jwks_uri?: string;
  introspection_endpoint?: string;
}

/**
 * Verificação de RESOURCE SERVER remoto: a API NÃO hospeda o issuer.
 *
 *   - JWT (RFC 9068) → assinatura contra o JWKS remoto (cacheado e recarregado
 *     pelo `jose` quando aparece um `kid` novo), `iss` e `typ: at+jwt`.
 *   - opaco → introspecção (RFC 7662) com client credentials; exige
 *     `active: true` e `token_type` Bearer (refresh token introspectado vem sem
 *     `token_type` e é recusado).
 */
export function remoteAccessTokenVerifier(
  options: RemoteAccessTokenVerifierOptions,
): AccessTokenVerifier {
  const doFetch = options.fetch ?? globalThis.fetch;
  const issuer = options.issuer.replace(/\/+$/, '');

  let discovery: Promise<DiscoveryDocument> | undefined;
  const discover = () => {
    discovery ??= (async () => {
      const res = await doFetch(`${issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`discovery ${res.status}`);
      return (await res.json()) as DiscoveryDocument;
    })().catch((error) => {
      // Falha transitória não fica memoizada: a próxima request tenta de novo.
      discovery = undefined;
      throw error;
    });
    return discovery;
  };

  let keySet: ReturnType<typeof createRemoteJWKSet> | undefined;
  const remoteKeySet = async () => {
    if (keySet) return keySet;
    const jwksUri = options.jwksUri ?? (await discover()).jwks_uri;
    if (!jwksUri) throw new Error('issuer sem jwks_uri');
    keySet = createRemoteJWKSet(
      new URL(jwksUri),
      options.fetch ? { [customFetch]: options.fetch } : undefined,
    );
    return keySet;
  };

  const introspect = async (token: string): Promise<VerifiedAccessToken | null> => {
    const creds = options.introspection;
    if (!creds) return null;
    const endpoint = creds.endpoint ?? (await discover()).introspection_endpoint;
    if (!endpoint) return null;
    // RFC 6749 §2.3.1: client_id/secret form-urlencoded antes do Basic.
    const basic = Buffer.from(
      `${encodeURIComponent(creds.clientId)}:${encodeURIComponent(creds.clientSecret)}`,
    ).toString('base64');
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
    });
    // 5xx ou credencial do resource server recusada: problema de infra/config, não do token.
    if (!res.ok) throw new Error(`authkit: introspecção falhou (HTTP ${res.status})`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.active !== true) return null;
    if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') {
      return null;
    }
    if (body.cnf) return null;
    if (typeof body.sub !== 'string' || !body.sub) return null;
    if (typeof body.exp === 'number' && body.exp <= Math.floor(Date.now() / 1000)) return null;
    return {
      format: 'opaque',
      sub: body.sub,
      clientId: typeof body.client_id === 'string' ? body.client_id : null,
      scopes: splitScope(body.scope),
      audience: toAudience(body.aud),
      exp: typeof body.exp === 'number' ? body.exp : null,
      jti: typeof body.jti === 'string' ? body.jti : null,
    };
  };

  return {
    async verify(token) {
      if (!token) return null;
      if (looksLikeJwt(token)) {
        try {
          const { payload } = await jwtVerify(token, await remoteKeySet(), {
            // Mesma forma da discovery (sem barra final), aceitando o `iss` com ou sem ela.
            issuer: [issuer, `${issuer}/`],
            typ: 'at+jwt',
          });
          return fromJwtPayload(payload);
        } catch (error) {
          if (rejectedJwt(error)) return null;
          throw error;
        }
      }
      // Introspecção fora do ar sobe como erro (não é "token inválido").
      return introspect(token);
    },
  };
}
