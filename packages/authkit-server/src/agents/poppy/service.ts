/**
 * Authorization server do Poppy (Draft 0.1, §4–§6): Sessions, Session Tokens
 * opacos presos por DPoP, Account Tokens (refresh tokens), Direct/Device/Mediated
 * Sign-In, revogação, verificação nos resource servers e a asserção de navegador.
 *
 * Os Account Tokens são grants de personal agents (`auth_agent_grants`, prefixo
 * `pgrant_`) — a mesma lista/revogação do console de conta do PACT.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import { decodeJwt, decodeProtectedHeader, type JWTPayload, jwtVerify } from 'jose';
import { formatScope, parseScope } from '../config.js';
import type { DelegationStore, GrantRow } from '../delegation_store.js';
import type { PoppyClient, PoppyClientRegistry } from './client_registry.js';
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
import type { PoppyStore, RequestRow, SessionRow } from './store.js';

export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const BROWSER_ASSERTION_TYP = 'poppy-browser+jwt';

/** Algoritmos aceitos nas asserções do agente (client assertion, sessão, navegador). */
const ASSERTION_ALGS = ['ES256', 'ES384', 'ES512', 'RS256', 'PS256', 'EdDSA'];
const CLOCK_SKEW_S = 30;
/** Sem vogais: o código não forma palavras (RFC 8628 §6.1). */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
/** Pedido de autorização (Direct) aguardando o consentimento. */
const AUTHORIZE_REQUEST_TTL_S = 600;

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
  mediated: string;
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
    mediated: `${issuer}/sign-in`,
    browserSession: `${issuer}/browser-session`,
    discovery: `${origin}/.well-known/poppy.json`,
  };
}

