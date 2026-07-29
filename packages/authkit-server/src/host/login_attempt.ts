import type { AccountStore, AuthAccount } from '../accounts/account_store.js';
import {
  supportsAccountStatus,
  supportsEmailVerificationStatus,
  supportsPasswordExpiration,
} from '../accounts/account_store.js';
import type { AuditSink } from '../audit/audit_sink.js';
import type { ResolvedServerConfig } from '../define_config.js';
import { createAccountLockout } from './account_lockout.js';
import type { SettingsCapability } from './runtime_settings.js';
import {
  resolveEffectiveAccountExpiration,
  resolveEffectiveLockout,
  resolveEffectivePasswordExpiration,
  resolveEffectiveRequireVerifiedEmail,
  resolveEffectiveRequireVerifiedEmailFull,
} from './runtime_toggles.js';

/**
 * `requireVerifiedEmail` efetivo (config ou runtime setting) E o store sabe dizer
 * se o e-mail está verificado E a conta NÃO está verificada → bloqueia.
 * Capability-probed: sem {@link EmailVerificationStatusCapability} a checagem é
 * no-op (não bloqueia). Compartilhado pelos três fluxos de login (senha, magic
 * link, passkey-first).
 *
 * Suporta `graceDays`: se a conta foi criada há menos de `graceDays` dias e ainda
 * não verificou o e-mail, o login é permitido (mas a UI mostra um banner avisando).
 *
 * @param settings - SettingsCapability para ler o runtime setting. Quando
 *   ausente (chamadores que ainda não injetam o settings), faz fallback ao config.
 */
export async function isEmailUnverifiedBlock(
  cfg: ResolvedServerConfig,
  accountId: string,
  settings?: SettingsCapability,
): Promise<boolean> {
  // Resolve o valor efetivo: runtime setting sobrescreve o config estático.
  const requireVerified = settings
    ? await resolveEffectiveRequireVerifiedEmail(cfg.login?.requireVerifiedEmail ?? false, settings)
    : (cfg.login?.requireVerifiedEmail ?? false);

  if (!requireVerified) return false;
  if (!supportsEmailVerificationStatus(cfg.accountStore)) return false;
  const verified = await cfg.accountStore.isEmailVerified(accountId);
  if (verified) return false;

  // Grace period: se a setting tem graceDays e a conta foi criada recentemente,
  // permite o login.
  if (settings) {
    const full = await resolveEffectiveRequireVerifiedEmailFull(
      cfg.login?.requireVerifiedEmail ?? false,
      settings,
    );
    if (full.graceDays > 0) {
      // Busca a conta para checar created_at (se o store suportar).
      const account = await cfg.accountStore.findById(accountId);
      if (account) {
        // Tenta ler `created_at` via duck-typing (não é parte do contrato AccountStore).
        const raw = account as any;
        const createdAt: Date | null =
          raw.createdAt instanceof Date
            ? raw.createdAt
            : typeof raw.createdAt === 'string'
              ? new Date(raw.createdAt)
              : null;
        if (createdAt) {
          const graceCutoff = new Date(createdAt.getTime() + full.graceDays * 24 * 60 * 60 * 1000);
          if (new Date() <= graceCutoff) {
            return false; // dentro da janela de graça → não bloqueia
          }
        }
      }
    }
  }

  return true;
}

/**
 * Verifica se a senha da conta está vencida (password expiration).
 * Capability-probed: sem `getPasswordChangedAt` → retorna false.
 * Quando `password_expiration.enabled` é false ou a coluna não existe → false.
 *
 * @returns true se a senha expirou e deve ser trocada antes de completar o login.
 */
export async function isPasswordExpired(
  cfg: Pick<ResolvedServerConfig, 'accountStore'>,
  accountId: string,
  settings: SettingsCapability,
): Promise<boolean> {
  const expiration = await resolveEffectivePasswordExpiration(settings);
  if (!expiration.enabled) return false;
  if (!supportsPasswordExpiration(cfg.accountStore)) return false;

  const changedAt = await cfg.accountStore.getPasswordChangedAt!(accountId);
  if (!changedAt) {
    // Senha nunca trocada (coluna NULL = conta legacy) → considera vencida quando
    // expiration está ligada (seguro: força a troca na 1ª vez).
    return true;
  }

  const maxAgeMs = expiration.maxAgeDays * 24 * 60 * 60 * 1000;
  return Date.now() - changedAt.getTime() > maxAgeMs;
}

