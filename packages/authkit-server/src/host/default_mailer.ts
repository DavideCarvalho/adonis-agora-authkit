import type { HttpContext } from '@adonisjs/core/http';
import { getBootedApp } from '../../services/booted_app.js';
import type { ResolvedServerConfig } from '../define_config.js';
import { accountPath } from './account_paths.js';
import type { BrandingConfig } from './branding.js';
import { type EmailContent, renderTransactionalEmail } from './email_templates.js';
import { type AuthMessages, resolveMessages, translate } from './i18n.js';
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
 * O que os e-mails default precisam do config: marca, catálogo i18n + locale e o `from`.
 */
interface MailSettings {
  brand: { appName: string; accent?: string; company?: string };
  messages: AuthMessages;
  locale: string;
  from?: { address: string; name?: string } | string;
}

/** Algo com `make` — `ctx.containerResolver`, `app.container`. */
type Maker = { make?: (binding: string) => Promise<unknown> };

let warnedUnresolved = false;

/**
 * Permite rearmar o warning "config não resolvido" (usado em testes).
 * @internal
 */
export function __resetMailConfigWarningForTests(): void {
  warnedUnresolved = false;
}

/**
 * Encontra o config RESOLVIDO do authkit (`ResolvedServerConfig`).
 *
 * Por que não `ctx.containerResolver.app.config.get('authkit')`, como antes: o
 * `ContainerResolver` do `@adonisjs/fold` não tem `.app` — então numa request real
 * esse caminho dava `undefined` SEMPRE e todo e-mail default saía em `en` com a marca
 * "AuthKit". E mesmo onde há um `app` (o ctx do SDK embedded), `config.get('authkit')`
 * devolve o `ConfigProvider` preguiçoso do `defineConfig`, não o config resolvido —
 * `.i18n`/`.branding`/`.mail` nunca existem nele.
 *
 * Ordem: o `cfg` que o chamador já tem → o binding `authkit.server` pelo container da
 * request → pelo `app.container` do ctx → pelo app bootado capturado pelo provider.
 */
async function resolveServerConfig(
  ctx: HttpContext,
  cfg: ResolvedServerConfig | undefined,
): Promise<ResolvedServerConfig | undefined> {
  if (cfg) return cfg;
  const resolver = ctx?.containerResolver as unknown as
    | (Maker & { app?: { container?: Maker } })
    | undefined;
  const containers: Array<() => Maker | undefined> = [
    () => resolver,
    () => resolver?.app?.container,
    () => getBootedApp().container as unknown as Maker,
  ];
  for (const container of containers) {
    try {
      const maker = container();
      if (typeof maker?.make !== 'function') continue;
      const service = (await maker.make('authkit.server')) as
        | { config?: ResolvedServerConfig }
        | undefined;
      if (service?.config) return service.config;
    } catch {
      // tenta o próximo; a falha final é avisada em `resolveMailSettings`.
    }
  }
  return undefined;
}

/**
 * O `from` global do `config/mail.ts` do host (um objeto simples, não um provider),
 * lido do `app` do ctx (SDK embedded) ou do app bootado. Ausente → `undefined`, e o
 * `@adonisjs/mail` decide.
 */
function hostMailFrom(ctx: HttpContext): MailSettings['from'] {
  type ConfigReader = { config?: { get?: (key: string) => { from?: unknown } | undefined } };
  const apps: Array<() => ConfigReader | undefined> = [
    () => (ctx?.containerResolver as unknown as { app?: ConfigReader } | undefined)?.app,
    () => getBootedApp() as unknown as ConfigReader,
  ];
  for (const app of apps) {
    try {
      const from = app()?.config?.get?.('mail')?.from as MailSettings['from'];
      if (from) return from;
    } catch {
      // sem app/config de mail — tenta o próximo.
    }
  }
  return undefined;
}

/**
 * Marca, i18n e `from` dos e-mails default, a partir do config resolvido.
 *
 * Sem config resolvível cai num default neutro (`en`, "AuthKit") — mas NUNCA em
 * silêncio: avisa uma vez por processo, porque um e-mail no idioma/marca errados é
 * exatamente o tipo de bug que só aparece na caixa de entrada de um usuário.
 */
