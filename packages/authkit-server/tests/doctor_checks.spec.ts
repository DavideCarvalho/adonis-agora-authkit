import { test } from '@japa/runner';
import { DatabaseAdapter } from '../src/adapters/database_adapter.js';
import {
  checkAccessTokens,
  checkAccountStore,
  checkAccountStoreColumns,
  checkAdapterVolatility,
  checkAdmin,
  checkAuthMethodsSetting,
  checkBotProtection,
  checkClients,
  checkIssuer,
  checkJwks,
  checkPasswordPolicy,
  checkRateLimit,
  checkRequireVerifiedEmail,
  checkSettings,
  checkWebauthn,
  type DoctorInput,
  hasErrors,
  runAllChecks,
  signingKeyAgeFinding,
} from '../src/doctor/checks.js';

function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    authkitConfig: {
      issuer: 'https://idp.test/oidc',
      mountPath: '/oidc',
      clients: [{ client_id: 'a', redirectUris: ['https://app/cb'] }],
      accountStore: { findById: () => {}, verifyCredentials: () => {} },
      jwks: { source: 'managed', store: 'tmp/jwks.json' },
    },
    sessionConfig: { store: 'redis' },
    peers: { session: true, shield: true, ally: true, limiter: true },
    ...overrides,
  };
}