/**
 * Verifica se a conta está expirada por inatividade (account_expiration setting).
 *
 * "Última atividade" = timestamp do último `login.success` da conta no audit.
 * Capability-probed: sem `audit.list` → retorna false (feature indisponível).
 * Quando enabled=false ou sem audit queryável → false (no-op).
 *
 * @param audit - AuditSink. Quando ausente ou sem `list`, retorna false.
 * @param accountId - ID da conta a verificar.
 * @param settings - SettingsCapability para ler a setting `account_expiration`.
 * @param logger - logger mínimo opcional. Quando presente, registra falhas de DB
 *   no caminho fail-safe (sem ele, o erro continua silencioso por compat).
 * @returns true se a conta está expirada e o login deve ser bloqueado.
 */
export async function isAccountExpired(
  audit: AuditSink | null | undefined,
  accountId: string,
  settings: SettingsCapability,
  logger?: LoginAttemptLogger,
): Promise<boolean> {
  const expiration = await resolveEffectiveAccountExpiration(settings);
  if (!expiration.enabled) return false;
  // Sem audit queryável → feature indisponível → não bloqueia.
  if (typeof audit?.list !== 'function') return false;

  try {
    // Busca o último login.success da conta (ordem desc, limit 1).
    const result = await audit.list({
      type: 'login.success',
      subject: accountId,
      page: 1,
      limit: 1,
    });
    if (result.data.length === 0) {
      // Nunca logou → considera ativa (conta nova, não inativa).
      return false;
    }
    const lastLogin = result.data[0];
    const createdAt = lastLogin.createdAt;
    if (!createdAt) return false;
    const lastMs =
      createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt as string);
    if (!Number.isFinite(lastMs)) return false;
    const cutoffMs = Date.now() - expiration.inactiveDays * 24 * 60 * 60 * 1000;
    return lastMs < cutoffMs;
  } catch (err) {
    // Fail-safe: erro de DB → não bloqueia. Loga: enquanto a query de audit estiver
    // quebrada, a expiração por inatividade não é aplicada (admin precisa saber).
    logger?.warn(
      { err, accountId },
      'authkit: account-expiration check failed (audit query error) — not blocking login (fail-safe); inactivity enforcement is disabled until the audit store recovers.',
    );
    return false;
  }
}

