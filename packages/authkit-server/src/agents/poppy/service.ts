/**
 * Lado da empresa no Poppy (Draft 0.3): o authorization server OAuth (§4 — Direct, Device, refresh,
 * revogação, extensão Mediated Sign-In), a verificação do header `Poppy-Session` e das Sessions
 * (§5), os access tokens nos resource servers (§4.5, §7) e a entrada do navegador na Session (§6).
 *
 * Sessions e acesso à conta são independentes: o sign-in não conhece a Session. Os refresh tokens
 * são grants de personal agents (`auth_agent_grants`, prefixo `pgrant_`) — a mesma
 * lista/revogação do console de conta do PACT.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import { type JWTPayload, jwtVerify } from 'jose';
import { formatScope, parseScope } from '../config.js';
import type { DelegationStore, GrantRow } from '../delegation_store.js';
import type { PoppyClient, PoppyClientRegistry } from './client_registry.js';
import { redirectUriAllowed } from './client_registry.js';
import type {
  PoppyLimiter,
  PoppyPrincipalBase,
  PoppyReplayStore,
  PoppySignInType,
  ResolvedPoppyConfig,
} from './config.js';
import { type DpopNonceSource, normalizeHtu, verifyDpopProof } from './dpop.js';
import { PoppyError } from './errors.js';
import { replayKey } from './replay.js';
import { SessionJwtError, type VerifiedSessionJwt, verifySessionJwt } from './session_jwt.js';
import type { PoppyStore, RequestRow, SessionRow } from './store.js';

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const MEDIATED_SIGN_IN_GRANT = 'https://personalagentprotocol.org/grant/mediated-sign-in';
export const MEDIATED_SIGN_IN_EXTENSION = 'mediated-sign-in';
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const POPPY_PROTOCOL_VERSION = '0.3';

/** Algoritmos das client assertions: `ES256` obrigatório, `PS384` para assinatura cega (§4.1). */
const ASSERTION_ALGS = ['ES256', 'PS384', 'ES384', 'ES512', 'RS256', 'PS256', 'EdDSA'];
const CLOCK_SKEW_S = 30;
/** Sem vogais: o código não forma palavras (RFC 8628 §6.1). */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
/** Pedido de autorização (Direct) aguardando o consentimento. */
const AUTHORIZE_REQUEST_TTL_S = 600;
/** Código de entrada do navegador: 128 bits, 60 s (guia `company-browsing`). */
const BROWSER_CODE_TTL_S = 60;
/** Só regrava a validade da Session quando o último uso já passou disso. */
const SESSION_TOUCH_INTERVAL_MS = 60_000;

/** URLs públicas do authorization server Poppy. */
export interface PoppyUrls {
  origin: string;
  issuer: string;
  /** RFC 8414 §3.1: `/.well-known/oauth-authorization-server{issuer path}`. */
  metadata: string;
  token: string;
  revocation: string;
  authorization: string;
  deviceAuthorization: string;
  /** Tela do device flow (`verification_uri`). */
  device: string;
  browserSession: string;
  discovery: string;
}

/** Deriva as URLs da ORIGEM do issuer configurado — nunca do Host da request. */
export function poppyUrls(oidcIssuer: string, prefix: string): PoppyUrls {
  const origin = new URL(oidcIssuer).origin;
  const issuer = `${origin}${prefix}`;
  return {
    origin,
    issuer,
    metadata: `${origin}/.well-known/oauth-authorization-server${prefix}`,
    token: `${issuer}/oauth/token`,
    revocation: `${issuer}/oauth/revoke`,
    authorization: `${issuer}/oauth/authorize`,
    deviceAuthorization: `${issuer}/oauth/device`,
    device: `${issuer}/device`,
    browserSession: `${issuer}/browser-session`,
    discovery: `${origin}/.well-known/poppy.json`,
  };
}

