/**
 * Testes do "dance" de sudo/passkey por form clássico (Parte B):
 *
 *   - submitClassicForm (tier 3): SSR-safe sem `document`; com `document`
 *     injetado, monta o form (method/action) + hidden inputs e submete.
 *   - runPasskeyAssertion / runPasskeyRegistration (tier 3): cerimônia real com
 *     fetch + start* + document injetados — cobertura comportamental:
 *       · header `x-csrf-token` presente no options;
 *       · campo `return_to` incluído quando fornecido, ausente quando não;
 *       · options 4xx LANÇA e NÃO navega (nenhum form submetido);
 *       · `response` = attestation/assertion serializado.
 *   - usePasskeyAssertion / usePasskeyRegistration (tier 2): exportados, shape das
 *     options, e a máquina de estado `running`/`error` (o comportamento com
 *     useState não roda em Node — simulado como nos demais specs).
 */

import { test } from '@japa/runner';
import {
  type UsePasskeyAssertionOptions,
  usePasskeyAssertion,
} from '../src/hooks/use_passkey_assertion.js';
import {
  type UsePasskeyRegistrationOptions,
  usePasskeyRegistration,
} from '../src/hooks/use_passkey_registration.js';
import {
  type StartAuthenticationFn,
  type StartRegistrationFn,
} from '../src/passkey/authenticate.js';
import { submitClassicForm } from '../src/passkey/classic_form.js';
import { runPasskeyAssertion, runPasskeyRegistration } from '../src/passkey/sudo.js';

// ─── fake DOM ────────────────────────────────────────────────────────────────

interface FakeInput {
  type: string;
  name: string;
  value: string;
}
interface FakeForm {
  method: string;
  action: string;
  hidden: boolean;
  children: FakeInput[];
  submitted: boolean;
  appendChild(el: FakeInput): void;
  submit(): void;
}

