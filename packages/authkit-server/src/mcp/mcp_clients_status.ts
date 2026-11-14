/**
 * O estado do login de clientes MCP como o console admin e a CLI mostram: ligado/desligado e por
 * quê, os resources registrados, o que a config travou, e quantos clientes MCP existem.
 */
import { AdminClientsService } from '../host/admin_clients_service.js';
import type { OidcService } from '../provider/oidc_service.js';
import { describeMcpClientsState, type McpClientsState, mcpClientsState } from './mcp_clients.js';

export interface McpClientsStatus extends McpClientsState {
  /** Uma linha legível ("on (automatic — resources: /mcp/agora; …)"). */
  summary: string;
  /** O que a config decide. */
  config: {
    /** `'mcp'`: registro MCP; `'app'`: o `dynamicRegistration` do app manda; `'off'`. */
    dynamicRegistration: 'mcp' | 'app' | 'off';
    metadataDocuments: boolean;
    allowHosts: string[] | null;
  };
  clients: {
    /** Clients registrados pelo `/reg`; `null` quando o adapter não enumera. */
    dynamic: number | null;
    /** Clientes por Client ID Metadata Document em cache neste processo. */
    metadataDocuments: number;
  };
}

export async function buildMcpClientsStatus(oidc: OidcService): Promise<McpClientsStatus> {
  const cfg = oidc.config.mcpClients;
  const state = await mcpClientsState(cfg);
  const svc = new AdminClientsService(oidc);
  const dynamic = svc.canList
    ? (await svc.list()).filter((c) => c.dynamicallyRegistered).length
    : null;
  return {
    ...state,
    summary: describeMcpClientsState(state),
    config: {
      dynamicRegistration: cfg.dynamicRegistration,
      metadataDocuments: cfg.metadataDocuments !== null,
      allowHosts: cfg.metadataDocuments?.allowHosts ?? null,
    },
    clients: { dynamic, metadataDocuments: oidc.metadataDocuments?.cached().length ?? 0 },
  };
}
