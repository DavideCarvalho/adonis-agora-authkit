import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import {
  supportsAccountDeletion,
  supportsAccountSecurity,
  supportsPasswordHistory,
  supportsProfile,
} from '../../accounts/account_store.js';
import { PasswordPolicyError } from '../../password/password_manager.js';
import { AccountDeletionService } from '../account_deletion_service.js';
import { AccountExportService } from '../account_export_service.js';
import { getAccountLoginUrl } from '../account_login_url.js';
import { accountPath } from '../account_paths.js';
import type { AccountEmailConfirmedProps, AccountSecurityProps } from '../account_screen_props.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { syncAdonisAuthLogout } from '../adonis_auth_sync.js';
import { AvatarUploadError, isAvatarUploadSupported, storeAvatar } from '../avatar_storage.js';
import {
  sendEmailChangeConfirmationEmail,
  sendEmailChangeNoticeEmail,
  sendEmailChangedCompletedEmail,
} from '../default_mailer.js';
import { translate } from '../i18n.js';
import { authkitOrigin } from '../origin.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import {
  resolveEffectiveEmailChange,
  resolveEffectivePasswordHistory,
} from '../runtime_toggles.js';
import { dispatchSecurityNotice } from '../security_notice_service.js';
import { enrichSessionsWithContext } from '../session_context.js';
import { requireSudo } from '../sudo_mode.js';
import { TRUSTED_DEVICE_COOKIE } from '../trusted_device.js';
import {
  changeEmailValidator,
  changePasswordValidator,
  deleteAccountValidator,
  updateProfileValidator,
} from '../validators.js';

/** Resolve os password history settings em runtime (fail-safe). */
async function resolvePasswordHistorySettings(ctx: HttpContext) {
  try {
    const runtimeSettings = await resolveRuntimeSettings(ctx);
    if (runtimeSettings && (await runtimeSettings.isTablePresent())) {
      return await resolveEffectivePasswordHistory(runtimeSettings);
    }
  } catch {
    // DB não disponível ou tabela ausente → usa defaults.
  }
  return { enabled: false, count: 5 };
}

/** Resolve os settings de troca de e-mail em runtime (fail-safe). */
async function resolveEmailChangeSettings(ctx: HttpContext) {
  try {
    const runtimeSettings = await resolveRuntimeSettings(ctx);
    if (runtimeSettings && (await runtimeSettings.isTablePresent())) {
      return await resolveEffectiveEmailChange(runtimeSettings);
    }
  } catch {
    // DB não disponível ou tabela ausente → usa defaults.
  }
  return { enabled: true, ttlHours: 24, requirePassword: true };
}

/**
 * Self-service de segurança da conta (console de conta): trocar a senha e o
 * e-mail. A troca de senha exige a senha ATUAL (verifyCredentials). A troca de
 * e-mail exige a senha atual e dispara um link de confirmação para o NOVO
 * endereço (consumido em GET /account/email/confirm). Degrada graciosamente se o
 * store não suportar a capacidade ({@link supportsAccountSecurity}).
 */
export default class AccountSecurityController {
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const account = await cfg.accountStore.findById(userId);

    // Sessões ativas da PRÓPRIA conta (enriquecidas com contexto de dispositivo),
    // capability-probed: só quando o adapter OIDC enumera.
    const adminSessions = new AdminSessionsService(service);
    const sessionsSupported = adminSessions.canList;
    const ownSessions = sessionsSupported
      ? await enrichSessionsWithContext(cfg, userId, await adminSessions.listSessions(userId))
      : [];