/** Resposta do token endpoint (§4.7, RFC 6749 §5.1). */
export interface PoppyTokenResponse {
  access_token: string;
  token_type: 'DPoP' | 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/** Ponte com o oidc-provider para os tokens Bearer de MCP (§7). */
export interface PoppyMcpBridge {
  /** `url` é um servidor MCP deste app (de `apis` ou do registro de resources)? */
  isMcpResource(url: string): boolean;
  /**
   * Emite o Bearer de um sign-in como access token do oidc-provider,
   * para que a integração MCP existente (`AccessToken.find`) o aceite. `null` =
   * sem ponte (o token fica só no store do Poppy).
   */
  mint?(input: {
    grantId: string;
    accountId: string;
    clientId: string;
    scope: string;
    resource: string;
    expiresIn: number;
    grantExpiresAt: Date;
  }): Promise<string | null>;
  /** Revoga o grant (e os tokens) no oidc-provider. */
  revoke?(grantId: string): Promise<void>;
}

export interface PoppyServiceDeps {
  cfg: ResolvedPoppyConfig;
  urls: PoppyUrls;
  store: PoppyStore;
  grants: DelegationStore;
  registry: PoppyClientRegistry;
  replay: PoppyReplayStore;
  limiter: PoppyLimiter | null;
  nonces: DpopNonceSource;
  /** A conta ainda pode agir? (existe e não está desabilitada). Default: sempre. */
  isAccountActive?: (accountId: string) => Promise<boolean>;
  mcp?: PoppyMcpBridge;
  now?: () => Date;
}

/** Entrada de uma request para {@link PoppyService.verifyAccess}. */
export interface PoppyRequestInput {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PoppyVerifyOptions {
  /** Scopes exigidos (todos). Sem access token: challenge 401; sem o scope: `insufficient_scope`. */
  scopes?: string[];
  /** Exige acesso à conta (um access token). */
  signedIn?: boolean;
  /**
   * `resource` exigido por este endpoint. Default: derivado da URL contra
   * `apis`/`agent.protocols` do config (entradas com `resource`) e os MCP.
   */
  resource?: string | null;
}

export type PoppyAuthError =
  | 'invalid_session'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'invalid_dpop_proof'
  | 'use_dpop_nonce';

export type PoppyVerifyResult =
  | {
      ok: true;
      principal: PoppyPrincipalBase;
      /** Grant (refresh token) do access token — `null` deslogado. */
      grantId: string | null;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 429;
      /** `null`: challenge sem código (§7, falta o access token) ou limite de taxa (§5.6). */
      error: PoppyAuthError | null;
      description: string;
      scope?: string;
      /** `null` nos erros que vão no corpo (`invalid_session`) e no 429. */
      wwwAuthenticate: string | null;
      /** Headers extras (`DPoP-Nonce`, `Retry-After`). */
      headers: Record<string, string>;
    };

/** Pedido Direct aguardando o usuário na tela de consentimento. */
export interface PoppyConsentRequest {
  id: string;
  clientId: string;
  agentName: string;
  agentOrigin: string;
  logoUri: string | null;
  scopes: { id: string; description: string }[];
  userCode?: string;
}

export type PoppyAuthorizeOutcome =
  | { kind: 'consent'; request: PoppyConsentRequest }
  | { kind: 'redirect'; url: string }
  | { kind: 'error'; description: string };

export interface PoppyGrantSummary {
  id: string;
  clientId: string;
  scopes: { id: string; description: string }[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/** O que a entrada de um navegador autorizou (§6, passo 3). */
export interface PoppyBrowserJoin {
  sessionId: string;
  clientId: string;
  userId: string;
  /** Conta autorizada no passo 2; `null` = entrada sem access token. */
  accountId: string | null;
  grantId: string | null;
  scopes: string[];
}

/** Estado atual de um navegador que entrou numa Session (§6, "The cookie"). */
export interface PoppySessionState {
  active: boolean;
  sessionId: string;
  clientId: string;
  userId: string;
  accountId: string | null;
  signedIn: boolean;
  scopes: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomId(prefix: string, bytes = 16): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function newUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Aceita o código como o usuário digitar: minúsculas, sem hífen, com espaços. */
export function normalizePoppyUserCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== 8) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function str(value: unknown): string | undefined {
  if (Array.isArray(value)) return undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sameUrl(a: string, b: string): boolean {
  const na = normalizeHtu(a);
  const nb = normalizeHtu(b);
  return na !== null && nb !== null && trimSlash(na) === trimSlash(nb);
}

/** `true` quando `url` está "debaixo" de `base` (mesma origem, path igual ou filho). */
function underUrl(url: string, base: string): boolean {
  const u = normalizeHtu(url);
  const b = normalizeHtu(base);
  if (!u || !b) return false;
  const ub = trimSlash(b);
  return trimSlash(u) === ub || u.startsWith(`${ub}/`);
}

function header(
  headers: PoppyRequestInput['headers'],
  name: string,
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function quote(value: string): string {
  return value.replace(/["\\]/g, '');
}

/** A URL da protected resource metadata de um resource (RFC 9728 §3.1). */
function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** Slot global onde o `@adonis-agora/agent` registra o endpoint de conversas Poppy. */
export const POPPY_ENDPOINTS_SLOT = Symbol.for('@adonis-agora/poppy:endpoints');

/**
 * `agent.protocols` vindo do slot `Symbol.for('@adonis-agora/poppy:endpoints')`
 * (`{ conversations: 'https://…' }`), usado quando o config não declara
 * `agent.protocols` — o mesmo padrão do slot de resources do MCP.
 */
export function registeredConversationProtocols(): {
  type: string;
  endpoint: string;
  access?: 'session' | 'signed_in';
}[] {
  const slot = (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT] as
    | { conversations?: unknown }
    | undefined;
  const url = slot?.conversations;
  if (typeof url !== 'string') return [];
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return [];
  } catch {
    return [];
  }
  return [{ type: 'poppy', endpoint: url }];
}

/**
 * @experimental Poppy (Personal Agent Protocol) Draft 0.3 — pode mudar de forma incompatível enquanto a spec for draft.
 */
export class PoppyService {
  readonly cfg: ResolvedPoppyConfig;
  readonly urls: PoppyUrls;
  readonly registry: PoppyClientRegistry;
  #store: PoppyStore;
  #grants: DelegationStore;
  #replay: PoppyReplayStore;
  #limiter: PoppyLimiter | null;
  #nonces: DpopNonceSource;
  #isAccountActive: (accountId: string) => Promise<boolean>;
  #mcp: PoppyMcpBridge | undefined;
  #now: () => Date;
  #housekeepingAt = 0;

  constructor(deps: PoppyServiceDeps) {
    this.cfg = deps.cfg;
    this.urls = deps.urls;
    this.registry = deps.registry;
    this.#store = deps.store;
    this.#grants = deps.grants;
    this.#replay = deps.replay;
    this.#limiter = deps.limiter;
    this.#nonces = deps.nonces;
    this.#isAccountActive = deps.isAccountActive ?? (async () => true);
    this.#mcp = deps.mcp;
    this.#now = deps.now ?? (() => new Date());
  }

  /** Um nonce DPoP novo (header `DPoP-Nonce`), quando o app exige nonces. */
  nonce(): string | null {
    return this.cfg.dpop.requireNonce ? this.#nonces.issue() : null;
  }

  /** Domínios da empresa (o principal + aliases). */
  get domains(): string[] {
    return [this.cfg.organization.domain, ...this.cfg.organization.aliases];
  }

  /** Descrição de um scope para o usuário. */
  describe(ids: string[]): { id: string; description: string }[] {
    return ids.map((id) => ({ id, description: this.cfg.scopes[id] ?? id }));
  }

  // ─── descoberta ───────────────────────────────────────────────────────────

  /** A URL `https://{domain}` de um domínio (no host do issuer, a origem dele — dev com porta). */
  #domainUrl(domain: string): string {
    const issuer = new URL(this.urls.origin);
    return domain === issuer.hostname.toLowerCase()
      ? this.urls.origin
      : `${issuer.protocol}//${domain}`;
  }

  /** O domínio da empresa que o host serve, sem normalizar nada além de caixa e porta (§3.1). */
  #domainOf(requestHost: string): { domain: string; hostWithPort: string } | null {
    const hostWithPort = requestHost
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/\.(:\d+)$/, '$1');
    const host = hostWithPort.replace(/:\d+$/, '');
    const domain = this.domains.find((d) => d === host);
    return domain ? { domain, hostWithPort } : null;
  }

  /** `www.{domínio}` não é a empresa (§3.1): a descoberta redireciona para o domínio (§3). */
  discoveryRedirect(requestHost: string): string | null {
    const host = requestHost.toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
    if (!host.startsWith('www.') || this.domains.includes(host)) return null;
    const bare = host.slice(4);
    if (!this.domains.includes(bare)) return null;
    return `${this.#domainUrl(bare)}/.well-known/poppy.json`;
  }

  /** `/.well-known/poppy.json` (§3) para o domínio pedido; `null` = domínio que não é nosso. */
  discoveryDocument(requestHost: string): Record<string, unknown> | null {
    const match = this.#domainOf(requestHost);
    if (!match) return null;
    const { domain, hostWithPort } = match;
    const auth: Record<string, unknown> = { issuer: this.urls.issuer };
    if (Object.keys(this.cfg.scopes).length > 0) auth.scopes = this.cfg.scopes;
    if (Object.keys(this.cfg.scopeHints).length > 0) auth.scope_hints = this.cfg.scopeHints;

    const doc: Record<string, unknown> = {
      protocol_version: POPPY_PROTOCOL_VERSION,
      organization: { name: this.cfg.organization.name, domain },
      auth,
    };
    const protocols = this.cfg.agent?.protocols ?? registeredConversationProtocols();
    if (protocols.length > 0) {
      doc.agent = {
        protocols: protocols.map((p) => ({
          type: p.type,
          endpoint: p.endpoint,
          ...(p.access ? { access: p.access } : {}),
        })),
      };
    }
    if (this.cfg.web) {
      doc.web = this.cfg.web.browserSession
        ? { browser_session_endpoint: this.#browserSessionEndpointFor(hostWithPort) }
        : {};
    }
    if (this.cfg.feedback) doc.feedback = { endpoint: this.cfg.feedback.endpoint };
    if (this.cfg.excludedTasks) doc.excluded_tasks = { url: this.cfg.excludedTasks.url };
    if (this.cfg.apis.length > 0) {
      doc.apis = this.cfg.apis.map((a) => ({
        type: a.type,
        url: a.url,
        description: a.description,
      }));
    }
    const extensions: Record<string, unknown> = { ...this.cfg.extensions };
    const mediated = this.cfg.signIn.mediated;
    if (mediated) {
      extensions[MEDIATED_SIGN_IN_EXTENSION] = {
        version: '1',
        fields: mediated.fields,
        scopes: mediated.scopes,
      };
    }
    if (Object.keys(extensions).length > 0) doc.extensions = extensions;
    return doc;
  }

  /** `/.well-known/oauth-protected-resource` do domínio (§3.2, RFC 9728): aponta o issuer. */
  protectedResourceMetadata(requestHost: string): Record<string, unknown> | null {
    const match = this.#domainOf(requestHost);
    if (!match) return null;
    return {
      resource: this.#domainUrl(match.domain),
      authorization_servers: [this.urls.issuer],
    };
  }

  /** RFC 8414 com `protected_resources` (§3.2). */
  authorizationServerMetadata(): Record<string, unknown> {
    const { signIn } = this.cfg;
    const grants = ['refresh_token'];
    if (signIn.direct) grants.push('authorization_code');
    if (signIn.device) grants.push(DEVICE_CODE_GRANT);
    if (signIn.mediated) grants.push(MEDIATED_SIGN_IN_GRANT);
    return {
      issuer: this.urls.issuer,
      token_endpoint: this.urls.token,
      revocation_endpoint: this.urls.revocation,
      ...(signIn.direct ? { authorization_endpoint: this.urls.authorization } : {}),
      ...(signIn.device ? { device_authorization_endpoint: this.urls.deviceAuthorization } : {}),
      protected_resources: [
        ...this.domains.map((d) => this.#domainUrl(d)),
        ...this.cfg.apis.filter((a) => a.type === 'mcp').map((a) => a.url),
      ],
      scopes_supported: Object.keys(this.cfg.scopes),
      response_types_supported: signIn.direct ? ['code'] : [],
      response_modes_supported: signIn.direct ? ['query'] : [],
      grant_types_supported: grants,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGS,
      revocation_endpoint_auth_methods_supported: ['private_key_jwt'],
      revocation_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGS,
      dpop_signing_alg_values_supported: this.cfg.dpop.algorithms,
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    };
  }

  /**
   * O endpoint no host pedido (o cookie do site é do domínio que o agente abriu). No host do issuer
   * é o do issuer — com a porta dele: o `Host` pode vir sem porta (ou o controller só ter o
   * hostname), e `http://localhost/poppy/…` apontaria para outro servidor.
   */
  #browserSessionEndpointFor(requestHost: string): string {
    const issuer = new URL(this.urls.origin);
    let requested: URL;
    try {
      requested = new URL(`${issuer.protocol}//${requestHost}`);
    } catch {
      return this.urls.browserSession;
    }
    if (requested.hostname === issuer.hostname.toLowerCase()) return this.urls.browserSession;
    const path = new URL(this.urls.browserSession).pathname;
    return `${issuer.protocol}//${requested.host}${path}`;
  }

  // ─── autenticação do agente ───────────────────────────────────────────────

  /**
   * `private_key_jwt` (§4.1, RFC 7523): `client_assertion` assinada por uma chave do `jwks_uri`,
   * `iss` = `sub` = `client_id`, `aud` = o issuer como UMA string, curta, com `iat` e `jti` únicos.
   */
  async authenticateClient(form: Record<string, unknown>): Promise<PoppyClient> {
    const clientId = str(form.client_id);
    const type = str(form.client_assertion_type);
    const assertion = str(form.client_assertion);
    const bad = (why: string) => new PoppyError('invalid_client', why);
    if (!clientId || type !== CLIENT_ASSERTION_TYPE || !assertion) {
      throw bad('private_key_jwt client authentication is required');
    }
    const client = await this.registry.resolve(clientId);
    const now = this.#now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(assertion, client.keys, {
        algorithms: ASSERTION_ALGS,
        issuer: client.clientId,
        subject: clientId,
        currentDate: now,
        clockTolerance: CLOCK_SKEW_S,
        requiredClaims: ['exp', 'iat', 'jti'],
      }));
    } catch {
      throw bad('client assertion verification failed');
    }
    if (typeof payload.aud !== 'string' || payload.aud !== this.urls.issuer) {
      throw bad('aud must be the issuer, as a single string');
    }
    const nowS = Math.floor(now.getTime() / 1000);
    if (payload.iat! > nowS + CLOCK_SKEW_S) throw bad('iat is in the future');
    if (payload.exp! - payload.iat! > this.cfg.assertionMaxLifetime) {
      throw bad('the client assertion lifetime is too long');
    }
    if (typeof payload.jti !== 'string' || !payload.jti) throw bad('jti is required');
    const expiresAt = new Date((payload.exp! + CLOCK_SKEW_S) * 1000);
    if (!(await this.#replay.claim(replayKey('client', clientId, payload.jti), expiresAt))) {
      throw bad('jti was already used');
    }
    return client;
  }