/** `document` mínimo que registra o form criado (e se `.submit()` foi chamado). */
function fakeDocument() {
  const forms: FakeForm[] = [];
  let appendedForm: FakeForm | null = null;
  const doc = {
    createElement(tag: string) {
      if (tag === 'form') {
        const form: FakeForm = {
          method: '',
          action: '',
          hidden: false,
          children: [],
          submitted: false,
          appendChild(el: FakeInput) {
            this.children.push(el);
          },
          submit() {
            this.submitted = true;
          },
        };
        forms.push(form);
        return form as unknown as HTMLFormElement;
      }
      return { type: '', name: '', value: '' } as unknown as HTMLInputElement;
    },
    body: {
      appendChild(el: unknown) {
        appendedForm = el as FakeForm;
      },
    },
  };
  return {
    document: doc as unknown as Document,
    forms,
    get appended() {
      return appendedForm;
    },
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// ─── submitClassicForm ───────────────────────────────────────────────────────

test.group('submitClassicForm (tier 3)', () => {
  test('SSR-safe: no-op without document', ({ assert }) => {
    assert.equal(typeof document, 'undefined');
    assert.doesNotThrow(() => submitClassicForm({ action: '/x', fields: { a: '1' } }));
  });

  test('builds a form with method/action and one hidden input per field, then submits', ({
    assert,
  }) => {
    const dom = fakeDocument();
    submitClassicForm(
      {
        action: '/account/confirm/passkey',
        fields: { response: '{}', _csrf: 't', return_to: '/x' },
      },
      { document: dom.document },
    );
    assert.lengthOf(dom.forms, 1);
    const form = dom.forms[0]!;
    assert.equal(form.method, 'POST');
    assert.equal(form.action, '/account/confirm/passkey');
    assert.isTrue(form.hidden);
    assert.isTrue(form.submitted);
    assert.strictEqual(dom.appended, form);
    // Um hidden por campo, na ordem de inserção.
    assert.deepEqual(
      form.children.map((c) => [c.name, c.value, c.type]),
      [
        ['response', '{}', 'hidden'],
        ['_csrf', 't', 'hidden'],
        ['return_to', '/x', 'hidden'],
      ],
    );
  });

  test('method override is honored', ({ assert }) => {
    const dom = fakeDocument();
    submitClassicForm({ action: '/x', fields: {}, method: 'GET' }, { document: dom.document });
    assert.equal(dom.forms[0]!.method, 'GET');
  });
});

// ─── runPasskeyAssertion ─────────────────────────────────────────────────────

/** Deps de cerimônia (assertion) que capturam o fetch e devolvem uma assertion fixa. */
function assertionDeps(dom: ReturnType<typeof fakeDocument>) {
  const calls: { fetchUrl?: string; fetchInit?: RequestInit } = {};
  const startAuthentication: StartAuthenticationFn = async () => ({ id: 'assert-1' });
  return {
    calls,
    deps: {
      fetch: (async (url: string, init?: RequestInit) => {
        calls.fetchUrl = url;
        calls.fetchInit = init;
        return okResponse({ challenge: 'c' });
      }) as unknown as typeof globalThis.fetch,
      loadStartAuthentication: async () => startAuthentication,
      document: dom.document,
    },
  };
}

test.group('runPasskeyAssertion (tier 3 — dance de sudo)', () => {
  test('POSTs options with x-csrf-token, then submits response via classic form', async ({
    assert,
  }) => {
    const dom = fakeDocument();
    const { deps, calls } = assertionDeps(dom);
    await runPasskeyAssertion(
      {
        optionsUrl: '/account/confirm/passkey/options',
        actionUrl: '/account/confirm/passkey',
        csrfToken: 'tok-9',
        returnTo: '/account/security',
      },
      deps,
    );
    // options POST com header CSRF.
    assert.equal(calls.fetchUrl, '/account/confirm/passkey/options');
    assert.equal(calls.fetchInit?.method, 'POST');
    assert.equal(
      (calls.fetchInit?.headers as Record<string, string> | undefined)?.['x-csrf-token'],
      'tok-9',
    );
    // Form submetido no actionUrl, com response + _csrf + return_to.
    const form = dom.forms[0]!;
    assert.equal(form.action, '/account/confirm/passkey');
    assert.isTrue(form.submitted);
    const byName = Object.fromEntries(form.children.map((c) => [c.name, c.value]));
    assert.equal(byName.response, JSON.stringify({ id: 'assert-1' }));
    assert.equal(byName._csrf, 'tok-9');
    assert.equal(byName.return_to, '/account/security');
  });

  test('return_to is included only when provided', async ({ assert }) => {
    const dom = fakeDocument();
    const { deps } = assertionDeps(dom);
    await runPasskeyAssertion({ optionsUrl: '/o', actionUrl: '/a', csrfToken: 't' }, deps);
    const names = dom.forms[0]!.children.map((c) => c.name);
    assert.notInclude(names, 'return_to');
    assert.include(names, '_csrf');
    assert.include(names, 'response');
  });

  test('x-csrf-token header is absent when no token given', async ({ assert }) => {
    const dom = fakeDocument();
    const { deps, calls } = assertionDeps(dom);
    await runPasskeyAssertion({ optionsUrl: '/o', actionUrl: '/a' }, deps);
    const headers = calls.fetchInit?.headers as Record<string, string>;
    assert.isUndefined(headers['x-csrf-token']);
    // Sem csrf → sem campo _csrf no form.
    assert.notInclude(
      dom.forms[0]!.children.map((c) => c.name),
      '_csrf',
    );
  });

  test('options failure throws and does NOT navigate (no form submitted)', async ({ assert }) => {
    const dom = fakeDocument();
    let started = false;
    const deps = {
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
      document: dom.document,
    };
    await assert.rejects(() =>
      runPasskeyAssertion({ optionsUrl: '/o', actionUrl: '/a', csrfToken: 't' }, deps),
    );
    assert.isFalse(started, 'cerimônia do browser nem começa');
    assert.lengthOf(dom.forms, 0, 'nenhum form criado → nenhuma navegação');
  });
});

// ─── runPasskeyRegistration ──────────────────────────────────────────────────

test.group('runPasskeyRegistration (tier 3 — dance de registro)', () => {
  test('uses startRegistration and submits the attestation via classic form', async ({
    assert,
  }) => {
    const dom = fakeDocument();
    let startedRegistration = false;
    const startRegistration: StartRegistrationFn = async () => {
      startedRegistration = true;
      return { id: 'reg-1' };
    };
    const calls: { fetchUrl?: string; fetchInit?: RequestInit } = {};
    const deps = {
      fetch: (async (url: string, init?: RequestInit) => {
        calls.fetchUrl = url;
        calls.fetchInit = init;
        return okResponse({ challenge: 'c' });
      }) as unknown as typeof globalThis.fetch,
      loadStartRegistration: async () => startRegistration,
      document: dom.document,
    };
    await runPasskeyRegistration(
      {
        optionsUrl: '/account/mfa/passkeys/options',
        actionUrl: '/account/mfa/passkeys/verify',
        csrfToken: 'tok',
      },
      deps,
    );
    assert.isTrue(startedRegistration);
    assert.equal(calls.fetchUrl, '/account/mfa/passkeys/options');
    assert.equal(
      (calls.fetchInit?.headers as Record<string, string> | undefined)?.['x-csrf-token'],
      'tok',
    );
    const form = dom.forms[0]!;
    assert.equal(form.action, '/account/mfa/passkeys/verify');
    assert.isTrue(form.submitted);
    const byName = Object.fromEntries(form.children.map((c) => [c.name, c.value]));
    assert.equal(byName.response, JSON.stringify({ id: 'reg-1' }));
    assert.equal(byName._csrf, 'tok');
  });

  test('options failure throws and does NOT navigate', async ({ assert }) => {
    const dom = fakeDocument();
    const deps = {
      fetch: (async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({}),
        }) as unknown as Response) as unknown as typeof globalThis.fetch,
      loadStartRegistration: async () => (async () => ({})) as StartRegistrationFn,
      document: dom.document,
    };
    await assert.rejects(() => runPasskeyRegistration({ optionsUrl: '/o', actionUrl: '/a' }, deps));
    assert.lengthOf(dom.forms, 0);
  });
});

