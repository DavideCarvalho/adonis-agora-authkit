import { test } from '@japa/runner';
import { resolvePoppyConfig } from '../src/config.js';
import { PoppyError } from '../src/errors.js';
import {
  normalizeApproval,
  type PoppyOperationResult,
  parseApprovalHeader,
  poppyOperationToolResult,
} from '../src/operations.js';
import { DEVICE_CODE_GRANT, PoppyService, type PoppyVerifyResult } from '../src/service.js';
import { parseSfDictionary } from '../src/structured_fields.js';
import { poppyUserStep, poppyUserStepAttrs } from '../src/web_session.js';
import {
  ACCOUNT_ID,
  CLIENT_ID,
  delegatedKey,
  type Env,
  MCP_URL,
  ORDERS_API,
  OTHER_ACCOUNT_ID,
  POPPY_ISSUER,
  pkce,
  REDIRECT_URI,
  type RequestOptions,
  setupPoppy,
} from './poppy_helpers.js';

async function rejects(fn: () => Promise<unknown>): Promise<PoppyError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PoppyError) return error;
    throw error;
  }
  throw new Error('expected a PoppyError');
}

function failure(result: PoppyVerifyResult) {
  if (result.ok) throw new Error('expected a failure');
  return result;
}

async function principal(env: Env, opts: RequestOptions = {}) {
  const result = await env.poppy.verifyAccess(await env.request(opts));
  if (!result.ok) throw new Error(`${result.error}: ${result.description}`);
  return result.principal;
}

function fail(result: PoppyOperationResult) {
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

const OPS = '"operations";v="3"';

test.group('poppy optionals — consentimento', () => {
  test('a tela marca os scopes que a conta já concedeu ao agente, e lista todos', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    await env.signIn({ scope: 'orders:read' });
    const { challenge } = pkce();
    const start = await env.poppy.startAuthorization(
      {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'orders:read orders:write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      ACCOUNT_ID,
    );
    if (start.kind !== 'consent') throw new Error(start.kind);
    assert.deepEqual(
      start.request.scopes.map((s) => [s.id, s.granted === true]),
      [
        ['orders:read', true],
        ['orders:write', false],
      ],
    );
    // Outra conta não tem nada concedido.
    const other = await env.poppy.startAuthorization(
      {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'orders:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      OTHER_ACCOUNT_ID,
    );
    if (other.kind !== 'consent') throw new Error(other.kind);
    assert.isUndefined(other.request.scopes[0].granted);

    // Device: a tela marca quando conhece a conta.
    const device = (await env.poppy.deviceAuthorization(
      await env.form({ scope: 'orders:read addresses' }),
    )) as any;
    const seen = await env.poppy.pendingDevice(device.user_code, ACCOUNT_ID);
    assert.deepEqual(
      seen!.scopes.map((s) => [s.id, s.granted === true]),
      [
        ['orders:read', true],
        ['addresses', false],
      ],
    );
    const anonymous = await env.poppy.pendingDevice(device.user_code);
    assert.isUndefined(anonymous!.scopes[0].granted);

    // Um grant revogado não conta.
    for (const g of await env.poppy.listGrants(ACCOUNT_ID)) await env.poppy.revokeGrant(g.id);
    const after = await env.poppy.pendingDevice(device.user_code, ACCOUNT_ID);
    assert.isUndefined(after!.scopes[0].granted);
    await env.close();
  });
});

test.group('poppy optionals — sign-in limitado a resources', () => {
  async function deviceSignIn(env: Env, resource: string | string[] | undefined, extra = {}) {
    const device = (await env.poppy.deviceAuthorization(
      await env.form({ scope: 'orders:read', ...(resource ? { resource } : {}) }),
    )) as any;
    await env.poppy.decideDevice({
      userCode: device.user_code,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    return env.poppy.token(
      await env.form({ grant_type: DEVICE_CODE_GRANT, device_code: device.device_code, ...extra }),
      undefined,
    );
  }

  test('limitado: só os resources nomeados; o default só se nomeou o domínio', async ({
    assert,
  }) => {
    const env = await setupPoppy({ signIn: { limitToResource: true } });
    // Nomeou só o MCP: o token que completa o sign-in precisa ser dele.
    const device = (await env.poppy.deviceAuthorization(
      await env.form({ scope: 'orders:read', resource: MCP_URL }),
    )) as any;
    await env.poppy.decideDevice({
      userCode: device.user_code,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    const poll = async (extra: Record<string, unknown>) =>
      env.poppy.token(
        await env.form({
          grant_type: DEVICE_CODE_GRANT,
          device_code: device.device_code,
          ...extra,
        }),
        undefined,
      );
    assert.equal((await rejects(() => poll({}))).code, 'invalid_target');
    // O pedido errado não gastou o device_code.
    const mcp = await poll({ resource: MCP_URL });
    assert.equal(mcp.token_type, 'Bearer');
    const refreshDefault = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: 'refresh_token', refresh_token: mcp.refresh_token }),
        undefined,
      ),
    );
    assert.equal(refreshDefault.code, 'invalid_target');
    const refreshMcp = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: mcp.refresh_token,
        resource: MCP_URL,
      }),
      undefined,
    );
    assert.equal(refreshMcp.token_type, 'Bearer');

    // Nomeou o domínio e o MCP: os dois saem.
    const both = await deviceSignIn(env, ['https://shop.example', MCP_URL]);
    assert.isString(both.access_token);
    const fromBoth = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: both.refresh_token,
        resource: MCP_URL,
      }),
      undefined,
    );
    assert.isString(fromBoth.access_token);

    // Sem resource no começo: cobre tudo.
    const all = await deviceSignIn(env, undefined);
    const anyMcp = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: all.refresh_token,
        resource: MCP_URL,
      }),
      undefined,
    );
    assert.isString(anyMcp.access_token);

    // Um resource que o app não serve: invalid_target já no começo.
    const unknown = await rejects(async () =>
      env.poppy.deviceAuthorization(
        await env.form({ scope: 'orders:read', resource: 'https://evil.example/api' }),
      ),
    );
    assert.equal(unknown.code, 'invalid_target');
    await env.close();
  });

  test('Direct e PAR levam o limite; desligado (default), o resource do começo é ignorado', async ({
    assert,
  }) => {
    const env = await setupPoppy({ signIn: { limitToResource: true } });
    const { verifier, challenge } = pkce();
    const pushed = await env.poppy.pushAuthorization(
      await env.form({
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: 'orders:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: MCP_URL,
      }),
      undefined,
    );
    const start = await env.poppy.startAuthorization(
      { client_id: CLIENT_ID, request_uri: pushed.request_uri },
      ACCOUNT_ID,
    );
    if (start.kind !== 'consent') throw new Error(start.kind);
    const decided = await env.poppy.decideAuthorization({
      requestId: start.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    const code = new URL(decided!.url).searchParams.get('code');
    const exchange = async (extra: Record<string, unknown>) =>
      env.poppy.token(
        await env.form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          ...extra,
        }),
        undefined,
      );
    assert.equal((await rejects(() => exchange({}))).code, 'invalid_target');
    const ok = await exchange({ resource: MCP_URL });
    assert.equal(ok.token_type, 'Bearer');
    await env.close();

    const open = await setupPoppy();
    const device = (await open.poppy.deviceAuthorization(
      await open.form({ scope: 'orders:read', resource: MCP_URL }),
    )) as any;
    await open.poppy.decideDevice({
      userCode: device.user_code,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    const tokens = await open.poppy.token(
      await open.form({ grant_type: DEVICE_CODE_GRANT, device_code: device.device_code }),
      undefined,
    );
    assert.isString(tokens.access_token);
    await open.close();
  });
});

