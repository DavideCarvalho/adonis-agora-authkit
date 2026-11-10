import { DateTime } from 'luxon';
import type { PasswordExpirationCapability, PasswordHistoryCapability } from '../account_store.js';
import type { LucidStoreContext } from './shared.js';

/** Stub de noop para quando não há verify disponível (fail-safe: não bloqueia). */
const _noopVerify = async (_hash: string, _plain: string): Promise<boolean> => false;

/**
 * Histórico de senhas (disallow_password_reuse), sobre a tabela lib-owned
 * `auth_password_history` (criada pelo `ensureAuthkitSchema`).
 *
 * Tabela: `auth_password_history`
 *   id          UUID/SERIAL PK
 *   account_id  TEXT NOT NULL
 *   password_hash TEXT NOT NULL
 *   created_at  TIMESTAMP NOT NULL
 */
export function buildPasswordHistory(ctx: LucidStoreContext, db: any): PasswordHistoryCapability {
  /**
   * Helper para query raw da tabela de histórico.
   * Lucid expõe `db.query().from(table)` para SELECT e `db.table(table).insert()` para INSERT.
   * Para DELETE usamos `db.query().from(table)`.
   */
  function qFrom() {
    return db.query().from('auth_password_history');
  }

  return {
    async isPasswordReused(accountId, plainPassword, count, nativeVerify) {
      try {
        const rows = await qFrom()
          .where('account_id', accountId)
          .orderBy('created_at', 'desc')
          .limit(count);
        if (!rows || rows.length === 0) return false;
        // Usa o hook do chamador quando fornecido; fallback: ctx.nativeVerifyHash.
        const verify = (nativeVerify ?? null) || ctx.nativeVerifyHash || _noopVerify;
        // Verifica a senha candidata contra cada hash do histórico.
        for (const row of rows) {
          try {
            const matches = await verify(row.password_hash, plainPassword);
            if (matches) return true;
          } catch {
            // falha ao verificar um hash individual → ignora (hash de sistema legado etc.)
          }
        }
        return false;
      } catch {
        // Falha de DB → fail-safe: não bloqueia (prefere availability).
        return false;
      }
    },

    async recordPasswordHistory(accountId, oldHash) {
      try {
        await db.table('auth_password_history').insert({
          account_id: accountId,
          password_hash: oldHash,
          created_at: DateTime.now().toISO(),
        });
      } catch {
        // Best-effort: falha silenciosa não impede a troca de senha.
      }
    },

    async prunePasswordHistory(accountId, count) {
      try {
        // Busca os IDs dos últimos `count` registros.
        const rows = await qFrom()
          .where('account_id', accountId)
          .orderBy('created_at', 'desc')
          .limit(count)
          .select('id');

        if (rows.length < count) return; // menos registros que o limite → nada a podar

        // Apaga os mais antigos (todos exceto os últimos `count`).
        const keepIds = rows.map((r: any) => r.id);
        await qFrom().where('account_id', accountId).whereNotIn('id', keepIds).delete();
      } catch {
        // Best-effort.
      }
    },
  };
}

/**
 * Expiração de senha. Só deve ser montado quando o model tem a propriedade
 * `passwordChangedAt` (coluna `password_changed_at`) — capability-probed via
 * {@link hasColumn} no `lucidAccountStore`.
 */
export function buildPasswordExpiration(ctx: LucidStoreContext): PasswordExpirationCapability {
  const { Model } = ctx;
  return {
    async getPasswordChangedAt(accountId) {
      try {
        const row = await Model.find(accountId);
        if (!row) return null;
        const val = row.passwordChangedAt;
        if (!val) return null;
        // Suporta tanto DateTime do Luxon quanto Date nativo.
        if (val instanceof Date) return val;
        if (val && typeof val.toJSDate === 'function') return val.toJSDate();
        if (typeof val === 'string') return new Date(val);
        return null;
      } catch {
        return null;
      }
    },

    async touchPasswordChangedAt(accountId) {
      try {
        const row = await Model.find(accountId);
        if (!row) return;
        row.passwordChangedAt = DateTime.now();
        await row.save();
      } catch {
        // Best-effort.
      }
    },
  };
}
