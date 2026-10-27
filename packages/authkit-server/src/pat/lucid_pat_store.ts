import { DateTime } from 'luxon';
import type { IssuePatInput, PatRecord, PatStore } from './pat_store.js';
import { generatePatToken, hashPatToken } from './pat_tokens.js';

/** Resolução de `lastUsedAt`: um uso dentro desta janela não regrava a linha. */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Implementação default do {@link PatStore} sobre um model Lucid composto de
 * `withPersonalAccessToken()`. A coluna DB `user_id` é mapeada de `accountId`.
 */
export function lucidPatStore(Model: any): PatStore {
  const toRecord = (row: any): PatRecord => ({
    id: row.id,
    name: row.name,
    scopes: row.scopes ?? [],
    audience: row.audience ?? null,
    createdAt: row.createdAt ? row.createdAt.toISO() : '',
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISO() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISO() : null,
  });

  return {
    async issue(input: IssuePatInput) {
      const token = generatePatToken();
      const row = await Model.create({
        userId: input.accountId,
        name: input.name,
        tokenHash: hashPatToken(token),
        scopes: input.scopes ?? [],
        audience: input.audience ?? null,
        expiresAt: input.expiresInDays ? DateTime.now().plus({ days: input.expiresInDays }) : null,
      });
      return { token, pat: toRecord(row) };
    },

    async listForAccount(accountId) {
      const rows = await Model.query().where('user_id', accountId).orderBy('created_at', 'desc');
      return rows.map(toRecord);
    },

    async revoke(accountId, id) {
      const row = await Model.query().where('id', id).where('user_id', accountId).first();
      if (!row) return false;
      await row.delete();
      return true;
    },

    async findActiveByToken(token) {
      const hash = hashPatToken(token);
      const row = await Model.query().where('token_hash', hash).first();
      if (!row) return null;
      const now = DateTime.now();
      if (row.expiresAt && row.expiresAt < now) return null;
      if (
        !row.lastUsedAt ||
        now.toMillis() - row.lastUsedAt.toMillis() >= LAST_USED_RESOLUTION_MS
      ) {
        row.lastUsedAt = now;
        await row.save();
      }
      return {
        accountId: row.userId,
        scopes: row.scopes ?? [],
        audience: row.audience ?? null,
        exp: row.expiresAt ? Math.floor(row.expiresAt.toSeconds()) : null,
      };
    },
  };
}