test.group('poppy optionals — chave delegada de um usuário só', () => {
  test('a chave que já assinou por outro User ID é recusada; o mesmo usuário segue', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const key = await delegatedKey();
    assert.isTrue(
      (await env.poppy.verifyAccess(await env.request({ delegatedKey: key, sub: 'usr_a' }))).ok,
    );
    assert.isTrue(
      (
        await env.poppy.verifyAccess(
          await env.request({ delegatedKey: key, sub: 'usr_a', sid: 'other_sid' }),
        )
      ).ok,
    );
    const f = failure(
      await env.poppy.verifyAccess(await env.request({ delegatedKey: key, sub: 'usr_b' })),
    );
    assert.equal(f.status, 400);
    assert.equal(f.error, 'invalid_session');
    // Uma chave nova para o outro usuário serve.
    assert.isTrue((await env.poppy.verifyAccess(await env.request({ sub: 'usr_b' }))).ok);
    // Depois que a delegação vence, a chave pode ser de outro (uma delegação nova).
    const later = Date.now() + 2 * 3600_000;
    env.setNow(later);
    const fresh = await env.poppy.verifyAccess(
      await env.request({ delegatedKey: key, sub: 'usr_b' }),
    );
    assert.isTrue(fresh.ok);
    env.setNow(null);
    await env.close();
  });

  test('sessionJwt.oneUserPerKey: false aceita a mesma chave para vários usuários', async ({
    assert,
  }) => {
    const env = await setupPoppy({ sessionJwt: { oneUserPerKey: false } });
    const key = await delegatedKey();
    assert.isTrue(
      (await env.poppy.verifyAccess(await env.request({ delegatedKey: key, sub: 'usr_a' }))).ok,
    );
    assert.isTrue(
      (await env.poppy.verifyAccess(await env.request({ delegatedKey: key, sub: 'usr_b' }))).ok,
    );
    await env.close();
  });
});

