import { Exception } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import AuthInteractionController from './controllers/interaction_controller.js';

/** A verified identity, obtained from trusted host logic rather than request.accountId. */
export interface CustomLoginIdentity {
  accountId: string;
  /** Host-validated remember-me choice, subject to the runtime session policy. */
  remember?: boolean;
}

/** Host-defined primary authentication. AuthKit owns policies, MFA and session completion. */
export interface CustomLoginMethod {
  /** Credential group, used to prevent repeating it as an additional MFA factor. */
  readonly factorId?: string;
  /** Set true only for proofs that do not authenticate with the account password. */
  readonly passwordless?: boolean;
  /** Optional challenge initiation; response shape, validation and delivery are host-owned. */
  begin?(ctx: HttpContext): Promise<unknown>;
  /** Validate/consume the primary proof, bound to this interaction. Null denies login. */
  authenticate(ctx: HttpContext): Promise<CustomLoginIdentity | null>;
}

/** Constructors are resolved through the request container, including @inject dependencies. */
export type CustomLoginMethodConstructor = new (...args: never[]) => CustomLoginMethod;
export type CustomLoginMethodBinding = CustomLoginMethodConstructor | CustomLoginMethod;
export type CustomLoginMethods = Readonly<Record<string, CustomLoginMethodBinding>>;

export function isCustomLoginMethodId(method: string): boolean {
  return (
    /^[a-z][a-z0-9:_-]{0,63}$/.test(method) &&
    !['pwd', 'email', 'mfa', 'totp', 'webauthn', 'recovery'].includes(method)
  );
}

function failure(message: string, code: string, status = 422): Exception {
  return new Exception(message, { code, status });
}

async function resolveMethod(ctx: HttpContext, method: string): Promise<CustomLoginMethod> {
  if (!isCustomLoginMethodId(method))
    throw failure('Invalid custom login method', 'E_CUSTOM_LOGIN_METHOD');
  const service = await ctx.containerResolver.make('authkit.server');
  const details = await service.interactions.details(ctx);
  if (details.uid !== ctx.request.param('uid') || details.prompt.name !== 'login') {
    throw failure('Invalid login interaction', 'E_CUSTOM_LOGIN_INTERACTION');
  }
  const registry = service.config.customLoginMethods;
  if (!registry || !Object.hasOwn(registry, method)) {
    throw failure('Unknown custom login method', 'E_CUSTOM_LOGIN_METHOD');
  }
  const binding = registry[method];
  return typeof binding === 'function' ? ctx.containerResolver.make(binding) : binding;
}

/** Start a registered method's optional challenge within a valid OIDC login interaction. */
export async function beginCustomLogin(ctx: HttpContext, method: string): Promise<unknown> {
  const handler = await resolveMethod(ctx, method);
  if (!handler.begin)
    throw failure('This method has no challenge initiation', 'E_CUSTOM_LOGIN_BEGIN');
  return handler.begin(ctx);
}

/** Verify using a registered class/instance, then pass through the shared login gates. */
export async function authenticateCustomLogin(ctx: HttpContext, method: string): Promise<unknown> {
  const handler = await resolveMethod(ctx, method);
  let identity: CustomLoginIdentity | null;
  try {
    identity = await handler.authenticate(ctx);
  } catch (error) {
    await recordFailure(ctx, method, 'method_error');
    throw error;
  }
  if (!identity || typeof identity.accountId !== 'string' || !identity.accountId.trim()) {
    await recordFailure(ctx, method, 'invalid_proof');
    throw failure('Authentication failed', 'E_CUSTOM_LOGIN_FAILED');
  }
  return completeCustomLogin(ctx, {
    ...identity,
    method,
    factorId: handler.factorId,
    passwordless: handler.passwordless === true,
  });
}

/**
 * Trusted host escape hatch for arbitrary flows. Call ONLY after validating a primary proof.
 * Never forward an account ID supplied by the browser. Prefer a registered CustomLoginMethod.
 */
export function completeCustomLogin(
  ctx: HttpContext,
  input: CustomLoginIdentity & { method: string; factorId?: string; passwordless?: boolean },
): Promise<unknown> {
  return new AuthInteractionController().completeCustomLogin(ctx, input);
}

async function recordFailure(ctx: HttpContext, method: string, reason: string): Promise<void> {
  const service = await ctx.containerResolver.make('authkit.server');
  const details = await service.interactions.details(ctx);
  try {
    await service.config.audit?.record({
      type: 'login.failure',
      accountId: null,
      ip: ctx.request.ip(),
      clientId: details.params.client_id ?? null,
      metadata: { method, reason },
    });
  } catch {
    ctx.logger.warn('AuthKit custom login failure audit could not be recorded');
  }
}
