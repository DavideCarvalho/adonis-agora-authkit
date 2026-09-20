/**
 * Superfície de ESCRITA headless da conta — client + hooks de mutation.
 *
 * É o lado React do espelho JSON de `/account/api/*`: o host desenha as
 * próprias telas de organização e de segundo fator e nunca manda o usuário ao
 * console `/account/*`.
 *
 * O que estes testes fixam:
 *
 *   - VERBO, URL e CORPO de cada método novo do `AuthkitClient` — um PATCH que
 *     vira POST, ou um id não-encodado, é bug de segurança tanto quanto de
 *     roteamento (`/orgs/a/b/members/x` cairia em outra rota);
 *   - o CSRF vai em TODA escrita (o servidor não isenta nenhuma delas);
 *   - o token de aceite e os ids vão ENCODADOS no path;
 *   - cada hook devolve a `mutationKey` de `authkitKeys` e uma `mutationFn` que
 *     bate no endpoint certo — inclusive dentro de um `useMutation` real;
 *   - erros do servidor chegam como `AuthkitClientError` com o `code` do
 *     envelope (`sudo_required`, `slug_taken`, …), que é o que a tela lê;
 *   - a cerimônia de passkey em JSON encadeia options → `startRegistration` →
 *     verify, sem nenhum POST de página inteira.
 *
 * Os hooks são renderizados com `react-dom/server` (mesma técnica de
 * `idp_mode.spec.ts` e `can_permission.spec.ts`): eles leem o client do
 * contexto, então não dá para chamá-los soltos.
 */

import { test } from '@japa/runner';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type AuthkitClient,
  AuthkitClientError,
  createAuthkitClient,
} from '../src/client/client.js';
import { AuthkitClientProvider } from '../src/client/context.js';
import { registerPasskeyJson } from '../src/passkey/json_registration.js';
import {
  useAccountAcceptOrgInvitationMutationOptions,
  useAccountActivateOrgMutationOptions,
  useAccountCreateOrgMutationOptions,
  useAccountDeactivateOrgMutationOptions,
  useAccountInviteOrgMemberMutationOptions,
  useAccountLeaveOrgMutationOptions,
  useAccountRemoveOrgMemberMutationOptions,
  useAccountRevokeOrgInvitationMutationOptions,
  useAccountUpdateOrgMemberRoleMutationOptions,
  useConfirmTotpMutationOptions,
  useDisableTotpMutationOptions,
  useEnrollTotpMutationOptions,
  useRegenerateRecoveryCodesMutationOptions,
  useRegisterPasskeyMutationOptions,
} from '../src/queries/account/index.js';
import { authkitKeys } from '../src/queries/keys.js';
import { createElementWithChildren } from './helpers/create_element.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  body: unknown;
  csrf: string | undefined;
}

/** Client com fetch instrumentado: guarda verbo, URL, corpo e header de CSRF. */
function instrumentedClient(response: unknown = { ok: true }, status = 200) {
  const calls: Call[] = [];
  const client = createAuthkitClient({
    baseUrl: '/admin/api',
    accountBaseUrl: '/account/api',
    csrfToken: 'csrf-token-1',
    fetch: async (input, init = {}) => {
      const headers = new Headers(init.headers as HeadersInit | undefined);
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        csrf: headers.get('x-csrf-token') ?? undefined,
      });
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      }) as any;
    },
  });
  return { client, calls, last: () => calls[calls.length - 1] };
}

/**
 * Renderiza um hook dentro do `AuthkitClientProvider` e devolve o que ele
 * retornou. `renderToStaticMarkup` é síncrono, então o valor já está capturado
 * quando a função retorna.
 */
function renderHook<T>(useHook: () => T, client: AuthkitClient): T {
  let captured: T | undefined;
  const Probe = () => {
    captured = useHook();
    return null;
  };
  const tree: ReactNode = createElementWithChildren(
    AuthkitClientProvider,
    { client },
    createElement(Probe),
  );
  renderToStaticMarkup(tree as any);
  if (captured === undefined) throw new Error('o hook não renderizou');
  return captured;
}

// ─── Client: orgs (escrita) ──────────────────────────────────────────────────

