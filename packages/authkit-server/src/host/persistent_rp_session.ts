import type { HttpContext } from '@adonisjs/core/http';
import type { OidcService } from '../provider/oidc_service.js';
import { ACCOUNT_IDP_SESSION_KEY, readIdpSession } from './idp_session_bridge.js';
import { impersonationState } from './impersonation_session.js';
import { assertAccountEnabled } from './login_attempt.js';
export interface PersistentRpOptions {
  acceptIdpSession?: boolean | ((ctx: HttpContext) => boolean);
}

/** Same-host RP restoration: the signed IdP cookie is the persistent credential. */
export async function ensureRpSession(ctx: HttpContext, sessionKey: string): Promise<void> {
  const service: OidcService = await ctx.containerResolver.make('authkit.server');
  const current = ctx.session.get(sessionKey);
  const linkedUid = ctx.session.get(ACCOUNT_IDP_SESSION_KEY);
  const idp = await readIdpSession(ctx, service, true);
  const realId = current ? (impersonationState(ctx).impersonatorId ?? current) : undefined;
  if (current && linkedUid && (!idp || idp.uid !== linkedUid || idp.accountId !== realId)) {
    ctx.session.clear();
    return;
  }
  // An existing local login cannot silently become a different IdP account.
  if (current && (!idp || idp.accountId !== realId || idp.transient)) return;
  if (!idp?.accountId || idp.transient) return;
  const account = await service.config.accountStore.findById(idp.accountId);
  if (
    !account ||
    !(
      await assertAccountEnabled(service.config, account.id, {
        email: account.email ?? '',
        ip: ctx.request.ip(),
      })
    ).allowed
  ) {
    if (current) ctx.session.clear();
    return;
  }
  const adapter = service.provider.Session.adapter;
  const ttl = service.sessionTtlHolder.rememberSec;
  if (adapter.renewSession) {
    if (!(await adapter.renewSession(idp.id, ttl))) {
      if (linkedUid) ctx.session.clear();
      return;
    }
    const kctx = service.provider.createContext(ctx.request.request, ctx.response.response);
    kctx.cookies.set(service.provider.cookieName('session'), idp.id, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: kctx.secure,
      maxAge: ttl * 1000,
      overwrite: true,
    });
  }
  // Custom adapters without atomic renewal restore until the existing IdP expiry.
  if (!current) {
    await ctx.session.regenerate();
    ctx.session.put(sessionKey, account.id);
  }
  ctx.session.put(ACCOUNT_IDP_SESSION_KEY, idp.uid);
}
/** Logout must revoke the credential that could otherwise restore the RP. */
export async function endRpSession(ctx: HttpContext): Promise<void> {
  const service: OidcService = await ctx.containerResolver.make('authkit.server');
  const idp = await readIdpSession(ctx, service, true);
  // The browser's signed IdP credential must be revoked even after its RP expired.
  if (idp) await idp.destroy();
  ctx.session.forget(ACCOUNT_IDP_SESSION_KEY);
}
