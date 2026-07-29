/**
 * Testes do login por passkey disparado por clique (as três camadas):
 *   - authenticatePasskey (tier 3): cerimônia real, com fetch + startAuthentication
 *     injetados — cobertura comportamental (prove-by-mutation).
 *   - submitPasskeyVerification (tier 3): SSR-safe sem `document`.
 *   - usePasskeyLogin (tier 2) e PasskeyButton (tier 1): exportados e com o shape certo
 *     (o comportamento com useState/DOM não roda em Node, como nos demais specs React).
 */

import { test } from '@japa/runner';
import { PasskeyButton } from '../src/components/passkey_button.js';
import { type UsePasskeyLoginOptions, usePasskeyLogin } from '../src/hooks/use_passkey_login.js';
import {
  type PasskeyCeremonyDeps,
  type StartAuthenticationFn,
  type StartRegistrationFn,
  authenticatePasskey,
  loadStartAuthentication,
  submitPasskeyVerification,
} from '../src/passkey/authenticate.js';

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/** Captura o que a cerimônia enviou, devolvendo options fixas e uma assertion fixa. */
function stubDeps(overrides: Partial<PasskeyCeremonyDeps> = {}) {
  const calls: {
    fetchUrl?: string;
    fetchInit?: RequestInit;
    startInput?: unknown;
  } = {};
  const startAuthentication: StartAuthenticationFn = async (opts) => {
    calls.startInput = opts.optionsJSON;
    return { id: 'assertion-xyz', type: 'public-key' };
  };
  const deps: PasskeyCeremonyDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.fetchUrl = url;
      calls.fetchInit = init;
      return okResponse({ challenge: 'chal-1' });
    }) as unknown as typeof globalThis.fetch,
    loadStartAuthentication: async () => startAuthentication,
    ...overrides,
  };
  return { deps, calls };
}

test.group('authenticatePasskey (tier 3 — cerimônia)', () => {
  test('POSTs to optionsUrl and returns the assertion serialized', async ({ assert }) => {
    const { deps, calls } = stubDeps();
    const result = await authenticatePasskey({ optionsUrl: '/opts' }, deps);

    assert.equal(calls.fetchUrl, '/opts');
    assert.equal(calls.fetchInit?.method, 'POST');
    // A assertion devolvida por startAuthentication volta serializada.
    assert.equal(result, JSON.stringify({ id: 'assertion-xyz', type: 'public-key' }));
  });

  test('feeds the fetched options straight into startAuthentication', async ({ assert }) => {
    const { deps, calls } = stubDeps();
    await authenticatePasskey({ optionsUrl: '/opts' }, deps);
    // O que o servidor devolveu é exatamente o que vai pro browser.
    assert.deepEqual(calls.startInput, { challenge: 'chal-1' });
  });

  test('sends the CSRF header only when a token is provided', async ({ assert }) => {
    const withToken = stubDeps();
    await authenticatePasskey({ optionsUrl: '/opts', csrfToken: 'tok-9' }, withToken.deps);
    const headers = withToken.calls.fetchInit?.headers as Record<string, string>;
    assert.equal(headers['x-csrf-token'], 'tok-9');

    const without = stubDeps();
    await authenticatePasskey({ optionsUrl: '/opts' }, without.deps);
    const headers2 = without.calls.fetchInit?.headers as Record<string, string>;
    assert.isUndefined(headers2['x-csrf-token']);
  });

  test('throws when the options request is not ok (no ceremony)', async ({ assert }) => {
    let started = false;
    const deps: PasskeyCeremonyDeps = {
      fetch: (async () =>
        ({
          ok: false,
          status: 403,
          json: async () => ({}),
        }) as unknown as Response) as unknown as typeof globalThis.fetch,
      loadStartAuthentication: async () => {
        started = true;
        return (async () => ({})) as StartAuthenticationFn;
      },
    };
    await assert.rejects(() => authenticatePasskey({ optionsUrl: '/opts' }, deps));
    // Falha no options não deve nem tentar a cerimônia do browser.
    assert.isFalse(started);
  });
});

