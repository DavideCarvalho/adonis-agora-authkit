/**
 * Login de clientes MCP (Claude Code, Claude, ChatGPT, Cursor, VS Code), AUTOMÁTICO.
 *
 * O authkit deixa clientes MCP se registrarem e logarem SÓ quando há pelo menos um resource
 * OAuth/MCP registrado com ele:
 *   - uma lib que se anuncia por `registerOAuthResource` (o hub `/mcp/agora` do
 *     `@adonis-agora/agent`, com `devTools` ligado);
 *   - `mcpClients.resources` na config;
 *   - um `oidcBearerGuard({ resource })`.
 *
 * Sem resource, tudo fica desligado: o `/reg` recusa, o metadata RFC 8414 não anuncia
 * `registration_endpoint` nem `client_id_metadata_document_supported`, e um `client_id` URL não
 * resolve. A decisão é tomada A CADA REQUEST (o agente se registra durante o boot, e a ordem dos
 * providers não é garantida), lendo o registro vivo e a setting de runtime `mcp_clients`.
 *
 * Desligar, do mais global ao mais específico:
 *   - `mcpClients: false` na config (trava a setting `mcp_clients`);
 *   - a setting `mcp_clients` `{ enabled: false }` (console admin, Admin API, `authkit:settings:set`);
 *   - `mcpClients.dynamicRegistration: false` / `mcpClients.metadataDocuments: false`.
 */

import { hostAllowed, isClientIdUrl, isHttpsUrl, urlHost } from '../cimd/client_id_url.js';
import { MetadataDocumentCache, resolveDocumentCacheTtl } from '../cimd/document_cache.js';
import { type JsonFetcher, safeFetchJson } from '../cimd/safe_fetch.js';
import type { SettingsCapability } from '../host/runtime_settings.js';
import {
  checkClientRegistration,
  type RedirectUriPolicy,
  RegistrationPolicyError,
  type ResolvedRedirectUriPolicy,
  resolveRedirectUriPolicy,
} from '../provider/registration_policy.js';
import {
  MCP_CLIENT_REDIRECTS,
  mcpClientRegistration,
  registeredOAuthResources,
} from './mcp_oauth.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Client ID Metadata Documents: o `client_id` é uma URL `https:` com o JSON do cliente. */
export interface McpMetadataDocumentsInput {
  /**
   * Só busca documentos destes hosts (`claude.ai`, `*.example.com`). Ausente: qualquer host
   * público (a busca recusa IPs privados/reservados de qualquer jeito).
   */
  allowHosts?: string[];
  /** Tempo em cache de um documento, em segundos: o `max-age` da resposta dentro de `[min, max]`. */
  ttl?: { min?: number; max?: number };
}

export interface McpClientsConfigInput {
  /**
   * URLs de servidores MCP para os quais este IdP emite tokens, além dos que se registram em
   * runtime (`registerOAuthResource`). Ex.: `['https://app.example.com/mcp']`.
   */
  resources?: string[];
  /** Redirects aceitos ALÉM dos clientes MCP conhecidos ({@link MCP_CLIENT_REDIRECTS}). */
  redirectUris?: RedirectUriPolicy;
  /** `false` desliga os Client ID Metadata Documents. Default: ligados. */
  metadataDocuments?: false | McpMetadataDocumentsInput;
  /** `false` desliga o registro dinâmico (RFC 7591): só Client ID Metadata Documents. */
  dynamicRegistration?: false;
}

export interface ResolvedMcpClientsConfig {
  /** `false` só com `mcpClients: false`: nunca liga. */
  allowed: boolean;
  resources: string[];
  redirectUriPolicy: ResolvedRedirectUriPolicy;
  /**
   * De onde vem o registro dinâmico: `'mcp'` = o deste módulo (aberto, só redirects MCP, ligado
   * por request); `'app'` = o `dynamicRegistration` declarado pelo app manda; `'off'` = nenhum.
   */
  dynamicRegistration: 'mcp' | 'app' | 'off';
  /** `null` = Client ID Metadata Documents desligados. */
  metadataDocuments: { allowHosts: string[] | null; ttl: { min: number; max: number } } | null;
}

