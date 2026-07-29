import type { HttpContext } from '@adonisjs/core/http';
import type { ResolvedServerConfig } from '../define_config.js';
import { accountPath } from './account_paths.js';
import type { BrandingConfig } from './branding.js';
import { type EmailContent, renderTransactionalEmail } from './email_templates.js';
import { type AuthMessages, type I18nConfig, resolveMessages, translate } from './i18n.js';
import { authkitOrigin } from './origin.js';

/**
 * Envio de e-mail default do host-kit, usando o mailer `default` do host via
 * `@adonisjs/mail`. Permite que o dev não escreva nenhum hook: por padrão os
 * e-mails de reset de senha / verificação são enviados pelo mailer já configurado
 * no app, com HTML responsivo + branding (do `config/authkit.ts`) e fallback texto.
 * Os hooks de `config/authkit.ts` (`mail.onPasswordReset` /
 * `mail.onEmailVerification`), quando presentes, têm prioridade (override).
 *
 * Best-effort: se `@adonisjs/mail` não estiver instalado/configurado, cai no
 * fallback de log (mesmo comportamento de antes) e NUNCA lança na request.
 */

/**
 * Service do `@adonisjs/mail` resolvido de forma preguiçosa. Tipado como `any` de
 * propósito: a lib NÃO depende do mail em tempo de compilação (peer/opt-in).
 */
type MailService = any;

let mailServicePromise: Promise<MailService | null> | undefined;

/**
 * Importa o service de mail do HOST de forma preguiçosa e fail-safe.
 * Se `@adonisjs/mail` não estiver instalado, resolve `null`.
 */
async function loadMail(): Promise<MailService | null> {
  if (!mailServicePromise) {
    // Indireção via variável: o `@adonisjs/mail` é peer/opcional e pode não estar
    // instalado na lib, então o specifier não é resolvido em build-time.
    const specifier = '@adonisjs/mail/services/main';
    mailServicePromise = import(specifier)
      .then((mod) => (mod as any).default ?? null)
      .catch(() => null);
  }
  return mailServicePromise;
}

/**
 * Permite reapontar/limpar o loader do mail (usado em testes).
 * @internal
 */
export function __setMailLoaderForTests(fn: (() => Promise<MailService | null>) | undefined): void {
  if (fn) {
    mailServicePromise = fn();
  } else {
    mailServicePromise = undefined;
  }
}

/**
 * Tenta descobrir o `from` default da config de mail do host. Se não houver,
 * retorna `undefined` (deixa o @adonisjs/mail aplicar o default da própria config).
 */
function defaultFrom(ctx: HttpContext): { address: string; name?: string } | string | undefined {
  try {
    // Alcançamos as configs do HOST via o resolver do container. Esse formato é
    // específico do app (a lib não conhece o shape das configs nem `containerResolver.app`
    // é público), então tipamos apenas ESTE acesso como `unknown`/cast estreito — não o
    // `HttpContext` inteiro.
    const resolver = ctx.containerResolver as unknown as {
      app?: {
        config?: {
          get?: (key: string) => { from?: unknown; mail?: { from?: unknown } } | undefined;
        };
      };
    };
    const get = resolver.app?.config?.get;
    type FromValue = { address: string; name?: string } | string | undefined;
    // 1) `from` específico do authkit (defineConfig({ mail: { from } })) — PRIORIDADE:
    // permite que o auth use um remetente próprio, diferente do e-mail geral do app.
    const authkitFrom = get?.('authkit')?.mail?.from as FromValue;
    if (authkitFrom) return authkitFrom;
    // 2) `from` global do host (config/mail.ts).
    const hostFrom = get?.('mail')?.from as FromValue;
    if (hostFrom) return hostFrom;
  } catch {
    // sem config resolvível — deixa o @adonisjs/mail decidir.
  }
  return undefined;
}

/**
 * Resolve a marca default a partir do `config/authkit.ts` (branding.default +
 * company). Usada para o cabeçalho/cor de acento/rodapé dos e-mails. Cai num
 * default neutro se a config não for resolvível.
 */
