import { test } from '@japa/runner';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';
import { PersonalAgentVerifier } from '../../src/agents/agent_identity.js';
import {
  type PersonalAgentsConfigInput,
  resolvePersonalAgentsConfig,
} from '../../src/agents/config.js';

const ISSUER = 'https://pa.example.com';
const JWKS_URI = 'https://pa.example.com/.well-known/jwks.json';
const AUDIENCE = 'https://brand.example/a2a';
const NOW = new Date('2026-10-06T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

async function agentKeys() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

function sign(key: CryptoKey, claims: JWTPayload, header: { alg?: string } = {}) {
  return new SignJWT({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-1',
    iat: NOW_S,
    exp: NOW_S + 120,
    ...claims,
  })
    .setProtectedHeader({ alg: header.alg ?? 'ES256', kid: 'k1' })
    .sign(key);
}

function verifier(
  jwks: ReturnType<typeof createLocalJWKSet>,
  overrides: Partial<PersonalAgentsConfigInput> = {},
  fetchImpl?: typeof fetch,
) {
  const cfg = resolvePersonalAgentsConfig({
    audience: AUDIENCE,
    agents: [{ issuer: ISSUER, jwksUri: JWKS_URI, name: 'Example PA' }],
    ...overrides,
  })!;
  const seen: string[] = [];
  const v = new PersonalAgentVerifier(cfg, {
    getKey: (uri) => {
      seen.push(uri);
      return jwks;
    },
    now: () => NOW,
    fetch: fetchImpl,
  });
  return { v, seen };
}

test.group('PersonalAgentVerifier (PACT §3.2)', () => {
  test('aceita um JWT válido e devolve agente + sub', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const { v, seen } = verifier(jwks);
    const identity = await v.verify(`Bearer ${await sign(privateKey, {})}`);
    assert.deepInclude(identity!, { issuer: ISSUER, sub: 'user-1', name: 'Example PA' });
    assert.deepEqual(seen, [JWKS_URI]);
  });

  test('rejeita header ausente ou sem Bearer', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const { v } = verifier(jwks);
    assert.isNull(await v.verify(undefined));
    assert.isNull(await v.verify(`Basic ${await sign(privateKey, {})}`));
  });

  test('rejeita issuer desconhecido ou desabilitado', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    assert.isNull(
      await verifier(jwks, { agents: [] }).v.verify(`Bearer ${await sign(privateKey, {})}`),
    );
    const disabled = verifier(jwks, {
      agents: [{ issuer: ISSUER, jwksUri: JWKS_URI, enabled: false }],
    });
    assert.isNull(await disabled.v.verify(`Bearer ${await sign(privateKey, {})}`));
  });

  test('rejeita aud errado ou aud em array', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const { v } = verifier(jwks);
    assert.isNull(await v.verify(`Bearer ${await sign(privateKey, { aud: 'https://other' })}`));
    assert.isNull(await v.verify(`Bearer ${await sign(privateKey, { aud: [AUDIENCE] })}`));
  });

  test('rejeita vida > 300 s, iat no futuro e token expirado', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const { v } = verifier(jwks);
    assert.isNull(await v.verify(`Bearer ${await sign(privateKey, { exp: NOW_S + 301 })}`));
    assert.isNull(
      await v.verify(`Bearer ${await sign(privateKey, { iat: NOW_S + 31, exp: NOW_S + 100 })}`),
    );
    assert.isNull(
      await v.verify(`Bearer ${await sign(privateKey, { iat: NOW_S - 200, exp: NOW_S - 31 })}`),
    );
  });

  test('tolera 30 s de relógio', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const { v } = verifier(jwks);
    const token = await sign(privateKey, { iat: NOW_S + 25, exp: NOW_S + 100 });
    assert.isNotNull(await v.verify(`Bearer ${token}`));
  });

  test('rejeita sub ausente', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const { v } = verifier(jwks);
    assert.isNull(await v.verify(`Bearer ${await sign(privateKey, { sub: undefined })}`));
  });

  test('rejeita algoritmo fora de ES256/RS256 antes de buscar chave', async ({ assert }) => {
    const { jwks } = await agentKeys();
    const { v, seen } = verifier(jwks);
    const hs = await new SignJWT({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: 'u',
      iat: NOW_S,
      exp: NOW_S + 60,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('x'.repeat(32)));
    assert.isNull(await v.verify(`Bearer ${hs}`));
    assert.deepEqual(seen, []);
  });

  test('assinatura de outra chave não passa', async ({ assert }) => {
    const { jwks } = await agentKeys();
    const other = await agentKeys();
    const { v } = verifier(jwks);
    assert.isNull(await v.verify(`Bearer ${await sign(other.privateKey, {})}`));
  });

  test('modo open: descobre o jwks_uri via OIDC discovery (só HTTPS)', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: JWKS_URI }), { status: 200 });
    }) as unknown as typeof fetch;
    const { v, seen } = verifier(jwks, { agents: [], open: true }, fakeFetch);
    const identity = await v.verify(`Bearer ${await sign(privateKey, {})}`);
    assert.equal(identity?.issuer, ISSUER);
    assert.equal(identity?.name, 'pa.example.com');
    assert.deepEqual(calls, [`${ISSUER}/.well-known/openid-configuration`]);
    assert.deepEqual(seen, [JWKS_URI]);
  });

  test('modo open: falha de discovery fica em cache (sem request de saída por request)', async ({
    assert,
  }) => {
    const { privateKey, jwks } = await agentKeys();
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const { v } = verifier(jwks, { agents: [], open: true }, fakeFetch);
    const token = `Bearer ${await sign(privateKey, {})}`;
    assert.isNull(await v.verify(token));
    assert.isNull(await v.verify(token));
    assert.isNull(await v.verify(token));
    assert.equal(calls, 1);
  });

  test('modo open: issuer http nunca é buscado', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const { v } = verifier(jwks, { agents: [], open: true }, fakeFetch);
    assert.isNull(
      await v.verify(`Bearer ${await sign(privateKey, { iss: 'http://internal.local' })}`),
    );
    assert.equal(calls, 0);
  });

  test('modo open: discovery com issuer divergente é recusada', async ({ assert }) => {
    const { privateKey, jwks } = await agentKeys();
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ issuer: 'https://evil.example', jwks_uri: JWKS_URI }), {
        status: 200,
      })) as unknown as typeof fetch;
    const { v } = verifier(jwks, { agents: [], open: true }, fakeFetch);
    assert.isNull(await v.verify(`Bearer ${await sign(privateKey, {})}`));
  });
});

