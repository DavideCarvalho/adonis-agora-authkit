/**
 * Runtime Settings — mecanismo genérico de configuração persistida em banco.
 *
 * A tabela `auth_settings` é OPCIONAL (capability-probed via SELECT tentativo).
 * Se a tabela não existir, todas as operações retornam null/empty sem erro — os
 * callers devem usar o fallback de config estático. A leitura usa cache em
 * memória com TTL curto (default 15s) para eliminar overhead por request; o
 * método `invalidate()` limpa o cache imediatamente (chamado após escrita).
 *
 * FAIL-SAFE TOTAL: qualquer erro de DB ou de probe → null + caller usa config.
 * Disponibilidade > proteção, consistente com o padrão de bot-protection.
 *
 * PROBE SEARCHPATH-AWARE: o probe usa `SELECT key FROM auth_settings LIMIT 1`
 * em vez de `schema.hasTable`, que ignora o search_path do Postgres. Assim,
 * quando a tabela existe num schema nomeado (ex.: `auth` com searchPath), o
 * probe detecta corretamente.
 *
 * CONEXÃO NOMEADA: quando `options.connection` for fornecido, todas as queries
 * usam `db.connection(name)` em vez da conexão default — necessário quando o
 * auth vive num schema/conexão separados (ex.: host com `auth` connection).
 *
 * ESCOPO DE ORG: settings podem ser globais (organization_id NULL) ou escopadas
 * a uma organização (organization_id = uuid). A resolução efetiva segue a cadeia
 * org → global → null, implementada em `getEffective(key, orgId?)`.
 *
 * Keys org-scopáveis: `organizations_policy`, `roles_catalog`.
 * As demais keys são GLOBAIS (a UI não oferece escopo por org para elas).
 *
 * @example
 * ```ts
 * const settings = new RuntimeSettings(db)
 * const raw = await settings.getSetting('bot_protection')
 * // raw é `unknown | null`. Null = tabela ausente ou key inexistente.
 * const botSetting = raw as BotProtectionSetting | null
 *
 * // Resolução org→global→null:
 * const effective = await settings.getEffective('organizations_policy', orgId)
 * ```
 *
 * Schema esperado da tabela `auth_settings`:
 * ```sql
 * CREATE TABLE auth_settings (
 *   key             TEXT NOT NULL,
 *   organization_id TEXT,               -- NULL = global
 *   value           TEXT NOT NULL,      -- JSON
 *   updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 *   updated_by      TEXT,               -- nullable accountId do admin
 *   UNIQUE (key, organization_id)       -- NULL tratado como distinct via UNIQUE NULLS NOT DISTINCT
 *                                       -- ou via unique index parcial (ver migração)
 * );
 * ```
 */

import type { HttpContext } from '@adonisjs/core/http';
import { isSettingLocked, SettingLockedError } from './config_locks.js';

/** Uma entrada da tabela `auth_settings`. */
export interface SettingRow {
  key: string;
  organizationId: string | null;
  value: unknown; // JSON parseado
  updatedAt: Date | string | null;
  updatedBy: string | null;
}

/**
 * Capacidade de runtime settings. Presente quando a tabela `auth_settings`
 * existe. Use `supportsSettings` para verificar em runtime.
 */
export interface SettingsCapability {
  /**
   * Lê uma key no escopo especificado (global se orgId omitido).
   * Retorna null se ausente ou tabela inexistente. Usa cache TTL.
   */
  getSetting(key: string, orgId?: string | null): Promise<unknown | null>;
  /**
   * Grava (upsert) uma key no escopo especificado.
   * Invalida o cache para essa (key, orgId).
   */
  setSetting(
    key: string,
    value: unknown,
    updatedBy?: string | null,
    orgId?: string | null,
  ): Promise<void>;
  /** Remove uma key no escopo especificado. Invalida o cache. */
  deleteSetting(key: string, orgId?: string | null): Promise<void>;
  /** Lista settings. Sem orgId = todas; com orgId = apenas escopo da org. */
  listSettings(orgId?: string | null): Promise<SettingRow[]>;
  /**
   * Resolve efetivamente: org-setting → global-setting → null.
   * Sem orgId equivale a getSetting(key) (global apenas).
   */
  getEffective(key: string, orgId?: string | null): Promise<unknown | null>;
}

/**
 * Type guard: o objeto (store ou serviço) expõe SettingsCapability?
 */
export function supportsSettings(obj: unknown): obj is SettingsCapability {
  return !!obj && typeof (obj as any).getSetting === 'function';
}

export interface RuntimeSettingsOptions {
  /** TTL do cache em ms. Default: 15_000 (15s). */
  ttlMs?: number;
  /**
   * Nome da conexão Lucid a usar (ex.: 'auth'). Quando presente, todas as
   * queries usam `db.connection(name)` em vez da conexão default. Necessário
   * quando o schema de auth vive numa conexão nomeada com searchPath próprio.
   * Ausente (ou undefined) → conexão default (back-compat total).
   */
  connection?: string;
}