test.group('AuthkitClient — account.orgs (escrita)', () => {
  test('create: POST /account/api/orgs com name+slug e CSRF', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.create({ name: 'Acme', slug: 'acme' });
    assert.equal(last().url, '/account/api/orgs');
    assert.equal(last().method, 'POST');
    assert.deepEqual(last().body, { name: 'Acme', slug: 'acme' });
    assert.equal(last().csrf, 'csrf-token-1');
  });

  test('activate/deactivate batem nas rotas certas', async ({ assert }) => {
    const { client, calls } = instrumentedClient();
    await client.account.orgs.activate('org-1');
    await client.account.orgs.deactivate();
    assert.equal(calls[0].url, '/account/api/orgs/org-1/activate');
    assert.equal(calls[1].url, '/account/api/orgs/deactivate');
    assert.equal(calls[1].method, 'POST');
  });

  test('leave: POST /account/api/orgs/:id/leave', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.leave('org-1');
    assert.equal(last().url, '/account/api/orgs/org-1/leave');
    assert.equal(last().method, 'POST');
  });

  test('invite: POST na org do path, com email e role no corpo', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.invite('org-1', { email: 'a@b.com', role: 'admin' });
    assert.equal(last().url, '/account/api/orgs/org-1/invitations');
    assert.deepEqual(last().body, { email: 'a@b.com', role: 'admin' });
  });

  test('revokeInvitation: DELETE escopado por org (anti-IDOR no próprio path)', async ({
    assert,
  }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.revokeInvitation('org-1', 'inv-9');
    assert.equal(last().url, '/account/api/orgs/org-1/invitations/inv-9');
    assert.equal(last().method, 'DELETE');
  });

  test('updateMemberRole: PATCH com role no corpo', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.updateMemberRole('org-1', 'acc-2', 'admin');
    assert.equal(last().url, '/account/api/orgs/org-1/members/acc-2');
    assert.equal(last().method, 'PATCH');
    assert.deepEqual(last().body, { role: 'admin' });
  });

  test('removeMember: DELETE do membro na org', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.removeMember('org-1', 'acc-2');
    assert.equal(last().url, '/account/api/orgs/org-1/members/acc-2');
    assert.equal(last().method, 'DELETE');
  });

  test('acceptInvitation: token ENCODADO no path', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.acceptInvitation('tok/with+slash');
    assert.equal(last().url, '/account/api/orgs/invitations/tok%2Fwith%2Bslash/accept');
    assert.equal(last().method, 'POST');
  });

  test('ids com barra são encodados (senão o path casaria outra rota)', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    await client.account.orgs.removeMember('org/1', 'acc/2');
    assert.equal(last().url, '/account/api/orgs/org%2F1/members/acc%2F2');
  });

  test('TODA escrita de org manda o header de CSRF', async ({ assert }) => {
    const { client, calls } = instrumentedClient();
    await client.account.orgs.create({ name: 'A', slug: 'a' });
    await client.account.orgs.activate('o');
    await client.account.orgs.deactivate();
    await client.account.orgs.leave('o');
    await client.account.orgs.invite('o', { email: 'a@b.com' });
    await client.account.orgs.revokeInvitation('o', 'i');
    await client.account.orgs.updateMemberRole('o', 'a', 'member');
    await client.account.orgs.removeMember('o', 'a');
    await client.account.orgs.acceptInvitation('t');
    assert.lengthOf(calls, 9);
    for (const call of calls) {
      assert.equal(call.csrf, 'csrf-token-1', `${call.method} ${call.url} sem CSRF`);
    }
  });
});

// ─── Client: MFA (escrita) ───────────────────────────────────────────────────

test.group('AuthkitClient — account.mfa (escrita)', () => {
  test('mfa() continua sendo a LEITURA do status (assinatura preservada)', async ({ assert }) => {
    const { client, last } = instrumentedClient({ enabled: false });
    await client.account.mfa();
    assert.equal(last().url, '/account/api/mfa');
    assert.equal(last().method, 'GET');
  });

  test('enroll/confirm/disable/recovery-codes batem nas rotas certas', async ({ assert }) => {
    const { client, calls } = instrumentedClient();
    await client.account.mfa.enroll();
    await client.account.mfa.confirm('123456');
    await client.account.mfa.disable();
    await client.account.mfa.regenerateRecoveryCodes();
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        'POST /account/api/mfa/totp/enroll',
        'POST /account/api/mfa/totp/confirm',
        'POST /account/api/mfa/totp/disable',
        'POST /account/api/mfa/recovery-codes',
      ],
    );
    assert.deepEqual(calls[1].body, { code: '123456' });
    for (const call of calls) assert.equal(call.csrf, 'csrf-token-1');
  });

  test('passkeys.options/verify são POST em JSON (nunca form de página inteira)', async ({
    assert,
  }) => {
    const { client, calls } = instrumentedClient();
    await client.account.mfa.passkeys.options();
    await client.account.mfa.passkeys.verify('{"id":"cred"}');
    assert.equal(calls[0].url, '/account/api/mfa/passkeys/options');
    assert.equal(calls[1].url, '/account/api/mfa/passkeys/verify');
    assert.deepEqual(calls[1].body, { response: '{"id":"cred"}' });
  });

  test('403 sudo_required chega como AuthkitClientError com o code do envelope', async ({
    assert,
  }) => {
    const { client } = instrumentedClient(
      { error: { code: 'sudo_required', message: 'Identity confirmation required.' } },
      403,
    );
    await assert.rejects(async () => {
      await client.account.mfa.enroll();
    });
    try {
      await client.account.mfa.enroll();
      assert.fail('deveria ter lançado');
    } catch (err) {
      assert.instanceOf(err, AuthkitClientError);
      assert.equal((err as AuthkitClientError).status, 403);
      assert.equal((err as AuthkitClientError).code, 'sudo_required');
    }
  });

  test('409 slug_taken também preserva o code (a tela precisa dele)', async ({ assert }) => {
    const { client } = instrumentedClient(
      { error: { code: 'slug_taken', message: 'Slug already in use.' } },
      409,
    );
    try {
      await client.account.orgs.create({ name: 'A', slug: 'a' });
      assert.fail('deveria ter lançado');
    } catch (err) {
      assert.equal((err as AuthkitClientError).code, 'slug_taken');
    }
  });
});

