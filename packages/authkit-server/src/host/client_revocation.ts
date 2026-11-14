/**
 * Revogar um client: desabilita (quando tem cadastro — um cliente MCP por Client ID Metadata
 * Document não tem) e corta os grants e tokens dele em TODAS as contas. É o que o console
 * (botão "Revoke") e `node ace authkit:client revoke` fazem.
 */
import type { OidcService } from '../provider/oidc_service.js';
import { AdminClientsService } from './admin_clients_service.js';
import { AdminSessionsService, type RevokeResult } from './admin_sessions_service.js';

export interface ClientRevocation extends RevokeResult {
  clientId: string;
  /** Há um cadastro do client (e ele foi desabilitado). */
  stored: boolean;
}

export async function revokeClient(
  oidc: OidcService,
  clientId: string,
  options: {
    actorId: string | null;
    source: 'admin-console' | 'admin-api' | 'cli';
    ip?: string | null;
  },
): Promise<ClientRevocation> {
  const stored = await new AdminClientsService(oidc).setDisabled(clientId, true);
  const revoked = await new AdminSessionsService(oidc).revokeAllClientGrants(clientId);
  const result: ClientRevocation = { clientId, stored, ...revoked };
  await oidc.config.audit?.record({
    type: 'client.revoked',
    clientId,
    actorId: options.actorId,
    ip: options.ip ?? null,
    metadata: {
      source: options.source,
      stored,
      grants: revoked.grants,
      accessTokens: revoked.accessTokens,
      refreshTokens: revoked.refreshTokens,
    },
  });
  return result;
}