type CacheEntry = { value: unknown | null; expiresAt: number };

/** Chave de cache: combina key + escopo de org (null = global). */
function cacheKey(key: string, orgId: string | null | undefined): string {
  return orgId ? `${key}\x00${orgId}` : key;
}

/**
 * Implementação default do SettingsCapability sobre um `Database` Lucid.
 *
 * Tabela esperada: ver módulo JSDoc acima.
 */
export class RuntimeSettings implements SettingsCapability {
  private readonly db: any;
  private readonly ttlMs: number;
  private readonly connectionName: string | undefined;
  private cache = new Map<string, CacheEntry>();
  /** null = não foi verificado ainda; false = tabela ausente; true = presente */
  private tablePresent: boolean | null = null;

  constructor(db: any, opts: RuntimeSettingsOptions = {}) {
    this.db = db;
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.connectionName = opts.connection;
  }

  /**
   * Retorna o objeto de conexão Lucid correto.
   * Quando `connectionName` está definido, usa `db.connection(name)`;
   * caso contrário usa o `db` diretamente (conexão default).
   */
  private conn(): any {
    return this.connectionName ? this.db.connection(this.connectionName) : this.db;
  }

  /**
   * Verifica (e memoriza) se a tabela `auth_settings` existe.
   *
   * Usa `SELECT key FROM auth_settings LIMIT 1` em vez de `schema.hasTable`
   * para ser searchPath-aware: `schema.hasTable` no Postgres ignora o
   * search_path e reporta "ausente" quando a tabela existe apenas no schema
   * configurado via searchPath da conexão. A tentativa de SELECT em try/catch
   * detecta a tabela corretamente independente do schema.
   *
   * Fail-safe: qualquer erro → false (tabela considerada ausente, sem lançar).
   */
  private async hasTable(): Promise<boolean> {
    if (this.tablePresent !== null) return this.tablePresent;
    try {
      await this.conn().from('auth_settings').select('key').limit(1);
      this.tablePresent = true;
      return true;
    } catch {
      this.tablePresent = false;
      return false;
    }
  }

  async getSetting(key: string, orgId?: string | null): Promise<unknown | null> {
    // Travada por defineConfig → comporta-se como ausente, então os resolvers caem
    // no configDefault (= o valor do config). Config vence; a UI não pode sobrescrever.
    if (isSettingLocked(key)) return null;

    const ck = cacheKey(key, orgId ?? null);
    // Cache hit?
    const cached = this.cache.get(ck);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (!(await this.hasTable())) {
      this._cache(ck, null);
      return null;
    }

    try {
      let q = this.conn().from('auth_settings').where('key', key);
      if (orgId) {
        q = q.where('organization_id', orgId);
      } else {
        q = q.whereNull('organization_id');
      }
      const row = await q.first();
      const value = row ? this._parse(row.value) : null;
      this._cache(ck, value);
      return value;
    } catch {
      // FAIL-SAFE: erro de DB → null, caller usa config estático.
      this._cache(ck, null);
      return null;
    }
  }

  /**
   * Resolve efetivamente: org-setting → global-setting → null.
   * Se orgId não fornecido, equivale a getSetting(key) (global apenas).
   */
  async getEffective(key: string, orgId?: string | null): Promise<unknown | null> {
    if (orgId) {
      const orgValue = await this.getSetting(key, orgId);
      if (orgValue !== null) return orgValue;
    }
    return this.getSetting(key, null);
  }

  async setSetting(
    key: string,
    value: unknown,
    updatedBy: string | null = null,
    orgId?: string | null,
  ): Promise<void> {
    // Travada por defineConfig → recusa a escrita (write path da Admin API/console mapeia p/ 423).
    if (isSettingLocked(key)) throw new SettingLockedError(key);
    if (!(await this.hasTable())) return;
    const json = JSON.stringify(value);
    const resolvedOrgId = orgId ?? null;
    try {
      // Delete first then insert = upsert (compatível com sqlite + pg sem UPSERT syntax).
      let q = this.conn().from('auth_settings').where('key', key);
      if (resolvedOrgId) {
        q = q.where('organization_id', resolvedOrgId);
      } else {
        q = q.whereNull('organization_id');
      }
      await q.delete();
      await this.conn().table('auth_settings').insert({
        key,
        organization_id: resolvedOrgId,
        value: json,
        updated_at: new Date(),
        updated_by: updatedBy,
      });
    } catch {
      // Fail-safe: não lança.
    }
    this.invalidate(key, resolvedOrgId);
  }

