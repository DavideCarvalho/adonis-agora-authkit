/**
 * Registro de personal agents feito pelo console admin — tabela LIB-OWNED
 * `auth_agent_registry` (ver `schema/ensure.ts`). SOMA ao `defineConfig`:
 *
 * - `allowed`: o agente entra mesmo fora da lista do config (PACT: issuer + JWKS;
 *   Poppy: `client_id` registrado quando `clients.requireRegistration`).
 * - `blocked`: o agente é recusado mesmo que o config o liste — bloquear é a
 *   ação de emergência, e precisa valer sem deploy.
 *
 * O que o config bloqueia continua bloqueado: o console não desfaz o config.
 *
 * A tabela é pequena e lida em TODA verificação de agente PACT, então as linhas
 * ficam num snapshot em memória por {@link SNAPSHOT_TTL_MS}. Escritas por este
 * processo invalidam na hora; em outras instâncias o efeito chega no próximo
 * refresh — o bloqueio corta os tokens já emitidos pelo banco (grants revogados,
 * Sessions encerradas), então o atraso só vale para um agente começando do zero.
 */
import { randomBytes } from 'node:crypto';

export const REGISTRY_TABLE = 'auth_agent_registry';

export type AgentProtocolId = 'pact' | 'poppy';
export type AgentRegistryStatus = 'allowed' | 'blocked';

export interface AgentRegistryRow {
  id: string;
  protocol: AgentProtocolId;
  /** PACT: o `iss` do agente. Poppy: o `client_id` (URL do documento de metadata). */
  identifier: string;
  status: AgentRegistryStatus;
  name: string | null;
  /** JWKS do agente PACT (obrigatório num `allowed` PACT). */
  jwksUri: string | null;
  /** Conta do admin que fez a mudança. */
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Quanto tempo o snapshot vale antes de reler a tabela. */
export const SNAPSHOT_TTL_MS = 15 * 1000;

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value));
  return new Date(String(value));
}

function toRow(row: any): AgentRegistryRow {
  return {
    id: row.id,
    protocol: row.protocol,
    identifier: row.identifier,
    status: row.status,
    name: row.name ?? null,
    jwksUri: row.jwks_uri ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

const key = (protocol: AgentProtocolId, identifier: string) => `${protocol} ${identifier}`;

export class AgentRegistryStore {
  #conn: () => any;
  #now: () => number;
  #snapshot: { rows: Map<string, AgentRegistryRow>; expiresAt: number } | null = null;
  #loading: Promise<Map<string, AgentRegistryRow>> | null = null;

  constructor(conn: () => any, options: { now?: () => number } = {}) {
    this.#conn = conn;
    this.#now = options.now ?? Date.now;
  }

  /** Todas as linhas, mais recentes primeiro. Lê do banco (console). */
  async list(): Promise<AgentRegistryRow[]> {
    const rows = await this.#conn().from(REGISTRY_TABLE).orderBy('updated_at', 'desc');
    return rows.map(toRow);
  }

  /** A linha do agente, pelo snapshot. `null` = o console não diz nada sobre ele. */
  async find(protocol: AgentProtocolId, identifier: string): Promise<AgentRegistryRow | null> {
    return (await this.#rows()).get(key(protocol, identifier)) ?? null;
  }

  async findById(id: string): Promise<AgentRegistryRow | null> {
    const row = await this.#conn().from(REGISTRY_TABLE).where('id', id).first();
    return row ? toRow(row) : null;
  }

  /** Cria ou troca a linha de (protocolo, identificador). */
  async upsert(input: {
    protocol: AgentProtocolId;
    identifier: string;
    status: AgentRegistryStatus;
    name?: string | null;
    jwksUri?: string | null;
    updatedBy?: string | null;
  }): Promise<AgentRegistryRow> {
    const now = new Date(this.#now());
    const existing = await this.#conn()
      .from(REGISTRY_TABLE)
      .where('protocol', input.protocol)
      .where('identifier', input.identifier)
      .first();
    const values = {
      status: input.status,
      name: input.name ?? null,
      jwks_uri: input.jwksUri ?? null,
      updated_by: input.updatedBy ?? null,
      updated_at: now,
    };
    if (existing) {
      await this.#conn().from(REGISTRY_TABLE).where('id', existing.id).update(values);
    } else {
      await this.#conn()
        .table(REGISTRY_TABLE)
        .insert({
          id: `areg_${randomBytes(12).toString('base64url')}`,
          protocol: input.protocol,
          identifier: input.identifier,
          created_at: now,
          ...values,
        });
    }
    this.invalidate();
    const row = await this.#conn()
      .from(REGISTRY_TABLE)
      .where('protocol', input.protocol)
      .where('identifier', input.identifier)
      .first();
    return toRow(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.#conn().from(REGISTRY_TABLE).where('id', id).delete();
    this.invalidate();
    return (typeof result === 'number' ? result : Array.isArray(result) ? result.length : 0) > 0;
  }

  invalidate(): void {
    this.#snapshot = null;
  }

  async #rows(): Promise<Map<string, AgentRegistryRow>> {
    const now = this.#now();
    if (this.#snapshot && this.#snapshot.expiresAt > now) return this.#snapshot.rows;
    if (!this.#loading) {
      this.#loading = (async (): Promise<Map<string, AgentRegistryRow>> => {
        try {
          const rows: AgentRegistryRow[] = (await this.#conn().from(REGISTRY_TABLE)).map(toRow);
          const map = new Map<string, AgentRegistryRow>(
            rows.map((r) => [key(r.protocol, r.identifier), r]),
          );
          this.#snapshot = { rows: map, expiresAt: this.#now() + SNAPSHOT_TTL_MS };
          return map;
        } catch {
          // Banco fora (ou tabela ainda não criada): fica com o último snapshot, ou
          // nenhum — o config continua valendo sozinho. Tenta de novo logo.
          const rows = this.#snapshot?.rows ?? new Map<string, AgentRegistryRow>();
          this.#snapshot = { rows, expiresAt: this.#now() + 1000 };
          return rows;
        } finally {
          this.#loading = null;
        }
      })();
    }
    return this.#loading!;
  }
}
