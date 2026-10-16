import { createHash, randomBytes } from 'node:crypto';
import { base64url } from 'jose';
import { type ResiliencePolicy, resilientFetch } from './http/resilient_fetch.js';
import type { TokenSet } from './types.js';

/**
 * Gera um par PKCE (code_verifier + code_challenge) usando o método S256.
 *
 * Observação: o `jose` v5 instalado não exporta os helpers
 * `generateRandomCodeVerifier`/`calculatePKCECodeChallenge`, então usamos o
 * `crypto` do Node + `jose.base64url` para produzir valores equivalentes,
 * conforme RFC 7636 (verifier aleatório base64url, challenge = base64url(SHA-256(verifier))).
 */
export async function generatePkce() {
  const verifier = base64url.encode(randomBytes(32));
  const challenge = base64url.encode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' as const };
}

export interface AuthorizeParams {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  /**
   * OIDC `nonce`, echoed back in the id_token and checked by `validateIdToken`.
   * Binds the id_token to this authorization request (replay protection).
   */
  nonce?: string;
  /**
   * Endpoint de autorização do IdP — obtenha via `discoverEndpoints(issuer)`
   * para IdPs de terceiros. Default: `${issuer}/auth` (convenção oidc-provider).
   */
  authorizationEndpoint?: string;
  /**
   * Parâmetros extras anexados à URL de autorização (ex.: `audience`, `prompt`,
   * `login_hint`, `ui_locales`, `acr_values`). Evita manipulação manual de URL no
   * controller. Valores `undefined`/`null` são ignorados.
   */
  extraParams?: Record<string, string | number | undefined | null>;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const url = new URL(p.authorizationEndpoint ?? `${p.issuer}/auth`);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', p.scopes.join(' '));
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.nonce) url.searchParams.set('nonce', p.nonce);
  if (p.extraParams) {
    for (const [key, value] of Object.entries(p.extraParams)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export interface EndSessionParams {
  /** Issuer do IdP (ex.: http://localhost:3333/oidc). */
  issuer: string;
  /** ID token atual da sessão; usado como id_token_hint para o IdP pular a confirmação. */
  idToken?: string;
  /** URI registrada no client onde o IdP devolve o browser após encerrar a sessão. */
  postLogoutRedirectUri?: string;
  /** Opcional; alguns IdPs exigem client_id quando não há id_token_hint. */
  clientId?: string;
  /** Opcional; ecoado de volta no post_logout_redirect_uri. */
  state?: string;
  /**
   * Endpoint de end-session do IdP (via `discoverEndpoints`). Default:
   * `${issuer}/session/end` (convenção oidc-provider).
   */
  endSessionEndpoint?: string;
}

/**
 * Monta a URL de RP-initiated logout (OIDC) do IdP: `<issuer>/session/end`.
 *
 * Com `id_token_hint` + `post_logout_redirect_uri` registrada no client, o
 * oidc-provider encerra a sessão SSO e redireciona o browser de volta. Sem
 * o `id_token_hint`, o oidc-provider (v9) renderiza uma página de confirmação.
 */
export function buildEndSessionUrl(p: EndSessionParams): string {
  const url = new URL(p.endSessionEndpoint ?? `${p.issuer}/session/end`);
  if (p.idToken) url.searchParams.set('id_token_hint', p.idToken);
  if (p.postLogoutRedirectUri) {
    url.searchParams.set('post_logout_redirect_uri', p.postLogoutRedirectUri);
  }
  if (p.clientId) url.searchParams.set('client_id', p.clientId);
  if (p.state) url.searchParams.set('state', p.state);
  return url.toString();
}

/** Resposta padrão do token endpoint (RFC 6749 §5.1). */
interface TokenEndpointResponse {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * POST genérico ao token endpoint (`<issuer>/token`) compartilhado pelos fluxos
 * authorization_code, refresh_token e token-exchange. Mapeia a resposta para um
 * TokenSet padronizado e lança se o endpoint não responder 2xx.
 */
async function tokenEndpoint(
  issuer: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
  endpoint?: string,
  resilience?: ResiliencePolicy,
): Promise<TokenSet> {
  const res = await resilientFetch(
    endpoint ?? `${issuer}/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    resilience,
    fetchImpl,
  );
  if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);

  const json = (await res.json()) as TokenEndpointResponse;
  return {
    idToken: json.id_token ?? '',
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

export interface ExchangeParams {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
  /** Token endpoint do IdP (via `discoverEndpoints`). Default: `${issuer}/token`. */
  tokenEndpoint?: string;
  /** Política de resiliência OPCIONAL p/ a chamada ao token endpoint. */
  resilience?: ResiliencePolicy;
}

export async function exchangeCode(p: ExchangeParams): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.codeVerifier,
  });
  if (p.clientSecret) body.set('client_secret', p.clientSecret);

  return tokenEndpoint(p.issuer, body, p.fetchImpl, p.tokenEndpoint, p.resilience);
}

export interface RefreshParams {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  /** Escopo opcional para reduzir o escopo do novo token. */
  scope?: string;
  fetchImpl?: typeof fetch;
  /** Token endpoint do IdP (via `discoverEndpoints`). Default: `${issuer}/token`. */
  tokenEndpoint?: string;
  /** Política de resiliência OPCIONAL p/ a chamada ao token endpoint. */
  resilience?: ResiliencePolicy;
}

/**
 * Renova o TokenSet via `grant_type=refresh_token` (RFC 6749 §6).
 *
 * Com rotação habilitada no IdP (oidc-provider `rotateRefreshToken`), o endpoint
 * devolve um NOVO refresh_token a cada uso e invalida o anterior — o chamador
 * DEVE persistir o `refreshToken` retornado. Se o IdP não rotacionar, o campo
 * pode vir vazio e o refresh token anterior continua válido.
 */
export async function refreshTokens(p: RefreshParams): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: p.refreshToken,
    client_id: p.clientId,
  });
  if (p.scope) body.set('scope', p.scope);
  if (p.clientSecret) body.set('client_secret', p.clientSecret);

  return tokenEndpoint(p.issuer, body, p.fetchImpl, p.tokenEndpoint, p.resilience);
}

export interface ExchangeTokenParams {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Access token atual do ator (admin). */
  subjectToken: string;
  /** Id do usuário-alvo a impersonar. */
  requestedSubject: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  /** Token endpoint do IdP (via `discoverEndpoints`). Default: `${issuer}/token`. */
  tokenEndpoint?: string;
  /** Política de resiliência OPCIONAL p/ a chamada ao token endpoint. */
  resilience?: ResiliencePolicy;
}

/** Troca o token do ator por um token do usuário-alvo (RFC 8693), p/ impersonation. */
export async function exchangeToken(p: ExchangeTokenParams): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: p.subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_subject: p.requestedSubject,
    client_id: p.clientId,
  });
  if (p.scope) body.set('scope', p.scope);
  if (p.clientSecret) body.set('client_secret', p.clientSecret);

  return tokenEndpoint(p.issuer, body, p.fetchImpl, p.tokenEndpoint, p.resilience);
}