test.group('poppy optionals — várias versões', () => {
  const deprecatedAt = new Date('2026-12-01T00:00:00Z');
  const sunset = new Date('2027-03-01T00:00:00Z');

  test('supported_versions no mesmo host; documento por versão; Poppy-Version escolhe', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      versions: {
        '0.9': {
          document: (doc) => ({ ...doc, supported_versions: { x: 'y' }, legacy: true }),
          deprecated: { at: deprecatedAt, sunset, link: 'https://shop.example/poppy-0.9' },
        },
        '1.1': {},
      },
      preferredVersion: '1.0',
    });
    const doc = env.poppy.discoveryDocument('shop.example')!;
    assert.equal(doc.protocol_version, '1.0');
    assert.deepEqual(doc.supported_versions, {
      '1.1': 'https://shop.example/poppy/versions/1.1.json',
      '0.9': 'https://shop.example/poppy/versions/0.9.json',
    });
    // No alias, o documento aponta o próprio host.
    const alias = env.poppy.discoveryDocument('shop.example.co.uk')!;
    assert.equal(
      (alias.supported_versions as any)['0.9'],
      'https://shop.example.co.uk/poppy/versions/0.9.json',
    );
    const old = env.poppy.versionDocument('shop.example', '0.9')!;
    assert.equal(old.protocol_version, '0.9');
    assert.isTrue(old.legacy as boolean);
    assert.notProperty(old, 'supported_versions');
    assert.deepEqual(old.organization, doc.organization);
    assert.deepEqual((old.auth as any).issuer, (doc.auth as any).issuer);
    assert.isNull(env.poppy.versionDocument('shop.example', '0.8'));
    assert.isNull(env.poppy.versionDocument('evil.example', '0.9'));
    assert.deepEqual(env.poppy.versionHeaders('0.9'), {
      Deprecation: `@${Math.floor(deprecatedAt.getTime() / 1000)}`,
      Sunset: sunset.toUTCString(),
      Link: '<https://shop.example/poppy-0.9>; rel="deprecation"',
    });
    assert.deepEqual(env.poppy.versionHeaders('1.0'), {});

    const v09 = await env.poppy.verifyAccess(await env.request({ version: '0.9', sid: 's09' }));
    assert.isTrue(v09.ok);
    if (v09.ok) {
      assert.equal(v09.principal.documentVersion, '0.9');
      assert.equal(v09.headers.Sunset, sunset.toUTCString());
    }
    const v12 = await env.poppy.verifyAccess(await env.request({ version: '1.2', sid: 's12' }));
    assert.isTrue(v12.ok && v12.principal.documentVersion === '1.1');
    const v10 = await env.poppy.verifyAccess(await env.request({ version: '1.0', sid: 's10' }));
    assert.isTrue(v10.ok && v10.principal.documentVersion === '1.0' && !v10.headers.Deprecation);
    const v08 = failure(await env.poppy.verifyAccess(await env.request({ version: '0.8' })));
    assert.equal(v08.error, 'version_unsupported');
    // Um erro numa versão em retirada também leva os headers.
    const scoped = failure(
      await env.poppy.verifyAccess(await env.request({ version: '0.9', sid: 's09' }), {
        signedIn: true,
      }),
    );
    assert.equal(scoped.status, 401);
    assert.equal(scoped.headers.Deprecation, `@${Math.floor(deprecatedAt.getTime() / 1000)}`);
    await env.close();
  });

  test('preferredVersion: a mais nova por default; validações', async ({ assert }) => {
    const env = await setupPoppy({ versions: { '1.1': {} } });
    const doc = env.poppy.discoveryDocument('shop.example')!;
    assert.equal(doc.protocol_version, '1.1');
    assert.deepEqual(doc.supported_versions, {
      '1.0': 'https://shop.example/poppy/versions/1.0.json',
    });
    assert.equal(env.poppy.versionDocument('shop.example', '1.0')!.protocol_version, '1.0');
    await env.close();

    const base = { organization: { name: 'S', domain: 's.example' }, scopes: { a: 'A' } };
    assert.throws(() => resolvePoppyConfig({ ...base, versions: { '1': {} } }, undefined), /major/);
    assert.throws(
      () => resolvePoppyConfig({ ...base, preferredVersion: '2.0' }, undefined),
      /preferredVersion/,
    );
    assert.throws(
      () => resolvePoppyConfig({ ...base, versions: { '1.0': { document: (d) => d } } }, undefined),
      /1\.0/,
    );
    assert.throws(
      () =>
        resolvePoppyConfig(
          { ...base, versions: { '0.9': { deprecated: { at: 'x' as any } } } },
          undefined,
        ),
      /deprecated/,
    );
  });

  test('uma Session mantém o Poppy-Version com que começou (session_ended)', async ({ assert }) => {
    const env = await setupPoppy();
    assert.isTrue((await env.poppy.verifyAccess(await env.request({ sid: 'pin' }))).ok);
    const changed = failure(
      await env.poppy.verifyAccess(await env.request({ sid: 'pin', version: '1.1' })),
    );
    assert.equal(changed.status, 400);
    assert.equal(changed.error, 'session_ended');
    assert.equal(changed.body!.error, 'session_ended');
    assert.isTrue((await env.poppy.verifyAccess(await env.request({ sid: 'pin' }))).ok);
    assert.isTrue(
      (await env.poppy.verifyAccess(await env.request({ sid: 'pin2', version: '1.1' }))).ok,
    );
    await env.close();
  });

  test('Session de antes da coluna ganha a versão na primeira request', async ({ assert }) => {
    const env = await setupPoppy();
    assert.isTrue((await env.poppy.verifyAccess(await env.request({ sid: 'legacy' }))).ok);
    await env.db.from('auth_poppy_sessions').update({ protocol_version: null, sid: null });
    assert.isTrue(
      (await env.poppy.verifyAccess(await env.request({ sid: 'legacy', version: '1.2' }))).ok,
    );
    const row = await env.db.from('auth_poppy_sessions').first();
    assert.equal(row.protocol_version, '1.2');
    assert.equal(row.sid, 'legacy');
    assert.equal(
      failure(await env.poppy.verifyAccess(await env.request({ sid: 'legacy' }))).error,
      'session_ended',
    );
    await env.close();
  });
});

