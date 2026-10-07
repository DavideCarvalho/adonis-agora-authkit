/**
 * Login OAuth de clientes MCP (Claude Code, Claude, ChatGPT, VS Code, Cursor) — a autorização da
 * spec do MCP: OAuth 2.1 com PKCE, registro dinâmico (RFC 7591), metadata do servidor de
 * autorização (RFC 8414) e o token amarrado ao servidor MCP pelo `resource` (RFC 8707).
 *
 * `mcp: true` na config liga tudo de uma vez:
 *   - o registro dinâmico ABERTO, restrito aos redirects dos clientes MCP conhecidos
 *     ({@link MCP_CLIENT_REDIRECTS}) — loopback para os de linha de comando;
 *   - o refresh token desses clientes: o registro pede `offline_access` e o authorize ganha
 *     `prompt=consent` (OIDC Core §11), então a pessoa consente uma vez e o cliente não precisa
 *     logar de novo a cada hora;
 *   - os `resource` dos servidores MCP: os de `mcp.resources` e os REGISTRADOS em runtime
 *     ({@link registerOAuthResource}) — é por aí que o MCP do `@adonis-agora/agent` se anuncia
 *     sem o app listar a URL dele aqui.
 *
 * Os clientes registrados pelo `/reg` se distinguem pelo `client_id_issued_at`, que só o registro
 * dinâmico grava: clients estáticos ou criados pelo console/CLI não mudam de comportamento.
 */
import type {
  RedirectUriPolicy,
  ResolvedRedirectUriPolicy,
} from '../provider/registration_policy.js';
import { resolveRedirectUriPolicy } from '../provider/registration_policy.js';

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

export interface McpOAuthConfigInput {
  /**
   * Redirects aceitos ALÉM dos clientes MCP conhecidos — ex.: o callback de um cliente próprio.
   * Somados a {@link MCP_CLIENT_REDIRECTS}.
   */
  redirectUris?: RedirectUriPolicy;
  /**
   * URLs dos servidores MCP para os quais este IdP emite tokens, além dos que se registram em
   * runtime ({@link registerOAuthResource}). Ex.: `['https://app.example.com/mcp']`.
   */
  resources?: string[];
}

export interface ResolvedMcpOAuthConfig {
  enabled: boolean;
  redirectUriPolicy: ResolvedRedirectUriPolicy;
  resources: string[];
}

export function resolveMcpOAuth(input?: boolean | McpOAuthConfigInput): ResolvedMcpOAuthConfig {
  const options = typeof input === 'object' ? input : {};
  const extra = options.redirectUris ?? {};
  return {
    enabled: input === true || typeof input === 'object',
    redirectUriPolicy: resolveRedirectUriPolicy({
      loopback: extra.loopback ?? MCP_CLIENT_REDIRECTS.loopback,
      exact: [...new Set([...MCP_CLIENT_REDIRECTS.exact, ...(extra.exact ?? [])])],
      appSchemes: [...new Set([...MCP_CLIENT_REDIRECTS.appSchemes, ...(extra.appSchemes ?? [])])],
      anyHttps: extra.anyHttps ?? MCP_CLIENT_REDIRECTS.anyHttps,
    }),
    resources: [...(options.resources ?? [])],
  };
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
  registry().push({ ...resource });
}

export function registeredOAuthResources(): readonly OAuthResourceRegistration[] {
  return registry();
}

const trim = (value: string) => value.replace(/\/+$/, '');

function normalizePath(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

/**
 * O resource MCP que `indicator` nomeia, ou `null`. Casa com `mcp.resources`, com uma URL
 * registrada, ou com um `path` registrado na origem do issuer. Barra final tolerada.
 */
export function findMcpResource(
  indicator: string,
  issuer: string,
  config: ResolvedMcpOAuthConfig,
): { audience: string; scopes: string[] } | null {
  if (!config.enabled) return null;
  let url: URL;
  try {
    url = new URL(indicator);
  } catch {
    return null;
  }
  const wanted = trim(url.href);
  for (const declared of config.resources) {
    if (trim(declared) === wanted) return { audience: trim(declared), scopes: MCP_RESOURCE_SCOPES };
  }
  const issuerOrigin = new URL(issuer).origin;
  for (const resource of registeredOAuthResources()) {
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
 * Middleware do provider (Koa) que aplica {@link withOfflineAccess} ao `GET /auth` de um client
 * registrado dinamicamente que tem o grant `refresh_token`.
 */
export function mcpAuthorizeMiddleware(provider: { Client: { find(id: string): Promise<any> } }) {
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
      metadata.client_id_issued_at === undefined ||
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