    const props = {
      csrfToken: ctx.request.csrfToken,
      supported: supportsAccountSecurity(cfg.accountStore),
      profileSupported: supportsProfile(cfg.accountStore),
      // Só mostramos o input de arquivo se ALGUM backend (drive OU media) puder armazenar.
      avatarUploadSupported: await isAvatarUploadSupported(cfg.uploads),
      email: account?.email ?? '',
      name: account?.name ?? '',
      avatarUrl: account?.avatarUrl ?? '',
      passwordChanged: ctx.session.flashMessages.get('passwordChanged') ?? null,
      emailChangeRequested: ctx.session.flashMessages.get('emailChangeRequested') ?? null,
      emailChanged: ctx.session.flashMessages.get('emailChanged') ?? null,
      profileUpdated: ctx.session.flashMessages.get('profileUpdated') ?? null,
      error: ctx.session.flashMessages.get('securityError') ?? null,
      trustedDevicesEnabled: cfg.trustedDevices.enabled,
      trustedDevicesRevoked: ctx.session.flashMessages.get('trustedDevicesRevoked') ?? null,
      sessionsSupported,
      sessions: ownSessions.map((s) => ({
        loginTs: s.loginTs ? new Date(s.loginTs * 1000).toISOString() : '',
        browser: s.browser ?? '',
        os: s.os ?? '',
        ip: s.ip ?? '',
        location: s.location ?? '',
      })),
      // Export de dados (portabilidade) sempre disponível para a conta logada.
      exportSupported: true,
      // Deleção de conta (LGPD): só quando o store suporta hard delete.
      deletionSupported: supportsAccountDeletion(cfg.accountStore),
      deleteError: ctx.session.flashMessages.get('deleteError') ?? null,
    } satisfies Omit<AccountSecurityProps, 'messages'>;

