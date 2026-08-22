import type { LoginMethodsPreferenceCapability } from '../account_store.js';
import type { UserLoginMethods } from '../../host/user_login_methods.js';
import { normalizeUserLoginMethods } from '../../host/user_login_methods.js';
import { hasColumn } from './status_profile.js';
import type { LucidStoreContext } from './shared.js';

/**
 * Preferência por usuário de tipos de login sobre a coluna `login_methods`
 * (JSONB) do model. Só deve ser montada quando a coluna existe
 * ({@link hasColumn}) — caso contrário a capacidade fica ausente e a feature
 * degrada para no-op (hosts adotam por migração própria).
 */
export function buildLoginMethods(ctx: LucidStoreContext): LoginMethodsPreferenceCapability {
  const { Model } = ctx;
  return {
    async getLoginMethods(accountId) {
      const row = await Model.find(accountId);
      if (!row) return null;
      return normalizeUserLoginMethods(row.loginMethods);
    },
    async setLoginMethods(accountId, methods: UserLoginMethods | null) {
      const row = await Model.find(accountId);
      if (!row) return;
      // Objeto vazio/null → grava null (sem preferência = herda globais).
      const value =
        methods && Object.keys(methods).length > 0 ? normalizeUserLoginMethods(methods) : null;
      row.loginMethods = value;
      await row.save();
    },
  };
}

/** Indica se o model suporta a preferência de tipos de login (coluna presente). */
export function supportsLoginMethodsColumn(Model: any): boolean {
  return hasColumn(Model, 'loginMethods');
}
