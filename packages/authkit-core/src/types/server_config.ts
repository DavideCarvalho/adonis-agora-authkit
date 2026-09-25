/**
 * Client OIDC persistido no adapter/DB, gerenciável via console admin ou Admin API
 * em runtime. Usado internamente pela lib para representar clients em memória.
 */
export interface ClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  grants?: string[];
  /** 'none' para public clients (SPA com PKCE) */
  tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none';
  /**
   * Tipo de aplicação (OIDC Registration §2, `application_type`). Default `'web'`.
   *
   * `'native'` (RFC 8252 — OAuth 2.0 for Native Apps) libera os redirects de app
   * mobile/desktop: esquema privado (`com.example.app:/callback`), URL https
   * "claimed" (universal/app links) e loopback `http://127.0.0.1` com qualquer
   * porta. Client nativo é SEMPRE público (sem `clientSecret`,
   * `tokenEndpointAuthMethod: 'none'`) — PKCE já é obrigatório no issuer.
   */
  applicationType?: 'web' | 'native';
  /**
   * Endpoint do RP que recebe o POST de OIDC Back-Channel Logout. Quando definido,
   * o IdP envia um `logout_token` para esta URI ao encerrar a sessão/grant do usuário.
   */
  backchannelLogoutUri?: string;
  /**
   * Exige que o `logout_token` inclua a claim `sid` (session id). Mapeado para
   * `backchannel_logout_session_required` do oidc-provider. Default: false.
   */
  backchannelLogoutSessionRequired?: boolean;
}

export interface TtlConfig {
  accessToken?: string | number;
  refreshToken?: string | number;
  idToken?: string | number;
  session?: string | number;
}

/** Config de onde o keystore managed mora. String = atalho p/ { driver:'file', path }. */
export type KeystoreStoreConfig =
  | string
  | { driver: 'file'; path: string }
  | { driver: 'drive'; disk?: string; key: string }
  | { driver: 'lucid'; table?: string; connection?: string; key?: string }
  | { driver: 'redis'; connection?: string; key?: string }
  | {
      driver: 'hashicorp-vault';
      endpoint: string;
      path: string;
      token?: string;
      mount?: string;
      field?: string;
    }
  | { driver: 'aws-secrets-manager'; secretId: string; region?: string }
  | { driver: 'gcp-secret-manager'; name: string }
  | { driver: 'azure-key-vault'; vaultUrl: string; secretName: string };

export interface JwksConfig {
  /** 'managed' = lib gera/rotaciona/persiste; 'jwks' = fornecido inline */
  source: 'managed' | 'jwks';
  /** usado quando source='managed' */
  rotationDays?: number;
  algorithm?: 'RS256' | 'ES256' | 'PS256' | 'EdDSA';
  /**
   * Onde o keystore PRIVADO managed é persistido. String = atalho p/ arquivo
   * (`{driver:'file', path}`). Objeto `{ driver }` = cofre (file/drive/vault).
   * Ausente = chave efêmera por boot (sem rotação real).
   */
  store?: KeystoreStoreConfig;
  /** Encripta o keystore em repouso (APP_KEY). Default backend-aware: file/drive ON, vault real OFF. */
  encrypt?: boolean;
  /** usado quando source='jwks' */
  keys?: Record<string, unknown>[];
}

export interface ObservabilityConfig {
  metrics?: boolean;
  jsonRoutes?: boolean;
  dashboard?: boolean;
}

/** Formato de emissão de um Access Token. */
export type AccessTokenFormat = 'opaque' | 'jwt';

/**
 * Configuração de um Resource Server (API) endereçável por um resource indicator
 * (RFC 8707). O resource indicator é a CHAVE no mapa `resources` — uma URI que
 * identifica a API (ex.: 'https://api.acme.com'). Quando o client solicita esse
 * `resource` no authorize/token, o Access Token emitido herda estas opções.
 */
export interface AccessTokenResourceConfig {
  /**
   * Valor da claim `aud` do JWT AT. Default: o próprio resource indicator (a chave).
   */
  audience?: string;
  /**
   * Scopes que ESTA API aceita (space/array). Quando omitido, todos os scopes do
   * provider são oferecidos a esta resource.
   */
  scopes?: string[];
  /** Formato do AT para esta resource. Default: herda o `accessTokens.format`. */
  format?: AccessTokenFormat;
  /** TTL do AT (segundos) para esta resource. Default: herda `ttl.accessToken`. */
  expiresIn?: number;
}

/**
 * Access Tokens (RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens).
 *
 * - `format: 'opaque'` (DEFAULT): o AT é uma string opaca introspecionável (comportamento atual).
 * - `format: 'jwt'`: TODO AT vira um JWT RFC 9068 (`typ: at+jwt`, claims
 *   iss/sub/aud/exp/iat/jti/client_id/scope), assinado com a chave do JWKS e
 *   validável só com o discovery/jwks_uri.
 *
 * O `audience` (modo simples jwt) define a claim `aud` do token; default = issuer.
 *
 * `resources` mapeia resource indicators (RFC 8707) → configuração por API: cada
 * chave é a URI da API que o client solicita via `resource`, permitindo audiences,
 * scopes, formato e TTL distintos por API. O caso simples NÃO precisa de `resources`.
 */
export interface AccessTokensConfig {
  /** Formato default de TODOS os ATs sem resource explícito. Default: 'opaque'. */
  format?: AccessTokenFormat;
  /**
   * Claim `aud` do JWT AT no modo simples (sem `resources`). Também é o resource
   * indicator default usado quando `format: 'jwt'`. Default: o issuer.
   */
  audience?: string;
  /** Resource Servers (APIs) endereçáveis por resource indicator (RFC 8707). */
  resources?: Record<string, AccessTokenResourceConfig>;
}

/** Forma normalizada do config do server (pós-`defineConfig`). */
export interface ResolvedAuthServerConfig {
  issuer: string;
  clients: ClientConfig[];
  ttl: Required<TtlConfig>;
  jwks: JwksConfig;
  globalRolesClaim: string;
  cookieKeys: string[];
  observability: ObservabilityConfig;
}
