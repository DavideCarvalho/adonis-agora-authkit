import '../augmentations.js';
import { randomBytes } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import {
  supportsAccountDeletion,
  supportsMagicLink,
  supportsOtpLogin,
} from '../../accounts/account_store.js';
import { PasswordPolicyError } from '../../password/password_manager.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { guardBotProtection, resolveEffectiveBotProtection } from '../bot_protection.js';
import { brandFor } from '../branding.js';
import {
  sendEmailVerificationEmail,
  sendMagicLinkEmail,
  sendPasswordResetEmail,
} from '../default_mailer.js';
import { translate } from '../i18n.js';
import { rememberLastLoginMethod } from '../last_login_method.js';
import { authkitOrigin } from '../origin.js';
import { RuntimeSettings, resolveRuntimeSettings } from '../runtime_settings.js';
import {
  resolveEffectiveAuthMethods,
  resolveEffectiveMaintenanceMode,
  resolveEffectiveRegistration,
} from '../runtime_toggles.js';
import { dispatchSecurityNotice } from '../security_notice_service.js';
import {
  LOGIN_EMAIL_SESSION_KEY,
  SIGNUP_CODE_SESSION_KEY,
  startSignupCode,
} from '../signup_code.js';
import { issueSignupToken, readSignupToken } from '../signup_token.js';
import {
  forgotPasswordValidator,
  passwordlessSignupValidator,
  resetPasswordValidator,
  signupValidator,
} from '../validators.js';

