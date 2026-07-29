import '../augmentations.js';
import { randomUUID } from 'node:crypto';
import type { AllyDriverContract } from '@adonisjs/ally/types';
import type { HttpContext } from '@adonisjs/core/http';
import { supportsProviderIdentity } from '../../accounts/account_store.js';
import { assertLoginAllowed } from '../login_attempt.js';
import { resolveRuntimeSettingsOrNoop } from '../runtime_settings.js';

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
    const email = profile.email ?? undefined;

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

    if (!user && email) {
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
        emailVerified: true,
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

    ctx.session.forget(UID_SESSION_KEY);

    // Conclui a interaction OIDC para este usuário (escreve o 303 de volta ao authorize).
    // O cookie de interaction (path '/') sobrevive ao round-trip do provider OAuth.
    await service.interactions.completeLogin(ctx, user.id);
  }
}
