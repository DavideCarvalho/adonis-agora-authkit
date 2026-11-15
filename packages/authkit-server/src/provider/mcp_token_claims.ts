import type { AuthAccount } from '../accounts/account_store.js';

/**
 * Claims de usuário nos access tokens de servidores MCP (os de `mcpClients.resources` e os
 * registrados com `registerOAuthResource`).
 *
 * Um servidor MCP em OUTRO processo só enxerga o token: sem os papéis nele, um console protegido
 * por papel recusa quem chega pelo MCP. Por isso:
 *   - os papéis (`globalRolesClaim`) vão sempre — da mesma fonte do id_token
 *     (`resolveTokenRoles` ou `globalRoles`);
 *   - o email vai só quando o escopo `email` foi concedido.
 *
 * O token é amarrado ao resource (`aud`), então esses dados só valem para aquele servidor.
 */
export interface McpTokenClaimsDeps {
  findAccount: (sub: string) => Promise<AuthAccount | null>;
  globalRolesClaim: string;
  resolveTokenRoles?: (
    account: AuthAccount,
    context: {
      clientId?: string;
      activeOrg?: { orgId: string; orgSlug: string; orgRole: string } | null;
    },
  ) => string[] | Promise<string[]>;
  /** `true` quando `audience` é um servidor MCP conhecido agora. */
  isMcpResource: (audience: string) => boolean | Promise<boolean>;
}

interface TokenLike {
  kind?: string;
  accountId?: string;
  scope?: string;
  clientId?: string;
  resourceServer?: { audience?: string | string[] };
}

export async function mcpTokenClaims(
  token: unknown,
  deps: McpTokenClaimsDeps,
): Promise<Record<string, unknown> | undefined> {
  const t = token as TokenLike | null | undefined;
  if (!t || t.kind !== 'AccessToken' || !t.accountId) return undefined;
  const raw = t.resourceServer?.audience;
  const audience = Array.isArray(raw) ? raw[0] : raw;
  if (typeof audience !== 'string' || !audience) return undefined;
  if (!(await deps.isMcpResource(audience))) return undefined;

  const account = await deps.findAccount(t.accountId);
  if (!account) return undefined;

  const roles = deps.resolveTokenRoles
    ? await deps.resolveTokenRoles(account, { clientId: t.clientId, activeOrg: null })
    : (account.globalRoles ?? []);
  const claims: Record<string, unknown> = { [deps.globalRolesClaim]: roles };
  const scopes = new Set((t.scope ?? '').split(' ').filter(Boolean));
  if (scopes.has('email') && account.email) claims.email = account.email;
  return claims;
}
