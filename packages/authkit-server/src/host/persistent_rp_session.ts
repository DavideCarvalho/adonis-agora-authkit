import type { HttpContext } from '@adonisjs/core/http';
import type { OidcService } from '../provider/oidc_service.js';
import { ACCOUNT_IDP_SESSION_KEY, readIdpSession } from './idp_session_bridge.js';
import { impersonationState } from './impersonation_session.js';
import { assertAccountEnabled } from './login_attempt.js';
export interface PersistentRpOptions {
  acceptIdpSession?: boolean | ((ctx: HttpContext) => boolean);
}

/**
 * How long (seconds) a renewal stays good enough: a linked RP whose IdP session was
 * renewed less than this ago, with the current TTL, is not renewed again. Without
 * it every authenticated request wrote the IdP session row and re-sent its cookie.
 */
const RENEW_RESOLUTION_SEC = 60;

/**
 * The linked RP's IdP session already expires between `ttl - RENEW_RESOLUTION_SEC`
 * and `ttl` from now, i.e. it was renewed with this TTL moments ago. Renewing again
 * would only move the expiry by those few seconds. A session that expires LATER
 * than `now + ttl` (the TTL was lowered) is still renewed, which shortens it.
 * Restoration (no local login yet) always renews.
 */
function renewedRecently(
  idp: { uid: string; exp: number },
  ttl: number,
  current: unknown,
  linkedUid: unknown,
): boolean {
  if (!current || linkedUid !== idp.uid || typeof idp.exp !== 'number') return false;
  const remaining = idp.exp - Date.now() / 1000;
  return remaining <= ttl && remaining > ttl - RENEW_RESOLUTION_SEC;
}

/** Same-host RP restoration: the signed IdP cookie is the persistent credential. */
export async function ensureRpSession(ctx: HttpContext, sessionKey: string): Promise<void> {
  const service: OidcService = await ctx.containerResolver.make('authkit.server');
  // Provider interactions write to the raw Node response. Regenerating Adonis's
  // session there migrates its data after headers are sent, leaving the browser
  // with the old cookie and losing the pending RP state/PKCE verifier.
  const path = ctx.request.url?.().split('?', 1)[0] ?? '';
  const mount = service.mountPath || service.config.mountPath;
  if (
    path.startsWith('/auth/interaction/') ||
    (mount && mount !== '/' && (path === mount || path.startsWith(`${mount}/`))) ||
    ctx.route?.name === 'authkit.oidc.root' ||
    ctx.route?.name === 'authkit.oidc.wildcard'
  )
    return;

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
  if (adapter.renewSession && !renewedRecently(idp, ttl, current, linkedUid)) {
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
