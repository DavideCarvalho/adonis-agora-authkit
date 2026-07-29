import type { HttpContext } from '@adonisjs/core/http';
import type { Authenticator } from '../authenticator.js';

/**
 * Resolve (uma vez por request) o {@link Authenticator} do authkit e o memoiza
 * em `ctx.authkit`.
 *
 * É o ÚNICO caminho de resolução de sessão da lib: passa pelo
 * `AuthkitClientManager`, então o refresh proativo do token (`maybeRefresh`), o
 * `SessionResolver` configurado, as métricas e a ponte do `@agora/context`
 * continuam valendo — tanto para quem usa `authkit_middleware` (legado) quanto
 * para quem usa o `authkitClientGuard` de `@adonisjs/auth`.
 *
 * Memoiza em `ctx.authkit` de propósito: quando o host registra o
 * `authkit_context_middleware` E o guard, os dois compartilham a MESMA
 * instância, e a sessão é resolvida (e o token renovado) uma vez só.
 */
export async function getAuthkit(ctx: HttpContext): Promise<Authenticator> {
  const existing = (ctx as unknown as { authkit?: Authenticator }).authkit;
  if (existing) return existing;

  const manager = await ctx.containerResolver.make('authkit.client');
  await manager.maybeRefresh(ctx);
  const authenticator = await manager.createAuthenticator(ctx);
  (ctx as unknown as { authkit?: Authenticator }).authkit = authenticator;
  return authenticator;
}

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /**
     * Superfície específica do authkit (`getIdentity`, `hasGlobalRole`, a
     * `Identity` crua). Populada pelo `authkit_context_middleware` e, no
     * caminho do guard, pelo próprio `authkitClientGuard` ao autenticar.
     *
     * Existe para que o `@adonisjs/auth` possa ser o dono de `ctx.auth` sem que
     * o host perca o que só o authkit sabe. Quem NÃO usa o guard continua com o
     * `Authenticator` do authkit direto em `ctx.auth` (ver `types.ts`).
     */
    authkit: Authenticator;
  }
}
