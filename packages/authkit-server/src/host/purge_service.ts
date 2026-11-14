/**
 * Limpeza do que o IdP acumula: artefatos OIDC expirados ou consumidos (tokens, códigos, grants,
 * sessões, interactions) e clients do registro dinâmico que ninguém usa. É o que
 * `node ace authkit:purge` roda — seguro para um cron: nada vivo é apagado.
 *
 *   - expirados: só onde o backend não expira sozinho (banco; no Redis o TTL já apaga);
 *   - consumidos: códigos/refresh tokens já usados que continuam até o TTL (`consumed` no payload);
 *   - clients: registrados pelo `/reg` há mais de `olderThanDays` e sem nenhum grant vivo.
 */
import type { OidcAdapter } from '../adapters/adapter_contract.js';
import { pickModelAdapterClass } from '../adapters/factory.js';
import type { OidcService } from '../provider/oidc_service.js';
import { AdminClientsService } from './admin_clients_service.js';
import { AdminSessionsService } from './admin_sessions_service.js';

export const PURGE_KINDS = ['tokens', 'grants', 'sessions', 'interactions', 'clients'] as const;
export type PurgeKind = (typeof PURGE_KINDS)[number];

/** Os models do oidc-provider de cada tipo. */
const MODELS: Record<Exclude<PurgeKind, 'clients'>, string[]> = {
  tokens: [
    'AccessToken',
    'AuthorizationCode',
    'RefreshToken',
    'DeviceCode',
    'ClientCredentials',
    'BackchannelAuthenticationRequest',
    'PushedAuthorizationRequest',
    'RegistrationAccessToken',
    'InitialAccessToken',
    'ReplayDetection',
  ],
  grants: ['Grant'],
  sessions: ['Session'],
  interactions: ['Interaction'],
};

export interface PurgeOptions {
  /** Default: todos. */
  kinds?: readonly PurgeKind[];
  /** Clients do `/reg` mais velhos que isto (dias) e sem grant vivo. Default: 30. */
  olderThanDays?: number;
  /** Só conta. */
  dryRun?: boolean;
  now?: () => Date;
}

export interface PurgeReport {
  dryRun: boolean;
  /** Linhas expiradas, por tipo. */
  expired: Record<string, number>;
  /** Artefatos consumidos, por tipo. */
  consumed: Record<string, number>;
  /** Clients do registro dinâmico sem uso (os ids). */
  clients: string[];
  total: number;
}

export class PurgeService {
  #oidc: OidcService;

  constructor(oidc: OidcService) {
    this.#oidc = oidc;
  }

  #adapter(model: string): OidcAdapter {
    const { AdapterClass, SessionAdapterClass } = this.#oidc.config;
    return new (pickModelAdapterClass(model, AdapterClass, SessionAdapterClass ?? AdapterClass))(
      model,
    ) as OidcAdapter;
  }

  async run(options: PurgeOptions = {}): Promise<PurgeReport> {
    const kinds = new Set(options.kinds?.length ? options.kinds : PURGE_KINDS);
    const dryRun = options.dryRun === true;
    const report: PurgeReport = { dryRun, expired: {}, consumed: {}, clients: [], total: 0 };

    for (const kind of ['tokens', 'grants', 'sessions', 'interactions'] as const) {
      if (!kinds.has(kind)) continue;
      let expired = 0;
      let consumed = 0;
      for (const model of MODELS[kind]) {
        const adapter = this.#adapter(model);
        if (adapter.purgeExpired) expired += await adapter.purgeExpired({ dryRun });
        if (kind === 'tokens' && adapter.list) {
          for (const row of await adapter.list()) {
            if (!row.payload.consumed) continue;
            consumed += 1;
            if (!dryRun) await adapter.destroy(row.id);
          }
        }
      }
      report.expired[kind] = expired;
      if (kind === 'tokens') report.consumed[kind] = consumed;
      report.total += expired + consumed;
    }

    if (kinds.has('clients')) {
      const clients = new AdminClientsService(this.#oidc);
      if (clients.canList) {
        const cutoff =
          (options.now?.() ?? new Date()).getTime() - (options.olderThanDays ?? 30) * 86_400_000;
        const inUse = await new AdminSessionsService(this.#oidc).clientIdsWithGrants();
        for (const client of await clients.list()) {
          if (!client.dynamicallyRegistered || !client.registeredAt) continue;
          if (client.registeredAt.getTime() > cutoff || inUse.has(client.clientId)) continue;
          report.clients.push(client.clientId);
          if (!dryRun) await clients.delete(client.clientId);
        }
      }
      report.total += report.clients.length;
    }
    return report;
  }
}

/** `30d`, `12h`, `2w`, ou um número de dias → dias. `null` se inválido. */
export function parseOlderThan(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([dhw]?)$/i.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  return unit === 'h' ? n / 24 : unit === 'w' ? n * 7 : n;
}
