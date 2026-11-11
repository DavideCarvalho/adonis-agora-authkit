import { test } from '@japa/runner';
import { buildImpersonationPanel } from '../src/host/impersonation.js';

const ISSUER = { issuer: 'https://idp.example.com' };

/** Clients como o `AdminClientsService` os lê do adapter (sem secret). */
function clients(list: Array<{ clientId: string; clientSecret?: string; grants: string[] }>) {
  return list.map((c) => ({
    clientId: c.clientId,
    grantTypes: c.grants,
    confidential: c.clientSecret !== undefined,
  }));
}

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

test.group('buildImpersonationPanel (RFC 8693 token exchange)', () => {
  test('sem client com token-exchange → null (fluxo não disponível)', ({ assert }) => {
    const result = buildImpersonationPanel(
      ISSUER,
      'target-user-id',
      clients([
        {
          clientId: 'web',
          clientSecret: 'sec',
          grants: ['authorization_code', 'refresh_token'],
        },
      ]),
    );
    assert.isNull(result);
  });

  test('com client confidencial → monta curl com -u e placeholder do secret', ({ assert }) => {
    const result = buildImpersonationPanel(
      ISSUER,
      'user-42',
      clients([
        {
          clientId: 'admin-cli',
          clientSecret: 'sec-abc',
          grants: [TOKEN_EXCHANGE],
        },
      ]),
    );
    assert.isNotNull(result);
    assert.equal(result!.tokenEndpoint, 'https://idp.example.com/token');
    assert.equal(result!.grantType, TOKEN_EXCHANGE);
    assert.equal(result!.subjectTokenType, ACCESS_TOKEN_TYPE);
    assert.equal(result!.requestedSubject, 'user-42');
    assert.equal(result!.clientId, 'admin-cli');
    // curl usa auth HTTP basic (-u); o secret não é recuperável, sai o placeholder.
    assert.include(result!.curl, "-u 'admin-cli:<CLIENT_SECRET>'");
    assert.include(result!.curl, `grant_type=${TOKEN_EXCHANGE}`);
    assert.include(result!.curl, 'subject_token=<ADMIN_ACCESS_TOKEN>');
    assert.include(result!.curl, 'requested_subject=user-42');
  });

  test('com client público (sem secret) → curl usa -d client_id', ({ assert }) => {
    const result = buildImpersonationPanel(
      ISSUER,
      'user-99',
      clients([
        {
          clientId: 'public-cli',
          // sem clientSecret
          grants: [TOKEN_EXCHANGE],
        },
      ]),
    );
    assert.isNotNull(result);
    assert.include(result!.curl, 'client_id=public-cli');
    assert.notInclude(result!.curl, '-u ');
  });

  test('escolhe o PRIMEIRO client com o grant (quando há vários)', ({ assert }) => {
    const result = buildImpersonationPanel(
      ISSUER,
      'user-1',
      clients([
        {
          clientId: 'no-exchange',
          clientSecret: 'x',
          grants: ['authorization_code'],
        },
        {
          clientId: 'has-exchange',
          clientSecret: 'y',
          grants: [TOKEN_EXCHANGE],
        },
      ]),
    );
    assert.isNotNull(result);
    assert.equal(result!.clientId, 'has-exchange');
  });

  test('issuer com trailing slash é normalizado no tokenEndpoint', ({ assert }) => {
    const result = buildImpersonationPanel(
      { issuer: 'https://idp.example.com/' },
      'target',
      clients([{ clientId: 'cli', clientSecret: 'sec', grants: [TOKEN_EXCHANGE] }]),
    );
    assert.equal(result!.tokenEndpoint, 'https://idp.example.com/token');
  });

  test('shape completo do retorno tem todos os campos esperados', ({ assert }) => {
    const result = buildImpersonationPanel(
      ISSUER,
      'uid-1',
      clients([
        {
          clientId: 'c1',
          clientSecret: 's1',
          grants: [TOKEN_EXCHANGE],
        },
      ]),
    );
    assert.isNotNull(result);
    const expectedKeys = [
      'tokenEndpoint',
      'grantType',
      'subjectTokenType',
      'requestedSubject',
      'clientId',
      'curl',
    ];
    for (const key of expectedKeys) {
      assert.property(result!, key, `campo '${key}' deve estar presente`);
    }
  });
});

/**
 * ATÉ O PLANO 016 este grupo fixava o oposto: `impersonation` era hardcoded
 * `false` no `resolveAdmin` e nem sequer existia no `AdminConfigInput`. Isso não
 * era um "gate conservador" — o grant token-exchange era registrado de qualquer
 * jeito e o único efeito da flag era deixar o painel do console inalcançável.
 * Agora a flag é declarável, tem default `true` (back-compat) e governa as duas
 * superfícies. Cobertura de comportamento: `admin_impersonation_switch.spec.ts`.
 */
test.group('impersonation gate (admin.impersonation, default true)', () => {
  test('resolveAdmin → impersonation default true (back-compat: o grant sempre existiu)', async ({
    assert,
  }) => {
    const { resolveAdmin } = await import('../src/define_config.js');
    assert.isTrue(resolveAdmin({ enabled: true }).impersonation);
  });

  test('resolveAdmin sem config → impersonation true', async ({ assert }) => {
    const { resolveAdmin } = await import('../src/define_config.js');
    assert.isTrue(resolveAdmin(undefined).impersonation);
  });

  test('resolveAdmin com impersonation: false → desligado', async ({ assert }) => {
    const { resolveAdmin } = await import('../src/define_config.js');
    assert.isFalse(resolveAdmin({ enabled: true, impersonation: false }).impersonation);
  });
});
