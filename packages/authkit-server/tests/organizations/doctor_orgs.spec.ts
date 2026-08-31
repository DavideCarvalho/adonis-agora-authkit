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

  test('warn quando enabled=true mas store sem createOrg', ({ assert }) => {
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
    assert.include(result?.message ?? '', 'organizationModels');
  });

  test('ok quando store tem createOrg', ({ assert }) => {
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
});
