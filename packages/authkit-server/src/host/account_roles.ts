import type { AuthAccount } from '../accounts/account_store.js';

/** The slice of the resolved config the role resolution needs (structurally typed). */
type RoleResolverConfig = {
  resolveTokenRoles?: (
    account: AuthAccount,
    context: {
      clientId?: string;
      activeOrg?: { orgId: string; orgSlug: string; orgRole: string } | null;
    },
  ) => string[] | Promise<string[]>;
};

/**
 * An account's effective roles for host-side gating (the admin console).
 *
 * When the host configures `resolveTokenRoles`, that hook is the single source of an account's roles
 * — the same one the OIDC `roles` claim is minted from — so console access tracks the host's role
 * authority (e.g. an app that keeps roles in its own table via `@adonis-agora/authz`) instead of the
 * account's stored `globalRoles`. Falls back to `account.globalRoles ?? []` when no hook is set, so
 * default behavior is unchanged.
 *
 * Gates that are not tied to an OIDC client (console, maintenance mode, PAT introspection) call the
 * hook with an empty context; callers that know the client (opaque access-token introspection) pass
 * its `clientId`, matching what the token was minted with. `activeOrg` is always `null` here.
 */
export async function resolveAccountRoles(
  cfg: RoleResolverConfig,
  account: AuthAccount,
  context: { clientId?: string } = {},
): Promise<string[]> {
  if (cfg.resolveTokenRoles) {
    return cfg.resolveTokenRoles(account, { clientId: context.clientId, activeOrg: null });
  }
  return account.globalRoles ?? [];
}
