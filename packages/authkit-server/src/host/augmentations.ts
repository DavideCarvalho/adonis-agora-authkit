/**
 * Carrega as augmentations de tipo do AdonisJS usadas pelos controllers do host-kit.
 *
 * Estes pacotes adicionam propriedades ao `HttpContext`/`HttpRequest` do core via
 * `declare module '@adonisjs/core/http'`, mas a augmentation só é carregada quando
 * o módulo que a declara é referenciado na compilação. Usamos `import type {} from`
 * para carregar APENAS os tipos/augmentations dos subpaths que as declaram — assim
 * `ctx.session`, `ctx.request.csrfToken` e `ctx.ally` ficam tipados sem casts, e a
 * importação é COMPLETAMENTE apagada no build (zero efeito em runtime).
 *
 * Importante: precisa ser `import type {}` (não `import 'specifier'`). Um import de
 * side-effect comum permaneceria no JS emitido e quebraria o boot de hosts sem o
 * peer opcional `@adonisjs/ally` (social login) com ERR_MODULE_NOT_FOUND.
 *
 * - `@adonisjs/session/session_middleware`         → `HttpContext.session`
 * - `@adonisjs/shield/shield_middleware`            → `HttpRequest.csrfToken`
 * - `@adonisjs/ally/ally_provider`                  → `HttpContext.ally` (peer opcional)
 * - `@adonisjs/core/providers/vinejs_provider`      → `HttpRequest.validateUsing`
 * - `@adonisjs/auth/initialize_auth_middleware`     → `HttpContext.auth` (peer opcional)
 */

import type {} from '@adonisjs/ally/ally_provider';
import type {} from '@adonisjs/auth/initialize_auth_middleware';
import type {} from '@adonisjs/core/providers/vinejs_provider';
import type {} from '@adonisjs/session/session_middleware';
import type {} from '@adonisjs/shield/shield_middleware';

/**
 * Identificador NÃO-SENSÍVEL da API key admin que autenticou a request (R6),
 * anexado pelo `adminApiGuard`. Usado pela trilha de auditoria REST para saber
 * QUAL key agiu sem vazar o segredo (ex.: `admin-key:<8 hex>`). Ausente fora do
 * grupo admin-api.
 */
declare module '@adonisjs/core/http' {
  interface HttpContext {
    adminApiKeyId?: string;
  }
}