  // ─── token endpoint ───────────────────────────────────────────────────────

  /** `POST token_endpoint` (§4.2–§4.4, §4.7, extensão Mediated Sign-In). */
  async token(
    form: Record<string, unknown>,
    dpopHeader: string | string[] | undefined,
    ctx?: HttpContext,
  ): Promise<PoppyTokenResponse> {
    await this.#housekeeping();
    const client = await this.authenticateClient(form);
    const grantType = str(form.grant_type);
    if (
      grantType !== 'refresh_token' &&
      !(grantType === 'authorization_code' && this.cfg.signIn.direct) &&
      !(grantType === DEVICE_CODE_GRANT && this.cfg.signIn.device) &&
      !(grantType === MEDIATED_SIGN_IN_GRANT && this.cfg.signIn.mediated)
    ) {
      throw new PoppyError('unsupported_grant_type', 'Unsupported grant_type');
    }
    const binding = await this.#tokenBinding(form, dpopHeader);
    const scopeParam = form.scope;
    const requestedScope = scopeParam === undefined ? null : parseScope(str(scopeParam) ?? '');

    switch (grantType) {
      case 'refresh_token':
        return this.#refresh(client, form, binding, requestedScope);
      case 'authorization_code':
        return this.#authorizationCode(client, form, binding, requestedScope);
      case MEDIATED_SIGN_IN_GRANT:
        return this.#mediated(client, form, binding, ctx);
      default:
        return this.#deviceCode(client, form, binding, requestedScope);
    }
  }

  /**
   * O `resource` (RFC 8707, §4.5) e a chave DPoP do token. DPoP é escolha da empresa: uma prova
   * prende o token (RFC 9449 §5), sem prova ele sai Bearer, a não ser com `dpop.required`. Servidor
   * MCP recebe Bearer: é o baseline do MCP, e os daqui não anunciam DPoP (§7).
   */
  async #tokenBinding(
    form: Record<string, unknown>,
    dpopHeader: string | string[] | undefined,
  ): Promise<{ jkt: string | null; resource: string | null }> {
    const rawResource = form.resource;
    if (Array.isArray(rawResource)) {
      throw new PoppyError('invalid_target', 'Request a token for one resource at a time');
    }
    const resource = str(rawResource) ?? null;
    if (resource && this.#isMcp(resource)) return { jkt: null, resource: this.#mcpUrl(resource) };
    if (resource && !this.#isConfiguredResource(resource)) {
      throw new PoppyError('invalid_target', 'Unknown resource');
    }
    if (dpopHeader === undefined || dpopHeader === '') {
      if (this.cfg.dpop.required) {
        throw new PoppyError('invalid_dpop_proof', 'A DPoP proof is required');
      }
      return { jkt: null, resource };
    }
    const result = await verifyDpopProof({
      proof: dpopHeader,
      method: 'POST',
      url: this.urls.token,
      algorithms: this.cfg.dpop.algorithms,
      maxAge: this.cfg.dpop.maxAge,
      replay: this.#replay,
      nonce: { required: this.cfg.dpop.requireNonce, source: this.#nonces },
      now: () => this.#now().getTime(),
    });
    if (!result.ok) {
      throw new PoppyError(result.error, result.description, {
        headers: result.error === 'use_dpop_nonce' ? { 'DPoP-Nonce': this.#nonces.issue() } : {},
      });
    }
    return { jkt: result.jkt, resource };
  }

  /** `resource`s que exigem tokens próprios (§4.5): os declarados em `apis` e `agent.protocols`. */
  #isConfiguredResource(resource: string): boolean {
    const entries = [
      ...this.cfg.apis.filter((a) => a.type !== 'mcp').map((a) => a.resource),
      ...(this.cfg.agent?.protocols ?? []).map((p) => p.resource),
    ].filter((r): r is string => !!r);
    return entries.some((r) => sameUrl(r, resource));
  }

  #isMcp(url: string): boolean {
    if (this.cfg.apis.some((a) => a.type === 'mcp' && sameUrl(a.url, url))) return true;
    return this.#mcp?.isMcpResource(url) ?? false;
  }

  /** A URL canônica do MCP (a de `apis`, quando listado). */
  #mcpUrl(url: string): string {
    const listed = this.cfg.apis.find((a) => a.type === 'mcp' && sameUrl(a.url, url));
    return listed ? listed.url : url;
  }

