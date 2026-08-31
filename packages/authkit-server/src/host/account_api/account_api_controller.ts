/**
 * Account Self-Service JSON API
 *
 * Endpoints JSON sob `/account/api/*` (session-authed via accountGuard, mutating
 * com CSRF). Reusa a lógica dos controllers de conta existentes sem duplicar regras.
 *
 * Mapa de rotas:
 *   GET  /account/api/me                    → perfil + flags
 *   GET  /account/api/security              → overview de segurança (sessões, MFA, etc.)
 *   PATCH /account/api/profile              → atualizar nome/avatar
 *   POST /account/api/password              → trocar senha (sudo + senha atual)
 *   POST /account/api/email-change          → solicitar troca de e-mail (sudo)
 *   POST /account/api/email-change/cancel   → cancelar troca pendente
 *   GET  /account/api/sessions              → sessões ativas
 *   DELETE /account/api/sessions/:id        → revogar uma sessão
 *   POST /account/api/sessions/revoke-others → revogar todas exceto a atual
 *   POST /account/api/sessions/revoke-all   → revogar TODAS + logout global (signedOut: true)
 *   GET  /account/api/apps                  → grants (apps autorizados)
 *   DELETE /account/api/apps/:clientId      → revogar consentimento de um app
 *   GET  /account/api/mfa                   → status MFA (totp + passkeys + recovery)
 *   GET  /account/api/passkeys              → lista passkeys
 *   DELETE /account/api/passkeys/:id        → remover passkey
 *   GET  /account/api/tokens               → lista PATs
 *   POST /account/api/tokens               → criar PAT (sudo)
 *   DELETE /account/api/tokens/:id         → revogar PAT (sudo)
 *   GET  /account/api/orgs                 → lista orgs do usuário
 *   GET  /account/api/orgs/:id             → detalhe de org (requer membership)
 *   GET  /account/api/orgs/invitations     → convites pendentes
 */

import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import {
  type PasskeySummary,
  supportsAccountSecurity,
  supportsLoginMethodsPreference,
  supportsMagicLink,
  supportsOrganizations,
  supportsPasskeys,
  supportsProfile,
} from '../../accounts/account_store.js';
import { PasswordPolicyError } from '../../password/password_manager.js';
import type { PatRecord } from '../../pat/pat_store.js';
import { accountPath } from '../account_paths.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { ACTIVE_ORG_COOKIE } from '../active_org_cookie.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { syncAdonisAuthLogout } from '../adonis_auth_sync.js';
import { AvatarUploadError, isAvatarUploadSupported, storeAvatar } from '../avatar_storage.js';
import { sendEmailChangeConfirmationEmail, sendEmailChangeNoticeEmail } from '../default_mailer.js';
import { translate } from '../i18n.js';
import { authkitOrigin } from '../origin.js';
import { resolveRuntimeSettings, resolveRuntimeSettingsOrNoop } from '../runtime_settings.js';
import {
  configLockedAuthMethods,
  resolveEffectiveAuthMethods,
  resolveEffectiveEmailChange,
  resolveEffectivePasswordHistory,
} from '../runtime_toggles.js';
import { dispatchSecurityNotice } from '../security_notice_service.js';
import { enrichSessionsWithContext } from '../session_context.js';
import {
  isSudoActive,
  requireSudo,
  resolveEffectiveSudoMode,
  SUDO_MODE_DEFAULTS,
} from '../sudo_mode.js';
import {
  parseUserLoginMethodsPayload,
  resolveEffectiveUserLoginMethods,
} from '../user_login_methods.js';
import {
  changeEmailValidator,
  changePasswordValidator,
  updateProfileValidator,
} from '../validators.js';

// ---------------------------------------------------------------------------
// Helpers (shared with existing controllers — kept local to avoid coupling)
// ---------------------------------------------------------------------------

async function resolvePasswordHistorySettings(ctx: HttpContext) {
  try {
    const rs = await resolveRuntimeSettings(ctx);
    if (rs && (await rs.isTablePresent())) {
      return await resolveEffectivePasswordHistory(rs);
    }
  } catch {
    /* fail-safe */
  }
  return { enabled: false, count: 5 };
}

