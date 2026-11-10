import { test } from '@japa/runner';
import { clientDisplayInfo, clientDisplayNames } from '../../src/host/client_names.js';

function fakeService(clients: Record<string, { clientName?: string; logoUri?: string }>) {
  return {
    provider: {
      Client: {
        find: async (id: string) => clients[id] ?? null,
      },
    },
  };
}

test.group('clientDisplayInfo', () => {
  test('returns the registered client_name and logo_uri', async ({ assert }) => {
    const info = await clientDisplayInfo(
      fakeService({ mcp: { clientName: 'Claude Code', logoUri: 'https://cdn.example.com/l.png' } }),
      ['mcp'],
    );
    assert.deepEqual(info.get('mcp'), {
      name: 'Claude Code',
      logoUrl: 'https://cdn.example.com/l.png',
    });
  });

  test('falls back to the clientId and a null logo', async ({ assert }) => {
    const info = await clientDisplayInfo(fakeService({ web: {} }), ['web', 'gone']);
    assert.deepEqual(info.get('web'), { name: 'web', logoUrl: null });
    assert.deepEqual(info.get('gone'), { name: 'gone', logoUrl: null });
  });

  test('clientDisplayNames keeps returning only the names', async ({ assert }) => {
    const names = await clientDisplayNames(fakeService({ web: { clientName: 'Web' } }), ['web']);
    assert.equal(names.get('web'), 'Web');
  });
});
