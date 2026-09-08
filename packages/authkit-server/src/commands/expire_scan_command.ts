/**
 * Ace command: `authkit:accounts:expire-scan`
 *
 * Varre contas para detectar expiração por inatividade (account_expiration setting).
 *
 * Mecânica honesta:
 *   - "Última atividade" = último `login.success` da conta no audit (list capability).
 *   - Sem audit queryável → aborta com aviso (feature indisponível).
 *   - Usa `audit.list({ type: 'login.success', subject: accountId })` por conta — de
 *     forma paginada sobre `accountStore.listAccounts`. Esse padrão é O(accounts) em
 *     queries ao audit, o que é compatível com volumes moderados (<= 50k contas).
 *     Para volumes maiores, o operador deve implementar um sink com agregação nativa.
 *   - `--warn`: envia e-mail de aviso ("sua conta expira em N dias — faça login") via
 *     hook `mail.onAccountExpirationWarning` + template default. Deduplicado via
 *     audit `account.expiration_warned` — não re-avisa quem já foi avisado dentro
 *     da janela de `warnDays` dias.
 *   - `--dry-run`: reporta sem enviar e-mails nem auditar.
 *   - `--json`: output machine-readable.
 *
 * Designed pra cron do host (ex.: `0 2 * * * node ace authkit:accounts:expire-scan --warn`).
 */

import type { ApplicationService } from '@adonisjs/core/types';
import type { AccountStore, AuthAccount } from '../accounts/account_store.js';
import type { AuditSink } from '../audit/audit_sink.js';
import { RuntimeSettings } from '../host/runtime_settings.js';
import { resolveEffectiveAccountExpiration } from '../host/runtime_toggles.js';
import { ADMIN_LIST_DEFAULT_SIZE, LIST_FIRST_PAGE } from '../pagination.js';
import { resolveAuthkitConfig } from './resolve_config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExpireScanResult {
  /** Contas já expiradas (bloqueadas no login). */
  expired: Array<{ accountId: string; email: string; lastActivityDaysAgo: number | null }>;
  /** Contas a expirar em até warnDays dias. */
  warnSoon: Array<{ accountId: string; email: string; expiresInDays: number }>;
  /** Avisos enviados por e-mail (quando --warn). */
  warned: number;
  /** Contas ignoradas por já terem sido avisadas na janela. */
  deduped: number;
  /** Resumo do scan. */
  summary: {
    scanned: number;
    expired: number;
    warnSoon: number;
    inactiveDays: number;
    warnDays: number;
    auditSupported: boolean;
    dryRun: boolean;
  };
}

// ---------------------------------------------------------------------------
// Core logic (pura, testável sem Ace)
// ---------------------------------------------------------------------------

