import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { Edge } from 'edge.js';
import { DEFAULT_MESSAGES, PT_BR_MESSAGES, translate } from '../../src/host/i18n.js';

const dir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));

function makeEdge() {
  const edge = new Edge();
  edge.mount('authkit', dir);
  edge.global('t', (key: string, params?: Record<string, string | number>) =>
    translate({ ...DEFAULT_MESSAGES }, key, params),
  );
  return edge;
}

const request = {
  userCode: 'WDJB-MJHT',
  agentName: 'Example PA',
  agentOrigin: 'pa.example.com',
  scopes: [
    { id: 'orders:read', description: 'Look up your orders' },
    { id: 'orders:cancel', description: 'Cancel an order' },
  ],
};

test.group('views de personal agents', () => {
  test('consent: um checkbox marcado por scope, código e os dois botões', async ({ assert }) => {
    const html = await makeEdge().render('authkit::agents/consent', {
      csrfToken: 'csrf',
      action: '/agents/consent',
      request,
      account: { email: 'jane@example.com' },
      error: null,
    });
    assert.include(html, 'Example PA wants to act on your account');
    assert.include(html, 'value="orders:read" checked');
    assert.include(html, 'value="orders:cancel" checked');
    assert.include(html, 'name="user_code" value="WDJB-MJHT"');
    assert.include(html, 'name="decision" value="allow"');
    assert.include(html, 'name="decision" value="deny"');
    assert.include(html, 'jane@example.com');
    assert.include(html, '/authkit/assets/submit_lock.js');
  });

  test('consent: o nome do agente e as descrições saem escapados', async ({ assert }) => {
    const html = await makeEdge().render('authkit::agents/consent', {
      csrfToken: 'csrf',
      action: '/agents/consent',
      request: {
        ...request,
        agentName: '<script>x</script>',
        scopes: [{ id: 'a', description: '<img src=x onerror=alert(1)>' }],
      },
      account: null,
      error: null,
    });
    assert.notInclude(html, '<script>x</script>');
    assert.notInclude(html, '<img src=x');
  });

  test('consent sem pedido: formulário do código, com erro quando houver', async ({ assert }) => {
    const edge = makeEdge();
    const blank = await edge.render('authkit::agents/consent', {
      csrfToken: 'csrf',
      action: '/agents/consent',
      request: null,
      account: null,
      error: null,
    });
    assert.include(blank, 'name="user_code"');
    assert.include(blank, 'method="GET"');

    const invalid = await edge.render('authkit::agents/consent', {
      csrfToken: 'csrf',
      action: '/agents/consent',
      request: null,
      account: null,
      error: 'agents.consent.invalid_code',
    });
    assert.include(invalid, 'invalid or expired');
    assert.include(invalid, 'name="user_code"');

    const impersonating = await edge.render('authkit::agents/consent', {
      csrfToken: 'csrf',
      action: '/agents/consent',
      request: null,
      account: null,
      error: 'agents.consent.impersonating',
    });
    assert.include(impersonating, 'impersonating');
    assert.notInclude(impersonating, 'name="user_code"');
  });

  test('done: aprovado, negado e expirado', async ({ assert }) => {
    const edge = makeEdge();
    const approved = await edge.render('authkit::agents/done', {
      status: 'approved',
      agentName: 'Example PA',
      scopes: [{ id: 'orders:read', description: 'Look up your orders' }],
    });
    assert.include(approved, 'Example PA can now:');
    assert.include(approved, 'Look up your orders');
    const denied = await edge.render('authkit::agents/done', {
      status: 'denied',
      agentName: 'Example PA',
      scopes: [],
    });
    assert.include(denied, 'Access denied');
    const expired = await edge.render('authkit::agents/done', {
      status: 'expired',
      agentName: null,
      scopes: [],
    });
    assert.include(expired, 'Request expired');
  });

  test('account/apps: seção de assistentes só quando a feature está ligada', async ({ assert }) => {
    const edge = makeEdge();
    const base = { csrfToken: 'csrf', supported: true, revoked: null, apps: [] };
    const off = await edge.render('authkit::account/apps', { ...base, agents: null });
    assert.notInclude(off, 'Personal agents');

    const on = await edge.render('authkit::account/apps', {
      ...base,
      agents: [{ id: 'agrant_1', name: 'Example PA', scopes: [{ id: 'a', description: 'Do A' }] }],
    });
    assert.include(on, 'Personal agents');
    assert.include(on, '/account/apps/agents/agrant_1/revoke');
    assert.include(on, 'Do A');
  });

  test('pt-BR cobre todas as chaves novas', ({ assert }) => {
    const keys = Object.keys(DEFAULT_MESSAGES).filter(
      (k) => k.startsWith('agents.') || k.startsWith('account.apps.agents_'),
    );
    assert.isAbove(keys.length, 10);
    for (const key of keys) assert.isTrue(key in PT_BR_MESSAGES, `falta ${key} no pt-BR`);
  });
});
