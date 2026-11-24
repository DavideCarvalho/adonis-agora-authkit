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
     * `agent_id` opcional. `account_id` é a conta que já usou; `sid` é o do agente (vai no header
     * `Poppy-Operation`) e `protocol_version` a versão com que a Session começou (§3.4). `grant_id`
     * e `scope` ficaram da Draft 0.1, sem uso (o schema só é aditivo).
     */
    create: (t) => {
      t.string('id').primary();
      t.string('client_id', 2048).notNullable();
      t.string('user_id').notNullable();
      t.string('agent_id').nullable();
      t.string('account_id').nullable().index();
      t.string('grant_id').nullable().index();
      t.text('scope').notNullable();
      t.string('sid', 256).nullable();
      t.string('protocol_version', 16).nullable();
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
      sid: (t) => t.string('sid', 256).nullable(),
      protocol_version: (t) => t.string('protocol_version', 16).nullable(),
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
     * Pedidos: `authorize` (Direct — vira código após o consentimento), `par` (RFC 9126), `device` (RFC 8628),
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
    name: 'auth_poppy_grant_keys',
    /**
     * A chave DPoP (thumbprint) a que o refresh token de um grant ficou preso no sign-in (§4.4): o
     * refresh precisa de uma prova dela.
     */
    create: (t) => {
      t.string('grant_id').primary();
      t.string('jkt', 64).notNullable();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('updated_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      jkt: (t) => t.string('jkt', 64),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
      updated_at: (t) => t.dateTime('updated_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_grant_resources',
    /**
     * Os resources a que um sign-in que nomeou `resource` ficou limitado (§4.5,
     * `signIn.limitToResource`), em JSON. `""` é o default token (`https://{organization.domain}`).
     */
    create: (t) => {
      t.string('grant_id').primary();
      t.text('resources').notNullable();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('updated_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      resources: (t) => t.text('resources'),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
      updated_at: (t) => t.dateTime('updated_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_delegated_keys',
    /**
     * Para qual User ID cada chave delegada já assinou, enquanto a delegação vale (§5.2). `id` é o
     * hash de `client_id` + thumbprint.
     */
    create: (t) => {
      t.string('id', 64).primary();
      t.string('client_id', 2048).notNullable();
      t.string('user_id').notNullable();
      t.dateTime('expires_at', { useTz: true, precision: 3 }).notNullable().index();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('updated_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      client_id: (t) => t.string('client_id', 2048),
      user_id: (t) => t.string('user_id'),
      expires_at: (t) => t.dateTime('expires_at', { useTz: true, precision: 3 }).nullable(),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
      updated_at: (t) => t.dateTime('updated_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_feedback',
    /** Relatos de tarefas que não deram para fazer (§9.3), do endpoint de feedback da lib. */
    create: (t) => {
      t.string('id').primary();
      t.string('client_id', 2048).notNullable();
      t.string('user_id').notNullable();
      t.string('agent_id').nullable();
      t.string('session_id').notNullable().index();
      t.string('account_id').nullable();
      t.string('protocol_version', 16).notNullable();
      t.string('task', 200).notNullable();
      t.text('description').notNullable();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable().index();
      t.dateTime('updated_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      client_id: (t) => t.string('client_id', 2048),
      user_id: (t) => t.string('user_id'),
      agent_id: (t) => t.string('agent_id').nullable(),
      session_id: (t) => t.string('session_id').index(),
      account_id: (t) => t.string('account_id').nullable(),
      protocol_version: (t) => t.string('protocol_version', 16),
      task: (t) => t.string('task', 200),
      description: (t) => t.text('description'),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
      updated_at: (t) => t.dateTime('updated_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_operations',
    /**
     * Operações (extensão Operations 3): uma ação que a empresa executa uma vez aprovada; `revision`
     * é a revisão atual (a última devolvida). Quem pode
     * aprovar é o mesmo `client_id` + `user_id` (e a conta, quando `account_id`). `status`:
     * `pending` → `approved` (aprovação gravada, só no site) → `performing` → `performed`. A
     * aprovação aceita (`approved_revision`, `approver`, `approved_at`, `input_type`, `reference`)
     * fica registrada; `response` é a resposta da execução, repetida nos retries. `ref_hash` é o
     * hash da referência do header `Poppy-Operation` (site). `expires_at` = a validade mais longa
     * das revisões: até lá a operação é lembrada.
     */
    create: (t) => {
      t.string('id').primary();
      t.string('client_id', 2048).notNullable();
      t.string('user_id').notNullable();
      t.string('account_id').nullable();
      t.string('interface', 16).notNullable();
      t.string('revision').notNullable();
      t.string('status', 16).notNullable();
      t.string('ref_hash', 64).nullable().unique();
      t.string('approved_revision').nullable();
      t.string('approver', 16).nullable();
      t.bigInteger('approved_at').nullable();
      t.string('input_type', 64).nullable();
      t.string('reference', 256).nullable();
      t.dateTime('recorded_at', { useTz: true, precision: 3 }).nullable();
      t.text('response').nullable();
      t.dateTime('expires_at', { useTz: true, precision: 3 }).notNullable().index();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('updated_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      client_id: (t) => t.string('client_id', 2048),
      user_id: (t) => t.string('user_id'),
      account_id: (t) => t.string('account_id').nullable(),
      interface: (t) => t.string('interface', 16),
      revision: (t) => t.string('revision').nullable(),
      status: (t) => t.string('status', 16),
      ref_hash: (t) => t.string('ref_hash', 64).nullable(),
      approved_revision: (t) => t.string('approved_revision').nullable(),
      approver: (t) => t.string('approver', 16).nullable(),
      approved_at: (t) => t.bigInteger('approved_at').nullable(),
      input_type: (t) => t.string('input_type', 64).nullable(),
      reference: (t) => t.string('reference', 256).nullable(),
      recorded_at: (t) => t.dateTime('recorded_at', { useTz: true, precision: 3 }).nullable(),
      response: (t) => t.text('response').nullable(),
      expires_at: (t) => t.dateTime('expires_at', { useTz: true, precision: 3 }).nullable(),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
      updated_at: (t) => t.dateTime('updated_at', { useTz: true, precision: 3 }).nullable(),
    },
  },
  {
    name: 'auth_poppy_operation_revisions',
    /**
     * Cada revisão devolvida de uma operação: os termos (JSON), o resumo, a validade e o
     * `fingerprint` (SHA-256 do que a request pede), para conferir que a request com a aprovação
     * pede exatamente o que foi aprovado.
     */
    create: (t) => {
      t.string('revision').primary();
      t.string('operation_id').notNullable().index();
      t.string('fingerprint', 64).notNullable();
      t.text('terms').notNullable();
      t.text('summary').nullable();
      t.dateTime('expires_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('created_at', { useTz: true, precision: 3 }).notNullable();
      t.dateTime('updated_at', { useTz: true, precision: 3 }).notNullable();
    },
    columns: {
      operation_id: (t) => t.string('operation_id').index(),
      fingerprint: (t) => t.string('fingerprint', 64),
      terms: (t) => t.text('terms'),
      summary: (t) => t.text('summary').nullable(),
      expires_at: (t) => t.dateTime('expires_at', { useTz: true, precision: 3 }).nullable(),
      created_at: (t) => t.dateTime('created_at', { useTz: true, precision: 3 }).nullable(),
      updated_at: (t) => t.dateTime('updated_at', { useTz: true, precision: 3 }).nullable(),
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
 *     // with `schema.name: 'auth'`: pass `{ schema: 'auth' }` to both
 *   }
 * }
 * ```
 */
export function ensurePoppySchema(
  db: unknown,
  /** The same `connection` and `schema` (`schema.name`) as AuthKit's tables. */
  options: { connection?: string; schema?: string } = {},
) {
  return ensureAuthkitTables(db, POPPY_TABLES, options);
}
