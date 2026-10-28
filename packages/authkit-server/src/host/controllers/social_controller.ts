import '../augmentations.js';
import { randomUUID } from 'node:crypto';
import type { AllyDriverContract } from '@adonisjs/ally/types';
import type { HttpContext } from '@adonisjs/core/http';
import {
  supportsLoginMethodsPreference,
  supportsMagicLink,
  supportsPasskeys,
  supportsProviderIdentity,
} from '../../accounts/account_store.js';
import type { SocialSecondFactorPolicy } from '../../define_config.js';
import { normalizeEmailIdentifier } from '../email_identifier.js';
import { assertLoginAllowed } from '../login_attempt.js';
import { type RuntimeSettings, resolveRuntimeSettingsOrNoop } from '../runtime_settings.js';
import { resolveEffectiveAuthMethods } from '../runtime_toggles.js';
import { SOCIAL_PENDING_KEY, type SocialPendingLogin } from '../social_pending.js';
import {
  type ResolvedAuthMethodsLike,
  resolveEffectiveUserLoginMethods,
} from '../user_login_methods.js';

const UID_SESSION_KEY = 'authkit_social_uid';

/**
 * `AllyService.use()` é tipado contra a interface `SocialProviders`, que só é
 * preenchida pelo HOST (a lib não conhece os providers configurados). Para um
 * nome de provider dinâmico (vindo da rota), o retorno colapsa em `never`, então
 * resolvemos via o contrato genérico do driver — sem cast pro `HttpContext` inteiro.
 */
function useProvider(ctx: HttpContext, provider: string): AllyDriverContract<any, any> {
  return (ctx.ally.use as (name: string) => AllyDriverContract<any, any>)(provider);
}

/**
 * Métodos globais efetivos para o gate por usuário do callback social.
 * Espelha o `#loginMethods` do interaction controller (mesma fonte de
 * capabilities), sem acoplar os dois controllers.
 */
async function resolveGlobalAuthMethodsForUser(
  cfg: any,
  settings: RuntimeSettings,
): Promise<ResolvedAuthMethodsLike> {
  return await resolveEffectiveAuthMethods(settings, {
    configuredSocialProviders: cfg.social?.providers ?? [],
    magicLinkCapable: cfg.passwordless?.magicLink && supportsMagicLink(cfg.accountStore),
    passkeyCapable: supportsPasskeys(cfg.accountStore),
    configOverrides: cfg.authMethods,
  });
}

/**
 * Política de 2º fator do login social para esta conta (ver
 * `AuthSocialConfig.secondFactor`). Default `'enrolled'`.
 */
async function resolveSecondFactorPolicy(
  cfg: any,
  account: { id: string; email: string; globalRoles?: string[] },
): Promise<SocialSecondFactorPolicy> {
  const policy = cfg.social?.secondFactor ?? 'enrolled';
  return typeof policy === 'function' ? await policy(account) : policy;
}

/** true se a conta tem TOTP confirmado ou ao menos uma passkey. */
async function hasEnrolledSecondFactor(store: any, accountId: string): Promise<boolean> {
  const mfa = (await store.getMfaState?.(accountId)) ?? { enabled: false };
  if (mfa.totp ?? mfa.enabled) return true;
  if (!supportsPasskeys(store)) return false;
  const list = await store.listPasskeys(accountId);
  return Array.isArray(list) && list.length > 0;
}

export default class AuthSocialController {
  /** GET /auth/:provider/redirect/:uid — guarda o uid e redireciona para o provider OAuth. */
  async redirect(ctx: HttpContext) {
    const provider = ctx.request.param('provider');
    ctx.session.put(UID_SESSION_KEY, ctx.request.param('uid'));
    return useProvider(ctx, provider).redirect();
  }