function resolveBrand(ctx: HttpContext): {
  appName: string;
  accent?: string;
  company?: string;
} {
  try {
    const resolver = ctx.containerResolver as unknown as {
      app?: { config?: { get?: (key: string) => { branding?: BrandingConfig } | undefined } };
    };
    const branding = resolver.app?.config?.get?.('authkit')?.branding;
    if (branding) {
      return {
        appName: branding.default?.appName || branding.company || 'AuthKit',
        accent: branding.default?.accent,
        company: branding.company,
      };
    }
  } catch {
    // sem config authkit resolvível — usa default neutro.
  }
  return { appName: 'AuthKit' };
}

/**
 * Resolve o catálogo de mensagens i18n a partir do `config/authkit.ts` (i18n).
 * Cai no default (`en`) se a config não for resolvível. Usado para localizar
 * os e-mails transacionais (assunto/cabeçalho/corpo).
 */
function resolveMailMessages(ctx: HttpContext): { messages: AuthMessages; locale: string } {
  try {
    const resolver = ctx.containerResolver as unknown as {
      app?: { config?: { get?: (key: string) => { i18n?: I18nConfig } | undefined } };
    };
    const i18n = resolver.app?.config?.get?.('authkit')?.i18n;
    return { messages: resolveMessages(i18n), locale: i18n?.locale ?? 'en' };
  } catch {
    // sem config authkit resolvível — usa o default `en`.
    return { messages: resolveMessages(), locale: 'en' };
  }
}

async function sendEmail(ctx: HttpContext, to: string, content: EmailContent): Promise<boolean> {
  const mail = await loadMail();
  if (!mail) return false;
  const from = defaultFrom(ctx);
  await mail.send((message: any) => {
    if (from) message.from(from);
    message.to(to).subject(content.subject).html(content.html).text(content.text);
  });
  return true;
}

/**
 * Envia o e-mail de redefinição de senha pelo mailer default do host.
 * Best-effort: no fallback (sem mail) loga o link; nunca lança.
 */
export async function sendPasswordResetEmail(
  ctx: HttpContext,
  data: { email: string; resetUrl: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.reset.subject'),
      heading: translate(t, 'mail.reset.heading'),
      intro: translate(t, 'mail.reset.intro'),
      ctaLabel: translate(t, 'mail.reset.cta'),
      ctaUrl: data.resetUrl,
      footnote: translate(t, 'mail.reset.fallback'),
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { resetUrl: data.resetUrl, email: data.email },
        'authkit: link de redefinição de senha (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar e-mail de redefinição de senha',
    );
  }
}

/**
 * Envia o e-mail de confirmação de TROCA de e-mail para o NOVO endereço.
 * Best-effort: no fallback (sem mail) loga o link; nunca lança.
 */
export async function sendEmailChangeConfirmationEmail(
  ctx: HttpContext,
  data: { email: string; confirmUrl: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.email_change.subject'),
      heading: translate(t, 'mail.email_change.heading'),
      intro: translate(t, 'mail.email_change.intro'),
      ctaLabel: translate(t, 'mail.email_change.cta'),
      ctaUrl: data.confirmUrl,
      footnote: translate(t, 'mail.email_change.fallback'),
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { confirmUrl: data.confirmUrl, email: data.email },
        'authkit: link de confirmação de troca de e-mail (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar confirmação de troca de e-mail',
    );
  }
}

/**
 * Envia o e-mail de alerta de NOVO acesso à conta (login de um IP novo).
 * Best-effort: no fallback (sem mail) loga o evento; nunca lança.
 */
export async function sendNewLoginEmail(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  data: { email: string; ip: string; when: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const origin = authkitOrigin(cfg);
    const intro = [
      translate(t, 'mail.new_login.intro'),
      translate(t, 'mail.new_login.when', { date: data.when }),
      translate(t, 'mail.new_login.ip', { ip: data.ip }),
    ].join(' ');
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.new_login.subject'),
      heading: translate(t, 'mail.new_login.heading'),
      intro,
      ctaLabel: translate(t, 'account.security.title'),
      ctaUrl: `${origin}${accountPath('security')}`,
      footnote: translate(t, 'mail.new_login.fallback'),
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { ip: data.ip, email: data.email },
        'authkit: alerta de novo acesso (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar alerta de novo acesso',
    );
  }
}

/**
 * Envia o e-mail de alerta de NOVO DISPOSITIVO (login sem cookie de dispositivo
 * confiável). Best-effort: no fallback (sem mail) loga o evento; nunca lança.
 */