/** Resolve `mcpClients`. `appDynamicRegistration`: o app declarou o próprio `dynamicRegistration`. */
export function resolveMcpClients(
  input?: false | McpClientsConfigInput,
  appDynamicRegistration = false,
): ResolvedMcpClientsConfig {
  const allowed = input !== false;
  const options = typeof input === 'object' && input !== null ? input : {};
  const extra = options.redirectUris ?? {};
  const docs = options.metadataDocuments;
  const ttl = resolveDocumentCacheTtl(typeof docs === 'object' ? docs.ttl : undefined);
  return {
    allowed,
    resources: [...(options.resources ?? [])],
    redirectUriPolicy: resolveRedirectUriPolicy({
      loopback: extra.loopback ?? MCP_CLIENT_REDIRECTS.loopback,
      exact: [...new Set([...MCP_CLIENT_REDIRECTS.exact, ...(extra.exact ?? [])])],
      appSchemes: [...new Set([...MCP_CLIENT_REDIRECTS.appSchemes, ...(extra.appSchemes ?? [])])],
      anyHttps: extra.anyHttps ?? MCP_CLIENT_REDIRECTS.anyHttps,
    }),
    dynamicRegistration: appDynamicRegistration
      ? 'app'
      : allowed && options.dynamicRegistration !== false
        ? 'mcp'
        : 'off',
    metadataDocuments:
      allowed && docs !== false
        ? {
            allowHosts: typeof docs === 'object' && docs.allowHosts ? [...docs.allowHosts] : null,
            ttl: { min: ttl.min, max: ttl.max },
          }
        : null,
  };
}