test.group('doctor checks', () => {
  test('config saudável não produz erros', ({ assert }) => {
    const findings = runAllChecks(baseInput());
    assert.isFalse(hasErrors(findings));
  });

  test('config ausente vira erro', ({ assert }) => {
    const findings = runAllChecks(baseInput({ authkitConfig: null }));
    assert.isTrue(hasErrors(findings));
  });

  test('issuer pathname != mountPath gera warn', ({ assert }) => {
    const findings = checkIssuer(
      baseInput({
        authkitConfig: { issuer: 'https://idp.test/auth', mountPath: '/oidc', clients: [] },
      }),
    );
    assert.isTrue(findings.some((f) => f.level === 'warn'));
  });

  test('issuer inválido vira erro', ({ assert }) => {
    const findings = checkIssuer(
      baseInput({
        authkitConfig: { issuer: 'not a url', mountPath: '/oidc', clients: [] },
      }),
    );
    assert.equal(findings[0].level, 'error');
  });

  test('checkClients: sempre ok (clients são 100% runtime)', ({ assert }) => {
    const f = checkClients(
      baseInput({
        authkitConfig: { clients: [] },
      }),
    );
    assert.equal(f.level, 'ok');
    assert.include(f.message, 'runtime');
  });

  test('accountStore detecta capacidades opt-in', ({ assert }) => {
    const findings = checkAccountStore(
      baseInput({
        authkitConfig: {
          accountStore: { findById: () => {}, getMfaState: () => {}, listPasskeys: () => {} },
        },
      }),
    );
    const caps = findings.find((f) => f.message.includes('Optional capabilities'));
    assert.include(caps!.message, 'MFA');
    assert.include(caps!.message, 'passkeys');
  });

  test('rate-limit ligado sem limiter vira warn', ({ assert }) => {
    const f = checkRateLimit(
      baseInput({ peers: { session: true, shield: true, ally: true, limiter: false } }),
    );
    assert.equal(f.level, 'warn');
  });

  test('admin ligado sem roles vira warn', ({ assert }) => {
    const f = checkAdmin(
      baseInput({
        authkitConfig: { admin: { enabled: true } },
      }),
    );
    assert.equal(f!.level, 'warn');
  });

  test('webauthn rpId divergente do host do issuer vira warn', ({ assert }) => {
    const f = checkWebauthn(
      baseInput({
        authkitConfig: { issuer: 'https://idp.test/oidc', webauthn: { rpId: 'other.host' } },
      }),
    );
    assert.equal(f!.level, 'warn');
  });

  test('requireVerifiedEmail sem isEmailVerified no store vira warn', ({ assert }) => {
    const f = checkRequireVerifiedEmail(
      baseInput({
        authkitConfig: {
          login: { requireVerifiedEmail: true },
          accountStore: { findById: () => {} },
        },
      }),
    );
    assert.equal(f!.level, 'warn');
  });

  test('password: sem __passwordConfig no store → check silencioso (null)', ({ assert }) => {
    const f = checkPasswordPolicy(baseInput());
    assert.isNull(f);
  });

  test('password: checkPwned ligado → finding informativo ok', ({ assert }) => {
    const f = checkPasswordPolicy(
      baseInput({
        authkitConfig: {
          accountStore: {
            findById: () => {},
            __passwordConfig: { policy: { minLength: 12 }, checkPwned: { enabled: true } },
          },
        },
      }),
    );
    assert.equal(f!.level, 'ok');
    assert.include(f!.message, 'HaveIBeenPwned');
  });

  test('password: minLength < 8 → warn', ({ assert }) => {
    const f = checkPasswordPolicy(
      baseInput({
        authkitConfig: {
          accountStore: {
            findById: () => {},
            __passwordConfig: { policy: { minLength: 4 }, checkPwned: { enabled: false } },
          },
        },
      }),
    );
    assert.equal(f!.level, 'warn');
  });

  test('password: minLength inválido → warn', ({ assert }) => {
    const f = checkPasswordPolicy(
      baseInput({
        authkitConfig: {
          accountStore: {
            findById: () => {},
            __passwordConfig: { policy: { minLength: -1 }, checkPwned: { enabled: false } },
          },
        },
      }),
    );
    assert.equal(f!.level, 'warn');
  });

  test('requireVerifiedEmail com isEmailVerified no store é ok', ({ assert }) => {
    const f = checkRequireVerifiedEmail(
      baseInput({
        authkitConfig: {
          login: { requireVerifiedEmail: true },
          accountStore: { findById: () => {}, isEmailVerified: () => {} },
        },
      }),
    );
    assert.equal(f!.level, 'ok');
  });

  test('accountStore detecta email-verification-status e account-deletion', ({ assert }) => {
    const findings = checkAccountStore(
      baseInput({
        authkitConfig: {
          accountStore: { findById: () => {}, isEmailVerified: () => {}, deleteAccount: () => {} },
        },
      }),
    );
    const caps = findings.find((f) => f.message.includes('Optional capabilities'));
    assert.include(caps!.message, 'email-verification-status');
    assert.include(caps!.message, 'account-deletion');
  });

  test('session cookie store gera warn de tamanho', ({ assert }) => {
    const findings = runAllChecks(baseInput({ sessionConfig: { store: 'cookie' } }));
    assert.isTrue(findings.some((f) => f.level === 'warn' && f.message.includes('cookie')));
  });

  test('jwks managed com store → ok e referencia authkit:keys:rotate', ({ assert }) => {
    const f = checkJwks(baseInput());
    assert.equal(f!.level, 'ok');
    assert.include(f!.message, 'authkit:keys:rotate');
  });

  test('jwks managed SEM store → warn (chave efêmera por boot)', ({ assert }) => {
    const f = checkJwks(baseInput({ authkitConfig: { jwks: { source: 'managed' } } }));
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'store');
  });

  test('botProtection ausente → check silencioso (null)', ({ assert }) => {
    assert.isNull(checkBotProtection(baseInput()));
  });

  test('botProtection ligado → ok informa as ações + fail-safe', ({ assert }) => {
    const f = checkBotProtection(
      baseInput({
        authkitConfig: { botProtection: { verify: () => true, on: ['login', 'reset'] } },
      }),
    );
    assert.equal(f!.level, 'ok');
    assert.include(f!.message, 'login, reset');
    assert.include(f!.message, 'fail-safe');
  });

  test('botProtection sem verify função → warn', ({ assert }) => {
    const f = checkBotProtection(
      baseInput({
        authkitConfig: { botProtection: { verify: 'nope' } },
      }),
    );
    assert.equal(f!.level, 'warn');
  });

  test('accessTokens: sem config → null (silencioso)', ({ assert }) => {
    const f = checkAccessTokens(baseInput({ authkitConfig: {} }));
    assert.isNull(f);
  });

  test('accessTokens: opaque (default) → ok informativo', ({ assert }) => {
    const f = checkAccessTokens(
      baseInput({
        authkitConfig: { accessTokens: { format: 'opaque', resources: {}, anyJwt: false } },
      }),
    );
    assert.equal(f!.level, 'ok');
    assert.include(f!.message, 'opaque');
  });

  test('accessTokens: jwt com jwks persistido → ok (RFC 9068)', ({ assert }) => {
    const f = checkAccessTokens(
      baseInput({
        authkitConfig: {
          jwks: { source: 'managed', store: 'tmp/jwks.json' },
          accessTokens: {
            format: 'jwt',
            audience: 'https://idp.test/oidc',
            resources: {},
            anyJwt: true,
          },
        },
      }),
    );
    assert.equal(f!.level, 'ok');
    assert.include(f!.message, 'RFC 9068');
  });

  test('accessTokens: jwt mas jwks managed SEM store → warn', ({ assert }) => {
    const f = checkAccessTokens(
      baseInput({
        authkitConfig: {
          jwks: { source: 'managed' },
          accessTokens: { format: 'jwt', audience: 'x', resources: {}, anyJwt: true },
        },
      }),
    );
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'store');
  });

  test('checkSettings: settingsTablePresent undefined → null (silent)', ({ assert }) => {
    const f = checkSettings(baseInput());
    assert.isNull(f);
  });

  test('checkSettings: table absent → null (opt-in, silent)', ({ assert }) => {
    const f = checkSettings(baseInput({ settingsTablePresent: false }));
    assert.isNull(f);
  });

  test('checkSettings: table present + botProtection.verify present → ok', ({ assert }) => {
    const f = checkSettings(
      baseInput({
        settingsTablePresent: true,
        authkitConfig: {
          issuer: 'https://idp.test/oidc',
          mountPath: '/oidc',
          clients: [{ redirectUris: ['https://app/cb'] }],
          accountStore: { findById: () => {}, verifyCredentials: () => {} },
          botProtection: { verify: async () => true },
        },
      }),
    );
    assert.equal(f!.level, 'ok');
    assert.include(f!.message, 'auth_settings table present');
  });

  test('checkSettings: table present + no botProtection.verify → warn (orphan setting)', ({
    assert,
  }) => {
    const f = checkSettings(
      baseInput({
        settingsTablePresent: true,
      }),
    );
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'orphan');
  });

  // --- clients: sempre runtime ---

  test('checkClients: ok (clients são 100% runtime)', ({ assert }) => {
    const f = checkClients(baseInput({ authkitConfig: { clients: [] } }));
    assert.equal(f.level, 'ok');
    assert.include(f.message, 'runtime');
  });

  test('checkClients: config ausente → ok informativo', ({ assert }) => {
    const f = checkClients(baseInput({ authkitConfig: {} }));
    assert.equal(f.level, 'ok');
  });

  test('config sem clients não produz erros no runAllChecks', ({ assert }) => {
    const findings = runAllChecks(
      baseInput({ authkitConfig: { ...baseInput().authkitConfig, clients: [] } }),
    );
    assert.isFalse(hasErrors(findings));
  });

  // --- adapter de volatilidade ---

  test('checkAdapterVolatility: DatabaseAdapter (persistente) → ok', ({ assert }) => {
    // Cria uma subclasse anônima de DatabaseAdapter (como o factory faz).
    const SubAdapter = class extends DatabaseAdapter {
      constructor(name: string) {
        super(name, {} as any);
      }
    };
    const f = checkAdapterVolatility(
      baseInput({
        authkitConfig: { clients: [], AdapterClass: SubAdapter },
        __adapterClasses: { DatabaseAdapter },
      }),
    );
    assert.equal(f!.level, 'ok');
    assert.include(f!.message, 'persistent');
  });

  test('checkAdapterVolatility: adapter desconhecido sem clients → warn', ({ assert }) => {
    class CustomAdapter {}
    const f = checkAdapterVolatility(
      baseInput({
        authkitConfig: { clients: [], AdapterClass: CustomAdapter },
      }),
    );
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'volatile');
  });

  test('checkAdapterVolatility: adapter desconhecido, clientes runtime → warn', ({ assert }) => {
    class CustomAdapter {}
    const f = checkAdapterVolatility(
      baseInput({
        authkitConfig: {
          clients: [],
          AdapterClass: CustomAdapter,
        },
      }),
    );
    // Adapter desconhecido sempre produz warn (clients são runtime)
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'volatile');
  });

  test('checkAdapterVolatility: sem AdapterClass → null (silencioso)', ({ assert }) => {
    const f = checkAdapterVolatility(
      baseInput({
        authkitConfig: { clients: [] },
      }),
    );
    assert.isNull(f);
  });

  // --- checkAuthMethodsSetting ---

  test('checkAuthMethodsSetting: no authMethodsSetting → null (silent)', ({ assert }) => {
    const f = checkAuthMethodsSetting(baseInput());
    assert.isNull(f);
  });

  test('checkAuthMethodsSetting: null → null (silent)', ({ assert }) => {
    const f = checkAuthMethodsSetting({ ...baseInput(), authMethodsSetting: null } as any);
    assert.isNull(f);
  });

  test('checkAuthMethodsSetting: invalid shape (array) → warn', ({ assert }) => {
    const f = checkAuthMethodsSetting({ ...baseInput(), authMethodsSetting: ['password'] } as any);
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'invalid shape');
  });

  test('checkAuthMethodsSetting: all-off → warn (fail-safe will activate)', ({ assert }) => {
    const f = checkAuthMethodsSetting({
      ...baseInput(),
      authMethodsSetting: { password: false, magicLink: false, passkey: false, social: [] },
    } as any);
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'fail-safe');
  });

  test('checkAuthMethodsSetting: social references unknown provider → warn', ({ assert }) => {
    const f = checkAuthMethodsSetting({
      ...baseInput({
        authkitConfig: {
          ...baseInput().authkitConfig,
          social: { providers: ['google'] },
        },
      }),
      authMethodsSetting: { password: true, social: ['google', 'unknown_provider'] },
    } as any);
    assert.equal(f!.level, 'warn');
    assert.include(f!.message, 'unknown_provider');
  });

  test('checkAuthMethodsSetting: valid setting → ok', ({ assert }) => {
    const f = checkAuthMethodsSetting({
      ...baseInput({
        authkitConfig: {
          ...baseInput().authkitConfig,
          social: { providers: ['google'] },
        },
      }),
      authMethodsSetting: {
        password: true,
        magicLink: false,
        passkey: false,
        social: ['google'],
        forgotPassword: true,
      },
    } as any);
    assert.equal(f!.level, 'ok');
  });

  test('checkAuthMethodsSetting: password=true, no social → ok (all-off needs ALL methods)', ({
    assert,
  }) => {
    // password is on, so not all-off
    const f = checkAuthMethodsSetting({
      ...baseInput(),
      authMethodsSetting: { password: true, magicLink: false, passkey: false, social: [] },
    } as any);
    assert.equal(f!.level, 'ok');
  });

  test('signingKeyAgeFinding: warn quando idade > maxAgeDays', ({ assert }) => {
    assert.equal(signingKeyAgeFinding(120, 90).level, 'warn');
    assert.equal(signingKeyAgeFinding(30, 90).level, 'ok');
    assert.equal(signingKeyAgeFinding(null, 90).level, 'ok'); // sem keystore managed → no-op ok
  });
});

