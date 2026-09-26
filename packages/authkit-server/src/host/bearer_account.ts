/**
 * Conta autenticada por `Authorization: Bearer` NESTA request — gravada pelo
 * `oidcBearerGuard` quando ele autentica e lida pelo `getAccountId` como
 * fallback da sessão.
 *
 * Um `WeakMap` keyed pelo próprio `HttpContext` (e não uma prop em `ctx`): nada
 * de augmentation de `HttpContext` vazando pelo barrel (ver o porquê em
 * `account_session_key.ts`), e o valor morre junto com a request.
 *
 * Mantenha este arquivo sem imports: `console_session.ts` (reexportado pelo
 * barrel) depende dele.
 */
const bearerAccounts = new WeakMap<object, string>();
const bearerImpersonations = new WeakMap<object, BearerImpersonation>();

/** Registra a conta autenticada via bearer nesta request. */
export function setBearerAccountId(ctx: object, accountId: string): void {
  bearerAccounts.set(ctx, accountId);
}

/** Esquece a conta bearer desta request (falha de autenticação). */
export function clearBearerAccountId(ctx: object): void {
  bearerAccounts.delete(ctx);
  bearerImpersonations.delete(ctx);
}

/**
 * Id da conta autenticada via bearer nesta request, ou `null` quando nenhum
 * `oidcBearerGuard` autenticou (ainda) a request.
 */
export function bearerAccountId(ctx: object): string | null {
  return bearerAccounts.get(ctx) ?? null;
}

/**
 * Impersonation carregada pelo access token bearer desta request: o ator
 * (`act.sub`, o admin) e a expiração do token. Gravada pelo `oidcBearerGuard`
 * só quando o token é de impersonation; lida por `impersonationState` e
 * `realAccountId` quando não há sessão.
 */
export interface BearerImpersonation {
  actorId: string;
  /** Epoch em segundos do `exp` do token, quando conhecido. */
  exp: number | null;
  /** `jti` do token trocado, quando conhecido (correlaciona com a auditoria). */
  jti: string | null;
}

/** Registra que o token bearer desta request é de impersonation. */
export function setBearerImpersonation(ctx: object, value: BearerImpersonation): void {
  bearerImpersonations.set(ctx, value);
}

/** Impersonation do token bearer desta request, ou `null`. */
export function bearerImpersonation(ctx: object): BearerImpersonation | null {
  return bearerImpersonations.get(ctx) ?? null;
}
