import type { ClientConfig } from '@adonis-agora/authkit-core';
import type {
  AdminClientsService,
  TokenEndpointAuthMethod,
} from '../host/admin_clients_service.js';

/** Resultado da importação de um client individual. */
export type ClientImportOutcome = 'created' | 'skipped' | 'error';

/** Linha de relatório por client. */
export interface ClientImportEntry {
  clientId: string;
  outcome: ClientImportOutcome;
  /** Razão do erro ou 'already exists' no caso de skip. */
  reason?: string;
  /**
   * Secret gerado (em claro, mostrado UMA vez) — presente apenas em `created` e
   * somente quando o client é confidencial. Não recuperável depois.
   */
  clientSecret?: string;
}

/** Relatório agregado da operação. */
export interface ClientsImportReport {
  created: number;
  skipped: number;
  errors: number;
  entries: ClientImportEntry[];
}

/**
 * Importa a lista de clients estáticos do config para o adapter/DB via
 * {@link AdminClientsService}. Idempotente: clients cujo `client_id` já existe no
 * adapter são pulados (preservando o secret original). O `client_secret` do config
 * estático é PRESERVADO na criação (passado diretamente como `clientId` ficará com
 * o secret original). Para clients sem secret (public), `clientSecret` fica omitido.
 *
 * A função é PURA quanto a I/O do config (recebe os records já parseados) —
 * testável em isolamento. O único I/O é via `svc` (adapter).
 *
 * @param clients - Lista de {@link ClientConfig} vindos de `config.clients`.
 * @param svc     - Serviço admin de clients (CRUD sobre o adapter).
 * @param options - `dryRun`: não persiste, só relata o que SERIA feito.
 */
export async function importClients(
  clients: ClientConfig[],
  svc: AdminClientsService,
  options: { dryRun?: boolean } = {},
): Promise<ClientsImportReport> {
  const report: ClientsImportReport = { created: 0, skipped: 0, errors: 0, entries: [] };

  for (const client of clients) {
    const clientId = client.clientId;

    // Verifica se já existe no adapter.
    let exists = false;
    try {
      const found = await svc.find(clientId);
      exists = !!found;
    } catch (err) {
      report.errors++;
      report.entries.push({
        clientId,
        outcome: 'error',
        reason: `falha ao verificar existência: ${(err as Error).message}`,
      });
      continue;
    }

    if (exists) {
      report.skipped++;
      report.entries.push({ clientId, outcome: 'skipped', reason: 'already exists' });
      continue;
    }

    if (options.dryRun) {
      // Dry-run: conta como "would create" sem persistir.
      report.created++;
      report.entries.push({ clientId, outcome: 'created' });
      continue;
    }

    // Determina o auth method a partir do config estático.
    const authMethod: TokenEndpointAuthMethod =
      client.tokenEndpointAuthMethod ?? (client.clientSecret ? 'client_secret_basic' : 'none');

    try {
      // Cria via AdminClientsService, que usa o mesmo caminho do console admin / registro dinâmico.
      // Para preservar o client_secret do config estático, escrevemos diretamente via adapter —
      // o `svc.create` gera um secret aleatório. Usamos a API interna do svc para construir o
      // payload com o secret original e persistir.
      const preservedSecret = client.clientSecret;
      const created = await svc.createWithSecret(
        {
          clientId,
          redirectUris: client.redirectUris ?? [],
          postLogoutRedirectUris: client.postLogoutRedirectUris ?? [],
          grantTypes: client.grants ?? ['authorization_code', 'refresh_token'],
          tokenEndpointAuthMethod: authMethod,
          backchannelLogoutUri: client.backchannelLogoutUri,
          backchannelLogoutSessionRequired: client.backchannelLogoutSessionRequired,
        },
        preservedSecret,
      );

      report.created++;
      report.entries.push({
        clientId,
        outcome: 'created',
        clientSecret: created.clientSecret,
      });
    } catch (err) {
      report.errors++;
      report.entries.push({
        clientId,
        outcome: 'error',
        reason: (err as Error).message,
      });
    }
  }

  return report;
}
