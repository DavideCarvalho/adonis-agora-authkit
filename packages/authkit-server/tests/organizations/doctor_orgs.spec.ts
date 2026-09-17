import { test } from '@japa/runner';
import type { DoctorInput } from '../../src/doctor/checks.js';
import { checkOrganizations } from '../../src/doctor/checks.js';

function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    authkitConfig: null,
    sessionConfig: null,
    peers: { session: true, shield: true, ally: false, limiter: false },
    ...overrides,
  };
}

test.group('checkOrganizations', () => {
  test('retorna null quando não há config', ({ assert }) => {
    assert.isNull(checkOrganizations(baseInput()));
  });

  test('retorna null quando enabled=undefined e store não suporta (auto, silencioso)', ({
    assert,
  }) => {
    const result = checkOrganizations(
      baseInput({
        authkitConfig: {
          accountStore: { findById: () => {} },
          organizations: { enabled: undefined, roles: ['owner', 'member'] },
        },
      }),
    );
    assert.isNull(result);
  });

  test('warn quando enabled=true mas store sem createOrg (não-lucid ou opt-out false)', ({
    assert,
  }) => {
    const result = checkOrganizations(
      baseInput({
        authkitConfig: {
          accountStore: { findById: () => {} },
          organizations: { enabled: true, roles: ['owner', 'member'] },
        },
      }),
    );
    assert.isNotNull(result);
    assert.equal(result?.level, 'warn');
    // O aviso agora aponta o default + o opt-out, em vez de mandar ligar o model.
    assert.include(result?.message ?? '', 'organizationModels: false');
  });

  test('ok quando store tem createOrg (origem desconhecida — wording genérica)', ({ assert }) => {
    const result = checkOrganizations(
      baseInput({
        authkitConfig: {
          accountStore: { createOrg: () => {} },
          organizations: { enabled: true, roles: ['owner', 'admin', 'member'] },
        },
      }),
    );
    assert.equal(result?.level, 'ok');
    assert.include(result?.message ?? '', 'owner, admin, member');
  });

  test('ok reporta models default da lib quando o store lucid marca a origem', ({ assert }) => {
    const result = checkOrganizations(
      baseInput({
        authkitConfig: {
          accountStore: { createOrg: () => {}, __organizationModelsSource: 'default' },
          organizations: { enabled: true, roles: ['owner'] },
        },
      }),
    );
    assert.equal(result?.level, 'ok');
    assert.include(result?.message ?? '', 'lib defaults');
  });

  test('ok reporta trio explícito quando o host forneceu os models', ({ assert }) => {
    const result = checkOrganizations(
      baseInput({
        authkitConfig: {
          accountStore: { createOrg: () => {}, __organizationModelsSource: 'explicit' },
          organizations: { enabled: true, roles: ['owner'] },
        },
      }),
    );
    assert.equal(result?.level, 'ok');
    assert.include(result?.message ?? '', 'host-provided explicit trio');
  });
});
