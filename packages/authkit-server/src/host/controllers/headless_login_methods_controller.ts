import type { HttpContext } from '@adonisjs/core/http';
import { supportsLoginMethodsPreference } from '../../accounts/account_store.js';
import type { ResolvedServerConfig } from '../../define_config.js';
import { loginMethodsStateForAccount, resolveGlobalAuthMethods } from '../login_methods_state.js';
import { resolveRuntimeSettingsOrNoop } from '../runtime_settings.js';
import { parseUserLoginMethodsPayload } from '../user_login_methods.js';

/** Erro JSON padrão. */
function apiErr(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * API headless do AuthKit (Clerk-style).
 *
 * Diferente da JSON API do console (`/account/api/*`, guardada pela sessão de
 * CONTA), esta API é protegida por um resolver de conta fornecido pelo HOST
 * (`headless.resolveAccountId`) — tipicamente a própria sessão do app
 * (`await ctx.auth.getUserOrFail()`). Assim um RP integrado usa o app como
 * frontend sem expor o console `/account/*`.
 */
export default class HeadlessLoginMethodsController {
  /**
   * GET {baseUrl}/login-methods
   * Estado final de tipos de login para a conta resolvida pelo host.
   */
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg: ResolvedServerConfig = service.config;

    const accountId = await this.#resolveAccount(ctx, cfg);
    if (!accountId) {
      return ctx.response.unauthorized(apiErr('unauthorized', 'Not authenticated.'));
    }

    const settings = await resolveRuntimeSettingsOrNoop(ctx);
    return loginMethodsStateForAccount(accountId, cfg.accountStore, settings, cfg);
  }

  /**
   * PUT {baseUrl}/login-methods
   * Grava a preferência de tipos de login para a conta resolvida pelo host.
   */
  async update(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg: ResolvedServerConfig = service.config;

    const accountId = await this.#resolveAccount(ctx, cfg);
    if (!accountId) {
      return ctx.response.unauthorized(apiErr('unauthorized', 'Not authenticated.'));
    }

    if (!supportsLoginMethodsPreference(cfg.accountStore)) {
      return ctx.response.notFound(
        apiErr('not_supported', 'Login methods preference not supported.'),
      );
    }

    const parsed = parseUserLoginMethodsPayload(ctx.request.body());
    if (!parsed.ok) {
      return ctx.response.badRequest(apiErr(parsed.error, 'Invalid login methods payload.'));
    }

    // All-off guard: preferência não pode zerar todos os métodos globais.
    const settings = await resolveRuntimeSettingsOrNoop(ctx);
    const { resolved: global } = await resolveGlobalAuthMethods(settings, cfg);
    const value = { ...parsed.value };
    const wouldBeAllOff =
      (value.password === false || !global.password) &&
      (value.magicLink === false || !global.magicLink) &&
      (value.passkey === false || !global.passkey) &&
      (value.social === false || global.social.length === 0);
    if (wouldBeAllOff) {
      return ctx.response.badRequest(
        apiErr('all_methods_off', 'Cannot disable every login method.'),
      );
    }

    await cfg.accountStore.setLoginMethods(accountId, Object.keys(value).length > 0 ? value : null);
    return { ok: true, methods: value };
  }

  /** Delega ao resolver do host; null (ou throw de auth) => 401. */
  async #resolveAccount(ctx: HttpContext, cfg: ResolvedServerConfig) {
    const resolve = cfg.headless?.resolveAccountId;
    if (!resolve) return null;
    try {
      const id = await resolve(ctx);
      return id ? String(id) : null;
    } catch {
      // Resolver do host lançou (ex.: auth.getUserOrFail sem sessão) → não-autorizado.
      return null;
    }
  }
}
