import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

const IAT = 'iat_secret';

/**
 * Sobe um OidcService (issuer na RAIZ, então os endpoints OIDC ficam no root,
 * inclusive o de registro dinâmico em `/reg`) sobre um RedisMock in-process.
 * `dynReg` controla a feature de registro dinâmico no defineConfig.
 */
async function startService(
  port: number,
  dynReg?: { enabled: boolean; initialAccessToken?: string; management?: boolean },
) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
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
          grants: ['authorization_code', 'refresh_token'],
        },
      ],
      accountStore: fakeAccountStore(),
      ...(dynReg ? { dynamicRegistration: dynReg } : {}),
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

const metadata = (issuer: string) => ({
  redirect_uris: [`${issuer}/dyn/cb`],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'client_secret_basic',
});

test.group('dynamic client registration (RFC 7591/7592)', () => {
  test('com IAT exigido: registra client, persiste via adapter e é encontrável', async ({
    assert,
    cleanup,
  }) => {
    const port = 9811;
    const { issuer, service, server } = await startService(port, {
      enabled: true,
      initialAccessToken: IAT,
      management: true,
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    // SEM o IAT => rejeitado (401/400), endpoint protegido.
    const noAuth = await fetch(`${issuer}/reg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata(issuer)),
    });
    assert.oneOf(noAuth.status, [400, 401]);

    // COM o IAT + metadata válida => 201 com client_id e client_secret.
    const res = await fetch(`${issuer}/reg`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${IAT}`,
      },
      body: JSON.stringify(metadata(issuer)),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.isString(body.client_id);
    assert.isString(body.client_secret);
    assert.deepEqual(body.redirect_uris, [`${issuer}/dyn/cb`]);
    // RFC 7592: com management ligado, o provider devolve o registration_access_token.
    assert.isString(body.registration_access_token);

    // Prova de persistência via adapter: o provider encontra o client recém-registrado.
    const found = await (service.provider as any).Client.find(body.client_id);
    assert.isOk(found);
    assert.deepEqual(found.metadata().redirect_uris, [`${issuer}/dyn/cb`]);
  });

  test('IAT inválido é rejeitado', async ({ assert, cleanup }) => {
    const port = 9812;
    const { issuer, server } = await startService(port, {
      enabled: true,
      initialAccessToken: IAT,
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const res = await fetch(`${issuer}/reg`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong_token',
      },
      body: JSON.stringify(metadata(issuer)),
    });
    assert.oneOf(res.status, [400, 401]);
  });

  test('com a feature DESLIGADA (default), /reg não está disponível', async ({
    assert,
    cleanup,
  }) => {
    const port = 9813;
    // Sem passar dynamicRegistration => default desligado.
    const { issuer, server } = await startService(port);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const res = await fetch(`${issuer}/reg`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${IAT}`,
      },
      body: JSON.stringify(metadata(issuer)),
    });
    // endpoint inexistente: 404 (ou 400 caso o provider trate a rota como desconhecida).
    assert.oneOf(res.status, [400, 404]);
  });
});
