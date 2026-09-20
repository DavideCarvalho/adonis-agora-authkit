/**
 * Ponte SSO: sessão do IdP → sessão do console de conta (`/account/*`, `/admin/*`).
 *
 * POR QUE EXISTE. São duas sessões diferentes no mesmo host:
 *
 *   - a sessão do IdP (oidc-provider): cookie `_session`, criada quando o
 *     usuário completa a interaction de login do `/oidc/auth` (senha, magic
 *     link, OTP, passkey, social). É ela que dá o SSO entre os clients OIDC;
 *   - a sessão do console: a chave `ACCOUNT_SESSION_KEY` na sessão do Adonis,
 *     criada SÓ pelo login do próprio console (`POST /account/login`).
 *
 * O login do IdP nunca escrevia a segunda, então um usuário que acabou de
 * entrar num app OIDC (inclusive o próprio host, quando ele é IdP e RP ao mesmo
 * tempo) e abria `/account/*` levava um SEGUNDO pedido de login.
 *
 * Com `accountSession.acceptIdpSession: true`, os guards do console aceitam a
 * sessão ATIVA do IdP: sem sessão de console, mas com uma sessão do IdP válida
 * (cookie assinado + registro no adapter, não expirado) de uma conta existente
 * e habilitada, o console é aberto para essa conta. A ponte fica AMARRADA à
 * sessão do IdP que a originou (o `uid` dela vai na sessão do Adonis): quando a
 * sessão do IdP acaba (logout OIDC, expiração, troca de conta), o console
 * derivado dela acaba junto no próximo request.
 *
 * Default `false`: quem não liga continua exatamente como antes.
 */
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from './account_session_key.js';
import { syncAdonisAuthLogin } from './adonis_auth_sync.js';
import { impersonationState } from './impersonation_session.js';
import { assertAccountEnabled } from './login_attempt.js';

/** Chave da sessão Adonis com o `uid` da sessão do IdP que originou o console. */
export const ACCOUNT_IDP_SESSION_KEY = 'authkit_idp_session_uid';

/** O que interessa de uma sessão do oidc-provider (instância do model `Session`). */
interface IdpSession {
  uid: string;
  accountId?: string;
  destroy(): Promise<void>;
}

/**
 * Lê a sessão do IdP a partir do cookie do request (mesma leitura que o
 * provider faz: cookie `_session` assinado com as keys do provider, e o registro
 * no adapter, que já descarta expirados). `null` sem sessão logada.
 */
export async function readIdpSession(ctx: HttpContext, service: any): Promise<IdpSession | null> {
  const provider = service?.provider;
  if (!provider?.Session || typeof provider.createContext !== 'function') return null;
  try {
    const kctx = provider.createContext(ctx.request.request, ctx.response.response);
    const id = kctx.cookies.get(provider.cookieName('session'));
    if (!id) return null;
    const session = (await provider.Session.find(id)) as IdpSession | undefined;
    return session?.accountId ? session : null;
  } catch {
    // Fail-safe: sem ponte (o guard segue para o login normal).
    return null;
  }
}

function acceptsIdpSession(service: any): boolean {
  return service?.config?.accountSession?.acceptIdpSession === true;
}

/** Id do humano por trás da sessão do console (impersonation → o admin real). */
function realConsoleAccount(ctx: HttpContext, current: string): string {
  try {
    return impersonationState(ctx).impersonatorId ?? current;
  } catch {
    return current;
  }
}

/**
 * Garante a sessão do console, aceitando a sessão do IdP quando configurado.
 * Devolve `true` quando o request tem (ou passou a ter) sessão de console.
 *
 * Sem `accountSession.acceptIdpSession`, é só "existe `ACCOUNT_SESSION_KEY`?" —
 * o comportamento de sempre, sem tocar no provider.
 */
export async function ensureConsoleSession(ctx: HttpContext): Promise<boolean> {
  const current = ctx.session?.get(ACCOUNT_SESSION_KEY) as string | undefined;
  const service = await (ctx as any).containerResolver?.make('authkit.server').catch(() => null);
  if (!acceptsIdpSession(service)) return Boolean(current);

  const bridgedUid = ctx.session?.get(ACCOUNT_IDP_SESSION_KEY) as string | undefined;
  // Login próprio do console (não veio da ponte): intocado.
  if (current && !bridgedUid) return true;

  const idp = await readIdpSession(ctx, service);

  if (current && bridgedUid) {
    if (idp && idp.uid === bridgedUid && idp.accountId === realConsoleAccount(ctx, current)) {
      return true;
    }
    // A sessão do IdP que originou o console acabou (ou virou outra conta):
    // encerra o console derivado dela. Se houver outra sessão do IdP viva, a
    // ponte abaixo reabre para a conta dela.
    ctx.session.forget(ACCOUNT_SESSION_KEY);
    ctx.session.forget(ACCOUNT_IDP_SESSION_KEY);
  }

  if (!idp?.accountId) return false;

  const cfg = service.config;
  const account = await cfg.accountStore.findById(idp.accountId);
  if (!account) return false;
  const gate = await assertAccountEnabled(cfg, account.id, {
    email: account.email ?? '',
    ip: ctx.request.ip?.() ?? null,
  });
  if (!gate.allowed) return false;

  // Elevação anônimo → autenticado: troca o id da sessão (anti-fixation), como
  // o login do console faz.
  await ctx.session.regenerate();
  ctx.session.put(ACCOUNT_SESSION_KEY, account.id);
  ctx.session.put(ACCOUNT_IDP_SESSION_KEY, idp.uid);
  await syncAdonisAuthLogin(ctx, cfg, account);
  return true;
}

/**
 * Logout do console de uma sessão que veio da ponte: encerra também a sessão
 * do IdP que a originou — senão o próximo request reabriria o console pela
 * própria ponte e o "Sair" não teria efeito. No-op fora da ponte.
 */
export async function endBridgedIdpSession(ctx: HttpContext): Promise<void> {
  const bridgedUid = ctx.session?.get(ACCOUNT_IDP_SESSION_KEY) as string | undefined;
  if (!bridgedUid) return;
  ctx.session.forget(ACCOUNT_IDP_SESSION_KEY);
  const service = await (ctx as any).containerResolver?.make('authkit.server').catch(() => null);
  const idp = await readIdpSession(ctx, service);
  if (idp && idp.uid === bridgedUid) {
    try {
      await idp.destroy();
    } catch {
      // best-effort
    }
  }
}
