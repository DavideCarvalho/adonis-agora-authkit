/**
 * Serviço de notificações de segurança: envia e-mail quando eventos sensíveis
 * ocorrem na conta (senha alterada, MFA ligado/desligado, passkey add/remove,
 * e-mail alterado). Best-effort, fail-safe total — NUNCA lança na request.
 *
 * Respeita a setting `security_notifications` em `auth_settings` (enabled + kinds).
 * O hook `mail.onSecurityNotice` do config tem prioridade sobre o mailer default.
 */

import type { HttpContext } from '@adonisjs/core/http';
import type { AuditSink } from '../audit/audit_sink.js';
import type { MailHooks, ResolvedServerConfig } from '../define_config.js';
import { sendSecurityNoticeEmail } from './default_mailer.js';
import { resolveRuntimeSettings } from './runtime_settings.js';
import type { SecurityNotificationKind } from './runtime_toggles.js';
import { resolveEffectiveSecurityNotifications } from './runtime_toggles.js';

/**
 * Contexto para disparo de uma notificação de segurança.
 */
export interface SecurityNoticeContext {
  account: { id: string; email: string };
  kind: SecurityNotificationKind;
  ip?: string | null;
  userAgent?: string | null;
  timestamp?: string;
  metadata?: Record<string, string>;
}

/**
 * Despacha uma notificação de segurança, se habilitada e o kind for um dos
 * configurados. Best-effort: qualquer falha é ignorada silenciosamente (logged).
 *
 * @param ctx         HttpContext para o mailer default
 * @param notice      Contexto da notificação
 * @param mailHooks   Hooks de mail do config (opcional)
 * @param audit       Sink de auditoria (opcional)
 * @param cfg         Config resolvido — só usado para derivar o origin do link
 *                    do e-mail default (`authkitOrigin`); nunca do `request.host()`.
 */
export async function dispatchSecurityNotice(
  ctx: HttpContext,
  notice: SecurityNoticeContext,
  mailHooks: Pick<MailHooks, 'onSecurityNotice'> | undefined,
  audit: AuditSink | undefined,
  cfg: ResolvedServerConfig,
): Promise<void> {
  try {
    // Resolve settings em runtime (fail-safe: sem tabela → defaults habilitados).
    let enabled = true;
    let enabledKinds: SecurityNotificationKind[] = [
      'password_changed',
      'mfa_enabled',
      'mfa_disabled',
      'passkey_added',
      'passkey_removed',
      'email_changed',
    ];

    try {
      const runtimeSettings = await resolveRuntimeSettings(ctx);
      if (runtimeSettings && (await runtimeSettings.isTablePresent())) {
        const resolved = await resolveEffectiveSecurityNotifications(runtimeSettings);
        enabled = resolved.enabled;
        enabledKinds = resolved.kinds;
      }
    } catch {
      // DB não disponível ou tabela ausente → usa defaults (habilitado, todos os kinds).
    }

    if (!enabled) return;
    if (!enabledKinds.includes(notice.kind)) return;

    const timestamp = notice.timestamp ?? new Date().toISOString();
    const noticeData = {
      account: notice.account,
      kind: notice.kind,
      ip: notice.ip ?? null,
      userAgent: notice.userAgent ?? null,
      timestamp,
      metadata: notice.metadata,
    };

    // Hook do config tem prioridade; senão usa o mailer default.
    if (mailHooks?.onSecurityNotice) {
      await mailHooks.onSecurityNotice(noticeData);
    } else {
      await sendSecurityNoticeEmail(ctx, cfg, {
        email: notice.account.email,
        kind: notice.kind,
        timestamp,
        ip: notice.ip,
        metadata: notice.metadata,
      });
    }

    // Audita o envio da notificação (best-effort).
    await audit?.record({
      type: 'security_notice.sent',
      accountId: notice.account.id,
      ip: notice.ip ?? null,
      metadata: { kind: notice.kind },
    });
  } catch (error) {
    // Fail-safe total: erro na notificação NUNCA quebra o fluxo principal.
    try {
      ctx.logger.error(
        { err: error, kind: notice.kind, accountId: notice.account.id },
        'authkit: falha ao enviar notificação de segurança',
      );
    } catch {
      // Logger também falhou — silencioso.
    }
  }
}
