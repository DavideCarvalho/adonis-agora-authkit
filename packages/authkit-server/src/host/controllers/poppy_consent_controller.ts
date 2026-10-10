import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { personalAgentsFor } from '../../agents/runtime.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { impersonationState } from '../impersonation_session.js';
import { redirectExact } from '../redirect_exact.js';

/** A tela nunca pode ser emoldurada (clickjacking — ver `agent_consent_controller.ts`). */
function denyFraming(ctx: HttpContext): void {
  ctx.response.header('X-Frame-Options', 'DENY');
  ctx.response.header('Content-Security-Policy', "frame-ancestors 'none'");
}

function chosenScopes(ctx: HttpContext): string[] {
  const raw = ctx.request.input('scope');
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
}

/**
 * Telas do usuário no Poppy: o consentimento do Direct Sign-In (o
 * `authorization_endpoint`, §4.5) e a do Device Sign-In (o `verification_uri`,
 * §4.6). Montadas atrás do `accountGuard`: sem sessão, o usuário passa pelo login
 * DESTE app e volta. Abrir o link nunca aprova sozinho — a aprovação é um POST
 * com CSRF. Recusadas durante impersonation.
 */
export default class PoppyConsentController {
  /** GET {prefix}/oauth/authorize */
  async authorize(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    const poppy = runtime?.poppy;
    if (!poppy?.cfg.signIn.direct) return ctx.response.notFound();
    denyFraming(ctx);
    const service = await ctx.containerResolver.make('authkit.server');
    const render = service.config.render!;
    if (impersonationState(ctx).active) {
      return render(ctx, 'agents/consent', {
        csrfToken: ctx.request.csrfToken,
        action: poppy.urls.authorization,
        request: null,
        account: null,
        error: 'agents.consent.impersonating',
      });
    }
    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const outcome = await poppy.startAuthorization(ctx.request.qs(), accountId);
    if (outcome.kind === 'redirect') return redirectExact(ctx.response, outcome.url);
    if (outcome.kind === 'error') {
      ctx.response.status(400);
      return render(ctx, 'agents/done', { status: 'invalid', agentName: null, scopes: [] });
    }
    const account = await service.config.accountStore.findById(accountId);
    return render(ctx, 'agents/consent', {
      csrfToken: ctx.request.csrfToken,
      action: poppy.urls.authorization,
      request: {
        agentName: outcome.request.agentName,
        agentOrigin: outcome.request.agentOrigin,
        logoUri: outcome.request.logoUri,
        scopes: outcome.request.scopes,
        hidden: [{ name: 'request_id', value: outcome.request.id }],
      },
      account: { email: account?.email ?? null },
      error: null,
    });
  }

  /** POST {prefix}/oauth/authorize — `request_id`, `decision=allow|deny`, `scope[]`. */
  async decideAuthorization(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    const poppy = runtime?.poppy;
    if (!poppy?.cfg.signIn.direct) return ctx.response.notFound();
    denyFraming(ctx);
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    if (impersonationState(ctx).active) {
      return render(ctx, 'agents/done', { status: 'expired', agentName: null, scopes: [] });
    }
    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const decided = await poppy.decideAuthorization({
      requestId: String(ctx.request.input('request_id') ?? ''),
      accountId,
      allow: ctx.request.input('decision') === 'allow',
      scopes: chosenScopes(ctx),
    });
    if (!decided) {
      return render(ctx, 'agents/done', { status: 'expired', agentName: null, scopes: [] });
    }
    await cfg.audit?.record({
      type: decided.approved ? 'agent.delegation_approved' : 'agent.delegation_denied',
      accountId,
      clientId: decided.clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { protocol: 'poppy', signIn: 'direct', scopes: decided.approved ?? [] },
    });
    return redirectExact(ctx.response, decided.url);
  }

  /** GET {prefix}/device?user_code=XXXX-XXXX */
  async device(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    const poppy = runtime?.poppy;
    if (!poppy?.cfg.signIn.device) return ctx.response.notFound();
    denyFraming(ctx);
    const service = await ctx.containerResolver.make('authkit.server');
    const render = service.config.render!;
    const base = {
      csrfToken: ctx.request.csrfToken,
      action: poppy.urls.device,
      request: null,
      account: null,
      error: null,
    };
    if (impersonationState(ctx).active) {
      return render(ctx, 'agents/consent', { ...base, error: 'agents.consent.impersonating' });
    }
    const input: unknown = ctx.request.input('user_code');
    if (!input) return render(ctx, 'agents/consent', base);
    const pending = await poppy.pendingDevice(input);
    if (!pending) {
      return render(ctx, 'agents/consent', { ...base, error: 'agents.consent.invalid_code' });
    }
    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const account = await service.config.accountStore.findById(accountId);
    return render(ctx, 'agents/consent', {
      ...base,
      request: {
        userCode: pending.userCode,
        agentName: pending.agentName,
        agentOrigin: pending.agentOrigin,
        scopes: pending.scopes,
      },
      account: { email: account?.email ?? null },
    });
  }

  /** POST {prefix}/device — `user_code`, `decision`, `scope[]`. */
  async decideDevice(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    const poppy = runtime?.poppy;
    if (!poppy?.cfg.signIn.device) return ctx.response.notFound();
    denyFraming(ctx);
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    if (impersonationState(ctx).active) {
      return render(ctx, 'agents/done', { status: 'expired', agentName: null, scopes: [] });
    }
    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const userCode = String(ctx.request.input('user_code') ?? '');
    const pending = await poppy.pendingDevice(userCode);
    const decided = await poppy.decideDevice({
      userCode,
      accountId,
      allow: ctx.request.input('decision') === 'allow',
      scopes: chosenScopes(ctx),
    });
    if (!decided || !pending) {
      return render(ctx, 'agents/done', { status: 'expired', agentName: null, scopes: [] });
    }
    await cfg.audit?.record({
      type: decided.approved ? 'agent.delegation_approved' : 'agent.delegation_denied',
      accountId,
      clientId: decided.clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { protocol: 'poppy', signIn: 'device', scopes: decided.approved ?? [] },
    });
    return render(ctx, 'agents/done', {
      status: decided.approved ? 'approved' : 'denied',
      agentName: pending.agentName,
      scopes: decided.approved ? poppy.describe(decided.approved) : [],
    });
  }
}