/**
 * Brownfield: o host aponta o account store para a tabela de usuários que ele JÁ
 * tem. Se faltar uma coluna que o core store escreve, o app sobe normalmente e só
 * quebra quando alguém exercita o fluxo — em produção. Estes testes fixam a
 * detecção no boot/doctor.
 */
function fakeModel(properties: string[]): any {
  return {
    name: 'User',
    $columnsDefinitions: new Map(properties.map((p) => [p, { columnName: p }])),
  };
}

/** Model completo (withAuthUser + withCredentials). */
const COMPLETE = [
  'id',
  'email',
  'password',
  'globalRoles',
  'emailVerifiedAt',
  'emailVerificationToken',
  'passwordResetToken',
  'passwordResetExpiresAt',
];

test.group('doctor — colunas do model do account store', () => {
  test('model completo passa sem achado de coluna faltando', ({ assert }) => {
    const findings = checkAccountStoreColumns(
      baseInput({ authkitConfig: { accountStore: { __model: fakeModel(COMPLETE) } } }),
    );
    assert.isEmpty(findings.filter((f) => f.level === 'error' || f.level === 'warn'));
  });

  test('coluna faltando vira error nomeando a coluna E o fluxo que quebra', ({ assert }) => {
    const findings = checkAccountStoreColumns(
      baseInput({
        authkitConfig: {
          accountStore: {
            __model: fakeModel(COMPLETE.filter((c) => c !== 'passwordResetToken')),
          },
        },
      }),
    );
    const err = findings.find((f) => f.level === 'error');
    assert.isDefined(err, 'faltando passwordResetToken deveria virar error');
    assert.include(err!.message, 'passwordResetToken');
    // Sem dizer O QUE quebra, o achado não é acionável.
    assert.match(err!.message, /password reset/i);
  });

  test('colunas opcionais ausentes viram info, nunca error', ({ assert }) => {
    // fullName/avatarUrl/disabledAt são capability-probed: ausentes = feature off.
    const findings = checkAccountStoreColumns(
      baseInput({ authkitConfig: { accountStore: { __model: fakeModel(COMPLETE) } } }),
    );
    assert.isEmpty(findings.filter((f) => f.level === 'error'));
    const info = findings.find((f) => f.message.includes('Capabilities off'));
    assert.isDefined(
      info,
      'deveria reportar quais capabilities estão desligadas por falta de coluna',
    );
    // Ausência de coluna opcional é configuração válida — jamais error/warn.
    assert.equal(info!.level, 'ok');
    assert.include(info!.message, 'profile');
    assert.include(info!.message, 'disable/enable');
  });

  test('runAllChecks ROTEIA o check de colunas (um check não-ligado é um check morto)', ({
    assert,
  }) => {
    const findings = runAllChecks(
      baseInput({
        authkitConfig: {
          issuer: 'https://idp.test/oidc',
          accountStore: {
            __model: fakeModel(COMPLETE.filter((c) => c !== 'emailVerificationToken')),
          },
        },
      }),
    );
    const err = findings.find((f) => f.message.includes('emailVerificationToken'));
    assert.isDefined(err, 'runAllChecks não está chamando checkAccountStoreColumns');
    assert.equal(err!.level, 'error');
    assert.isTrue(hasErrors(findings));
  });

  test('store não-Lucid (sem __model) não vira erro — nada a inspecionar', ({ assert }) => {
    const findings = checkAccountStoreColumns(
      baseInput({ authkitConfig: { accountStore: { findById: () => {} } } }),
    );
    assert.isEmpty(findings.filter((f) => f.level === 'error'));
  });

  test('reporta o columnName real, não o nome da propriedade', ({ assert }) => {
    // Brownfield mapeia `password` → coluna `senha`; a mensagem tem que citar a
    // coluna que o DBA vai procurar no banco.
    const model = {
      name: 'User',
      $columnsDefinitions: new Map<string, { columnName: string }>([
        ['id', { columnName: 'id' }],
        ['email', { columnName: 'email' }],
        ['password', { columnName: 'senha' }],
      ]),
    };
    const findings = checkAccountStoreColumns(
      baseInput({ authkitConfig: { accountStore: { __model: model } } }),
    );
    const all = findings.map((f) => f.message).join(' ');
    assert.notInclude(all, "'password'");
    assert.include(all, 'passwordResetToken');
  });
});
