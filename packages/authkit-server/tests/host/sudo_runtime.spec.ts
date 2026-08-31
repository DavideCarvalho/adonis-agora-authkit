import { test } from '@japa/runner';
import { DEFAULT_MESSAGES } from '../../src/host/i18n.js';
import {
  completeSudo,
  fail,
  LAST_METHOD_SESSION_KEY,
  resolveAvailableMethods,
} from '../../src/host/sudo/runtime.js';
import type { SudoMethod } from '../../src/host/sudo/types.js';
import { SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';

function fakeSudoContext(opts: { returnTo?: string | null } = {}) {
  const session: Record<string, unknown> = {};
  const flashed: Record<string, unknown> = {};
  const redirects: string[] = [];
  const audit: unknown[] = [];
  const warnings: Array<{ payload: unknown; message: string }> = [];

  const c = {
    accountId: 'acc-1',
    account: { id: 'acc-1', email: 'user@example.com' },
    returnTo: opts.returnTo ?? null,
    cfg: {
      messages: { ...DEFAULT_MESSAGES },
      audit: {
        async record(e: unknown) {
          audit.push(e);
        },
      },
    },
    ctx: {
      session: {
        get: (k: string) => session[k],
        put: (k: string, v: unknown) => {
          session[k] = v;
        },
        forget: (k: string) => {
          delete session[k];
        },
        flash: (k: string, v: unknown) => {
          flashed[k] = v;
        },
      },
      request: { ip: () => '203.0.113.1' },
      response: {
        redirect: (u: string) => {
          redirects.push(u);
          return { _redirect: u };
        },
      },
      // Logger espião: só o suficiente pra provar que `warn` foi chamado —
      // não é um logger real do Adonis.
      logger: {
        warn: (payload: unknown, message: string) => {
          warnings.push({ payload, message });
        },
      },
    },
  } as any;

  return { c, session, flashed, redirects, audit, warnings };
}

/** Método de teste com disponibilidade e id controláveis. */
function stubMethod(id: string, available: boolean | (() => never)): SudoMethod {
  return {
    id,
    async isAvailable() {
      if (typeof available === 'function') available();
      return available as boolean;
    },
    async describe() {
      return {
        labelKey: `account.confirm.method.${id}`,
        kind: 'action',
        endpoint: `/account/confirm/${id}`,
      };
    },
  };
}

test.group('completeSudo', () => {
  test('marca sudo na sessão', async ({ assert }) => {
    const h = fakeSudoContext();
    await completeSudo(h.c, 'password');
    assert.isNumber(h.session[SUDO_SESSION_KEY]);
  });

  test('audita com o method recebido', async ({ assert }) => {
    const h = fakeSudoContext();
    await completeSudo(h.c, 'magic-link');
    assert.deepInclude(h.audit[0] as object, { type: 'sudo.confirmed', accountId: 'acc-1' });
    assert.deepEqual((h.audit[0] as any).metadata, { method: 'magic-link' });
  });

  test('lembra o método usado para ordenar a tela depois', async ({ assert }) => {
    const h = fakeSudoContext();
    await completeSudo(h.c, 'passkey');
    assert.equal(h.session[LAST_METHOD_SESSION_KEY], 'passkey');
  });

  test('redireciona pro returnTo quando presente', async ({ assert }) => {
    const h = fakeSudoContext({ returnTo: '/account/security' });
    await completeSudo(h.c, 'password');
    assert.deepEqual(h.redirects, ['/account/security']);
  });

  test('redireciona pro accountHome quando não há returnTo', async ({ assert }) => {
    const h = fakeSudoContext();
    await completeSudo(h.c, 'password');
    assert.deepEqual(h.redirects, ['/account/security']);
  });
});

test.group('fail', () => {
  test('flasha o erro traduzido e NÃO marca sudo', async ({ assert }) => {
    const h = fakeSudoContext();
    await fail(h.c, 'account.confirm.error');
    assert.isNotNull(h.flashed.confirmError);
    assert.isUndefined(h.session[SUDO_SESSION_KEY]);
  });

  test('preserva o return_to no redirect de volta', async ({ assert }) => {
    const h = fakeSudoContext({ returnTo: '/account/security' });
    await fail(h.c, 'account.confirm.error');
    assert.deepEqual(h.redirects, ['/account/confirm?return_to=%2Faccount%2Fsecurity']);
  });
});

test.group('resolveAvailableMethods', () => {
  test('filtra os indisponíveis', async ({ assert }) => {
    const h = fakeSudoContext();
    const out = await resolveAvailableMethods(h.c, [stubMethod('a', true), stubMethod('b', false)]);
    assert.deepEqual(
      out.map((m) => m.id),
      ['a'],
    );
  });

  test('omite método cujo isAvailable lança, sem derrubar os outros', async ({ assert }) => {
    const h = fakeSudoContext();
    const explode = stubMethod('boom', () => {
      throw new Error('falhou');
    });
    const out = await resolveAvailableMethods(h.c, [explode, stubMethod('ok', true)]);
    assert.deepEqual(
      out.map((m) => m.id),
      ['ok'],
    );
  });

  test('loga warn com o id do método quando isAvailable lança', async ({ assert }) => {
    const h = fakeSudoContext();
    const explode = stubMethod('boom', () => {
      throw new Error('falhou');
    });
    await resolveAvailableMethods(h.c, [explode, stubMethod('ok', true)]);
    assert.lengthOf(h.warnings, 1);
    assert.equal((h.warnings[0].payload as any).method, 'boom');
    assert.instanceOf((h.warnings[0].payload as any).err, Error);
    assert.include(h.warnings[0].message, 'boom');
  });

  test('promove o último método usado para o topo', async ({ assert }) => {
    const h = fakeSudoContext();
    h.session[LAST_METHOD_SESSION_KEY] = 'b';
    const out = await resolveAvailableMethods(h.c, [stubMethod('a', true), stubMethod('b', true)]);
    assert.deepEqual(
      out.map((m) => m.id),
      ['b', 'a'],
    );
  });

  test('devolve lista vazia quando nada está disponível', async ({ assert }) => {
    const h = fakeSudoContext();
    const out = await resolveAvailableMethods(h.c, [stubMethod('a', false)]);
    assert.lengthOf(out, 0);
  });
});
