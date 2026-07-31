import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';

/**
 * Aplica revogações de OIDC Back-Channel Logout sobre sessões COOKIE-BASED.
 *
 * Sem store server-side não dá pra destruir a sessão no instante do logout_token;
 * este middleware roda em toda request COM token set na sessão, extrai sid/sub/iat
 * do id_token e, se a sessão foi revogada (via {@link RevocationStore}), limpa o
 * token set local — o resolver downstream trata como não-autenticado.
 *
 * No-op quando `backchannelLogout.store` não está configurado em `config/authkit_client.ts`.
 *
 * Ordem no kernel: DEPOIS do `authkit_middleware` (depende do `authkit.client`
 * resolvido), antes dos named middlewares de auth.
 */
export default class BackchannelRevocationMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const manager = await ctx.containerResolver.make('authkit.client');
    const store = manager.clientConfig.backchannelStore;
    if (!store) return next();

    const idToken = manager.getIdToken(ctx);

    if (idToken) {
      const claims = decodeJwtPayload(idToken);
      const sid = typeof claims?.sid === 'string' ? claims.sid : undefined;
      const sub = typeof claims?.sub === 'string' ? claims.sub : undefined;
      const authTime = typeof claims?.iat === 'number' ? claims.iat : undefined;

      if ((sid || sub) && (await store.isRevoked({ sid, sub, authTime }))) {
        // endSession, não `forget(sessionKey)`: uma revogação central não pode deixar
        // a credencial de impersonação (refresh token do ATOR) parqueada no browser.
        manager.endSession(ctx);
      }
    }

    return next();
  }
}

/**
 * Decodifica o payload de um JWT SEM verificar assinatura — seguro aqui porque o
 * id_token foi validado no login e vive numa sessão assinada/encriptada pelo app.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
