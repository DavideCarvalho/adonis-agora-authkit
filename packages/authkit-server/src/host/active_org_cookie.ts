import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
 * Desfaz o envelope de cookie ASSINADO do AdonisJS: `s:<base64url>.<hmac>`.
 *
 * O host grava o cookie via `ctx.response.cookie`, e o AdonisJS assina com o
 * `MessageVerifier` (`@boringnode/encryption`): HMAC-SHA256 sobre o base64url do
 * payload, com a chave derivada de `sha256(appKey)`, e `purpose` = NOME do cookie.
 * O `message` do payload é o valor.
 *
 * Verificamos a assinatura — não basta decodificar. Este cookie decide a claim de
 * organização, então aceitar um valor não assinado deixaria qualquer usuário trocar
 * de tenant forjando o cookie. Sem `appKey` não há como verificar: devolve null.
 */
function unsignAdonisCookie(signedRaw: string, appKey: string, purpose: string): string | null {
  if (!signedRaw.startsWith('s:')) return null;
  const [encoded, hash] = signedRaw.slice(2).split('.');
  if (!encoded || !hash) return null;

  const key = createHash('sha256').update(appKey).digest();
  const expected = createHmac('sha256', key).update(encoded).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload?.purpose !== purpose) return null;
    return typeof payload.message === 'string' ? payload.message : null;
  } catch {
    return null;
  }
}

/**
 * Parseia um valor de cookie possivelmente URL-encoded.
 *
 * Aceita três formas, nesta ordem:
 * 1. **Assinado pelo Adonis** (`s:<b64>.<hmac>`), quando `appKey` é conhecida —
 *    verificado com `unsignAdonisCookie`. É a forma real quando o host grava via
 *    `ctx.response.cookie` num app com assinatura de cookie ligada.
 * 2. Valor cru (hosts que gravem sem encode e sem assinatura).
 */
function parseActiveOrgCookieValue(raw: unknown, appKey?: string): ActiveOrgInfo | null {
  if (typeof raw !== 'string' || !raw) return null;

  // O jar Koa devolve o valor COMO ESTÁ no header, sem URL-decode — e o browser
  // reenvia o cookie exatamente como o host o escreveu, isto é `s%3A<b64>.<hmac>`
  // quando ele é assinado. Normalizar ANTES de decidir o formato é obrigatório:
  // checar `startsWith('s:')` no valor cru nunca casaria.
  let value = raw;
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded) value = decoded;
  } catch {
    // não era URL-encoded; segue com o cru
  }

  if (value.startsWith('s:')) {
    if (!appKey) return null;
    const unsigned = unsignAdonisCookie(value, appKey, ACTIVE_ORG_COOKIE);
    return unsigned ? decodeActiveOrgCookie(unsigned) : null;
  }

  return decodeActiveOrgCookie(value);
}

/**
 * Lê a org ativa de um contexto Koa (oidc-provider).
 *
 * O cookie NÃO pode ser lido como "cru": num app Adonis com assinatura de cookie
 * ligada ele chega como `s:<b64>.<hmac>` e precisa ser verificado. Passamos
 * `appKey` e verificamos a assinatura — sem ela o valor é recusado.
 *
 * Por que existe: `loadExistingGrant` roda no authorize (request do browser, com o
 * cookie) e é quem reconcilia o Grant reaproveitado depois que o usuário troca de
 * organização. O consent também grava a org, mas ele só roda UMA vez por grant —
 * sem esta leitura, quem ativa a org depois do primeiro login nunca recebe a claim.
 *
 * NOTA: `ctx.cookies.get()` nunca lança — retorna null se ausente.
 */
export function readActiveOrgFromKoaCtx(
  koaCtx: any,
  opts?: { appKey?: string },
): ActiveOrgInfo | null {
  try {
    const raw = koaCtx?.cookies?.get?.(ACTIVE_ORG_COOKIE, { signed: false });
    return parseActiveOrgCookieValue(raw, opts?.appKey);
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
 * do mint do id_token no `/token` (server-a-servidor, sem cookies). Aqui o
 * `request.cookie` do AdonisJS já desassina o cookie (quando o host assina), então
 * o valor chega em texto; `appKey` cobre o fallback Koa, caso o ctx recebido seja
 * um ctx Koa e não o HttpContext.
 */
export function readActiveOrgFromHostCtx(
  ctx: unknown,
  opts?: { appKey?: string },
): ActiveOrgInfo | null {
  try {
    const raw = (ctx as any)?.request?.cookie?.(ACTIVE_ORG_COOKIE);
    const parsed = parseActiveOrgCookieValue(raw, opts?.appKey);
    if (parsed) return parsed;
  } catch {
    // contexto sem `request.cookie` — tenta o caminho Koa abaixo
  }
  return readActiveOrgFromKoaCtx(ctx, opts);
}