test.group('poppy optionals — feedback', () => {
  const FEEDBACK = `${POPPY_ISSUER}/feedback`;

  test('endpoint da lib: no tasks, guarda o relato, 202; o hook pode devolver alternativa', async ({
    assert,
  }) => {
    const reports: unknown[] = [];
    const env = await setupPoppy({
      tasks: {
        feedback: {
          onReport: ({ principal: p, report }) => {
            reports.push({ user: p.userId, ...report });
            if (report.task === 'Pay with a gift card') {
              return { instructions: 'Use the payment API, before the order is placed.' };
            }
            return undefined;
          },
        },
      },
    });
    const tasks = await env.poppy.tasksResponse(
      await env.request({ url: `${POPPY_ISSUER}/tasks` }),
    );
    assert.isTrue(tasks.ok);
    if (tasks.ok) assert.deepEqual(tasks.body.feedback, { endpoint: FEEDBACK });
    const doc = env.poppy.discoveryDocument('shop.example')!;
    assert.deepEqual(doc.tasks, { endpoint: `${POPPY_ISSUER}/tasks` });

    const post = async (body: unknown, opts: RequestOptions = {}) =>
      env.poppy.feedback(await env.request({ method: 'POST', url: FEEDBACK, ...opts }), body);
    const accepted = await post({ task: 'Return a jacket', description: 'No return API.' });
    assert.deepInclude(accepted, { ok: true, status: 202, body: null });
    const answered = await post({ task: 'Pay with a gift card', description: 'No field.' });
    assert.deepInclude(answered, {
      ok: true,
      status: 200,
      body: { instructions: 'Use the payment API, before the order is placed.' },
    });
    const long = await post({ task: 'x'.repeat(201), description: 'd' });
    assert.deepInclude(long, { ok: false, status: 400 });
    const missing = await post({ task: 'Return' });
    assert.deepInclude(missing, { ok: false, status: 400 });
    const tooLong = await post({ task: 't', description: 'é'.repeat(2001) });
    assert.deepInclude(tooLong, { ok: false, status: 400 });
    const noSession = await env.poppy.feedback(
      { method: 'POST', url: FEEDBACK, headers: { 'poppy-version': '1.0' } },
      { task: 't', description: 'd' },
    );
    assert.isFalse(noSession.ok);
    if (!noSession.ok && 'error' in noSession) assert.equal(noSession.error, 'invalid_session');

    const stored = await env.poppy.recentFeedback();
    assert.lengthOf(stored, 2);
    assert.deepInclude(stored[1], {
      clientId: CLIENT_ID,
      userId: 'usr_Q7c1vK',
      task: 'Return a jacket',
      description: 'No return API.',
      protocolVersion: '1.0',
    });
    assert.instanceOf(stored[1].createdAt, Date);
    assert.instanceOf(stored[1].updatedAt, Date);
    assert.lengthOf(reports, 2);
    await env.close();
  });

  test('o endpoint do app continua possível; onReport só no da lib', async ({ assert }) => {
    const base = { organization: { name: 'S', domain: 's.example' }, scopes: { a: 'A' } };
    const resolved = resolvePoppyConfig(
      { ...base, tasks: { feedback: { endpoint: 'https://s.example/feedback' } } },
      undefined,
    )!;
    assert.deepEqual(resolved.tasks!.response.feedback, { endpoint: 'https://s.example/feedback' });
    assert.isNull(resolved.tasks!.feedback);
    assert.throws(
      () =>
        resolvePoppyConfig(
          {
            ...base,
            tasks: {
              feedback: { endpoint: 'https://s.example/f', onReport: () => undefined } as any,
            },
          },
          undefined,
        ),
      /onReport/,
    );
    assert.isNotNull(
      resolvePoppyConfig({ ...base, tasks: { feedback: {} } }, undefined)!.tasks!.feedback,
    );
  });
});

test.group('poppy optionals — extensões anunciadas', () => {
  test('operations, browser-control, links e disclosures no poppy.json e nas declarações', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      operations: true,
      browserControl: true,
      links: true,
      disclosures: true,
    });
    const doc = env.poppy.discoveryDocument('shop.example')!;
    assert.deepEqual(doc.extensions, {
      operations: [{ version: '3', endpoint: `${POPPY_ISSUER}/operations` }],
      'browser-control': [{ version: '1' }],
      links: [{ version: '1' }],
      disclosures: [{ version: '1' }],
    });
    const p = await principal(env, {
      extensionsHeader:
        '"operations";v="3", "links";v="1", "disclosures";v="1", "browser-control";v="1"',
    });
    assert.deepEqual(p.extensions, {
      operations: '3',
      links: '1',
      disclosures: '1',
      'browser-control': '1',
    });
    await env.close();

    const noWebsite = await setupPoppy({ operations: { website: false } });
    assert.deepEqual(noWebsite.poppy.discoveryDocument('shop.example')!.extensions, {
      operations: [{ version: '3' }],
    });
    await noWebsite.close();

    const base = { organization: { name: 'S', domain: 's.example' }, scopes: { a: 'A' } };
    assert.throws(
      () =>
        resolvePoppyConfig(
          { ...base, links: true, extensions: { links: [{ version: '1' }] } },
          undefined,
        ),
      /links/,
    );
    assert.throws(
      () => resolvePoppyConfig({ ...base, web: false, browserControl: true }, undefined),
      /browserControl/,
    );
    assert.throws(
      () => resolvePoppyConfig({ ...base, web: false, operations: { website: true } }, undefined),
      /operations\.website/,
    );
    // Sem browser join, operations fica sem endpoint.
    assert.isFalse(
      resolvePoppyConfig({ ...base, web: false, operations: true }, undefined)!.operations!.website,
    );
  });

  test('Browser Control: o atributo data-poppy-user-step', ({ assert }) => {
    assert.equal(poppyUserStep('submission'), 'data-poppy-user-step="submission"');
    assert.deepEqual(poppyUserStepAttrs('interaction'), { 'data-poppy-user-step': 'interaction' });
    assert.throws(() => poppyUserStep('other' as any), /interaction ou submission/);
  });
});