// ─── hooks: exports, shape e máquina de estado ───────────────────────────────

test.group('usePasskeyAssertion / usePasskeyRegistration — exports e types', () => {
  test('both hooks are exported as functions', ({ assert }) => {
    assert.isFunction(usePasskeyAssertion);
    assert.isFunction(usePasskeyRegistration);
  });

  test('UsePasskeyAssertionOptions shape is correct', ({ assert }) => {
    const opts: UsePasskeyAssertionOptions = {
      optionsUrl: '/account/confirm/passkey/options',
      actionUrl: '/account/confirm/passkey',
      csrfToken: 'abc',
      returnTo: '/account/security',
    };
    assert.equal(opts.actionUrl, '/account/confirm/passkey');
    assert.equal(opts.returnTo, '/account/security');
  });

  test('UsePasskeyRegistrationOptions shape is correct (returnTo optional)', ({ assert }) => {
    const opts: UsePasskeyRegistrationOptions = {
      optionsUrl: '/account/mfa/passkeys/options',
      actionUrl: '/account/mfa/passkeys/verify',
      csrfToken: 'abc',
    };
    assert.isUndefined(opts.returnTo);
    assert.equal(opts.actionUrl, '/account/mfa/passkeys/verify');
  });

  /**
   * A lógica de `running`/`error` do hook (não roda o useState em Node): simulada
   * unitariamente, igual ao padrão do passkey_autofill.spec. Sucesso mantém
   * `running` true (a navegação leva a página); erro reseta e captura o Error.
   */
  test('state machine: success keeps running true; error resets and captures Error', async ({
    assert,
  }) => {
    const simulate = async (flow: () => Promise<void>) => {
      let running = false;
      let error: Error | null = null;
      // corpo do `run` do hook:
      error = null;
      running = true;
      try {
        await flow();
        // sucesso: NÃO reseta running (navegação pendente).
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        running = false;
      }
      return { running, error };
    };

    const success = await simulate(async () => {});
    assert.isTrue(success.running);
    assert.isNull(success.error);

    const failure = await simulate(async () => {
      throw new Error('passkey options request failed: 403');
    });
    assert.isFalse(failure.running);
    assert.instanceOf(failure.error, Error);
    assert.include(failure.error!.message, '403');
  });
});
