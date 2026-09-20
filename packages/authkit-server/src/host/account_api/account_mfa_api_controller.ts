/**
 * Account Self-Service JSON API — SEGUNDO FATOR (TOTP + passkeys)
 *
 * Espelho JSON do `AccountMfaController`, para o host que desenha a própria
 * tela de "segundo fator" e não pode navegar o browser no meio do fluxo.
 *
 * Mapa de rotas (sob o `accountGuard`; mutantes sob o CSRF do shield do host):
 *   POST /account/api/mfa/totp/enroll       → inicia o enrolamento (sudo)
 *   POST /account/api/mfa/totp/confirm      → confirma com o código (throttled)
 *   POST /account/api/mfa/totp/disable      → desliga o MFA (sudo)
 *   POST /account/api/mfa/recovery-codes    → regenera os códigos (sudo)
 *   POST /account/api/mfa/passkeys/options  → options da cerimônia de registro
 *   POST /account/api/mfa/passkeys/verify   → verifica o attestation (sudo)
 *
 * Paridade de gates com o console HTML, endpoint a endpoint:
 *
 *   | ação             | console HTML | aqui             |
 *   | ---------------- | ------------ | ---------------- |
 *   | enroll           | sudo         | sudo → 403 JSON  |
 *   | confirm          | sem sudo     | sem sudo         |
 *   | disable          | sudo         | sudo → 403 JSON  |
 *   | passkey options  | sem sudo     | sem sudo         |
 *   | passkey verify   | sudo         | sudo → 403 JSON  |
 *   | recovery codes   | (não existe) | sudo → 403 JSON  |
 *
 * A única diferença é a FORMA da recusa: `requireSudo` devolve um redirect para
 * `/account/confirm`, que numa SPA chega como uma página HTML onde ela esperava
 * JSON. Aqui a recusa vira `403 { error: { code: 'sudo_required' } }` e a tela
 * do host manda o usuário confirmar identidade por conta própria. Mesma
 * política, resposta legível por máquina.
 *
 * `confirm` NÃO exige sudo — porque o `enroll` que criou o segredo pendente já
 * exigiu, e pedir de novo no passo seguinte quebraria o enrolamento de quem
 * demorou a digitar o código. É exatamente o que o console faz. O que o console
 * não tem, e aqui existe, é o THROTTLE: o código de 6 dígitos é adivinhável, e
 * a rota carrega o bucket de sudo (por IP) — mais apertado que o form, nunca
 * mais frouxo.
 *
 * Os dois caminhos (clássico e JSON) COMPARTILHAM o slot do desafio WebAuthn
 * (`PASSKEY_REG_CHALLENGE_KEY`), então um `options` pedido num deles pode ser
 * finalizado pelo outro e nunca existem dois desafios vivos na mesma sessão.
 */

import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import QRCode from 'qrcode';
import {
  supportsMfa,
  supportsPasskeys,
  supportsRecoveryCodeRegeneration,
} from '../../accounts/account_store.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { translate } from '../i18n.js';
import { PASSKEY_REG_CHALLENGE_KEY } from '../passkey_registration_challenge.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { dispatchSecurityNotice } from '../security_notice_service.js';
import { requireSudo } from '../sudo_mode.js';

/** Erro JSON padrão — mesmo envelope do `account_api_controller`. */
function apiErr(code: string, message: string) {
  return { error: { code, message } };
}

export default class AccountMfaApiController {
  // ─── POST /account/api/mfa/totp/enroll ──────────────────────────────────