    return render(ctx, 'account/security', props);
  }

  /**
   * GET /account/security/export — baixa um JSON com os dados da conta logada
   * (perfil, identidades, apps autorizados, sessões, passkeys e audit do usuário).
   * NUNCA inclui segredos. Audita `account.exported`.
   */
  async exportData(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    if (cfg.accountLifecycle?.durable) {
      // OPT-IN durável: enfileira o workflow de export (coleta + persiste artefato
      // + entrega async). Isolado no subpath durável — só carregado neste ramo.
      const { resolveWorkflowEngine, enqueueAccountExport } = await import('../durable/index.js');
      const engine = await resolveWorkflowEngine(ctx.containerResolver);
      await enqueueAccountExport(engine, {
        accountId: userId,
        ip: ctx.request.ip?.() ?? null,
      });
      ctx.session.flash('exportRequested', translate(cfg.messages, 'account.export.requested'));
      return ctx.response.redirect(accountPath('security'));
    }

    // Caminho SÍNCRONO de sempre (byte-idêntico): download inline do JSON.
    const payload = await new AccountExportService(service).export(userId);
    if (!payload) {
      return ctx.response.notFound();
    }

    await cfg.audit?.record({
      type: 'account.exported',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });

    ctx.response.header('content-type', 'application/json; charset=utf-8');
    ctx.response.header(
      'content-disposition',
      `attachment; filename="authkit-data-export-${userId}.json"`,
    );
    return ctx.response.send(JSON.stringify(payload, null, 2));
  }

  /**
   * POST /account/security/delete — deleção self-service da conta (danger zone).
   * Exige confirmação: a senha ATUAL (se confere via verifyCredentials) OU o
   * e-mail digitado igual ao da conta (contas passwordless). Roda o cascade
   * completo e encerra a sessão.
   */
  async deleteAccount(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsAccountDeletion(store)) {
      return ctx.response.redirect(accountPath('security'));
    }

    // Sudo mode gate (defesa em profundidade — confirmação inline continua abaixo).
    const sudoSettingsDel = await resolveRuntimeSettings(ctx);
    const sudoResultDel = await requireSudo(ctx, sudoSettingsDel);
    if (sudoResultDel !== true) return sudoResultDel;

    const account = await store.findById(userId);
    if (!account) {
      return ctx.response.redirect(getAccountLoginUrl());
    }

    const { currentPassword, confirmEmail } =
      await ctx.request.validateUsing(deleteAccountValidator);

    // Confirmação: senha atual correta OU e-mail digitado batendo com o da conta
    // (case-insensitive). Sem nenhuma das duas → recusa (não deleta).
    let confirmed = false;
    if (currentPassword) {
      confirmed = !!(await store.verifyCredentials(account.email, currentPassword));
    }
    if (!confirmed && confirmEmail) {
      confirmed = confirmEmail.trim().toLowerCase() === account.email.toLowerCase();
    }
    if (!confirmed) {
      ctx.session.flash(
        'deleteError',
        translate(cfg.messages, 'account.delete.invalid_confirmation'),
      );
      return ctx.response.redirect(accountPath('security'));
    }

    const actor = {
      actorId: userId,
      ip: ctx.request.ip?.() ?? null,
      source: 'self' as const,
    };

    if (cfg.accountLifecycle?.durable) {
      // OPT-IN durável (self-service): logout IMEDIATO (revoga as sessões/grants
      // OIDC do ator de forma síncrona) + enfileira o resto do cascade async.
      // Isolado no subpath durável — só carregado neste ramo.
      const { resolveWorkflowEngine, enqueueAccountDeletion } = await import('../durable/index.js');
      try {
        const { revokeSessions } = await import('../account_deletion_ops.js');
        await revokeSessions(service, userId);
      } catch {
        // best-effort: o logout do cookie abaixo já tira o usuário; o workflow
        // re-revoga as sessões na sua própria etapa idempotente.
      }
      const engine = await resolveWorkflowEngine(ctx.containerResolver);
      await enqueueAccountDeletion(engine, { accountId: userId, actor });
    } else {
      // Caminho SÍNCRONO de sempre (byte-idêntico): cascade completo in-process.
      await new AccountDeletionService(service).delete(userId, actor);
    }

    // Encerra a sessão e leva ao login com a mensagem de sucesso.
    ctx.session.forget(ACCOUNT_SESSION_KEY);
    await syncAdonisAuthLogout(ctx, cfg);
    ctx.session.flash('accountDeleted', translate(cfg.messages, 'account.delete.deleted'));
    return ctx.response.redirect(getAccountLoginUrl());
  }

  /**
   * POST /account/security/trusted-devices/revoke
   * Limpa o cookie de dispositivo confiável DESTE navegador (o MFA volta a ser
   * exigido aqui). Revogação global por-dispositivo não existe sem estado
   * server-side; re-enrolar o MFA invalida a confiança em TODOS os dispositivos.
   */
  async revokeTrustedDevices(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    ctx.response.clearCookie(TRUSTED_DEVICE_COOKIE);
    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    await cfg.audit?.record({
      type: 'trusted_device.revoked',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });
    ctx.session.flash(
      'trustedDevicesRevoked',
      translate(cfg.messages, 'account.security.trusted_devices_revoked'),
    );
    return ctx.response.redirect(accountPath('security'));
  }

  /** POST /account/security/profile — atualiza nome + avatar do próprio perfil. */
  async updateProfile(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsProfile(store)) {
      return ctx.response.redirect(accountPath('security'));
    }

    const { name, avatarUrl } = await ctx.request.validateUsing(updateProfileValidator);

    // Upload de avatar via o drive do app (opt-in pela presença do arquivo).
    // Se um arquivo for enviado e o drive estiver disponível, a URL resultante
    // tem prioridade sobre o input de URL; senão caímos no avatarUrl (texto).
    let resolvedAvatarUrl: string | null = avatarUrl ?? null;
    let via: 'upload' | 'url' = 'url';
    const file = ctx.request.file('avatar', {
      size: `${cfg.uploads.avatars.maxSizeMb}mb`,
      extnames: ['jpg', 'jpeg', 'png', 'webp'],
    });
    if (file) {
      try {
        const uploadedUrl = await storeAvatar(ctx, cfg.uploads, file as any, userId, {
          extname: translate(cfg.messages, 'account.profile.avatar_invalid_type'),
          size: translate(cfg.messages, 'account.profile.avatar_too_large'),
        });
        if (uploadedUrl) {
          resolvedAvatarUrl = uploadedUrl;
          via = 'upload';
        }
      } catch (error) {
        if (error instanceof AvatarUploadError) {
          ctx.session.flash('securityError', error.message);
          return ctx.response.redirect(accountPath('security'));
        }
        throw error;
      }
    }

    // Campos ausentes no form viram string vazia (limpa o valor); enviamos null
    // para limpar, ou o valor trimado.
    await store.updateProfile(userId, {
      name: name ?? null,
      avatarUrl: resolvedAvatarUrl,
    });

    await cfg.audit?.record({
      type: 'profile.updated',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { via },
    });
    ctx.session.flash('profileUpdated', translate(cfg.messages, 'account.profile.updated'));
    return ctx.response.redirect(accountPath('security'));
  }

  async changePassword(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsAccountSecurity(store)) {
      return ctx.response.redirect(accountPath('security'));
    }

    // Sudo mode gate (defesa em profundidade — a verificação de senha ATUAL continua abaixo).
    const sudoSettings = await resolveRuntimeSettings(ctx);
    const sudoResult = await requireSudo(ctx, sudoSettings);
    if (sudoResult !== true) return sudoResult;

    const { currentPassword, newPassword } =
      await ctx.request.validateUsing(changePasswordValidator);
    const account = await store.findById(userId);
    // Confirma a senha ATUAL pelo e-mail da conta.
    const verified = account ? await store.verifyCredentials(account.email, currentPassword) : null;
    if (!verified) {
      ctx.session.flash('securityError', translate(cfg.messages, 'errors.invalid_credentials'));
      return ctx.response.redirect(accountPath('security'));
    }

    // Verificação de histórico de senhas (disallow_password_reuse).
    // Capability-probed: sem `isPasswordReused` ou com setting desligada → no-op.
    if (supportsPasswordHistory(store)) {
      const histSettings = await resolvePasswordHistorySettings(ctx);
      if (histSettings.enabled) {
        // Aplica o pepper à senha candidata antes de comparar com os hashes históricos
        // (que foram gravados já com pepper). Pepper ausente → identidade.
        const pepperedNew =
          (cfg.accountStore as any).__passwordManager?.applyCurrentPepper?.(newPassword) ??
          newPassword;
        const reused = await store.isPasswordReused!(userId, pepperedNew, histSettings.count);
        if (reused) {
          ctx.session.flash(
            'securityError',
            translate(cfg.messages, 'password.reused', {
              count: histSettings.count,
            }),
          );
          return ctx.response.redirect(accountPath('security'));
        }
        // Grava o hash ATUAL no histórico antes de trocar.
        // O hash atual está na linha do DB — buscamos via store.findById + raw model.
        const rawRow = await (cfg.accountStore as any).__getRawRow?.(userId);
        if (rawRow?.password) {
          await store.recordPasswordHistory!(userId, rawRow.password);
          await store.prunePasswordHistory!(userId, histSettings.count);
        }
      }
    }

    try {
      await store.changePassword(userId, newPassword);
    } catch (error) {
      // Política de senha violada → flash com a regra e volta à tela de segurança.
      if (error instanceof PasswordPolicyError) {
        ctx.session.flash('securityError', translate(cfg.messages, error.key, error.params));
        return ctx.response.redirect(accountPath('security'));
      }
      throw error;
    }
    await cfg.audit?.record({
      type: 'password.changed',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });
    // M2: troca de senha INVALIDA as sessões/grants OIDC da conta. A sessão do
    // console de conta (cookie Adonis, ACCOUNT_SESSION_KEY) NÃO é tocada por
    // revokeAll — ela só destrói sessões/grants OIDC — então o usuário corrente
    // permanece logado no console, enquanto todas as sessões SSO derivadas da
    // senha antiga são derrubadas. Best-effort/fail-safe.
    try {
      const sessions = new AdminSessionsService(service);
      const result = await sessions.revokeAll(userId);
      await cfg.audit?.record({
        type: 'session.revoked_all',
        accountId: userId,
        actorId: userId,
        ip: ctx.request.ip?.() ?? null,
        metadata: {
          sessions: result.sessions,
          grants: result.grants,
          accessTokens: result.accessTokens,
          refreshTokens: result.refreshTokens,
          source: 'password-change',
        },
      });
    } catch {
      // fail-safe: a troca de senha já vale; a invalidação é best-effort.
    }
    // Notificação de segurança ao titular da conta (best-effort, fail-safe).
    if (account) {
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: userId, email: account.email },
          kind: 'password_changed',
          ip: ctx.request.ip?.() ?? null,
          timestamp: new Date().toISOString(),
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }
    ctx.session.flash(
      'passwordChanged',
      translate(cfg.messages, 'account.security.password_changed'),
    );
    return ctx.response.redirect(accountPath('security'));
  }

  async changeEmail(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsAccountSecurity(store)) {
      return ctx.response.redirect(accountPath('security'));
    }

    // Sudo mode gate.
    const sudoSettingsEmail = await resolveRuntimeSettings(ctx);
    const sudoResultEmail = await requireSudo(ctx, sudoSettingsEmail);
    if (sudoResultEmail !== true) return sudoResultEmail;

    // Resolve os settings de troca de e-mail em runtime.
    const emailChangeSettings = await resolveEmailChangeSettings(ctx);
    if (!emailChangeSettings.enabled) {
      ctx.session.flash(
        'securityError',
        translate(cfg.messages, 'account.security.email_change_disabled'),
      );
      return ctx.response.redirect(accountPath('security'));
    }

    const { currentPassword, newEmail } = await ctx.request.validateUsing(changeEmailValidator);
    const account = await store.findById(userId);

    // requirePassword: se ligado (default true), exige senha atual.
    if (emailChangeSettings.requirePassword) {
      if (!currentPassword) {
        ctx.session.flash('securityError', translate(cfg.messages, 'errors.invalid_credentials'));
        return ctx.response.redirect(accountPath('security'));
      }
      const verified = account
        ? await store.verifyCredentials(account.email, currentPassword)
        : null;
      if (!verified) {
        ctx.session.flash('securityError', translate(cfg.messages, 'errors.invalid_credentials'));
        return ctx.response.redirect(accountPath('security'));
      }
    }

    const issued = await store.requestEmailChange(userId, newEmail);
    if (!issued) {
      ctx.session.flash('securityError', translate(cfg.messages, 'errors.email_taken'));
      return ctx.response.redirect(accountPath('security'));
    }

    await cfg.audit?.record({
      type: 'email_change.requested',
      accountId: userId,
      email: newEmail,
      ip: ctx.request.ip?.() ?? null,
    });

    const origin = authkitOrigin(cfg);
    const confirmUrl = `${origin}${accountPath('emailConfirm')}?token=${encodeURIComponent(issued.token)}`;

    // 1. Link de confirmação → NOVO e-mail (hook onEmailChangeConfirm > onEmailVerification > default).
    if (cfg.mail?.onEmailChangeConfirm) {
      await cfg.mail.onEmailChangeConfirm({
        email: newEmail,
        confirmUrl,
        token: issued.token,
        oldEmail: account?.email ?? '',
      });
    } else if (cfg.mail?.onEmailVerification) {
      // Retrocompat: hook legado onEmailVerification (ainda funciona como override).
      await cfg.mail.onEmailVerification({
        email: newEmail,
        verifyUrl: confirmUrl,
        token: issued.token,
      });
    } else {
      await sendEmailChangeConfirmationEmail(ctx, {
        email: newEmail,
        confirmUrl,
      });
    }

    // 2. Aviso de segurança → e-mail ATUAL (best-effort, fail-safe).
    if (account) {
      if (cfg.mail?.onEmailChangeNotice) {
        await cfg.mail.onEmailChangeNotice({ email: account.email, newEmail });
      } else {
        await sendEmailChangeNoticeEmail(ctx, cfg, {
          email: account.email,
          newEmail,
        });
      }
    }

    ctx.session.flash(
      'emailChangeRequested',
      translate(cfg.messages, 'account.security.email_change_requested', {
        email: newEmail,
      }),
    );
    return ctx.response.redirect(accountPath('security'));
  }

  /**
   * POST /account/security/email/cancel — cancela uma troca de e-mail pendente
   * (limpa o token pending sem alterar o e-mail da conta).
   */
  async cancelEmailChange(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsAccountSecurity(store)) {
      return ctx.response.redirect(accountPath('security'));
    }

    // Implementação: issuePendingToken(userId, null) limpa o token; reutilizamos
    // requestEmailChange com um valor sentinela → não, melhor usar cancelEmailChange
    // se o store o suportar, senão fallback: sobreescrevemos o token pendente com um
    // token fictício que nunca será confirmado (mas abre nova solicitação).
    // A forma mais limpa é verificar se o store tem cancelEmailChange; se não tiver,
    // chamamos requestEmailChange com o próprio e-mail atual (limpa o pending antigo).
    const cancelFn = (store as any).cancelEmailChange;
    if (typeof cancelFn === 'function') {
      await cancelFn.call(store, userId);
    } else {
      // Fallback: sobrescreve o pending com o próprio e-mail (não tem efeito após confirm).
      const account = await store.findById(userId);
      if (account) {
        // Limpa o token pending emitindo um novo token para o mesmo e-mail e depois
        // confirmando imediatamente — ou simplesmente apaga o campo via requestEmailChange
        // com o mesmo e-mail (que é idempotente e limpa o anterior).
        await store.requestEmailChange(userId, account.email);
      }
    }

    await cfg.audit?.record({
      type: 'email_change.cancelled',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });

    ctx.session.flash(
      'emailChangeRequested',
      translate(cfg.messages, 'account.security.email_change_cancelled'),
    );
    return ctx.response.redirect(accountPath('security'));
  }

  /** GET /account/email/confirm?token=... — consome o token e aplica o novo e-mail. */
  async confirmEmail(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const render = cfg.render!;

    if (!supportsAccountSecurity(store)) {
      return render(ctx, 'account/email-confirmed', { ok: false } satisfies Omit<
        AccountEmailConfirmedProps,
        'messages'
      >);
    }

    const token = ctx.request.qs().token ?? '';
    const result = await store.confirmEmailChange(token);
    if (result.ok) {
      await cfg.audit?.record({
        type: 'email_change.confirmed',
        accountId: result.account.id,
        email: result.newEmail,
        ip: ctx.request.ip?.() ?? null,
        metadata: { oldEmail: result.oldEmail },
      });

      // Aviso de conclusão ao e-mail ANTIGO: "seu e-mail foi alterado de A para B".
      // Best-effort, fail-safe.
      if (cfg.mail?.onEmailChangeNotice) {
        // Reusa onEmailChangeNotice para o aviso pós-confirmação ao endereço antigo.
        await cfg.mail
          .onEmailChangeNotice({
            email: result.oldEmail,
            newEmail: result.newEmail,
          })
          .catch(() => {});
      } else {
        await sendEmailChangedCompletedEmail(ctx, cfg, {
          oldEmail: result.oldEmail,
          newEmail: result.newEmail,
        });
      }

      // Notificação de segurança ao NOVO e-mail (email_changed) — best-effort.
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: result.account.id, email: result.newEmail },
          kind: 'email_changed',
          ip: ctx.request.ip?.() ?? null,
          timestamp: new Date().toISOString(),
          metadata: { oldEmail: result.oldEmail, newEmail: result.newEmail },
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }
    return render(ctx, 'account/email-confirmed', { ok: result.ok } satisfies Omit<
      AccountEmailConfirmedProps,
      'messages'
    >);
  }
}
