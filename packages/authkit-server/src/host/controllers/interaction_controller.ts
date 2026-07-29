import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import {
  supportsMagicLink,
  supportsOtpLogin,
  supportsPasskeys,
} from '../../accounts/account_store.js';
import type { ResolvedServerConfig } from '../../define_config.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { guardBotProtection, resolveEffectiveBotProtection } from '../bot_protection.js';
import { brandFor, isFirstParty } from '../branding.js';
import { sendMagicLinkEmail } from '../default_mailer.js';
import { sendOtpUnlockEmail } from '../default_mailer.js';
import { translate } from '../i18n.js';
import type { AccountStatusReason } from '../login_attempt.js';
import {
  assertLoginAllowed,
  attemptPasswordLogin,
  isEmailUnverifiedBlock,
} from '../login_attempt.js';
import { magicChannelProp, normalizeLoginChannel } from '../login_channel.js';
import { notifyLoginSuccess } from '../login_notify.js';
import { authkitOrigin } from '../origin.js';
import {
  createOtpLockout,
  generateOtpUnlockToken,
  rawToDbOtpUnlockToken,
  resolveEffectiveOtpLockout,
} from '../otp_lockout.js';
import { RuntimeSettings, resolveRuntimeSettings } from '../runtime_settings.js';
import {
  resolveEffectiveAuthMethods,
  resolveEffectiveMaintenanceMode,
  resolveEffectiveRegistration,
  resolveEffectiveSessionPolicy,
} from '../runtime_toggles.js';
import {
  TRUSTED_DEVICE_COOKIE,
  buildTrustedDevicePayload,
  isTrustedDeviceValid,
} from '../trusted_device.js';

/**
 * Best-effort: returns a RuntimeSettings backed by the container DB, or a no-op
 * fallback. Contrato NON-NULL preservado — é chamado 6× passando direto p/
 * funções que exigem `SettingsCapability` non-null. Reusa a fábrica canônica
 * `resolveRuntimeSettings` e degrada para o RuntimeSettings no-op (probe via
 * SELECT lança → tabela ausente → config fallback) quando a resolução falha.
 */
async function getRuntimeSettings(ctx: HttpContext): Promise<RuntimeSettings> {
  const rs = await resolveRuntimeSettings(ctx);
  return (
    rs ??
    new RuntimeSettings({
      table: () => {
        throw new Error('no-op');
      },
    })
  );
}

/**
 * Chave i18n do erro de status de conta (disabled/expired) compartilhada pelos
 * fluxos passwordless (magic link, OTP, passkey). `password_expired` reaproveita
 * o texto do passo de troca obrigatória (`login.password_expired_intro`) — estes
 * fluxos não têm essa etapa, então falham fechado com uma mensagem ainda coerente
 * em vez de inventar uma nova chave de tradução.
 */
function accountStatusErrorKey(reason: AccountStatusReason): string {
  switch (reason) {
    case 'disabled':
      return 'errors.account_disabled';
    case 'account_expired':
      return 'errors.account_expired';
    case 'password_expired':
      return 'login.password_expired_intro';
  }
}

const SESSION_KEY = 'authkit_login_email';
/** accountId aguardando o 2º fator depois da senha verificada. */
const MFA_PENDING_KEY = 'authkit_mfa_pending';
/** Desafio WebAuthn pendente (autenticação) guardado entre begin/finish no login. */
const PASSKEY_AUTH_CHALLENGE_KEY = 'authkit_passkey_auth_challenge';

