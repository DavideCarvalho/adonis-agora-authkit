import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import QRCode from 'qrcode';
import { supportsPasskeys } from '../../accounts/account_store.js';
import { accountPath } from '../account_paths.js';
import type { AccountMfaProps } from '../account_screen_props.js';
import { translate } from '../i18n.js';
import { ACCOUNT_SESSION_KEY } from '../middleware/account_auth.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { dispatchSecurityNotice } from '../security_notice_service.js';
import { requireSudo } from '../sudo_mode.js';

/** Desafio WebAuthn pendente (registro) guardado na sessão entre begin/finish. */
const PASSKEY_REG_CHALLENGE_KEY = 'authkit_passkey_reg_challenge';

/**
 * `true` quando a requisição é uma NAVEGAÇÃO (form/browser) e não um XHR/fetch:
 * o cliente aceita `text/html` e NÃO pede explicitamente `application/json`.
 *
 * Endpoints duais (JSON para o app React / redirect para o `<form>` clássico)
 * decidem a resposta por aqui. Um `fetch` sem `Accept` explícito manda coringa
 * (`*` + `/` + `*`) → não é navegação → JSON (mantém o comportamento de sempre
 * da `mfa.edge`).
 */
function isNavigationRequest(ctx: HttpContext): boolean {
  const accept = (ctx.request.header('accept') ?? '').toLowerCase();
  const wantsJson = accept.includes('application/json');
  const wantsHtml = accept.includes('text/html');
  return wantsHtml && !wantsJson;
}

/**
 * Console de MFA da conta (atrás do account_auth middleware). Enrollment TOTP
 * com QR, confirmação com código, exibição única dos recovery codes e disable.
 */
export default class AccountMfaController {
  /** GET /account/mfa — estado atual; oferece enroll se desligado. */
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const state = (await cfg.accountStore.getMfaState?.(userId)) ?? { enabled: false };
    const recoveryCodes = ctx.session.flashMessages.get('recoveryCodes') as string[] | undefined;

    // Passkeys disponíveis quando o store as suporta (model de credenciais wired).
    const passkeysSupported = supportsPasskeys(cfg.accountStore);
    const passkeys = passkeysSupported ? await cfg.accountStore.listPasskeys(userId) : [];

    const props = {
      csrfToken: ctx.request.csrfToken,
      enabled: state.enabled,
      recoveryCodes: recoveryCodes ?? null,
      passkeysSupported,
      passkeys,
    } satisfies Omit<AccountMfaProps, 'messages'>;

