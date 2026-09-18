/**
 * Política do registro dinâmico de clients (RFC 7591 / RFC 7592).
 *
 * O oidc-provider, sozinho, aceita qualquer `redirect_uri` que passe na
 * validação sintática de metadata (qualquer `https://…`, por exemplo). Com o
 * registro ABERTO (sem Initial Access Token — o caso dos clientes MCP, que não
 * têm como obter um IAT), isso deixa qualquer um registrar um client cujo
 * callback é um domínio do atacante e usar a tela de consent do IdP como isca.
 * O que protege o usuário é PARA ONDE o código de autorização pode ir.
 *
 * Esta política roda ANTES do provider (middleware Koa em `provider.use`), no
 * `POST /reg` (criação) e no `PUT /reg/:clientId` (update do RFC 7592), e:
 *
 *   1. confere cada `redirect_uris` / `post_logout_redirect_uris` contra a
 *      política (loopback, URLs exatas, esquemas de app instalado, https);
 *   2. restringe o client ao fluxo de código (`authorization_code` +
 *      `refresh_token`, `response_type=code`) — PKCE já é obrigatório no IdP;
 *   3. normaliza `application_type: 'native'` quando todos os redirects são
 *      loopback/app instalado (é o que o client é, e sem isso o oidc-provider
 *      recusa esquema próprio);
 *   4. chama o gancho `validateRegistration` do host, se houver.
 *
 * Funções puras + um middleware fino, para serem testadas isoladamente.
 */

/** Política de redirect URIs aceita no registro dinâmico. */
export interface RedirectUriPolicy {
  /**
   * Aceita `http://localhost`, `http://127.0.0.1` e `http://[::1]` em QUALQUER
   * porta e path (RFC 8252 §7.3 — apps nativos/CLIs escutam numa porta efêmera).
   * Default: `true`.
   */
  loopback?: boolean;
  /** URLs de callback aceitas por igualdade EXATA (ex.: callbacks de fornecedores). Default: `[]`. */
  exact?: string[];
  /**
   * Esquemas privados de app instalado (RFC 8252 §7.1), sem o `:`, ex.:
   * `['cursor', 'vscode']`. Default: `[]`.
   */
  appSchemes?: string[];
  /**
   * Aceita QUALQUER redirect `https://`. É o comportamento do oidc-provider sem
   * política — só faz sentido com registro protegido por Initial Access Token.
   * Default: `false`.
   */
  anyHttps?: boolean;
}

export interface ResolvedRedirectUriPolicy {
  loopback: boolean;
  exact: string[];
  appSchemes: string[];
  anyHttps: boolean;
}

/** Operação de registro que está sendo validada. */
export type RegistrationOperation = 'create' | 'update';

/**
 * Gancho do host para validar/ajustar o metadata de um registro dinâmico,
 * depois da política de redirect. Pode:
 *   - retornar `void` → segue com o metadata como está;
 *   - retornar um objeto → ele SUBSTITUI o metadata enviado ao provider;
 *   - lançar {@link RegistrationPolicyError} → o registro é recusado com
 *     `400 { error, error_description }`.
 * Qualquer outro erro sobe (500).
 */
export type ValidateRegistrationHook = (
  metadata: Record<string, unknown>,
  info: { operation: RegistrationOperation; ctx: unknown },
) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;

/** Erro de política: vira `400 { error: code, error_description: message }`. */
export class RegistrationPolicyError extends Error {
  readonly code: 'invalid_redirect_uri' | 'invalid_client_metadata';
  constructor(code: 'invalid_redirect_uri' | 'invalid_client_metadata', description: string) {
    super(description);
    this.name = 'RegistrationPolicyError';
    this.code = code;
  }
}

/** Default seguro do registro ABERTO: só loopback, nada de web arbitrário. */
export const OPEN_REGISTRATION_REDIRECT_POLICY: ResolvedRedirectUriPolicy = Object.freeze({
  loopback: true,
  exact: [],
  appSchemes: [],
  anyHttps: false,
}) as ResolvedRedirectUriPolicy;

export function resolveRedirectUriPolicy(input: RedirectUriPolicy): ResolvedRedirectUriPolicy {
  return {
    loopback: input.loopback ?? true,
    exact: [...(input.exact ?? [])],
    appSchemes: (input.appSchemes ?? []).map((s) => s.replace(/:$/, '').toLowerCase()),
    anyHttps: input.anyHttps ?? false,
  };
}

export type RedirectKind = 'loopback' | 'app' | 'web';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Classifica um redirect pela política; `null` = fora dela. */
export function classifyRedirect(
  uri: string,
  policy: ResolvedRedirectUriPolicy,
): RedirectKind | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  // Credencial embutida e fragmento nunca são redirect legítimo (RFC 6749 §3.1.2).
  if (url.username || url.password || url.hash) return null;

  if (policy.loopback && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return 'loopback';
  }
  if (policy.exact.includes(uri)) return 'web';
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (policy.appSchemes.includes(scheme)) return 'app';
  if (policy.anyHttps && url.protocol === 'https:') return 'web';
  return null;
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

