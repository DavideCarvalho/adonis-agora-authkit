import { test } from '@japa/runner';
import { createRemoteAuthkit } from '../index.js';

function mockFetch(responses: Record<string, { status?: number; body: any }>): typeof fetch {
  // Sem anotar os parâmetros: eles vêm por contexto do `typeof fetch` do
  // retorno, então o stub aceita `string | URL | Request` igual ao fetch real
  // (o `String(url)` abaixo já normalizava).
  return async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const urlStr = String(url);
    const path = urlStr.replace(/.*\/api\/authkit\/v1/, '');
    const key = `${method} ${path}`;
    const match = responses[key];
    if (!match) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }),
      } as unknown as Response;
    }
    const status = match.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(match.body),
    } as unknown as Response;
  };
}

test.group('SDK settings namespace — remote driver', () => {
  const sdk = createRemoteAuthkit({
    baseUrl: 'http://idp.test',
    apiKey: 'test-key',
    fetchImpl: mockFetch({
      'GET /settings': {
        body: {
          data: [
            { key: 'bot_protection', value: { enabled: true }, updatedAt: null, updatedBy: null },
          ],
        },
      },
      'GET /settings/bot_protection': {
        body: { key: 'bot_protection', value: { enabled: true }, updatedAt: null, updatedBy: null },
      },
      'PUT /settings/bot_protection': {
        body: {
          key: 'bot_protection',
          value: { enabled: false },
          updatedAt: new Date().toISOString(),
          updatedBy: null,
        },
      },
      'DELETE /settings/bot_protection': { body: { key: 'bot_protection', deleted: true } },
    }),
  });

  test('list() returns data array with setting', async ({ assert }) => {
    const result = await sdk.settings.list();
    assert.isArray(result.data);
    assert.equal(result.data[0].key, 'bot_protection');
  });

  test('get() returns single setting', async ({ assert }) => {
    const result = await sdk.settings.get('bot_protection');
    assert.equal(result.key, 'bot_protection');
    assert.deepEqual(result.value, { enabled: true });
  });

  test('set() sends PUT and returns updated setting', async ({ assert }) => {
    let capturedMethod = '';
    let capturedBody: any = null;
    const sdkCapture = createRemoteAuthkit({
      baseUrl: 'http://idp.test',
      apiKey: 'test-key',
      fetchImpl: async (_url, init = {}) => {
        capturedMethod = init.method ?? 'GET';
        capturedBody = init.body ? JSON.parse(init.body as string) : null;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              key: 'bot_protection',
              value: { enabled: false },
              updatedAt: new Date().toISOString(),
              updatedBy: null,
            }),
        } as unknown as Response;
      },
    });
    const result = await sdkCapture.settings.set('bot_protection', { enabled: false });
    assert.equal(capturedMethod, 'PUT');
    assert.deepEqual(capturedBody, { value: { enabled: false } });
    assert.equal(result.key, 'bot_protection');
  });

  test('delete() sends DELETE and returns { key, deleted: true }', async ({ assert }) => {
    const result = await sdk.settings.delete('bot_protection');
    assert.isTrue(result.deleted);
    assert.equal(result.key, 'bot_protection');
  });

  test('get() for non-existent key throws AuthkitApiError', async ({ assert }) => {
    const sdkEmpty = createRemoteAuthkit({
      baseUrl: 'http://idp.test',
      apiKey: 'key',
      fetchImpl: mockFetch({}),
    });
    await assert.rejects(async () => sdkEmpty.settings.get('missing'));
  });
});
