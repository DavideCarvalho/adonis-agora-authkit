import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { KeystoreReadOnlyError } from '../../keys/keystore_read_only.js';
import { buildKeysStatus, keystoreReadOnlyBody, rotateNow } from '../key_rotation_actions.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { apiError } from './dto.js';

/**
 * Gestão da chave de assinatura managed via Admin REST API (Bearer).
 * Sob `/api/authkit/v1/keys`. Retorna 501 (`not_implemented`) quando o jwks não é
 * managed+store (sem keystore gerenciável). A rotação aplica ao vivo e audita
 * (`keys.rotated`) dentro de `svc.rotateKeys`.
 */
export default class ApiKeysController {
  /** GET /keys — status da chave de assinatura managed (idade + política + ETA). */
  async status(ctx: HttpContext) {
    const svc: any = await ctx.containerResolver.make('authkit.server');
    // RuntimeSettings é opcional (tabela auth_settings ausente → política default).
    const settings = await resolveRuntimeSettings(ctx);
    const status = await buildKeysStatus(svc, settings);
    if (!status) {
      return ctx.response
        .status(501)
        .send(apiError('not_implemented', 'jwks não é managed+store.'));
    }
    return status;
  }

  /** POST /keys/rotate — { retire?, keep? } → rotaciona agora. */
  async rotate(ctx: HttpContext) {
    const svc: any = await ctx.containerResolver.make('authkit.server');
    if (
      typeof svc.rotateKeys !== 'function' ||
      (await svc.keystoreAgeDays?.().catch(() => null)) === null
    ) {
      return ctx.response
        .status(501)
        .send(apiError('not_implemented', 'rotação indisponível (jwks não é managed+store).'));
    }
    if (svc.keystoreReadOnly === true) {
      return ctx.response.status(409).send(keystoreReadOnlyBody());
    }
    try {
      return await rotateNow(svc, ctx.request.body() as any);
    } catch (error) {
      if (error instanceof KeystoreReadOnlyError) {
        return ctx.response.status(409).send(keystoreReadOnlyBody(error.message));
      }
      throw error;
    }
  }
}
