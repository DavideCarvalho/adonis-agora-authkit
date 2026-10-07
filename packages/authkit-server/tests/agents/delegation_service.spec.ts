import { test } from '@japa/runner';
import { compactVerify, decodeJwt } from 'jose';
import type { PersonalAgentIdentity } from '../../src/agents/agent_identity.js';
import { resolvePersonalAgentsConfig } from '../../src/agents/config.js';
import {
  AgentOAuthError,
  normalizeUserCode,
  PersonalAgentDelegation,
} from '../../src/agents/delegation_service.js';
import { DelegationStore } from '../../src/agents/delegation_store.js';
import { personalAgentUrls } from '../../src/agents/runtime.js';
import { keystoreSigner } from '../../src/agents/signer.js';
import { generateJwks } from '../../src/keys/jwks_manager.js';
import { toPublicJwks } from '../../src/keys/keystore.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

const INTERFACE_URL = 'https://brand.example/a2a';
const URLS = personalAgentUrls('https://brand.example/oidc', '/agents');
const agent: PersonalAgentIdentity = {
  issuer: 'https://pa.example.com',
  sub: 'pa-user-1',
  name: 'Example PA',
  claims: {},
};

async function setup() {
  const db = createTestDatabase();
  await ensureAuthkitSchema(db);
  const jwks = await generateJwks('ES256');
  const keys = { signingJwks: jwks, publicJwks: toPublicJwks(jwks) };
  let now = new Date('2026-10-06T12:00:00Z');
  const inactive = new Set<string>();
  const cfg = resolvePersonalAgentsConfig({
    audience: 'aud',
    delegation: {
      interfaceUrl: INTERFACE_URL,
      scopes: {
        'orders:read': 'Look up your orders',
        'orders:cancel': 'Cancel an order',
        'refunds:issue': 'Issue refunds',
      },
    },
  })!;
  const delegation = new PersonalAgentDelegation({
    cfg: cfg.delegation!,
    store: new DelegationStore(() => db.connection()),
    signer: keystoreSigner(keys),
    urls: { issuer: URLS.issuer, consent: URLS.consent },
    isAccountActive: async (id) => !inactive.has(id),
    now: () => now,
  });
  return {
    db,
    keys,
    delegation,
    inactive,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

async function oauthError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentOAuthError) return error.code;
    throw error;
  }
  return 'no error';
}

/** Device flow completo até o token, aprovando `approve`. */
async function authorize(
  d: PersonalAgentDelegation,
  advance: (s: number) => void,
  request: string,
  approve: string[],
  accountId = 'acct-1',
) {
  const device = await d.requestDevice(agent, request);
  await d.approve({ userCode: device.user_code, accountId, scopes: approve });
  advance(5);
  return d.exchangeDeviceCode(agent, device.device_code);
}