  /** GET /auth/:provider/callback — retorno do provider → acha/cria AuthUser → conclui a interaction. */
  async callback(ctx: HttpContext) {
    const provider = ctx.request.param('provider');
    const social = useProvider(ctx, provider);
    const uid = ctx.session.get(UID_SESSION_KEY) as string | undefined;
    const backToLogin = uid ? `/auth/interaction/${uid}` : '/health';

    if (social.accessDenied() || social.stateMisMatch() || social.hasError()) {
      ctx.session.forget(UID_SESSION_KEY);
      return ctx.response.redirect(backToLogin);
    }

    const profile = await social.user();
    // `profile.id` é o id estável do usuário no provider — independe do e-mail.
    if (!profile.id) {
      ctx.session.forget(UID_SESSION_KEY);
      return ctx.response.redirect(backToLogin);
    }

    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    // Normaliza o e-mail do provider com a MESMA regra do cadastro/login: sem
    // isto, um provider que devolve o endereço com maiúsculas criava uma conta
    // que o login (normalizado) não encontrava mais.
    const email = profile.email ? normalizeEmailIdentifier(profile.email) : undefined;

    // Account linking exige a capacidade de provider-identity (model wired no store).
    // Ausente → não há como ligar a identidade; volta ao login em vez de quebrar.
    if (!supportsProviderIdentity(store)) {
      ctx.session.forget(UID_SESSION_KEY);
      return ctx.response.redirect(backToLogin);
    }

    // Precedência do account linking:
    //  1. Identidade de provider já ligada → loga essa conta.
    //  2. Senão, e-mail conhecido → acha por e-mail e LIGA a identidade (linking).
    //  3. Senão → cria conta nova e liga a identidade.
    let user = await store.findByProviderIdentity(provider, profile.id);

    // E-mail que o provider declara NÃO verificado não identifica ninguém: ligar
    // por ele entregaria a conta de quem é dono do endereço a quem só o digitou
    // no provider. `unsupported`/ausente (provider que não informa) segue valendo.
    const emailUnverified = profile.emailVerificationState === 'unverified';

    if (!user && email && emailUnverified) {
      await cfg.audit?.record({
        type: 'login.failure',
        email,
        ip: ctx.request.ip?.() ?? null,
        metadata: { stage: 'social', provider, reason: 'provider_email_unverified' },
      });
      ctx.session.forget(UID_SESSION_KEY);
      return ctx.response.redirect(backToLogin);
    }

    if (!user && email) {
      // Busca pela MESMA forma normalizada que o login usa. Uma conta gravada
      // com outra grafia não é encontrada aqui e a pessoa ganharia uma SEGUNDA
      // conta — por isso `authkit:users:normalize-emails` é passo de upgrade.
      const byEmail = await store.findByEmail(email);
      if (byEmail) {
        await store.linkProviderIdentity({
          accountId: byEmail.id,
          provider,
          providerUserId: profile.id,
          email,
        });
        user = byEmail;
      }
    }

    if (!user) {
      // Sem e-mail não há como criar/identificar uma conta — volta ao login.
      if (!email) {
        ctx.session.forget(UID_SESSION_KEY);
        return ctx.response.redirect(backToLogin);
      }
      const created = await store.create({
        email,
        password: randomUUID(),
        fullName: profile.name ?? null,
        // Só o provider que confirma o e-mail o torna verificado aqui.
        emailVerified: profile.emailVerificationState === 'verified',
      });
      await store.linkProviderIdentity({
        accountId: created.id,
        provider,
        providerUserId: profile.id,
        email,
      });
      user = created;
    }

    // Status da conta: mesmo gate compartilhado dos demais fluxos de login. O
    // callback já voltou do provider OAuth — não há passo de formulário para
    // re-renderizar um erro, então seguimos a convenção deste controller e
    // redirecionamos de volta ao login.
    //
    // O QUE ESTE CAMINHO APLICA:
    //  - `disabled` → recusa (evento `login.failure` com `reason: 'disabled'`).
    //  - `account_expiration` (inatividade) → recusa (evento
    //    `account.expired_login_blocked`). Isto exige `settings`: sem eles,
    //    `assertAccountNotExpired` deixa AMBAS as checagens de expiração como
    //    no-op, e era exatamente esse o bug — uma política de controle de acesso
    //    valendo em todo lugar menos no "Continue with Google".
    //
    // O QUE ESTE CAMINHO **NÃO** APLICA (`passwordless: true`):
    //  - `password_expiration`. Este é um fluxo SEM senha: a conta pode nunca ter
    //    definido uma (login social puro → `password_changed_at` NULL, que
    //    `isPasswordExpired` trata como "vencida"), e este controller não tem um
    //    passo de troca obrigatória para onde mandar o usuário — só sabe
    //    redirecionar de volta ao login. Aplicar a checagem aqui trancaria
    //    permanentemente todo usuário social-only assim que o operador ligasse a
    //    política, devolvendo-o a uma tela sem senha nenhuma que pudesse trocar.
    //
    // `resolveRuntimeSettingsOrNoop` degrada para um RuntimeSettings no-op quando
    // não há tabela de settings — host sem a migração continua logando por social.
    const settings = await resolveRuntimeSettingsOrNoop(ctx);
    const statusGate = await assertLoginAllowed(cfg, user.id, {
      email: user.email,
      ip: ctx.request.ip?.() ?? null,
      settings,
      passwordless: true,
    });
    if (!statusGate.allowed) {
      ctx.session.forget(UID_SESSION_KEY);
      return ctx.response.redirect(backToLogin);
    }

    // Preferência por usuário: método social desligado para esta conta → recusa.
    // Aplica-se a contas EXISTENTES (identidade ligada ou e-mail conhecido); uma
    // conta recém-criada pelo callback não tem preferência gravada, então herda
    // os globais — o gate é no-op para ela por construção.
    const existingUser = user;
    if (supportsLoginMethodsPreference(store)) {
      const pref = await store.getLoginMethods(existingUser.id);
      const scoped = resolveEffectiveUserLoginMethods(
        await resolveGlobalAuthMethodsForUser(cfg, settings),
        pref,
      );
      if (scoped.social.length === 0) {
        ctx.session.forget(UID_SESSION_KEY);
        return ctx.response.redirect(backToLogin);
      }
    }

    ctx.session.forget(UID_SESSION_KEY);

    // 2º fator: o provider provou a identidade, mas quem cadastrou TOTP/passkey
    // aqui espera que o fator valha também neste caminho. O desafio mora no
    // interaction controller (mesmo gate de senha/magic link/OTP), então este
    // passo só registra o login pendente e manda o browser para lá.
    const policy = await resolveSecondFactorPolicy(cfg, {
      id: user.id,
      email: user.email,
      globalRoles: (user as { globalRoles?: string[] }).globalRoles,
    });
    const needsGate =
      policy === 'required' ||
      (policy === 'enrolled' && (!!cfg.mfa || (await hasEnrolledSecondFactor(store, user.id))));
    if (needsGate) {
      if (!uid) return ctx.response.redirect(backToLogin);
      const pending: SocialPendingLogin = {
        accountId: user.id,
        uid,
        required: policy === 'required',
        at: Date.now(),
      };
      ctx.session.put(SOCIAL_PENDING_KEY, pending);
      return ctx.response.redirect(`/auth/interaction/${uid}/social/continue`);
    }

    // Conclui a interaction OIDC para este usuário (escreve o 303 de volta ao authorize).
    // O cookie de interaction (path '/') sobrevive ao round-trip do provider OAuth.
    await service.interactions.completeLogin(ctx, user.id);
  }
}
