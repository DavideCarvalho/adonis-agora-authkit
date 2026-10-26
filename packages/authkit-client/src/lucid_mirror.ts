import type { Identity } from '@adonis-agora/authkit-core';

/** Model Lucid mínimo que o mirror precisa. */
interface LucidModelLike {
  updateOrCreate(search: Record<string, unknown>, payload: Record<string, unknown>): Promise<any>;
  /** Leitura sem transação nem lock, usada quando o espelho já está em dia. */
  findBy?(key: string, value: unknown): Promise<any>;
}

/** O usuário já tem exatamente esses valores? Valores não primitivos contam como diferentes. */
function alreadyMirrored(user: any, payload: Record<string, unknown>): boolean {
  return Object.entries(payload).every(([key, value]) => {
    if (value !== null && typeof value === 'object') return false;
    return Object.is(user[key], value);
  });
}

export interface LucidMirrorOptions {
  /**
   * Campos a sincronizar das claims do id_token a cada login (além do id). Default:
   * `{ email }`. Ex.: `(i) => ({ email: i.email, fullName: i.profile?.name ?? null })`.
   */
  sync?: (identity: Identity) => Record<string, unknown>;
  /** Relações Lucid a pré-carregar no usuário resolvido (ex.: `['roles']`). */
  preload?: string[];
  /**
   * Injeta `identity.globalRoles` numa propriedade NÃO persistida do usuário (p/ policies).
   * `true` → `globalRoles`; string → nome custom da propriedade.
   */
  injectGlobalRoles?: boolean | string;
  /** Coluna que casa com `identity.userId`. Default: `id`. */
  idColumn?: string;
}

/**
 * Factory do padrão "espelho local" de `resolveUser`: faz `updateOrCreate` do usuário
 * de domínio a partir das claims do id_token, opcionalmente pré-carrega relações e
 * injeta os papéis globais. Quando a linha já tem os valores das claims (o caso de
 * todo request depois do login), lê com `findBy` em vez de abrir a transação com
 * `SELECT ... FOR UPDATE` do `updateOrCreate`. Substitui o `resolveUser` que cada app reescrevia.
 *
 * ```ts
 * resolveUser: lucidMirror(AppUser, {
 *   sync: (i) => ({ email: i.email, fullName: i.profile?.name ?? null }),
 *   preload: ['roles'],
 *   injectGlobalRoles: true,
 * })
 * ```
 *
 * Escape hatch: continue passando uma função própria em `resolveUser` quando precisar.
 */
export function lucidMirror(Model: LucidModelLike, options: LucidMirrorOptions = {}) {
  const idColumn = options.idColumn ?? 'id';
  return async (identity: Identity): Promise<unknown> => {
    const synced = options.sync ? options.sync(identity) : { email: identity.email };
    const payload = { [idColumn]: identity.userId, ...synced };
    let user = Model.findBy ? await Model.findBy(idColumn, identity.userId) : null;
    if (!user || !alreadyMirrored(user, payload)) {
      user = await Model.updateOrCreate({ [idColumn]: identity.userId }, payload);
    }

    if (options.preload) {
      for (const relation of options.preload) {
        await user.load(relation);
      }
    }

    if (options.injectGlobalRoles) {
      const prop =
        typeof options.injectGlobalRoles === 'string' ? options.injectGlobalRoles : 'globalRoles';
      user[prop] = identity.globalRoles ?? [];
    }

    return user;
  };
}