async function resolveMailSettings(
  ctx: HttpContext,
  cfg: ResolvedServerConfig | undefined,
): Promise<MailSettings> {
  const resolved = await resolveServerConfig(ctx, cfg);
  if (!resolved) {
    if (!warnedUnresolved) {
      warnedUnresolved = true;
      const message =
        'authkit: config do authkit não resolvido para os e-mails default — usando locale `en` e a marca "AuthKit". Registre o AuthkitServerProvider ou passe o config resolvido.';
      if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message);
      else console.warn(message);
    }
    return { brand: { appName: 'AuthKit' }, messages: resolveMessages(), locale: 'en' };
  }
  const branding = resolved.branding as Partial<BrandingConfig> | undefined;
  return {
    brand: {
      // `branding.default` é opcional na prática (hosts declaram só `company` + `clients`):
      // sem ele, o nome do app é a `company`.
      appName: branding?.default?.appName || branding?.company || 'AuthKit',
      accent: branding?.default?.accent,
      company: branding?.company,
    },
    messages: resolved.messages ?? resolveMessages(),
    locale: resolved.locale ?? 'en',
    // `from` próprio do authkit tem prioridade; senão o `from` global do `config/mail.ts`.
    from: resolved.mail?.from ?? hostMailFrom(ctx),
  };
}

async function sendEmail(
  settings: MailSettings,
  to: string,
  content: EmailContent,
): Promise<boolean> {
  const mail = await loadMail();
  if (!mail) return false;
  const { from } = settings;
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
  cfg?: ResolvedServerConfig,
): Promise<void> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
  cfg?: ResolvedServerConfig,
): Promise<void> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
  cfg?: ResolvedServerConfig,
): Promise<void> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
 * Envia um e-mail só com um código (sem link: quem digita é a pessoa, em outro lugar) pelo mailer
 * default do host, com o branding e o i18n do authkit. Os textos saem do catálogo pelas chaves
 * `{messages}.subject`, `.heading`, `.intro`, `.code_label` e `.fallback`, com `params`
 * interpolados — uma extension registra as dela em `messages`. Best-effort: sem `@adonisjs/mail`
 * loga o código (dev); nunca lança.
 *
 * Estável no 1.x (é o mailer das `personalAgents.extensions`).
 */
export async function sendAuthkitCodeEmail(
  ctx: HttpContext,
  data: {
    email: string;
    code: string;
    /** Prefixo das chaves no catálogo (`'mail.poppy_sign_in'`). */
    messages: string;
    params?: Record<string, string | number>;
  },
  cfg?: ResolvedServerConfig,
): Promise<void> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
    const key = (name: string) => `${data.messages}.${name}`;
    const content = renderTransactionalEmail({
      brand,
      locale,
      subject: translate(t, key('subject'), data.params),
      heading: translate(t, key('heading'), data.params),
      intro: translate(t, key('intro'), data.params),
      footnote: translate(t, key('fallback'), data.params),
      code: data.code,
      codeLabel: translate(t, key('code_label'), data.params),
    });
    const sent = await sendEmail(settings, data.email, content);
    if (!sent) {
      ctx.logger.info(
        { email: data.email, code: data.code, messages: data.messages, ...(data.params ?? {}) },
        'authkit: código por e-mail (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger.error(
      { err: error, email: data.email, messages: data.messages },
      'authkit: falha ao enviar o e-mail com código',
    );
  }
}