  /** Refresh (§4.4): access token novo; o refresh token continua o mesmo (RFC 6749 §6). */
  async #refresh(
    client: PoppyClient,
    form: Record<string, unknown>,
    binding: { jkt: string | null; resource: string | null },
    requestedScope: string[] | null,
  ): Promise<PoppyTokenResponse> {
    const token = str(form.refresh_token);
    if (!token) throw new PoppyError('invalid_grant', 'refresh_token is required');
    const now = this.#now();
    const invalid = new PoppyError('invalid_grant', 'Unknown, expired or revoked refresh token');
    const row = await this.#grants.findRefreshToken(sha256(token));
    if (!row || row.expiresAt <= now) throw invalid;
    const grant = await this.#grants.findGrant(row.grantId);
    if (!grant || !(await this.#grantUsable(grant, client.clientId, now))) throw invalid;
    const scopes = this.#narrow(parseScope(grant.scope), requestedScope);
    return this.#issue(grant, scopes, binding);
  }

  async #authorizationCode(
    client: PoppyClient,
    form: Record<string, unknown>,
    binding: { jkt: string | null; resource: string | null },
    requestedScope: string[] | null,
  ): Promise<PoppyTokenResponse> {
    const code = str(form.code);
    if (!code) throw new PoppyError('invalid_request', 'code is required');
    const now = this.#now();
    const row = await this.#store.findRequestByCodeHash(sha256(code));
    const invalid = new PoppyError('invalid_grant', 'Unknown, expired or used authorization code');
    if (row?.kind !== 'authorize' || row.clientId !== client.clientId) throw invalid;
    if (row.status === 'consumed') {
      // Código reusado: revoga o que ele já entregou (RFC 6749 §4.1.2).
      const grantId = row.data?.grantId;
      if (typeof grantId === 'string') await this.revokeGrant(grantId);
      throw invalid;
    }
    if (row.status !== 'approved' || row.expiresAt <= now || !row.accountId) throw invalid;
    if (str(form.redirect_uri) !== row.redirectUri) {
      throw new PoppyError(
        'invalid_grant',
        'redirect_uri does not match the authorization request',
      );
    }
    const verifier = str(form.code_verifier);
    if (
      !verifier ||
      !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) ||
      createHash('sha256').update(verifier).digest('base64url') !== row.codeChallenge
    ) {
      throw new PoppyError('invalid_grant', 'PKCE verification failed');
    }
    if (!(await this.#store.transitionRequest(row.id, 'approved', { status: 'consumed' }))) {
      throw invalid;
    }
    const granted = parseScope(row.grantedScope);
    const response = await this.#signIn(
      client.clientId,
      row.accountId,
      granted,
      binding,
      requestedScope,
    );
    await this.#store.setRequestData(row.id, { ...(row.data ?? {}), grantId: response.grantId });
    return response.body;
  }

