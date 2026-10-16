import { conventionEndpoints } from '../../src/discovery.js';
import type { ResolverContext } from '../../src/resolvers/factory.js';

/** What the manager hands a resolver factory: authkit-server endpoints, a silent logger. */
export function resolverContext(
  issuer: string,
  over: Partial<ResolverContext> = {},
): ResolverContext {
  return {
    issuer,
    clientId: 'app1',
    sessionKey: 'authkit',
    globalRolesClaim: 'roles',
    endpoints: async () => conventionEndpoints(issuer),
    logger: { warn: () => {} },
    ...over,
  };
}