test.group('submitPasskeyVerification (tier 3)', () => {
  test('SSR-safe: no-op without document', ({ assert }) => {
    assert.equal(typeof document, 'undefined');
    assert.doesNotThrow(() =>
      submitPasskeyVerification({
        verifyUrl: '/verify',
        assertion: '{}',
        csrfToken: 't',
      }),
    );
  });
});

test.group('usePasskeyLogin / PasskeyButton — exports e types', () => {
  test('loadStartAuthentication is exported as a function', ({ assert }) => {
    assert.isFunction(loadStartAuthentication);
  });

  test('usePasskeyLogin is exported as a function', ({ assert }) => {
    assert.isFunction(usePasskeyLogin);
  });

  test('UsePasskeyLoginOptions shape is correct', ({ assert }) => {
    const opts: UsePasskeyLoginOptions = {
      optionsUrl: '/auth/interaction/uid/passkey/options',
      verifyUrl: '/auth/interaction/uid/passkey/verify',
      csrfToken: 'abc',
      onSuccess: (_assertion: string) => {},
    };
    assert.equal(opts.optionsUrl, '/auth/interaction/uid/passkey/options');
    assert.equal(opts.verifyUrl, '/auth/interaction/uid/passkey/verify');
    assert.equal(opts.csrfToken, 'abc');
    assert.isFunction(opts.onSuccess);
  });

  test('PasskeyButton is exported as a function component', ({ assert }) => {
    assert.isFunction(PasskeyButton);
  });
});

test.group('loadStartAuthentication — sem CDN, falha alto', () => {
  /**
   * Simula o consumidor que não instalou o peer opcional: tem que estourar com a
   * instrução de instalação, e não degradar em silêncio para um CDN. O import é
   * injetado porque o `auto-install-peers` do pnpm instala peers opcionais no
   * workspace — "não está instalado" não é um estado reproduzível.
   */
  test('throws with install instructions when the peer is missing', async ({ assert }) => {
    const missing = async () => {
      const err = new Error("Cannot find package '@simplewebauthn/browser'");
      (err as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    };

    let error: Error | undefined;
    try {
      await loadStartAuthentication(missing);
    } catch (err) {
      error = err as Error;
    }

    assert.instanceOf(error, Error);
    assert.include(error!.message, '@simplewebauthn/browser');
    assert.include(error!.message, 'npm i @simplewebauthn/browser@^13');
    // A causa original (ERR_MODULE_NOT_FOUND) fica anexada para debug.
    assert.exists(error!.cause);
  });

  /** O caminho feliz continua devolvendo a função do módulo, sem embrulho. */
  test('returns startAuthentication from the resolved module', async ({ assert }) => {
    const startAuthentication: StartAuthenticationFn = async () => ({});
    // O ponto de injeção é o import do MÓDULO inteiro do
    // `@simplewebauthn/browser` (o mesmo que `loadStartRegistration` usa), então
    // o fake precisa das duas cerimônias. `loadStartAuthentication` só lê
    // `startAuthentication` — este stub existe para o fake não mentir sobre o
    // módulo, não porque o código sob teste o alcance.
    const startRegistration: StartRegistrationFn = async () => ({});
    const resolved = await loadStartAuthentication(async () => ({
      startAuthentication,
      startRegistration,
    }));

    assert.strictEqual(resolved, startAuthentication);
  });

  /**
   * Barato e específico: qualquer volta do fallback de CDN quebra aqui, mesmo
   * que o resto dos testes continue verde (eles injetam o loader).
   */
  test('the ceremony source has no public CDN reference', async ({ assert }) => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/passkey/authenticate.ts', import.meta.url),
      'utf-8',
    );

    for (const line of source.split('\n')) {
      // Ignora as linhas de comentário que EXPLICAM por que não há CDN.
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//')) continue;
      assert.notMatch(
        code,
        /\/\/cdn\.|jsdelivr|unpkg\.com|cdnjs\.|esm\.sh/i,
        `linha com CDN público no caminho de autenticação: ${line}`,
      );
    }
  });
});
