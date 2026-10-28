/**
 * Selo "último usado" do login: cookie por dispositivo com o método primário.
 *
 * Os testes de cookie usam o HttpContext REAL do Adonis (factories), porque o
 * ponto delicado é justamente o ciclo da resposta: o `interactionFinished` do
 * oidc-provider encerra a resposta crua antes do `finish()` do Adonis, e um
 * cookie que fica só no Adonis some em silêncio.
 */

import { HttpContextFactory, RequestFactory, ResponseFactory } from '@adonisjs/core/factories/http';
import { test } from '@japa/runner';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import {
  LAST_LOGIN_METHOD_COOKIE,
  normalizeLastLoginMethod,
  readLastLoginMethod,
  relayPendingCookies,
  rememberLastLoginMethod,
} from '../../src/host/last_login_method.js';
import { createInteractionActions } from '../../src/provider/interaction_actions.js';

const ENABLED = { login: { lastUsedMethod: true } };

function realCtx(cookieHeader?: string) {
  const request = new RequestFactory()
    .merge({ url: '/auth/interaction/u1', method: 'GET' })
    .create();
  if (cookieHeader) request.request.headers.cookie = cookieHeader;
  const response = new ResponseFactory()
    .merge({ req: request.request, res: request.response })
    .create();
  return new HttpContextFactory().merge({ request, response }).create();
}

/** Simula o `interactionFinished`: 303 + `res.end()` direto na resposta crua. */
function endRawLikeOidcProvider(ctx: ReturnType<typeof realCtx>) {
  const raw = ctx.response.response;
  raw.statusCode = 303;
  raw.setHeader('Location', '/auth/authorize/resume');
  raw.end();
}

function rawSetCookies(ctx: ReturnType<typeof realCtx>): string[] {
  const value = ctx.response.response.getHeader('set-cookie');
  return value === undefined ? [] : Array.isArray(value) ? value : [String(value)];
}

test.group('last login method — valores aceitos', () => {
  test('aceita os métodos conhecidos e os qualificados por provedor/id', ({ assert }) => {
    for (const method of [
      'password',
      'magic_link',
      'otp',
      'passkey',
      'social:google',
      'custom:whatsapp-code',
    ]) {
      assert.equal(normalizeLastLoginMethod(method), method);
    }
  });

  test('valor adulterado ou desconhecido vira undefined (sem selo)', ({ assert }) => {
    for (const raw of [
      undefined,
      null,
      42,
      '',
      'admin',
      'social:',
      'social:<script>',
      `social:${'a'.repeat(80)}`,
      'custom:a b',
    ]) {
      assert.isUndefined(normalizeLastLoginMethod(raw));
    }
  });
});

test.group('last login method — cookie no ciclo real do Adonis', () => {
  test('sem repasse, o cookie gravado antes do interactionFinished some', async ({ assert }) => {
    const ctx = realCtx();
    rememberLastLoginMethod(ctx, ENABLED, 'password');
    endRawLikeOidcProvider(ctx);
    ctx.response.finish();
    // É o bug que o repasse corrige: a resposta já saiu sem o Set-Cookie.
    assert.isFalse(rawSetCookies(ctx).some((c) => c.startsWith(`${LAST_LOGIN_METHOD_COOKIE}=`)));
  });

  test('com repasse, o cookie sai na resposta crua — uma vez só', async ({ assert }) => {
    const ctx = realCtx();
    rememberLastLoginMethod(ctx, ENABLED, 'social:google');
    relayPendingCookies(ctx);
    endRawLikeOidcProvider(ctx);
    ctx.response.finish();
    const ours = rawSetCookies(ctx).filter((c) => c.startsWith(`${LAST_LOGIN_METHOD_COOKIE}=`));
    assert.lengthOf(ours, 1);
    assert.include(ours[0], 'HttpOnly');
    assert.include(ours[0], 'SameSite=Lax');
    assert.include(ours[0], 'Path=/');
  });

  test('o repasse preserva Set-Cookie que já estava na resposta crua', async ({ assert }) => {
    const ctx = realCtx();
    ctx.response.response.setHeader('set-cookie', ['_interaction=abc; Path=/']);
    rememberLastLoginMethod(ctx, ENABLED, 'passkey');
    relayPendingCookies(ctx);
    const cookies = rawSetCookies(ctx);
    assert.lengthOf(cookies, 2);
    assert.isTrue(cookies[0].startsWith('_interaction='));
  });

  test('ida e volta: o valor gravado é o lido no próximo request', async ({ assert }) => {
    const first = realCtx();
    rememberLastLoginMethod(first, ENABLED, 'magic_link');
    relayPendingCookies(first);
    const pair = rawSetCookies(first)[0].split(';')[0];

    const next = realCtx(pair);
    assert.equal(readLastLoginMethod(next, ENABLED), 'magic_link');
  });

  test('cookie com valor inválido não vira selo', async ({ assert }) => {
    const first = realCtx();
    first.response.plainCookie(LAST_LOGIN_METHOD_COOKIE, 'social:<img>');
    relayPendingCookies(first);
    const pair = rawSetCookies(first)[0].split(';')[0];
    assert.isUndefined(readLastLoginMethod(realCtx(pair), ENABLED));
  });

  test('login.lastUsedMethod: false não grava nem lê', async ({ assert }) => {
    const off = { login: { lastUsedMethod: false } };
    const ctx = realCtx();
    rememberLastLoginMethod(ctx, off, 'password');
    relayPendingCookies(ctx);
    assert.lengthOf(rawSetCookies(ctx), 0);

    const seeded = realCtx();
    rememberLastLoginMethod(seeded, ENABLED, 'password');
    relayPendingCookies(seeded);
    const pair = rawSetCookies(seeded)[0].split(';')[0];
    assert.isUndefined(readLastLoginMethod(realCtx(pair), off));
  });

  test('resolveLogin liga a feature por default', ({ assert }) => {
    assert.isTrue(resolveLogin().lastUsedMethod);
    assert.isFalse(resolveLogin({ lastUsedMethod: false }).lastUsedMethod);
  });
});