  /**
   * Inicia o enrolamento TOTP: segredo pendente + `otpauth://` URI + o QR já
   * renderizado como data-URL (o console renderiza server-side; aqui a tela do
   * host recebe pronto e decide se mostra o QR, o segredo, ou os dois).
   */
  async enrollTotp(ctx: HttpContext) {
    const c = await this.#mfaContext(ctx);
    if (!c) return;
    if (!(await this.#requireSudoJson(ctx))) return;

    const started = await c.store.startTotpEnrollment(c.userId);
    if (!started) {
      return ctx.response
        .status(422)
        .send(apiErr('enroll_failed', 'Could not start TOTP enrollment.'));
    }

    const qrDataUrl = await QRCode.toDataURL(started.otpauthUri);
    return { secret: started.secret, otpauthUri: started.otpauthUri, qrDataUrl };
  }

  // ─── POST /account/api/mfa/totp/confirm ─────────────────────────────────

  /**
   * Confirma o enrolamento com o código do app autenticador. Sucesso ativa o
   * MFA e devolve os recovery codes — UMA vez, como no console (lá eles vão num
   * flash; aqui, no corpo da resposta, que é o equivalente headless).
   */
  async confirmTotp(ctx: HttpContext) {
    const c = await this.#mfaContext(ctx);
    if (!c) return;

    const code = String(ctx.request.input('code', '') ?? '').trim();
    const result = await c.store.confirmTotpEnrollment(c.userId, code);
    if (!result.ok) {
      // NÃO regenera o segredo pendente: o usuário já escaneou o QR, e um
      // segredo novo invalidaria o app autenticador dele. Mesma decisão do
      // console — a tela pede outro código sobre o MESMO segredo.
      return ctx.response
        .status(422)
        .send(apiErr('invalid_code', translate(c.cfg.messages, 'errors.invalid_code')));
    }

    await c.cfg.audit?.record({
      type: 'mfa.enabled',
      accountId: c.userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { method: 'totp' },
    });
    await this.#notice(ctx, c, 'mfa_enabled');

    return { ok: true, enabled: true, recoveryCodes: result.recoveryCodes ?? [] };
  }

  // ─── POST /account/api/mfa/totp/disable ─────────────────────────────────

  /** Desliga o MFA (TOTP + recovery codes). Exige sudo, como o console. */
  async disableTotp(ctx: HttpContext) {
    const c = await this.#mfaContext(ctx);
    if (!c) return;
    if (!(await this.#requireSudoJson(ctx))) return;

    await c.store.disableMfa(c.userId);
    await c.cfg.audit?.record({
      type: 'mfa.disabled',
      accountId: c.userId,
      ip: ctx.request.ip?.() ?? null,
    });
    await this.#notice(ctx, c, 'mfa_disabled');

    return { ok: true, enabled: false };
  }

  // ─── POST /account/api/mfa/recovery-codes ───────────────────────────────

  /**
   * Regenera os recovery codes de uma conta com MFA ATIVO e devolve os novos —
   * uma única vez. Exige sudo: o resultado é um conjunto de credenciais que
   * contorna o segundo fator, então vale o mesmo gate do `enroll`/`disable`.
   *
   * Capability-probed: stores que não implementam
   * `regenerateRecoveryCodes` respondem 422 em vez de 500.
   */
  async regenerateRecoveryCodes(ctx: HttpContext) {
    const c = await this.#mfaContext(ctx);
    if (!c) return;

    if (!supportsRecoveryCodeRegeneration(c.store)) {
      return ctx.response
        .status(422)
        .send(apiErr('capability_unsupported', 'Recovery code regeneration not supported.'));
    }
    if (!(await this.#requireSudoJson(ctx))) return;

    const codes = await c.store.regenerateRecoveryCodes(c.userId);
    if (!codes) {
      // Sem MFA ativo não há conjunto a regenerar — enrolar é o caminho.
      return ctx.response.status(422).send(apiErr('mfa_not_enabled', 'MFA is not enabled.'));
    }

    await c.cfg.audit?.record({
      type: 'mfa.recovery_codes_regenerated',
      accountId: c.userId,
      ip: ctx.request.ip?.() ?? null,
    });

    return { ok: true, recoveryCodes: codes };
  }

  // ─── POST /account/api/mfa/passkeys/options ─────────────────────────────

  /**
   * Options da cerimônia de REGISTRO de passkey, guardando o desafio na sessão.
   * Sem sudo, igual ao endpoint clássico: quem paga o gate é o `verify`, que é
   * onde a credencial passa a existir.
   */
  async passkeyRegisterOptions(ctx: HttpContext) {
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

    const generated = await cfg.accountStore.generatePasskeyRegistrationOptions?.(userId);
    if (!generated) {
      return ctx.response
        .status(422)
        .send(
          apiErr('capability_unsupported', translate(cfg.messages, 'errors.passkeys_unavailable')),
        );
    }

    ctx.session.put(PASSKEY_REG_CHALLENGE_KEY, generated.challenge);
    return generated.options;
  }

  // ─── POST /account/api/mfa/passkeys/verify ──────────────────────────────

  /**
   * Verifica o attestation contra o desafio da sessão e persiste a credencial.
   *
   * O endpoint clássico responde 302 numa navegação e `{ok:true}` num fetch;
   * este responde SEMPRE JSON — inclusive na recusa de sudo, que lá é um
   * redirect. É a diferença que faz a cerimônia caber numa SPA: o browser não
   * pode navegar entre `startRegistration()` e a verificação.
   */
  async passkeyRegisterVerify(ctx: HttpContext) {
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
    if (!(await this.#requireSudoJson(ctx))) return;

    const challenge = ctx.session.get(PASSKEY_REG_CHALLENGE_KEY) as string | undefined;
    if (!challenge) {
      return ctx.response
        .status(400)
        .send(apiErr('challenge_expired', translate(cfg.messages, 'errors.challenge_expired')));
    }

    const body = ctx.request.input('response', ctx.request.body());
    const ok = (await cfg.accountStore.verifyPasskeyRegistration?.(userId, body, challenge)) ?? false;
    // Queima o desafio em QUALQUER desfecho: um attestation recusado não pode
    // ser retentado contra o mesmo challenge.
    ctx.session.forget(PASSKEY_REG_CHALLENGE_KEY);
    if (!ok) {
      return ctx.response
        .status(400)
        .send(apiErr('invalid_response', translate(cfg.messages, 'errors.invalid_code')));
    }

    const ip = ctx.request.ip?.() ?? null;
    await cfg.audit?.record({
      type: 'mfa.enabled',
      accountId: userId,
      ip,
      metadata: { method: 'webauthn' },
    });
    await cfg.audit?.record({ type: 'passkey.registered', accountId: userId, ip });

    const account = await cfg.accountStore.findById(userId);
    if (account) {
      const ts = new Date().toISOString();
      for (const kind of ['passkey_added', 'mfa_enabled'] as const) {
        await dispatchSecurityNotice(
          ctx,
          { account: { id: userId, email: account.email }, kind, ip, timestamp: ts },
          cfg.mail,
          cfg.audit,
          cfg,
        );
      }
    }

    return { ok: true };
  }

  // ─── Internos ───────────────────────────────────────────────────────────

  /**
   * Resolve config + store com MFA + a conta da sessão. Quando o pré-requisito
   * falha, JÁ RESPONDE e devolve `null`.
   */
  async #mfaContext(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsMfa(store)) {
      ctx.response
        .status(422)
        .send(apiErr('capability_unsupported', 'MFA not supported by the account store.'));
      return null;
    }
    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
    if (!userId) {
      ctx.response.unauthorized(apiErr('unauthorized', 'Not authenticated.'));
      return null;
    }
    return { cfg, store, userId };
  }

  /**
   * Gate de sudo em versão JSON: a MESMA `requireSudo` do console (mesma
   * setting, mesma janela de graça, mesmo fail-closed), só que a recusa vira
   * 403 em vez do redirect para `/account/confirm`. Devolve `false` quando já
   * respondeu.
   */
  async #requireSudoJson(ctx: HttpContext): Promise<boolean> {
    const settings = await resolveRuntimeSettings(ctx);
    const result = await requireSudo(ctx, settings);
    if (result !== true) {
      ctx.response.status(403).send(apiErr('sudo_required', 'Identity confirmation required.'));
      return false;
    }
    return true;
  }

  /** Notificação de segurança best-effort (nunca derruba a operação). */
  async #notice(ctx: HttpContext, c: { cfg: any; userId: string }, kind: string) {
    const account = await c.cfg.accountStore.findById(c.userId);
    if (!account) return;
    await dispatchSecurityNotice(
      ctx,
      {
        account: { id: c.userId, email: account.email },
        kind: kind as any,
        ip: ctx.request.ip?.() ?? null,
        timestamp: new Date().toISOString(),
      },
      c.cfg.mail,
      c.cfg.audit,
      c.cfg,
    );
  }
}
