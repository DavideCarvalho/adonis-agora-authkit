/**
 * Schema das tabelas que o PRÓPRIO authkit possui (nomes fixos). As tabelas
 * do host (users, webauthn credentials, provider identities, PATs, audit)
 * ficam de fora de propósito: nome e shape são decisão do host.
 *
 * `ensureAuthkitSchema()` é ADITIVO e idempotente:
 *  - cria as tabelas que faltam;
 *  - adiciona colunas novas em tabelas existentes (ALTER ADD);
 *  - nunca dropa nada nem altera tipo de coluna existente.
 *
 * Roda automaticamente no boot quando `schema.autoManage` está ligado
 * (default), ou manualmente dentro de uma migration do host:
 *
 * ```ts
 * // database/migrations/xxxx_authkit_schema.ts
 * import { BaseSchema } from '@adonisjs/lucid/schema'
 * import { ensureAuthkitSchema } from '@adonis-agora/authkit-server'
 *
 * export default class extends BaseSchema {
 *   async up() {
 *     await ensureAuthkitSchema(this.db)
 *   }
 * }
 * ```
 */

type TableBuilder = any;

interface TableDef {
  name: string;
  /** Builder completo — usado quando a tabela não existe. */
  create: (table: TableBuilder) => void;
  /**
   * Builder por coluna — usado para ALTER ADD quando a tabela já existe
   * mas a coluna não. Sem constraints que quebram em tabelas populadas
   * (unique/FK ficam só no `create`).
   */
  columns: Record<string, (table: TableBuilder) => void>;
}

