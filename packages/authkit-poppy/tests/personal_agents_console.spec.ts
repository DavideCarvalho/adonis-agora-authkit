import { ACCOUNT_SESSION_KEY } from '@adonis-agora/authkit-server';
import { test } from '@japa/runner';
import {
  ConsolePersonalAgentsController,
  SUDO_ACCOUNT_SESSION_KEY,
  SUDO_SESSION_KEY,
} from './authkit_internals.js';
import {
  ACCOUNT_ID,
  b64,
  CLIENT_ID,
  type Env,
  OTHER_ACCOUNT_ID,
  setupPoppy,
} from './poppy_helpers.js';

const ADMIN_ID = 'admin-1';

/** Ctx falso do console: `authkit.server` e `lucid.db` do ambiente; sudo opcional. */
function consoleCtx(
  service: any,
  db: any,
  opts: {
    body?: any;
    params?: Record<string, string>;
    qs?: Record<string, string>;
    sudo?: boolean;
  } = {},
) {
  let status = 200;
  let body: any;
  const set = (s: number) => (b: any) => {
    status = s;
    body = b;
    return b;
  };
  const audit: any[] = [];
  service.config.audit = { record: async (e: any) => audit.push(e) };
  const ctx = {
    request: {
      body: () => opts.body ?? {},
      param: (k: string) => opts.params?.[k],
      qs: () => opts.qs ?? {},
      ip: () => '127.0.0.1',
      url: () => '/admin/api/personal-agents',
      parsedUrl: { search: '' },
    },
    response: {
      status: (s: number) => ({ send: set(s) }),
      notFound: set(404),
      unprocessableEntity: set(422),
      redirect: () => undefined,
    },
    session: {
      get: (k: string) => {
        if (k === ACCOUNT_SESSION_KEY) return ADMIN_ID;
        if (!opts.sudo) return undefined;
        if (k === SUDO_SESSION_KEY) return Date.now();
        if (k === SUDO_ACCOUNT_SESSION_KEY) return ADMIN_ID;
        return undefined;
      },
    },
    containerResolver: {
      make: async (k: string) => {
        if (k === 'authkit.server') return service;
        if (k === 'lucid.db') return db;
        throw new Error(`no binding for ${k}`);
      },
    },
  } as any;
  return { ctx, status: () => status, body: () => body, audit };
}

/** Um sign-in por Device Sign-In (cria o refresh token `pgrant_`). */
async function signIn(env: Env, accountId: string) {
  const res = await env.signIn({ accountId, scope: 'orders:read' });
  return { sid: b64(), accessToken: res.access_token };
}

/** O agente consegue começar uma Session? */
async function sessionAccepted(env: Env): Promise<boolean> {
  return (await env.poppy.verifyAccess(await env.request({ sid: b64() }))).ok;
}

const controller = new ConsolePersonalAgentsController();

