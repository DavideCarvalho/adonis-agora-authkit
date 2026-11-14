/**
 * Login OAuth de clientes MCP (Claude Code, Claude, ChatGPT, VS Code, Cursor) — a autorização da
 * spec do MCP: OAuth 2.1 com PKCE, registro dinâmico (RFC 7591) ou Client ID Metadata Documents,
 * metadata do servidor de autorização (RFC 8414) e o token amarrado ao servidor MCP pelo
 * `resource` (RFC 8707).
 *
 * Este módulo tem as peças de protocolo: os redirects dos clientes MCP conhecidos
 * ({@link MCP_CLIENT_REDIRECTS}), o registro global de resources ({@link registerOAuthResource}),
 * o refresh token dos clientes MCP (o registro pede `offline_access` e o authorize ganha
 * `prompt=consent`, OIDC Core §11) e os documentos RFC 9728. QUANDO o login de clientes MCP está
 * ligado é decidido por request em `mcp_clients.ts` (automático: há um resource registrado).
 *
 * Os clientes registrados pelo `/reg` se distinguem pelo `client_id_issued_at`, que só o registro
 * dinâmico grava: clients estáticos ou criados pelo console/CLI não mudam de comportamento.
 */
import type { RedirectUriPolicy } from '../provider/registration_policy.js';

/** Callbacks dos clientes MCP conhecidos. Loopback (Claude Code, CLIs) já entra pela política. */
export const MCP_CLIENT_REDIRECTS: Required<RedirectUriPolicy> = {
  loopback: true,
  exact: [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://vscode.dev/redirect',
    'https://insiders.vscode.dev/redirect',
  ],
  appSchemes: ['cursor', 'vscode', 'vscode-insiders'],
  anyHttps: false,
};

/** Escopos de um token de servidor MCP: identidade + refresh. */
export const MCP_RESOURCE_SCOPES = ['openid', 'profile', 'email', 'offline_access'];

/** O que {@link findMcpResource} precisa saber do login de clientes MCP agora. */
export interface McpResourceLookup {
  /** Login de clientes MCP ligado neste request. */
  enabled: boolean;
  /** `mcpClients.resources` da config. */
  resources: readonly string[];
}

/**
 * Um servidor protegido (RFC 9728) que aceita tokens deste IdP. `url` é o `resource` exato; sem
 * ela, `path` casa com qualquer `resource` na origem do issuer (quem registra no boot nem sempre
 * sabe a URL pública).
 */
export interface OAuthResourceRegistration {
  url?: string;
  path?: string;
  /** Escopos do token para este resource. Default: {@link MCP_RESOURCE_SCOPES}. */
  scopes?: string[];
  /** `resource_name` do documento RFC 9728, quando o authkit o serve (`metadata: true`). */
  name?: string;
  /**
   * `true`: o authkit serve o documento RFC 9728 deste resource em
   * `/.well-known/oauth-protected-resource<path>` (é o que o `oidcBearerGuard({ resource })` faz).
   * Ausente: quem registrou serve o próprio documento (o MCP do `@adonis-agora/agent`), e o authkit
   * não monta rota nesse path.
   */
  metadata?: boolean;
}

/**
 * Registro em runtime — um slot global, para que outra lib (o MCP do `@adonis-agora/agent`) se
 * registre sem importar esta: o contrato é o símbolo, não o módulo.
 */
const REGISTRY = Symbol.for('@adonis-agora/oauth:resources');

function registry(): OAuthResourceRegistration[] {
  const slot = globalThis as Record<symbol, unknown>;
  if (!Array.isArray(slot[REGISTRY])) slot[REGISTRY] = [];
  return slot[REGISTRY] as OAuthResourceRegistration[];
}

export function registerOAuthResource(resource: OAuthResourceRegistration): void {
  if (!resource.url && !resource.path) {
    throw new Error('authkit: registerOAuthResource precisa de `url` ou `path`.');
  }
  const list = registry();
  const same = (r: OAuthResourceRegistration) =>
    r.url === resource.url && r.path === resource.path && !!r.metadata === !!resource.metadata;
  if (list.some(same)) return;
  list.push({ ...resource });
}

export function registeredOAuthResources(): readonly OAuthResourceRegistration[] {
  return registry();
}