const TABLES: TableDef[] = [
  {
    name: 'authkit_oidc_payloads',
    create: (t) => {
      t.string('id', 255).notNullable();
      t.string('model_name', 100).notNullable();
      t.text('payload').notNullable();
      t.string('grant_id', 255).nullable().index();
      t.string('user_code', 255).nullable().index();
      t.string('uid', 255).nullable().index();
      t.timestamp('expires_at', { useTz: true }).nullable();
      t.primary(['model_name', 'id']);
    },
    columns: {
      id: (t) => t.string('id', 255),
      model_name: (t) => t.string('model_name', 100),
      payload: (t) => t.text('payload'),
      grant_id: (t) => t.string('grant_id', 255).nullable().index(),
      user_code: (t) => t.string('user_code', 255).nullable().index(),
      uid: (t) => t.string('uid', 255).nullable().index(),
      expires_at: (t) => t.timestamp('expires_at', { useTz: true }).nullable(),
    },
  },
  {
    name: 'auth_settings',
    create: (t) => {
      t.string('key').notNullable();
      t.string('organization_id').nullable();
      t.text('value').notNullable();
      t.timestamp('updated_at', { useTz: true }).nullable();
      t.string('updated_by').nullable();
      t.unique(['key', 'organization_id']);
    },
    columns: {
      key: (t) => t.string('key'),
      organization_id: (t) => t.string('organization_id').nullable(),
      value: (t) => t.text('value'),
      updated_at: (t) => t.timestamp('updated_at', { useTz: true }).nullable(),
      updated_by: (t) => t.string('updated_by').nullable(),
    },
  },
  {
    name: 'auth_password_history',
    create: (t) => {
      t.increments('id').primary();
      t.string('account_id').notNullable();
      t.text('password_hash').notNullable();
      /* o código sempre envia created_at no INSERT — default de banco desnecessário */
      t.timestamp('created_at', { useTz: true }).notNullable();
      t.index(['account_id', 'created_at']);
    },
    columns: {
      account_id: (t) => t.string('account_id'),
      password_hash: (t) => t.text('password_hash'),
      created_at: (t) => t.timestamp('created_at', { useTz: true }).nullable(),
    },
  },
  {
    name: 'auth_mfa',
    /**
     * Estado de MFA/TOTP por conta — LIB-OWNED (substitui as colunas
     * `totp_secret`/`mfa_enabled_at`/`recovery_codes`/`last_totp_step` que viviam
     * na tabela `users` do host). Keyed por `account_id` (1:1 com a conta).
     *
     *  - `totp_secret`   — segredo TOTP encriptado em repouso (text, null = sem enrollment).
     *  - `mfa_enabled_at`— instante do (re)enrollment confirmado (null = MFA desligado).
     *  - `recovery_codes`— hashes (sha256) dos recovery codes, single-use (json, null = nenhum).
     *  - `last_totp_step`— último step TOTP aceito (anti-replay M3; bigint, null = nenhum).
     */
    create: (t) => {
      t.string('account_id').notNullable().primary();
      t.text('totp_secret').nullable();
      t.timestamp('mfa_enabled_at', { useTz: true }).nullable();
      t.json('recovery_codes').nullable();
      t.bigInteger('last_totp_step').nullable();
    },
    columns: {
      totp_secret: (t) => t.text('totp_secret').nullable(),
      mfa_enabled_at: (t) => t.timestamp('mfa_enabled_at', { useTz: true }).nullable(),
      recovery_codes: (t) => t.json('recovery_codes').nullable(),
      last_totp_step: (t) => t.bigInteger('last_totp_step').nullable(),
    },
  },
  {
    name: 'auth_organizations',
    create: (t) => {
      t.string('id').primary();
      t.string('name').notNullable();
      t.string('slug').notNullable().unique();
      t.string('logo_url').nullable();
      t.json('metadata').nullable();
      t.timestamp('created_at', { useTz: true }).nullable();
      t.timestamp('updated_at', { useTz: true }).nullable();
    },
    columns: {
      name: (t) => t.string('name'),
      slug: (t) => t.string('slug'),
      logo_url: (t) => t.string('logo_url').nullable(),
      metadata: (t) => t.json('metadata').nullable(),
      created_at: (t) => t.timestamp('created_at', { useTz: true }).nullable(),
      updated_at: (t) => t.timestamp('updated_at', { useTz: true }).nullable(),
    },
  },
  {
    name: 'auth_organization_members',
    create: (t) => {
      t.string('id').primary();
      t.string('organization_id')
        .notNullable()
        .references('id')
        .inTable('auth_organizations')
        .onDelete('CASCADE');
      t.string('account_id').notNullable();
      t.string('role').notNullable().defaultTo('member');
      t.timestamp('created_at', { useTz: true }).nullable();
      t.timestamp('updated_at', { useTz: true }).nullable();
      t.unique(['organization_id', 'account_id']);
    },
    columns: {
      organization_id: (t) => t.string('organization_id'),
      account_id: (t) => t.string('account_id'),
      role: (t) => t.string('role').defaultTo('member'),
      created_at: (t) => t.timestamp('created_at', { useTz: true }).nullable(),
      updated_at: (t) => t.timestamp('updated_at', { useTz: true }).nullable(),
    },
  },
  {
    name: 'auth_session_revocations',
    /**
     * Log de revogações de Back-Channel Logout para clients com sessão cookie-based.
     * Escrito pelo handler de BCL de cada client (e pela revogação em massa do admin);
     * lido pelo BackchannelRevocationMiddleware em toda request. Vive no schema `auth`
     * para ser compartilhável entre todos os apps que apontam para o MESMO banco.
     */
    create: (t) => {
      t.increments('id').primary();
      // sid do logout_token → revoga UMA sessão SSO específica (nullable: pode vir só sub).
      t.string('sid').nullable().index();
      // sub do logout_token → revoga TODAS as sessões do usuário antes de revoked_at.
      t.string('sub').nullable().index();
      t.timestamp('revoked_at', { useTz: true }).notNullable();
      // Prune por idade (revogações mais velhas que o TTL máximo de sessão viram lixo).
      t.index(['revoked_at']);
    },
    columns: {
      sid: (t) => t.string('sid').nullable().index(),
      sub: (t) => t.string('sub').nullable().index(),
      revoked_at: (t) => t.timestamp('revoked_at', { useTz: true }).nullable(),
    },
  },
  {
    name: 'auth_organization_invitations',
    create: (t) => {
      t.string('id').primary();
      t.string('organization_id')
        .notNullable()
        .references('id')
        .inTable('auth_organizations')
        .onDelete('CASCADE');
      t.string('email').notNullable();
      t.string('role').notNullable().defaultTo('member');
      t.string('token_hash').notNullable().unique();
      t.string('invited_by').notNullable();
      t.timestamp('expires_at', { useTz: true }).notNullable();
      t.timestamp('accepted_at', { useTz: true }).nullable();
      t.timestamp('created_at', { useTz: true }).nullable();
      t.timestamp('updated_at', { useTz: true }).nullable();
    },
    columns: {
      organization_id: (t) => t.string('organization_id'),
      email: (t) => t.string('email'),
      role: (t) => t.string('role').defaultTo('member'),
      token_hash: (t) => t.string('token_hash'),
      invited_by: (t) => t.string('invited_by'),
      expires_at: (t) => t.timestamp('expires_at', { useTz: true }).nullable(),
      accepted_at: (t) => t.timestamp('accepted_at', { useTz: true }).nullable(),
      created_at: (t) => t.timestamp('created_at', { useTz: true }).nullable(),
      updated_at: (t) => t.timestamp('updated_at', { useTz: true }).nullable(),
    },
  },
];