const ALLOWED_GRANTS = new Set(['authorization_code', 'refresh_token']);

/**
 * Confere o metadata de um registro contra a política. Devolve o metadata
 * normalizado ou lança {@link RegistrationPolicyError}.
 */
export function checkClientRegistration(
  metadata: Record<string, unknown>,
  policy: ResolvedRedirectUriPolicy,
): Record<string, unknown> {
  const redirects = stringList(metadata.redirect_uris);
  if (!redirects || redirects.length === 0) {
    throw new RegistrationPolicyError('invalid_redirect_uri', 'redirect_uris is required');
  }

  const kinds: RedirectKind[] = [];
  for (const uri of redirects) {
    const kind = classifyRedirect(uri, policy);
    if (!kind) {
      throw new RegistrationPolicyError(
        'invalid_redirect_uri',
        `redirect_uri not allowed by the registration policy: ${uri}`,
      );
    }
    kinds.push(kind);
  }

  if (metadata.post_logout_redirect_uris !== undefined) {
    const logout = stringList(metadata.post_logout_redirect_uris);
    if (!logout || logout.some((uri) => !classifyRedirect(uri, policy))) {
      throw new RegistrationPolicyError(
        'invalid_client_metadata',
        'post_logout_redirect_uris not allowed by the registration policy',
      );
    }
  }

  const grants =
    metadata.grant_types === undefined ? ['authorization_code'] : stringList(metadata.grant_types);
  if (!grants?.includes('authorization_code') || grants.some((g) => !ALLOWED_GRANTS.has(g))) {
    throw new RegistrationPolicyError(
      'invalid_client_metadata',
      'only the authorization_code and refresh_token grant types are allowed',
    );
  }

  const responses =
    metadata.response_types === undefined ? ['code'] : stringList(metadata.response_types);
  if (responses?.length !== 1 || responses[0] !== 'code') {
    throw new RegistrationPolicyError(
      'invalid_client_metadata',
      'only response_type=code is allowed',
    );
  }

  const native = kinds.every((kind) => kind !== 'web');
  return native && metadata.application_type === undefined
    ? { ...metadata, application_type: 'native' }
    : metadata;
}

/** Mesmo teto do `selective_body` do oidc-provider. */
const BODY_LIMIT = 56 * 1024;

/**
 * Lê o corpo JSON do request. Quando o Adonis já parseou (a ponte do
 * `OidcCallbackController` põe o objeto em `req.body`), usa-o; senão consome o
 * stream. Devolve `undefined` quando não dá para interpretar como objeto — o
 * provider segue e responde o erro de parse ele mesmo.
 */
async function readJsonBody(ctx: any): Promise<Record<string, unknown> | undefined> {
  const req = ctx.req;
  let raw: unknown;
  if (req.readable && !req.readableEnded) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) return undefined;
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
    // O stream foi consumido: o provider cai no fallback `req.body`.
    req.body = raw;
  } else {
    raw = req.body ?? ctx.request?.body;
  }
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try {
      raw = JSON.parse(raw.toString());
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

/**
 * Middleware Koa (para `provider.use`) que aplica a política no registro
 * dinâmico. `registrationPath` é o path da rota DENTRO do provider (default
 * `/reg`; sob koa-mount o prefixo do issuer já foi removido).
 */
export function registrationPolicyMiddleware(options: {
  policy: ResolvedRedirectUriPolicy | null;
  validate?: ValidateRegistrationHook;
  registrationPath?: string;
}) {
  const base = options.registrationPath ?? '/reg';
  return async (ctx: any, next: () => Promise<void>) => {
    const operation: RegistrationOperation | null =
      ctx.method === 'POST' && ctx.path === base
        ? 'create'
        : ctx.method === 'PUT' && ctx.path.startsWith(`${base}/`)
          ? 'update'
          : null;
    if (!operation || !ctx.is('application/json')) return next();

    const metadata = await readJsonBody(ctx);
    if (!metadata) return next();

    try {
      let checked = options.policy ? checkClientRegistration(metadata, options.policy) : metadata;
      if (options.validate) {
        const replaced = await options.validate(checked, { operation, ctx });
        if (replaced && typeof replaced === 'object') checked = replaced;
      }
      ctx.req.body = checked;
    } catch (error) {
      if (!(error instanceof RegistrationPolicyError)) throw error;
      ctx.status = 400;
      ctx.set('cache-control', 'no-store');
      ctx.body = { error: error.code, error_description: error.message };
      return;
    }
    return next();
  };
}
