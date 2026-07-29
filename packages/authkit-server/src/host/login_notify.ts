import type { HttpContext } from '@adonisjs/core/http';
import type { ResolvedServerConfig } from '../define_config.js';
import { sendNewDeviceLoginEmail, sendNewLoginEmail } from './default_mailer.js';
import { TRUSTED_DEVICE_COOKIE, isTrustedDeviceValid } from './trusted_device.js';

/** Dados de um login bem-sucedido a auditar/notificar. */
export interface LoginSuccessInput {
  accountId: string;
  email?: string | null;
  ip?: string | null;
  clientId?: string | null;
  /**
   * Sinal "dispositivo já confiável" quando o caller JÁ resolveu o cookie de
   * confiança (ex.: o controller pulou o MFA por causa dele). Quando omitido, a
   * notificação resolve o cookie por conta própria (best-effort). `true` =
   * dispositivo conhecido → NÃO notifica novo dispositivo.
   */
  trustedDevice?: boolean;
  /** Metadata extra a anexar ao evento login.success (ex.: { mfa: 'totp' }). */
  metadata?: Record<string, unknown>;
}

/**
 * Centraliza o pós-login bem-sucedido: registra o evento `login.success` e dispara
 * (best-effort) o alerta de NOVO acesso quando o IP nunca foi visto para a conta.
 *
 * É fire-and-forget e FAIL-SAFE: a notificação roda DEPOIS do audit e qualquer erro
 * é engolido — NUNCA bloqueia nem lança no caminho do login. Substitui as chamadas
 * `cfg.audit?.record({ type: 'login.success', ... })` espalhadas pelos controllers.
 */
export async function notifyLoginSuccess(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  input: LoginSuccessInput,
): Promise<void> {
  const { accountId, email, ip, clientId, metadata, trustedDevice } = input;

  // User-agent da request: anexado ao `login.success` em `metadata.userAgent` para
  // dar contexto de dispositivo às sessões (o admin/account o lê via join por
  // accountId+loginTs). Sem migração — usa a coluna JSON `metadata` já existente.
  const ua = ctx.request.header?.('user-agent') ?? null;

  // 1) Audit do login.success (mesmo formato de antes + userAgent em metadata).
  await cfg.audit?.record({
    type: 'login.success',
    accountId,
    email: email ?? null,
    ip: ip ?? null,
    clientId: clientId ?? null,
    metadata: ua ? { ...(metadata ?? {}), userAgent: ua } : metadata,
  });

  // 2) Sinal de DISPOSITIVO NOVO: login sem cookie de confiança válido para a
  //    conta. Auditamos `login.new_device` (mesmo sem mail configurado) e, se
  //    `notifications.newDeviceEmail`, enviamos o alerta. Resolvido aqui (síncrono
  //    com o audit) porque depende do cookie da REQUEST atual; o e-mail em si é
  //    fire-and-forget. `trustedDevice === true` (o caller já decidiu) pula tudo.
  const onNewDevice = trustedDevice === true ? false : !hasTrustedDeviceCookie(ctx, accountId);
  if (onNewDevice) {
    await cfg.audit?.record({
      type: 'login.new_device',
      accountId,
      email: email ?? null,
      ip: ip ?? null,
      clientId: clientId ?? null,
    });
  }

  const userAgent = ua;

  // 3) Alertas por e-mail (fire-and-forget): nunca propaga erro pro login.
  if (!cfg.notifications.newLoginEmail && !(onNewDevice && cfg.notifications.newDeviceEmail))
    return;
  void (async () => {
    // Resolve o e-mail quando o caller não o forneceu (ex.: fluxo de MFA só tem o
    // accountId em escopo). Best-effort.
    let resolvedEmail = email ?? null;
    if (!resolvedEmail) {
      resolvedEmail = (await cfg.accountStore.findById(accountId))?.email ?? null;
    }
    if (cfg.notifications.newLoginEmail) {
      await maybeNotifyNewLogin(ctx, cfg, { accountId, email: resolvedEmail, ip: ip ?? null });
    }
    if (onNewDevice && cfg.notifications.newDeviceEmail && resolvedEmail) {
      await notifyNewDevice(ctx, cfg, {
        accountId,
        email: resolvedEmail,
        ip: ip ?? null,
        userAgent,
      });
    }
  })().catch((error) => {
    // Defensivo: o próprio handler de erro nunca pode lançar (logger pode faltar
    // em contextos mínimos). Best-effort.
    ctx.logger?.error?.({ err: error, accountId }, 'authkit: falha no alerta de login');
  });
}