  async #deviceCode(
    client: PoppyClient,
    form: Record<string, unknown>,
    binding: { jkt: string | null; resource: string | null },
    requestedScope: string[] | null,
  ): Promise<PoppyTokenResponse> {
    const deviceCode = str(form.device_code);
    if (!deviceCode) throw new PoppyError('invalid_request', 'device_code is required');
    const row = await this.#store.findRequestByCodeHash(sha256(deviceCode));
    if (row?.kind !== 'device' || row.clientId !== client.clientId) {
      throw new PoppyError('invalid_grant', 'Unknown device_code');
    }
    const now = this.#now();
    if (row.status === 'denied') throw new PoppyError('access_denied', 'The user denied access');
    if (row.status === 'consumed') throw new PoppyError('invalid_grant', 'device_code was used');
    if (row.expiresAt <= now) throw new PoppyError('expired_token', 'The device code expired');
    if (row.status === 'pending') {
      const interval = row.intervalSeconds ?? this.cfg.pollInterval;
      const tooSoon =
        row.lastPolledAt !== null && now.getTime() - row.lastPolledAt.getTime() < interval * 1000;
      await this.#store.markPolled(row.id, now);
      throw tooSoon
        ? new PoppyError('slow_down', 'Poll less often')
        : new PoppyError('authorization_pending', 'Waiting for the user');
    }
    if (row.status !== 'approved' || !row.accountId) {
      throw new PoppyError('invalid_grant', 'Unknown device_code');
    }
    if (!(await this.#store.transitionRequest(row.id, 'approved', { status: 'consumed' }))) {
      throw new PoppyError('invalid_grant', 'device_code was used');
    }
    const result = await this.#signIn(
      client.clientId,
      row.accountId,
      parseScope(row.grantedScope),
      binding,
      requestedScope,
    );
    return result.body;
  }

  /** `POST device_authorization_endpoint` (§4.6). */
  async deviceAuthorization(form: Record<string, unknown>): Promise<Record<string, unknown>> {
    const device = this.cfg.signIn.device;
    if (!device) throw new PoppyError('unauthorized_client', 'Device Sign-In is not offered');
    await this.#housekeeping();
    const client = await this.authenticateClient(form);
    const scopes = this.#signInScopes(form.scope, 'device');
    const now = this.#now();
    const deviceCode = randomId('pdc_', 32);
    const expiresAt = new Date(now.getTime() + this.cfg.deviceCodeTtl * 1000);
    let userCode = newUserCode();
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#store.insertRequest({
          id: randomId('dev_'),
          kind: 'device',
          codeHash: sha256(deviceCode),
          userCode,
          clientId: client.clientId,
          sessionId: null,
          accountId: null,
          requestedScope: formatScope(scopes),
          redirectUri: null,
          codeChallenge: null,
          status: 'pending',
          intervalSeconds: this.cfg.pollInterval,
          data: null,
          expiresAt,
          createdAt: now,
        });
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        userCode = newUserCode();
      }
    }
    const complete = new URL(this.urls.device);
    complete.searchParams.set('user_code', userCode);
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: this.urls.device,
      verification_uri_complete: complete.toString(),
      expires_in: this.cfg.deviceCodeTtl,
      interval: this.cfg.pollInterval,
    };
  }

  /** `POST revocation_endpoint` (§4.6, RFC 7009). */
  async revoke(form: Record<string, unknown>): Promise<void> {
    const client = await this.authenticateClient(form);
    const token = str(form.token);
    if (!token) throw new PoppyError('invalid_request', 'token is required');
    const hint = str(form.token_type_hint);
    if (hint && hint !== 'refresh_token' && hint !== 'access_token') {
      throw new PoppyError('unsupported_token_type', 'Unsupported token_type_hint');
    }
    const hash = sha256(token);
    const refresh = await this.#grants.findRefreshToken(hash);
    if (refresh) {
      const grant = await this.#grants.findGrant(refresh.grantId);
      // De outro agente: RFC 7009 — token inválido para este cliente, nada acontece.
      if (grant && grant.clientId === client.clientId && grant.id.startsWith('pgrant_')) {
        await this.revokeGrant(grant.id);
      }
      return;
    }
    const sessionToken = await this.#store.findToken(hash);
    if (sessionToken && sessionToken.clientId === client.clientId) {
      await this.#store.deleteToken(hash);
    }
  }

  /**
   * Revoga um refresh token (grant): os access tokens dele morrem junto (RFC 7009 §2.1), as
   * Sessions continuam deslogadas (§5.5) e os Bearer de MCP no oidc-provider também caem.
   */
  async revokeGrant(grantId: string): Promise<void> {
    await this.#grants.revokeGrantById(grantId, this.#now());
    await this.#mcp?.revoke?.(grantId);
  }

  // ─── Direct Sign-In (§4.2) ────────────────────────────────────────────────

  /**
   * `GET authorization_endpoint` com o usuário já logado neste app. Erros no
   * `client_id`/`redirect_uri` não redirecionam (RFC 6749 §4.1.2.1); os demais
   * voltam ao agente com `error`, `state` e `iss`.
   */
  async startAuthorization(
    params: Record<string, unknown>,
    accountId: string,
  ): Promise<PoppyAuthorizeOutcome> {
    const direct = this.cfg.signIn.direct;
    if (!direct) return { kind: 'error', description: 'Direct Sign-In is not offered' };
    let client: PoppyClient;
    try {
      client = await this.registry.resolve(params.client_id);
    } catch (error) {
      return {
        kind: 'error',
        description: error instanceof PoppyError ? error.description : 'invalid client',
      };
    }
    const redirectUri = str(params.redirect_uri);
    if (!redirectUri || !redirectUriAllowed(client.redirectUris, redirectUri)) {
      return { kind: 'error', description: 'redirect_uri is not registered for this client' };
    }
    const state = str(params.state);
    const back = (error: string, description: string) => ({
      kind: 'redirect' as const,
      url: this.#redirect(redirectUri, { error, error_description: description, state }),
    });
    if (str(params.response_type) !== 'code') {
      return back('unsupported_response_type', 'response_type must be code');
    }
    const challenge = str(params.code_challenge);
    if (
      str(params.code_challenge_method) !== 'S256' ||
      !challenge ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    ) {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    let scopes: string[];
    try {
      scopes = this.#signInScopes(params.scope, 'direct');
    } catch (error) {
      return back(
        'invalid_scope',
        error instanceof PoppyError ? error.description : 'invalid scope',
      );
    }
    await this.#housekeeping();
    const now = this.#now();
    const id = randomId('azr_');
    await this.#store.insertRequest({
      id,
      kind: 'authorize',
      codeHash: null,
      userCode: null,
      clientId: client.clientId,
      sessionId: null,
      accountId,
      requestedScope: formatScope(scopes),
      redirectUri,
      codeChallenge: challenge,
      status: 'pending',
      intervalSeconds: null,
      data: state !== undefined ? { state } : {},
      expiresAt: new Date(now.getTime() + AUTHORIZE_REQUEST_TTL_S * 1000),
      createdAt: now,
    });
    return {
      kind: 'consent',
      request: {
        id,
        clientId: client.clientId,
        agentName: client.name,
        agentOrigin: new URL(client.clientId).host,
        logoUri: client.logoUri,
        scopes: this.describe(scopes),
      },
    };
  }

  /**
   * `POST` da tela de consentimento Direct. Devolve para onde mandar o
   * navegador (`code`/`error`, `state`, `iss`), ou `null` quando o pedido não
   * vale mais (expirou, decidido em outra aba, de outra conta).
   */
  async decideAuthorization(input: {
    requestId: string;
    accountId: string;
    allow: boolean;
    scopes: string[];
  }): Promise<{ url: string; approved: string[] | null; clientId: string } | null> {
    const row = await this.#store.findRequest(input.requestId);
    const now = this.#now();
    if (
      row?.kind !== 'authorize' ||
      row.status !== 'pending' ||
      row.expiresAt <= now ||
      row.accountId !== input.accountId ||
      !row.redirectUri
    ) {
      return null;
    }
    const state = typeof row.data?.state === 'string' ? row.data.state : undefined;
    const requested = parseScope(row.requestedScope);
    const granted = input.allow ? requested.filter((s) => input.scopes.includes(s)) : [];
    if (granted.length === 0) {
      if (!(await this.#store.transitionRequest(row.id, 'pending', { status: 'denied' })))
        return null;
      return {
        url: this.#redirect(row.redirectUri, { error: 'access_denied', state }),
        approved: null,
        clientId: row.clientId,
      };
    }
    const code = randomBytes(32).toString('base64url');
    if (
      !(await this.#store.transitionRequest(row.id, 'pending', {
        status: 'approved',
        codeHash: sha256(code),
        grantedScope: formatScope(granted),
        expiresAt: new Date(now.getTime() + this.cfg.authorizationCodeTtl * 1000),
      }))
    ) {
      return null;
    }
    return {
      url: this.#redirect(row.redirectUri, { code, state }),
      approved: granted,
      clientId: row.clientId,
    };
  }

  /** `redirect_uri` + params + `iss` (RFC 9207). */
  #redirect(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set('iss', this.urls.issuer);
    return url.toString();
  }

  // ─── Device Sign-In: tela (§4.3) ──────────────────────────────────────────

  async pendingDevice(userCodeInput: unknown): Promise<PoppyConsentRequest | null> {
    const userCode = normalizePoppyUserCode(userCodeInput);
    if (!userCode) return null;
    const row = await this.#store.findRequestByUserCode(userCode);
    if (row?.kind !== 'device' || row.status !== 'pending' || row.expiresAt <= this.#now()) {
      return null;
    }
    const name = await this.registry.displayName(row.clientId);
    return {
      id: row.id,
      clientId: row.clientId,
      agentName: name,
      agentOrigin: new URL(row.clientId).host,
      logoUri: null,
      scopes: this.describe(parseScope(row.requestedScope)),
      userCode: row.userCode ?? undefined,
    };
  }

  /** Aprova (scopes marcados) ou nega um device code. `null` = não está mais pendente. */
  async decideDevice(input: {
    userCode: string;
    accountId: string;
    allow: boolean;
    scopes: string[];
  }): Promise<{ approved: string[] | null; clientId: string } | null> {
    const userCode = normalizePoppyUserCode(input.userCode);
    const row = userCode ? await this.#store.findRequestByUserCode(userCode) : null;
    if (row?.kind !== 'device' || row.status !== 'pending' || row.expiresAt <= this.#now()) {
      return null;
    }
    const granted = input.allow
      ? parseScope(row.requestedScope).filter((s) => input.scopes.includes(s))
      : [];
    if (granted.length === 0) {
      const ok = await this.#store.transitionRequest(row.id, 'pending', {
        status: 'denied',
        accountId: input.accountId,
      });
      return ok ? { approved: null, clientId: row.clientId } : null;
    }
    const ok = await this.#store.transitionRequest(row.id, 'pending', {
      status: 'approved',
      accountId: input.accountId,
      grantedScope: formatScope(granted),
    });
    return ok ? { approved: granted, clientId: row.clientId } : null;
  }

  // ─── extensão Mediated Sign-In ────────────────────────────────────────────

  /** O grant de extensão no token endpoint: credenciais ou `sign_in_id` + `one_time_code`. */
  async #mediated(
    client: PoppyClient,
    form: Record<string, unknown>,
    binding: { jkt: string | null; resource: string | null },
    ctx: HttpContext | undefined,
  ): Promise<PoppyTokenResponse> {
    if (form.sign_in_id !== undefined) return this.#mediatedCode(client, form, binding);
    const mediated = this.cfg.signIn.mediated!;
    if (!ctx) throw new Error('authkit: Mediated Sign-In precisa do HttpContext.');
    const scopes = this.#signInScopes(form.scope, 'mediated');
    const credentials: Record<string, string> = {};
    for (const field of mediated.fields) {
      const value = str(form[field.name]);
      if (!value) throw new PoppyError('invalid_request', `${field.name} is required`);
      credentials[field.name] = value;
    }
    // Por agente e pelo que identifica a conta — nunca pelos valores secretos em claro.
    const identifier = mediated.fields
      .filter((f) => !f.secret)
      .map((f) => credentials[f.name])
      .join('\u0000');
    await this.#limit('mediated', `${client.clientId}\u0000${sha256(identifier)}`);

    const result = await mediated.verify({
      credentials,
      scopes,
      clientId: client.clientId,
      ctx,
    });
    if (result?.status === 'denied') {
      throw new PoppyError('access_denied', 'The Company refused this sign-in');
    }
    if (result?.status === 'complete') {
      const done = await this.#signIn(client.clientId, result.accountId, scopes, binding, null);
      return done.body;
    }
    if (result?.status !== 'code_required') {
      throw new PoppyError('invalid_grant', 'Sign-in did not succeed');
    }
    // `accountId: null` = sem conta elegível (anti-enumeração): a resposta é a mesma de uma conta
    // real e nenhum código vale.
    const decoy = result.accountId === null;
    if (!decoy && result.code === undefined && !mediated.verifyCode) {
      throw new Error(
        'authkit: personalAgents.poppy.signIn.mediated — `verify` devolveu code_required sem `code` e não há `verifyCode`.',
      );
    }
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + mediated.codeTtl * 1000);
    const id = randomId('sgn_');
    await this.#store.insertRequest({
      id,
      kind: 'mediated',
      codeHash: null,
      userCode: null,
      clientId: client.clientId,
      sessionId: null,
      accountId: result.accountId,
      requestedScope: formatScope(scopes),
      redirectUri: null,
      codeChallenge: null,
      status: 'pending',
      intervalSeconds: null,
      data: {
        sentTo: result.sentTo,
        ...(!decoy && result.code !== undefined
          ? { codeHash: sha256(`${id}:${result.code}`) }
          : {}),
        ...(result.state !== undefined ? { state: result.state } : {}),
      },
      expiresAt,
      createdAt: now,
    });
    throw this.#codeRequired(id, result.sentTo, mediated.codeTtl);
  }

  #codeRequired(signInId: string, sentTo: string, expiresIn: number): PoppyError {
    return new PoppyError('code_required', 'A one-time code was sent to the user', {
      extra: { sign_in_id: signInId, sent_to: sentTo, expires_in: expiresIn },
    });
  }

  async #mediatedCode(
    client: PoppyClient,
    form: Record<string, unknown>,
    binding: { jkt: string | null; resource: string | null },
  ): Promise<PoppyTokenResponse> {
    const mediated = this.cfg.signIn.mediated!;
    const invalid = new PoppyError('invalid_grant', 'Sign-in did not succeed');
    const row = await this.#store.findRequest(str(form.sign_in_id) ?? '');
    // Só o `client_id` que começou o sign-in termina. De outro = não existe.
    if (row?.kind !== 'mediated' || row.clientId !== client.clientId) throw invalid;
    if (row.status !== 'pending') throw invalid;
    const now = this.#now();
    if (row.expiresAt <= now) throw new PoppyError('expired_token', 'The sign-in expired');
    const code = str(form.one_time_code);
    if (!code) throw new PoppyError('invalid_request', 'one_time_code is required');
    const data = row.data ?? {};
    let correct: boolean;
    if (row.accountId === null) {
      // Identificador sem conta (anti-enumeração): todo código é um código errado.
      correct = false;
    } else if (typeof data.codeHash === 'string') {
      correct = sha256(`${row.id}:${code}`) === data.codeHash;
    } else {
      correct =
        (await mediated.verifyCode?.({
          code,
          accountId: row.accountId,
          state: data.state,
          clientId: row.clientId,
        })) === true;
    }
    if (!correct) {
      const attempts = row.attempts + 1;
      if (attempts >= mediated.maxCodeAttempts) {
        await this.#store.transitionRequest(row.id, 'pending', { status: 'failed', attempts });
        throw invalid;
      }
      if (!(await this.#store.bumpAttempts(row.id, row.attempts))) throw invalid;
      const left = Math.max(1, Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000));
      throw this.#codeRequired(row.id, String(data.sentTo ?? ''), left);
    }
    if (!(await this.#store.transitionRequest(row.id, 'pending', { status: 'consumed' }))) {
      throw invalid;
    }
    const done = await this.#signIn(
      client.clientId,
      row.accountId!,
      parseScope(row.requestedScope),
      binding,
      null,
    );
    return done.body;
  }

  // ─── Sessions e resource server (§4.5, §5.2–§5.4, §7) ─────────────────────

  /**
   * Verifica uma request às APIs/conversas do app: o header `Poppy-Session` (§5.3) e, se houver, o
   * access token (`Authorization: Bearer|DPoP`, com a prova DPoP). Um `sid` novo começa uma Session
   * deslogada; a request é logada só quando traz access token. Nunca lê token da URL (§5.6).
   */
  async verifyAccess(
    input: PoppyRequestInput,
    options: PoppyVerifyOptions = {},
  ): Promise<PoppyVerifyResult> {
    const target = this.#endpointFor(input.url, options.resource);
    const resourceMetadata = target.mcp ? resourceMetadataUrl(target.mcp) : undefined;
    const challenge = (
      status: 401 | 403,
      error: PoppyAuthError | null,
      description: string,
      extra: {
        scope?: string;
        schemes?: string[];
        resourceMetadata?: string;
        headers?: Record<string, string>;
      } = {},
    ): PoppyVerifyResult => {
      const metadata = extra.resourceMetadata ?? resourceMetadata;
      const params = [
        ...(error ? [`error="${error}"`, `error_description="${quote(description)}"`] : []),
        ...(extra.scope ? [`scope="${quote(extra.scope)}"`] : []),
        ...(metadata ? [`resource_metadata="${quote(metadata)}"`] : []),
      ];
      const schemes = extra.schemes ?? this.#acceptedSchemes(target.mcp !== null);
      const wwwAuthenticate = schemes
        .map((scheme) => {
          const all =
            scheme === 'DPoP'
              ? [`algs="${this.cfg.dpop.algorithms.join(' ')}"`, ...params]
              : params;
          return all.length > 0 ? `${scheme} ${all.join(', ')}` : scheme;
        })
        .join(', ');
      return {
        ok: false,
        status,
        error,
        description,
        ...(extra.scope ? { scope: extra.scope } : {}),
        wwwAuthenticate,
        headers: extra.headers ?? {},
      };
    };
    const invalidSession = (description: string): PoppyVerifyResult => ({
      ok: false,
      status: 400,
      error: 'invalid_session',
      description,
      wwwAuthenticate: null,
      headers: {},
    });

    const auth = header(input.headers, 'authorization');
    const authValue = Array.isArray(auth) ? undefined : auth;
    const match = authValue
      ? /^(DPoP|Bearer)\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(authValue)
      : null;
    if (auth !== undefined && !match) {
      return challenge(401, 'invalid_token', 'Malformed Authorization header');
    }
    const usedScheme = match?.[1].toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer';
    const token = match?.[2] ?? null;

    const now = this.#now();
    let jwt: VerifiedSessionJwt;
    try {
      jwt = await verifySessionJwt({
        header: header(input.headers, 'poppy-session'),
        method: input.method,
        url: input.url,
        accessToken: token,
        audience: this.urls.issuer,
        maxAge: this.cfg.sessionJwt.maxAge,
        resolveClient: (clientId) => this.registry.resolve(clientId),
        now,
      });
    } catch (error) {
      if (error instanceof SessionJwtError) return invalidSession(error.message);
      throw error;
    }
    const replayUntil = new Date((jwt.iat + this.cfg.sessionJwt.maxAge + CLOCK_SKEW_S) * 1000);
    if (!(await this.#replay.claim(replayKey('session', jwt.clientId, jwt.jti), replayUntil))) {
      return invalidSession('jti was already used');
    }

    // Acesso à conta (§4.5).
    let signedIn: {
      accountId: string;
      grantId: string;
      scopes: string[];
      jkt: string | null;
    } | null = null;
    let resource: string | null = null;
    if (token !== null) {
      const row = await this.#store.findToken(sha256(token));
      if (!row || row.expiresAt <= now) {
        return challenge(401, 'invalid_token', 'The access token is unknown or expired', {
          schemes: [usedScheme],
        });
      }
      if (row.clientId !== jwt.clientId) {
        return invalidSession('The access token was issued to another client_id');
      }
      const tokenScheme = row.jkt ? 'DPoP' : 'Bearer';
      if (usedScheme !== tokenScheme) {
        return challenge(401, 'invalid_token', `This token uses the ${tokenScheme} scheme`, {
          schemes: [tokenScheme],
        });
      }
      if (row.jkt) {
        const proof = await verifyDpopProof({
          proof: header(input.headers, 'dpop'),
          method: input.method,
          url: input.url,
          accessToken: token,
          expectedJkt: row.jkt,
          algorithms: this.cfg.dpop.algorithms,
          maxAge: this.cfg.dpop.maxAge,
          replay: this.#replay,
          nonce: { required: this.cfg.dpop.requireNonce, source: this.#nonces },
          now: () => now.getTime(),
        });
        if (!proof.ok) {
          return challenge(401, proof.error, proof.description, {
            schemes: ['DPoP'],
            headers: proof.error === 'use_dpop_nonce' ? { 'DPoP-Nonce': this.#nonces.issue() } : {},
          });
        }
      }
      // Um token de um `resource` só vale nele; o default, onde não se exige um (§4.5).
      const required = target.mcp ?? target.resource;
      if ((row.resource ?? null) !== null || required !== null) {
        if (!row.resource || !required || !sameUrl(row.resource, required)) {
          return challenge(401, 'invalid_token', 'The token was not issued for this resource', {
            schemes: [tokenScheme],
            ...(required ? { resourceMetadata: resourceMetadataUrl(required) } : {}),
          });
        }
      }
      const grant = row.grantId ? await this.#grants.findGrant(row.grantId) : null;
      if (
        !row.grantId ||
        !row.accountId ||
        !grant ||
        !(await this.#grantUsable(grant, row.clientId, now))
      ) {
        return challenge(401, 'invalid_token', 'The access token was revoked', {
          schemes: [tokenScheme],
        });
      }
      signedIn = {
        accountId: row.accountId,
        grantId: row.grantId,
        scopes: parseScope(row.scope),
        jkt: row.jkt,
      };
      resource = row.resource;
    }

    // A Session (§5.3, passo 4) e a conta dela (§5.4).
    let session: SessionRow;
    try {
      session = await this.#sessionFor(jwt, now);
    } catch (error) {
      if (error instanceof PoppyError && error.status === 429) {
        return {
          ok: false,
          status: 429,
          error: null,
          description: error.description,
          wwwAuthenticate: null,
          headers: error.headers,
        };
      }
      if (error instanceof PoppyError) return invalidSession(error.description);
      throw error;
    }
    if (signedIn) {
      if (session.accountId && session.accountId !== signedIn.accountId) {
        return invalidSession('The Session used a different account');
      }
      if (
        !session.accountId &&
        !(await this.#store.bindSessionAccount(session.id, signedIn.accountId, now))
      ) {
        return invalidSession('The Session used a different account');
      }
    }

    const principal: PoppyPrincipalBase = {
      userId: session.userId,
      agentId: session.agentId,
      accountId: signedIn?.accountId ?? null,
      clientId: session.clientId,
      scopes: signedIn?.scopes ?? [],
      sessionId: session.id,
      signedIn: signedIn !== null,
      resource,
      tokenType: signedIn ? (signedIn.jkt ? 'DPoP' : 'Bearer') : null,
    };
    const required = options.scopes ?? [];
    if (!signedIn && (options.signedIn || required.length > 0)) {
      return challenge(401, null, 'This request needs the account of the user', {
        ...(required.length > 0 ? { scope: formatScope(required) } : {}),
      });
    }
    if (required.some((s) => !principal.scopes.includes(s))) {
      return challenge(403, 'insufficient_scope', 'The token lacks required scopes', {
        scope: formatScope(required),
        schemes: [principal.tokenType!],
      });
    }
    return { ok: true, principal, grantId: signedIn?.grantId ?? null };
  }

  /** Um challenge para cada esquema que o resource aceita (§7). */
  #acceptedSchemes(mcp: boolean): string[] {
    if (mcp) return ['Bearer'];
    return this.cfg.dpop.required ? ['DPoP'] : ['Bearer', 'DPoP'];
  }

  /** O endpoint pedido: MCP? exige `resource`? */
  #endpointFor(
    url: string,
    explicit: string | null | undefined,
  ): { mcp: string | null; resource: string | null } {
    if (this.#isMcp(url)) return { mcp: this.#mcpUrl(url), resource: null };
    if (explicit !== undefined) {
      if (explicit && this.#isMcp(explicit)) return { mcp: this.#mcpUrl(explicit), resource: null };
      return { mcp: null, resource: explicit };
    }
    const entries = [
      ...this.cfg.apis
        .filter((a) => a.type !== 'mcp')
        .map((a) => ({ base: a.url, resource: a.resource })),
      ...(this.cfg.agent?.protocols ?? []).map((p) => ({ base: p.endpoint, resource: p.resource })),
    ];
    for (const entry of entries) {
      if (entry.resource && (underUrl(url, entry.base) || underUrl(url, entry.resource))) {
        return { mcp: null, resource: entry.resource };
      }
    }
    return { mcp: null, resource: null };
  }

  // ─── navegação (§6) ───────────────────────────────────────────────────────

  /** Passo 1: gera o código de uso único e o valor do cookie que o prende a este navegador. */
  async startBrowserJoin(): Promise<{ code: string; cookie: string; maxAge: number }> {
    await this.#housekeeping();
    const now = this.#now();
    const code = randomId('bc_');
    const cookie = randomBytes(32).toString('base64url');
    await this.#store.insertRequest({
      id: randomId('brw_'),
      kind: 'browser',
      codeHash: sha256(code),
      userCode: null,
      clientId: '',
      sessionId: null,
      accountId: null,
      requestedScope: '',
      redirectUri: null,
      codeChallenge: null,
      status: 'pending',
      intervalSeconds: null,
      data: { cookieHash: sha256(cookie) },
      expiresAt: new Date(now.getTime() + BROWSER_CODE_TTL_S * 1000),
      createdAt: now,
    });
    return { code, cookie, maxAge: BROWSER_CODE_TTL_S };
  }

  /**
   * Passo 2: o agente autoriza o código, com o header da Session e, se logado, o access token.
   * `{ ok: true }` = 204; um código inválido lança `invalid_request`.
   */
  async authorizeBrowserJoin(
    input: PoppyRequestInput,
    code: unknown,
  ): Promise<Extract<PoppyVerifyResult, { ok: false }> | { ok: true }> {
    const auth = await this.verifyAccess(input);
    if (!auth.ok) return auth;
    const invalid = new PoppyError('invalid_request', 'Unknown, expired or used code');
    if (typeof code !== 'string' || !code) throw invalid;
    const row = await this.#store.findRequestByCodeHash(sha256(code));
    if (row?.kind !== 'browser' || row.status !== 'pending' || row.expiresAt <= this.#now()) {
      throw invalid;
    }
    const { principal, grantId } = auth;
    const moved = await this.#store.transitionRequest(row.id, 'pending', {
      status: 'approved',
      clientId: principal.clientId,
      sessionId: principal.sessionId,
      ...(principal.accountId ? { accountId: principal.accountId } : {}),
      grantedScope: formatScope(principal.scopes),
      data: { ...(row.data ?? {}), userId: principal.userId, grantId },
    });
    if (!moved) throw invalid;
    return { ok: true };
  }

  /**
   * Passo 3: o navegador submete o código. O primeiro envio o consome, qualquer que seja o
   * resultado; `null` = sem cookie para a Session (página de erro).
   */
  async completeBrowserJoin(code: unknown, cookie: unknown): Promise<PoppyBrowserJoin | null> {
    if (typeof code !== 'string' || !code) return null;
    const row = await this.#store.findRequestByCodeHash(sha256(code));
    if (row?.kind !== 'browser' || (row.status !== 'pending' && row.status !== 'approved')) {
      return null;
    }
    const moved = await this.#store.transitionRequest(row.id, row.status, { status: 'consumed' });
    if (!moved || row.status !== 'approved') return null;
    const now = this.#now();
    const data = row.data ?? {};
    if (
      row.expiresAt <= now ||
      typeof cookie !== 'string' ||
      !cookie ||
      sha256(cookie) !== data.cookieHash ||
      !row.sessionId
    ) {
      return null;
    }
    const session = await this.#store.findSession(row.sessionId);
    if (!session || session.endedAt || session.expiresAt <= now) return null;
    const grantId = typeof data.grantId === 'string' ? data.grantId : null;
    return {
      sessionId: session.id,
      clientId: session.clientId,
      userId: session.userId,
      accountId: grantId ? row.accountId : null,
      grantId,
      scopes: grantId ? parseScope(row.grantedScope) : [],
    };
  }

  /** O cookie age pela conta e pelos scopes do passo 2, enquanto o refresh token viver (§6). */
  async browserState(marker: {
    sessionId: string;
    accountId?: string | null;
    grantId?: string | null;
    scopes?: string[];
  }): Promise<PoppySessionState | null> {
    const session = await this.#store.findSession(marker.sessionId);
    if (!session) return null;
    const now = this.#now();
    const active = !session.endedAt && session.expiresAt > now;
    let signedIn = false;
    if (active && marker.grantId) {
      const grant = await this.#grants.findGrant(marker.grantId);
      signedIn = !!grant && (await this.#grantUsable(grant, session.clientId, now));
    }
    return {
      active,
      sessionId: session.id,
      clientId: session.clientId,
      userId: session.userId,
      accountId: signedIn ? (marker.accountId ?? null) : null,
      signedIn,
      scopes: signedIn ? (marker.scopes ?? []) : [],
    };
  }

  // ─── console de conta ─────────────────────────────────────────────────────

  async listGrants(accountId: string): Promise<PoppyGrantSummary[]> {
    const now = this.#now();
    return (await this.#grants.listGrants(accountId))
      .filter((g) => g.id.startsWith('pgrant_') && g.expiresAt > now)
      .map((g) => ({
        id: g.id,
        clientId: g.clientId,
        scopes: this.describe(parseScope(g.scope)),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        expiresAt: g.expiresAt,
      }));
  }

  /** Desconectar o agente pela conta (§5.5): revoga um refresh token DA CONTA. */
  async revokeAccountGrant(accountId: string, grantId: string): Promise<boolean> {
    if (!grantId.startsWith('pgrant_')) return false;
    const grant = await this.#grants.findGrant(grantId);
    if (!grant || grant.accountId !== accountId || grant.revokedAt) return false;
    await this.revokeGrant(grantId);
    return true;
  }

  /** Revoga todos os refresh tokens da conta (sair de tudo, conta suspensa…). */
  async revokeAllAccountGrants(accountId: string): Promise<number> {
    const live = (await this.#grants.listGrants(accountId)).filter((g) =>
      g.id.startsWith('pgrant_'),
    );
    for (const g of live) await this.revokeGrant(g.id);
    return live.length;
  }

  /**
   * Bloqueio pelo console admin: revoga todos os refresh tokens do agente (todas as contas) e
   * encerra as Sessions dele — param na próxima request. Devolve quantos estavam vivos.
   */
  async disconnectClient(clientId: string): Promise<number> {
    const ids = (await this.#grants.unrevokedGrantIdsOfClient(clientId)).filter((id) =>
      id.startsWith('pgrant_'),
    );
    for (const id of ids) await this.revokeGrant(id);
    await this.#store.endSessionsOfClient(clientId, this.#now());
    return ids.length;
  }

  // ─── internos ─────────────────────────────────────────────────────────────

  /** Scopes de um pedido de sign-in: obrigatórios, conhecidos e do tipo (§4.7). */
  #signInScopes(raw: unknown, type: PoppySignInType): string[] {
    const allowed =
      type === 'mediated' ? this.cfg.signIn.mediated?.scopes : this.cfg.signIn[type]?.scopes;
    const scopes = typeof raw === 'string' ? parseScope(raw) : [];
    if (scopes.length === 0) throw new PoppyError('invalid_scope', 'scope is required');
    if (!allowed || scopes.some((s) => !allowed.includes(s))) {
      throw new PoppyError('invalid_scope', `Unknown or unavailable scope for ${type} sign-in`);
    }
    return scopes;
  }

  #narrow(available: string[], requested: string[] | null): string[] {
    if (requested === null) return available;
    if (requested.some((s) => !available.includes(s))) {
      throw new PoppyError('invalid_scope', 'scope can only narrow the granted scopes');
    }
    return requested;
  }

  /**
   * §5.3, passo 4: busca a Session por `client_id` + `sid`. `sid` novo começa uma Session deslogada;
   * o conhecido precisa ter o mesmo User ID e Agent ID, e não pode ter terminado (§5.5).
   */
  async #sessionFor(jwt: VerifiedSessionJwt, now: Date): Promise<SessionRow> {
    // O `sid` é escolhido pelo agente: a chave inclui o `client_id`, para um não esbarrar no outro.
    const id = `ses_${createHash('sha256')
      .update(`${jwt.clientId}\u0000${jwt.sid}`)
      .digest('base64url')}`;
    let session = await this.#store.findSession(id);
    if (!session) {
      await this.#limit('session', jwt.clientId);
      const row = {
        id,
        clientId: jwt.clientId,
        userId: jwt.userId,
        agentId: jwt.agentId,
        accountId: null,
        grantId: null,
        scope: '',
        expiresAt: this.#sessionExpiry(now),
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.#store.insertSession(row);
        return { ...row, endedAt: null };
      } catch (error) {
        // Duas requests simultâneas com o mesmo `sid` novo: a outra ganhou.
        session = await this.#store.findSession(id);
        if (!session) throw error;
      }
    }
    if (session.endedAt || session.expiresAt <= now) {
      throw new PoppyError('invalid_session', 'The Session has ended');
    }
    if (session.userId !== jwt.userId || session.agentId !== jwt.agentId) {
      throw new PoppyError('invalid_session', 'The Session has another User ID or Agent ID');
    }
    if (now.getTime() - session.updatedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await this.#store.touchSession(session.id, this.#sessionExpiry(now), now);
    }
    return session;
  }

  #sessionExpiry(now: Date): Date {
    return new Date(now.getTime() + this.cfg.sessionTtl * 1000);
  }

  async #grantUsable(grant: GrantRow, clientId: string, now: Date): Promise<boolean> {
    return (
      grant.id.startsWith('pgrant_') &&
      grant.revokedAt === null &&
      grant.expiresAt > now &&
      grant.clientId === clientId &&
      (await this.#isAccountActive(grant.accountId))
    );
  }

  /** Fim comum dos sign-ins (§4.7): refresh token novo (grant + hash) e o access token. */
  async #signIn(
    clientId: string,
    accountId: string,
    granted: string[],
    binding: { jkt: string | null; resource: string | null },
    requestedScope: string[] | null,
  ): Promise<{ body: PoppyTokenResponse; grantId: string }> {
    if (!(await this.#isAccountActive(accountId))) {
      throw new PoppyError('invalid_grant', 'The account cannot sign in');
    }
    const scopes = this.#narrow(granted, requestedScope);
    const now = this.#now();
    const grantId = `pgrant_${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + this.cfg.refreshTokenTtl * 1000);
    const grant: GrantRow = {
      id: grantId,
      accountId,
      clientId,
      // O authorization server não vê User IDs (§5.3).
      agentSub: '',
      scope: formatScope(granted),
      expiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#grants.insertGrant(grant);
    const refreshToken = randomId('poa_', 32);
    await this.#grants.insertRefreshToken({
      tokenHash: sha256(refreshToken),
      grantId,
      expiresAt,
      createdAt: now,
    });
    const body = await this.#issue(grant, scopes, binding);
    return { body: { ...body, refresh_token: refreshToken }, grantId };
  }

  /** Emite um access token do grant (§4.5). */
  async #issue(
    grant: GrantRow,
    scopes: string[],
    binding: { jkt: string | null; resource: string | null },
  ): Promise<PoppyTokenResponse> {
    const now = this.#now();
    const ttl = this.cfg.accessTokenTtl;
    const scope = formatScope(scopes);
    let token: string | null = null;
    // Bearer de MCP: vira access token do oidc-provider, para a integração MCP existente
    // aceitá-lo sem código no app (§7).
    if (binding.jkt === null && binding.resource && this.#isMcp(binding.resource)) {
      token =
        (await this.#mcp?.mint?.({
          grantId: grant.id,
          accountId: grant.accountId,
          clientId: grant.clientId,
          scope,
          resource: binding.resource,
          expiresIn: ttl,
          grantExpiresAt: grant.expiresAt,
        })) ?? null;
    }
    token ??= randomId('pat_', 32);
    await this.#store.insertToken({
      tokenHash: sha256(token),
      clientId: grant.clientId,
      accountId: grant.accountId,
      grantId: grant.id,
      scope,
      resource: binding.resource,
      jkt: binding.jkt,
      expiresAt: new Date(now.getTime() + ttl * 1000),
      createdAt: now,
    });
    return {
      access_token: token,
      token_type: binding.jkt ? 'DPoP' : 'Bearer',
      expires_in: ttl,
      scope,
    };
  }

  async #limit(action: 'session' | 'mediated', key: string): Promise<void> {
    if (!this.#limiter) return;
    const retryAfter = await this.#limiter({ action, key });
    if (retryAfter !== null) {
      throw new PoppyError('too_many_requests', 'Too many requests for this client_id', {
        headers: { 'Retry-After': String(Math.max(1, retryAfter)) },
      });
    }
  }

  /** Limpeza preguiçosa: no máximo uma vez por minuto. */
  async #housekeeping(): Promise<void> {
    const now = this.#now();
    if (now.getTime() - this.#housekeepingAt < 60_000) return;
    this.#housekeepingAt = now.getTime();
    await this.#store.deleteRequestsExpiredBefore(new Date(now.getTime() - 3600_000));
    await this.#store.deleteTokensExpiredBefore(now);
  }
}

export type { RequestRow };