test.group('poppy optionals — Operations: APIs, MCP e conversas', () => {
  const ACTION = { method: 'POST', url: `${ORDERS_API}/ord_7Hk2/exchanges`, item_id: 'itm_4Qa' };
  const TERMS = {
    order_id: 'ord_7Hk2',
    price_difference: { amount: '70.00', currency: 'USD' },
  };

  async function actorFor(env: Env, opts: RequestOptions = {}) {
    return PoppyService.operationActor(await principal(env, { extensionsHeader: OPS, ...opts }));
  }

  test('sem aprovação: 403 approval_required; com ela: executa uma vez; retries repetem', async ({
    assert,
  }) => {
    const env = await setupPoppy({ operations: true });
    const ops = env.poppy.operations!;
    const out = await actorFor(env);
    const asked = fail(
      await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS, summary: 'Swap' }),
    );
    assert.equal(asked.kind, 'approval_required');
    assert.equal(asked.status, 403);
    const op = asked.operation!;
    assert.match(op.operation_id, /^op_/);
    assert.match(op.revision, /^\d+-[A-Za-z0-9_-]+$/);
    assert.deepEqual(op.terms, TERMS);
    assert.equal(op.summary, 'Swap');
    assert.isAbove(Date.parse(op.expires_at), Date.now() + 14 * 60_000);
    assert.deepEqual(asked.body, { error: 'approval_required', operation: op });

    const header = `operation_id="${op.operation_id}", revision="${op.revision}", approver="user", approved_at=1791487260, input_type="tap", reference="apr_01JD8ZK3Q9"`;
    const ok = await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, header);
    assert.isTrue(ok.ok);
    if (ok.ok) {
      assert.deepEqual(ok.approval, {
        operation_id: op.operation_id,
        revision: op.revision,
        approver: 'user',
        approved_at: 1791487260,
        input_type: 'tap',
        reference: 'apr_01JD8ZK3Q9',
      });
    }
    // Em execução: 503 + Retry-After, nunca como falha.
    const busy = fail(
      await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, header),
    );
    assert.equal(busy.kind, 'performing');
    assert.equal(busy.status, 503);
    assert.equal(busy.headers['Retry-After'], '5');

    assert.isTrue(
      await ops.markPerformed(op.operation_id, { status: 201, body: { exchange_id: 'exg_1' } }),
    );
    assert.isFalse(await ops.markPerformed(op.operation_id));
    const replay = fail(
      await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, header),
    );
    assert.equal(replay.kind, 'performed');
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, { exchange_id: 'exg_1' });

    const record = await ops.get(out, op.operation_id);
    assert.equal(record!.status, 'performed');
    assert.equal(record!.approval!.approver, 'user');
    assert.isNull(await ops.get({ clientId: CLIENT_ID, userId: 'usr_other' }, op.operation_id));

    const row = await env.db.from('auth_poppy_operations').where('id', op.operation_id).first();
    assert.equal(row.reference, 'apr_01JD8ZK3Q9');
    assert.equal(row.input_type, 'tap');
    assert.isNotNull(row.created_at);
    assert.isNotNull(row.updated_at);
    await env.close();
  });

  test('check 3: termos, pedido ou revisão diferentes → nova revisão do mesmo operation_id', async ({
    assert,
  }) => {
    const env = await setupPoppy({ operations: true });
    const ops = env.poppy.operations!;
    const out = await actorFor(env);
    const first = fail(await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }))
      .operation!;
    const approve = (rev: string, id = first.operation_id) =>
      `operation_id="${id}", revision="${rev}", approver="agent", approved_at=1791487255`;

    // O preço mudou: revisão nova, nunca a que a aprovação nomeia.
    const newTerms = { ...TERMS, price_difference: { amount: '75.00', currency: 'USD' } };
    const priced = fail(
      await ops.require(
        out,
        { interface: 'api', action: ACTION, terms: newTerms },
        approve(first.revision),
      ),
    ).operation!;
    assert.equal(priced.operation_id, first.operation_id);
    assert.notEqual(priced.revision, first.revision);
    // A revisão antiga foi substituída: não vale mais.
    const stale = fail(
      await ops.require(
        out,
        { interface: 'api', action: ACTION, terms: newTerms },
        approve(first.revision),
      ),
    ).operation!;
    assert.notEqual(stale.revision, first.revision);
    // O pedido mudou (outro item): revisão nova também.
    const other = fail(
      await ops.require(
        out,
        { interface: 'api', action: { ...ACTION, item_id: 'itm_X' }, terms: newTerms },
        approve(stale.revision),
      ),
    ).operation!;
    assert.equal(other.operation_id, first.operation_id);
    // Vencida: revisão nova.
    env.setNow(Date.now() + 3600_000);
    const expired = fail(
      await ops.require(
        out,
        { interface: 'api', action: { ...ACTION, item_id: 'itm_X' }, terms: newTerms },
        approve(other.revision),
      ),
    ).operation!;
    assert.notEqual(expired.revision, other.revision);
    env.setNow(null);
    // Operação desconhecida: uma operação nova.
    const unknown = fail(
      await ops.require(
        out,
        { interface: 'api', action: ACTION, terms: TERMS },
        approve('r1', 'op_nope'),
      ),
    ).operation!;
    assert.notEqual(unknown.operation_id, first.operation_id);
    // A aprovação certa da revisão atual executa (agente, sem input_type).
    const current = fail(await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }))
      .operation!;
    const ok = await ops.require(
      out,
      {
        interface: 'api',
        action: { url: ACTION.url, item_id: 'itm_4Qa', method: 'POST' },
        terms: TERMS,
      },
      `${approve(current.revision, current.operation_id)}, input_type="tap"`,
    );
    assert.isTrue(ok.ok);
    if (ok.ok) assert.notProperty(ok.approval, 'input_type');
    await env.close();
  });

  test('quem pode aprovar: mesmo agente e usuário; conta: challenge deslogado, outra conta não', async ({
    assert,
  }) => {
    const env = await setupPoppy({ operations: true });
    const ops = env.poppy.operations!;
    const signed = await env.signIn({ scope: 'orders:read orders:write' });
    const inAccount = await actorFor(env, { token: signed.access_token });
    const op = fail(
      await ops.require(inAccount, { interface: 'api', action: ACTION, terms: TERMS }),
    ).operation!;
    const header = `operation_id="${op.operation_id}", revision="${op.revision}", approver="user"`;
    // Deslogado (mesmo usuário): challenge da conta.
    const out = await actorFor(env);
    const challenged = fail(
      await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, header),
    );
    assert.equal(challenged.kind, 'challenge');
    assert.equal(challenged.status, 401);
    assert.match(challenged.headers['WWW-Authenticate'], /^Bearer, DPoP algs="ES256"$/);
    // Outro usuário do agente: tratado como sem aprovação (operação nova).
    const stranger = await actorFor(env, { sub: 'usr_other', sid: 'stranger' });
    const fresh = fail(
      await ops.require(stranger, { interface: 'api', action: ACTION, terms: TERMS }, header),
    ).operation!;
    assert.notEqual(fresh.operation_id, op.operation_id);
    // Outra conta do mesmo usuário: também.
    const other = await env.signIn({ scope: 'orders:read', accountId: OTHER_ACCOUNT_ID });
    const otherAccount = await actorFor(env, { token: other.access_token, sid: 'acct2' });
    const again = fail(
      await ops.require(otherAccount, { interface: 'api', action: ACTION, terms: TERMS }, header),
    ).operation!;
    assert.notEqual(again.operation_id, op.operation_id);
    // Uma operação de API não é aprovada numa conversa.
    const viaConversation = fail(
      await ops.require(inAccount, {
        interface: 'conversation',
        action: ACTION,
        terms: TERMS,
        approval: { operation_id: op.operation_id, revision: op.revision, approver: 'user' },
      }),
    ).operation!;
    assert.notEqual(viaConversation.operation_id, op.operation_id);
    // Em outra Session do mesmo usuário e conta, aprova.
    const otherSession = await actorFor(env, { token: signed.access_token, sid: 'later' });
    assert.isTrue(
      (await ops.require(otherSession, { interface: 'api', action: ACTION, terms: TERMS }, header))
        .ok,
    );
    await env.close();
  });

  test('extension_required sem a declaração; Poppy-Approval malformado → invalid_request', async ({
    assert,
  }) => {
    const env = await setupPoppy({ operations: true });
    const ops = env.poppy.operations!;
    const undeclared = PoppyService.operationActor(await principal(env));
    const refused = fail(
      await ops.require(undeclared, { interface: 'api', action: ACTION, terms: TERMS }),
    );
    assert.equal(refused.kind, 'extension_required');
    assert.deepEqual(refused.body, { error: 'extension_required', extension: 'operations' });
    const out = await actorFor(env);
    for (const bad of [
      'operation_id=1',
      'operation_id="a", revision="b"',
      'approver="x"',
      '"bad"',
    ]) {
      const r = fail(
        await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, bad),
      );
      assert.equal(r.kind, 'invalid_request', bad);
      assert.equal(r.status, 400);
    }
    await env.close();
  });

  test('decide recusa: approval_declined sem gravar; release devolve a aprovação', async ({
    assert,
  }) => {
    let refuse = true;
    const env = await setupPoppy({
      operations: {
        decide: ({ approval }) =>
          refuse && approval.approver === 'agent'
            ? {
                reason: 'Only the account holder can do this.',
                alternative: { references: [{ type: 'web', url: 'https://shop.example/x' }] },
              }
            : undefined,
      },
    });
    const ops = env.poppy.operations!;
    const out = await actorFor(env);
    const op = fail(await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }))
      .operation!;
    const agent = `operation_id="${op.operation_id}", revision="${op.revision}", approver="agent"`;
    const declined = fail(
      await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, agent),
    );
    assert.equal(declined.kind, 'approval_declined');
    assert.equal(declined.status, 403);
    assert.deepEqual(declined.body, {
      error: 'approval_declined',
      operation_id: op.operation_id,
      revision: op.revision,
      reason: 'Only the account holder can do this.',
      alternative: { references: [{ type: 'web', url: 'https://shop.example/x' }] },
    });
    assert.deepEqual(declined.declined, {
      operation_id: op.operation_id,
      revision: op.revision,
      reason: 'Only the account holder can do this.',
      alternative: { references: [{ type: 'web', url: 'https://shop.example/x' }] },
    });
    assert.equal((await ops.get(out, op.operation_id))!.status, 'pending');
    assert.isNull((await ops.get(out, op.operation_id))!.approval);

    const user = `operation_id="${op.operation_id}", revision="${op.revision}", approver="user"`;
    assert.isTrue(
      (await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, user)).ok,
    );
    assert.isTrue(await ops.release(op.operation_id));
    assert.isFalse(await ops.release(op.operation_id));
    // A mesma aprovação vale no retry.
    assert.isTrue(
      (await ops.require(out, { interface: 'api', action: ACTION, terms: TERMS }, user)).ok,
    );
    refuse = false;
    await env.close();
  });

  test('conversas e MCP: aprovação como objeto; revisão nova com operationId; tool result', async ({
    assert,
  }) => {
    const env = await setupPoppy({ operations: true });
    const ops = env.poppy.operations!;
    const out = await actorFor(env);
    const conversation = { conversation_id: 'cnv_1' };
    const asked = fail(
      await ops.require(out, {
        interface: 'conversation',
        action: conversation,
        terms: TERMS,
        idPrefix: 'exc_',
      }),
    ).operation!;
    assert.match(asked.operation_id, /^exc_/);
    // O usuário pediu outro tamanho: mesmo operation_id, revisão nova.
    const resized = fail(
      await ops.require(out, {
        interface: 'conversation',
        action: conversation,
        terms: { ...TERMS, size: 'L' },
        operationId: asked.operation_id,
      }),
    ).operation!;
    assert.equal(resized.operation_id, asked.operation_id);
    assert.notEqual(resized.revision, asked.revision);
    const ok = await ops.require(out, {
      interface: 'conversation',
      action: conversation,
      terms: { ...TERMS, size: 'L' },
      approval: {
        operation_id: resized.operation_id,
        revision: resized.revision,
        approver: 'user',
        approved_at: 1791487260,
        input_type: 'voice',
        extra: 'ignored',
      },
    });
    assert.isTrue(ok.ok);

    const tool = { order_id: 'ord_7Hk2' };
    const mcp = fail(
      await ops.require(out, { interface: 'mcp', action: tool, terms: TERMS, summary: 'Swap it' }),
    );
    assert.deepEqual(poppyOperationToolResult(mcp), {
      isError: true,
      content: [{ type: 'text', text: 'Not done yet. This needs approval: Swap it' }],
      structuredContent: { operation: mcp.operation! },
    });
    const malformed = fail(
      await ops.require(out, {
        interface: 'mcp',
        action: tool,
        terms: TERMS,
        approval: { operation_id: 'x' },
      }),
    );
    assert.equal(malformed.kind, 'invalid_request');
    await env.close();
  });
});