export default class AuthInteractionController {
  /**
   * Métodos de login efetivos (com os pins do `cfg.authMethods`) para QUALQUER render do
   * passo login. Sem isto, os re-renders (erro de senha, magic link enviado, lockout…) mandam
   * `authMethods` undefined → a view volta ao default (senha ligada), ignorando a config.
   * `passkeyFirst` depende da conta (resolvido no fluxo principal); aqui cobrimos senha + magic link.
   *
   * `otpEnabled` (disponibilidade do login por OTP: config ligada E store com a
   * capacidade) também sai daqui — é um FATO de disponibilidade de método de login,
   * como `magicLinkAvailable`. Assim TODO render do passo login (identifier, seletor
   * choose-first, magicLinkSent, erro) carrega a flag POR CONSTRUÇÃO: o seletor
   * precisa dela para oferecer a opção "código" ANTES do envio do magic link.
   *
   * `runtimeSettings` pode ser passado já resolvido (ex.: o `show()` já resolveu para
   * maintenance) para evitar uma segunda resolução; ausente, resolve sob demanda.
   */
  async #loginMethods(
    ctx: HttpContext,
    cfg: ResolvedServerConfig,
    runtimeSettings?: RuntimeSettings,
  ) {
    const settings = runtimeSettings ?? (await getRuntimeSettings(ctx));
    const magicLinkCapableConfig =
      cfg.passwordless.magicLink && supportsMagicLink(cfg.accountStore);
    const authMethods = await resolveEffectiveAuthMethods(settings, {
      configuredSocialProviders: cfg.social?.providers ?? [],
      magicLinkCapable: magicLinkCapableConfig,
      passkeyCapable: false,
      configOverrides: cfg.authMethods,
    });
    const otpEnabled = cfg.login.otp.enabled && supportsOtpLogin(cfg.accountStore);
    return {
      authMethods,
      magicLinkAvailable: authMethods.magicLink && magicLinkCapableConfig,
      otpEnabled,
    };
  }

  async show(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(
      cfg.branding!,
      details.params.client_id as string | undefined,
      details.params.audience as string | undefined,
    );

    // Maintenance mode: verifica se é uma conta admin antes de bloquear.
    // Contas admin continuam podendo logar para que o operador possa desligar a
    // manutenção via console. Contas comuns veem a tela de manutenção.
    const runtimeSettingsForMaintenance = await getRuntimeSettings(ctx);
    const maintenance = await resolveEffectiveMaintenanceMode(runtimeSettingsForMaintenance);
    if (maintenance.enabled) {
      // Verifica se já há uma conta admin na sessão (já autenticado) OU
      // se o prompt não é de login — nesse caso, permite prosseguir.
      // Para o prompt de login: permite continuar sem bloquear; o guard real
      // está no POST. Dessa forma o admin pode inserir email/senha normalmente.
      // A tela de manutenção é exibida apenas para o prompt de login quando
      // não há indicação de conta admin (antes de autenticar não sabemos a role).
      // Decisão: exibimos a tela de manutenção SOMENTE se não for conta admin.
      // Como não sabemos a role antes de autenticar, exibimos a tela com uma nota
      // de que admins podem continuar — o POST real tem o guard.
      if (details.prompt.name === 'login') {
        return render(ctx, 'maintenance', {
          uid: details.uid,
          csrfToken: ctx.request.csrfToken,
          message: maintenance.message ?? translate(cfg.messages, 'maintenance.default_message'),
          brand,
          adminLoginAllowed: true,
          adminLoginNote: translate(cfg.messages, 'maintenance.admin_login_note'),
        });
      }
    }

    if (
      details.prompt.name === 'consent' &&
      isFirstParty(cfg.branding!, details.params.client_id as string | undefined)
    ) {
      // Clients first-party: auto-concede o consent (pula a tela de consent).
      // interactions.consent monta o Grant + interactionFinished e escreve o
      // redirect de volta para o client — opera via provider.interactionDetails,
      // independente do metodo HTTP, entao funciona no GET show().
      return await service.interactions.consent(ctx);
    }

    if (details.prompt.name !== 'login') {
      // Consent or other prompts — unchanged
      return render(ctx, 'consent', {
        uid: details.uid,
        params: details.params,
        csrfToken: ctx.request.csrfToken,
        brand,
      });
    }

    const email = ctx.session.get(SESSION_KEY) as string | undefined;

    // Métodos de login efetivos (magic link, OTP, social) — account-independent
    // neste ponto (passkey-first depende da conta, resolvido no step 2). Reusa o
    // helper compartilhado por TODOS os renders do passo login, para que
    // `authMethods`, `magicLinkAvailable` e `otpEnabled` saiam POR CONSTRUÇÃO
    // (o seletor choose-first precisa de `otpEnabled` para oferecer "código").
    // Passa o runtimeSettings já resolvido para maintenance (sem 2ª resolução).
    const loginMethods = await this.#loginMethods(ctx, cfg, runtimeSettingsForMaintenance);
    const authMethods = loginMethods.authMethods;

    if (!email) {
      // Step 1: identifier (email only).
      // Resolve registration enabled to hide "create account" link when closed.
      const registrationEnabled = await resolveEffectiveRegistration(
        cfg.registration?.enabled ?? true,
        runtimeSettingsForMaintenance,
      );
      return render(ctx, 'login', {
        ...loginMethods,
        uid: details.uid,
        csrfToken: ctx.request.csrfToken,
        step: 'identifier',
        registrationEnabled,
        brand,
      });
    }

    // Step 2: password — look up user for personalisation (enumeration-safe: always show step 2)
    const acc = await cfg.accountStore.findByEmail(email);
    const account = acc ? { fullName: acc.name ?? null, globalRoles: acc.globalRoles ?? [] } : null;

    // Passwordless: magic link disponível vem do helper (`loginMethods`).
    // Passkey-first disponível se ligado, o store suporta, a conta tem passkeys E auth_methods permite.
    const passkeyFirstCapable =
      cfg.passwordless.passkeyFirst && !!acc && (await this.hasPasskeys(cfg, acc.id));
    const passkeyFirstAvailable = authMethods.passkey && passkeyFirstCapable;

    // Effective bot protection: may be overridden at runtime via auth_settings.
    const effectiveBot = await resolveEffectiveBotProtection(
      cfg.botProtection,
      await getRuntimeSettings(ctx),
    );

    // Session policy: resolve para exibir o checkbox "manter conectado".
    const sessionPolicyForShow = await resolveEffectiveSessionPolicy(
      runtimeSettingsForMaintenance,
      cfg.ttl?.session ? Math.ceil(cfg.ttl.session / 3600) : undefined,
    );

    return render(ctx, 'login', {
      ...loginMethods,
      uid: details.uid,
      csrfToken: ctx.request.csrfToken,
      step: 'password',
      email,
      account,
      brand,
      passkeyFirstAvailable,
      botProtection: effectiveBot?.on.includes('login') ? effectiveBot.widget : undefined,
      rememberEnabled: sessionPolicyForShow.rememberEnabled,
      rememberDays: sessionPolicyForShow.rememberDays,
    });
  }

  /**
   * POST /auth/interaction/:uid/identifier
   * Step 1: receive email, store in session, redirect to step 2.
   * ENUMERATION-SAFE: always advances regardless of whether the email exists.
   */
  async identifier(ctx: HttpContext) {
    const { email } = ctx.request.only(['email']);
    ctx.session.put(SESSION_KEY, email);
    return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
  }

  /**
   * POST /auth/interaction/:uid/login
   * Step 2: password submit. Reads email from session (never from form).
   */
  async login(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(
      cfg.branding!,
      details.params.client_id as string | undefined,
      details.params.audience as string | undefined,
    );
    const email = ctx.session.get(SESSION_KEY) as string | undefined;
    if (!email) {
      // Session expired or tampered — send back to step 1
      return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
    }

    const { password } = ctx.request.only(['password']);
    const ip = ctx.request.ip?.() ?? null;
    const clientId = (details.params.client_id as string | undefined) ?? null;

    // Resolve runtime settings (reutilizado por bot + maintenance + verifiedEmail + session_policy).
    const runtimeSettings = await getRuntimeSettings(ctx);

    // Maintenance mode: verifica se a conta que tenta logar é admin.
    // Admins CONTINUAM podendo logar (senão o operador se tranca fora).
    // A verificação de role acontece APÓS as credenciais (senha correta primeiro).
    const maintenance = await resolveEffectiveMaintenanceMode(runtimeSettings);

    // Effective bot protection: may be overridden at runtime via auth_settings.
    const effectiveBotLogin = await resolveEffectiveBotProtection(
      cfg.botProtection,
      runtimeSettings,
    );

    // Bot protection (plugável): valida o token do widget ANTES de tocar nas
    // credenciais. Fail-safe: erro/timeout no verify do host PERMITE o fluxo.
    // We use a cfg-compatible object: pass effectiveBotLogin merged into cfg.
    const cfgWithEffectiveBot =
      effectiveBotLogin !== cfg.botProtection ? { ...cfg, botProtection: effectiveBotLogin } : cfg;
    if (
      !(await guardBotProtection(ctx, cfgWithEffectiveBot as any, 'login', { email, clientId }))
    ) {
      const found = await cfg.accountStore.findByEmail(email);
      const account = found
        ? { fullName: found.name ?? null, globalRoles: found.globalRoles ?? [] }
        : null;
      return render(ctx, 'login', {
        ...(await this.#loginMethods(ctx, cfg)),
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        step: 'password',
        email,
        account,
        error: translate(cfg.messages, 'errors.bot_protection_failed'),
        brand,
        botProtection: effectiveBotLogin?.widget,
      });
    }

    // Verificamos as credenciais ANTES de finalizar a interaction, porque com MFA
    // ligado precisamos exigir o 2º fator e NÃO podemos chamar interactionFinished
    // ainda. A sequência verificação + lockout + auditoria de falha é centralizada
    // em attemptPasswordLogin; a renderização (lookup p/ personalização) fica aqui.
    const result = await attemptPasswordLogin(cfg, {
      email,
      password,
      ip,
      clientId,
      settings: runtimeSettings,
      logger: ctx.logger,
    });

    if (!result.ok) {
      // Senha expirada: redireciona para o step de troca obrigatória.
      if (result.passwordExpired && (result as any).account) {
        const expiredAcc = (result as any).account;
        const PASSWORD_EXPIRED_KEY = 'authkit_password_expired';
        ctx.session.put(PASSWORD_EXPIRED_KEY, expiredAcc.id);
        return render(ctx, 'login', {
          uid: ctx.request.param('uid'),
          csrfToken: ctx.request.csrfToken,
          step: 'password_expired',
          email,
          account: { fullName: expiredAcc.name ?? null, globalRoles: expiredAcc.globalRoles ?? [] },
          error: null,
          brand,
          botProtection: undefined,
        });
      }

      const found = await cfg.accountStore.findByEmail(email);
      const account = found
        ? { fullName: found.name ?? null, globalRoles: found.globalRoles ?? [] }
        : null;
      return render(ctx, 'login', {
        ...(await this.#loginMethods(ctx, cfg)),
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        step: 'password',
        email,
        account,
        error: result.locked
          ? translate(cfg.messages, 'errors.account_locked', {
              seconds: result.retryAfterSec ?? 0,
            })
          : result.disabled
            ? translate(cfg.messages, 'errors.account_disabled')
            : result.unverified
              ? translate(cfg.messages, 'errors.email_unverified')
              : result.accountExpired
                ? translate(cfg.messages, 'errors.account_expired')
                : translate(cfg.messages, 'errors.invalid_credentials'),
        brand,
        botProtection: effectiveBotLogin?.on.includes('login')
          ? effectiveBotLogin.widget
          : undefined,
      });
    }

    const acc = result.account;

    // Maintenance mode guard: credenciais válidas, mas manutenção ativa.
    // Contas admin (role em cfg.admin.roles) CONTINUAM podendo logar.
    // Contas comuns são bloqueadas com a tela de manutenção.
    if (maintenance.enabled) {
      const adminRoles: string[] = cfg.admin?.roles ?? ['ADMIN'];
      const accountRoles: string[] = acc.globalRoles ?? [];
      const isAdmin = adminRoles.some((r: string) => accountRoles.includes(r));
      if (!isAdmin) {
        return render(ctx, 'maintenance', {
          uid: details.uid,
          csrfToken: ctx.request.csrfToken,
          message: maintenance.message ?? translate(cfg.messages, 'maintenance.default_message'),
          brand,
          adminLoginAllowed: true,
          adminLoginNote: translate(cfg.messages, 'maintenance.admin_login_note'),
        });
      }
      // Admin: prossegue normalmente (sem bloqueio).
    }

    // Step-up auth (acr_values): o client pode EXIGIR MFA nesta requisição
    // solicitando o `mfaAcr` em acr_values, mesmo que a conta tenha MFA opcional.
    const mfaRequired = this.acrRequiresMfa(cfg, details);

    // MFA gate: força o 2º fator se a conta tem TOTP ativo OU se o client exige MFA
    // via acr. Não finaliza a interaction agora — guarda o accountId pendente.
    const mfa = (await cfg.accountStore.getMfaState?.(acc.id)) ?? { enabled: false };
    if (mfa.enabled || mfaRequired) {
      if (mfaRequired && !mfa.enabled) {
        // Client exige MFA mas a conta não tem MFA enrolado: bloqueia este login
        // com a instrução de configurar MFA no console (não há 2º fator a desafiar).
        return render(ctx, 'mfa-challenge', {
          uid: ctx.request.param('uid'),
          csrfToken: ctx.request.csrfToken,
          brand,
          passkeyAvailable: false,
          error: translate(cfg.messages, 'mfa_challenge.required_no_enrollment'),
          noEnrollment: true,
        });
      }
      // Trusted device: se o mecanismo está ligado, a conta JÁ tem MFA enrolado e
      // o request NÃO é um step-up (que sempre força o MFA), um cookie de confiança
      // válido para ESTA conta pula o 2º fator. amr fica `['pwd']` (sem acr de MFA).
      if (cfg.trustedDevices.enabled && mfa.enabled && !mfaRequired) {
        const trusted = await this.checkTrustedDevice(ctx, acc.id, mfa.enabledAt ?? null);
        if (trusted) {
          await service.interactions.completeLogin(ctx, acc.id, { amr: ['pwd'] });
          await notifyLoginSuccess(ctx, cfg, {
            accountId: acc.id,
            email,
            ip,
            clientId,
            trustedDevice: true,
          });
          ctx.session.forget(SESSION_KEY);
          return;
        }
      }

      ctx.session.put(MFA_PENDING_KEY, acc.id);
      // Passkey disponível como alternativa ao TOTP se o store suporta E a conta
      // tem ao menos uma credencial registrada.
      const passkeyAvailable = await this.hasPasskeys(cfg, acc.id);
      return render(ctx, 'mfa-challenge', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        brand,
        passkeyAvailable,
        trustedDevicesEnabled: cfg.trustedDevices.enabled,
        trustedDeviceDays: cfg.trustedDevices.days,
      });
    }

    // Sem MFA: finaliza a interaction (escreve o 303 de volta para o client).
    // Resolve session_policy para remember-me e single-session.
    const sessionPolicy = await resolveEffectiveSessionPolicy(
      runtimeSettings,
      cfg.ttl?.session ? Math.ceil(cfg.ttl.session / 3600) : undefined,
    );
    // remember-me: lê o checkbox do form. Checkbox HTML ausente/desmarcado = sem valor.
    // Quando rememberEnabled=false, ignora o checkbox (sessão sempre transiente).
    const rememberChecked = ctx.request.input('remember');
    const rememberOn =
      rememberChecked === 'on' ||
      rememberChecked === '1' ||
      rememberChecked === 'true' ||
      rememberChecked === true;
    const remember = sessionPolicy.rememberEnabled ? rememberOn : false;

    // single-session: lista sessões ANTES do login para saber quais existem.
    // Após o completeLogin, a sessão NOVA é criada; revogamos as ANTERIORES.
    // Obtemos os ids das sessões correntes para que possamos preservar a nova.
    let prevSessionIds: Set<string> = new Set();
    if (sessionPolicy.singleSession) {
      const sessionsSvc = new AdminSessionsService(service);
      if (sessionsSvc.canList) {
        const prev = await sessionsSvc.listSessions(acc.id);
        prevSessionIds = new Set(prev.map((s) => s.id));
      }
    }

    await service.interactions.completeLogin(ctx, acc.id, { remember });
    await notifyLoginSuccess(ctx, cfg, { accountId: acc.id, email, ip, clientId });

    // single-session: após o completeLogin, revoga sessões que existiam ANTES.
    // A sessão nova foi criada pelo provider no resume — ela NÃO está em prevSessionIds.
    if (sessionPolicy.singleSession && prevSessionIds.size > 0) {
      const sessionsSvc = new AdminSessionsService(service);
      if (sessionsSvc.canList) {
        const current = await sessionsSvc.listSessions(acc.id);
        const newSession = current.find((s) => !prevSessionIds.has(s.id));
        const exceptId = newSession?.id ?? '__none__';
        await sessionsSvc.revokeAllExcept(acc.id, exceptId);
        await cfg.audit?.record({
          type: 'session.single_enforced',
          accountId: acc.id,
          ip,
          clientId,
          metadata: { revokedCount: prevSessionIds.size },
        });
      }
    }

    // Clean up the session key after a successful login.
    ctx.session.forget(SESSION_KEY);
  }

  /**
   * POST /auth/interaction/:uid/mfa
   * 2º fator: lê o accountId pendente da sessão e aceita um código TOTP (`code`)
   * OU um recovery code (`recoveryCode`). Em caso de sucesso finaliza a interaction.
   */
  async mfaVerify(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(
      cfg.branding!,
      details.params.client_id as string | undefined,
      details.params.audience as string | undefined,
    );
    const accountId = ctx.session.get(MFA_PENDING_KEY) as string | undefined;
    const ip = ctx.request.ip?.() ?? null;
    const clientId = (details.params.client_id as string | undefined) ?? null;

    if (!accountId) {
      // Sessão expirou/foi adulterada — volta ao início do login.
      return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
    }

    const { code, recoveryCode } = ctx.request.only(['code', 'recoveryCode']);

    // Resolve OTP lockout settings (fail-safe).
    const runtimeForOtp = await getRuntimeSettings(ctx);
    const otpLockoutCfg = await resolveEffectiveOtpLockout(runtimeForOtp);
    const otpLockout = createOtpLockout(otpLockoutCfg, ctx.logger);

    // Verifica se o fator OTP está travado ANTES de tentar verificar.
    if (otpLockoutCfg.enabled && (await otpLockout.isLocked(accountId))) {
      return render(ctx, 'mfa-challenge', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'errors.otp_locked'),
        brand,
        passkeyAvailable: await this.hasPasskeys(cfg, accountId),
        trustedDevicesEnabled: cfg.trustedDevices.enabled,
        trustedDeviceDays: cfg.trustedDevices.days,
        otpLocked: true,
      });
    }

    let ok = false;
    let usedRecovery = false;
    if (recoveryCode) {
      ok = (await cfg.accountStore.consumeRecoveryCode?.(accountId, recoveryCode)) ?? false;
      usedRecovery = ok;
    } else if (code) {
      ok = (await cfg.accountStore.verifyTotp?.(accountId, code)) ?? false;
    }

    if (!ok) {
      await cfg.audit?.record({
        type: 'login.failure',
        accountId,
        ip,
        clientId,
        metadata: { stage: 'mfa' },
      });

      // Registra falha OTP e verifica se deve travar.
      const nowLocked = await otpLockout.recordFailure(accountId, { sink: cfg.audit, ip });

      if (nowLocked) {
        // Emite e-mail de desbloqueio (best-effort, fail-safe).
        await this.sendOtpUnlockEmailIfAble(ctx, cfg, accountId, otpLockoutCfg.unlockTtlHours);

        return render(ctx, 'mfa-challenge', {
          uid: ctx.request.param('uid'),
          csrfToken: ctx.request.csrfToken,
          error: translate(cfg.messages, 'errors.otp_locked'),
          brand,
          passkeyAvailable: await this.hasPasskeys(cfg, accountId),
          trustedDevicesEnabled: cfg.trustedDevices.enabled,
          trustedDeviceDays: cfg.trustedDevices.days,
          otpLocked: true,
        });
      }

      return render(ctx, 'mfa-challenge', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'errors.invalid_code'),
        brand,
        passkeyAvailable: await this.hasPasskeys(cfg, accountId),
        trustedDevicesEnabled: cfg.trustedDevices.enabled,
        trustedDeviceDays: cfg.trustedDevices.days,
      });
    }

    // Código correto: zera o contador de falhas OTP.
    await otpLockout.clearFailures(accountId);

    // Sucesso no 2º fator: opcionalmente confia neste dispositivo (checkbox).
    await this.maybeTrustDevice(ctx, cfg, accountId);
    // Finaliza a interaction para o accountId pendente.
    ctx.session.forget(MFA_PENDING_KEY);
    ctx.session.forget(SESSION_KEY);
    await notifyLoginSuccess(ctx, cfg, {
      accountId,
      ip,
      clientId,
      metadata: { mfa: usedRecovery ? 'recovery' : 'totp' },
    });
    // Step-up: um 2º fator foi de fato verificado — carimba acr/amr no id_token
    // se o client solicitou o mfaAcr nesta requisição.
    await service.interactions.completeLogin(
      ctx,
      accountId,
      this.stepUpExtra(cfg, details, usedRecovery ? 'recovery' : 'totp'),
    );
  }

  /**
   * true se o authorize request exige MFA via acr_values (contém o mfaAcr da
   * config de step-up). `acr_values` é a string separada por espaços padrão OIDC.
   */
  private acrRequiresMfa(cfg: any, details: any): boolean {
    const mfaAcr = cfg.stepUp?.mfaAcr as string | undefined;
    if (!mfaAcr) return false;
    const raw = details?.params?.acr_values;
    if (typeof raw !== 'string' || !raw) return false;
    return raw.split(/\s+/).includes(mfaAcr);
  }

  /**
   * Monta o acr/amr do step-up quando o client solicitou o mfaAcr e um 2º fator
   * foi verificado. `method` é o método do segundo fator (totp/recovery/webauthn).
   * Retorna `undefined` quando não há step-up — completeLogin usa o default.
   */
  private stepUpExtra(
    cfg: any,
    details: any,
    method: string,
  ): { acr: string; amr: string[] } | undefined {
    if (!this.acrRequiresMfa(cfg, details)) return undefined;
    return { acr: cfg.stepUp.mfaAcr, amr: ['mfa', method] };
  }

  /** true se o store suporta passkeys E a conta tem ao menos uma registrada. */
  private async hasPasskeys(cfg: any, accountId: string): Promise<boolean> {
    if (!supportsPasskeys(cfg.accountStore)) return false;
    const list = await cfg.accountStore.listPasskeys(accountId);
    return Array.isArray(list) && list.length > 0;
  }

  /**
   * Lê o cookie de dispositivo confiável (encriptado, appKey-backed) e valida que
   * pertence a `accountId`, não expirou e é posterior ao último (re)enrollment de
   * MFA. Step-up NÃO chama isto (força sempre o MFA). Best-effort: qualquer erro de
   * leitura → não confiável.
   */
  private async checkTrustedDevice(
    ctx: HttpContext,
    accountId: string,
    mfaEnabledAt: number | null,
  ): Promise<boolean> {
    try {
      const payload = ctx.request.encryptedCookie(TRUSTED_DEVICE_COOKIE);
      return isTrustedDeviceValid(payload, { accountId, mfaEnabledAt });
    } catch {
      return false;
    }
  }

  /**
   * Se o checkbox "confiar neste dispositivo" foi marcado E o mecanismo está ligado,
   * grava o cookie encriptado de confiança para a conta (skip MFA por N dias).
   */
  private async maybeTrustDevice(ctx: HttpContext, cfg: any, accountId: string): Promise<void> {
    if (!cfg.trustedDevices.enabled) return;
    const checked = ctx.request.input('trustDevice');
    // Checkbox HTML: presente ('on'/'true'/'1') = marcado.
    const on = checked === 'on' || checked === 'true' || checked === '1' || checked === true;
    if (!on) return;
    const payload = buildTrustedDevicePayload(accountId, cfg.trustedDevices);
    ctx.response.encryptedCookie(TRUSTED_DEVICE_COOKIE, payload, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: cfg.trustedDevices.days * 24 * 60 * 60,
    });
  }

  /**
   * Emite o e-mail de desbloqueio OTP quando o fator fica travado.
   * Best-effort, fail-safe: nunca lança na request.
   */
  private async sendOtpUnlockEmailIfAble(
    ctx: HttpContext,
    cfg: any,
    accountId: string,
    unlockTtlHours: number,
  ): Promise<void> {
    try {
      const account = await cfg.accountStore.findById(accountId);
      if (!account?.email) return;

      // Gera o token e persiste no campo passwordResetToken (com prefixo `ou:`).
      // Reutiliza a coluna existente sem nova migração (padrão magic-link/email-change).
      const { raw, dbValue } = generateOtpUnlockToken();
      const store = cfg.accountStore;
      const row = await (store as any).__getRawRow?.(accountId);
      if (row) {
        row.passwordResetToken = dbValue;
        // Expira em unlockTtlHours horas.
        const { DateTime } = await import('luxon');
        row.passwordResetExpiresAt = DateTime.now().plus({ hours: unlockTtlHours });
        await row.save();
      }

      const origin = authkitOrigin(cfg);
      const unlockUrl = `${origin}/auth/otp-unlock/${encodeURIComponent(raw)}`;

      if (cfg.mail?.onOtpUnlock) {
        await cfg.mail.onOtpUnlock({ email: account.email, unlockUrl, token: raw }).catch(() => {});
      } else {
        await sendOtpUnlockEmail(ctx, { email: account.email, unlockUrl }).catch(() => {});
      }
    } catch {
      // Best-effort: nunca propaga erro para o fluxo de login.
    }
  }

  /**
   * accountId para uma cerimônia de passkey no login. Prioriza o accountId pendente
   * do MFA (passkey como 2º fator). Quando ausente e o passkey-first está ligado,
   * resolve a conta pelo e-mail guardado na sessão (passkey ANTES da senha) — só se
   * a conta existe E tem ao menos uma passkey.
   */
  private async resolvePasskeyAccountId(ctx: HttpContext, cfg: any): Promise<string | undefined> {
    const pending = ctx.session.get(MFA_PENDING_KEY) as string | undefined;
    if (pending) return pending;
    if (!cfg.passwordless?.passkeyFirst) return undefined;
    const email = ctx.session.get(SESSION_KEY) as string | undefined;
    if (!email) return undefined;
    const acc = await cfg.accountStore.findByEmail(email);
    if (!acc) return undefined;
    return (await this.hasPasskeys(cfg, acc.id)) ? acc.id : undefined;
  }

  /**
   * POST /auth/interaction/:uid/magic
   * Magic link: lê o e-mail da sessão (passwordless.magicLink ligado), emite um
   * token de uso único e dispara o e-mail. SEMPRE renderiza "link enviado",
   * independentemente de a conta existir (anti-enumeração). Throttled como o login.
   */
  async magicLinkRequest(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(
      cfg.branding!,
      details.params.client_id as string | undefined,
      details.params.audience as string | undefined,
    );
    const email = ctx.session.get(SESSION_KEY) as string | undefined;
    const uid = ctx.request.param('uid');
    // Login por OTP: liga o campo de código na tela "link enviado" quando a config
    // está ligada E o store suporta a capacidade.
    const otpEnabled = cfg.login.otp.enabled && supportsOtpLogin(cfg.accountStore);
    // Seletor "choose-first": o host pode POSTar `channel=code|link` para pedir que
    // o e-mail e a tela mostrem SÓ aquele método. Ausente/ inválido = both (histórico).
    // NÃO condiciona a emissão de token — os dois continuam saindo co-locados.
    const channel = normalizeLoginChannel(ctx.request.input('channel'));

    if (cfg.passwordless.magicLink && supportsMagicLink(cfg.accountStore) && email) {
      const ip = ctx.request.ip?.() ?? null;
      const clientId = (details.params.client_id as string | undefined) ?? null;
      // Com OTP ligado, emite link E código no MESMO disparo (issueMagicLinkWithCode);
      // senão, o magic link puro de sempre.
      const issued = otpEnabled
        ? await cfg.accountStore.issueMagicLinkWithCode(email, uid, {
            digits: cfg.login.otp.digits,
            ttlMinutes: cfg.login.otp.ttlMinutes,
          })
        : await cfg.accountStore.issueMagicLinkToken(email);
      if (issued) {
        const code = 'code' in issued ? issued.code : undefined;
        await cfg.audit?.record({
          type: 'login.magic_link_sent',
          accountId: issued.account.id,
          email,
          ip,
          clientId,
        });
        if (code) {
          await cfg.audit?.record({
            type: 'login.otp_sent',
            accountId: issued.account.id,
            email,
            ip,
            clientId,
          });
        }
        const origin = authkitOrigin(cfg);
        const magicUrl = `${origin}/auth/interaction/${uid}/magic?token=${encodeURIComponent(issued.token)}`;
        if (cfg.mail?.onMagicLink) {
          await cfg.mail.onMagicLink({ email, magicUrl, token: issued.token, code, channel });
        } else {
          await sendMagicLinkEmail(ctx, { email, magicUrl, code, channel });
        }
      }
    }

    // Resposta uniforme (não vaza existência de conta).
    // `otpEnabled` vem do spread de `#loginMethods` (mesmo valor do `otpEnabled`
    // local usado acima para decidir a emissão) — não re-declarado aqui.
    return render(ctx, 'login', {
      ...(await this.#loginMethods(ctx, cfg)),
      uid,
      csrfToken: ctx.request.csrfToken,
      step: 'password',
      email,
      account: null,
      brand,
      magicLinkSent: true,
      // Prop da tela: qual sub-view do estado `magicLinkSent` mostrar —
      // 'code' (só o campo de código), 'link' (só o aviso de link) ou 'both'
      // (ambos, quando o host não escolheu canal). Back-compat: ausente = 'both'.
      magicChannel: magicChannelProp(channel),
    });
  }

  /**
   * GET /auth/interaction/:uid/magic?token=...
   * Consome o magic link. Em sucesso finaliza o login (amr `['email']`). Token
   * inválido/expirado volta ao início do login.
   */
  async magicLinkConsume(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const uid = ctx.request.param('uid');
    const ip = ctx.request.ip?.() ?? null;
    const clientId = (await service.interactions.details(ctx)).params.client_id as
      | string
      | undefined;

    const token = (ctx.request.qs().token as string) ?? '';
    if (!cfg.passwordless.magicLink || !supportsMagicLink(cfg.accountStore) || !token) {
      return ctx.response.redirect(`/auth/interaction/${uid}`);
    }
    const acc = await cfg.accountStore.consumeMagicLinkToken(token);
    if (!acc) {
      await cfg.audit?.record({
        type: 'login.failure',
        ip,
        clientId,
        metadata: { stage: 'magic_link' },
      });
      return ctx.response.redirect(`/auth/interaction/${uid}`);
    }
    // E-mail não verificado (LGPD/compliance): mesmo com o link válido, não
    // materializa a sessão se a política exige verificação. Volta ao login com erro.
    const magicLinkRuntimeSettings = await getRuntimeSettings(ctx);
    if (await isEmailUnverifiedBlock(cfg, acc.id, magicLinkRuntimeSettings)) {
      await cfg.audit?.record({
        type: 'login.failure',
        accountId: acc.id,
        email: acc.email,
        ip,
        clientId,
        metadata: { stage: 'magic_link', reason: 'unverified' },
      });
      const render = cfg.render!;
      return render(ctx, 'login', {
        ...(await this.#loginMethods(ctx, cfg)),
        uid,
        csrfToken: ctx.request.csrfToken,
        step: 'password',
        email: acc.email,
        account: null,
        brand: brandFor(cfg.branding!, clientId ?? undefined, undefined),
        error: translate(cfg.messages, 'errors.email_unverified'),
      });
    }

    // Status da conta (disabled/expired): mesmo gate de `attemptPasswordLogin`,
    // agora aplicado ao magic link (o botão "desabilitar" no admin console não
    // tinha efeito nenhum aqui antes desta checagem). Emite o MESMO evento
    // `login.failure`/`password.expired_change_forced`/`account.expired_login_blocked`
    // que o fluxo de senha (auditoria uniforme entre fluxos).
    const magicLinkStatusGate = await assertLoginAllowed(cfg, acc.id, {
      email: acc.email,
      ip,
      clientId,
      settings: magicLinkRuntimeSettings,
    });
    if (!magicLinkStatusGate.allowed) {
      const render = cfg.render!;
      return render(ctx, 'login', {
        ...(await this.#loginMethods(ctx, cfg)),
        uid,
        csrfToken: ctx.request.csrfToken,
        step: 'password',
        email: acc.email,
        account: null,
        brand: brandFor(cfg.branding!, clientId ?? undefined, undefined),
        error: translate(cfg.messages, accountStatusErrorKey(magicLinkStatusGate.reason)),
      });
    }

    await notifyLoginSuccess(ctx, cfg, {
      accountId: acc.id,
      email: acc.email,
      ip,
      clientId: clientId ?? null,
      metadata: { method: 'magic_link' },
    });
    ctx.session.forget(SESSION_KEY);
    await service.interactions.completeLogin(ctx, acc.id, { amr: ['email'] });
  }

  /**
   * POST /auth/interaction/:uid/otp-verify
   *
   * Verifica o CÓDIGO OTP de login (o mesmo e-mail carrega link E código). Roda
   * atrás do throttle dedicado `authkit_otp_login` (por IP, mais apertado que o
   * login). A ordem das checagens de segurança — lockout (contador persistido no
   * slot) → TTL → comparação constant-time — vive no store (`verifyLoginCode` →
   * `evaluateLoginOtp`). Em sucesso, completa a MESMA interaction que o link
   * completaria (amr `['email']`), consumindo código E link (single-use conjunto).
   */
  async otpVerify(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const uid = ctx.request.param('uid');
    const ip = ctx.request.ip?.() ?? null;
    const clientId = (await service.interactions.details(ctx)).params.client_id as
      | string
      | undefined;
    const email = ctx.session.get(SESSION_KEY) as string | undefined;

    // Guardas: OTP desligado, store sem suporte ou sem e-mail na sessão → volta ao login.
    const otpEnabled = cfg.login.otp.enabled && supportsOtpLogin(cfg.accountStore);
    if (!otpEnabled || !email) {
      return ctx.response.redirect(`/auth/interaction/${uid}`);
    }

    const code = String(ctx.request.input('code', '') ?? '').trim();
    const brand = brandFor(cfg.branding!, clientId ?? undefined, undefined);
    // Mantém a sub-view do seletor no re-render de erro (o form de código pode
    // POSTar `channel=code`). Ausente = both (histórico).
    const channel = normalizeLoginChannel(ctx.request.input('channel'));

    const result = await cfg.accountStore.verifyLoginCode(email, uid, code, {
      maxAttempts: cfg.login.otp.maxAttempts,
    });

    // Re-render da tela "link enviado" com o campo de código + erro localizado.
    // `otpEnabled` vem do spread de `#loginMethods` (aqui, após a guarda acima,
    // vale `true`) — não re-declarado inline.
    const renderOtpError = async (messageKey: string) =>
      render(ctx, 'login', {
        ...(await this.#loginMethods(ctx, cfg)),
        uid,
        csrfToken: ctx.request.csrfToken,
        step: 'password',
        email,
        account: null,
        brand,
        magicLinkSent: true,
        magicChannel: magicChannelProp(channel),
        otpError: translate(cfg.messages, messageKey),
      });

    if (result.status === 'ok') {
      // E-mail não verificado (LGPD): mesmo com código válido, não materializa a
      // sessão se a política exige verificação. Espelha o magicLinkConsume.
      const runtimeSettings = await getRuntimeSettings(ctx);
      if (await isEmailUnverifiedBlock(cfg, result.account.id, runtimeSettings)) {
        await cfg.audit?.record({
          type: 'login.failure',
          accountId: result.account.id,
          email: result.account.email,
          ip,
          clientId,
          metadata: { stage: 'otp', reason: 'unverified' },
        });
        return render(ctx, 'login', {
          ...(await this.#loginMethods(ctx, cfg)),
          uid,
          csrfToken: ctx.request.csrfToken,
          step: 'password',
          email: result.account.email,
          account: null,
          brand,
          error: translate(cfg.messages, 'errors.email_unverified'),
        });
      }

      // Status da conta (disabled/expired): mesmo gate de `attemptPasswordLogin`,
      // agora aplicado ao login por OTP. Emite o MESMO evento de auditoria que o
      // fluxo de senha (uniforme entre fluxos).
      const otpStatusGate = await assertLoginAllowed(cfg, result.account.id, {
        email: result.account.email,
        ip,
        clientId,
        settings: runtimeSettings,
      });
      if (!otpStatusGate.allowed) {
        return render(ctx, 'login', {
          ...(await this.#loginMethods(ctx, cfg)),
          uid,
          csrfToken: ctx.request.csrfToken,
          step: 'password',
          email: result.account.email,
          account: null,
          brand,
          error: translate(cfg.messages, accountStatusErrorKey(otpStatusGate.reason)),
        });
      }

      await cfg.audit?.record({
        type: 'login.otp_verified',
        accountId: result.account.id,
        email: result.account.email,
        ip,
        clientId,
      });
      await notifyLoginSuccess(ctx, cfg, {
        accountId: result.account.id,
        email: result.account.email,
        ip,
        clientId: clientId ?? null,
        metadata: { method: 'otp' },
      });
      ctx.session.forget(SESSION_KEY);
      return service.interactions.completeLogin(ctx, result.account.id, { amr: ['email'] });
    }

    if (result.status === 'locked') {
      // 5ª falha (ou já travado): código invalidado, o LINK continua válido.
      await cfg.audit?.record({ type: 'login.otp_invalidated', email, ip, clientId });
      return renderOtpError('login.otp_locked');
    }
    if (result.status === 'expired') {
      await cfg.audit?.record({
        type: 'login.otp_failed',
        email,
        ip,
        clientId,
        metadata: { reason: 'expired' },
      });
      return renderOtpError('login.otp_expired');
    }
    // 'invalid' (tentativa contabilizada) ou 'no_code'.
    await cfg.audit?.record({
      type: 'login.otp_failed',
      email,
      ip,
      clientId,
      metadata: { reason: result.status },
    });
    return renderOtpError('login.otp_invalid');
  }

  /**
   * POST /auth/interaction/:uid/passkey/options
   *
   * Gera as opções de autenticação por passkey. Suporta dois modos:
   *
   * 1. **Modo normal** (MFA gate ou passkey-first com e-mail na sessão):
   *    resolve o `accountId` e gera opções com `allowCredentials` restrito às
   *    credenciais da conta (comportamento original).
   *
   * 2. **Modo discoverable** (WebAuthn autofill / conditional mediation):
   *    chamado sem accountId resolvível (tela de identifier sem e-mail ainda).
   *    Neste caso, delega a `generatePasskeyAuthenticationOptions` com accountId
   *    especial `'__discoverable__'` — o store deve retornar opções com
   *    `allowCredentials: []` (deixa o browser apresentar TODAS as passkeys
   *    disponíveis). Quando o store não suporta este modo, devolve 400 com
   *    `discoverable: false` (o JS de autofill trata silenciosamente).
   *
   * Guarda o challenge na sessão e devolve as opções JSON.
   */
  async passkeyOptions(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    // Tenta resolver o accountId do contexto corrente (MFA gate ou passkey-first).
    const accountId = await this.resolvePasskeyAccountId(ctx, cfg);

    if (!accountId) {
      // Modo discoverable: sem accountId na sessão, gera options sem restrição
      // de credenciais (allowCredentials vazio = o browser apresenta todas).
      if (!supportsPasskeys(cfg.accountStore)) {
        return ctx.response.badRequest({
          message: translate(cfg.messages, 'errors.passkeys_unavailable'),
          discoverable: false,
        });
      }
      // Passa '__discoverable__' como sentinel — o store (LucidStore) detecta e
      // retorna options com allowCredentials:[] se suportar; caso contrário null.
      const generated =
        await cfg.accountStore.generatePasskeyAuthenticationOptions?.('__discoverable__');
      if (!generated) {
        // Store não suporta discoverable credentials — autofill não disponível.
        return ctx.response.badRequest({
          message: translate(cfg.messages, 'errors.passkeys_unavailable'),
          discoverable: false,
        });
      }
      ctx.session.put(PASSKEY_AUTH_CHALLENGE_KEY, generated.challenge);
      return { ...generated.options, _discoverable: true };
    }

    // Modo normal: opções restritas à conta.
    const generated = await cfg.accountStore.generatePasskeyAuthenticationOptions?.(accountId);
    if (!generated) {
      return ctx.response.notFound({
        message: translate(cfg.messages, 'errors.no_passkey_registered'),
      });
    }
    ctx.session.put(PASSKEY_AUTH_CHALLENGE_KEY, generated.challenge);
    return generated.options;
  }

  /**
   * POST /auth/interaction/:uid/passkey/verify
   * Verifica a resposta de autenticação por passkey contra o challenge guardado;
   * em caso de sucesso FINALIZA a interaction (303 de volta ao client — alternativa
   * ao código TOTP). É um POST de página inteira (form), não fetch: o browser
   * submete o JSON da assertion no campo `response` e segue o redirect normalmente.
   */
  async passkeyVerify(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(
      cfg.branding!,
      details.params.client_id as string | undefined,
      details.params.audience as string | undefined,
    );
    let accountId = await this.resolvePasskeyAccountId(ctx, cfg);
    const challenge = ctx.session.get(PASSKEY_AUTH_CHALLENGE_KEY) as string | undefined;
    const ip = ctx.request.ip?.() ?? null;
    const clientId = (details.params.client_id as string | undefined) ?? null;

    if (!challenge) {
      // Sessão expirou/foi adulterada — volta ao início do login.
      return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
    }

    // Modo discoverable: quando não temos accountId na sessão, precisamos
    // descobri-lo a partir da credencial na assertion (rawId/id). O store
    // pode implementar `findByPasskeyCredentialId` para isso; se não suportar,
    // não podemos completar o autofill e redirecionamos para o início.
    if (!accountId) {
      const rawResponse = ctx.request.input('response') as string | undefined;
      let parsedEarly: any = null;
      try {
        parsedEarly = rawResponse ? JSON.parse(rawResponse) : null;
      } catch {
        parsedEarly = null;
      }
      const credId = parsedEarly?.id ?? parsedEarly?.rawId ?? null;
      if (credId && typeof (cfg.accountStore as any).findByPasskeyCredentialId === 'function') {
        const found = await (cfg.accountStore as any).findByPasskeyCredentialId(credId);
        accountId = found?.id ?? null;
      }
      if (!accountId) {
        return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
      }
    }

    // A assertion vem serializada como JSON no campo `response` do form.
    const raw = ctx.request.input('response') as string | undefined;
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const ok = parsed
      ? ((await cfg.accountStore.verifyPasskeyAuthentication?.(accountId, parsed, challenge)) ??
        false)
      : false;
    ctx.session.forget(PASSKEY_AUTH_CHALLENGE_KEY);

    if (!ok) {
      await cfg.audit?.record({
        type: 'login.failure',
        accountId,
        ip,
        clientId,
        metadata: { stage: 'mfa', method: 'webauthn' },
      });
      return render(ctx, 'mfa-challenge', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'mfa_challenge.passkey_error'),
        brand,
        passkeyAvailable: await this.hasPasskeys(cfg, accountId),
        trustedDevicesEnabled: cfg.trustedDevices.enabled,
        trustedDeviceDays: cfg.trustedDevices.days,
      });
    }

    // E-mail não verificado (LGPD/compliance): bloqueia mesmo com a passkey válida.
    // Relevante sobretudo no passkey-first (a etapa de senha — que também checa —
    // não rodou). Volta à tela de desafio com o erro.
    const passkeyRuntimeSettings = await getRuntimeSettings(ctx);
    if (await isEmailUnverifiedBlock(cfg, accountId, passkeyRuntimeSettings)) {
      await cfg.audit?.record({
        type: 'login.failure',
        accountId,
        ip,
        clientId,
        metadata: { stage: 'mfa', method: 'webauthn', reason: 'unverified' },
      });
      return render(ctx, 'mfa-challenge', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'errors.email_unverified'),
        brand,
        passkeyAvailable: await this.hasPasskeys(cfg, accountId),
        trustedDevicesEnabled: cfg.trustedDevices.enabled,
        trustedDeviceDays: cfg.trustedDevices.days,
      });
    }

    // Status da conta (disabled/expired): mesmo gate de `attemptPasswordLogin`,
    // agora aplicado ao passkey (cobre sobretudo o passkey-first, que nunca passa
    // pelo fluxo de senha). Emite o MESMO evento de auditoria que os outros fluxos.
    const passkeyAccount = await cfg.accountStore.findById(accountId);
    const passkeyStatusGate = await assertLoginAllowed(cfg, accountId, {
      email: passkeyAccount?.email ?? '',
      ip,
      clientId,
      settings: passkeyRuntimeSettings,
    });
    if (!passkeyStatusGate.allowed) {
      return render(ctx, 'mfa-challenge', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, accountStatusErrorKey(passkeyStatusGate.reason)),
        brand,
        passkeyAvailable: await this.hasPasskeys(cfg, accountId),
        trustedDevicesEnabled: cfg.trustedDevices.enabled,
        trustedDeviceDays: cfg.trustedDevices.days,
      });
    }

    // Passkey OK: opcionalmente confia neste dispositivo (checkbox no challenge).
    await this.maybeTrustDevice(ctx, cfg, accountId);
    ctx.session.forget(MFA_PENDING_KEY);
    ctx.session.forget(SESSION_KEY);
    await notifyLoginSuccess(ctx, cfg, {
      accountId,
      ip,
      clientId,
      metadata: { mfa: 'webauthn' },
    });
    // Step-up carimba acr/amr quando solicitado; senão a passkey conta como o fator
    // forte do login (amr `['webauthn']`) — vale tanto p/ MFA quanto passkey-first.
    await service.interactions.completeLogin(
      ctx,
      accountId,
      this.stepUpExtra(cfg, details, 'webauthn') ?? { amr: ['webauthn'] },
    );
  }

  /**
   * GET /auth/interaction/:uid/switch
   * Clears the stored email and redirects back to step 1.
   */
  async switchIdentifier(ctx: HttpContext) {
    ctx.session.forget(SESSION_KEY);
    return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
  }

  /**
   * POST /auth/interaction/:uid/password-expired
   *
   * Step de troca obrigatória quando a senha expirou. A senha VELHA já foi
   * verificada em `login` — aqui a conta está no step `password_expired` da
   * sessão. O usuário informa a nova senha (+ confirmação) e o controller:
   *   1. Valida política de senha.
   *   2. Atualiza a senha via `changePassword` (que toca `passwordChangedAt`).
   *   3. Finaliza a interaction normalmente.
   *
   * Capability-probed: sem `changePassword` → redireciona para o login.
   */
  async changeExpiredPassword(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(
      cfg.branding!,
      details.params.client_id as string | undefined,
      details.params.audience as string | undefined,
    );

    const PASSWORD_EXPIRED_KEY = 'authkit_password_expired';
    const accountId = ctx.session.get(PASSWORD_EXPIRED_KEY) as string | undefined;
    const ip = ctx.request.ip?.() ?? null;
    const clientId = (details.params.client_id as string | undefined) ?? null;

    if (!accountId) {
      return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
    }

    const { newPassword } = ctx.request.only(['newPassword']);

    if (!newPassword) {
      return render(ctx, 'login', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        step: 'password_expired',
        email: '',
        account: null,
        error: translate(cfg.messages, 'errors.invalid_credentials'),
        brand,
        botProtection: undefined,
      });
    }

    const { PasswordPolicyError } = await import('../../password/password_manager.js');
    const { supportsAccountSecurity } = await import('../../accounts/account_store.js');

    if (!supportsAccountSecurity(cfg.accountStore)) {
      return ctx.response.redirect(`/auth/interaction/${ctx.request.param('uid')}`);
    }

    try {
      await cfg.accountStore.changePassword!(accountId, newPassword);
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        return render(ctx, 'login', {
          uid: ctx.request.param('uid'),
          csrfToken: ctx.request.csrfToken,
          step: 'password_expired',
          email: '',
          account: null,
          error: translate(cfg.messages, error.key, error.params),
          brand,
          botProtection: undefined,
        });
      }
      throw error;
    }

    await cfg.audit?.record({
      type: 'password.changed',
      accountId,
      ip,
      clientId,
      metadata: { reason: 'expired_forced' },
    });

    // Senha trocada: limpa o step e finaliza o login.
    ctx.session.forget(PASSWORD_EXPIRED_KEY);

    // Verifica se precisa de MFA mesmo após a troca.
    const mfa = (await cfg.accountStore.getMfaState?.(accountId)) ?? { enabled: false };
    if (mfa.enabled) {
      ctx.session.put(MFA_PENDING_KEY, accountId);
      const passkeyAvailable = await this.hasPasskeys(cfg, accountId);
      return render(ctx, 'mfa-challenge', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        brand,
        passkeyAvailable,
        trustedDevicesEnabled: cfg.trustedDevices.enabled,
        trustedDeviceDays: cfg.trustedDevices.days,
      });
    }

    await service.interactions.completeLogin(ctx, accountId);
    const account = await cfg.accountStore.findById(accountId);
    await notifyLoginSuccess(ctx, cfg, {
      accountId,
      email: account?.email ?? '',
      ip,
      clientId,
    });
  }

  async consent(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    await service.interactions.consent(ctx);
  }

  /**
   * GET /auth/otp-unlock/:token
   * Consome o token de desbloqueio OTP enviado por e-mail. Valida (hash + TTL),
   * zera o contador/lock, audita `otp.unlocked` e redireciona ao login com mensagem.
   */
  async otpUnlock(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const ip = ctx.request.ip?.() ?? null;

    const raw = ctx.request.param('token') as string;
    if (!raw) {
      return render(ctx, 'otp-unlock', { ok: false });
    }

    const dbValue = rawToDbOtpUnlockToken(raw);

    try {
      // Busca a conta pelo token (campo passwordResetToken).
      const store = cfg.accountStore;
      // Usamos findByPasswordResetToken se disponível; senão fallback via raw row scan.
      let row: any = null;
      if (typeof (store as any).__findByTokenField === 'function') {
        row = await (store as any).__findByTokenField('passwordResetToken', dbValue);
      } else {
        // Fallback: busca direto via raw query (Lucid model).
        const Model = (store as any).__Model;
        if (Model) {
          row = await Model.query().where('passwordResetToken', dbValue).first();
        }
      }

      if (!row) {
        await cfg.audit?.record({
          type: 'otp.unlock_failed',
          ip,
          metadata: { reason: 'token_not_found' },
        });
        return render(ctx, 'otp-unlock', { ok: false });
      }

      // Verifica TTL.
      const { DateTime } = await import('luxon');
      const expiresAt = row.passwordResetExpiresAt;
      if (!expiresAt || expiresAt < DateTime.now()) {
        await cfg.audit?.record({
          type: 'otp.unlock_failed',
          accountId: row.id,
          ip,
          metadata: { reason: 'token_expired' },
        });
        return render(ctx, 'otp-unlock', { ok: false, expired: true });
      }

      // Token válido: zera o lock OTP + limpa o token do DB.
      const runtimeForOtp = await getRuntimeSettings(ctx);
      const otpLockoutCfg = await resolveEffectiveOtpLockout(runtimeForOtp);
      const otpLockout = createOtpLockout(otpLockoutCfg, ctx.logger);
      await otpLockout.unlock(row.id);

      row.passwordResetToken = null;
      row.passwordResetExpiresAt = null;
      await row.save();

      await cfg.audit?.record({ type: 'otp.unlocked', accountId: row.id, ip });

      return render(ctx, 'otp-unlock', { ok: true });
    } catch {
      return render(ctx, 'otp-unlock', { ok: false });
    }
  }
}
