import type { Database } from '@adonisjs/lucid/database';
import type { EnumeratedArtifact, OidcAdapter, OidcPayload } from './adapter_contract.js';

const TABLE = 'authkit_oidc_payloads';

export class DatabaseAdapter implements OidcAdapter {
  constructor(
    private name: string,
    private db: Database,
  ) {}

  #query() {
    return this.db.query().from(TABLE).where('model_name', this.name);
  }

  async upsert(id: string, payload: OidcPayload, expiresIn: number): Promise<void> {
    // Armazenamos como ISO string para que o parse de expiração seja determinístico
    // independente do backend (SQLite/Postgres) e do formato nativo de timestamp.
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
    const row = {
      id,
      model_name: this.name,
      payload: JSON.stringify(payload),
      grant_id: (payload.grantId as string) ?? null,
      user_code: (payload.userCode as string) ?? null,
      uid: (payload.uid as string) ?? null,
      expires_at: expiresAt,
    };
    const existing = await this.#query().where('id', id).first();
    if (existing) {
      await this.#query().where('id', id).update(row);
    } else {
      await this.db.table(TABLE).insert(row);
    }
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
      .where('expires_at', '>', new Date(now).toISOString())
      .update({
        payload: JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + expiresIn }),
        expires_at: new Date(now + expiresIn * 1000).toISOString(),
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
    const rows = await this.#query().orderBy('id', 'asc');
    const now = Date.now();
    const result: EnumeratedArtifact[] = [];
    for (const row of rows) {
      if (row.expires_at && new Date(row.expires_at).getTime() <= now) continue;
      result.push({ id: row.id, payload: JSON.parse(row.payload) as Record<string, unknown> });
    }
    return result;
  }
}
