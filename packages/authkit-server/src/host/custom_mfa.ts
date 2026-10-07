import { randomUUID } from 'node:crypto';
import { Exception } from '@adonisjs/core/exceptions';
import type { HttpContext } from '@adonisjs/core/http';
import type { AuthAccount } from '../accounts/account_store.js';

export interface CustomMfaContext {
  ctx: HttpContext;
  account: AuthAccount;
  accountId: string;
  uid: string;
  primaryMethod: string;
  challengeId: string;
}

export interface CustomMfaField {
  name: string;
  label: string;
  type?: 'text' | 'password';
  inputMode?: 'numeric' | 'text';
  autoComplete?: string;
}

export interface CustomMfaDescription {
  label: string;
  fields?: CustomMfaField[];
}

/** A host-defined enrolled factor. Verify and consume its proof within this challenge. */
export interface CustomMfaMethod {
  /** Methods sharing the same credential/channel must share a factorId. */
  readonly factorId?: string;
  isEnabled(context: CustomMfaContext): Promise<boolean>;
  describe(context: CustomMfaContext): Promise<CustomMfaDescription>;
  begin?(context: CustomMfaContext): Promise<void>;
  verify(context: CustomMfaContext): Promise<boolean>;
}

export type CustomMfaMethodConstructor = new (...args: never[]) => CustomMfaMethod;
export type CustomMfaMethodBinding = CustomMfaMethod | CustomMfaMethodConstructor;
export type CustomMfaMethods = Readonly<Record<string, CustomMfaMethodBinding>>;

export interface RuntimeMfaFlow {
  uid: string;
  accountId: string;
  primaryMethod: string;
  primaryFactorId: string;
  challengeId: string;
  /** Total distinct factors, including the authenticated primary factor. */
  requiredFactors: number;
  remember?: boolean;
  passwordless?: boolean;
  completed: Array<{ method: string; factorId: string }>;
  startedMethods: string[];
  createdAt: number;
  attempts: number;
}

export interface CustomMfaDescriptor extends CustomMfaDescription {
  id: string;
  factorId: string;
  requiresBegin: boolean;
}

const FLOW_KEY = 'authkit_mfa_flow';
const PENDING_KEY = 'authkit_mfa_pending';
const FLOW_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESERVED = new Set(['totp', 'webauthn', 'recovery', 'pwd', 'email', 'mfa']);
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9:_-]{0,63}$/.test(value);

export function isCustomMfaMethodId(method: string): boolean {
  return isId(method) && !RESERVED.has(method);
}

function failure(message: string): Exception {
  return new Exception(message, { code: 'E_CUSTOM_MFA', status: 422 });
}

export function initializeMfaFlow(
  ctx: HttpContext,
  input: Pick<
    RuntimeMfaFlow,
    | 'uid'
    | 'accountId'
    | 'primaryMethod'
    | 'primaryFactorId'
    | 'requiredFactors'
    | 'remember'
    | 'passwordless'
  >,
): void {
  if (
    !input.uid ||
    !input.accountId ||
    !isId(input.primaryMethod) ||
    !isId(input.primaryFactorId) ||
    !Number.isInteger(input.requiredFactors) ||
    input.requiredFactors < 2 ||
    input.requiredFactors > 8
  ) {
    throw failure('Invalid MFA flow');
  }
  ctx.session.put(FLOW_KEY, {
    uid: input.uid,
    accountId: input.accountId,
    primaryMethod: input.primaryMethod,
    primaryFactorId: input.primaryFactorId,
    requiredFactors: input.requiredFactors,
    passwordless: input.passwordless ?? input.primaryMethod !== 'pwd',
    ...(input.remember !== undefined ? { remember: input.remember === true } : {}),
    challengeId: randomUUID(),
    completed: [],
    startedMethods: [],
    createdAt: Date.now(),
    attempts: 0,
  } satisfies RuntimeMfaFlow);
}

export function clearMfaFlow(ctx: HttpContext): void {
  ctx.session.forget(FLOW_KEY);
}