/** `mcp` foi removido (1.0): falha alto, apontando o substituto. */
export function assertNoLegacyMcpKey(config: Record<string, unknown>): void {
  if ('mcp' in config && config.mcp !== undefined) {
    throw new Error(
      'authkit: `mcp` was removed from defineConfig — MCP client login is now automatic ' +
        '(on whenever an MCP/OAuth resource is registered). Delete `mcp` from config/authkit.ts; ' +
        'move `mcp.resources`/`mcp.redirectUris` to `mcpClients: { resources, redirectUris }`, ' +
        'or set `mcpClients: false` to keep it off.',
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime setting `mcp_clients`
// ---------------------------------------------------------------------------

/** Chave da setting de runtime. */
export const MCP_CLIENTS_SETTING_KEY = 'mcp_clients';

/** Shape da setting `mcp_clients` em `auth_settings`. */
export interface McpClientsSetting {
  /** `'auto'` (default): ligado quando há resource. `false`: desligado. */
  enabled?: 'auto' | false;
  /** `false` desliga só o registro dinâmico. Default: `true`. */
  dynamicRegistration?: boolean;
  /** `false` desliga só os Client ID Metadata Documents. Default: `true`. */
  metadataDocuments?: boolean;
}

export interface ResolvedMcpClientsSetting {
  enabled: 'auto' | false;
  dynamicRegistration: boolean;
  metadataDocuments: boolean;
}

export const MCP_CLIENTS_SETTING_DEFAULT: ResolvedMcpClientsSetting = Object.freeze({
  enabled: 'auto',
  dynamicRegistration: true,
  metadataDocuments: true,
}) as ResolvedMcpClientsSetting;

/** Erro de shape da setting `mcp_clients`, ou `null`. */
export function validateMcpClientsSetting(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'mcp_clients must be an object: { "enabled": "auto" | false }';
  }
  const v = value as Record<string, unknown>;
  if ('enabled' in v && v.enabled !== 'auto' && v.enabled !== false) {
    return 'mcp_clients.enabled must be "auto" or false';
  }
  for (const field of ['dynamicRegistration', 'metadataDocuments']) {
    if (field in v && typeof v[field] !== 'boolean') return `mcp_clients.${field} must be boolean`;
  }
  const unknown = Object.keys(v).filter(
    (k) => !['enabled', 'dynamicRegistration', 'metadataDocuments'].includes(k),
  );
  if (unknown.length) return `mcp_clients: unknown field(s) ${unknown.join(', ')}`;
  return null;
}

/** A setting gravada → efetiva; ausente/inválida → default (`'auto'`, tudo ligado). */
export function normalizeMcpClientsSetting(raw: unknown): ResolvedMcpClientsSetting {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ...MCP_CLIENTS_SETTING_DEFAULT };
  const v = raw as McpClientsSetting;
  return {
    enabled: v.enabled === false ? false : 'auto',
    dynamicRegistration: v.dynamicRegistration !== false,
    metadataDocuments: v.metadataDocuments !== false,
  };
}

type SettingsSource = () => Promise<SettingsCapability | null>;

let settingsSource: SettingsSource | null = null;
let lastSetting: ResolvedMcpClientsSetting = { ...MCP_CLIENTS_SETTING_DEFAULT };

/**
 * De onde ler a setting `mcp_clients` fora de um request (o provider do oidc-provider não tem o
 * `HttpContext`). Definido no boot pelo provider do authkit; `null` = sem banco → `'auto'`.
 */
export function setMcpClientsSettingsSource(source: SettingsSource | null): void {
  settingsSource = source;
  lastSetting = { ...MCP_CLIENTS_SETTING_DEFAULT };
}

/** Registra uma setting recém-gravada neste processo (vale já para os caminhos síncronos). */
export function noteMcpClientsSetting(setting: ResolvedMcpClientsSetting): void {
  lastSetting = { ...setting };
}

/** Lê a setting (cache curto do `RuntimeSettings`). Falha → a última lida (fail-safe). */
export async function readMcpClientsSetting(): Promise<ResolvedMcpClientsSetting> {
  if (!settingsSource) return lastSetting;
  try {
    const settings = await settingsSource();
    lastSetting = normalizeMcpClientsSetting(
      settings ? await settings.getSetting(MCP_CLIENTS_SETTING_KEY) : null,
    );
  } catch {
    // Fail-safe: banco fora → a última leitura vale.
  }
  return lastSetting;
}

// ---------------------------------------------------------------------------
// Estado vivo
// ---------------------------------------------------------------------------

export interface McpClientsState {
  /** Clientes MCP podem se registrar/logar agora. */
  enabled: boolean;
  /** Por que está desligado (`null` quando ligado). */
  off: 'config' | 'setting' | 'no-resource' | null;
  /** Os resources registrados (URL ou path), na ordem de registro. */
  resources: string[];
  /** O `/reg` do registro dinâmico MCP aceita agora. */
  dynamicRegistration: boolean;
  /** Um `client_id` URL (Client ID Metadata Document) resolve agora. */
  metadataDocuments: boolean;
  /** A setting `mcp_clients` efetiva. */
  setting: ResolvedMcpClientsSetting;
  /** `mcpClients: false` na config: a setting está travada. */
  lockedByConfig: boolean;
}

let labelsMemo: { length: number; config: readonly string[]; labels: string[] } | null = null;

/** Os resources registrados (memoizado pelo tamanho do registro, que só cresce). */
export function registeredResourceLabels(configResources: readonly string[]): string[] {
  const registered = registeredOAuthResources();
  if (
    labelsMemo &&
    labelsMemo.length === registered.length &&
    labelsMemo.config === configResources
  ) {
    return labelsMemo.labels;
  }
  const labels = [
    ...new Set([
      ...registered.map((r) => (r.url ?? r.path ?? '').replace(/\/+$/, '') || '/'),
      ...configResources.map((r) => r.replace(/\/+$/, '')),
    ]),
  ];
  labelsMemo = { length: registered.length, config: configResources, labels };
  return labels;
}

/** O estado a partir da config e de uma setting já lida. Puro. */
export function mcpClientsStateFrom(
  config: ResolvedMcpClientsConfig,
  setting: ResolvedMcpClientsSetting,
): McpClientsState {
  const resources = config.allowed ? registeredResourceLabels(config.resources) : [];
  const off = !config.allowed
    ? 'config'
    : setting.enabled === false
      ? 'setting'
      : resources.length === 0
        ? 'no-resource'
        : null;
  const enabled = off === null;
  return {
    enabled,
    off,
    resources,
    dynamicRegistration:
      enabled && config.dynamicRegistration === 'mcp' && setting.dynamicRegistration,
    metadataDocuments: enabled && config.metadataDocuments !== null && setting.metadataDocuments,
    setting,
    lockedByConfig: !config.allowed,
  };
}

/** O estado vivo: relê a setting (cache curto) e o registro. */
export async function mcpClientsState(config: ResolvedMcpClientsConfig): Promise<McpClientsState> {
  if (!config.allowed) return mcpClientsStateFrom(config, MCP_CLIENTS_SETTING_DEFAULT);
  return mcpClientsStateFrom(config, await readMcpClientsSetting());
}

/** O estado com a última setting lida — para caminhos síncronos. */
export function mcpClientsStateSync(config: ResolvedMcpClientsConfig): McpClientsState {
  return mcpClientsStateFrom(config, config.allowed ? lastSetting : MCP_CLIENTS_SETTING_DEFAULT);
}

/** Uma linha legível do estado (doctor, boot log, CLI). */
export function describeMcpClientsState(state: McpClientsState): string {
  if (state.enabled) {
    return `on (automatic — resources: ${state.resources.join(', ')}; disable with \`mcpClients: false\`)`;
  }
  if (state.off === 'config') return 'off (mcpClients: false)';
  if (state.off === 'setting') return 'off (turned off by the `mcp_clients` setting)';
  return 'off (no MCP resource registered)';
}

// ---------------------------------------------------------------------------
// Client ID Metadata Documents
// ---------------------------------------------------------------------------

/** Teto do documento de um cliente MCP. */
export const MCP_METADATA_DOCUMENT_MAX_BYTES = 5 * 1024;
/** Teto de tempo da busca. */
export const MCP_METADATA_DOCUMENT_TIMEOUT_MS = 5000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: recusa caracteres de controle no nome
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Valida o Client ID Metadata Document buscado em `url` e devolve o metadata do client para o
 * oidc-provider. Lança {@link RegistrationPolicyError} quando o documento não serve:
 *   - `client_id` igual à URL;
 *   - cliente público (`token_endpoint_auth_method` `none` ou ausente), sem secret nem chaves;
 *   - `redirect_uris` dentro da política dos clientes MCP;
 *   - só o fluxo de código; `client_name` texto curto sem caracteres de controle.
 */
export function mcpClientFromMetadataDocument(
  url: string,
  doc: unknown,
  policy: ResolvedRedirectUriPolicy,
): Record<string, unknown> {
  const bad = (why: string) =>
    new RegistrationPolicyError('invalid_client_metadata', `client metadata document: ${why}`);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw bad('not a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== url) throw bad('client_id must equal the URL it was fetched from');
  const auth = d.token_endpoint_auth_method ?? 'none';
  if (auth !== 'none') throw bad('only public clients (token_endpoint_auth_method: none)');
  for (const forbidden of ['client_secret', 'client_secret_expires_at', 'jwks', 'jwks_uri']) {
    if (forbidden in d) throw bad(`${forbidden} is not allowed`);
  }
  let name: string | undefined;
  if (d.client_name !== undefined) {
    if (
      typeof d.client_name !== 'string' ||
      !d.client_name.trim() ||
      d.client_name.length > 200 ||
      CONTROL_CHARS.test(d.client_name)
    ) {
      throw bad('client_name must be a short single-line text');
    }
    name = d.client_name.trim();
  }
  const metadata: Record<string, unknown> = {
    client_id: url,
    client_name: name ?? urlHost(url) ?? url,
    redirect_uris: d.redirect_uris,
    grant_types: d.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: d.response_types ?? ['code'],
    token_endpoint_auth_method: 'none',
  };
  if (typeof d.scope === 'string') metadata.scope = d.scope;
  for (const field of ['logo_uri', 'client_uri', 'policy_uri', 'tos_uri']) {
    if (isHttpsUrl(d[field])) metadata[field] = d[field];
  }
  try {
    return mcpClientRegistration(checkClientRegistration(metadata, policy));
  } catch (error) {
    if (error instanceof RegistrationPolicyError) throw bad(error.message);
    throw error;
  }
}

export interface McpMetadataDocumentResolverOptions {
  /** Busca do JSON. Default: {@link safeFetchJson} com 5 KB e 5 s. */
  fetchJson?: JsonFetcher;
  /** Avisado quando um documento é recusado (log). */
  onReject?: (clientId: string, reason: string) => void;
  now?: () => number;
}

/**
 * Resolve clientes MCP pelo Client ID Metadata Document: busca à prova de SSRF, valida, guarda em
 * cache. Nenhuma linha no banco por cliente.
 */
export class McpMetadataDocumentResolver {
  #cache: MetadataDocumentCache<Record<string, unknown>>;
  #allowHosts: string[] | null;
  #onReject?: (clientId: string, reason: string) => void;

  constructor(config: ResolvedMcpClientsConfig, options: McpMetadataDocumentResolverOptions = {}) {
    const docs = config.metadataDocuments;
    this.#allowHosts = docs?.allowHosts ?? null;
    this.#onReject = options.onReject;
    this.#cache = new MetadataDocumentCache({
      fetchJson:
        options.fetchJson ??
        ((url) =>
          safeFetchJson(url, {
            maxBytes: MCP_METADATA_DOCUMENT_MAX_BYTES,
            timeoutMs: MCP_METADATA_DOCUMENT_TIMEOUT_MS,
            userAgent: 'authkit',
          })),
      validate: (url, body) => mcpClientFromMetadataDocument(url, body, config.redirectUriPolicy),
      fetchError: (_url, why) =>
        new RegistrationPolicyError('invalid_client_metadata', `client metadata document: ${why}`),
      ttl: docs?.ttl,
      now: options.now,
    });
  }

  /** Pode ser um Client ID Metadata Document deste servidor (URL válida, host permitido)? */
  accepts(clientId: string): boolean {
    if (!isClientIdUrl(clientId)) return false;
    const host = urlHost(clientId);
    return !!host && (!this.#allowHosts || hostAllowed(host, this.#allowHosts));
  }

  /** O metadata do client, ou `undefined` (não é URL, host fora da lista, documento recusado). */
  async find(clientId: string): Promise<Record<string, unknown> | undefined> {
    if (!this.accepts(clientId)) return undefined;
    try {
      return await this.#cache.get(clientId);
    } catch (error) {
      this.#onReject?.(clientId, error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /** `clientId` foi resolvido por documento e está em cache. */
  has(clientId: string): boolean {
    return this.#cache.peek(clientId) !== undefined;
  }

  /** Os clientes em cache neste processo. */
  cached(): Array<{ clientId: string; clientName: string | null }> {
    return this.#cache.entries().map(([clientId, metadata]) => ({
      clientId,
      clientName: typeof metadata.client_name === 'string' ? metadata.client_name : null,
    }));
  }

  clear(): void {
    this.#cache.clear();
  }
}

