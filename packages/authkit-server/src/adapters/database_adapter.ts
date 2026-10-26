import type { Database } from '@adonisjs/lucid/database';
import type { EnumeratedArtifact, OidcAdapter, OidcPayload } from './adapter_contract.js';

const TABLE = 'authkit_oidc_payloads';

/** Intervalo mínimo, por conexão, entre duas limpezas das linhas expiradas. */
const PRUNE_INTERVAL_MS = 10 * 60_000;
/** Quanto tempo a ausência da coluna `account_id` vale antes de re-checar. */
const ACCOUNT_COLUMN_RECHECK_MS = 60_000;
/** Tamanho máximo de uma lista `IN (...)`. */
const IN_CHUNK = 500;

/**
 * Estado por conexão (todas as instâncias — uma por model — sobre o mesmo `db`):
 * se a coluna `account_id` existe (instalações que gerenciam o schema à mão podem
 * ainda não tê-la) e quando a próxima limpeza de expirados pode rodar.
 */
interface ConnectionState {
  accountColumn: boolean | null;
  accountColumnRecheckAt: number;
  nextPruneAt: number;
  /** Nome do dialeto Lucid (`undefined` = ainda não lido, `null` = desconhecido). */
  dialect?: string | null;
}

const connectionStates = new WeakMap<object, ConnectionState>();

function connectionState(db: object): ConnectionState {
  let state = connectionStates.get(db);
  if (!state) {
    state = { accountColumn: null, accountColumnRecheckAt: 0, nextPruneAt: 0 };
    connectionStates.set(db, state);
  }
  return state;
}

/** Dialetos que gravam `expires_at` como texto ISO-8601 (comparado lexicograficamente). */
const TEXT_TIMESTAMP_DIALECTS: ReadonlySet<string> = new Set([
  'sqlite3',
  'better-sqlite3',
  'libsql',
]);

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

export class DatabaseAdapter implements OidcAdapter {
  constructor(
    private name: string,
    private db: Database,
  ) {}

