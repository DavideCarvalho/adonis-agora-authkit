/**
 * `admin.impersonation` como interruptor REAL (plano 016).
 *
 * A flag precisa (a) ser declarável no `defineConfig`, (b) ser lida pelo
 * `resolveAdmin` e (c) governar as DUAS superfícies de impersonation:
 *   1. o grant RFC 8693 (token-exchange) registrado no provider;
 *   2. o painel de impersonation do console admin.
 *
 * O default é `true` — back-compat: hoje o grant é registrado
 * incondicionalmente e há hosts que o consomem a partir do PRÓPRIO /admin, sem
 * montar o console da lib. Virar o default para `false` é decisão de major.
 */

import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import instance from 'oidc-provider/lib/helpers/weak_cache.js';
import {
  type AuthServerConfigInput,
  adapters,
  defineConfig,
  resolveAdmin,
} from '../src/define_config.js';
import ConsoleImpersonationController from '../src/host/admin_console/console_impersonation_controller.js';
import { SETTING_KEYS } from '../src/host/runtime_toggles.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ISSUER = 'https://impersonation.test';

/** Resolve um `defineConfig` completo (Redis em memória) para os testes. */
async function resolvedConfig(extra: Partial<AuthServerConfigInput> = {}) {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  return (await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          clientId: 'admin-cli',
          clientSecret: 'sec',
          redirectUris: [`${ISSUER}/cb`],
          grants: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE],
        },
      ],
      accountStore: fakeAccountStore({
        findById: async (id: string) =>
          id === 'target-1'
            ? { id, email: 't@x.com', globalRoles: ['USER'], name: 'Target' }
            : null,
      }),
      ...extra,
    }),
  )) as any;
}

/**
 * PONTO DE OBSERVAÇÃO do grant: `registerGrantType` do oidc-provider grava o
 * handler em `instance(provider).grantTypeHandlers` (Map) e adiciona o nome em
 * `configuration.grantTypes` (Set). Checamos os dois — é o mesmo weak_cache que
 * `build_provider.spec.ts`/`oidc_service.spec.ts` já usam para inspecionar o
 * provider montado.
 */
function grantIsRegistered(service: OidcService): boolean {
  const int = instance(service.provider as any) as any;
  const inHandlers = int.grantTypeHandlers.has(TOKEN_EXCHANGE);
  const inConfig = int.configuration.grantTypes.has(TOKEN_EXCHANGE);
  if (inHandlers !== inConfig) {
    throw new Error(
      `estado inconsistente do provider: handlers=${inHandlers} grantTypes=${inConfig}`,
    );
  }
  return inHandlers;
}

/** Contexto HTTP falso mínimo para o controller do console. */
function fakeCtx(service: any, userId: string) {
  let status = 200;
  let body: any;
  const set = (b: any) => {
    body = b;
    return b;
  };
  const ctx = {
    request: { param: (k: string) => (k === 'userId' ? userId : undefined), ip: () => '127.0.0.1' },
    response: {
      notFound: (p?: any) => {
        status = 404;
        return set(p);
      },
      status: (s: number) => {
        status = s;
        return { send: set };
      },
      send: set,
    },
    session: { get: () => 'admin-1' },
    containerResolver: { make: async () => service },
  } as any;
  return { ctx, status: () => status, body: () => body };
}

// ───────────────────────────────────────────────────────────────────────────
// Teste 1 — a flag é declarável e resolve
// ───────────────────────────────────────────────────────────────────────────

test.group('admin.impersonation — resolveAdmin', () => {
  test('impersonation: false no input resolve para false', ({ assert }) => {
    assert.isFalse(resolveAdmin({ enabled: true, impersonation: false }).impersonation);
  });

  test('omitido resolve para true (default de back-compat)', ({ assert }) => {
    assert.isTrue(resolveAdmin({ enabled: true }).impersonation);
    // Também sem nenhum input: o grant existia antes de qualquer `admin` existir.
    assert.isTrue(resolveAdmin().impersonation);
  });

  test('impersonation: true no input resolve para true', ({ assert }) => {
    assert.isTrue(resolveAdmin({ enabled: true, impersonation: true }).impersonation);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Testes 2 e 3 — o grant token-exchange
// ───────────────────────────────────────────────────────────────────────────

test.group('admin.impersonation — grant token-exchange', () => {
  test('impersonation: false NÃO registra o grant token-exchange', async ({ assert }) => {
    const cfg = await resolvedConfig({ admin: { enabled: true, impersonation: false } });
    assert.isFalse(cfg.admin.impersonation, 'pré-condição: a flag tem de chegar resolvida');

    const service = new OidcService(cfg, 'a'.repeat(32));
    assert.isFalse(grantIsRegistered(service), 'o grant não pode existir com a flag desligada');
  });

  test('BACK-COMPAT: sem declarar nada, o grant token-exchange segue registrado', async ({
    assert,
  }) => {
    const cfg = await resolvedConfig();
    const service = new OidcService(cfg, 'a'.repeat(32));
    assert.isTrue(grantIsRegistered(service), 'default tem de preservar o comportamento de hoje');
  });

  test('impersonation: true registra o grant', async ({ assert }) => {
    const cfg = await resolvedConfig({ admin: { enabled: true, impersonation: true } });
    const service = new OidcService(cfg, 'a'.repeat(32));
    assert.isTrue(grantIsRegistered(service));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Teste 4 — o painel do console
// ───────────────────────────────────────────────────────────────────────────

test.group('admin.impersonation — painel do console', () => {
  test('impersonation: false → 404 capability_unsupported', async ({ assert }) => {
    const cfg = await resolvedConfig({ admin: { enabled: true, impersonation: false } });
    const { ctx, status, body } = fakeCtx({ config: cfg }, 'target-1');

    await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 404);
    assert.equal(body().error.code, 'capability_unsupported');
  });

  test('impersonation: true → devolve os parâmetros RFC 8693 do alvo', async ({ assert }) => {
    const cfg = await resolvedConfig({ admin: { enabled: true, impersonation: true } });
    const { ctx, status } = fakeCtx({ config: cfg }, 'target-1');

    const result: any = await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 200);
    assert.equal(result.targetUserId, 'target-1');
    assert.equal(result.targetEmail, 't@x.com');
    assert.equal(result.grantType, TOKEN_EXCHANGE);
    assert.equal(result.clientId, 'admin-cli');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A3 — o lock que antes não podia disparar
// ───────────────────────────────────────────────────────────────────────────

test.group('admin.impersonation — config lock', () => {
  test('declarar admin.impersonation trava a setting admin_impersonation', async ({ assert }) => {
    const cfg = await resolvedConfig({ admin: { enabled: true, impersonation: false } });
    assert.include(cfg.lockedSettingKeys, SETTING_KEYS.ADMIN_IMPERSONATION);
  });

  test('admin sem impersonation NÃO trava a setting (a UI segue mandando)', async ({ assert }) => {
    const cfg = await resolvedConfig({ admin: { enabled: true } });
    assert.notInclude(cfg.lockedSettingKeys, SETTING_KEYS.ADMIN_IMPERSONATION);
  });
});