export interface EnsureSchemaOptions {
  /** Conexão Lucid a usar. Default: conexão primária. */
  connection?: string;
}

export interface EnsureSchemaReport {
  /** Tabelas criadas do zero nesta execução. */
  created: string[];
  /** Colunas adicionadas em tabelas já existentes: tabela → colunas. */
  altered: Record<string, string[]>;
}

/**
 * Probe searchPath-aware: `schema.hasTable` no Postgres ignora o
 * search_path, então testamos com um SELECT de verdade (mesma técnica do
 * RuntimeSettings).
 */
async function tableExists(conn: any, table: string): Promise<boolean> {
  try {
    await conn.from(table).limit(1);
    return true;
  } catch {
    return false;
  }
}

async function columnExists(conn: any, table: string, column: string): Promise<boolean> {
  try {
    await conn.from(table).select(column).limit(1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Garante que as tabelas do authkit existem e têm todas as colunas que esta
 * versão da lib espera. Aditivo e idempotente — seguro de rodar em todo boot
 * e dentro de migrations.
 */
export async function ensureAuthkitSchema(
  db: any,
  options: EnsureSchemaOptions = {},
): Promise<EnsureSchemaReport> {
  const conn = options.connection ? db.connection(options.connection) : db.connection();
  const report: EnsureSchemaReport = { created: [], altered: {} };

  for (const def of TABLES) {
    if (!(await tableExists(conn, def.name))) {
      try {
        await conn.schema.createTable(def.name, def.create);
        report.created.push(def.name);
        continue;
      } catch (error) {
        /**
         * Corrida entre instâncias subindo juntas: se outra instância criou
         * a tabela entre o probe e o CREATE, segue o jogo; senão, propaga.
         */
        if (!(await tableExists(conn, def.name))) throw error;
      }
    }

    for (const [column, add] of Object.entries(def.columns)) {
      if (await columnExists(conn, def.name, column)) continue;
      await conn.schema.alterTable(def.name, (t: TableBuilder) => add(t));
      if (!report.altered[def.name]) report.altered[def.name] = [];
      report.altered[def.name].push(column);
    }
  }

  // Coluna `login_methods` em `auth.users` — a tabela é HOST-owned (não está em
  // TABLES porque o nome/shape são decisão do app), mas a LI B consome a coluna
  // (LoginMethodsPreferenceCapability). Alguns deploys de host só migram o schema
  // do domínio, não o schema `auth` — então a migration manual da coluna pode
  // nunca rodar, e isso derrubava TODO login/callback OIDC com "column users.login_methods
  // does not exist" no instante em que o model passou a declará-la.
  // Aqui garantimos: SE `auth.users` existe E a coluna falta, adicionamos. Nunca
  // criamos a tabela (host-owned). Aditivo + idempotente — roda em todo boot.
  try {
    if (await tableExists(conn, 'users')) {
      if (!(await columnExists(conn, 'users', 'login_methods'))) {
        await conn.schema.alterTable('users', (t: TableBuilder) => {
          t.jsonb('login_methods').nullable();
        });
        report.altered['users'] = ['login_methods'];
      }
    }
  } catch (error) {
    // Tabela host-owned pode não existir num banco que nunca criou users — não
    // é erro: fail-soft (a migração do host cuida). Nunca criar a tabela aqui.
    if (!(await tableExists(conn, 'users'))) {
      throw error; // alguém criou entre o probe e o ALTER — repropaga se sumiu
    }
  }

  return report;
}
