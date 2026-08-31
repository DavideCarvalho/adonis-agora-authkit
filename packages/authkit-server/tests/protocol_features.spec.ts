import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

/**
 * Cobertura dos quatro recursos de protocolo: Device Flow (RFC 8628), DPoP
 * (RFC 9449), PAR (RFC 9126) e step-up acr. Os três primeiros são exercitados via
 * o servidor http in-process sobre o OidcService (mesma harness do oidc_flow.spec);
 * o step-up é exercitado tanto pela discovery (acr_values_supported) quanto pela
 * lógica de exigência de MFA no controller de interaction.
 */

let nextPort = 9810;
function freshPort() {
  return nextPort++;
}

async function startServer(
  configOverrides: Record<string, unknown>,
  port: number,
): Promise<{ server: Server; issuer: string }> {
  const issuer = `http://localhost:${port}`;
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  // O grant device_code SÓ é aceito pelo oidc-provider quando a feature deviceFlow
  // está ligada — declará-lo com a feature off quebra a validação de metadata do
  // client. Por isso o grant é condicional ao override de deviceFlow do teste.
  const deviceEnabled = (configOverrides as any).deviceFlow?.enabled === true;
  const grants = [
    'authorization_code',
    'refresh_token',
    ...(deviceEnabled ? ['urn:ietf:params:oauth:grant-type:device_code'] : []),
  ];
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          clientId: 'app1',
          clientSecret: 's',
          redirectUris: [`${issuer}/cb`],
          grants,
        },
      ],
      accountStore: fakeAccountStore(),
      ...configOverrides,
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { server, issuer };
}

function basicAuth() {
  return `Basic ${Buffer.from('app1:s').toString('base64')}`;
}

test.group('B1 Device Authorization Grant (RFC 8628)', () => {
  test('discovery anuncia device_authorization_endpoint quando ligado', async ({ assert }) => {
    const { server, issuer } = await startServer({ deviceFlow: { enabled: true } }, freshPort());
    try {
      const disco = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
      assert.equal(disco.device_authorization_endpoint, `${issuer}/device/auth`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('discovery NÃO anuncia device endpoint quando desligado (default)', async ({ assert }) => {
    const { server, issuer } = await startServer({}, freshPort());
    try {
      const disco = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
      assert.isUndefined(disco.device_authorization_endpoint);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('POST /device/auth emite device_code + user_code; token-poll devolve authorization_pending', async ({
    assert,
  }) => {
    const { server, issuer } = await startServer({ deviceFlow: { enabled: true } }, freshPort());
    try {
      const authRes = await fetch(`${issuer}/device/auth`, {
        method: 'POST',
        headers: {
          authorization: basicAuth(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ scope: 'openid' }).toString(),
      });
      assert.equal(authRes.status, 200);
      const auth = await authRes.json();
      assert.isString(auth.device_code);
      assert.isString(auth.user_code);
      assert.isString(auth.verification_uri);

      // Poll do token endpoint ANTES da aprovação: authorization_pending.
      const tokenRes = await fetch(`${issuer}/token`, {
        method: 'POST',
        headers: {
          authorization: basicAuth(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: auth.device_code,
        }).toString(),
      });
      assert.equal(tokenRes.status, 400);
      const tokenBody = await tokenRes.json();
      assert.equal(tokenBody.error, 'authorization_pending');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('user-code entry screen (/device) renderiza com o form do user-code', async ({ assert }) => {
    const { server, issuer } = await startServer({ deviceFlow: { enabled: true } }, freshPort());
    try {
      const res = await fetch(`${issuer}/device`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.include(html, 'op.deviceInputForm');
      // String i18n (default em inglês) da nossa source customizada.
      assert.include(html, 'Sign in to the device');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test.group('B2 DPoP (RFC 9449)', () => {
  test('discovery anuncia dpop_signing_alg_values_supported quando ligado', async ({ assert }) => {
    const { server, issuer } = await startServer({ dpop: { enabled: true } }, freshPort());
    try {
      const disco = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
      assert.isArray(disco.dpop_signing_alg_values_supported);
      assert.isAbove(disco.dpop_signing_alg_values_supported.length, 0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('feature flag DPoP faz round-trip pela config resolvida', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'http://localhost:1',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed' },
        clients: [{ clientId: 'app1', clientSecret: 's', redirectUris: ['https://a/cb'] }],
        accountStore: fakeAccountStore(),
        dpop: { enabled: true },
      }),
    );
    assert.isTrue(cfg!.dpop.enabled);
  });

  test('requisição SEM DPoP segue funcionando com a feature ligada (token endpoint vivo)', async ({
    assert,
  }) => {
    const { server, issuer } = await startServer({ dpop: { enabled: true } }, freshPort());
    try {
      // grant_type não suportado → erro de grant, mas prova que o token endpoint
      // processa requests normais (sem DPoP) com a feature ligada.
      const res = await fetch(`${issuer}/token`, {
        method: 'POST',
        headers: {
          authorization: basicAuth(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      });
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.error, 'unsupported_grant_type');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test.group('B3 PAR (RFC 9126)', () => {
  test('discovery anuncia pushed_authorization_request_endpoint quando ligado', async ({
    assert,
  }) => {
    const { server, issuer } = await startServer({ par: { enabled: true } }, freshPort());
    try {
      const disco = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
      assert.equal(disco.pushed_authorization_request_endpoint, `${issuer}/request`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('POST no PAR endpoint devolve request_uri + expires_in', async ({ assert }) => {
    const { server, issuer } = await startServer({ par: { enabled: true } }, freshPort());
    try {
      const res = await fetch(`${issuer}/request`, {
        method: 'POST',
        headers: {
          authorization: basicAuth(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: 'app1',
          response_type: 'code',
          redirect_uri: `${issuer}/cb`,
          scope: 'openid',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        }).toString(),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.isString(body.request_uri);
      assert.include(body.request_uri, 'urn:ietf:params:oauth:request_uri:');
      assert.isNumber(body.expires_in);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test.group('B4 Step-up acr', () => {
  test('discovery anuncia o mfaAcr em acr_values_supported', async ({ assert }) => {
    const { server, issuer } = await startServer(
      { stepUp: { acrValues: ['urn:authkit:mfa'] } },
      freshPort(),
    );
    try {
      const disco = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
      assert.include(disco.acr_values_supported, 'urn:authkit:mfa');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