test.group('PersonalAgentDelegation (PACT §5)', (group) => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  group.each.setup(async () => {
    ctx = await setup();
    return async () => ctx.db.manager.closeAll();
  });

  test('device authorization devolve códigos e o link de consentimento', async ({ assert }) => {
    const res = await ctx.delegation.requestDevice(agent, 'orders:read orders:cancel');
    assert.match(res.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.isTrue(res.device_code.startsWith('dc_'));
    assert.equal(res.verification_uri, 'https://brand.example/agents/consent');
    assert.equal(
      res.verification_uri_complete,
      `https://brand.example/agents/consent?user_code=${res.user_code}`,
    );
    assert.equal(res.interval, 5);
    assert.equal(res.expires_in, 600);

    // Só o hash do device_code fica no banco.
    const row = await ctx.db.connection().from('auth_agent_device_codes').first();
    assert.notEqual(row.device_code_hash, res.device_code);
  });

  test('scope fora da lista é invalid_scope', async ({ assert }) => {
    assert.equal(
      await oauthError(ctx.delegation.requestDevice(agent, 'orders:delete')),
      'invalid_scope',
    );
    assert.equal(await oauthError(ctx.delegation.requestDevice(agent, '')), 'invalid_scope');
  });

  test('polling: pending, slow_down, depois token com o que o usuário aprovou', async ({
    assert,
  }) => {
    const d = ctx.delegation;
    const device = await d.requestDevice(agent, 'orders:read orders:cancel');

    assert.equal(
      await oauthError(d.exchangeDeviceCode(agent, device.device_code)),
      'authorization_pending',
    );
    ctx.advance(1);
    assert.equal(await oauthError(d.exchangeDeviceCode(agent, device.device_code)), 'slow_down');

    const pending = await d.pendingRequest(device.user_code.toLowerCase().replace('-', ''));
    assert.deepEqual(
      pending?.scopes.map((s) => s.id),
      ['orders:read', 'orders:cancel'],
    );

    // Desmarcou `orders:cancel`; tentou aprovar um scope que nem foi pedido.
    const approved = await d.approve({
      userCode: device.user_code,
      accountId: 'acct-1',
      scopes: ['orders:read', 'refunds:issue'],
    });
    assert.deepEqual(approved?.scopes, ['orders:read']);

    ctx.advance(5);
    const token = await d.exchangeDeviceCode(agent, device.device_code);
    assert.equal(token.scope, 'orders:read');
    assert.equal(token.token_type, 'Bearer');

    const claims = decodeJwt(token.access_token);
    assert.deepInclude(claims, {
      iss: URLS.issuer,
      aud: INTERFACE_URL,
      sub: 'acct-1',
      client_id: agent.issuer,
      scope: 'orders:read',
    });
    assert.equal(claims.exp! - claims.iat!, 3600);

    const verified = await d.verify(agent, `Bearer ${token.access_token}`);
    assert.deepEqual(verified, {
      accountId: 'acct-1',
      scopes: ['orders:read'],
      grantId: approved!.grantId,
      clientId: agent.issuer,
    });

    // device_code é de uso único.
    assert.equal(
      await oauthError(d.exchangeDeviceCode(agent, device.device_code)),
      'invalid_grant',
    );
  });

  test('negar → access_denied', async ({ assert }) => {
    const d = ctx.delegation;
    const device = await d.requestDevice(agent, 'orders:read');
    assert.isTrue(await d.deny({ userCode: device.user_code, accountId: 'acct-1' }));
    assert.equal(
      await oauthError(d.exchangeDeviceCode(agent, device.device_code)),
      'access_denied',
    );
    assert.isNull(await d.pendingRequest(device.user_code));
  });

  test('aprovar sem nenhum scope do pedido não aprova', async ({ assert }) => {
    const d = ctx.delegation;
    const device = await d.requestDevice(agent, 'orders:read');
    assert.isNull(await d.approve({ userCode: device.user_code, accountId: 'acct-1', scopes: [] }));
    assert.isNotNull(await d.pendingRequest(device.user_code));
  });

  test('código expirado: expired_token e some da tela', async ({ assert }) => {
    const d = ctx.delegation;
    const device = await d.requestDevice(agent, 'orders:read');
    ctx.advance(601);
    assert.isNull(await d.pendingRequest(device.user_code));
    assert.isNull(
      await d.approve({ userCode: device.user_code, accountId: 'a', scopes: ['orders:read'] }),
    );
    assert.equal(
      await oauthError(d.exchangeDeviceCode(agent, device.device_code)),
      'expired_token',
    );
  });

  test('device_code de outro agente ou outro usuário do agente é desconhecido', async ({
    assert,
  }) => {
    const d = ctx.delegation;
    const device = await d.requestDevice(agent, 'orders:read');
    await d.approve({ userCode: device.user_code, accountId: 'acct-1', scopes: ['orders:read'] });
    const otherAgent = { ...agent, issuer: 'https://evil.example' };
    const otherUser = { ...agent, sub: 'pa-user-2' };
    assert.equal(
      await oauthError(d.exchangeDeviceCode(otherAgent, device.device_code)),
      'invalid_grant',
    );
    assert.equal(
      await oauthError(d.exchangeDeviceCode(otherUser, device.device_code)),
      'invalid_grant',
    );
    // E o legítimo continua conseguindo.
    assert.equal((await d.exchangeDeviceCode(agent, device.device_code)).scope, 'orders:read');
  });

  test('aprovação dupla do mesmo código: só a primeira vale', async ({ assert }) => {
    const d = ctx.delegation;
    const device = await d.requestDevice(agent, 'orders:read');
    const [a, b] = await Promise.all([
      d.approve({ userCode: device.user_code, accountId: 'acct-1', scopes: ['orders:read'] }),
      d.approve({ userCode: device.user_code, accountId: 'acct-2', scopes: ['orders:read'] }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const grants = await ctx.db.connection().from('auth_agent_grants');
    assert.lengthOf(grants, 1);
  });

  test('dois códigos aprovados ao mesmo tempo convergem para UM grant', async ({ assert }) => {
    const d = ctx.delegation;
    const a = await d.requestDevice(agent, 'orders:read');
    const b = await d.requestDevice(agent, 'orders:cancel');
    const [ra, rb] = await Promise.all([
      d.approve({ userCode: a.user_code, accountId: 'acct-1', scopes: ['orders:read'] }),
      d.approve({ userCode: b.user_code, accountId: 'acct-1', scopes: ['orders:cancel'] }),
    ]);
    const grants = await d.listGrants('acct-1');
    assert.lengthOf(grants, 1);
    assert.equal(ra?.grantId, grants[0].id);
    assert.equal(rb?.grantId, grants[0].id);
    assert.sameMembers(
      grants[0].scopes.map((x) => x.id),
      ['orders:read', 'orders:cancel'],
    );
    // E os dois agentes-polling recebem token do sobrevivente.
    ctx.advance(5);
    const ta = await d.exchangeDeviceCode(agent, a.device_code);
    const tb = await d.exchangeDeviceCode(agent, b.device_code);
    assert.equal(decodeJwt(ta.access_token).grant_id, grants[0].id);
    assert.equal(decodeJwt(tb.access_token).grant_id, grants[0].id);
  });

  test('revokeAllGrants corta todas as delegações da conta', async ({ assert }) => {
    const d = ctx.delegation;
    const token = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    await authorize(d, ctx.advance, 'orders:read', ['orders:read'], 'acct-2');
    assert.equal(await d.revokeAllGrants('acct-1'), 1);
    assert.isNull(await d.verify(agent, `Bearer ${token.access_token}`));
    assert.lengthOf(await d.listGrants('acct-2'), 1);
  });

  test('refresh rotativo: o refresh usado morre', async ({ assert }) => {
    const d = ctx.delegation;
    const token = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    const next = await d.refresh(agent, token.refresh_token);
    assert.equal(next.scope, 'orders:read');
    assert.notEqual(next.refresh_token, token.refresh_token);

    // Outro agente com o refresh alheio: recusado SEM queimar o token.
    assert.equal(
      await oauthError(d.refresh({ ...agent, issuer: 'https://evil.example' }, next.refresh_token)),
      'invalid_grant',
    );
    const third = await d.refresh(agent, next.refresh_token);
    assert.equal(third.scope, 'orders:read');
  });

  test('reuso de refresh já gasto revoga o grant inteiro', async ({ assert }) => {
    const d = ctx.delegation;
    const token = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    const next = await d.refresh(agent, token.refresh_token);

    // O token antigo reaparece: vazou. O grant morre, e com ele o refresh novo.
    assert.equal(await oauthError(d.refresh(agent, token.refresh_token)), 'invalid_grant');
    assert.lengthOf(await d.listGrants('acct-1'), 0);
    assert.equal(await oauthError(d.refresh(agent, next.refresh_token)), 'invalid_grant');
    assert.isNull(await d.verify(agent, `Bearer ${next.access_token}`));
  });

  test('conta apagada ou desabilitada corta a delegação na hora', async ({ assert }) => {
    const d = ctx.delegation;
    const token = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    assert.isNotNull(await d.verify(agent, `Bearer ${token.access_token}`));

    ctx.inactive.add('acct-1');
    assert.isNull(await d.verify(agent, `Bearer ${token.access_token}`));
    assert.equal(await oauthError(d.refresh(agent, token.refresh_token)), 'invalid_grant');

    // O refresh não foi queimado pela conta inativa: reativada, ele volta a valer.
    ctx.inactive.delete('acct-1');
    assert.equal((await d.refresh(agent, token.refresh_token)).scope, 'orders:read');
  });

  test('aprovar depois de revogar cria um grant novo, não ressuscita o antigo', async ({
    assert,
  }) => {
    const d = ctx.delegation;
    const first = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    const [grant] = await d.listGrants('acct-1');
    await d.revokeGrant('acct-1', grant.id);

    const second = await authorize(d, ctx.advance, 'orders:cancel', ['orders:cancel']);
    assert.notEqual(decodeJwt(second.access_token).grant_id, grant.id);
    // Só o que foi aprovado DEPOIS da revogação.
    assert.equal(second.scope, 'orders:cancel');
    assert.isNull(await d.verify(agent, `Bearer ${first.access_token}`));
  });

  test('entrada malformada (array) vira erro OAuth, não exceção', async ({ assert }) => {
    const d = ctx.delegation;
    assert.equal(await oauthError(d.requestDevice(agent, ['orders:read'])), 'invalid_scope');
    assert.equal(await oauthError(d.exchangeDeviceCode(agent, ['x'])), 'invalid_request');
    assert.equal(await oauthError(d.refresh(agent, ['x'])), 'invalid_request');
    assert.isNull(await d.pendingRequest(['WDJB-MJHT']));
  });

  test('revogar o grant mata o token na hora e o refresh', async ({ assert }) => {
    const d = ctx.delegation;
    const token = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    const [grant] = await d.listGrants('acct-1');
    assert.deepEqual(grant.scopes, [{ id: 'orders:read', description: 'Look up your orders' }]);

    assert.isFalse(await d.revokeGrant('acct-OTHER', grant.id));
    assert.isTrue(await d.revokeGrant('acct-1', grant.id));

    assert.isNull(await d.verify(agent, `Bearer ${token.access_token}`));
    assert.equal(await oauthError(d.refresh(agent, token.refresh_token)), 'invalid_grant');
    assert.lengthOf(await d.listGrants('acct-1'), 0);
  });

  test('step-up soma scopes ao grant existente', async ({ assert }) => {
    const d = ctx.delegation;
    const first = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    const second = await authorize(d, ctx.advance, 'refunds:issue', ['refunds:issue']);
    assert.equal(second.scope, 'orders:read refunds:issue');
    assert.equal(decodeJwt(first.access_token).grant_id, decodeJwt(second.access_token).grant_id);
    assert.lengthOf(await d.listGrants('acct-1'), 1);

    // O refresh antigo também passa a sair com o grant atualizado.
    const refreshed = await d.refresh(agent, first.refresh_token);
    assert.equal(refreshed.scope, 'orders:read refunds:issue');
  });

  test('verify: token de outro agente, outro usuário do agente, ou adulterado → null', async ({
    assert,
  }) => {
    const d = ctx.delegation;
    const token = await authorize(d, ctx.advance, 'orders:read', ['orders:read']);
    assert.isNull(
      await d.verify({ ...agent, issuer: 'https://evil.example' }, `Bearer ${token.access_token}`),
    );
    assert.isNull(await d.verify({ ...agent, sub: 'pa-user-2' }, `Bearer ${token.access_token}`));
    assert.isNull(await d.verify(agent, `Bearer ${token.access_token}x`));
    assert.isNull(await d.verify(agent, token.access_token));
    ctx.advance(3601);
    assert.isNull(await d.verify(agent, `Bearer ${token.access_token}`));
  });

  test('recibo assinado com as chaves do keystore (§5.6)', async ({ assert }) => {
    const d = ctx.delegation;
    const token = await authorize(d, ctx.advance, 'orders:read orders:cancel', [
      'orders:read',
      'orders:cancel',
    ]);
    const delegation = (await d.verify(agent, `Bearer ${token.access_token}`))!;
    const receipt = await d.receipt(delegation, {
      scopesUsed: ['orders:cancel'],
      actions: [{ tool: 'cancel_order', argsHash: 'abc' }],
    });
    assert.deepInclude(receipt.claims, {
      grantId: delegation.grantId,
      user: 'acct-1',
      pa: agent.issuer,
      brand: INTERFACE_URL,
    });
    const { payload } = await compactVerify(receipt.jws, keystoreSigner(ctx.keys).keySet() as any);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(payload)), receipt.claims);
  });
});

test.group('normalizeUserCode', () => {
  test('aceita minúsculas, espaços e sem hífen', ({ assert }) => {
    assert.equal(normalizeUserCode('wdjb mjht'), 'WDJB-MJHT');
    assert.equal(normalizeUserCode('WDJB-MJHT'), 'WDJB-MJHT');
    assert.isNull(normalizeUserCode('WDJB'));
    assert.isNull(normalizeUserCode(undefined));
  });
});