test.group('console admin — personal agents (Poppy)', () => {
  test('lista o agente conectado e as conexões, com o e-mail da conta', async ({ assert }) => {
    const env = await setupPoppy();
    await signIn(env, ACCOUNT_ID);
    await signIn(env, OTHER_ACCOUNT_ID);

    const index = consoleCtx(env.service, env.db);
    const overview: any = await controller.index(index.ctx);
    assert.deepEqual(overview.protocols.poppy, {
      label: 'Poppy',
      requireRegistration: false,
      hostResolver: false,
      allowHttpIdentifiers: false,
      identifierLabel: 'Client ID (metadata URL)',
      identifierPlaceholder: 'https://agent.example/poppy-agent/agent.json',
    });
    assert.isNull(overview.protocols.pact);
    assert.lengthOf(overview.agents, 1);
    assert.include(overview.agents[0], {
      protocol: 'poppy',
      identifier: CLIENT_ID,
      name: 'Example Agent',
      effective: 'unlisted',
      connections: 2,
    });

    const list = consoleCtx(env.service, env.db, { qs: { clientId: CLIENT_ID, size: '1' } });
    const page: any = await controller.connections(list.ctx);
    assert.deepEqual(page.meta, { page: 1, size: 1, total: 2 });
    assert.lengthOf(page.data, 1);
    assert.include(page.data[0], {
      protocol: 'poppy',
      clientId: CLIENT_ID,
      agentName: 'Example Agent',
    });
    assert.include(['jane@example.com', 'john@example.com'], page.data[0].accountEmail);
    assert.deepEqual(page.data[0].scopes, ['orders:read']);
    await env.close();
  });

  test('revogar uma conexão exige sudo e corta só aquela conta', async ({ assert }) => {
    const env = await setupPoppy();
    const jane = await signIn(env, ACCOUNT_ID);
    const john = await signIn(env, OTHER_ACCOUNT_ID);
    const [janeGrant] = await env.poppy.listGrants(ACCOUNT_ID);

    const noSudo = consoleCtx(env.service, env.db, { params: { grantId: janeGrant.id } });
    await controller.revokeConnection(noSudo.ctx);
    assert.equal(noSudo.status(), 403);
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 1);

    const ok = consoleCtx(env.service, env.db, { params: { grantId: janeGrant.id }, sudo: true });
    assert.deepEqual(await controller.revokeConnection(ok.ctx), { revoked: true });
    assert.equal(ok.audit[0].type, 'agent.grant_revoked_by_admin');
    assert.equal(ok.audit[0].accountId, ACCOUNT_ID);

    const janeCheck = await env.poppy.verifyAccess(
      await env.request({ sid: jane.sid, token: jane.accessToken }),
    );
    assert.isTrue(!janeCheck.ok && janeCheck.error === 'invalid_token');
    const johnCheck = await env.poppy.verifyAccess(
      await env.request({ sid: john.sid, token: john.accessToken }),
    );
    assert.isTrue(johnCheck.ok && johnCheck.principal.signedIn);

    const again = consoleCtx(env.service, env.db, {
      params: { grantId: janeGrant.id },
      sudo: true,
    });
    await controller.revokeConnection(again.ctx);
    assert.equal(again.status(), 404);

    // Expirado já não vale: 404, sem evento de auditoria.
    const [johnGrant] = await env.poppy.listGrants(OTHER_ACCOUNT_ID);
    env.setNow(johnGrant.expiresAt.getTime() + 1000);
    const expired = consoleCtx(env.service, env.db, {
      params: { grantId: johnGrant.id },
      sudo: true,
    });
    await controller.revokeConnection(expired.ctx);
    assert.equal(expired.status(), 404);
    assert.lengthOf(expired.audit, 0);
    await env.close();
  });

  test('bloquear desconecta de todas as contas e recusa Sessions novas; desbloquear volta', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const jane = await signIn(env, ACCOUNT_ID);
    await signIn(env, OTHER_ACCOUNT_ID);

    const block = consoleCtx(env.service, env.db, {
      body: { protocol: 'poppy', identifier: CLIENT_ID, status: 'blocked' },
      sudo: true,
    });
    const res: any = await controller.upsert(block.ctx);
    assert.equal(res.disconnected, 2);
    assert.equal(res.entry.status, 'blocked');
    assert.equal(block.audit[0].type, 'agent.blocked');

    // O token da Session acaba na hora, e o agente não começa outra.
    const check = await env.poppy.verifyAccess(
      await env.request({ sid: jane.sid, token: jane.accessToken }),
    );
    assert.isFalse(check.ok);
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 0);
    assert.lengthOf(await env.poppy.listGrants(OTHER_ACCOUNT_ID), 0);
    assert.isFalse(await sessionAccepted(env));

    const overview: any = await controller.index(consoleCtx(env.service, env.db).ctx);
    assert.include(overview.agents[0], { effective: 'blocked', connections: 0 });

    const remove = consoleCtx(env.service, env.db, {
      params: { id: overview.agents[0].console.id },
      sudo: true,
    });
    assert.deepEqual(await controller.destroy(remove.ctx), { removed: true });
    assert.isTrue(await sessionAccepted(env));
    await env.close();
  });

  test('requireRegistration: liberar pelo console deixa o agente entrar', async ({ assert }) => {
    const env = await setupPoppy({ clients: { requireRegistration: true } });
    assert.isFalse(await sessionAccepted(env));

    const allow = consoleCtx(env.service, env.db, {
      body: { protocol: 'poppy', identifier: CLIENT_ID, status: 'allowed', name: 'Assistente' },
      sudo: true,
    });
    const res: any = await controller.upsert(allow.ctx);
    assert.equal(res.disconnected, 0);
    assert.isTrue(await sessionAccepted(env));

    const overview: any = await controller.index(consoleCtx(env.service, env.db).ctx);
    assert.include(overview.agents[0], { name: 'Assistente', effective: 'allowed' });
    await env.close();
  });

  test('o que o config bloqueia o console não libera', async ({ assert }) => {
    const env = await setupPoppy({ clients: { blocked: [CLIENT_ID] } });
    const allow = consoleCtx(env.service, env.db, {
      body: { protocol: 'poppy', identifier: CLIENT_ID, status: 'allowed' },
      sudo: true,
    });
    await controller.upsert(allow.ctx);
    assert.isFalse(await sessionAccepted(env));
    const overview: any = await controller.index(consoleCtx(env.service, env.db).ctx);
    assert.include(overview.agents[0], { config: 'blocked', effective: 'blocked' });
    await env.close();
  });

  test('validação: protocolo desligado, identificador não-HTTPS, sem sudo', async ({ assert }) => {
    const env = await setupPoppy();
    const pact = consoleCtx(env.service, env.db, {
      body: { protocol: 'pact', identifier: 'https://a.example', status: 'blocked' },
      sudo: true,
    });
    await controller.upsert(pact.ctx);
    assert.equal(pact.status(), 422);

    const http = consoleCtx(env.service, env.db, {
      body: { protocol: 'poppy', identifier: 'http://agent.example/agent.json', status: 'blocked' },
      sudo: true,
    });
    await controller.upsert(http.ctx);
    assert.equal(http.status(), 422);

    const userinfo = consoleCtx(env.service, env.db, {
      body: {
        protocol: 'poppy',
        identifier: 'https://user:pass@agent.example/agent.json',
        status: 'blocked',
      },
      sudo: true,
    });
    await controller.upsert(userinfo.ctx);
    assert.equal(userinfo.status(), 422);

    const noSudo = consoleCtx(env.service, env.db, {
      body: { protocol: 'poppy', identifier: CLIENT_ID, status: 'blocked' },
    });
    await controller.upsert(noSudo.ctx);
    assert.equal(noSudo.status(), 403);
    assert.lengthOf(await env.db.connection().from('auth_agent_registry'), 0);
    await env.close();
  });
});