async function resolveEmailChangeSettings(ctx: HttpContext) {
  try {
    const rs = await resolveRuntimeSettings(ctx);
    if (rs && (await rs.isTablePresent())) {
      return await resolveEffectiveEmailChange(rs);
    }
  } catch {
    /* fail-safe */
  }
  return { enabled: true, ttlHours: 24, requirePassword: true };
}

/** Erro JSON padrão. */
function apiErr(code: string, message: string) {
  return { error: { code, message } };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export default class AccountApiController {
  // ─── GET /account/api/me ─────────────────────────────────────────────────

  /** Perfil + flags do usuário logado. */
  async me(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const account = await cfg.accountStore.findById(userId);
    if (!account) return ctx.response.unauthorized(apiErr('unauthorized', 'Not authenticated.'));

    // Sudo mode ativo?
    let sudoActive = false;
    try {
      const sudoSettings = await resolveRuntimeSettings(ctx);
      const resolved = sudoSettings
        ? await resolveEffectiveSudoMode(sudoSettings)
        : SUDO_MODE_DEFAULTS;
      sudoActive = resolved.enabled ? isSudoActive(ctx, resolved.graceMinutes) : true;
    } catch {
      /* fail-safe */
    }

    // Contagem de passkeys (capability-probed).
    let passkeyCount = 0;
    if (supportsPasskeys(cfg.accountStore)) {
      try {
        const passkeys = await cfg.accountStore.listPasskeys(userId);
        passkeyCount = passkeys.length;
      } catch {
        /* fail-safe */
      }
    }

    // MFA ativo?
    let mfaEnabled = false;
    try {
      const mfaState = await cfg.accountStore.getMfaState?.(userId);
      mfaEnabled = mfaState?.enabled ?? false;
    } catch {
      /* fail-safe */
    }

    // hasPassword: true quando a conta tem senha (verifyCredentials retorna algo com
    // o próprio e-mail; usamos flag de capacidade — stores passwordless retornam null).
    // Na prática, a presença de `changePassword` no store indica suporte a senha.
    const hasPassword = supportsAccountSecurity(cfg.accountStore);

    return {
      id: account.id,
      email: account.email,
      emailVerified: (account as any).emailVerified ?? null,
      name: account.name ?? null,
      avatarUrl: account.avatarUrl ?? null,
      globalRoles: account.globalRoles ?? [],
      hasPassword,
      mfaEnabled,
      passkeyCount,
      sudoActive,
      capabilities: {
        securitySupported: supportsAccountSecurity(cfg.accountStore),
        profileSupported: supportsProfile(cfg.accountStore),
        passkeysSupported: supportsPasskeys(cfg.accountStore),
        orgsSupported: supportsOrganizations(cfg.accountStore),
        tokensSupported: !!cfg.patStore,
        avatarUploadSupported: await isAvatarUploadSupported(cfg.uploads),
        sessionsSupported: new AdminSessionsService(service).canList,
      },
    };
  }

  // ─── GET /account/api/security ───────────────────────────────────────────

  /** Overview de segurança: sessões ativas, status MFA, passkeys, last pw change. */
  async securityOverview(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const account = await cfg.accountStore.findById(userId);
    if (!account) return ctx.response.unauthorized(apiErr('unauthorized', 'Not authenticated.'));

    // Sessões ativas (capability-probed).
    const adminSessions = new AdminSessionsService(service);
    const sessionsSupported = adminSessions.canList;
    const rawSessions = sessionsSupported ? await adminSessions.listSessions(userId) : [];
    const enriched = await enrichSessionsWithContext(cfg, userId, rawSessions);

    // MFA status.
    let mfaEnabled = false;
    let totpEnrolled = false;
    try {
      const mfaState = await cfg.accountStore.getMfaState?.(userId);
      mfaEnabled = mfaState?.enabled ?? false;
      totpEnrolled = mfaState?.enabled ?? false;
    } catch {
      /* fail-safe */
    }

    // Passkeys.
    const passkeysSupported = supportsPasskeys(cfg.accountStore);
    let passkeys: PasskeySummary[] = [];
    if (passkeysSupported) {
      try {
        passkeys = await cfg.accountStore.listPasskeys(userId);
      } catch {
        /* fail-safe */
      }
    }

    // Pending email change.
    const pendingEmail = (account as any).pendingEmail ?? null;

    return {
      email: account.email,
      pendingEmail,
      securitySupported: supportsAccountSecurity(cfg.accountStore),
      profileSupported: supportsProfile(cfg.accountStore),
      sessionsSupported,
      activeSessions: enriched.map((s) => ({
        id: s.id,
        loginTs: s.loginTs ? new Date(s.loginTs * 1000).toISOString() : null,
        browser: s.browser ?? null,
        os: s.os ?? null,
        ip: s.ip ?? null,
        location: s.location ?? null,
        amr: s.amr ?? [],
      })),
      mfa: {
        enabled: mfaEnabled,
        totpEnrolled,
        passkeyCount: passkeys.length,
        passkeysSupported,
      },
    };
  }

  // ─── PATCH /account/api/profile ─────────────────────────────────────────

  /** Atualizar nome + avatar do perfil. */
  async updateProfile(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsProfile(store)) {
      return ctx.response
        .status(422)
        .send(
          apiErr(
            'capability_unsupported',
            translate(cfg.messages, 'account.profile.not_supported'),
          ),
        );
    }

    const { name, avatarUrl } = await ctx.request.validateUsing(updateProfileValidator);

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
          return ctx.response.badRequest(apiErr('avatar_error', error.message));
        }
        throw error;
      }
    }

    const updated = await store.updateProfile(userId, {
      name: name ?? null,
      avatarUrl: resolvedAvatarUrl,
    });

    await cfg.audit?.record({
      type: 'profile.updated',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { via },
    });

    return {
      id: updated?.id ?? userId,
      name: updated?.name ?? null,
      avatarUrl: updated?.avatarUrl ?? null,
    };
  }

  // ─── POST /account/api/password ─────────────────────────────────────────

  /** Trocar senha. Exige sudo + senha atual (mesmo comportamento da tela). */
  async changePassword(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsAccountSecurity(store)) {
      return ctx.response
        .status(422)
        .send(
          apiErr(
            'capability_unsupported',
            translate(cfg.messages, 'account.security.not_supported'),
          ),
        );
    }

    // Sudo gate.
    const sudoSettings = await resolveRuntimeSettings(ctx);
    const sudoResult = await requireSudo(ctx, sudoSettings);
    if (sudoResult !== true) {
      // Para a API JSON, devolvemos 403 em vez de redirecionar.
      return ctx.response
        .status(403)
        .send(apiErr('sudo_required', 'Identity confirmation required.'));
    }

    const { currentPassword, newPassword } =
      await ctx.request.validateUsing(changePasswordValidator);
    const account = await store.findById(userId);
    const verified = account ? await store.verifyCredentials(account.email, currentPassword) : null;
    if (!verified) {
      return ctx.response
        .status(422)
        .send(apiErr('invalid_credentials', translate(cfg.messages, 'errors.invalid_credentials')));
    }

    // Histórico de senhas.
    const { supportsPasswordHistory } = await import('../../accounts/account_store.js');
    if (supportsPasswordHistory(store)) {
      const histSettings = await resolvePasswordHistorySettings(ctx);
      if (histSettings.enabled) {
        const pepperedNew =
          (cfg.accountStore as any).__passwordManager?.applyCurrentPepper?.(newPassword) ??
          newPassword;
        const reused = await store.isPasswordReused!(userId, pepperedNew, histSettings.count);
        if (reused) {
          return ctx.response
            .status(422)
            .send(
              apiErr(
                'password_reused',
                translate(cfg.messages, 'password.reused', { count: histSettings.count }),
              ),
            );
        }
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
      if (error instanceof PasswordPolicyError) {
        return ctx.response
          .status(422)
          .send(apiErr('password_policy', translate(cfg.messages, error.key, error.params)));
      }
      throw error;
    }

    await cfg.audit?.record({
      type: 'password.changed',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });

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

    return { ok: true };
  }

  // ─── POST /account/api/email-change ─────────────────────────────────────

  /** Solicitar troca de e-mail. Exige sudo. */
  async requestEmailChange(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsAccountSecurity(store)) {
      return ctx.response
        .status(422)
        .send(
          apiErr(
            'capability_unsupported',
            translate(cfg.messages, 'account.security.not_supported'),
          ),
        );
    }

    const sudoSettings = await resolveRuntimeSettings(ctx);
    const sudoResult = await requireSudo(ctx, sudoSettings);
    if (sudoResult !== true) {
      return ctx.response
        .status(403)
        .send(apiErr('sudo_required', 'Identity confirmation required.'));
    }

    const emailChangeSettings = await resolveEmailChangeSettings(ctx);
    if (!emailChangeSettings.enabled) {
      return ctx.response
        .status(422)
        .send(
          apiErr('disabled', translate(cfg.messages, 'account.security.email_change_disabled')),
        );
    }

    const { currentPassword, newEmail } = await ctx.request.validateUsing(changeEmailValidator);
    const account = await store.findById(userId);

    if (emailChangeSettings.requirePassword) {
      if (!currentPassword) {
        return ctx.response
          .status(422)
          .send(
            apiErr('invalid_credentials', translate(cfg.messages, 'errors.invalid_credentials')),
          );
      }
      const verified = account
        ? await store.verifyCredentials(account.email, currentPassword)
        : null;
      if (!verified) {
        return ctx.response
          .status(422)
          .send(
            apiErr('invalid_credentials', translate(cfg.messages, 'errors.invalid_credentials')),
          );
      }
    }

    const issued = await store.requestEmailChange(userId, newEmail);
    if (!issued) {
      return ctx.response
        .status(409)
        .send(apiErr('email_taken', translate(cfg.messages, 'errors.email_taken')));
    }

    await cfg.audit?.record({
      type: 'email_change.requested',
      accountId: userId,
      email: newEmail,
      ip: ctx.request.ip?.() ?? null,
    });

    const origin = authkitOrigin(cfg);
    const confirmUrl = `${origin}${accountPath('emailConfirm')}?token=${encodeURIComponent(issued.token)}`;

    if (cfg.mail?.onEmailChangeConfirm) {
      await cfg.mail.onEmailChangeConfirm({
        email: newEmail,
        confirmUrl,
        token: issued.token,
        oldEmail: account?.email ?? '',
      });
    } else if (cfg.mail?.onEmailVerification) {
      await cfg.mail.onEmailVerification({
        email: newEmail,
        verifyUrl: confirmUrl,
        token: issued.token,
      });
    } else {
      await sendEmailChangeConfirmationEmail(ctx, { email: newEmail, confirmUrl });
    }

    if (account) {
      if (cfg.mail?.onEmailChangeNotice) {
        await cfg.mail.onEmailChangeNotice({ email: account.email, newEmail });
      } else {
        await sendEmailChangeNoticeEmail(ctx, cfg, { email: account.email, newEmail });
      }
    }

    return { ok: true, email: newEmail };
  }

  // ─── POST /account/api/email-change/cancel ──────────────────────────────

  /** Cancelar troca de e-mail pendente. */
  async cancelEmailChange(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    if (!supportsAccountSecurity(store)) {
      return ctx.response
        .status(422)
        .send(
          apiErr(
            'capability_unsupported',
            translate(cfg.messages, 'account.security.not_supported'),
          ),
        );
    }

    const cancelFn = (store as any).cancelEmailChange;
    if (typeof cancelFn === 'function') {
      await cancelFn.call(store, userId);
    } else {
      const account = await store.findById(userId);
      if (account) {
        await store.requestEmailChange(userId, account.email);
      }
    }

    await cfg.audit?.record({
      type: 'email_change.cancelled',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });

    return { ok: true };
  }

  // ─── GET /account/api/sessions ──────────────────────────────────────────

  /** Sessões ativas do usuário logado. */
  async listSessions(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const adminSessions = new AdminSessionsService(service);
    const supported = adminSessions.canList;

    if (!supported) {
      return { supported: false, sessions: [] };
    }

    const rawSessions = await adminSessions.listSessions(userId);
    const enriched = await enrichSessionsWithContext(cfg, userId, rawSessions);

    return {
      supported: true,
      sessions: enriched.map((s) => ({
        id: s.id,
        loginTs: s.loginTs ? new Date(s.loginTs * 1000).toISOString() : null,
        browser: s.browser ?? null,
        os: s.os ?? null,
        ip: s.ip ?? null,
        location: s.location ?? null,
        amr: s.amr ?? [],
      })),
    };
  }

  // ─── DELETE /account/api/sessions/:id ──────────────────────────────────

  /** Revogar uma sessão específica (verifica que pertence ao usuário logado). */
  async revokeSession(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const sessionId = ctx.request.param('id') as string;

    const adminSessions = new AdminSessionsService(service);
    if (!adminSessions.canList) {
      return ctx.response
        .status(422)
        .send(
          apiErr('capability_unsupported', 'Session enumeration not supported by this adapter.'),
        );
    }

    // Verifica que a sessão pertence à conta logada.
    const sessions = await adminSessions.listSessions(userId);
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) {
      return ctx.response.notFound(apiErr('not_found', 'Session not found.'));
    }

    // Revoga via adapter diretamente.
    const AdapterClass = (service as any).config.AdapterClass;
    const sessionAdapter = new AdapterClass('Session');
    await sessionAdapter.destroy(sessionId);

    await cfg.audit?.record({
      type: 'session.revoked',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { sessionId, source: 'self' },
    });

    return { ok: true, revoked: sessionId };
  }

  // ─── POST /account/api/sessions/revoke-others ───────────────────────────

  /** Revogar todas as sessões exceto a atual (identificada pelo cookie de sessão). */
  async revokeOtherSessions(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const adminSessions = new AdminSessionsService(service);
    if (!adminSessions.canList) {
      return ctx.response
        .status(422)
        .send(
          apiErr('capability_unsupported', 'Session enumeration not supported by this adapter.'),
        );
    }

    // Sem sessão OIDC corrente identificável aqui (o console de conta usa sessão
    // Adonis, não sessão OIDC). Revogamos TODAS as sessões OIDC da conta.
    // Isso é seguro: a sessão Adonis do console não é uma sessão OIDC.
    const result = await adminSessions.revokeAll(userId);

    await cfg.audit?.record({
      type: 'session.revoked_all',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { ...result, source: 'self' },
    });

    return { ok: true, ...result };
  }

  // ─── POST /account/api/sessions/revoke-all ──────────────────────────────

  /**
   * Revogar TODAS as sessões OIDC + grants/tokens da conta e encerrar a sessão
   * Adonis do console (logout global). Retorna `{ ok, signedOut: true }` para que
   * a UI redirecione para o login.
   *
   * i18n keys: account.sessions.revoke_all_success (unused server-side — JSON API)
   */
  async revokeAllSessions(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const adminSessions = new AdminSessionsService(service);
    if (!adminSessions.canList) {
      return ctx.response
        .status(422)
        .send(
          apiErr('capability_unsupported', 'Session enumeration not supported by this adapter.'),
        );
    }

    // Revogar todas as sessões OIDC + grants da conta.
    const result = await adminSessions.revokeAll(userId);

    await cfg.audit?.record({
      type: 'account.signed_out_all',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { ...result, source: 'self' },
    });

    // Encerrar a sessão Adonis do console (logout global do self-service).
    ctx.session.forget(ACCOUNT_SESSION_KEY);
    await ctx.session.regenerate();
    await syncAdonisAuthLogout(ctx, cfg);

    return { ok: true, signedOut: true, ...result };
  }

  // ─── GET /account/api/apps ──────────────────────────────────────────────

  /** Apps com acesso (grants) do usuário logado. */
  async listApps(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const adminSessions = new AdminSessionsService(service);
    const supported = adminSessions.canList;

    if (!supported) {
      return { supported: false, apps: [] };
    }

    const grants = await adminSessions.listGrants(userId);

    return {
      supported: true,
      apps: grants
        .filter((g) => !!g.clientId)
        .map((g) => ({
          clientId: g.clientId as string,
          accessTokens: g.accessTokens,
          refreshTokens: g.refreshTokens,
        })),
    };
  }

  // ─── DELETE /account/api/apps/:clientId ─────────────────────────────────

  /** Revogar consentimento de um app (clientId). */
  async revokeApp(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const clientId = ctx.request.param('clientId') as string;

    const adminSessions = new AdminSessionsService(service);
    if (!adminSessions.canList) {
      return ctx.response
        .status(422)
        .send(
          apiErr('capability_unsupported', 'Session enumeration not supported by this adapter.'),
        );
    }

    const result = await adminSessions.revokeClientGrants(userId, clientId);

    await cfg.audit?.record({
      type: 'grant.revoked_by_user',
      accountId: userId,
      clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { ...result },
    });

    return { ok: true, ...result };
  }

  // ─── GET /account/api/mfa ────────────────────────────────────────────────

  /** Status completo do MFA: TOTP + passkeys + recovery. */
  async mfaStatus(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const mfaState = await cfg.accountStore.getMfaState?.(userId);
    const enabled = mfaState?.enabled ?? false;

    const passkeysSupported = supportsPasskeys(cfg.accountStore);
    let passkeys: PasskeySummary[] = [];
    if (passkeysSupported) {
      try {
        passkeys = await cfg.accountStore.listPasskeys(userId);
      } catch {
        /* fail-safe */
      }
    }

    return {
      enabled,
      totp: { enrolled: enabled },
      passkeys: {
        supported: passkeysSupported,
        count: passkeys.length,
        items: passkeys.map((p: PasskeySummary) => ({
          id: p.id,
          label: p.label ?? null,
          createdAt: p.createdAt ?? null,
        })),
      },
      // Recovery codes are shown once via the existing POST /account/mfa/confirm flow.
      recovery: { available: enabled },
    };
  }

  // ─── GET /account/api/login-methods ─────────────────────────────────────

  /**
   * Preferência POR USUÁRIO de tipos de login + o catálogo do que está
   * disponível/travado. A interseção com os métodos globais efetivos é feita
   * AQUI (a UI mostra o estado final; o enforcement no login reusa o resolver).
   */
  async getLoginMethods(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const supported = supportsLoginMethodsPreference(cfg.accountStore);
    if (!supported) {
      return { supported: false as const, methods: null, available: null, locked: null };
    }

    const pref = await cfg.accountStore.getLoginMethods(userId);
    const { resolved: global, locked: cfgLocked } = await this.#resolveGlobalAuthMethods(ctx, cfg);
    const effective = resolveEffectiveUserLoginMethods(global, pref);

    return {
      supported: true as const,
      // Preferência crua do usuário (o que ELE escolheu; null = sem preferência).
      methods: pref ?? {},
      // Estado final por método (global ∩ preferência) — o que a tela de login mostra.
      available: {
        password: effective.password,
        magicLink: effective.magicLink,
        passkey: effective.passkey,
        social: effective.social,
        forgotPassword: effective.forgotPassword,
      },
      // Métodos que o usuário NÃO pode controlar (globalmente off ou pin de config).
      // Pin de config: `cfgLocked` lista as chaves fixadas no arquivo de config.
      locked: {
        password: !global.password || cfgLocked.includes('password'),
        magicLink: !global.magicLink || cfgLocked.includes('magicLink'),
        passkey: !global.passkey || cfgLocked.includes('passkey'),
        social: global.social.length === 0,
      },
    };
  }

  // ─── PUT /account/api/login-methods ─────────────────────────────────────

  /** Grava a preferência de tipos de login do usuário logado. */
  async updateLoginMethods(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsLoginMethodsPreference(cfg.accountStore)) {
      return ctx.response.notFound(
        apiErr('not_supported', 'Login methods preference not supported.'),
      );
    }

    const parsed = parseUserLoginMethodsPayload(ctx.request.body());
    if (!parsed.ok) {
      return ctx.response.badRequest(apiErr(parsed.error, 'Invalid login methods payload.'));
    }

    // All-off guard server-side: a preferência não pode zerar todos os métodos
    // GLOBAIS disponíveis. Um `false` que deixaria zero métodos é recusado.
    const { resolved: global } = await this.#resolveGlobalAuthMethods(ctx, cfg);
    const value = { ...parsed.value };
    const wouldBeAllOff =
      (value.password === false || !global.password) &&
      (value.magicLink === false || !global.magicLink) &&
      (value.passkey === false || !global.passkey) &&
      (value.social === false || global.social.length === 0);
    if (wouldBeAllOff) {
      return ctx.response.badRequest(
        apiErr('all_methods_off', 'Cannot disable every login method.'),
      );
    }

    await cfg.accountStore.setLoginMethods(userId, Object.keys(value).length > 0 ? value : null);
    return { ok: true, methods: value };
  }

  /**
   * Métodos globais efetivos + pins de config, compartilhados pelos handlers
   * acima. Fail-safe: erro → defaults conservadores.
   */
  async #resolveGlobalAuthMethods(ctx: HttpContext, cfg: any) {
    const settings = await resolveRuntimeSettingsOrNoop(ctx);
    const resolved = await resolveEffectiveAuthMethods(settings, {
      configuredSocialProviders: cfg.social?.providers ?? [],
      magicLinkCapable: cfg.passwordless?.magicLink && supportsMagicLink(cfg.accountStore),
      passkeyCapable: supportsPasskeys(cfg.accountStore),
      configOverrides: cfg.authMethods,
    });
    return { resolved, locked: configLockedAuthMethods(cfg.authMethods) };
  }

  // ─── GET /account/api/passkeys ──────────────────────────────────────────

  /** Lista passkeys do usuário logado. */
  async listPasskeys(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsPasskeys(cfg.accountStore)) {
      return { supported: false, passkeys: [] };
    }

    const passkeys = await cfg.accountStore.listPasskeys(userId);

    return {
      supported: true,
      passkeys: passkeys.map((p: PasskeySummary) => ({
        id: p.id,
        label: p.label ?? null,
        createdAt: p.createdAt ?? null,
      })),
    };
  }

  // ─── DELETE /account/api/passkeys/:id ───────────────────────────────────

  /** Remover uma passkey. Exige sudo. */
  async removePasskey(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsPasskeys(cfg.accountStore)) {
      return ctx.response
        .status(422)
        .send(
          apiErr('capability_unsupported', translate(cfg.messages, 'errors.passkeys_unavailable')),
        );
    }

    const sudoSettings = await resolveRuntimeSettings(ctx);
    const sudoResult = await requireSudo(ctx, sudoSettings);
    if (sudoResult !== true) {
      return ctx.response
        .status(403)
        .send(apiErr('sudo_required', 'Identity confirmation required.'));
    }

    const credentialId = ctx.request.param('id') as string;
    await cfg.accountStore.removePasskey?.(userId, credentialId);

    await cfg.audit?.record({
      type: 'passkey.removed',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { credentialId },
    });

    const account = await cfg.accountStore.findById(userId);
    if (account) {
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: userId, email: account.email },
          kind: 'passkey_removed',
          ip: ctx.request.ip?.() ?? null,
          timestamp: new Date().toISOString(),
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }

    return { ok: true, removed: credentialId };
  }

  // ─── GET /account/api/tokens ─────────────────────────────────────────────

  /** Lista PATs (Personal Access Tokens) do usuário logado. */
  async listTokens(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    if (!cfg.patStore) {
      return { supported: false, tokens: [] };
    }

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const tokens = await cfg.patStore.listForAccount(userId);

    return {
      supported: true,
      tokens: tokens.map((t: PatRecord) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        audience: t.audience,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
      })),
    };
  }

  // ─── POST /account/api/tokens ────────────────────────────────────────────

  /** Criar um PAT. Exige sudo. O secret é retornado UMA vez. */
  async createToken(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    if (!cfg.patStore) {
      return ctx.response
        .status(422)
        .send(apiErr('capability_unsupported', 'PAT store not configured.'));
    }

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const sudoSettings = await resolveRuntimeSettings(ctx);
    const sudoResult = await requireSudo(ctx, sudoSettings);
    if (sudoResult !== true) {
      return ctx.response
        .status(403)
        .send(apiErr('sudo_required', 'Identity confirmation required.'));
    }

    const name = (ctx.request.input('name', 'Token') as string).trim() || 'Token';
    const { token, pat } = await cfg.patStore.issue({ accountId: userId, name });

    await cfg.audit?.record({
      type: 'pat.issued',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { patId: pat.id, name: pat.name },
    });

    ctx.response.status(201);
    return {
      id: pat.id,
      name: pat.name,
      scopes: pat.scopes,
      audience: pat.audience,
      createdAt: pat.createdAt,
      // Secret shown ONCE.
      secret: token,
    };
  }

  // ─── DELETE /account/api/tokens/:id ─────────────────────────────────────

  /** Revogar um PAT. Exige sudo. */
  async revokeToken(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    if (!cfg.patStore) {
      return ctx.response
        .status(422)
        .send(apiErr('capability_unsupported', 'PAT store not configured.'));
    }

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const sudoSettings = await resolveRuntimeSettings(ctx);
    const sudoResult = await requireSudo(ctx, sudoSettings);
    if (sudoResult !== true) {
      return ctx.response
        .status(403)
        .send(apiErr('sudo_required', 'Identity confirmation required.'));
    }

    const patId = ctx.request.param('id') as string;
    const revoked = await cfg.patStore.revoke(userId, patId);

    if (!revoked) {
      return ctx.response.notFound(apiErr('not_found', 'Token not found.'));
    }

    await cfg.audit?.record({
      type: 'pat.revoked',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { patId },
    });

    return { ok: true, revoked: patId };
  }

  // ─── GET /account/api/orgs ───────────────────────────────────────────────

  /** Lista orgs do usuário logado. Alias consolidado dos /account/orgs/json existentes. */
  async listOrgs(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsOrganizations(store)) {
      return { supported: false, orgs: [], activeOrgId: null };
    }

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const orgs = await store.listOrgsForAccount(userId);
    const activeOrgRaw = ctx.request.cookie(ACTIVE_ORG_COOKIE);
    const activeOrgId = activeOrgRaw ? activeOrgRaw.split('\t')[0] : null;

    return {
      supported: true,
      activeOrgId,
      orgs: orgs.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        logoUrl: org.logoUrl ?? null,
        role: org.role,
        isActive: org.id === activeOrgId,
      })),
    };
  }

  // ─── GET /account/api/orgs/:id ──────────────────────────────────────────

  /** Detalhe de uma org (requer membership). */
  async showOrg(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsOrganizations(store)) {
      return ctx.response.notFound(apiErr('not_supported', 'Organizations not supported.'));
    }

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const orgId = ctx.request.param('id') as string;

    const membership = await store.getOrgMembership!(orgId, userId);
    if (!membership) {
      return ctx.response.notFound(apiErr('not_found', 'Organization not found or not a member.'));
    }

    const org = await store.findOrgById!(orgId);
    if (!org) {
      return ctx.response.notFound(apiErr('not_found', 'Organization not found.'));
    }

    const canManage = membership.role === 'owner' || membership.role === 'admin';
    const members = canManage ? await store.listOrgMembers!(orgId) : [];
    const enrichedMembers = await Promise.all(
      members.map(async (m) => {
        const account = await store.findById(m.accountId);
        return {
          accountId: m.accountId,
          email: account?.email ?? null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    );

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoUrl ?? null,
      role: membership.role,
      canManage,
      members: enrichedMembers,
    };
  }

  // ─── GET /account/api/orgs/invitations ─────────────────────────────────

  /** Convites pendentes para o e-mail do usuário logado. */
  async listOrgInvitations(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsOrganizations(store)) {
      return { supported: false, invitations: [] };
    }

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const account = await store.findById(userId);
    if (!account) {
      return ctx.response.unauthorized(apiErr('unauthorized', 'Not authenticated.'));
    }

    const invitations = await store.listPendingInvitationsForEmail!(account.email);
    const enriched = await Promise.all(
      invitations.map(async (inv) => {
        const org = await store.findOrgById!(inv.organizationId);
        return {
          id: inv.id,
          organizationId: inv.organizationId,
          orgName: org?.name ?? inv.organizationId,
          orgSlug: org?.slug ?? inv.organizationId,
          email: inv.email,
          role: inv.role,
          expiresAt: inv.expiresAt,
          createdAt: inv.createdAt,
        };
      }),
    );

    return { supported: true, invitations: enriched };
  }
}
