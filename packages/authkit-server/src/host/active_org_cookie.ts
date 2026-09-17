import type { ActiveOrgInfo } from '../accounts/account_store.js';

/** Nome do cookie da org ativa. HttpOnly, SameSite=Lax, Secure em prod. */
export const ACTIVE_ORG_COOKIE = 'authkit_active_org';

/** TTL máximo do cookie da org ativa (30 dias em segundos). */
export const ACTIVE_ORG_COOKIE_TTL = 60 * 60 * 24 * 30;

/**
 * Codifica as informações da org ativa num valor de cookie (plaintext, sem
 * assinatura — a assinatura fica a cargo do jar de cookies do AdonisJS/Keygrip
 * via o próprio cookie signed). Formato: `orgId\torgSlug\torgRole`.
 * TAB é escolhido pois IDs e slugs não o contêm.
 */
export function encodeActiveOrgCookie(info: ActiveOrgInfo): string {
  return `${info.orgId}\t${info.orgSlug}\t${info.orgRole}`;
}

/**
 * Decodifica o valor cru do cookie. Retorna `null` se o formato for inválido.
 * Não valida assinatura — assume que o caller já verificou (AdonisJS request.cookiesList).
 */
export function decodeActiveOrgCookie(value: string | null | undefined): ActiveOrgInfo | null {
  if (!value) return null;
  const parts = value.split('\t');
  if (parts.length !== 3) return null;
  const [orgId, orgSlug, orgRole] = parts;
  if (!orgId || !orgSlug || !orgRole) return null;
  return { orgId, orgSlug, orgRole };
}

/**
 * Parseia um valor de cookie possivelmente URL-encoded.
 *
 * O jar Koa do oidc-provider (`cookies`) devolve o valor COMO ESTÁ no header — sem
 * URL-decode. Como o host grava o cookie via `response.cookie` (que serializa com
 * `encodeURIComponent`, transformando os TABs em `%09`), é preciso tentar decodificar.
 * Tentamos o valor cru primeiro (hosts que gravem sem encode) e o decodificado depois.
 */
function parseActiveOrgCookieValue(raw: unknown): ActiveOrgInfo | null {
  if (typeof raw !== 'string') return null;
  const direct = decodeActiveOrgCookie(raw);
  if (direct) return direct;
  try {
    return decodeActiveOrgCookie(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/**
 * Lê a org ativa de um contexto Koa (oidc-provider). O oidc-provider usa o Keygrip
 * das `cookieKeys` para assinar os cookies — lemos via `ctx.cookies.get(name, { signed: false })`
 * (o oidc-provider não assina cookies da aplicação; apenas verifica os seus). A
 * validação de assinatura para este cookie de aplicação é feita no controller AdonisJS
 * ao gravar (via `ctx.response.cookie` com `signed: true`). Aqui fazemos best-effort:
 * se o valor estiver presente e parseable, usamos; caso contrário retorna null.
 *
 * NOTA: o oidc-provider ctx.cookies.get() nunca lança — retorna null se ausente.
 */
export function readActiveOrgFromKoaCtx(koaCtx: any): ActiveOrgInfo | null {
  try {
    const raw = koaCtx?.cookies?.get?.(ACTIVE_ORG_COOKIE, { signed: false });
    return parseActiveOrgCookieValue(raw);
  } catch {
    return null;
  }
}

/**
 * Normaliza um valor potencialmente vindo de um payload PERSISTIDO (o `activeOrg`
 * do Grant) para `ActiveOrgInfo`. Retorna null quando a forma não bate — nunca
 * confiamos num objeto só porque ele veio do banco.
 */
export function normalizeActiveOrg(value: unknown): ActiveOrgInfo | null {
  if (!value || typeof value !== 'object') return null;
  const { orgId, orgSlug, orgRole } = value as Record<string, unknown>;
  if (
    typeof orgId !== 'string' ||
    !orgId ||
    typeof orgSlug !== 'string' ||
    !orgSlug ||
    typeof orgRole !== 'string' ||
    !orgRole
  ) {
    return null;
  }
  return { orgId, orgSlug, orgRole };
}

/**
 * Lê a org ativa de um contexto de interaction do HOST (o `HttpContext` do
 * AdonisJS usado pelas `InteractionActions`).
 *
 * No consent a request É do browser, então o cookie está presente — ao contrário
 * do mint do id_token no `/token` (server-a-servidor, sem cookies). O cookie é
 * gravado UNSIGNED por `account_orgs_controller.activate` e lido aqui via
 * `request.cookie` (o MESMO caminho das leituras do console/account API), com
 * fallback para o caminho Koa caso o contexto recebido seja um ctx Koa.
 */
export function readActiveOrgFromHostCtx(ctx: unknown): ActiveOrgInfo | null {
  try {
    const raw = (ctx as any)?.request?.cookie?.(ACTIVE_ORG_COOKIE);
    const parsed = parseActiveOrgCookieValue(raw);
    if (parsed) return parsed;
  } catch {
    // contexto sem `request.cookie` — tenta o caminho Koa abaixo
  }
  return readActiveOrgFromKoaCtx(ctx);
}