function invalidateMfaFlow(ctx: HttpContext): void {
  clearMfaFlow(ctx);
  for (const key of [PENDING_KEY, 'authkit_mfa_primary', 'authkit_mfa_custom_primary'])
    ctx.session.forget(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function getMfaFlow(ctx: HttpContext): RuntimeMfaFlow | null {
  const flow: unknown = ctx.session.get(FLOW_KEY);
  if (flow === undefined || flow === null) return null;
  const now = Date.now();
  if (
    !isRecord(flow) ||
    flow.uid !== ctx.request.param('uid') ||
    typeof flow.accountId !== 'string' ||
    !flow.accountId ||
    flow.accountId !== ctx.session.get(PENDING_KEY) ||
    !isId(flow.primaryMethod) ||
    !isId(flow.primaryFactorId) ||
    typeof flow.challengeId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(flow.challengeId) ||
    typeof flow.createdAt !== 'number' ||
    !Number.isFinite(flow.createdAt) ||
    flow.createdAt > now ||
    now - flow.createdAt >= FLOW_TTL ||
    typeof flow.requiredFactors !== 'number' ||
    !Number.isInteger(flow.requiredFactors) ||
    flow.requiredFactors < 2 ||
    flow.requiredFactors > 8 ||
    typeof flow.attempts !== 'number' ||
    !Number.isInteger(flow.attempts) ||
    flow.attempts < 0 ||
    flow.attempts >= MAX_ATTEMPTS ||
    (flow.remember !== undefined && typeof flow.remember !== 'boolean') ||
    !Array.isArray(flow.startedMethods) ||
    !flow.startedMethods.every((id) => isCustomMfaMethodId(id)) ||
    !Array.isArray(flow.completed) ||
    !flow.completed.every(
      (entry) =>
        isRecord(entry) &&
        isId(entry.method) &&
        isId(entry.factorId) &&
        entry.factorId !== flow.primaryFactorId,
    ) ||
    new Set(flow.completed.map((entry) => entry.factorId)).size !== flow.completed.length
  ) {
    invalidateMfaFlow(ctx);
    return null;
  }
  return flow as unknown as RuntimeMfaFlow;
}

function requireFlow(ctx: HttpContext): RuntimeMfaFlow {
  const flow = getMfaFlow(ctx);
  if (!flow) throw failure('Missing or expired MFA flow');
  return flow;
}

function requireCurrentFlow(ctx: HttpContext, previous: RuntimeMfaFlow): RuntimeMfaFlow {
  const current = requireFlow(ctx);
  if (current.challengeId !== previous.challengeId) throw failure('MFA challenge changed');
  return current;
}

async function contextFor(
  ctx: HttpContext,
  accountId: string,
  uid: string,
  primaryMethod: string,
  challengeId: string,
): Promise<CustomMfaContext> {
  const service = await ctx.containerResolver.make('authkit.server');
  const details = await service.interactions.details(ctx);
  if (details.uid !== uid || uid !== ctx.request.param('uid') || details.prompt.name !== 'login') {
    throw failure('Invalid MFA interaction');
  }
  const account = await service.config.accountStore.findById(accountId);
  if (!account || account.id !== accountId) throw failure('Invalid MFA account');
  return { ctx, account, accountId, uid, primaryMethod, challengeId };
}

async function resolveHandler(ctx: HttpContext, id: string): Promise<CustomMfaMethod> {
  if (!isCustomMfaMethodId(id)) throw failure('Invalid custom MFA method');
  const service = await ctx.containerResolver.make('authkit.server');
  const config = service.config as typeof service.config & { mfa?: { methods?: CustomMfaMethods } };
  const methods = config.mfa?.methods;
  if (!methods || !Object.hasOwn(methods, id)) throw failure('Unknown custom MFA method');
  const binding = methods[id];
  const handler =
    typeof binding === 'function' ? await ctx.containerResolver.make(binding) : binding;
  if (
    !handler ||
    typeof handler.isEnabled !== 'function' ||
    typeof handler.describe !== 'function' ||
    typeof handler.verify !== 'function' ||
    (handler.begin !== undefined && typeof handler.begin !== 'function') ||
    (handler.factorId !== undefined && !isId(handler.factorId))
  ) {
    throw failure('Invalid custom MFA method');
  }
  return handler;
}

/** Only explicit public descriptor fields are passed to templates. */
function descriptionProps(description: CustomMfaDescription): CustomMfaDescription {
  if (!description || typeof description.label !== 'string' || !description.label.trim()) {
    throw failure('Invalid custom MFA method description');
  }
  if (
    description.fields !== undefined &&
    (!Array.isArray(description.fields) || description.fields.length > 8)
  ) {
    throw failure('Invalid custom MFA method fields');
  }
  const fields = description.fields?.map((field) => {
    if (
      !field ||
      typeof field.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.name) ||
      typeof field.label !== 'string' ||
      (field.type !== undefined && !['text', 'password'].includes(field.type)) ||
      (field.inputMode !== undefined && !['numeric', 'text'].includes(field.inputMode)) ||
      (field.autoComplete !== undefined && typeof field.autoComplete !== 'string')
    ) {
      throw failure('Invalid custom MFA method fields');
    }
    return {
      name: field.name,
      label: field.label,
      ...(field.type !== undefined ? { type: field.type } : {}),
      ...(field.inputMode !== undefined ? { inputMode: field.inputMode } : {}),
      ...(field.autoComplete !== undefined ? { autoComplete: field.autoComplete } : {}),
    };
  });
  return { label: description.label, ...(fields ? { fields } : {}) };
}

export async function resolveCustomMfaMethods(
  ctx: HttpContext,
  accountId: string,
  uid: string,
  primaryMethod: string,
  challengeId: string,
): Promise<CustomMfaDescriptor[]> {
  const service = await ctx.containerResolver.make('authkit.server');
  const config = service.config as typeof service.config & { mfa?: { methods?: CustomMfaMethods } };
  const ids = Object.keys(config.mfa?.methods ?? {});
  if (!ids.length) return [];
  const context = await contextFor(ctx, accountId, uid, primaryMethod, challengeId);
  const descriptors: CustomMfaDescriptor[] = [];
  for (const id of ids) {
    const handler = await resolveHandler(ctx, id);
    if (!(await handler.isEnabled(context))) continue;
    descriptors.push({
      id,
      factorId: handler.factorId ?? id,
      requiresBegin: typeof handler.begin === 'function',
      ...descriptionProps(await handler.describe(context)),
    });
  }
  return descriptors;
}

export async function customMfaViewProps(ctx: HttpContext): Promise<{
  customMfaMethods: Array<
    CustomMfaDescriptor & { beginUrl: string; verifyUrl: string; started: boolean }
  >;
  completedMfaMethods: string[];
  requiredMfaFactors: number;
}> {
  const flow = requireFlow(ctx);
  const descriptors = await resolveCustomMfaMethods(
    ctx,
    flow.accountId,
    flow.uid,
    flow.primaryMethod,
    flow.challengeId,
  );
  const used = new Set([flow.primaryFactorId, ...flow.completed.map((entry) => entry.factorId)]);
  return {
    customMfaMethods: descriptors
      .filter((descriptor) => !used.has(descriptor.factorId))
      .map((descriptor) => {
        const base = `/auth/interaction/${encodeURIComponent(flow.uid)}/mfa/custom/${encodeURIComponent(descriptor.id)}`;
        return {
          ...descriptor,
          beginUrl: `${base}/begin`,
          verifyUrl: `${base}/verify`,
          started: flow.startedMethods.includes(descriptor.id),
        };
      }),
    completedMfaMethods: flow.completed.map((entry) => entry.method),
    requiredMfaFactors: flow.requiredFactors,
  };
}

async function activeHandler(ctx: HttpContext, method: string) {
  const flow = requireFlow(ctx);
  const context = await contextFor(
    ctx,
    flow.accountId,
    flow.uid,
    flow.primaryMethod,
    flow.challengeId,
  );
  const handler = await resolveHandler(ctx, method);
  const factorId = handler.factorId ?? method;
  if (
    factorId === flow.primaryFactorId ||
    flow.completed.some((entry) => entry.factorId === factorId)
  ) {
    throw failure('MFA factor has already been authenticated');
  }
  if (!(await handler.isEnabled(context))) throw failure('Custom MFA method is not enabled');
  requireCurrentFlow(ctx, flow);
  return { flow, context, handler };
}

export async function beginCustomMfa(ctx: HttpContext, method: string): Promise<void> {
  const { flow, context, handler } = await activeHandler(ctx, method);
  if (!handler.begin) throw failure('Custom MFA method has no challenge initiation');
  await handler.begin(context);
  requireCurrentFlow(ctx, flow);
  if (!flow.startedMethods.includes(method)) flow.startedMethods.push(method);
  ctx.session.put(FLOW_KEY, flow);
}

export async function verifyCustomMfa(ctx: HttpContext, method: string): Promise<boolean> {
  const { flow, context, handler } = await activeHandler(ctx, method);
  if (handler.begin && !flow.startedMethods.includes(method))
    throw failure('Custom MFA challenge has not started');
  let verified: boolean;
  try {
    verified = (await handler.verify(context)) === true;
  } catch (error) {
    requireCurrentFlow(ctx, flow);
    failedProof(ctx, flow);
    throw error;
  }
  requireCurrentFlow(ctx, flow);
  if (!verified) failedProof(ctx, flow);
  return verified;
}

function failedProof(ctx: HttpContext, flow: RuntimeMfaFlow): void {
  flow.attempts++;
  if (flow.attempts >= MAX_ATTEMPTS) invalidateMfaFlow(ctx);
  else ctx.session.put(FLOW_KEY, flow);
}

/** Call only after a trusted verifier consumes a proof; this does not finish the login. */
export function recordVerifiedMfaFactor(
  ctx: HttpContext,
  method: string,
  factorId = method,
): { complete: boolean; amr: string[] } {
  const flow = requireFlow(ctx);
  if (
    !isId(method) ||
    !isId(factorId) ||
    factorId === flow.primaryFactorId ||
    flow.completed.some((entry) => entry.factorId === factorId)
  ) {
    throw failure('MFA factor has already been authenticated or is invalid');
  }
  flow.completed.push({ method, factorId });
  ctx.session.put(FLOW_KEY, flow);
  return {
    complete: 1 + flow.completed.length >= flow.requiredFactors,
    amr: [flow.primaryMethod, ...flow.completed.map((entry) => entry.method)],
  };
}