/**
 * Envia o link de CONFIRMAÇÃO DE IDENTIDADE (sudo) pelo mailer default do host.
 *
 * POR QUE EXISTE. `sudoMethods.magicLink()` dependia EXCLUSIVAMENTE do hook
 * `mail.onSudoLink`, e sem ele o método se declarava indisponível. Num host
 * passwordless isso fechava o deadlock: sem senha, sem passkey e sem hook, a
 * tela `/account/confirm` não tinha um único método satisfazível — e o usuário
 * ficava trancado fora de exportar/excluir os próprios dados, do MFA, dos PATs
 * e da troca de e-mail, inclusive do cadastro de passkey que destravaria tudo.
 *
 * A postura aqui é a MESMA de todos os outros e-mails da lib (reset de senha,
 * verificação, magic link de login, avisos de segurança): o hook do host, quando
 * existe, tem prioridade; sem hook, o próprio host-kit envia pelo mailer default
 * (`@adonisjs/mail`) com branding e i18n; sem mailer, loga o link (dev).
 *
 * O TOKEN continua sendo o de sudo — emitido e verificado em
 * `sudo/methods/magic_link.ts`, hasheado na sessão que pediu, de uso único,
 * 5 min, vinculado ao `accountId` emissor. Isto aqui é só ENTREGA; nada é
 * compartilhado com o token de login.
 *
 * @returns `true` quando o e-mail foi entregue ao mailer (ou logado no fallback
 * de dev) e `false` quando o envio falhou de verdade. O chamador PRECISA disso:
 * ao contrário dos outros e-mails da lib, um link de sudo que não saiu tem de
 * apagar o pendente da sessão e recusar — flashar "link enviado" deixaria o
 * usuário esperando um e-mail que nunca vem, na tela que já é o gargalo dele.
 */
export async function sendSudoLinkEmail(
  ctx: HttpContext,
  data: { email: string; sudoUrl: string },
  cfg?: ResolvedServerConfig,
): Promise<boolean> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.sudo_link.subject'),
      heading: translate(t, 'mail.sudo_link.heading'),
      intro: translate(t, 'mail.sudo_link.intro'),
      ctaLabel: translate(t, 'mail.sudo_link.cta'),
      ctaUrl: data.sudoUrl,
      footnote: translate(t, 'mail.sudo_link.fallback'),
    });
    const sent = await sendEmail(settings, data.email, content);
    if (!sent) {
      ctx.logger?.info(
        { sudoUrl: data.sudoUrl, email: data.email },
        'authkit: link de confirmação de identidade (dev — @adonisjs/mail ausente)',
      );
    }
    return true;
  } catch (error) {
    ctx.logger?.error(
      { err: error, email: data.email },
      'authkit: falha ao enviar link de confirmação de identidade',
    );
    return false;
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
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.oldEmail, content);
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
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
  cfg?: ResolvedServerConfig,
): Promise<void> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
 * Sends the organization invitation email through the host default mailer.
 *
 * WHY IT EXISTS. `mail.onOrgInvitation` used to be the ONLY hook without a
 * default-mailer fallback: without it the invitation row was created and NO
 * email was ever sent — a silent failure where the invited person never learned
 * about the invitation. This restores the same posture as every other email of
 * the library: the host hook wins when present, otherwise the host-kit itself
 * sends a branded/translated email; with no mailer at all, the link is logged (dev).
 *
 * Best-effort: never throws — invitation creation must not depend on delivery.
 */
export async function sendOrgInvitationEmail(
  ctx: HttpContext,
  data: {
    email: string;
    invitationId: string;
    orgName: string;
    orgSlug: string;
    role: string;
    acceptUrl: string;
    token: string;
  },
  cfg?: ResolvedServerConfig,
): Promise<void> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
    const content = renderTransactionalEmail({
      brand,
      locale,
      linkFallback: translate(t, 'mail.common.link_fallback'),
      subject: translate(t, 'mail.org_invitation.subject', { org: data.orgName }),
      heading: translate(t, 'mail.org_invitation.heading', { org: data.orgName }),
      intro: translate(t, 'mail.org_invitation.intro', { org: data.orgName, role: data.role }),
      ctaLabel: translate(t, 'mail.org_invitation.cta'),
      ctaUrl: data.acceptUrl,
      footnote: translate(t, 'mail.org_invitation.fallback'),
    });
    const sent = await sendEmail(settings, data.email, content);
    if (!sent) {
      ctx.logger?.info(
        {
          acceptUrl: data.acceptUrl,
          email: data.email,
          orgSlug: data.orgSlug,
          invitationId: data.invitationId,
        },
        'authkit: convite de organização (dev — @adonisjs/mail ausente)',
      );
    }
  } catch (error) {
    ctx.logger?.error(
      { err: error, email: data.email, orgSlug: data.orgSlug },
      'authkit: falha ao enviar convite de organização',
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
  cfg?: ResolvedServerConfig,
): Promise<void> {
  try {
    const settings = await resolveMailSettings(ctx, cfg);
    const { brand, messages: t, locale } = settings;
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
    const sent = await sendEmail(settings, data.email, content);
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
