/**
 * Abrir e fechar a sessão de CONTA do authkit (o cookie do console, `ACCOUNT_SESSION_KEY`) a partir
 * de código de fora do host-kit — o navegador de um personal agent que entrou na conta, por
 * exemplo. Sincroniza `ctx.auth` (`adonisAuth.guard`) como o login do próprio console.
 *
 * Estável no 1.x (usado pelas `personalAgents.extensions`).
 */
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from './account_session_key.js';
import { syncAdonisAuthLogin, syncAdonisAuthLogout } from './adonis_auth_sync.js';

/** Liga a sessão de conta a `accountId` e sincroniza `ctx.auth`. Não regenera a sessão. */
export async function signInAccountSession(ctx: HttpContext, accountId: string): Promise<void> {
  // Sem augmentation no barrel (ver `augmentation_isolation.spec.ts`): a sessão é lida sem tipo.
  const session = (ctx as HttpContext & { session: any }).session;
  const service = await ctx.containerResolver.make('authkit.server');
  session.put(ACCOUNT_SESSION_KEY, accountId);
  const account = await service.config.accountStore.findById(accountId);
  if (account) await syncAdonisAuthLogin(ctx, service.config, account);
}

/** Desliga a sessão de conta e sincroniza `ctx.auth`. Não regenera a sessão. */
export async function signOutAccountSession(ctx: HttpContext): Promise<void> {
  const session = (ctx as HttpContext & { session: any }).session;
  const service = await ctx.containerResolver.make('authkit.server');
  session.forget(ACCOUNT_SESSION_KEY);
  await syncAdonisAuthLogout(ctx, service.config);
}