export async function sendNewDeviceLoginEmail(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  data: { email: string; ip?: string | null; userAgent?: string | null; when: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const origin = authkitOrigin(cfg);
    const lines = [
      translate(t, 'mail.new_login.intro'),
      translate(t, 'mail.new_login.when', { date: data.when }),
    ];
    if (data.userAgent)
      lines.push(translate(t, 'mail.new_login.device', { device: data.userAgent }));
    if (data.ip) lines.push(translate(t, 'mail.new_login.ip', { ip: data.ip }));
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.new_login.subject'),
      heading: translate(t, 'mail.new_login.heading'),
      intro: lines.join(' '),
      ctaLabel: translate(t, 'account.security.title'),
      ctaUrl: `${origin}${accountPath('security')}`,
      footnote: translate(t, 'mail.new_login.fallback'),
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { ip: data.ip, email: data.email, userAgent: data.userAgent },
        'authkit: alerta de novo dispositivo (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar alerta de novo dispositivo',
    );
  }
}

/**
 * Envia o e-mail de magic link (login passwordless) pelo mailer default do host.
 * Best-effort: no fallback (sem mail) loga o link; nunca lança.
 */
export async function sendMagicLinkEmail(
  ctx: HttpContext,
  data: { email: string; magicUrl: string; code?: string; channel?: 'code' | 'link' },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    // Login choose-first: o `channel` decide o que o e-mail SURFA (os dois tokens
    // continuam emitidos co-locados a montante — isto é só renderização).
    //  - 'code'  → e-mail SÓ com o código (sem botão/link), quando há código;
    //  - 'link'  → e-mail SÓ com o link (código suprimido);
    //  - ausente → ambos (comportamento histórico — back-compat).
    // Degradação limpa: `channel: 'code'` sem código emitido (OTP desligado) cai
    // no e-mail de link — não dá pra mostrar um código inexistente.
    const codeOnly = data.channel === 'code' && !!data.code;
    const linkOnly = data.channel === 'link';
    const content = codeOnly
      ? renderTransactionalEmail({
          brand,
          locale,
          subject: translate(t, 'mail.magic_link.code_subject'),
          heading: translate(t, 'mail.magic_link.heading'),
          intro: translate(t, 'mail.magic_link.code_intro'),
          footnote: translate(t, 'mail.magic_link.fallback'),
          // Sem `ctaUrl`: e-mail sem botão nem fallback de link — só o código.
          code: data.code,
          codeLabel: translate(t, 'mail.magic_link.code_only_label'),
        })
      : renderTransactionalEmail({
          brand,
          locale,
          linkFallback: translate(t, 'mail.common.link_fallback'),
          subject: translate(t, 'mail.magic_link.subject'),
          heading: translate(t, 'mail.magic_link.heading'),
          intro: translate(t, 'mail.magic_link.intro'),
          ctaLabel: translate(t, 'mail.magic_link.cta'),
          ctaUrl: data.magicUrl,
          footnote: translate(t, 'mail.magic_link.fallback'),
          // Código em destaque quando presente — suprimido no canal 'link'.
          code: linkOnly ? undefined : data.code,
          codeLabel: translate(t, 'mail.magic_link.code_label'),
        });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { magicUrl: data.magicUrl, email: data.email },
        'authkit: magic link de login (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar magic link de login',
    );
  }
}

/**
 * Envia o e-mail de aviso de segurança ao e-mail ATUAL quando uma troca de
 * e-mail é solicitada ("Alguém pediu troca para X — se não foi você...").
 * Best-effort: no fallback (sem mail) loga o evento; nunca lança.
 */
export async function sendEmailChangeNoticeEmail(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  data: { email: string; newEmail: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const origin = authkitOrigin(cfg);
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.email_change_notice.subject'),
      heading: translate(t, 'mail.email_change_notice.heading'),
      intro: translate(t, 'mail.email_change_notice.intro', { newEmail: data.newEmail }),
      ctaLabel: translate(t, 'mail.email_change_notice.cta'),
      ctaUrl: `${origin}${accountPath('security')}`,
      footnote: translate(t, 'mail.email_change_notice.fallback'),
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { newEmail: data.newEmail, email: data.email },
        'authkit: aviso de troca de e-mail (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar aviso de troca de e-mail',
    );
  }
}

/**
 * Envia o e-mail de aviso de segurança ao e-mail ANTIGO confirmando que a
 * troca foi concluída ("Seu e-mail foi alterado de A para B — se não foi você...").
 * Best-effort: no fallback (sem mail) loga o evento; nunca lança.
 */