test.group('poppy optionals — Operations: site', () => {
  const ACTION = { method: 'POST', path: '/orders/ord_7Hk2/exchange', sku: 'm' };
  const TERMS = { order_id: 'ord_7Hk2', amount: '70.00 USD' };

  async function browser(env: Env, opts: { sid?: string; token?: string } = {}) {
    const p = await principal(env, {
      extensionsHeader: OPS,
      sid: opts.sid ?? 'brw',
      token: opts.token,
    });
    return { ...PoppyService.operationActor(p), sid: opts.sid ?? 'brw' };
  }

  test('403 com Poppy-Operation → endpoint devolve a operação → aprova (204) → o site executa', async ({
    assert,
  }) => {
    const env = await setupPoppy({ operations: true });
    const ops = env.poppy.operations!;
    const actor = await browser(env);
    const waiting = fail(
      await ops.requireWebsite(actor, { interface: 'website', action: ACTION, terms: TERMS }),
    );
    assert.equal(waiting.kind, 'approval_required');
    assert.equal(waiting.status, 403);
    assert.deepEqual(waiting.body, { error: 'approval_required' });
    assert.equal(waiting.headers['Cache-Control'], 'no-store');
    const dict = parseSfDictionary(waiting.headers['Poppy-Operation'])!;
    assert.equal(dict.get('sid'), 'brw');
    const ref = dict.get('ref') as string;
    assert.match(ref, /^[A-Za-z0-9._-]{1,2048}$/);
    assert.include(waiting.html!, 'Continue');

    const endpoint = `${POPPY_ISSUER}/operations`;
    const call = async (body: unknown, approval?: string, opts: RequestOptions = {}) => {
      const req = await env.request({
        method: 'POST',
        url: endpoint,
        extensionsHeader: OPS,
        sid: 'brw',
        ...opts,
      });
      if (approval) req.headers['poppy-approval'] = approval;
      const r = await env.poppy.operationsEndpoint(req, body);
      if (!r.ok) throw new Error(`${r.error}`);
      return r;
    };
    const lookup = await call({ ref });
    assert.equal(lookup.status, 403);
    const op = (lookup.body as any).operation;
    assert.deepEqual(op.terms, TERMS);
    // Em outra Session do mesmo usuário também.
    assert.equal((await call({ ref }, undefined, { sid: 'other' })).status, 403);
    // Outro usuário: invalid_request.
    assert.equal((await call({ ref }, undefined, { sub: 'usr_x', sid: 'x' })).status, 400);
    assert.equal((await call({ ref: 'nope.nope' })).status, 400);
    assert.equal((await call({})).status, 400);
    // Sem a extensão declarada: extension_required.
    const undeclared = await env.poppy.operationsEndpoint(
      await env.request({ method: 'POST', url: endpoint, sid: 'brw' }),
      { ref },
    );
    assert.isTrue(!undeclared.ok && undeclared.status === 403);

    // Uma aprovação da revisão errada devolve a atual.
    const wrong = await call(
      { ref },
      `operation_id="${op.operation_id}", revision="r_old", approver="user"`,
    );
    assert.equal(wrong.status, 403);
    assert.equal((wrong.body as any).operation.revision, op.revision);

    // Antes de aprovar, o site ainda não acha aprovação: outra referência.
    const notYet = fail(
      await ops.requireWebsite(actor, { interface: 'website', action: ACTION, terms: TERMS }),
    );
    assert.equal(notYet.kind, 'approval_required');

    const approval = `operation_id="${op.operation_id}", revision="${op.revision}", approver="user", input_type="tap"`;
    const recorded = await call({ ref }, approval);
    assert.equal(recorded.status, 204);
    assert.deepEqual((await call({ ref })).body, {
      operation_id: op.operation_id,
      status: 'approved',
    });
    // Uma aprovação de operação do site não vale numa API.
    const viaApi = fail(
      await ops.require(actor, { interface: 'api', action: ACTION, terms: TERMS }, approval),
    );
    assert.notEqual(viaApi.operation!.operation_id, op.operation_id);

    // O navegador repete o pedido: a aprovação gravada é usada (uma vez).
    const performed = await ops.requireWebsite(actor, {
      interface: 'website',
      action: ACTION,
      terms: TERMS,
    });
    assert.isTrue(performed.ok);
    if (performed.ok) assert.equal(performed.operationId, op.operation_id);
    assert.deepEqual((await call({ ref })).body, {
      operation_id: op.operation_id,
      status: 'performing',
    });
    await ops.markPerformed(op.operation_id);
    assert.deepEqual((await call({ ref })).body, {
      operation_id: op.operation_id,
      status: 'performed',
    });
    // Outra vez: uma operação nova (a outra referência de antes, ainda sem aprovação, não conta).
    const next = fail(
      await ops.requireWebsite(actor, { interface: 'website', action: ACTION, terms: TERMS }),
    );
    assert.equal(next.kind, 'approval_required');
    await env.close();
  });

  test('site: recusa no endpoint não grava; extensão não declarada → unsupported', async ({
    assert,
  }) => {
    const env = await setupPoppy({ operations: { decide: () => ({ reason: 'No.' }) } });
    const ops = env.poppy.operations!;
    const actor = await browser(env);
    const waiting = fail(
      await ops.requireWebsite(actor, { interface: 'website', action: ACTION, terms: TERMS }),
    );
    const ref = parseSfDictionary(waiting.headers['Poppy-Operation'])!.get('ref') as string;
    const req = await env.request({
      method: 'POST',
      url: `${POPPY_ISSUER}/operations`,
      extensionsHeader: OPS,
      sid: 'brw',
    });
    const look = await env.poppy.operationsEndpoint(req, { ref });
    const op = (look.ok && (look.body as any).operation) as any;
    const req2 = await env.request({
      method: 'POST',
      url: `${POPPY_ISSUER}/operations`,
      extensionsHeader: OPS,
      sid: 'brw',
    });
    req2.headers['poppy-approval'] =
      `operation_id="${op.operation_id}", revision="${op.revision}", approver="user"`;
    const declined = await env.poppy.operationsEndpoint(req2, { ref });
    assert.isTrue(declined.ok);
    if (declined.ok) {
      assert.equal(declined.status, 403);
      assert.deepInclude(declined.body as any, { error: 'approval_declined', reason: 'No.' });
    }
    const still = fail(
      await ops.requireWebsite(actor, { interface: 'website', action: ACTION, terms: TERMS }),
    );
    assert.equal(still.kind, 'approval_required');

    const none = fail(
      await ops.requireWebsite(
        { ...actor, extensions: {} },
        { interface: 'website', action: ACTION, terms: TERMS },
      ),
    );
    assert.equal(none.kind, 'unsupported');
    await env.close();
  });

  test('operação da conta no site: o endpoint deslogado leva challenge', async ({ assert }) => {
    const env = await setupPoppy({ operations: true });
    const ops = env.poppy.operations!;
    const signed = await env.signIn({ scope: 'orders:read poppy:browser-sign-in' });
    const actor = await browser(env, { token: signed.access_token });
    const waiting = fail(
      await ops.requireWebsite(actor, { interface: 'website', action: ACTION, terms: TERMS }),
    );
    const ref = parseSfDictionary(waiting.headers['Poppy-Operation'])!.get('ref') as string;
    const out = await env.poppy.operationsEndpoint(
      await env.request({
        method: 'POST',
        url: `${POPPY_ISSUER}/operations`,
        extensionsHeader: OPS,
        sid: 'brw',
      }),
      { ref },
    );
    assert.isTrue(out.ok);
    if (out.ok) {
      assert.equal(out.status, 401);
      assert.match(out.headers['WWW-Authenticate'], /^Bearer/);
    }
    const inside = await env.poppy.operationsEndpoint(
      await env.request({
        method: 'POST',
        url: `${POPPY_ISSUER}/operations`,
        extensionsHeader: OPS,
        sid: 'brw',
        token: signed.access_token,
      }),
      { ref },
    );
    assert.isTrue(inside.ok && inside.status === 403);
    await env.close();
  });
});