/**
 * Adapter do model `Client` que, quando o client não existe no banco e o `id` é uma URL, o
 * resolve pelo Client ID Metadata Document — se `isOn()` (avaliado por chamada).
 */
export function withMetadataDocuments<T extends { find(id: string): Promise<any> }>(
  adapter: T,
  resolver: McpMetadataDocumentResolver,
  isOn: () => Promise<boolean>,
): T {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'find') {
        return async (id: string) => {
          const payload = await target.find(id);
          if (payload || !resolver.accepts(id) || !(await isOn())) return payload;
          return resolver.find(id);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Middlewares do provider (Koa)
// ---------------------------------------------------------------------------

const DISCOVERY_PATHS = new Set([
  '/.well-known/openid-configuration',
  '/.well-known/oauth-authorization-server',
]);

/**
 * Por request: recusa o `/reg` do registro dinâmico MCP quando ele está desligado (403), e ajusta
 * o metadata (RFC 8414 / discovery): sem `registration_endpoint` com o registro desligado, com
 * `client_id_metadata_document_supported` com os documentos ligados.
 */
export function mcpClientsMiddleware(config: ResolvedMcpClientsConfig, registrationPath = '/reg') {
  const reg = registrationPath.toLowerCase();
  return async (ctx: any, next: () => Promise<void>) => {
    const path = String(ctx.path ?? '').toLowerCase();
    const isRegistration =
      config.dynamicRegistration === 'mcp' && (path === reg || path.startsWith(`${reg}/`));
    if (isRegistration) {
      const state = await mcpClientsState(config);
      if (!state.dynamicRegistration) {
        ctx.status = 403;
        ctx.set('cache-control', 'no-store');
        ctx.body = {
          error: 'access_denied',
          error_description: `MCP client registration is ${describeMcpClientsState(state)}`,
        };
        return;
      }
      return next();
    }
    await next();
    if (ctx.method !== 'GET' || !DISCOVERY_PATHS.has(path.replace(/\/+$/, ''))) return;
    if (!ctx.body || typeof ctx.body !== 'object') return;
    const state = await mcpClientsState(config);
    if (config.dynamicRegistration === 'mcp' && !state.dynamicRegistration) {
      delete ctx.body.registration_endpoint;
    }
    if (state.metadataDocuments) ctx.body.client_id_metadata_document_supported = true;
    else delete ctx.body.client_id_metadata_document_supported;
  };
}