export async function sendEmailChangedCompletedEmail(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  data: { oldEmail: string; newEmail: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const origin = authkitOrigin(cfg);
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.email_changed_completed.subject'),
      heading: translate(t, 'mail.email_changed_completed.heading'),
      intro: translate(t, 'mail.email_changed_completed.intro', {
        oldEmail: data.oldEmail,
        newEmail: data.newEmail,
      }),
      ctaLabel: translate(t, 'mail.email_changed_completed.cta'),
      ctaUrl: `${origin}${accountPath('security')}`,
      footnote: translate(t, 'mail.email_changed_completed.fallback'),
    });
    const sent = await sendEmail(ctx, data.oldEmail, content);
    if (!sent) {
      ctx.logger.info(
        { oldEmail: data.oldEmail, newEmail: data.newEmail },
        'authkit: confirmação de troca de e-mail concluída (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.oldEmail },
      'authkit: falha ao enviar confirmação de troca de e-mail concluída',
    );
  }
}

/**
 * Envia um e-mail de notificação de segurança para a conta (senha alterada,
 * MFA habilitado/desabilitado, passkey adicionada/removida, e-mail alterado).
 * Best-effort: no fallback (sem mail) loga o evento; nunca lança.
 */
export async function sendSecurityNoticeEmail(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  data: {
    email: string;
    kind:
      | 'password_changed'
      | 'mfa_enabled'
      | 'mfa_disabled'
      | 'passkey_added'
      | 'passkey_removed'
      | 'email_changed';
    timestamp: string;
    ip?: string | null;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const origin = authkitOrigin(cfg);
    const kindKey = `mail.security_notice.kind_${data.kind}`;
    const kindLabel = translate(t, kindKey);
    const intro = [
      translate(t, 'mail.security_notice.intro', { kind: kindLabel }),
      translate(t, 'mail.security_notice.when', { date: data.timestamp }),
    ];
    if (data.ip) intro.push(translate(t, 'mail.security_notice.ip', { ip: data.ip }));
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.security_notice.subject', { kind: kindLabel }),
      heading: translate(t, 'mail.security_notice.heading'),
      intro: intro.join(' '),
      ctaLabel: translate(t, 'account.security.title'),
      ctaUrl: `${origin}${accountPath('security')}`,
      footnote: translate(t, 'mail.security_notice.fallback'),
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { kind: data.kind, email: data.email },
        'authkit: notificação de segurança (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email, kind: data.kind },
      'authkit: falha ao enviar notificação de segurança',
    );
  }
}

/**
 * Envia o e-mail de desbloqueio do fator OTP (quando TOTP/recovery excede maxAttempts).
 * Best-effort: no fallback (sem mail) loga o link; nunca lança.
 */
export async function sendOtpUnlockEmail(
  ctx: HttpContext,
  data: { email: string; unlockUrl: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.otp_unlock.subject'),
      heading: translate(t, 'mail.otp_unlock.heading'),
      intro: translate(t, 'mail.otp_unlock.intro'),
      ctaLabel: translate(t, 'mail.otp_unlock.cta'),
      ctaUrl: data.unlockUrl,
      footnote: translate(t, 'mail.otp_unlock.fallback'),
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { unlockUrl: data.unlockUrl, email: data.email },
        'authkit: link de desbloqueio OTP (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar e-mail de desbloqueio OTP',
    );
  }
}

/**
 * Envia o e-mail de verificação pelo mailer default do host.
 * Best-effort: no fallback (sem mail) loga o link; nunca lança.
 */
export async function sendEmailVerificationEmail(
  ctx: HttpContext,
  data: { email: string; verifyUrl: string },
): Promise<void> {
  try {
    const brand = resolveBrand(ctx);
    const { messages: t, locale } = resolveMailMessages(ctx);
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.verify.subject'),
      heading: translate(t, 'mail.verify.heading'),
      intro: translate(t, 'mail.verify.intro'),
      ctaLabel: translate(t, 'mail.verify.cta'),
      ctaUrl: data.verifyUrl,
    });
    const sent = await sendEmail(ctx, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { verifyUrl: data.verifyUrl, email: data.email },
        'authkit: link de verificação de e-mail (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar verificação de e-mail',
    );
  }
}
