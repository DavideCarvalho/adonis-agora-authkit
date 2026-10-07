import type { HttpContext } from '@adonisjs/core/http';
import type { PersonalAgentIdentity } from './agent_identity.js';
import type { DelegationContext } from './delegation_service.js';
import type { PersonalAgentProtocol } from './protocol.js';
import { type PersonalAgentsRuntime, personalAgentsFor } from './runtime.js';

/** 401 sem corpo, só o challenge do protocolo (PACT §3.4/§5.5). */
export function personalAgentUnauthorized(
  ctx: HttpContext,
  protocol: PersonalAgentProtocol,
  error?: 'invalid_token',
) {
  ctx.response.header('WWW-Authenticate', protocol.challenge(error));
  return ctx.response.status(401).send('');
}

/** O que o middleware anexa à request. */
export interface PersonalAgentRequestContext extends PersonalAgentIdentity {
  /** Delegação válida enviada junto, ou `null` (o agente fala só com identidade). */
  delegation: DelegationContext | null;
}

/**
 * Guardado fora do `HttpContext` de propósito: uma augmentation alcançável
 * pelo barrel vazaria para os tipos de todo host (ver
 * `augmentation_isolation.spec.ts`).
 */
const requestContexts = new WeakMap<HttpContext, PersonalAgentRequestContext>();

/**
 * O agente que chamou e a delegação dele — preenchido por
 * {@link personalAgentAuth}. `null` numa rota sem o middleware.
 */
export function personalAgentOf(ctx: HttpContext): PersonalAgentRequestContext | null {
  return requestContexts.get(ctx) ?? null;
}

export interface PersonalAgentAuthOptions {
  /**
   * - `'optional'` (default): valida a delegação SE vier; sem ela, segue só
   *   com identidade. É o que o PACT pede no endpoint do agente — falta de
   *   scope vira step-up, não erro.
   * - `'required'`: sem delegação válida, 401 `invalid_token` (APIs que só
   *   fazem sentido agindo na conta).
   */
  delegation?: 'optional' | 'required';
}

async function requireRuntime(ctx: HttpContext, helper: string): Promise<PersonalAgentsRuntime> {
  const runtime = await personalAgentsFor(ctx);
  if (!runtime) throw new Error(`authkit: ${helper} exige \`personalAgents\` no config.`);
  return runtime;
}

/**
 * Middleware das rotas que os personal agents chamam (o endpoint de agente do
 * app, ou uma API exposta a eles). Verifica o JWT do agente e, se vier, o token
 * de delegação no header do protocolo — falhas respondem 401 sem corpo. Em
 * sucesso, {@link personalAgentOf} devolve o agente e a delegação.
 *
 * ```ts
 * import { personalAgentAuth } from '@adonis-agora/authkit-server'
 * router.post('/a2a/message:send', [A2aController, 'send']).use(personalAgentAuth())
 * ```
 *
 * Lembre de isentar essas rotas do CSRF (são server-to-server).
 */
export function personalAgentAuth(options: PersonalAgentAuthOptions = {}) {
  const mode = options.delegation ?? 'optional';
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    const runtime = await personalAgentsFor(ctx);
    if (!runtime) return ctx.response.notFound();
    const { protocol } = runtime.config;

    // Autentica ANTES de ler o corpo (PACT §3.4).
    const agent = await runtime.verifier.verify(ctx.request.header('authorization'));
    if (!agent) return personalAgentUnauthorized(ctx, protocol);

    let delegation: DelegationContext | null = null;
    const header = ctx.request.header(protocol.delegationHeader);
    if (header) {
      delegation = runtime.delegation ? await runtime.delegation.verify(agent, header) : null;
      if (!delegation) return personalAgentUnauthorized(ctx, protocol, 'invalid_token');
    } else if (mode === 'required') {
      return personalAgentUnauthorized(ctx, protocol, 'invalid_token');
    }

    requestContexts.set(ctx, { ...agent, delegation });
    return next();
  };
}

/**
 * Bloco de segurança da descoberta do app — no PACT, os `securitySchemes` e
 * `securityRequirements` do Agent Card (§2.1, §5.1). Faça spread no documento
 * que o app serve.
 */
export async function personalAgentSecurity(
  ctx: HttpContext,
  options: {
    /**
     * A interface URL do card. Um app com vários agentes serve um card por agente, mas a delegação
     * vale para UMA interface (`delegation.interfaceUrl`): os demais cards anunciam só identidade.
     */
    interfaceUrl?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const runtime = await requireRuntime(ctx, 'personalAgentSecurity');
  const delegates =
    runtime.delegation !== null &&
    (options.interfaceUrl === undefined ||
      options.interfaceUrl === runtime.delegation.interfaceUrl);
  return runtime.config.protocol.discovery({
    deviceAuthorizationUrl: runtime.urls.deviceAuthorization,
    tokenUrl: runtime.urls.token,
    metadataUrl: runtime.urls.metadata,
    scopes: delegates ? runtime.delegation!.scopes : null,
  });
}

/**
 * Step-up: o turno precisa de scopes que o token não tem. Devolve o `metadata`
 * da resposta que pede autorização ao usuário (no PACT, a task
 * `TASK_STATE_AUTH_REQUIRED` de §5.5) — os scopes faltantes e um link de
 * consentimento pedindo só eles. Aprovar por esse link SOMA os scopes ao grant
 * existente; o agente obtém o token novo repetindo o device flow, ou com um
 * refresh, que já sai com o grant atualizado.
 */
export async function personalAgentStepUp(
  ctx: HttpContext,
  missingScopes: string[],
): Promise<Record<string, unknown>> {
  const runtime = await requireRuntime(ctx, 'personalAgentStepUp');
  const agent = personalAgentOf(ctx);
  if (!runtime.delegation || !agent) {
    throw new Error(
      'authkit: personalAgentStepUp exige `personalAgents.delegation` e o personalAgentAuth() na rota.',
    );
  }
  const link = await runtime.delegation.requestDevice(agent, missingScopes.join(' '));
  return runtime.config.protocol.stepUp({
    missingScopes,
    verificationUriComplete: link.verification_uri_complete,
  });
}

/**
 * Recibo assinado de uma resposta servida sob delegação, já no `metadata` do
 * protocolo (no PACT, `pact.receipt` — §5.6). O PACT exige um em TODA resposta
 * com delegação.
 */
export async function personalAgentReceipt(
  ctx: HttpContext,
  input: { scopesUsed: string[]; actions?: { tool: string; argsHash?: string }[] },
): Promise<Record<string, unknown>> {
  const runtime = await requireRuntime(ctx, 'personalAgentReceipt');
  const delegation = personalAgentOf(ctx)?.delegation;
  if (!runtime.delegation || !delegation) {
    throw new Error('authkit: personalAgentReceipt só vale numa request com delegação válida.');
  }
  return runtime.config.protocol.receipt(await runtime.delegation.receipt(delegation, input));
}