export async function runExpireScan(
  app: ApplicationService,
  opts: {
    dryRun?: boolean;
    warn?: boolean;
    json?: boolean;
    logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<ExpireScanResult> {
  const { dryRun = false, warn = false, logger } = opts;

  // ---- resolve config ----
  const raw = app.config?.get?.('authkit') ?? null;
  const cfg = await resolveAuthkitConfig(app, raw);
  if (!cfg) {
    logger.error('[expire-scan] Could not resolve authkit config.');
    return emptyResult(dryRun, 0, 0);
  }

  const accountStore = cfg.accountStore as AccountStore;
  const audit = cfg.audit as AuditSink | undefined;

  // ---- audit capability check ----
  if (typeof audit?.list !== 'function') {
    logger.warn(
      '[expire-scan] Audit sink does not support list(). Account expiration requires a queryable audit (e.g. lucidAuditSink). Feature unavailable.',
    );
    return emptyResult(dryRun, 0, 0, false);
  }

  // ---- resolve setting ----
  let runtimeSettings: RuntimeSettings | null = null;
  try {
    const db = await app.container.make('lucid.db' as any);
    const connection: string | undefined = (accountStore as any)?.connectionName;
    runtimeSettings = new RuntimeSettings(db, connection ? { connection } : {});
  } catch {
    // Sem DB → usa defaults.
  }

  const expiration = runtimeSettings
    ? await resolveEffectiveAccountExpiration(runtimeSettings)
    : { enabled: false, inactiveDays: 365, warnDays: 14 };

  if (!expiration.enabled && !dryRun) {
    logger.warn(
      '[expire-scan] account_expiration setting is disabled. Pass --dry-run to scan anyway.',
    );
    return emptyResult(dryRun, expiration.inactiveDays, expiration.warnDays);
  }

  const { inactiveDays, warnDays } = expiration;
  const nowMs = Date.now();
  const expiryCutoffMs = nowMs - inactiveDays * 24 * 60 * 60 * 1000;
  const warnCutoffMs = nowMs - (inactiveDays - warnDays) * 24 * 60 * 60 * 1000;

  // ---- scan accounts ----
  const expired: ExpireScanResult['expired'] = [];
  const warnSoon: ExpireScanResult['warnSoon'] = [];
  let warnedCount = 0;
  let dedupedCount = 0;
  let scanned = 0;
  let page = LIST_FIRST_PAGE;
  const size = ADMIN_LIST_DEFAULT_SIZE;

  while (true) {
    const batch = await accountStore.listAccounts({ page, size });
    if (batch.data.length === 0) break;

    for (const account of batch.data) {
      scanned++;
      const lastMs = await getLastLoginMs(audit, account.id);

      if (lastMs === null) {
        // Nunca logou → trata como ativa (conta nova).
        continue;
      }

      const daysAgo = (nowMs - lastMs) / (24 * 60 * 60 * 1000);

      if (lastMs < expiryCutoffMs) {
        // Expirada.
        expired.push({
          accountId: account.id,
          email: account.email,
          lastActivityDaysAgo: Math.floor(daysAgo),
        });
      } else if (warnDays > 0 && lastMs < warnCutoffMs) {
        // A expirar em breve.
        const daysUntilExpiry = Math.ceil(
          (lastMs + inactiveDays * 24 * 60 * 60 * 1000 - nowMs) / (24 * 60 * 60 * 1000),
        );
        warnSoon.push({
          accountId: account.id,
          email: account.email,
          expiresInDays: daysUntilExpiry,
        });

        if (warn && !dryRun) {
          // Verifica se já foi avisado dentro da janela de warnDays dias.
          const alreadyWarned = await wasWarnedRecently(audit, account.id, warnDays);
          if (alreadyWarned) {
            dedupedCount++;
          } else {
            // Envia e-mail de aviso.
            await sendWarnEmail(cfg, account, daysUntilExpiry);
            // Audita para deduplicação.
            await audit.record({
              type: 'account.expiration_warned',
              accountId: account.id,
              email: account.email,
              metadata: { expiresInDays: daysUntilExpiry },
            });
            warnedCount++;
          }
        }
      }
    }

    if (batch.data.length < size) break;
    page++;
  }

  const result: ExpireScanResult = {
    expired,
    warnSoon,
    warned: warnedCount,
    deduped: dedupedCount,
    summary: {
      scanned,
      expired: expired.length,
      warnSoon: warnSoon.length,
      inactiveDays,
      warnDays,
      auditSupported: true,
      dryRun,
    },
  };

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retorna o timestamp em ms do último login.success da conta, ou null se nunca logou. */
async function getLastLoginMs(audit: AuditSink, accountId: string): Promise<number | null> {
  try {
    const result = await audit.list!({
      type: 'login.success',
      subject: accountId,
      page: LIST_FIRST_PAGE,
      size: 1,
    });
    if (result.data.length === 0) return null;
    const createdAt = result.data[0].createdAt;
    if (!createdAt) return null;
    const ms = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt as string);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Verifica se a conta já foi avisada sobre expiração dentro da janela de `warnDays` dias.
 * Usa o audit `account.expiration_warned` para deduplicação.
 */
async function wasWarnedRecently(
  audit: AuditSink,
  accountId: string,
  warnDays: number,
): Promise<boolean> {
  try {
    const result = await audit.list!({
      type: 'account.expiration_warned',
      subject: accountId,
      page: LIST_FIRST_PAGE,
      size: 1,
    });
    if (result.data.length === 0) return false;
    const lastWarned = result.data[0].createdAt;
    if (!lastWarned) return false;
    const lastMs =
      lastWarned instanceof Date ? lastWarned.getTime() : Date.parse(lastWarned as string);
    if (!Number.isFinite(lastMs)) return false;
    const windowMs = warnDays * 24 * 60 * 60 * 1000;
    return Date.now() - lastMs < windowMs;
  } catch {
    return false;
  }
}

/** Envia e-mail de aviso de expiração iminente. Best-effort (silencioso em caso de erro). */
async function sendWarnEmail(
  cfg: Record<string, any>,
  account: AuthAccount,
  expiresInDays: number,
): Promise<void> {
  try {
    if (cfg.mail?.onAccountExpirationWarning) {
      await cfg.mail.onAccountExpirationWarning({ email: account.email, expiresInDays });
      return;
    }
    // Default: tenta via @adonisjs/mail se disponível.
    const mailSpecifier = '@adonisjs/mail/services/main';
    const mailMod = await import(mailSpecifier).catch(() => null);
    const mail = mailMod?.default ?? null;
    if (!mail) return; // Sem mail configurado — silêncio.

    await mail.send((message: any) => {
      message
        .to(account.email)
        .subject('Your account will be deactivated due to inactivity')
        .html(
          `<p>Your account will be deactivated in <strong>${expiresInDays} day(s)</strong> due to inactivity. Sign in to keep your account active.</p>`,
        )
        .text(
          `Your account will be deactivated in ${expiresInDays} day(s) due to inactivity. Sign in to keep your account active.`,
        );
    });
  } catch {
    // Best-effort: nunca propaga erros de e-mail.
  }
}

function emptyResult(
  dryRun: boolean,
  inactiveDays: number,
  warnDays: number,
  auditSupported = false,
): ExpireScanResult {
  return {
    expired: [],
    warnSoon: [],
    warned: 0,
    deduped: 0,
    summary: {
      scanned: 0,
      expired: 0,
      warnSoon: 0,
      inactiveDays,
      warnDays,
      auditSupported,
      dryRun,
    },
  };
}
