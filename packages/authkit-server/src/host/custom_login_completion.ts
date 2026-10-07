import type { HttpContext } from '@adonisjs/core/http';
import type { CompleteLoginExtra } from '../provider/interaction_actions.js';
import type { OidcService } from '../provider/oidc_service.js';
import { AdminSessionsService } from './admin_sessions_service.js';
import { resolveRuntimeSettingsOrNoop } from './runtime_settings.js';
import { resolveEffectiveSessionPolicy } from './runtime_toggles.js';

/** Shared by direct custom completion and its TOTP/passkey continuation. */
export async function completeCustomLoginSession(
  ctx: HttpContext,
  accountId: string,
  extra: CompleteLoginExtra,
  rememberRequested = false,
): Promise<unknown> {
  const service: OidcService = await ctx.containerResolver.make('authkit.server');
  const settings = await resolveRuntimeSettingsOrNoop(ctx);
  const policy = await resolveEffectiveSessionPolicy(
    settings,
    service.config.ttl?.session ? Math.ceil(service.config.ttl.session / 3600) : undefined,
  );
  const sessions = policy.singleSession ? new AdminSessionsService(service) : undefined;
  const previous = sessions?.canList ? await sessions.listSessions(accountId) : [];
  const details = sessions?.canList ? await service.interactions.details(ctx) : undefined;
  const currentIdpSession = details?.session?.uid
    ? await service.provider.Session.findByUid(details.session.uid)
    : undefined;
  const result = await service.interactions.completeLogin(ctx, accountId, {
    ...extra,
    remember: policy.rememberEnabled && rememberRequested,
  });
  const denied =
    result !== null && typeof result === 'object' && 'ok' in result && result.ok === false;
  if (!denied && sessions?.canList && previous.length) {
    const previousIds = new Set(previous.map((session) => session.id));
    const current = await sessions.listSessions(accountId);
    const created = current.find((session) => !previousIds.has(session.id));
    const revoked = await sessions.revokeAllExcept(
      accountId,
      created?.id ?? currentIdpSession?.id ?? '__none__',
    );
    await service.config.audit?.record({
      type: 'session.single_enforced',
      accountId,
      ip: ctx.request.ip(),
      metadata: { revokedCount: revoked.sessions },
    });
  }
  return result;
}