/** `true` quando algum guard do app declarou um resource (`oidcBearerGuard({ resource })`). */
export function hasGuardResources(): boolean {
  return registry().some((r) => r.metadata);
}

const trim = (value: string) => value.replace(/\/+$/, '');

function normalizePath(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * O resource MCP que `indicator` nomeia, ou `null`. Casa com `mcpClients.resources`, com uma URL
 * registrada, ou com um `path` registrado na origem do issuer. Barra final tolerada. Com o login
 * de clientes MCP desligado, só os resources que o próprio app declarou num guard
 * (`metadata: true`) valem.
 */
export function findMcpResource(
  indicator: string,
  issuer: string,
  config: McpResourceLookup,
): { audience: string; scopes: string[] } | null {
  const resources = config.enabled
    ? registeredOAuthResources()
    : registeredOAuthResources().filter((r) => r.metadata);
  if (resources.length === 0 && !config.enabled) return null;
  let url: URL;
  try {
    url = new URL(indicator);
  } catch {
    return null;
  }
  const wanted = trim(url.href);
  for (const declared of config.enabled ? config.resources : []) {
    if (trim(declared) === wanted) return { audience: trim(declared), scopes: MCP_RESOURCE_SCOPES };
  }
  const issuerOrigin = new URL(issuer).origin;
  for (const resource of resources) {
    const scopes = resource.scopes ?? MCP_RESOURCE_SCOPES;
    if (resource.url && trim(resource.url) === wanted)
      return { audience: trim(resource.url), scopes };
    if (
      resource.path &&
      url.origin === issuerOrigin &&
      trim(url.pathname) === normalizePath(resource.path) &&
      !url.search
    ) {
      return { audience: wanted, scopes };
    }
  }
  return null;
}

/** Path de um resource no documento RFC 9728: `/api`, ou `''` para a raiz da origem. */
export function resourcePath(path: string): string {
  const normalized = normalizePath(path);
  return normalized === '/' ? '' : normalized;
}

/** Prefixo do documento de um protected resource (RFC 9728 §3.1). */
export const PROTECTED_RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource';

/**
 * Onde fica o documento RFC 9728 de `resource`: o segmento well-known entra entre a origem e o
 * path (§3.1). `https://app/api` → `https://app/.well-known/oauth-protected-resource/api`.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}${PROTECTED_RESOURCE_WELL_KNOWN}${resourcePath(url.pathname)}`;
}

/** Documento de metadata de um protected resource (RFC 9728 §2). */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name?: string;
}

/**
 * Monta o documento RFC 9728 de `resource` com `issuer` como servidor de autorização. Útil para um
 * resource server REMOTO (que não hospeda o authkit) servir o próprio documento.
 */
export function protectedResourceMetadata(options: {
  resource: string;
  issuer: string;
  scopes?: string[];
  name?: string;
}): ProtectedResourceMetadata {
  return {
    resource: options.resource,
    authorization_servers: [options.issuer],
    scopes_supported: options.scopes ?? MCP_RESOURCE_SCOPES,
    bearer_methods_supported: ['header'],
    ...(options.name ? { resource_name: options.name } : {}),
  };
}

/** Um documento RFC 9728 que o authkit serve: o `path` da rota e o resource que ele descreve. */
export interface ServedProtectedResource {
  /** Sufixo depois de `/.well-known/oauth-protected-resource` (`/api`, ou `''`). */
  path: string;
  /** URL exata do resource; ausente = `path` na origem do issuer. */
  url?: string;
  scopes: string[];
  name?: string;
}

/**
 * Os documentos RFC 9728 que o authkit serve: os resources registrados com `metadata: true` (o
 * `oidcBearerGuard({ resource })`) e os de `mcpClients.resources` na origem do issuer. Paths de resources
 * registrados SEM `metadata` ficam de fora: a lib que os registrou serve o próprio documento (o MCP
 * do `@adonis-agora/agent`), e uma segunda rota no mesmo path colidiria. Primeiro a declarar ganha.
 */