    return render(ctx, 'account/mfa', props);
  }

  /**
   * POST /account/mfa/passkeys/options — gera as opções de registro de passkey
   * (JSON), guarda o challenge na sessão e devolve as opções para o browser.
   */
  async passkeyRegisterOptions(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const generated = await cfg.accountStore.generatePasskeyRegistrationOptions?.(userId);
    if (!generated) {
      return ctx.response.notFound({
        message: translate(cfg.messages, 'errors.passkeys_unavailable'),
      });
    }
    ctx.session.put(PASSKEY_REG_CHALLENGE_KEY, generated.challenge);
    return generated.options;
  }

  /**
   * POST /account/mfa/passkeys/verify — verifica a resposta de registro do browser
   * contra o challenge guardado; em caso de sucesso persiste a credencial e habilita MFA.
   */
  async passkeyRegisterVerify(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    // Sudo mode gate.
    const sudoSettingsPkAdd = await resolveRuntimeSettings(ctx);
    const sudoResultPkAdd = await requireSudo(ctx, sudoSettingsPkAdd);
    if (sudoResultPkAdd !== true) return sudoResultPkAdd;

    const challenge = ctx.session.get(PASSKEY_REG_CHALLENGE_KEY) as string | undefined;
    if (!challenge) {
      return ctx.response.badRequest({
        message: translate(cfg.messages, 'errors.challenge_expired'),
      });
    }
    const body = ctx.request.input('response', ctx.request.body());
    const ok =
      (await cfg.accountStore.verifyPasskeyRegistration?.(userId, body, challenge)) ?? false;
    ctx.session.forget(PASSKEY_REG_CHALLENGE_KEY);
    if (!ok) {
      return ctx.response.badRequest({ message: translate(cfg.messages, 'errors.invalid_code') });
    }
    await cfg.audit?.record({
      type: 'mfa.enabled',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { method: 'webauthn' },
    });
    await cfg.audit?.record({
      type: 'passkey.registered',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });
    // Notificações de segurança: passkey_added + mfa_enabled (best-effort).
    const accountForNotice = await cfg.accountStore.findById(userId);
    if (accountForNotice) {
      const ts = new Date().toISOString();
      const ip = ctx.request.ip?.() ?? null;
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: userId, email: accountForNotice.email },
          kind: 'passkey_added',
          ip,
          timestamp: ts,
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: userId, email: accountForNotice.email },
          kind: 'mfa_enabled',
          ip,
          timestamp: ts,
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }
    // Resposta DUAL. A cerimônia WebAuthn da tela built-in (`mfa.edge`) chama
    // este endpoint por `fetch` e só olha `res.ok` — mas um `<form>` HTML
    // clássico (progressive enhancement, ou host que POSTa a assertion sem JS)
    // fica encarando o JSON `{ok:true}` cru. Navegação (o cliente ACEITA HTML e
    // NÃO pede JSON) → redirect para a tela de MFA (respeitando `accountRoutes`);
    // XHR/fetch → JSON de sempre. O fetch da view manda Accept coringa, então
    // cai no ramo JSON e continua funcionando.
    if (isNavigationRequest(ctx)) {
      return ctx.response.redirect(accountPath('mfa'));
    }
    return { ok: true };
  }

  /** POST /account/mfa/passkeys/:id/remove — remove uma passkey da conta. */
  async passkeyRemove(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    // Sudo mode gate.
    const sudoSettingsPkRm = await resolveRuntimeSettings(ctx);
    const sudoResultPkRm = await requireSudo(ctx, sudoSettingsPkRm);
    if (sudoResultPkRm !== true) return sudoResultPkRm;

    const credentialId = ctx.request.param('id');
    await cfg.accountStore.removePasskey?.(userId, credentialId);
    await cfg.audit?.record({
      type: 'passkey.removed',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { credentialId },
    });
    // Notificação de segurança: passkey_removed (best-effort).
    const accountForNotice = await cfg.accountStore.findById(userId);
    if (accountForNotice) {
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: userId, email: accountForNotice.email },
          kind: 'passkey_removed',
          ip: ctx.request.ip?.() ?? null,
          timestamp: new Date().toISOString(),
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }
    return ctx.response.redirect(accountPath('mfa'));
  }

  /** POST /account/mfa/enroll — gera segredo pendente + QR e mostra a confirmação. */
  async enroll(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    // Sudo mode gate.
    const sudoSettingsEnroll = await resolveRuntimeSettings(ctx);
    const sudoResultEnroll = await requireSudo(ctx, sudoSettingsEnroll);
    if (sudoResultEnroll !== true) return sudoResultEnroll;

    const started = await cfg.accountStore.startTotpEnrollment?.(userId);
    if (!started) {
      return ctx.response.redirect(accountPath('mfa'));
    }

    // QR renderizado server-side como data-URL e passado como prop.
    const qrDataUrl = await QRCode.toDataURL(started.otpauthUri);

    const props = {
      csrfToken: ctx.request.csrfToken,
      enabled: false,
      enrolling: true,
      secret: started.secret,
      qrDataUrl,
      recoveryCodes: null,
    } satisfies Omit<AccountMfaProps, 'messages'>;

    return render(ctx, 'account/mfa', props);
  }

  /** POST /account/mfa/confirm — confirma o código; sucesso = ativa e mostra recovery codes. */
  async confirm(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const { code } = ctx.request.only(['code']);
    const result = (await cfg.accountStore.confirmTotpEnrollment?.(userId, code)) ?? { ok: false };

    if (!result.ok) {
      // Reenvia o passo de confirmação com erro SEM regenerar o segredo pendente
      // (o usuário já escaneou o QR; um novo segredo invalidaria o app autenticador).
      // Mostra só o campo de código para nova tentativa.
      const props = {
        csrfToken: ctx.request.csrfToken,
        enabled: false,
        enrolling: true,
        secret: null,
        qrDataUrl: null,
        error: translate(cfg.messages, 'errors.invalid_code'),
        recoveryCodes: null,
      } satisfies Omit<AccountMfaProps, 'messages'>;

      return render(ctx, 'account/mfa', props);
    }

    await cfg.audit?.record({
      type: 'mfa.enabled',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });
    // Notificação de segurança: mfa_enabled (best-effort).
    const accountForMfaNotice = await cfg.accountStore.findById(userId);
    if (accountForMfaNotice) {
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: userId, email: accountForMfaNotice.email },
          kind: 'mfa_enabled',
          ip: ctx.request.ip?.() ?? null,
          timestamp: new Date().toISOString(),
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }
    // Mostra os recovery codes UMA vez (flash) e volta pro estado "ativado".
    ctx.session.flash('recoveryCodes', result.recoveryCodes ?? []);
    return ctx.response.redirect(accountPath('mfa'));
  }

  /** POST /account/mfa/disable — desliga o MFA. */
  async disable(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    // Sudo mode gate.
    const sudoSettingsDisable = await resolveRuntimeSettings(ctx);
    const sudoResultDisable = await requireSudo(ctx, sudoSettingsDisable);
    if (sudoResultDisable !== true) return sudoResultDisable;

    await cfg.accountStore.disableMfa?.(userId);
    await cfg.audit?.record({
      type: 'mfa.disabled',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
    });
    // Notificação de segurança: mfa_disabled (best-effort).
    const accountForDisableNotice = await cfg.accountStore.findById(userId);
    if (accountForDisableNotice) {
      await dispatchSecurityNotice(
        ctx,
        {
          account: { id: userId, email: accountForDisableNotice.email },
          kind: 'mfa_disabled',
          ip: ctx.request.ip?.() ?? null,
          timestamp: new Date().toISOString(),
        },
        cfg.mail,
        cfg.audit,
        cfg,
      );
    }
    return ctx.response.redirect(accountPath('mfa'));
  }
}