test.group('last login method — completeLogin repassa os cookies', () => {
  test('os cookies do Adonis já estão na resposta crua quando o interactionFinished roda', async ({
    assert,
  }) => {
    const ctx = realCtx();
    let atFinish: string[] = [];
    const provider = {
      async interactionFinished() {
        atFinish = rawSetCookies(ctx);
      },
    };
    const actions = createInteractionActions(provider, {});
    rememberLastLoginMethod(ctx, ENABLED, 'otp');
    await actions.completeLogin(ctx, 'u1', { amr: ['email'] });
    assert.isTrue(atFinish.some((c) => c.startsWith(`${LAST_LOGIN_METHOD_COOKIE}=`)));
  });

  test('ctx mínimo (sem Response do Adonis) não quebra o completeLogin', async ({ assert }) => {
    let finished = false;
    const actions = createInteractionActions(
      {
        async interactionFinished() {
          finished = true;
        },
      },
      {},
    );
    await actions.completeLogin(
      { request: { request: {} }, response: { response: {} } } as any,
      'u1',
    );
    assert.isTrue(finished);
  });
});

test.group('last login method — tela de login recebe o selo', () => {
  function noTableDb() {
    return {
      from() {
        return (this as any).table();
      },
      table() {
        throw new Error('no table');
      },
    };
  }

  function setup(lastUsed: string | undefined) {
    const rendered: Array<{ view: string; props: Record<string, any> }> = [];
    const service = {
      config: {
        render: async (_ctx: any, view: string, props: Record<string, any>) => {
          rendered.push({ view, props });
        },
        messages: {},
        branding: { default: { appName: 'Acme', logoUrl: null }, clients: {}, firstParty: [] },
        passwordless: resolvePasswordless({ magicLink: false, passkeyFirst: false }),
        login: resolveLogin(),
        registration: { enabled: true },
        accountStore: {
          findByEmail: async () => null,
          findById: async () => null,
          verifyCredentials: async () => null,
        },
      },
      interactions: {
        details: async () => ({
          uid: 'u1',
          params: { client_id: 'web' },
          prompt: { name: 'login' },
        }),
      },
    };
    const ctx = {
      containerResolver: {
        make: async (key: string) => (key === 'authkit.server' ? service : noTableDb()),
      },
      request: {
        csrfToken: 'csrf',
        param: () => 'u1',
        input: (_k: string, def?: any) => def,
        qs: () => ({}),
        ip: () => '1.2.3.4',
        plainCookie: (name: string) => (name === LAST_LOGIN_METHOD_COOKIE ? lastUsed : undefined),
      },
      session: { get: () => undefined, put: () => {} },
      response: { redirect: () => undefined },
    } as any;
    return { ctx, rendered };
  }

  test('passo identifier carrega lastUsedLoginMethod do cookie', async ({ assert }) => {
    const { ctx, rendered } = setup('social:google');
    await new InteractionController().show(ctx);
    assert.equal(rendered[0].view, 'login');
    assert.equal(rendered[0].props.step, 'identifier');
    assert.equal(rendered[0].props.lastUsedLoginMethod, 'social:google');
  });

  test('sem cookie, sem selo', async ({ assert }) => {
    const { ctx, rendered } = setup(undefined);
    await new InteractionController().show(ctx);
    assert.isUndefined(rendered[0].props.lastUsedLoginMethod);
  });
});