/** Logger mínimo (subconjunto do logger do AdonisJS) para o caminho fail-safe. */
export interface LoginAttemptLogger {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Motivo pelo qual um login foi recusado no gate de status de conta,
 * compartilhado por TODOS os fluxos de login (senha, magic link, OTP,
 * passkey, social, token-exchange/impersonation) — não só o de senha.
 */
export type AccountStatusReason = 'disabled' | 'password_expired' | 'account_expired';

/** Resultado do gate de status de conta. Discriminado por `allowed`. */
export type LoginAllowedResult =
  | { allowed: true }
  | { allowed: false; reason: AccountStatusReason };

/**
 * Subconjunto de {@link ResolvedServerConfig} que o gate de status precisa: o
 * accountStore (para as capacidades opcionais) e o audit sink (para os
 * `login.failure`/`password.expired_change_forced`/`account.expired_login_blocked`
 * emitidos). Estrutural — qualquer `ResolvedServerConfig` serve aqui sem cast;
 * chamadores fora do host (ex.: `token_exchange.ts`, que não tem o
 * `ResolvedServerConfig` inteiro em mãos) podem montar só este pedaço.
 */
export interface LoginAllowedConfig {
  accountStore: AccountStore;
  audit?: AuditSink;
}

/** Entrada comum aos dois gates de status (`assertAccountEnabled`/`assertAccountNotExpired`). */
export interface LoginAllowedInput {
  email: string;
  ip: string | null;
  /** `clientId` só entra no evento de auditoria quando o fluxo o fornece (mesma regra do resto do arquivo). */
  clientId?: string | null;
  /** Ausente → password-expiry/account-expiry ficam no-op (precisam da runtime setting). */
  settings?: SettingsCapability;
  logger?: LoginAttemptLogger;
}

/**
 * Gate 1/2: conta desabilitada. Extraído de {@link attemptPasswordLogin}
 * (bloco `isDisabled` original) para ser reutilizável por TODO fluxo que
 * finaliza um login (`completeLogin`), não só o de senha.
 *
 * Capability-probed via `supportsAccountStatus` — store sem a capacidade
 * degrada para "allowed" (comportamento preservado exatamente).
 */
export async function assertAccountEnabled(
  cfg: LoginAllowedConfig,
  accountId: string,
  input: LoginAllowedInput,
): Promise<LoginAllowedResult> {
  const { email, ip, clientId } = input;
  if (supportsAccountStatus(cfg.accountStore) && (await cfg.accountStore.isDisabled(accountId))) {
    await cfg.audit?.record(
      clientId !== undefined
        ? {
            type: 'login.failure',
            email,
            ip,
            clientId,
            metadata: { reason: 'disabled' },
          }
        : { type: 'login.failure', email, ip, metadata: { reason: 'disabled' } },
    );
    return { allowed: false, reason: 'disabled' };
  }
  return { allowed: true };
}

/**
 * Gate 2/2: senha vencida (password_expiration) e conta expirada por
 * inatividade (account_expiration). Extraído dos blocos originais de
 * {@link attemptPasswordLogin} que seguiam o gate de e-mail não verificado.
 *
 * Capability/setting-probed: sem `input.settings`, ambas as checagens são
 * no-op (mesma guarda `if (input.settings)` do código original).
 */
export async function assertAccountNotExpired(
  cfg: LoginAllowedConfig,
  accountId: string,
  input: LoginAllowedInput,
): Promise<LoginAllowedResult> {
  const { email, ip, clientId, settings, logger } = input;

  if (settings) {
    const expired = await isPasswordExpired(cfg, accountId, settings);
    if (expired) {
      await cfg.audit?.record(
        clientId !== undefined
          ? { type: 'password.expired_change_forced', accountId, email, ip, clientId }
          : { type: 'password.expired_change_forced', accountId, email, ip },
      );
      return { allowed: false, reason: 'password_expired' };
    }
  }

  if (settings) {
    const expired = await isAccountExpired(cfg.audit, accountId, settings, logger);
    if (expired) {
      await cfg.audit?.record(
        clientId !== undefined
          ? { type: 'account.expired_login_blocked', accountId, email, ip, clientId }
          : { type: 'account.expired_login_blocked', accountId, email, ip },
      );
      return { allowed: false, reason: 'account_expired' };
    }
  }

  return { allowed: true };
}

/**
 * Gate combinado (disabled → password_expired → account_expired), na ordem
 * canônica. É o que os fluxos passwordless (magic link, OTP, passkey, social)
 * e o token-exchange (impersonation) chamam UMA VEZ, imediatamente antes de
 * `completeLogin` — eles não têm o gate de e-mail-não-verificado intercalado
 * entre o disabled-check e os expiry-checks como `attemptPasswordLogin` tem,
 * então uma chamada única e sequencial é observacionalmente idêntica a chamar
 * os dois gates separados nessa ordem.
 *
 * `attemptPasswordLogin` NÃO usa este combinado — chama `assertAccountEnabled`
 * e `assertAccountNotExpired` separadamente, com o gate de e-mail não
 * verificado (`isEmailUnverifiedBlock`) intercalado entre os dois, para
 * preservar a ordem de checagens original byte-a-byte.
 */
export async function assertLoginAllowed(
  cfg: LoginAllowedConfig,
  accountId: string,
  input: LoginAllowedInput,
): Promise<LoginAllowedResult> {
  const enabled = await assertAccountEnabled(cfg, accountId, input);
  if (!enabled.allowed) return enabled;
  return assertAccountNotExpired(cfg, accountId, input);
}

/** Entrada de uma tentativa de login por senha (keyed por email). */
export interface PasswordLoginInput {
  email: string;
  password: string;
  /** IP da request (para auditoria + lockout). null quando indisponível. */
  ip: string | null;
  /**
   * client_id da interaction OIDC, quando existir. Só é incluído no evento de
   * auditoria nos fluxos que o têm (interaction); ausente no console de conta.
   */
  clientId?: string | null;
  /**
   * SettingsCapability para ler o runtime setting de `require_verified_email`.
   * Quando ausente, faz fallback ao valor de `cfg.login.requireVerifiedEmail`.
   */
  settings?: SettingsCapability;
  /**
   * Logger mínimo opcional. Repassado aos caminhos fail-safe (ex.: checagem de
   * expiração por inatividade) para que falhas de infra não fiquem silenciosas.
   */
  logger?: LoginAttemptLogger;
}

/** Resultado de {@link attemptPasswordLogin}. */
export type PasswordLoginResult =
  | { ok: true; account: AuthAccount }
  | {
      ok: false;
      locked: boolean;
      retryAfterSec?: number;
      disabled?: boolean;
      unverified?: boolean;
      unverifiedGraceDays?: number;
      passwordExpired?: boolean;
      accountExpired?: boolean;
      account?: AuthAccount;
    };

/**
 * Sequência canônica de login por senha + bloqueio progressivo, compartilhada
 * pelos dois fluxos que pedem senha (interaction OIDC e console de conta):
 *
 *   1. `lockout.isLocked(email)` — se travada, NÃO verifica a senha; devolve
 *      `{ ok: false, locked: true, retryAfterSec }` (o controller renderiza o erro).
 *   2. `verifyCredentials(email, password)` — em falha: emite `login.failure`
 *      (com `clientId` apenas quando fornecido), registra a falha no lockout
 *      (`{ sink: cfg.audit, ip }`) e devolve `{ ok: false, locked: false }`.
 *   3. Em sucesso: limpa o contador de falhas e devolve `{ ok: true, account }`.
 *
 * O evento `login.success` e a finalização da sessão/interaction ficam a cargo de
 * cada controller (os fluxos diferem: MFA gate na interaction, sessão no console),
 * assim como toda a renderização.
 */
export async function attemptPasswordLogin(
  cfg: ResolvedServerConfig,
  input: PasswordLoginInput,
): Promise<PasswordLoginResult> {
  const { email, password, ip } = input;
  // Lockout efetivo: runtime setting `lockout` sobrescreve o config estático.
  // FAIL-SAFE → cfg.lockout (resolveEffectiveLockout já trata erros internamente).
  // `store` é infra e permanece no config estático (não vem da setting).
  const effectiveLockout = input.settings
    ? { ...(await resolveEffectiveLockout(input.settings, cfg.lockout)), store: cfg.lockout.store }
    : cfg.lockout;
  const lockout = createAccountLockout(effectiveLockout);

  // Bloqueio progressivo (keyed por email): se travada, não verifica a senha.
  const lock = await lockout.isLocked(email);
  if (lock.locked) {
    return { ok: false, locked: true, retryAfterSec: lock.retryAfterSec };
  }

  const account = await cfg.accountStore.verifyCredentials(email, password);
  if (!account) {
    // `clientId` só entra no evento quando o fluxo o fornece (interaction).
    await cfg.audit?.record(
      input.clientId !== undefined
        ? { type: 'login.failure', email, ip, clientId: input.clientId }
        : { type: 'login.failure', email, ip },
    );
    await lockout.recordFailure(email, { sink: cfg.audit, ip });
    return { ok: false, locked: false };
  }

  // Conta desabilitada: rejeita o login (mesmo com senha correta). A capacidade é
  // opcional — só checada quando o store a implementa. Emite `login.failure` (com
  // motivo `disabled` no metadata) e NÃO registra falha no lockout (não é tentativa
  // de adivinhar senha). Extraído em `assertAccountEnabled` — reutilizado por TODO
  // fluxo de login (magic link, OTP, passkey, social, token-exchange), não só este.
  const enabledCheck = await assertAccountEnabled(cfg, account.id, {
    email,
    ip,
    clientId: input.clientId,
  });
  if (!enabledCheck.allowed) {
    return { ok: false, locked: false, disabled: true };
  }

  // E-mail não verificado (LGPD/compliance): rejeita o login se a política exige
  // verificação E o store sabe responder. Não conta como falha de senha (a senha
  // estava correta) — limpa o contador e emite login.failure com motivo `unverified`.
  if (await isEmailUnverifiedBlock(cfg, account.id, input.settings)) {
    await lockout.clearFailures(email);
    await cfg.audit?.record(
      input.clientId !== undefined
        ? {
            type: 'login.failure',
            email,
            ip,
            clientId: input.clientId,
            metadata: { reason: 'unverified' },
          }
        : { type: 'login.failure', email, ip, metadata: { reason: 'unverified' } },
    );
    return { ok: false, locked: false, unverified: true };
  }

  // Senha expirada (password expiration) e conta expirada por inatividade
  // (account_expiration): extraído em `assertAccountNotExpired`, na mesma ordem
  // e com os mesmos eventos de auditoria do código original. Capability/setting
  // -probed internamente (sem `input.settings` → no-op, como antes).
  const expiryCheck = await assertAccountNotExpired(cfg, account.id, {
    email,
    ip,
    clientId: input.clientId,
    settings: input.settings,
    logger: input.logger,
  });
  if (!expiryCheck.allowed) {
    // Nenhuma das duas é falha de credenciais — limpa o contador.
    await lockout.clearFailures(email);
    if (expiryCheck.reason === 'password_expired') {
      return { ok: false, locked: false, passwordExpired: true, account: account as any };
    }
    return { ok: false, locked: false, accountExpired: true };
  }

  // Senha correta: limpa o contador de falhas (o lockout protege a etapa de senha).
  await lockout.clearFailures(email);
  return { ok: true, account };
}