/**
 * Best-effort: returns a RuntimeSettings backed by the container DB, or a no-op
 * fallback. Contrato NON-NULL preservado (callers passam direto p/ resolvers que
 * exigem SettingsCapability). Reusa a fábrica canônica `resolveRuntimeSettings`
 * e degrada para o RuntimeSettings no-op (probe via SELECT lança → tabela ausente
 * → config fallback) quando a resolução falha.
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

export default class AuthRegistrationController {
  /** GET /auth/interaction/:uid/signup — tela de cadastro (dentro do fluxo OIDC). */
  async showSignup(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(cfg.branding, details.params.client_id as string | undefined);
    const runtimeSettings = await getRuntimeSettings(ctx);

    // Maintenance mode: mostra página de manutenção se ativo.
    const maintenance = await resolveEffectiveMaintenanceMode(runtimeSettings);
    if (maintenance.enabled) {
      return render(ctx, 'maintenance', {
        csrfToken: ctx.request.csrfToken,
        message: maintenance.message ?? translate(cfg.messages, 'maintenance.default_message'),
        brand,
      });
    }

    // Registration disabled: mostra mensagem clara na tela de signup.
    const registrationEnabled = await resolveEffectiveRegistration(
      cfg.registration?.enabled ?? true,
      runtimeSettings,
    );
    if (!registrationEnabled) {
      return render(ctx, 'signup', {
        uid: details.uid,
        csrfToken: ctx.request.csrfToken,
        brand,
        registrationDisabled: true,
        registrationDisabledMessage: translate(cfg.messages, 'errors.registration_disabled'),
      });
    }

    const effectiveBot = await resolveEffectiveBotProtection(cfg.botProtection, runtimeSettings);
    return render(ctx, 'signup', {
      uid: details.uid,
      csrfToken: ctx.request.csrfToken,
      brand,
      passwordlessSignup: cfg.passwordless?.signup ?? false,
      botProtection: effectiveBot?.on.includes('signup') ? effectiveBot.widget : undefined,
    });
  }

  /** POST /auth/interaction/:uid/signup — cria o usuário e finaliza o login. */
  async signup(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const details = await service.interactions.details(ctx);
    const brand = brandFor(cfg.branding, details.params.client_id as string | undefined);
    const runtimeSettings = await getRuntimeSettings(ctx);

    // Maintenance mode: rejeita o POST durante manutenção.
    const maintenance = await resolveEffectiveMaintenanceMode(runtimeSettings);
    if (maintenance.enabled) {
      return render(ctx, 'maintenance', {
        csrfToken: ctx.request.csrfToken,
        message: maintenance.message ?? translate(cfg.messages, 'maintenance.default_message'),
        brand,
      });
    }

    // Registration disabled: rejeita o POST — mesmo que alguém bata diretamente.
    const registrationEnabled = await resolveEffectiveRegistration(
      cfg.registration?.enabled ?? true,
      runtimeSettings,
    );
    if (!registrationEnabled) {
      return render(ctx, 'signup', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        brand,
        registrationDisabled: true,
        registrationDisabledMessage: translate(cfg.messages, 'errors.registration_disabled'),
      });
    }

    // Effective bot protection: may be overridden at runtime via auth_settings.
    const effectiveBotSignup = await resolveEffectiveBotProtection(
      cfg.botProtection,
      runtimeSettings,
    );
    const cfgWithEffectiveBotSignup =
      effectiveBotSignup !== cfg.botProtection
        ? { ...cfg, botProtection: effectiveBotSignup }
        : cfg;

    // Bot protection (plugável): valida o token do widget ANTES de criar a conta.
    // Fail-safe: erro/timeout no verify do host PERMITE o cadastro.
    const clientId = (details.params.client_id as string | undefined) ?? null;
    if (
      !(await guardBotProtection(ctx, cfgWithEffectiveBotSignup as any, 'signup', { clientId }))
    ) {
      return render(ctx, 'signup', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'errors.bot_protection_failed'),
        brand,
        botProtection: effectiveBotSignup?.widget,
      });
    }

    // Cadastro passwordless (config): só e-mail + nome. Cria conta com senha random
    // inutilizável e envia um magic link — mesmo fluxo do login por magic link.
    if (
      cfg.passwordless?.signup &&
      typeof (cfg.accountStore as any).issueMagicLinkToken === 'function'
    ) {
      return this.#passwordlessSignup(ctx, { cfg, brand, details });
    }

    const data = await ctx.request.validateUsing(signupValidator);

    const accountStore = cfg.accountStore;
    // Duplicado pela MESMA forma que o login busca (`data.email` já saiu
    // normalizado do validator).
    const existing = await accountStore.findByEmail(data.email);
    if (existing) {
      return render(ctx, 'signup', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'errors.email_taken'),
        brand,
        botProtection: effectiveBotSignup?.on.includes('signup')
          ? effectiveBotSignup.widget
          : undefined,
      });
    }

    let created: Awaited<ReturnType<typeof accountStore.create>>;
    try {
      created = await accountStore.create({
        email: data.email,
        password: data.password,
        fullName: data.fullName,
      });
    } catch (error) {
      // Política de senha (comprimento/complexidade/vazamento) violada → re-renderiza
      // com a mensagem i18n específica da regra.
      if (error instanceof PasswordPolicyError) {
        return render(ctx, 'signup', {
          uid: ctx.request.param('uid'),
          csrfToken: ctx.request.csrfToken,
          error: translate(cfg.messages, error.key, error.params),
          brand,
          botProtection: effectiveBotSignup?.on.includes('signup')
            ? effectiveBotSignup.widget
            : undefined,
        });
      }
      throw error;
    }
    await cfg.audit?.record({
      type: 'signup',
      accountId: created?.id ?? null,
      email: data.email,
      ip: ctx.request.ip?.() ?? null,
      clientId: (details.params.client_id as string | undefined) ?? null,
    });

    // Conta nova entra por senha: o selo "último usado" já nasce no método certo.
    rememberLastLoginMethod(ctx, cfg, 'password');
    // Finaliza a interaction como login (interactionFinished escreve o redirect 303 que
    // retoma o authorize; o form nativo da tela segue esse redirect no sucesso).
    const result = await service.interactions.login(ctx, {
      email: data.email,
      password: data.password,
    });
    if (!result.ok) {
      // A conta acabou de nascer e o login dela falhou: sem desfazer, a pessoa
      // ficaria com um e-mail "já cadastrado" numa conta em que nunca entrou.
      if (created && supportsAccountDeletion(accountStore)) {
        await accountStore.deleteAccount(created.id).catch((error: unknown) => {
          ctx.logger.error(
            { err: error, accountId: created.id },
            'authkit: falha ao desfazer conta após signup sem login',
          );
        });
      }
      return render(ctx, 'signup', {
        uid: ctx.request.param('uid'),
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'errors.signup_failed'),
        brand,
        botProtection: effectiveBotSignup?.on.includes('signup')
          ? effectiveBotSignup.widget
          : undefined,
      });
    }

    // Verificação de e-mail (best-effort — não bloqueia nem reverte o login).
    try {
      const issued = await accountStore.issueEmailVerificationToken(data.email);
      if (issued) {
        await cfg.audit?.record({
          type: 'email_verification.issued',
          accountId: created?.id ?? null,
          email: data.email,
          ip: ctx.request.ip?.() ?? null,
        });
        const origin = authkitOrigin(cfg);
        const verifyUrl = `${origin}/auth/verify-email?token=${issued.token}`;
        // Hook do config tem prioridade (override); senão usa o mailer default do host.
        if (cfg.mail?.onEmailVerification) {
          await cfg.mail.onEmailVerification({ email: data.email, verifyUrl, token: issued.token });
        } else {
          await sendEmailVerificationEmail(ctx, { email: data.email, verifyUrl });
        }
      }
    } catch (error) {
      ctx.logger.error(
        { err: error, email: data.email },
        'authkit: falha ao enviar verificação de e-mail',
      );
    }
  }

  /**
   * Cadastro passwordless: valida e-mail + nome e envia um link. Conta existente
   * recebe um magic link de login; e-mail novo recebe o link de confirmação do
   * cadastro (`signupConfirm`), e só então a conta é criada. Sempre responde
   * "link enviado" (anti-enumeração), exista a conta ou não. Com `login.otp` ligado,
   * os dois casos também levam um código de digitar (`otpVerify`).
   */
  async #passwordlessSignup(ctx: HttpContext, deps: { cfg: any; brand: any; details: any }) {
    const { cfg, brand } = deps;
    const render = cfg.render!;
    const accountStore = cfg.accountStore;
    const uid = ctx.request.param('uid');
    const data = await ctx.request.validateUsing(passwordlessSignupValidator);

    const origin = authkitOrigin(cfg);
    // Com OTP ligado, o e-mail leva também um código, para concluir neste navegador.
    const otpEnabled = cfg.login?.otp?.enabled === true && supportsOtpLogin(accountStore);
    const existing = await accountStore.findByEmail(data.email);
    ctx.session.forget(SIGNUP_CODE_SESSION_KEY);
    if (otpEnabled) ctx.session.put(LOGIN_EMAIL_SESSION_KEY, data.email);
    if (existing) {
      // Conta já existe: o "cadastro" vira um login por magic link.
      // `data.email` já é a forma normalizada, a mesma do login.
      const issued = otpEnabled
        ? await accountStore.issueMagicLinkWithCode(data.email, uid, {
            digits: cfg.login.otp.digits,
            ttlMinutes: cfg.login.otp.ttlMinutes,
          })
        : await accountStore.issueMagicLinkToken(data.email);
      if (issued) {
        const code = 'code' in issued ? (issued.code as string) : undefined;
        const magicUrl = `${origin}/auth/interaction/${uid}/magic?token=${encodeURIComponent(issued.token)}`;
        const to = issued.account.email;
        if (cfg.mail?.onMagicLink) {
          await cfg.mail.onMagicLink({ email: to, magicUrl, token: issued.token, code });
        } else {
          await sendMagicLinkEmail(ctx, { email: to, magicUrl, code });
        }
      }
    } else {
      // Conta nova: NÃO cria aqui. O link de confirmação leva e-mail + nome num
      // token cifrado; a conta só nasce quando o dono do e-mail o abre
      // (`signupConfirm`). Um envio que falha não deixa conta órfã, e digitar o
      // e-mail de outra pessoa não cria nada.
      const token = await issueSignupToken({ email: data.email, fullName: data.fullName ?? null });
      const magicUrl = `${origin}/auth/interaction/${uid}/signup/confirm?token=${encodeURIComponent(token)}`;
      const code = otpEnabled
        ? startSignupCode(ctx, {
            uid,
            email: data.email,
            token,
            digits: cfg.login.otp.digits,
            ttlMinutes: cfg.login.otp.ttlMinutes,
          })
        : undefined;
      if (cfg.mail?.onMagicLink) {
        await cfg.mail.onMagicLink({ email: data.email, magicUrl, token, code, kind: 'signup' });
      } else {
        await sendMagicLinkEmail(ctx, { email: data.email, magicUrl, code });
      }
    }

    // Resposta uniforme: "enviamos um link" (não vaza existência da conta).
    return render(ctx, 'signup', {
      uid,
      csrfToken: ctx.request.csrfToken,
      brand,
      magicLinkSent: true,
      otpEnabled,
    });
  }

  /**
   * GET /auth/interaction/:uid/signup/confirm?token= — o dono do e-mail abriu o
   * link do cadastro passwordless. Cria a conta (e-mail já verificado: quem
   * clicou provou a caixa de entrada) e conclui pelo fluxo de magic link, que
   * aplica os mesmos gates do login (status, manutenção, 2º fator).
   *
   * Conta que já existe → o link é recusado e a pessoa volta ao login: é o que
   * faz o link valer uma vez só, sem estado no banco.
   */
  async signupConfirm(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const accountStore = cfg.accountStore;
    const uid = ctx.request.param('uid');
    const backToLogin = `/auth/interaction/${uid}`;
    const token = (ctx.request.qs().token as string | undefined) ?? '';

    if (!cfg.passwordless?.signup || !supportsMagicLink(accountStore) || !token) {
      return ctx.response.redirect(backToLogin);
    }
    const runtimeSettings = await getRuntimeSettings(ctx);
    const registrationEnabled = await resolveEffectiveRegistration(
      cfg.registration?.enabled ?? true,
      runtimeSettings,
    );
    if (!registrationEnabled) return ctx.response.redirect(backToLogin);

    const claim = await readSignupToken(token);
    if (!claim) return ctx.response.redirect(backToLogin);
    if (await accountStore.findByEmail(claim.email)) return ctx.response.redirect(backToLogin);

    let created: Awaited<ReturnType<typeof accountStore.create>>;
    try {
      created = await accountStore.create({
        email: claim.email,
        fullName: claim.fullName,
        password: randomBytes(24).toString('hex'),
        emailVerified: true,
      });
    } catch (error) {
      // Dois cliques simultâneos: o segundo perde na unicidade do e-mail.
      if (await accountStore.findByEmail(claim.email)) return ctx.response.redirect(backToLogin);
      throw error;
    }
    const details = await service.interactions.details(ctx);
    await cfg.audit?.record({
      type: 'signup',
      accountId: created.id,
      email: claim.email,
      ip: ctx.request.ip?.() ?? null,
      clientId: (details.params.client_id as string | undefined) ?? null,
    });

    const issued = await accountStore.issueMagicLinkToken(claim.email);
    if (!issued) return ctx.response.redirect(backToLogin);
    return ctx.response.redirect(
      `/auth/interaction/${uid}/magic?token=${encodeURIComponent(issued.token)}`,
    );
  }

  /** GET /auth/forgot-password — tela standalone. */
  async showForgot(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const runtimeSettings = await getRuntimeSettings(ctx);

    // Maintenance mode: mostra página de manutenção.
    const maintenance = await resolveEffectiveMaintenanceMode(runtimeSettings);
    if (maintenance.enabled) {
      return render(ctx, 'maintenance', {
        csrfToken: ctx.request.csrfToken,
        message: maintenance.message ?? translate(cfg.messages, 'maintenance.default_message'),
      });
    }

    // auth_methods: se forgotPassword efetivo for false → 404 (endpoint desligado).
    const authMethods = await resolveEffectiveAuthMethods(runtimeSettings, {
      configuredSocialProviders: cfg.social?.providers ?? [],
      magicLinkCapable:
        cfg.passwordless?.magicLink &&
        typeof (cfg.accountStore as any).issueMagicLinkToken === 'function',
      configOverrides: cfg.authMethods,
    });
    if (!authMethods.forgotPassword) {
      return ctx.response.notFound({ error: translate(cfg.messages, 'errors.not_found') });
    }

    const effectiveBot = await resolveEffectiveBotProtection(cfg.botProtection, runtimeSettings);
    return render(ctx, 'forgot', {
      csrfToken: ctx.request.csrfToken,
      botProtection: effectiveBot?.on.includes('reset') ? effectiveBot.widget : undefined,
    });
  }

  /** POST /auth/forgot-password — gera token e (dev) loga o link. Sempre responde sucesso (não vaza emails). */
  async forgot(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const runtimeSettings = await getRuntimeSettings(ctx);

    // Maintenance mode: rejeita o POST.
    const maintenance = await resolveEffectiveMaintenanceMode(runtimeSettings);
    if (maintenance.enabled) {
      return render(ctx, 'maintenance', {
        csrfToken: ctx.request.csrfToken,
        message: maintenance.message ?? translate(cfg.messages, 'maintenance.default_message'),
      });
    }

    // auth_methods: se forgotPassword efetivo for false → 404 (endpoint desligado).
    const authMethods = await resolveEffectiveAuthMethods(runtimeSettings, {
      configuredSocialProviders: cfg.social?.providers ?? [],
      magicLinkCapable:
        cfg.passwordless?.magicLink &&
        typeof (cfg.accountStore as any).issueMagicLinkToken === 'function',
      configOverrides: cfg.authMethods,
    });
    if (!authMethods.forgotPassword) {
      return ctx.response.notFound({ error: translate(cfg.messages, 'errors.not_found') });
    }

    // Effective bot protection: may be overridden at runtime via auth_settings.
    const effectiveBotForgot = await resolveEffectiveBotProtection(
      cfg.botProtection,
      runtimeSettings,
    );
    const cfgWithEffectiveBotForgot =
      effectiveBotForgot !== cfg.botProtection
        ? { ...cfg, botProtection: effectiveBotForgot }
        : cfg;

    // Bot protection (plugável): valida o token do widget ANTES de emitir o token
    // de reset. Fail-safe: erro/timeout no verify do host PERMITE o fluxo.
    if (!(await guardBotProtection(ctx, cfgWithEffectiveBotForgot as any, 'reset'))) {
      return render(ctx, 'forgot', {
        csrfToken: ctx.request.csrfToken,
        error: translate(cfg.messages, 'errors.bot_protection_failed'),
        botProtection: effectiveBotForgot?.widget,
      });
    }

    const { email } = await ctx.request.validateUsing(forgotPasswordValidator);
    const accountStore = cfg.accountStore;
    // `email` já saiu normalizado do validator (a MESMA normalização do
    // cadastro e do login). Resposta uniforme: a tela abaixo é a mesma, ache
    // conta ou não.
    const result = await accountStore.issuePasswordResetToken(email);
    if (result) {
      await cfg.audit?.record({
        type: 'password_reset.issued',
        email: result.account.email,
        ip: ctx.request.ip?.() ?? null,
      });
      const origin = authkitOrigin(cfg);
      const url = `${origin}/auth/reset-password?token=${result.token}`;
      // Hook do config tem prioridade (override); senão usa o mailer default do host.
      // O link vai para a caixa postal sob a qual a conta está gravada.
      const to = result.account.email;
      if (cfg.mail?.onPasswordReset) {
        await cfg.mail.onPasswordReset({ email: to, resetUrl: url, token: result.token });
      } else {
        await sendPasswordResetEmail(ctx, { email: to, resetUrl: url });
      }
    }
    return render(ctx, 'forgot', {
      csrfToken: ctx.request.csrfToken,
      sent: true,
    });
  }

  /** GET /auth/reset-password?token=... — tela standalone. */
  async showReset(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const token = ctx.request.qs().token ?? '';
    return render(ctx, 'reset', { token, csrfToken: ctx.request.csrfToken });
  }

  /** POST /auth/reset-password — redefine a senha. */
  async reset(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const { token, password } = await ctx.request.validateUsing(resetPasswordValidator);
    const accountStore = cfg.accountStore;

    // Pré-lookup da conta pelo token (best-effort) para a notificação de segurança.
    // O token é consumido a seguir, então buscamos antes de chamar consumePasswordResetToken.
    let accountForNotice: { id: string; email: string } | undefined;
    try {
      // issuePasswordResetToken coloca o token no campo passwordResetToken; podemos
      // procurar pelo e-mail via store se ele suportar lookup por token (não é um
      // método público). Tentamos via findByPasswordResetToken se disponível; senão
      // pulamos o aviso graciosamente.
      const storeAny = accountStore as any;
      if (typeof storeAny.findByPasswordResetToken === 'function') {
        accountForNotice = await storeAny.findByPasswordResetToken(token);
      }
    } catch {
      // Silencioso — aviso é best-effort.
    }

    let ok: boolean;
    try {
      ok = await accountStore.consumePasswordResetToken(token, password);
    } catch (error) {
      // Política de senha violada → re-renderiza a tela de reset com a regra.
      if (error instanceof PasswordPolicyError) {
        return render(ctx, 'reset', {
          token,
          csrfToken: ctx.request.csrfToken,
          error: translate(cfg.messages, error.key, error.params),
        });
      }
      throw error;
    }
    if (!ok) {
      return ctx.response.badRequest({
        error: translate(cfg.messages, 'errors.invalid_or_expired_token'),
      });
    }
    await cfg.audit?.record({
      type: 'password_reset.consumed',
      ip: ctx.request.ip?.() ?? null,
    });
    // M2: reset de senha INVALIDA todas as sessões/grants da conta (segurança >
    // conveniência — quem reseta a senha pode estar recuperando uma conta
    // comprometida). Best-effort/fail-safe: uma falha aqui NÃO falha o reset.
    if (accountForNotice) {
      try {
        const sessions = new AdminSessionsService(service);
        const result = await sessions.revokeAll(accountForNotice.id);
        await cfg.audit?.record({
          type: 'session.revoked_all',
          accountId: accountForNotice.id,
          actorId: null,
          ip: ctx.request.ip?.() ?? null,
          metadata: {
            sessions: result.sessions,
            grants: result.grants,
            accessTokens: result.accessTokens,
            refreshTokens: result.refreshTokens,
            source: 'password-reset',
          },
        });
      } catch {
        // fail-safe: a troca de senha já vale; a invalidação é best-effort.
      }
    }
    // Notificação de segurança: senha alterada via reset (best-effort, fail-safe).
    if (accountForNotice) {
      await dispatchSecurityNotice(
        ctx,
        {
          account: accountForNotice,
          kind: 'password_changed',
          ip: ctx.request.ip?.() ?? null,
          timestamp: new Date().toISOString(),
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }
    return render(ctx, 'reset', {
      token: '',
      csrfToken: ctx.request.csrfToken,
      done: true,
    });
  }

  /** GET /auth/verify-email?token=... — consome o token e mostra sucesso/falha. */
  async verifyEmail(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;
    const token = ctx.request.qs().token ?? '';
    const ok = await cfg.accountStore.consumeEmailVerificationToken(token);
    if (ok) {
      await cfg.audit?.record({
        type: 'email_verification.consumed',
        ip: ctx.request.ip?.() ?? null,
      });
    }
    return render(ctx, 'verify-email', { verified: ok });
  }
}