// ─── Hooks ───────────────────────────────────────────────────────────────────

test.group('Hooks de escrita da conta — mutationKey + mutationFn', () => {
  test('as mutationKeys vêm de authkitKeys e são distintas entre si', ({ assert }) => {
    const { client } = instrumentedClient();
    const keys = [
      renderHook(useAccountCreateOrgMutationOptions, client).mutationKey,
      renderHook(useAccountActivateOrgMutationOptions, client).mutationKey,
      renderHook(useAccountDeactivateOrgMutationOptions, client).mutationKey,
      renderHook(useAccountLeaveOrgMutationOptions, client).mutationKey,
      renderHook(useAccountInviteOrgMemberMutationOptions, client).mutationKey,
      renderHook(useAccountRevokeOrgInvitationMutationOptions, client).mutationKey,
      renderHook(useAccountUpdateOrgMemberRoleMutationOptions, client).mutationKey,
      renderHook(useAccountRemoveOrgMemberMutationOptions, client).mutationKey,
      renderHook(useAccountAcceptOrgInvitationMutationOptions, client).mutationKey,
      renderHook(useEnrollTotpMutationOptions, client).mutationKey,
      renderHook(useConfirmTotpMutationOptions, client).mutationKey,
      renderHook(useDisableTotpMutationOptions, client).mutationKey,
      renderHook(useRegenerateRecoveryCodesMutationOptions, client).mutationKey,
      renderHook(useRegisterPasskeyMutationOptions, client).mutationKey,
    ];

    assert.deepEqual(keys[0], authkitKeys.account.mutations.orgCreate());
    assert.deepEqual(keys[9], authkitKeys.account.mutations.mfaEnroll());

    const serialized = keys.map((k) => JSON.stringify(k));
    assert.lengthOf(new Set(serialized), keys.length, 'duas mutations com a MESMA chave');
  });

  test('todas as chaves de org caem sob o prefixo de org (useIsMutating por prefixo)', ({
    assert,
  }) => {
    const prefix = authkitKeys.account.mutations.orgs();
    for (const key of [
      authkitKeys.account.mutations.orgCreate(),
      authkitKeys.account.mutations.orgInvite(),
      authkitKeys.account.mutations.orgRemoveMember(),
    ]) {
      assert.deepEqual(key.slice(0, prefix.length), [...prefix]);
    }
  });

  test('createOrg: a mutationFn bate em POST /account/api/orgs', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    const options = renderHook(useAccountCreateOrgMutationOptions, client);
    await options.mutationFn({ name: 'Acme', slug: 'acme' });
    assert.equal(last().url, '/account/api/orgs');
    assert.deepEqual(last().body, { name: 'Acme', slug: 'acme' });
  });

  test('invite: a mutationFn separa orgId (path) de email/role (corpo)', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    const options = renderHook(useAccountInviteOrgMemberMutationOptions, client);
    await options.mutationFn({ orgId: 'org-1', email: 'a@b.com', role: 'member' });
    assert.equal(last().url, '/account/api/orgs/org-1/invitations');
    assert.deepEqual(last().body, { email: 'a@b.com', role: 'member' });
  });

  test('updateMemberRole: a mutationFn manda PATCH com o papel', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    const options = renderHook(useAccountUpdateOrgMemberRoleMutationOptions, client);
    await options.mutationFn({ orgId: 'org-1', accountId: 'acc-2', role: 'admin' });
    assert.equal(last().method, 'PATCH');
    assert.deepEqual(last().body, { role: 'admin' });
  });

  test('acceptInvitation: a mutationFn manda o token no path', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    const options = renderHook(useAccountAcceptOrgInvitationMutationOptions, client);
    await options.mutationFn('tok-1');
    assert.equal(last().url, '/account/api/orgs/invitations/tok-1/accept');
  });

  test('confirmTotp: a mutationFn manda o código no corpo', async ({ assert }) => {
    const { client, last } = instrumentedClient();
    const options = renderHook(useConfirmTotpMutationOptions, client);
    await options.mutationFn('123456');
    assert.equal(last().url, '/account/api/mfa/totp/confirm');
    assert.deepEqual(last().body, { code: '123456' });
  });

  test('enroll/disable/recovery-codes: mutationFns sem argumento', async ({ assert }) => {
    const { client, calls } = instrumentedClient();
    await renderHook(useEnrollTotpMutationOptions, client).mutationFn();
    await renderHook(useDisableTotpMutationOptions, client).mutationFn();
    await renderHook(useRegenerateRecoveryCodesMutationOptions, client).mutationFn();
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        '/account/api/mfa/totp/enroll',
        '/account/api/mfa/totp/disable',
        '/account/api/mfa/recovery-codes',
      ],
    );
  });

  test('a recusa de sudo propaga o erro pela mutationFn (a tela reage ao code)', async ({
    assert,
  }) => {
    const { client } = instrumentedClient({ error: { code: 'sudo_required', message: 'x' } }, 403);
    const options = renderHook(useEnrollTotpMutationOptions, client);
    try {
      await options.mutationFn();
      assert.fail('deveria ter lançado');
    } catch (err) {
      assert.equal((err as AuthkitClientError).code, 'sudo_required');
    }
  });

  test('fora do <AuthkitClientProvider> o hook falha alto', ({ assert }) => {
    const Probe = () => {
      useAccountCreateOrgMutationOptions();
      return null;
    };
    assert.throws(() => renderToStaticMarkup(createElement(Probe)));
  });
});