test.group('resolvePersonalAgentsConfig', () => {
  test('undefined = desligado', ({ assert }) => {
    assert.isUndefined(resolvePersonalAgentsConfig(undefined));
  });

  test('defaults de prefixo e delegação', ({ assert }) => {
    const cfg = resolvePersonalAgentsConfig({
      audience: 'aud',
      prefix: 'pa/',
      delegation: { interfaceUrl: 'https://x.example/a2a', scopes: { 'orders:read': 'Read' } },
    })!;
    assert.equal(cfg.prefix, '/pa');
    assert.deepInclude(cfg.delegation!, {
      accessTokenTtl: 3600,
      deviceCodeTtl: 600,
      pollInterval: 5,
      grantTtl: 30 * 24 * 3600,
    });
  });

  test('valida audience, URLs e ids de scope', ({ assert }) => {
    assert.throws(() => resolvePersonalAgentsConfig({ audience: ' ' }), /audience/);
    assert.throws(
      () => resolvePersonalAgentsConfig({ audience: 'a', agents: [{ issuer: 'x', jwksUri: 'y' }] }),
      /URL/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          audience: 'a',
          delegation: { interfaceUrl: 'https://x', scopes: {} },
        }),
      /pelo menos um scope/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          audience: 'a',
          delegation: { interfaceUrl: 'https://x', scopes: { 'bad scope': 'x' } },
        }),
      /id inválido/,
    );
  });
});