  #query() {
    return this.db.query().from(TABLE).where('model_name', this.name);
  }

  /**
   * Valor de `expires_at` (gravação e comparação) para o dialeto da conexão. No
   * SQLite a coluna guarda texto ISO-8601 (o driver gravaria um `Date` como número,
   * que não se compara com o texto já gravado); nos demais vai um `Date`, que o
   * driver serializa no formato do banco — o MySQL recusa o ISO com `Z`.
   */
  #timestamp(ms: number): Date | string {
    const state = connectionState(this.db);
    if (state.dialect === undefined) {
      // O factory passa o manager (`Database`) ou um `QueryClient` de conexão nomeada.
      const db = this.db as any;
      const client = typeof db.connection === 'function' ? db.connection() : db;
      state.dialect = client?.dialect?.name ?? null;
    }
    const dialect = state.dialect;
    return !dialect || TEXT_TIMESTAMP_DIALECTS.has(dialect)
      ? new Date(ms).toISOString()
      : new Date(ms);
  }

  /** `#query()` restrito às linhas não expiradas. */
  #liveQuery() {
    const now = this.#timestamp(Date.now());
    return this.#query().where((q: any) =>
      q.whereNull('expires_at').orWhere('expires_at', '>', now),
    );
  }

  /**
   * A coluna `account_id` existe? Probe por SELECT (searchPath-aware, como o
   * `ensureAuthkitSchema`). "Presente" vale pela vida do processo; "ausente" é
   * re-checado, para pegar o ALTER do boot que rodou depois do primeiro request.
   */
  async #hasAccountColumn(): Promise<boolean> {
    const state = connectionState(this.db);
    if (state.accountColumn === true) return true;
    if (state.accountColumn === false && state.accountColumnRecheckAt > Date.now()) return false;
    try {
      await this.db.query().from(TABLE).select('account_id').limit(1);
      state.accountColumn = true;
    } catch {
      state.accountColumn = false;
      state.accountColumnRecheckAt = Date.now() + ACCOUNT_COLUMN_RECHECK_MS;
    }
    return state.accountColumn;
  }

  /**
   * Apaga as linhas expiradas de todos os models (no máximo uma vez por
   * {@link PRUNE_INTERVAL_MS} por conexão). Linha expirada já é invisível para
   * `find`/`list`; a limpeza só impede a tabela de crescer sem limite. Roda fora
   * do caminho do request e nunca lança.
   */
  #maybePrune(): void {
    const state = connectionState(this.db);
    const now = Date.now();
    if (state.nextPruneAt > now) return;
    state.nextPruneAt = now + PRUNE_INTERVAL_MS;
    Promise.resolve()
      .then(() =>
        this.db
          .query()
          .from(TABLE)
          .whereNotNull('expires_at')
          .where('expires_at', '<=', this.#timestamp(now))
          .delete(),
      )
      .catch(() => {});
  }

  async upsert(id: string, payload: OidcPayload, expiresIn: number): Promise<void> {
    const expiresAt = expiresIn ? this.#timestamp(Date.now() + expiresIn * 1000) : null;
    const row: Record<string, unknown> = {
      id,
      model_name: this.name,
      payload: JSON.stringify(payload),
      grant_id: (payload.grantId as string) ?? null,
      user_code: (payload.userCode as string) ?? null,
      uid: (payload.uid as string) ?? null,
      expires_at: expiresAt,
    };
    if (await this.#hasAccountColumn()) {
      // NULL = "sem conta conhecida": as buscas por conta também leem essas linhas
      // (e as classificam), então uma linha escrita sem a coluna nunca fica de fora.
      const accountId = payload.accountId;
      row.account_id = typeof accountId === 'string' && accountId ? accountId : null;
    }
    const existing = await this.#query().where('id', id).first();
    if (existing) {
      await this.#query().where('id', id).update(row);
    } else {
      await this.db.table(TABLE).insert(row);
    }
    this.#maybePrune();
  }

  async #parse(record: any): Promise<OidcPayload | undefined> {
    if (!record) return undefined;
    if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
      return undefined;
    }
    return JSON.parse(record.payload) as OidcPayload;
  }

  async renewSession(id: string, expiresIn: number): Promise<boolean> {
    if (this.name !== 'Session' || !Number.isSafeInteger(expiresIn) || expiresIn < 1) return false;
    const row = await this.#query().where('id', id).first();
    const payload = await this.#parse(row);
    const now = Date.now();
    if (
      !payload ||
      payload.transient ||
      typeof payload.exp !== 'number' ||
      payload.exp <= now / 1000
    )
      return false;
    // Compare-and-set: concurrent logout or mutation cannot be undone by renewal.
    const changed = await this.#query()
      .where('id', id)
      .where('payload', row.payload)
      .where('expires_at', '>', this.#timestamp(now))
      .update({
        payload: JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + expiresIn }),
        expires_at: this.#timestamp(now + expiresIn * 1000),
      });
    if (Number(changed) > 0) return true;
    // A parallel renewal is harmless; a deletion must remain deleted.
    const current = await this.find(id);
    return Boolean(
      current && !current.transient && typeof current.exp === 'number' && current.exp > now / 1000,
    );
  }

  async find(id: string): Promise<OidcPayload | undefined> {
    return this.#parse(await this.#query().where('id', id).first());
  }

  async findByUid(uid: string): Promise<OidcPayload | undefined> {
    return this.#parse(await this.#query().where('uid', uid).first());
  }

  async findByUserCode(userCode: string): Promise<OidcPayload | undefined> {
    return this.#parse(await this.#query().where('user_code', userCode).first());
  }

  async consume(id: string): Promise<void> {
    const found = await this.find(id);
    if (!found) return;
    found.consumed = Math.floor(Date.now() / 1000);
    await this.#query()
      .where('id', id)
      .update({ payload: JSON.stringify(found) });
  }

  async destroy(id: string): Promise<void> {
    await this.#query().where('id', id).delete();
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.db.query().from(TABLE).where('grant_id', grantId).delete();
  }

  /**
   * Enumeração genérica dos artefatos do model deste adapter (id + payload).
   * Filtra por `model_name = this.name` e descarta linhas expiradas. Usada pelo
   * console admin para listar `Client` (CRUD) e `Session`/`Grant`/tokens.
   */
  async list(): Promise<EnumeratedArtifact[]> {
    return this.#toArtifacts(await this.#liveQuery().orderBy('id', 'asc'));
  }

  /**
   * Artefatos vivos da conta, pelo índice `(model_name, account_id)`. As linhas com
   * `account_id` NULL (gravadas antes da coluna existir, ou por uma versão anterior
   * da lib durante um deploy) entram na leitura; o filtro final é sempre o
   * `payload.accountId`, e as NULL que têm conta no payload são classificadas aqui,
   * para não serem relidas na próxima busca.
   */
  async listByAccount(accountId: string): Promise<EnumeratedArtifact[]> {
    if (!(await this.#hasAccountColumn())) {
      return (await this.list()).filter((r) => r.payload.accountId === accountId);
    }
    const rows = await this.#liveQuery()
      .where((q: any) => q.where('account_id', accountId).orWhereNull('account_id'))
      .orderBy('id', 'asc');
    const unclassified = new Map<string, string[]>();
    const result: EnumeratedArtifact[] = [];
    for (const artifact of this.#parseRows(rows)) {
      const owner = artifact.payload.accountId;
      if (artifact.unclassified && typeof owner === 'string' && owner) {
        const ids = unclassified.get(owner) ?? [];
        ids.push(artifact.id);
        unclassified.set(owner, ids);
      }
      if (owner === accountId) result.push({ id: artifact.id, payload: artifact.payload });
    }
    await this.#classify(unclassified);
    return result;
  }

  /** Artefatos vivos que referenciam algum dos grants, pela coluna indexada `grant_id`. */
  async listByGrantIds(grantIds: string[]): Promise<EnumeratedArtifact[]> {
    const wanted = new Set(grantIds);
    const result: EnumeratedArtifact[] = [];
    for (const chunk of chunks([...wanted])) {
      const rows = await this.#liveQuery().whereIn('grant_id', chunk).orderBy('id', 'asc');
      for (const artifact of this.#toArtifacts(rows)) {
        if (wanted.has(artifact.payload.grantId as string)) result.push(artifact);
      }
    }
    return result;
  }

  async #classify(byAccount: Map<string, string[]>): Promise<void> {
    for (const [accountId, ids] of byAccount) {
      for (const chunk of chunks(ids)) {
        try {
          await this.#query()
            .whereNull('account_id')
            .whereIn('id', chunk)
            .update({ account_id: accountId });
        } catch {
          // Classificar é só otimização: a linha segue NULL e é lida de novo.
        }
      }
    }
  }

  /** Linhas → artefatos, descartando as expiradas; `unclassified` = `account_id` NULL. */
  #parseRows(rows: any[]): Array<EnumeratedArtifact & { unclassified: boolean }> {
    const now = Date.now();
    const result: Array<EnumeratedArtifact & { unclassified: boolean }> = [];
    for (const row of rows) {
      if (row.expires_at && new Date(row.expires_at).getTime() <= now) continue;
      result.push({
        id: row.id,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        unclassified: row.account_id == null,
      });
    }
    return result;
  }

  #toArtifacts(rows: any[]): EnumeratedArtifact[] {
    return this.#parseRows(rows).map(({ id, payload }) => ({ id, payload }));
  }
}