test.group('poppy optionals — Poppy-Approval e Structured Fields', () => {
  test('parse do Dictionary; aprovação normalizada', ({ assert }) => {
    assert.deepEqual(
      parseApprovalHeader(
        'operation_id="exc_5Rt2", revision="1791487200-k3Jd9Qx2mW8v", approver="user", approved_at=1791487260, input_type="tap", reference="apr_01JD8ZK3Q9", future="x";p=1',
      ),
      {
        operation_id: 'exc_5Rt2',
        revision: '1791487200-k3Jd9Qx2mW8v',
        approver: 'user',
        approved_at: 1791487260,
        input_type: 'tap',
        reference: 'apr_01JD8ZK3Q9',
      },
    );
    assert.isNull(parseApprovalHeader(undefined));
    assert.equal(parseApprovalHeader('operation_id="a" revision="b"'), 'invalid');
    assert.equal(parseApprovalHeader('operation_id="a", revision="b", approver=user'), 'invalid');
    // `reference` fora do formato é descartada, não recusa.
    assert.deepEqual(
      normalizeApproval({
        operation_id: 'a',
        revision: 'b',
        approver: 'agent',
        reference: 'a b',
        input_type: 'tap',
      }),
      { operation_id: 'a', revision: 'b', approver: 'agent' },
    );
    assert.deepEqual(
      [...parseSfDictionary('a=?1, b=-2, c=tok/x, d')!.entries()],
      [
        ['a', true],
        ['b', -2],
        ['c', { token: 'tok/x' }],
        ['d', true],
      ],
    );
    assert.isNull(parseSfDictionary('a=(1 2)'));
  });
});
