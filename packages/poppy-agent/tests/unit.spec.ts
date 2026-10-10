import { test } from '@japa/runner';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import {
  authServerMetadataUrl,
  discover,
  validatePoppyDocument,
  wellKnownUrlFor,
} from '../src/discovery.js';
import { DpopKey, htuOf } from '../src/dpop.js';
import { DiscoveryError } from '../src/errors.js';
import { AgentIdentity } from '../src/identity.js';
import { generateEs256Key } from '../src/keys.js';
import { parseSse } from '../src/sse.js';
import { parseRetryAfter, parseWwwAuthenticate, wwwAuthError } from '../src/util.js';

const doc = (over: Record<string, unknown> = {}) => ({
  protocol_version: '0.1',
  organization: { name: 'Ex', domain: 'example.com' },
  auth: { issuer: 'https://auth.example.com', direct: { scopes: ['poppy:read'] } },
  agent: {
    protocols: [{ type: 'poppy', endpoint: 'https://api.example.com/poppy/conversations' }],
  },
  ...over,
});
const meta = (over: Record<string, unknown> = {}) => ({
  issuer: 'https://auth.example.com',
  token_endpoint: 'https://auth.example.com/oauth/token',
  revocation_endpoint: 'https://auth.example.com/oauth/revoke',
  authorization_endpoint: 'https://auth.example.com/oauth/authorize',
  poppy_domains: ['example.com'],
  ...over,
});

function mockFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    return r();
  };
  return { fn, calls };
}
const json =
  (b: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(b), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
const redirect = (to: string) => () =>
  new Response(null, { status: 302, headers: { location: to } });

test.group('discovery (section 3)', () => {
  test('valid document + metadata, unknown fields ignored', async ({ assert }) => {
    const { fn } = mockFetch({
      'https://example.com/.well-known/poppy.json': json(doc({ future: 1 })),
      'https://auth.example.com/.well-known/oauth-authorization-server': json(
        meta({ extra: true }),
      ),
    });
    const d = await discover('example.com', { fetch: fn });
    assert.equal(d.document.organization.name, 'Ex');
    assert.equal(d.metadata?.token_endpoint, 'https://auth.example.com/oauth/token');
  });

  test('www. is ignored when matching organization.domain', async ({ assert }) => {
    const { fn } = mockFetch({
      'https://www.example.com/.well-known/poppy.json': json(doc()),
      'https://auth.example.com/.well-known/oauth-authorization-server': json(meta()),
    });
    assert.equal((await discover('www.example.com', { fetch: fn })).domain, 'www.example.com');
  });

  test('follows HTTPS redirects; the redirected host does not count', async ({ assert }) => {
    const { fn, calls } = mockFetch({
      'https://example.com/.well-known/poppy.json': redirect(
        'https://cdn.provider.net/ex/poppy.json',
      ),
      'https://cdn.provider.net/ex/poppy.json': json(doc()),
      'https://auth.example.com/.well-known/oauth-authorization-server': json(meta()),
    });
    await discover('example.com', { fetch: fn });
    assert.include(calls, 'https://cdn.provider.net/ex/poppy.json');
  });

  test('refuses a redirect to http://', async ({ assert }) => {
    const { fn } = mockFetch({
      'https://example.com/.well-known/poppy.json': redirect('http://cdn.provider.net/poppy.json'),
    });
    await assert.rejects(() => discover('example.com', { fetch: fn }), /https/);
  });

  test('refuses plain http without --insecure-dev', async ({ assert }) => {
    assert.throws(() => wellKnownUrlFor('http://localhost:3333'), /insecure-dev/);
    assert.equal(
      wellKnownUrlFor('localhost:3333', { insecureDev: true }).toString(),
      'http://localhost:3333/.well-known/poppy.json',
    );
  });

  test('domain mismatch', ({ assert }) => {
    assert.throws(() => validatePoppyDocument(doc(), 'evil.com'), /does not match/);
  });

  test('unsupported major version, minor bumps fine', ({ assert }) => {
    assert.throws(
      () => validatePoppyDocument(doc({ protocol_version: '1.0' }), 'example.com'),
      /major/,
    );
    assert.doesNotThrow(() =>
      validatePoppyDocument(doc({ protocol_version: '0.7' }), 'example.com'),
    );
  });

  test('auth required with agent/apis/browser endpoint; one of agent/apis/web required', ({
    assert,
  }) => {
    assert.throws(
      () => validatePoppyDocument(doc({ auth: undefined }), 'example.com'),
      /auth is required/,
    );
    assert.throws(
      () =>
        validatePoppyDocument(
          { protocol_version: '0.1', organization: { name: 'x', domain: 'example.com' } },
          'example.com',
        ),
      /at least one/,
    );
    assert.doesNotThrow(() =>
      validatePoppyDocument(
        { protocol_version: '0.1', organization: { name: 'x', domain: 'example.com' }, web: {} },
        'example.com',
      ),
    );
  });

  test('issuer must match exactly and poppy_domains must list the domain', async ({ assert }) => {
    for (const bad of [
      meta({ issuer: 'https://auth.example.com/' }),
      meta({ poppy_domains: ['other.com'] }),
      meta({ poppy_domains: undefined }),
    ]) {
      const { fn } = mockFetch({
        'https://example.com/.well-known/poppy.json': json(doc()),
        'https://auth.example.com/.well-known/oauth-authorization-server': json(bad),
      });
      await assert.rejects(() => discover('example.com', { fetch: fn }), DiscoveryError as any);
    }
  });

  test('required endpoints', async ({ assert }) => {
    const { fn } = mockFetch({
      'https://example.com/.well-known/poppy.json': json(doc()),
      'https://auth.example.com/.well-known/oauth-authorization-server': json(
        meta({ authorization_endpoint: undefined }),
      ),
    });
    await assert.rejects(() => discover('example.com', { fetch: fn }), /authorization_endpoint/);
  });

  test('RFC 8414 metadata URL with an issuer path', ({ assert }) => {
    assert.equal(
      authServerMetadataUrl('https://auth.example.com/tenant1').toString(),
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    );
  });

  test('cache honours max-age', async ({ assert }) => {
    const { HttpJsonCache } = await import('../src/discovery.js');
    const cache = new HttpJsonCache();
    const { fn, calls } = mockFetch({
      'https://example.com/.well-known/poppy.json': json(doc(), { 'cache-control': 'max-age=60' }),
      'https://auth.example.com/.well-known/oauth-authorization-server': json(meta()),
    });
    await discover('example.com', { fetch: fn, cache });
    await discover('example.com', { fetch: fn, cache });
    assert.equal(calls.filter((c) => c.endsWith('poppy.json')).length, 1);
  });
});

test.group('assertions and proofs', () => {
  test('DPoP proof shape (RFC 9449)', async ({ assert }) => {
    const key = await DpopKey.generate();
    const proof = await key.proof({
      htm: 'post',
      htu: 'https://a.example/x?y=1#z',
      accessToken: 'tok',
      nonce: 'n1',
    });
    const h = decodeProtectedHeader(proof);
    const p = decodeJwt(proof);
    assert.equal(h.typ, 'dpop+jwt');
    assert.equal(h.alg, 'ES256');
    assert.notProperty(h.jwk as object, 'd');
    assert.equal(p.htm, 'POST');
    assert.equal(p.htu, 'https://a.example/x');
    assert.equal(p.nonce, 'n1');
    assert.isString(p.ath);
    assert.isAtLeast(Buffer.from(String(p.jti), 'base64url').length, 16);
    assert.equal(htuOf('https://a.example/p?q#f'), 'https://a.example/p');
  });

  test('identity: client_id, metadata, session and browser assertions', async ({ assert }) => {
    const id = new AgentIdentity({
      baseUrl: 'https://agent.example/',
      clientName: 'A',
      keys: [await generateEs256Key()],
    });
    const m = id.metadata();
    assert.equal(m.client_id, 'https://agent.example/agent.json');
    assert.deepEqual(m.redirect_uris, ['https://agent.example/oauth/callback']);
    assert.equal(m.token_endpoint_auth_method, 'private_key_jwt');
    for (const k of id.jwks().keys) assert.notProperty(k, 'd');
    const a = decodeJwt(await id.sessionAssertion('usr_x', 'https://auth.example.com/oauth/token'));
    assert.equal(a.iss, m.client_id);
    assert.equal(a.aud, 'https://auth.example.com/oauth/token');
    assert.isAtMost(Number(a.exp) - Number(a.iat), 60);
    const b = await id.browserAssertion({
      userId: 'usr_x',
      endpoint: 'https://ex.com/b',
      sessionId: 's',
      returnTo: 'https://ex.com/',
    });
    assert.equal(decodeProtectedHeader(b).typ, 'poppy-browser+jwt');
    assert.throws(
      () => new AgentIdentity({ baseUrl: 'http://agent.example', clientName: 'A', keys: [] }),
      /https/,
    );
  });
});

test.group('parsers', () => {
  test('WWW-Authenticate', ({ assert }) => {
    assert.deepEqual(
      wwwAuthError('DPoP error="insufficient_scope", scope="poppy:read poppy:write"'),
      {
        error: 'insufficient_scope',
        scope: 'poppy:read poppy:write',
        description: undefined,
      },
    );
    const c = parseWwwAuthenticate('Bearer realm="x", error=invalid_token, DPoP algs="ES256"');
    assert.equal(c.length, 2);
    assert.equal(c[0].params.error, 'invalid_token');
    assert.equal(parseRetryAfter('3'), 3);
  });

  test('SSE parser', async ({ assert }) => {
    const text =
      ': comment\r\nid: evt_1\ndata: {"a":1}\n\nevent: text-delta\ndata: {"t":\ndata: 2}\n\ndata: partial';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSse(stream)) events.push(e);
    assert.deepEqual(events, [
      { event: 'message', data: '{"a":1}', id: 'evt_1', retry: undefined },
      { event: 'text-delta', data: '{"t":\n2}', id: undefined, retry: undefined },
    ]);
  });
});
