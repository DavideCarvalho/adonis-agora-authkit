import { test } from '@japa/runner';
import { consentRequestParams } from '../../src/host/consent_params.js';

test.group('consentRequestParams', () => {
  test('keeps the standard fields as strings and passes the rest through', ({ assert }) => {
    const params = consentRequestParams({
      client_id: 'web',
      redirect_uri: 'https://app.test/cb',
      response_type: 'code',
      scope: 'openid email',
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      audience: 'https://api.test',
    });
    assert.deepEqual(params, {
      client_id: 'web',
      redirect_uri: 'https://app.test/cb',
      response_type: 'code',
      scope: 'openid email',
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      audience: 'https://api.test',
    });
  });

  test('device-flow style request: only client_id is guaranteed', ({ assert }) => {
    const params = consentRequestParams({ client_id: 'tv', scope: 'openid', nonce: undefined });
    assert.deepEqual(params, { client_id: 'tv', scope: 'openid' });
    assert.notProperty(params, 'redirect_uri');
  });
});