/**
 * `true` se há um cookie de dispositivo confiável VÁLIDO (estrutura íntegra, conta
 * casa, não expirou) para `accountId`. Best-effort: qualquer erro de leitura →
 * `false` (tratado como dispositivo novo). NÃO checa o re-enrollment de MFA
 * (mfaEnabledAt) — o sinal de "dispositivo conhecido" é a mera presença de um
 * cookie de confiança válido, independente do estado do MFA.
 */
function hasTrustedDeviceCookie(ctx: HttpContext, accountId: string): boolean {
  try {
    const payload = ctx.request.encryptedCookie?.(TRUSTED_DEVICE_COOKIE);
    return isTrustedDeviceValid(payload, { accountId });
  } catch {
    return false;
  }
}

/**
 * Envia o alerta de NOVO DISPOSITIVO: usa o hook `mail.onNewDeviceLogin` (override
 * do host) ou o mailer default. Best-effort — qualquer erro é engolido (já estamos
 * dentro do fire-and-forget de {@link notifyLoginSuccess}).
 */
async function notifyNewDevice(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  data: { accountId: string; email: string; ip: string | null; userAgent: string | null },
): Promise<void> {
  const timestamp = new Date().toISOString();
  if (cfg.mail?.onNewDeviceLogin) {
    await cfg.mail.onNewDeviceLogin({
      account: { id: data.accountId, email: data.email },
      ip: data.ip,
      userAgent: data.userAgent,
      timestamp,
    });
    return;
  }
  await sendNewDeviceLoginEmail(ctx, cfg, {
    email: data.email,
    ip: data.ip,
    userAgent: data.userAgent,
    when: timestamp,
  });
}

/**
 * Verifica se o IP é novo para a conta (consultando o audit sink por
 * `login.success` do subject) e, se for, envia o e-mail de alerta + audita
 * `login.new_ip_notified`. Degrada para no-op quando: sem IP, sem e-mail, sem
 * sink consultável (`list`), ou já houve um login.success deste IP antes.
 */
async function maybeNotifyNewLogin(
  ctx: HttpContext,
  cfg: ResolvedServerConfig,
  data: { accountId: string; email: string | null; ip: string | null },
): Promise<void> {
  const { accountId, email, ip } = data;
  if (!ip || !email) return;
  // Sem consulta do histórico não dá pra decidir se o IP é novo → no-op.
  if (typeof cfg.audit?.list !== 'function') return;

  // Lê o histórico de login.success do subject. O evento ATUAL já foi gravado por
  // notifyLoginSuccess, então um IP visto antes aparece com count >= 2 para o IP.
  // Buscamos uma página ampla e contamos as ocorrências deste IP.
  const page = await cfg.audit.list({
    type: 'login.success',
    subject: accountId,
    page: 1,
    limit: 200,
  });
  const sameIpCount = page.data.filter((e) => e.ip === ip).length;
  // > 1 significa que já havia um login.success deste IP antes do atual → não é novo.
  if (sameIpCount > 1) return;

  const when = new Date().toISOString();
  await sendNewLoginEmail(ctx, cfg, { email, ip, when });
  await cfg.audit?.record({
    type: 'login.new_ip_notified',
    accountId,
    email,
    ip,
  });
}
