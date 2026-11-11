/**
 * Tabelas LIB-OWNED do Poppy — os mesmos nomes e colunas de quando o Poppy morava no
 * `@adonis-agora/authkit-server` (`ensureAuthkitSchema`): um app que já as tem não migra nada.
 * Criadas no boot junto com as do authkit (`schema.autoManage`), ou numa migration com
 * {@link ensurePoppySchema}.
 */
import { type AuthkitTable, ensureAuthkitTables } from '@adonis-agora/authkit-server';

export const POPPY_TABLES: readonly AuthkitTable[] = [
  /*
   * Os refresh tokens são grants do ledger do authkit (`auth_agent_grants`, prefixo `pgrant_`)
   * com o hash em `auth_agent_refresh_tokens`; aqui ficam Sessions, access tokens, pedidos de
   * sign-in e os `jti` vistos. Datas com `useTz` e precisão de ms, como as do authkit.
   */
  {
    name: 'auth_poppy_sessions',
    /**
     * Uma Session: um usuário do agente (`user_id`, opaco) num agente (`client_id`), com o
     * `agent_id` opcional. `account_id` é a conta que já usou. `grant_id` e `scope` ficaram da
     * Draft 0.1, sem uso (o schema só é aditivo).
     */
    create: (t) => {
      t.string('id').primary();
      t.string('client_id', 2048).notNullable();
      t.string('user_id').notNullable();
      t.string('agent_id').nullable();
      t.string('account_id').nullable().index();
      t.string('grant_id').nullable().index();
      t.text('scope').notNullable();
      t.dateTime('expires_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('ended_at', { useTz: true, precision: 3 }).nullable();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('updated_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      client_id: (t) => t.string('client_id', 2048),
      user_id: (t) => t.string('user_id'),
      agent_id: (t) => t.string('agent_id').nullable(),
      account_id: (t) => t.string('account_id').nullable().index(),
      grant_id: (t) => t.string('grant_id').nullable().index(),
      scope: (t) => t.text('scope'),
      expires_at: (t) => t.dateTime('expires_at', { useTz: true, precision: 3 }).nullable(),
      ended_at: (t) => t.dateTime('ended_at', { useTz: true, precision: 3 }).nullable(),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
      updated_at: (t) => t.dateTime('updated_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_tokens',
    /**
     * Access tokens — só o hash. `jkt` = chave DPoP; `null` = Bearer. `session_id` e `user_id`
     * ficaram da Draft 0.1 e saem vazios: o sign-in não conhece a Session.
     */
    create: (t) => {
      t.string('token_hash', 64).primary();
      t.string('session_id').notNullable().index();
      t.string('client_id', 2048).notNullable();
      t.string('user_id').notNullable();
      t.string('account_id').nullable();
      t.string('grant_id').nullable().index();
      t.text('scope').notNullable();
      t.string('resource', 2048).nullable();
      t.string('jkt', 64).nullable();
      t.dateTime('expires_at', { useTz: true, precision: 3 }).notNullable().index();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      session_id: (t) => t.string('session_id').index(),
      client_id: (t) => t.string('client_id', 2048),
      user_id: (t) => t.string('user_id'),
      account_id: (t) => t.string('account_id').nullable(),
      grant_id: (t) => t.string('grant_id').nullable().index(),
      scope: (t) => t.text('scope'),
      resource: (t) => t.string('resource', 2048).nullable(),
      jkt: (t) => t.string('jkt', 64).nullable(),
      expires_at: (t) => t.dateTime('expires_at', { useTz: true, precision: 3 }).nullable(),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_requests',
    /**
     * Pedidos: `authorize` (Direct — vira código após o consentimento), `device` (RFC 8628),
     * `mediated` (aguardando o código de uso único) e `browser` (entrada de um navegador, §6).
     * Códigos só como hash. Linhas expiradas são apagadas no próximo pedido.
     */
    create: (t) => {
      t.string('id').primary();
      t.string('kind', 16).notNullable();
      t.string('code_hash', 64).nullable().unique();
      t.string('user_code', 16).nullable().unique();
      t.string('client_id', 2048).notNullable();
      t.string('session_id').nullable();
      t.string('account_id').nullable();
      t.text('requested_scope').notNullable();
      t.text('granted_scope').nullable();
      t.string('redirect_uri', 2048).nullable();
      t.string('code_challenge', 128).nullable();
      t.string('status', 16).notNullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.integer('interval_seconds').nullable();
      t.dateTime('last_polled_at', { useTz: true, precision: 3 }).nullable();
      t.text('data').nullable();
      t.dateTime('expires_at', { useTz: true, precision: 3 }).notNullable().index();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      kind: (t) => t.string('kind', 16),
      code_hash: (t) => t.string('code_hash', 64).nullable(),
      user_code: (t) => t.string('user_code', 16).nullable(),
      client_id: (t) => t.string('client_id', 2048),
      session_id: (t) => t.string('session_id').nullable(),
      account_id: (t) => t.string('account_id').nullable(),
      requested_scope: (t) => t.text('requested_scope'),
      granted_scope: (t) => t.text('granted_scope').nullable(),
      redirect_uri: (t) => t.string('redirect_uri', 2048).nullable(),
      code_challenge: (t) => t.string('code_challenge', 128).nullable(),
      status: (t) => t.string('status', 16),
      attempts: (t) => t.integer('attempts').defaultTo(0),
      interval_seconds: (t) => t.integer('interval_seconds').nullable(),
      last_polled_at: (t) => t.dateTime('last_polled_at', { useTz: true, precision: 3 }).nullable(),
      data: (t) => t.text('data').nullable(),
      expires_at: (t) => t.dateTime('expires_at', { useTz: true, precision: 3 }).nullable(),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_jtis',
    /** `jti` já aceitos (client assertions, Session JWTs, provas DPoP), até expirarem — anti-replay entre instâncias. */
    create: (t) => {
      t.string('key', 100).primary();
      t.dateTime('expires_at', { useTz: true, precision: 3 }).notNullable().index();
    },
    columns: {
      expires_at: (t) => t.dateTime('expires_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
];

/**
 * Garante as tabelas do Poppy — aditivo e idempotente, como `ensureAuthkitSchema`. Para hosts que
 * desligam `schema.autoManage` e gerenciam o schema em migrations:
 *
 * ```ts
 * import { ensureAuthkitSchema } from '@adonis-agora/authkit-server'
 * import { ensurePoppySchema } from '@adonis-agora/authkit-poppy'
 *
 * export default class extends BaseSchema {
 *   async up() {
 *     await ensureAuthkitSchema(this.db)
 *     await ensurePoppySchema(this.db)
 *   }
 * }
 * ```
 */
export function ensurePoppySchema(db: unknown, options: { connection?: string } = {}) {
  return ensureAuthkitTables(db, POPPY_TABLES, options);
}