// ─── Cerimônia de passkey em JSON ────────────────────────────────────────────

test.group('registerPasskeyJson — options → startRegistration → verify', () => {
  test('encadeia as três etapas, sem nenhum POST de página inteira', async ({ assert }) => {
    const { client, calls } = instrumentedClient({ challenge: 'chal-1' });
    let seenOptions: unknown;

    const result = await registerPasskeyJson(client, {
      loadStartRegistration: async () => async (opts: { optionsJSON: unknown }) => {
        seenOptions = opts.optionsJSON;
        return { id: 'cred-1' };
      },
    });

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      ['POST /account/api/mfa/passkeys/options', 'POST /account/api/mfa/passkeys/verify'],
    );
    // As options do servidor chegam intactas ao startRegistration…
    assert.deepEqual(seenOptions, { challenge: 'chal-1' });
    // …e o attestation volta ao servidor no campo `response`.
    assert.deepEqual(calls[1].body, { response: { id: 'cred-1' } });
    assert.exists(result);
  });

  test('a recusa de sudo no verify propaga com o code (não vira sucesso silencioso)', async ({
    assert,
  }) => {
    const client = createAuthkitClient({
      baseUrl: '/admin/api',
      accountBaseUrl: '/account/api',
      csrfToken: 'x',
      fetch: async (input) =>
        String(input).endsWith('/verify')
          ? (new Response(JSON.stringify({ error: { code: 'sudo_required', message: 'x' } }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }) as any)
          : (new Response(JSON.stringify({ challenge: 'c' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }) as any),
    });

    try {
      await registerPasskeyJson(client, {
        loadStartRegistration: async () => async () => ({ id: 'cred' }),
      });
      assert.fail('deveria ter lançado');
    } catch (err) {
      assert.equal((err as AuthkitClientError).code, 'sudo_required');
    }
  });

  test('o hook usa a mesma cerimônia, com as deps injetadas', async ({ assert }) => {
    const { client, calls } = instrumentedClient({ challenge: 'c' });
    const options = renderHook(
      () =>
        useRegisterPasskeyMutationOptions({
          loadStartRegistration: async () => async () => ({ id: 'cred' }),
        }),
      client,
    );
    await options.mutationFn();
    assert.lengthOf(calls, 2);
    assert.equal(calls[1].url, '/account/api/mfa/passkeys/verify');
  });
});