export function servedProtectedResources(options: {
  issuer?: string;
  mcpResources?: readonly string[];
}): ServedProtectedResource[] {
  const pathOf = (r: OAuthResourceRegistration) =>
    resourcePath(r.url ? new URL(r.url).pathname : (r.path ?? ''));
  const registered = registeredOAuthResources();
  const taken = new Set(registered.filter((r) => !r.metadata).map(pathOf));
  const served: ServedProtectedResource[] = [];
  const add = (entry: ServedProtectedResource) => {
    if (taken.has(entry.path)) return;
    taken.add(entry.path);
    served.push(entry);
  };
  for (const r of registered) {
    if (!r.metadata) continue;
    add({
      path: pathOf(r),
      ...(r.url ? { url: trim(r.url) } : {}),
      scopes: r.scopes ?? MCP_RESOURCE_SCOPES,
      ...(r.name ? { name: r.name } : {}),
    });
  }
  const issuerOrigin = options.issuer ? new URL(options.issuer).origin : undefined;
  for (const declared of options.mcpResources ?? []) {
    let url: URL;
    try {
      url = new URL(declared);
    } catch {
      continue;
    }
    // Um servidor MCP em outra origem serve o próprio documento: o `resource` do RFC 9728 tem de
    // bater com a URL de onde o documento foi lido (§3.3).
    if (url.origin !== issuerOrigin || url.search) continue;
    add({ path: resourcePath(url.pathname), url: trim(declared), scopes: MCP_RESOURCE_SCOPES });
  }
  return served;
}

/**
 * Registro de um cliente MCP: quem pede `refresh_token` ganha `openid offline_access` no escopo
 * registrado, senão o provider recusaria pedi-los no authorize.
 */
export function mcpClientRegistration(metadata: Record<string, unknown>): Record<string, unknown> {
  const grants = Array.isArray(metadata.grant_types)
    ? metadata.grant_types
    : ['authorization_code'];
  if (!grants.includes('refresh_token') || typeof metadata.scope !== 'string') return metadata;
  const scopes = metadata.scope.split(' ').filter(Boolean);
  for (const needed of ['openid', 'offline_access']) {
    if (!scopes.includes(needed)) scopes.push(needed);
  }
  return { ...metadata, scope: scopes.join(' ') };
}

/**
 * `scope`/`prompt` do authorize de um cliente MCP para que saia um refresh token: `offline_access`
 * no escopo e `consent` no prompt (sem ele o provider descarta o `offline_access`). `null` quando
 * já estão lá. `prompt=none` pede "sem interação", o contrário de consentir: sai.
 */
export function withOfflineAccess(
  params: Record<string, unknown>,
): { scope: string; prompt: string } | null {
  const scopes = String(params.scope ?? '')
    .split(' ')
    .filter(Boolean);
  const prompts = String(params.prompt ?? '')
    .split(' ')
    .filter(Boolean);
  const needsScope = !scopes.includes('offline_access');
  const needsPrompt = !prompts.includes('consent');
  if (!needsScope && !needsPrompt) return null;
  if (!scopes.includes('openid')) scopes.unshift('openid');
  if (needsScope) scopes.push('offline_access');
  const prompt = needsPrompt ? [...prompts.filter((p) => p !== 'none'), 'consent'] : prompts;
  return { scope: scopes.join(' '), prompt: prompt.join(' ') };
}

/**
 * Middleware do provider (Koa) que aplica {@link withOfflineAccess} ao `GET /auth` de um cliente
 * MCP (registrado dinamicamente, ou por Client ID Metadata Document — `isMetadataDocument`) que
 * tem o grant `refresh_token`.
 */
export function mcpAuthorizeMiddleware(
  provider: { Client: { find(id: string): Promise<any> } },
  isMetadataDocument: (clientId: string) => boolean = () => false,
) {
  return async (ctx: any, next: () => Promise<void>) => {
    if (ctx.method !== 'GET' || ctx.path !== '/auth') return next();
    const query = ctx.query as Record<string, unknown>;
    const clientId = typeof query.client_id === 'string' ? query.client_id : '';
    if (!clientId || (query.response_type !== undefined && query.response_type !== 'code')) {
      return next();
    }
    const client = await provider.Client.find(clientId).catch(() => undefined);
    const metadata = client?.metadata?.() ?? {};
    const grants: unknown = metadata.grant_types;
    if (
      (metadata.client_id_issued_at === undefined && !isMetadataDocument(clientId)) ||
      !Array.isArray(grants) ||
      !grants.includes('refresh_token')
    ) {
      return next();
    }
    const widened = withOfflineAccess(query);
    if (widened) ctx.query = { ...query, ...widened };
    return next();
  };
}