/** Resposta do token endpoint (§4.2, §4.4). */
export interface PoppyTokenResponse {
  access_token: string;
  token_type: 'DPoP' | 'Bearer';
  expires_in: number;
  scope: string;
  session_id: string;
  signed_in: boolean;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

/** Ponte com o oidc-provider para os tokens Bearer de MCP (§4.3, §6). */
export interface PoppyMcpBridge {
  /** `url` é um servidor MCP deste app (de `apis` ou do registro de resources)? */
  isMcpResource(url: string): boolean;
  /**
   * Emite o Bearer de uma Session LOGADA como access token do oidc-provider,
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
  /** Scopes exigidos (todos). Faltando: `sign_in_required` (deslogado) ou `insufficient_scope`. */
  scopes?: string[];
  /** Exige Session logada. */
  signedIn?: boolean;
  /**
   * `resource` exigido por este endpoint. Default: derivado da URL contra
   * `apis`/`agent.protocols` do config (entradas com `resource`) e os MCP.
   */
  resource?: string | null;
}

export type PoppyAuthError =
  | 'invalid_token'
  | 'sign_in_required'
  | 'insufficient_scope'
  | 'invalid_dpop_proof'
  | 'use_dpop_nonce';

export type PoppyVerifyResult =
  | { ok: true; principal: PoppyPrincipalBase; jkt: string | null }
  | {
      ok: false;
      status: 401 | 403;
      error: PoppyAuthError;
      description: string;
      scope?: string;
      wwwAuthenticate: string;
      /** Headers extras (`DPoP-Nonce`). */
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

export type PoppyMediatedResponse =
  | ({ status: 'complete' } & PoppyTokenResponse)
  | {
      status: 'code_required';
      sign_in_id: string;
      code: { sent_to: string };
      expires_at: string;
    }
  | { status: 'failed' }
  | { status: 'expired' };

export interface PoppyBrowserSessionResult {
  sessionId: string;
  clientId: string;
  userId: string;
  accountId: string | null;
  scopes: string[];
  returnTo: string;
}

/** Estado atual de uma Session (para o cookie do site acompanhar — §5). */
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

function hostMatches(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
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
  resource?: string;
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
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — pode mudar de forma incompatível enquanto a spec for draft.
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

  /** `/.well-known/poppy.json` (§3) para o domínio pedido; `null` = domínio que não é nosso. */
  discoveryDocument(requestHost: string): Record<string, unknown> | null {
    const host = requestHost.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    const bare = host.startsWith('www.') ? host.slice(4) : host;
    const domain = this.domains.find((d) => d === bare);
    if (!domain) return null;
    const { signIn } = this.cfg;
    const auth: Record<string, unknown> = { issuer: this.urls.issuer };
    if (signIn.direct) auth.direct = { scopes: signIn.direct.scopes };
    if (signIn.device) auth.device = { scopes: signIn.device.scopes };
    if (signIn.mediated) {
      auth.mediated = {
        endpoint: this.urls.mediated,
        fields: signIn.mediated.fields,
        scopes: signIn.mediated.scopes,
      };
    }
    if (Object.keys(this.cfg.customScopes).length > 0) auth.custom_scopes = this.cfg.customScopes;

    const doc: Record<string, unknown> = {
      protocol_version: '0.1',
      organization: { name: this.cfg.organization.name, domain },
      auth,
    };
    const protocols = this.cfg.agent?.protocols ?? registeredConversationProtocols();
    if (protocols.length > 0) {
      doc.agent = {
        protocols: protocols.map((p) => ({
          type: p.type,
          endpoint: p.endpoint,
          ...(p.resource ? { resource: p.resource } : {}),
        })),
      };
    }
    if (this.cfg.web) {
      doc.web = this.cfg.web.browserSession
        ? { browser_session_endpoint: this.#browserSessionEndpointFor(host) }
        : {};
    }
    if (this.cfg.apis.length > 0) {
      doc.apis = this.cfg.apis.map((a) => ({
        type: a.type,
        url: a.url,
        description: a.description,
        ...(a.resource ? { resource: a.resource } : {}),
      }));
    }
    if (Object.keys(this.cfg.extensions).length > 0) doc.extensions = this.cfg.extensions;
    return doc;
  }

  /** RFC 8414 com `poppy_domains` (§3.2). */
  authorizationServerMetadata(): Record<string, unknown> {
    const { signIn } = this.cfg;
    const grants = [JWT_BEARER_GRANT, 'refresh_token'];
    if (signIn.direct) grants.push('authorization_code');
    if (signIn.device) grants.push(DEVICE_CODE_GRANT);
    return {
      issuer: this.urls.issuer,
      token_endpoint: this.urls.token,
      revocation_endpoint: this.urls.revocation,
      ...(signIn.direct ? { authorization_endpoint: this.urls.authorization } : {}),
      ...(signIn.device ? { device_authorization_endpoint: this.urls.deviceAuthorization } : {}),
      poppy_domains: this.domains,
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

  /** Endpoints de sessão de navegador aceitos (um por domínio, com e sem `www.`). */
  #browserSessionEndpoints(): string[] {
    const path = new URL(this.urls.browserSession).pathname;
    const protocol = new URL(this.urls.origin).protocol;
    const list = new Set([this.urls.browserSession]);
    for (const d of this.domains) {
      list.add(`${protocol}//${d}${path}`);
      list.add(`${protocol}//www.${d}${path}`);
    }
    return [...list];
  }

  #browserSessionEndpointFor(host: string): string {
    const issuerHost = new URL(this.urls.origin).host;
    if (host === issuerHost.toLowerCase()) return this.urls.browserSession;
    const path = new URL(this.urls.browserSession).pathname;
    return `${new URL(this.urls.origin).protocol}//${host}${path}`;
  }

  // ─── autenticação do agente ───────────────────────────────────────────────

  /**
   * `private_key_jwt` (RFC 7523 §2.2, §3): `client_assertion` assinada por uma
   * chave do `jwks_uri`, `iss` = `sub` = `client_id`, `aud` = o endpoint
   * chamado (ou o token endpoint/issuer), `exp` curto, `jti` único.
   */
  async authenticateClient(form: Record<string, unknown>, endpoint: string): Promise<PoppyClient> {
    const clientId = str(form.client_id);
    const type = str(form.client_assertion_type);
    const assertion = str(form.client_assertion);
    if (!clientId || type !== CLIENT_ASSERTION_TYPE || !assertion) {
      throw new PoppyError('invalid_client', 'private_key_jwt client authentication is required');
    }
    const client = await this.registry.resolve(clientId);
    const payload = await this.#verifyAgentJwt(client, assertion, {
      audience: [endpoint, this.urls.token, this.urls.issuer],
      error: 'invalid_client',
      forbidTyp: [BROWSER_ASSERTION_TYP, 'dpop+jwt'],
    });
    if (payload.sub !== clientId) {
      throw new PoppyError('invalid_client', 'client assertion sub must be the client_id');
    }
    await this.#claimJti('client', clientId, payload, 'invalid_client');
    return client;
  }

  async #verifyAgentJwt(
    client: PoppyClient,
    token: string,
    options: {
      audience: string | string[];
      error: 'invalid_client' | 'invalid_grant' | 'invalid_request';
      typ?: string;
      forbidTyp?: string[];
      maxLifetime?: number;
    },
  ): Promise<JWTPayload> {
    const fail = (why: string) => new PoppyError(options.error, why);
    let typ: unknown;
    try {
      typ = decodeProtectedHeader(token).typ;
    } catch {
      throw fail('malformed JWT');
    }
    if (options.typ !== undefined && typ !== options.typ) throw fail(`typ must be ${options.typ}`);
    if (typeof typ === 'string' && options.forbidTyp?.includes(typ.toLowerCase())) {
      throw fail(`a ${typ} is not accepted here`);
    }
    const now = this.#now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, client.keys, {
        algorithms: ASSERTION_ALGS,
        issuer: client.clientId,
        audience: options.audience,
        currentDate: now,
        clockTolerance: CLOCK_SKEW_S,
        requiredClaims: ['exp', 'jti'],
      }));
    } catch (error) {
      if (error instanceof PoppyError) throw error;
      throw fail('JWT verification failed');
    }
    const nowS = Math.floor(now.getTime() / 1000);
    const max = options.maxLifetime ?? this.cfg.assertionMaxLifetime;
    const start = typeof payload.iat === 'number' ? payload.iat : nowS;
    if (typeof payload.iat === 'number' && payload.iat > nowS + CLOCK_SKEW_S) {
      throw fail('iat is in the future');
    }
    if (payload.exp! - start > max) throw fail('JWT lifetime is too long');
    if (typeof payload.jti !== 'string' || payload.jti.length < 16) throw fail('jti is required');
    return payload;
  }

  async #claimJti(
    kind: string,
    clientId: string,
    payload: JWTPayload,
    error: 'invalid_client' | 'invalid_grant' | 'invalid_request',
  ): Promise<void> {
    const expiresAt = new Date((payload.exp! + CLOCK_SKEW_S) * 1000);
    if (!(await this.#replay.claim(replayKey(kind, clientId, String(payload.jti)), expiresAt))) {
      throw new PoppyError(error, 'jti was already used');
    }
  }

  // ─── token endpoint ───────────────────────────────────────────────────────

  /** `POST token_endpoint` (§4.2, §4.3, §4.5, §4.6, §4.8). */
  async token(
    form: Record<string, unknown>,
    dpopHeader: string | string[] | undefined,
  ): Promise<PoppyTokenResponse> {
    await this.#housekeeping();
    const client = await this.authenticateClient(form, this.urls.token);
    const grantType = str(form.grant_type);
    if (
      grantType !== JWT_BEARER_GRANT &&
      grantType !== 'refresh_token' &&
      !(grantType === 'authorization_code' && this.cfg.signIn.direct) &&
      !(grantType === DEVICE_CODE_GRANT && this.cfg.signIn.device)
    ) {
      throw new PoppyError('unsupported_grant_type', 'Unsupported grant_type');
    }
    const binding = await this.#tokenBinding(form, dpopHeader);
    const scopeParam = form.scope;
    const requestedScope = scopeParam === undefined ? null : parseScope(str(scopeParam) ?? '');

    switch (grantType) {
      case JWT_BEARER_GRANT:
        return this.#jwtBearer(client, form, binding, requestedScope);
      case 'refresh_token':
        return this.#refresh(client, form, binding, requestedScope);
      case 'authorization_code':
        return this.#authorizationCode(client, form, binding, requestedScope);
      default:
        return this.#deviceCode(client, form, binding, requestedScope);
    }
  }

  /**
   * DPoP da request de token (sem `ath`), ou Bearer — que só existe para MCP e
   * exige `resource` = a URL de um servidor MCP (§4.3).
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

    if (dpopHeader === undefined || dpopHeader === '') {
      if (resource && this.#isMcp(resource)) return { jkt: null, resource: this.#mcpUrl(resource) };
      throw new PoppyError(
        'invalid_dpop_proof',
        'A DPoP proof is required (Bearer tokens are issued only for an MCP resource)',
      );
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
    if (resource) {
      if (!this.#isConfiguredResource(resource)) {
        throw new PoppyError('invalid_target', 'Unknown resource');
      }
      return { jkt: result.jkt, resource };
    }
    return { jkt: result.jkt, resource: null };
  }

  /** `resource`s que exigem tokens próprios (§4.3): os `resource` de `apis` e `agent.protocols`. */
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

  async #jwtBearer(
    client: PoppyClient,
    form: Record<string, unknown>,
    binding: { jkt: string | null; resource: string | null },
    requestedScope: string[] | null,
  ): Promise<PoppyTokenResponse> {
    const assertion = str(form.assertion);
    if (!assertion) throw new PoppyError('invalid_grant', 'assertion is required');
    const payload = await this.#verifyAgentJwt(client, assertion, {
      audience: this.urls.token,
      error: 'invalid_grant',
      forbidTyp: [BROWSER_ASSERTION_TYP, 'dpop+jwt'],
    });
    // `aud` é UMA string (§4.2): uma asserção com lista não serve.
    if (typeof payload.aud !== 'string' || payload.aud !== this.urls.token) {
      throw new PoppyError('invalid_grant', 'aud must be the token endpoint, as a single string');
    }
    if (typeof payload.iat !== 'number') throw new PoppyError('invalid_grant', 'iat is required');
    if (typeof payload.jti !== 'string' || payload.jti.length < 22) {
      throw new PoppyError('invalid_grant', 'jti needs at least 128 random bits');
    }
    const userId = payload.sub;
    if (typeof userId !== 'string' || !userId || userId.length > 255) {
      throw new PoppyError('invalid_grant', 'sub (the User ID) is required');
    }
    await this.#claimJti('session', client.clientId, payload, 'invalid_grant');
    if (requestedScope && requestedScope.length > 0) {
      throw new PoppyError('invalid_scope', 'A signed-out Session Token has no scopes');
    }

    const sessionId = str(form.session_id);
    const now = this.#now();
    let session: SessionRow;
    if (sessionId) {
      session = await this.#sessionFor(sessionId, client.clientId, userId);
    } else {
      await this.#limit('session', client.clientId);
      session = await this.#newSession(client.clientId, userId, now);
    }
    await this.#store.touchSession(session.id, this.#sessionExpiry(now), now);
    return this.#issue(session, { ...binding, signedIn: null, scopes: [] });
  }

  async #refresh(
    client: PoppyClient,
    form: Record<string, unknown>,
    binding: { jkt: string | null; resource: string | null },
    requestedScope: string[] | null,
  ): Promise<PoppyTokenResponse> {
    const token = str(form.refresh_token);
    if (!token) throw new PoppyError('invalid_grant', 'refresh_token is required');
    const now = this.#now();
    const invalid = new PoppyError('invalid_grant', 'Unknown, expired or revoked Account Token');
    const row = await this.#grants.findRefreshToken(sha256(token));
    if (!row || row.expiresAt <= now) throw invalid;
    const grant = await this.#grants.findGrant(row.grantId);
    // Só o `client_id` a que foi emitido (§4.8).
    if (!grant || !(await this.#grantUsable(grant, client.clientId, now))) throw invalid;

    const granted = parseScope(grant.scope);
    const scopes = this.#narrow(granted, requestedScope);

    const sessionId = str(form.session_id);
    let session: SessionRow;
    if (sessionId) {
      session = await this.#sessionFor(sessionId, client.clientId, grant.agentSub);
      if (session.accountId && session.accountId !== grant.accountId) {
        throw new PoppyError('account_mismatch', 'The Session is signed in to a different account');
      }
    } else {
      await this.#limit('session', client.clientId);
      session = await this.#newSession(client.clientId, grant.agentSub, now);
    }
    if (
      !(await this.#store.signInSession(session.id, {
        accountId: grant.accountId,
        grantId: grant.id,
        scope: grant.scope,
        expiresAt: this.#sessionExpiry(now),
        at: now,
      }))
    ) {
      throw new PoppyError('account_mismatch', 'The Session is signed in to a different account');
    }
    const fresh = { ...session, accountId: grant.accountId, grantId: grant.id, scope: grant.scope };
    return this.#issue(fresh, { ...binding, signedIn: grant, scopes });
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
    const sessionId = str(form.session_id);
    if (!sessionId) throw new PoppyError('invalid_request', 'session_id is required');
    const session = await this.#sessionFor(sessionId, client.clientId, null);
    if (session.accountId && session.accountId !== row.accountId) {
      throw new PoppyError('account_mismatch', 'The Session is signed in to a different account');
    }
    if (!(await this.#store.transitionRequest(row.id, 'approved', { status: 'consumed' }))) {
      throw invalid;
    }
    const granted = parseScope(row.grantedScope);
    const response = await this.#signIn(session, row.accountId, granted, binding, requestedScope);
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
    const sessionId = str(form.session_id);
    if (!sessionId) throw new PoppyError('invalid_request', 'session_id is required');
    const session = await this.#sessionFor(sessionId, client.clientId, null);
    if (session.accountId && session.accountId !== row.accountId) {
      throw new PoppyError('account_mismatch', 'The Session is signed in to a different account');
    }
    if (!(await this.#store.transitionRequest(row.id, 'approved', { status: 'consumed' }))) {
      throw new PoppyError('invalid_grant', 'device_code was used');
    }
    const result = await this.#signIn(
      session,
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
    const client = await this.authenticateClient(form, this.urls.deviceAuthorization);
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

  /** `POST revocation_endpoint` (§4.9, RFC 7009). */
  async revoke(form: Record<string, unknown>): Promise<void> {
    const client = await this.authenticateClient(form, this.urls.revocation);
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
   * Revoga um Account Token (grant): as Sessions logadas com ele continuam
   * deslogadas (§4.9) e os Bearer de MCP no oidc-provider morrem junto.
   */
  async revokeGrant(grantId: string): Promise<void> {
    const now = this.#now();
    await this.#grants.revokeGrantById(grantId, now);
    await this.#store.signOutSessionsOfGrant(grantId, now);
    await this.#mcp?.revoke?.(grantId);
  }

  // ─── Direct Sign-In (§4.5) ────────────────────────────────────────────────

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
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
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

  // ─── Device Sign-In: tela (§4.6) ──────────────────────────────────────────

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

  // ─── Mediated Sign-In (§4.7) ──────────────────────────────────────────────

  /** `POST auth.mediated.endpoint` — já autenticado pelo Session Token (DPoP). */
  async mediatedStart(
    principal: PoppyPrincipalBase,
    jkt: string | null,
    body: unknown,
    ctx: HttpContext,
  ): Promise<PoppyMediatedResponse> {
    const mediated = this.cfg.signIn.mediated;
    if (!mediated) throw new PoppyError('invalid_request', 'Mediated Sign-In is not offered');
    const b = (body ?? {}) as Record<string, unknown>;
    const scopes = this.#signInScopes(b.scope, 'mediated');
    const raw = b.credentials;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PoppyError('invalid_request', 'credentials is required');
    }
    const credentials: Record<string, string> = {};
    for (const field of mediated.fields) {
      const value = (raw as Record<string, unknown>)[field.name];
      if (typeof value !== 'string' || value === '') {
        throw new PoppyError('invalid_request', `credentials.${field.name} is required`);
      }
      credentials[field.name] = value;
    }
    await this.#limit('mediated', `${principal.clientId}\u0000${principal.userId}`);

    const result = await mediated.verify({
      credentials,
      scopes,
      clientId: principal.clientId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      ctx,
    });
    if (!result || result.status === 'failed') return { status: 'failed' };
    const session = await this.#sessionFor(
      principal.sessionId,
      principal.clientId,
      principal.userId,
    );
    if (session.accountId && session.accountId !== result.accountId) {
      throw new PoppyError('account_mismatch', 'The Session is signed in to a different account');
    }
    if (result.status === 'complete') {
      const done = await this.#signIn(
        session,
        result.accountId,
        scopes,
        { jkt, resource: null },
        null,
      );
      return { status: 'complete', ...done.body };
    }
    if (result.status !== 'code_required') return { status: 'failed' };
    if (result.code === undefined && !mediated.verifyCode) {
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
      clientId: principal.clientId,
      sessionId: principal.sessionId,
      accountId: result.accountId,
      requestedScope: formatScope(scopes),
      redirectUri: null,
      codeChallenge: null,
      status: 'pending',
      intervalSeconds: null,
      data: {
        sentTo: result.sentTo,
        ...(result.code !== undefined ? { codeHash: sha256(`${id}:${result.code}`) } : {}),
        ...(result.state !== undefined ? { state: result.state } : {}),
      },
      expiresAt,
      createdAt: now,
    });
    return {
      status: 'code_required',
      sign_in_id: id,
      code: { sent_to: result.sentTo },
      expires_at: expiresAt.toISOString(),
    };
  }

  /** `POST {mediated}/{sign_in_id}` com o código de uso único. */
  async mediatedCode(
    principal: PoppyPrincipalBase,
    jkt: string | null,
    signInId: string,
    body: unknown,
  ): Promise<PoppyMediatedResponse | null> {
    const mediated = this.cfg.signIn.mediated;
    if (!mediated) throw new PoppyError('invalid_request', 'Mediated Sign-In is not offered');
    const row = await this.#store.findRequest(signInId);
    // Só a Session que começou o sign-in termina (§4.7). De outra = não existe.
    if (row?.kind !== 'mediated' || row.sessionId !== principal.sessionId) return null;
    const now = this.#now();
    if (row.status === 'failed' || row.status === 'denied') return { status: 'failed' };
    if (row.status === 'consumed') return { status: 'failed' };
    if (row.expiresAt <= now) return { status: 'expired' };
    const code = (body as Record<string, unknown> | null)?.code;
    if (typeof code !== 'string' || code === '') {
      throw new PoppyError('invalid_request', 'code is required');
    }
    const data = row.data ?? {};
    let correct: boolean;
    if (typeof data.codeHash === 'string') {
      correct = sha256(`${row.id}:${code}`) === data.codeHash;
    } else {
      correct =
        (await mediated.verifyCode?.({
          code,
          accountId: row.accountId!,
          state: data.state,
          clientId: row.clientId,
          userId: principal.userId,
        })) === true;
    }
    if (!correct) {
      const attempts = row.attempts + 1;
      if (attempts >= mediated.maxCodeAttempts) {
        await this.#store.transitionRequest(row.id, 'pending', { status: 'failed', attempts });
        return { status: 'failed' };
      }
      if (!(await this.#store.bumpAttempts(row.id, row.attempts))) return { status: 'failed' };
      return {
        status: 'code_required',
        sign_in_id: row.id,
        code: { sent_to: String(data.sentTo ?? '') },
        expires_at: row.expiresAt.toISOString(),
      };
    }
    if (!(await this.#store.transitionRequest(row.id, 'pending', { status: 'consumed' }))) {
      return { status: 'failed' };
    }
    const session = await this.#sessionFor(
      principal.sessionId,
      principal.clientId,
      principal.userId,
    );
    const done = await this.#signIn(
      session,
      row.accountId!,
      parseScope(row.requestedScope),
      { jkt, resource: null },
      null,
    );
    return { status: 'complete', ...done.body };
  }

  // ─── resource server (§4.3, §6) ───────────────────────────────────────────

  /**
   * Verifica `Authorization: DPoP|Bearer` (+ prova DPoP) de uma request a uma API
   * ou conversa do app. Nunca lê token da URL (§4.3).
   */
  async verifyAccess(
    input: PoppyRequestInput,
    options: PoppyVerifyOptions = {},
  ): Promise<PoppyVerifyResult> {
    const target = this.#endpointFor(input.url, options.resource);
    const scheme = target.mcp ? 'Bearer' : 'DPoP';
    const deny = (
      status: 401 | 403,
      error: PoppyAuthError,
      description: string,
      extra: { scope?: string; scheme?: string; headers?: Record<string, string> } = {},
    ): PoppyVerifyResult => {
      const s = extra.scheme ?? scheme;
      const parts = [`error="${error}"`, `error_description="${quote(description)}"`];
      if (extra.scope) parts.push(`scope="${quote(extra.scope)}"`);
      if (s === 'DPoP') parts.unshift(`algs="${this.cfg.dpop.algorithms.join(' ')}"`);
      return {
        ok: false,
        status,
        error,
        description,
        ...(extra.scope ? { scope: extra.scope } : {}),
        wwwAuthenticate: `${s} ${parts.join(', ')}`,
        headers: extra.headers ?? {},
      };
    };

    const auth = header(input.headers, 'authorization');
    const authValue = Array.isArray(auth) ? undefined : auth;
    const match = authValue
      ? /^(DPoP|Bearer)\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(authValue)
      : null;
    if (!match)
      return deny(401, 'invalid_token', 'A Session Token is required in the Authorization header');
    const usedScheme = match[1].toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer';
    const token = match[2];

    const now = this.#now();
    const row = await this.#store.findToken(sha256(token));
    if (!row || row.expiresAt <= now)
      return deny(401, 'invalid_token', 'The token is unknown or expired');

    let jkt: string | null = null;
    if (row.jkt && target.mcp) {
      // O MCP aceita só o Bearer emitido para a URL dele (§6).
      return deny(401, 'invalid_token', 'The MCP server accepts only Bearer tokens issued for it', {
        scheme: 'Bearer',
      });
    }
    if (row.jkt) {
      if (usedScheme !== 'DPoP') {
        return deny(401, 'invalid_token', 'This token is DPoP-bound', { scheme: 'DPoP' });
      }
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
        return deny(401, proof.error, proof.description, {
          scheme: 'DPoP',
          headers: proof.error === 'use_dpop_nonce' ? { 'DPoP-Nonce': this.#nonces.issue() } : {},
        });
      }
      jkt = proof.jkt;
      // Um token de um `resource` só vale nele (§4.3); um sem `resource`, onde não se exige.
      if ((row.resource ?? null) !== null || target.resource !== null) {
        if (!row.resource || !target.resource || !sameUrl(row.resource, target.resource)) {
          return deny(401, 'invalid_token', 'The token was not issued for this resource');
        }
      }
    } else {
      // Bearer: só no servidor MCP para o qual foi emitido (§4.3, §6).
      if (
        usedScheme !== 'Bearer' ||
        !target.mcp ||
        !row.resource ||
        !sameUrl(row.resource, target.mcp)
      ) {
        return deny(
          401,
          'invalid_token',
          'Bearer Session Tokens are accepted only at their MCP server',
          {
            scheme: 'Bearer',
          },
        );
      }
    }

    const session = await this.#store.findSession(row.sessionId);
    if (
      !session ||
      session.endedAt ||
      session.expiresAt <= now ||
      session.clientId !== row.clientId
    ) {
      return deny(401, 'invalid_token', 'The Session has ended');
    }

    // Logada só se o token foi emitido logado E a Session ainda está logada com
    // o mesmo Account Token, vivo (§4.4, §4.9 — sign-out vale na hora).
    let signedIn = false;
    if (row.grantId && session.grantId === row.grantId) {
      const grant = await this.#grants.findGrant(row.grantId);
      signedIn = !!grant && (await this.#grantUsable(grant, row.clientId, now));
    }
    const scopes = signedIn ? parseScope(row.scope) : [];
    const principal: PoppyPrincipalBase = {
      userId: row.userId,
      accountId: signedIn ? row.accountId : null,
      clientId: row.clientId,
      scopes,
      sessionId: row.sessionId,
      signedIn,
      resource: row.resource,
      tokenType: row.jkt ? 'DPoP' : 'Bearer',
    };

    if ((options.signedIn || (options.scopes?.length ?? 0) > 0) && !signedIn) {
      return deny(403, 'sign_in_required', 'This request needs a signed-in Session', {
        scheme: principal.tokenType,
      });
    }
    const required = options.scopes ?? [];
    if (required.some((s) => !scopes.includes(s))) {
      return deny(403, 'insufficient_scope', 'The token lacks required account scopes', {
        scope: formatScope(required),
        scheme: principal.tokenType,
      });
    }
    return { ok: true, principal, jkt };
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

  // ─── navegação (§5) ───────────────────────────────────────────────────────

  /**
   * Confere a asserção de navegador (`typ` `poppy-browser+jwt`). `requestOrigin`
   * é a origem em que o POST chegou — o cookie precisa nascer nela.
   */
  async verifyBrowserAssertion(
    assertion: unknown,
    requestOrigin: string,
  ): Promise<PoppyBrowserSessionResult> {
    const fail = (why: string) => new PoppyError('invalid_request', why);
    if (typeof assertion !== 'string' || !assertion) throw fail('assertion is required');
    let iss: unknown;
    try {
      if (decodeProtectedHeader(assertion).typ !== BROWSER_ASSERTION_TYP) {
        throw fail(`typ must be ${BROWSER_ASSERTION_TYP}`);
      }
      iss = decodeJwt(assertion).iss;
    } catch (error) {
      if (error instanceof PoppyError) throw error;
      throw fail('malformed assertion');
    }
    const client = await this.registry.resolve(iss);
    const accepted = this.#browserSessionEndpoints().filter(
      (e) => new URL(e).origin === new URL(requestOrigin).origin,
    );
    if (accepted.length === 0) throw fail('this host has no browser session endpoint');
    const payload = await this.#verifyAgentJwt(client, assertion, {
      audience: accepted,
      error: 'invalid_request',
      typ: BROWSER_ASSERTION_TYP,
      maxLifetime: 60,
    });
    if (typeof payload.aud !== 'string') throw fail('aud must be a single string');
    if (typeof payload.iat !== 'number' || payload.exp! - payload.iat > 60) {
      throw fail('exp must be at most 60 seconds after iat');
    }
    const sessionId = payload.session_id;
    const userId = payload.sub;
    if (typeof sessionId !== 'string' || typeof userId !== 'string') {
      throw fail('session_id and sub are required');
    }
    const returnTo = payload.return_to;
    if (typeof returnTo !== 'string' || !this.#onCompanyDomain(returnTo)) {
      throw fail('return_to must be an HTTPS URL on the company domain');
    }
    const session = await this.#store.findSession(sessionId);
    const now = this.#now();
    if (
      !session ||
      session.endedAt ||
      session.expiresAt <= now ||
      session.clientId !== client.clientId ||
      session.userId !== userId
    ) {
      throw fail('the Session is not active for this agent and user');
    }
    await this.#claimJti('browser', client.clientId, payload, 'invalid_request');
    const state = await this.sessionState(session.id);
    return {
      sessionId: session.id,
      clientId: client.clientId,
      userId,
      accountId: state?.signedIn ? state.accountId : null,
      scopes: state?.scopes ?? [],
      returnTo,
    };
  }

  #onCompanyDomain(value: string): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    // HTTPS (§5). Em dev, com o próprio issuer em http, aceita http.
    const insecureOk = new URL(this.urls.origin).protocol === 'http:';
    if (url.protocol !== 'https:' && !(insecureOk && url.protocol === 'http:')) return false;
    if (url.username || url.password) return false;
    return hostMatches(url.hostname, this.domains);
  }

  /** Estado atual da Session (ativa? logada? scopes) — o cookie do site segue isto. */
  async sessionState(sessionId: string): Promise<PoppySessionState | null> {
    const session = await this.#store.findSession(sessionId);
    if (!session) return null;
    const now = this.#now();
    const active = !session.endedAt && session.expiresAt > now;
    let signedIn = false;
    if (active && session.grantId) {
      const grant = await this.#grants.findGrant(session.grantId);
      signedIn = !!grant && (await this.#grantUsable(grant, session.clientId, now));
    }
    return {
      active,
      sessionId: session.id,
      clientId: session.clientId,
      userId: session.userId,
      accountId: signedIn ? session.accountId : null,
      signedIn,
      scopes: signedIn ? parseScope(session.scope) : [],
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

  /** Desconectar o agente pela conta (§4.9): revoga um Account Token DA CONTA. */
  async revokeAccountGrant(accountId: string, grantId: string): Promise<boolean> {
    if (!grantId.startsWith('pgrant_')) return false;
    const grant = await this.#grants.findGrant(grantId);
    if (!grant || grant.accountId !== accountId || grant.revokedAt) return false;
    await this.revokeGrant(grantId);
    return true;
  }

  /** Revoga todos os Account Tokens da conta (sair de tudo, conta suspensa…). */
  async revokeAllAccountGrants(accountId: string): Promise<number> {
    const live = (await this.#grants.listGrants(accountId)).filter((g) =>
      g.id.startsWith('pgrant_'),
    );
    for (const g of live) await this.revokeGrant(g.id);
    return live.length;
  }

  // ─── internos ─────────────────────────────────────────────────────────────

  /** Scopes de um pedido de sign-in: obrigatórios, conhecidos e do tipo (§4.4). */
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

  /** A Session existe, está viva e é deste agente (e deste User ID, quando dado). */
  async #sessionFor(
    sessionId: string,
    clientId: string,
    userId: string | null,
  ): Promise<SessionRow> {
    const session = await this.#store.findSession(sessionId);
    const now = this.#now();
    if (
      !session ||
      session.endedAt ||
      session.expiresAt <= now ||
      session.clientId !== clientId ||
      (userId !== null && session.userId !== userId)
    ) {
      throw new PoppyError(
        'invalid_session',
        'The Session has ended or belongs to another agent or user',
      );
    }
    return session;
  }

  async #newSession(clientId: string, userId: string, now: Date): Promise<SessionRow> {
    const row = {
      id: randomId('ses_'),
      clientId,
      userId,
      accountId: null,
      grantId: null,
      scope: '',
      expiresAt: this.#sessionExpiry(now),
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.insertSession(row);
    return { ...row, endedAt: null };
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

  /**
   * Fim comum dos três sign-ins (§4.4): Account Token novo (grant + refresh
   * token) e a Session logada com ele. A Session presa a outra conta →
   * `account_mismatch`.
   */
  async #signIn(
    session: SessionRow,
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
    const scope = formatScope(granted);
    if (
      !(await this.#store.signInSession(session.id, {
        accountId,
        grantId,
        scope,
        expiresAt: this.#sessionExpiry(now),
        at: now,
      }))
    ) {
      throw new PoppyError('account_mismatch', 'The Session is signed in to a different account');
    }
    const expiresAt = new Date(now.getTime() + this.cfg.accountTokenTtl * 1000);
    const grant: GrantRow = {
      id: grantId,
      accountId,
      clientId: session.clientId,
      agentSub: session.userId,
      scope,
      expiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#grants.insertGrant(grant);
    const accountToken = randomId('poa_', 32);
    await this.#grants.insertRefreshToken({
      tokenHash: sha256(accountToken),
      grantId,
      expiresAt,
      createdAt: now,
    });
    const fresh = { ...session, accountId, grantId, scope };
    const body = await this.#issue(fresh, { ...binding, signedIn: grant, scopes });
    return {
      body: {
        ...body,
        refresh_token: accountToken,
        refresh_token_expires_in: this.cfg.accountTokenTtl,
      },
      grantId,
    };
  }

  /** Emite um Session Token para o estado da Session (logado com `signedIn`, ou deslogado). */
  async #issue(
    session: SessionRow,
    input: {
      jkt: string | null;
      resource: string | null;
      signedIn: GrantRow | null;
      scopes: string[];
    },
  ): Promise<PoppyTokenResponse> {
    const now = this.#now();
    const ttl = this.cfg.sessionTokenTtl;
    const scope = input.signedIn ? formatScope(input.scopes) : '';
    let token: string | null = null;
    // Bearer de MCP de Session logada: vira access token do oidc-provider, para
    // a integração MCP existente aceitá-lo sem código no app (§6).
    if (input.jkt === null && input.resource && input.signedIn && this.#mcp?.mint) {
      token = await this.#mcp.mint({
        grantId: input.signedIn.id,
        accountId: input.signedIn.accountId,
        clientId: session.clientId,
        scope,
        resource: input.resource,
        expiresIn: ttl,
        grantExpiresAt: input.signedIn.expiresAt,
      });
    }
    token ??= randomId('pst_', 32);
    await this.#store.insertToken({
      tokenHash: sha256(token),
      sessionId: session.id,
      clientId: session.clientId,
      userId: session.userId,
      accountId: input.signedIn ? input.signedIn.accountId : null,
      grantId: input.signedIn ? input.signedIn.id : null,
      scope,
      resource: input.resource,
      jkt: input.jkt,
      expiresAt: new Date(now.getTime() + ttl * 1000),
      createdAt: now,
    });
    return {
      access_token: token,
      token_type: input.jkt ? 'DPoP' : 'Bearer',
      expires_in: ttl,
      scope,
      session_id: session.id,
      signed_in: input.signedIn !== null,
    };
  }

  async #limit(action: 'session' | 'mediated', key: string): Promise<void> {
    if (!this.#limiter) return;
    const retryAfter = await this.#limiter({ action, key });
    if (retryAfter !== null) {
      throw new PoppyError('rate_limited', 'Too many requests for this client_id', {
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
