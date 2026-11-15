import { test } from '@japa/runner';
import { mcpTokenClaims } from '../src/provider/mcp_token_claims.js';

const MCP = 'https://tools.example.com/mcp';
const account = { id: 'u1', email: 'u1@example.com', globalRoles: ['ADMIN'] };

function deps(overrides: Partial<Parameters<typeof mcpTokenClaims>[1]> = {}) {
  return {
    findAccount: async (sub: string) => (sub === 'u1' ? account : null),
    globalRolesClaim: 'roles',
    isMcpResource: (audience: string) => audience === MCP,
    ...overrides,
  };
}

const token = (extra: Record<string, unknown> = {}) => ({
  kind: 'AccessToken',
  accountId: 'u1',
  clientId: 'claude-code',
  scope: 'openid profile email offline_access',
  resourceServer: { audience: MCP },
  ...extra,
});

test.group('mcpTokenClaims', () => {
  test('roles always, email with the email scope', async ({ assert }) => {
    assert.deepEqual(await mcpTokenClaims(token(), deps()), {
      roles: ['ADMIN'],
      email: 'u1@example.com',
      email_verified: false,
    });
    assert.deepEqual(
      await mcpTokenClaims(token(), deps({ isEmailVerified: async (id) => id === 'u1' })),
      { roles: ['ADMIN'], email: 'u1@example.com', email_verified: true },
    );
    assert.deepEqual(await mcpTokenClaims(token({ scope: 'openid profile' }), deps()), {
      roles: ['ADMIN'],
    });
  });

  test('any audience of a multi-audience token counts', async ({ assert }) => {
    const claims = await mcpTokenClaims(
      token({ resourceServer: { audience: ['https://api.example.com', MCP] } }),
      deps(),
    );
    assert.deepEqual(claims?.roles, ['ADMIN']);
  });

  test('roles come from resolveTokenRoles when the host sets it', async ({ assert }) => {
    const seen: unknown[] = [];
    const claims = await mcpTokenClaims(
      token(),
      deps({
        globalRolesClaim: 'app_roles',
        resolveTokenRoles: (acc, ctx) => {
          seen.push(ctx);
          return [`${acc.id}:editor`];
        },
      }),
    );
    assert.deepEqual(claims?.app_roles, ['u1:editor']);
    assert.deepEqual(seen, [{ clientId: 'claude-code', activeOrg: null }]);
  });

  test('nothing for other resources, client credentials, or unknown accounts', async ({
    assert,
  }) => {
    assert.isUndefined(
      await mcpTokenClaims(
        token({ resourceServer: { audience: 'https://api.example.com' } }),
        deps(),
      ),
    );
    assert.isUndefined(await mcpTokenClaims(token({ resourceServer: undefined }), deps()));
    assert.isUndefined(
      await mcpTokenClaims(token({ kind: 'ClientCredentials', accountId: undefined }), deps()),
    );
    assert.isUndefined(await mcpTokenClaims(token({ accountId: 'ghost' }), deps()));
  });
});
