import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { displayNameFor } from '../../agents/agent_identity.js';
import type { PersonalAgentsRuntime } from '../../agents/runtime.js';
import { personalAgentsFor } from '../../agents/runtime.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { impersonationState } from '../impersonation_session.js';

async function agentName(runtime: PersonalAgentsRuntime, issuer: string): Promise<string> {
  const registration = await runtime.config.resolveAgent(issuer);
  return displayNameFor(registration ?? { issuer, jwksUri: '' });
}

/** Host do issuer para exibição — um resolver do host pode devolver issuer que não é URL. */
function originOf(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
}

/**
 * Anti-clickjacking: o atacante pega um código na própria sessão de agente e
 * emoldura o link já preenchido — um clique em "Permitir" entregaria a conta.
 * A tela nunca pode ser renderizada num frame, com ou sem o shield do host.
 */
function denyFraming(ctx: HttpContext): void {
  ctx.response.header('X-Frame-Options', 'DENY');
  ctx.response.header('Content-Security-Policy', "frame-ancestors 'none'");
}

/**
 * Tela de consentimento da delegação (PACT §5.3) — o `verification_uri` do
 * device flow. Montada atrás do `accountGuard`: sem sessão o usuário passa pelo
 * login DESTE app e volta com o `user_code` no `return_to`. O agente nunca vê
 * esse login.
 *
 * Durante uma impersonation a tela recusa: um admin personificando alguém não
 * pode entregar a conta dessa pessoa a um agente.
 */
export default class AgentConsentController {
  /** GET {prefix}/consent?user_code=XXXX-XXXX */
  async show(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    if (!runtime?.delegation) return ctx.response.notFound();
    denyFraming(ctx);
    const service = await ctx.containerResolver.make('authkit.server');
    const render = service.config.render!;
    const base = {
      csrfToken: ctx.request.csrfToken,
      action: runtime.urls.consent,
      request: null,
      account: null,
      error: null,
    };

    if (impersonationState(ctx).active) {
      return render(ctx, 'agents/consent', { ...base, error: 'agents.consent.impersonating' });
    }

    const input: unknown = ctx.request.input('user_code');
    if (!input) return render(ctx, 'agents/consent', base);

    const pending = await runtime.delegation.pendingRequest(input);
    if (!pending) {
      return render(ctx, 'agents/consent', { ...base, error: 'agents.consent.invalid_code' });
    }

    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const account = await service.config.accountStore.findById(accountId);
    return render(ctx, 'agents/consent', {
      ...base,
      request: {
        userCode: pending.userCode,
        agentName: await agentName(runtime, pending.clientId),
        agentOrigin: originOf(pending.clientId),
        scopes: pending.scopes,
      },
      account: { email: account?.email ?? null },
    });
  }

  /** POST {prefix}/consent — `decision=allow|deny`, `scope[]` marcados. */
  async decide(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    if (!runtime?.delegation) return ctx.response.notFound();
    denyFraming(ctx);
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    if (impersonationState(ctx).active) {
      return render(ctx, 'agents/consent', {
        csrfToken: ctx.request.csrfToken,
        action: runtime.urls.consent,
        request: null,
        account: null,
        error: 'agents.consent.impersonating',
      });
    }

    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const rawCode: unknown = ctx.request.input('user_code');
    const userCode = typeof rawCode === 'string' ? rawCode : '';
    const pending = await runtime.delegation.pendingRequest(userCode);
    if (!pending) {
      return render(ctx, 'agents/done', { status: 'expired', agentName: null, scopes: [] });
    }
    const name = await agentName(runtime, pending.clientId);
    const raw = ctx.request.input('scope');
    const chosen = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);

    const approved =
      ctx.request.input('decision') === 'allow'
        ? await runtime.delegation.approve({ userCode, accountId, scopes: chosen })
        : null;

    if (!approved) {
      // Negou ou desmarcou tudo. Se nem negar deu, o pedido mudou de estado no
      // meio do caminho (aprovado em outra aba, expirou).
      if (!(await runtime.delegation.deny({ userCode, accountId }))) {
        return render(ctx, 'agents/done', { status: 'expired', agentName: name, scopes: [] });
      }
      await cfg.audit?.record({
        type: 'agent.delegation_denied',
        accountId,
        clientId: pending.clientId,
        ip: ctx.request.ip?.() ?? null,
        metadata: { requested: pending.scopes.map((s) => s.id) },
      });
      return render(ctx, 'agents/done', { status: 'denied', agentName: name, scopes: [] });
    }

    await cfg.audit?.record({
      type: 'agent.delegation_approved',
      accountId,
      clientId: pending.clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { grantId: approved.grantId, scopes: approved.scopes },
    });
    return render(ctx, 'agents/done', {
      status: 'approved',
      agentName: name,
      scopes: approved.scopes.map((id) => ({
        id,
        description: runtime.delegation!.scopes[id] ?? id,
      })),
    });
  }
}