  async deleteSetting(key: string, orgId?: string | null): Promise<void> {
    if (isSettingLocked(key)) throw new SettingLockedError(key);
    if (!(await this.hasTable())) return;
    const resolvedOrgId = orgId ?? null;
    try {
      let q = this.conn().from('auth_settings').where('key', key);
      if (resolvedOrgId) {
        q = q.where('organization_id', resolvedOrgId);
      } else {
        q = q.whereNull('organization_id');
      }
      await q.delete();
    } catch {
      // Fail-safe.
    }
    this.invalidate(key, resolvedOrgId);
  }

  async listSettings(orgId?: string | null): Promise<SettingRow[]> {
    if (!(await this.hasTable())) return [];
    try {
      let q = this.conn().from('auth_settings').select('*');
      if (orgId !== undefined) {
        // orgId fornecido: filtra pelo escopo
        if (orgId) {
          q = q.where('organization_id', orgId);
        } else {
          q = q.whereNull('organization_id');
        }
      }
      // orgId undefined = lista tudo (global + todos os orgs)
      const rows = await q;
      return rows.map(
        (r: any): SettingRow => ({
          key: r.key,
          organizationId: r.organization_id ?? null,
          value: this._parse(r.value),
          updatedAt: r.updated_at ?? null,
          updatedBy: r.updated_by ?? null,
        }),
      );
    } catch {
      return [];
    }
  }

  /**
   * Verifica se a tabela `auth_settings` está presente (mesmo resultado de
   * `hasTable()` privado, mas exposto para casos de diagnóstico como a UI admin).
   */
  async isTablePresent(): Promise<boolean> {
    return this.hasTable();
  }

  /**
   * Invalida o cache em memória. Sem argumento: limpa tudo.
   * Chamado AUTOMATICAMENTE após setSetting/deleteSetting.
   * Chame externamente após writes que contornam este serviço.
   */
  invalidate(key?: string, orgId?: string | null): void {
    if (key !== undefined) {
      this.cache.delete(cacheKey(key, orgId ?? null));
    } else {
      this.cache.clear();
    }
  }

  private _cache(key: string, value: unknown | null): void {
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  private _parse(raw: string | null | undefined): unknown | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/**
 * Fábrica canônica de {@link RuntimeSettings} a partir de um `HttpContext`.
 *
 * Resolve o `lucid.db` e o `authkit.server` do container, deriva a conexão
 * nomeada do `accountStore` (para que o probe da tabela `auth_settings` seja
 * searchPath-aware quando o auth vive numa conexão/schema próprios) e monta o
 * `RuntimeSettings`.
 *
 * FAIL-SAFE → null: qualquer erro de resolução (DB ausente, serviço não
 * registrado, etc.) retorna `null` em vez de lançar. Os callers usam o `null`
 * tanto como sinal de "settings runtime indisponíveis" (caem no config estático)
 * quanto, em alguns endpoints, como sinal de `capability_unsupported` (404) — a
 * semântica do `!rs`/`!svc` de cada caller é preservada.
 *
 * Esta fábrica SUBSTITUI ~16 cópias do mesmo bloco db/connection que viviam sob
 * nomes distintos (`getRuntimeSettings`, `getSettingsService`,
 * `getRuntimeSettingsForSudo`) e elimina o cast `as any` (via `connectionName`
 * tipado em {@link AccountStore}).
 *
 * @example
 * ```ts
 * const rs = await resolveRuntimeSettings(ctx)
 * if (!rs) return response.notFound({ error: 'capability_unsupported' })
 * ```
 */
export async function resolveRuntimeSettings(ctx: HttpContext): Promise<RuntimeSettings | null> {
  try {
    const db = await ctx.containerResolver.make('lucid.db');
    const service = await ctx.containerResolver.make('authkit.server').catch(() => null);
    const connection = service?.config?.accountStore?.connectionName;
    return new RuntimeSettings(db, connection ? { connection } : {});
  } catch {
    return null;
  }
}

/**
 * Variante NON-NULL de {@link resolveRuntimeSettings}: quando a resolução falha
 * (DB ausente, serviço não registrado), devolve um {@link RuntimeSettings} no-op
 * cujo probe de tabela lança — logo `hasTable()` vira false e TODA leitura
 * retorna null, fazendo os resolvers caírem no config estático.
 *
 * Use esta quando o chamador precisa passar um `SettingsCapability` non-null
 * adiante (é o caso dos gates de login, que só rodam as checagens de expiração
 * quando recebem `settings`). Use {@link resolveRuntimeSettings} quando o `null`
 * carrega semântica própria (ex.: responder `capability_unsupported`).
 *
 * Vive AQUI, e não em um controller, porque é sobre runtime settings — o
 * `interaction_controller` e o `social_controller` a compartilham; uma segunda
 * cópia da degradação no-op é como as duas divergem.
 */
export async function resolveRuntimeSettingsOrNoop(ctx: HttpContext): Promise<RuntimeSettings> {
  const rs = await resolveRuntimeSettings(ctx);
  return (
    rs ??
    new RuntimeSettings({
      table: () => {
        throw new Error('no-op');
      },
    })
  );
}
