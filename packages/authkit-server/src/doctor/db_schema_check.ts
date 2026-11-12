import type { AgoraDoctorResult } from './agora_doctor.js';

/** Thrown inside the probe transaction so the probe row is never kept. */
class ProbeRollback extends Error {}

function rows(result: any): any[] {
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result;
  return result?.rows ?? [];
}

/**
 * `agora:doctor` check for `schema.name`: the schema exists, AuthKit's tables are in it, and the
 * connection can write there. No result at all without `schema.name`.
 */
export async function dbSchemaResults(
  config: Record<string, any> | null,
  makeDb: () => Promise<any>,
  docs: string,
): Promise<AgoraDoctorResult[]> {
  const schema: string | undefined = config?.schema?.name;
  if (!schema) return [];
  const [{ AUTHKIT_TABLE_NAMES }, { authkitTable, authkitTablesClient, dialectOf }] =
    await Promise.all([import('../schema/ensure.js'), import('../schema/tables_location.js')]);
  const client = authkitTablesClient(await makeDb(), { connection: config?.schema?.connection });
  const dialect = dialectOf(client);
  if (dialect !== 'postgres' && dialect !== 'mysql') {
    return [
      {
        status: 'error',
        message: `schema.name "${schema}" is set, but the connection uses ${dialect ?? 'an unknown dialect'}, which has no schemas`,
        fix: 'Remove schema.name from config/authkit.ts, or use Postgres or MySQL',
        docs,
      },
    ];
  }

  const exists = rows(
    await client.rawQuery('select 1 as ok from information_schema.schemata where schema_name = ?', [
      schema,
    ]),
  );
  if (exists.length === 0) {
    return [
      {
        status: 'error',
        message: `database schema "${schema}" does not exist on this connection`,
        fix:
          dialect === 'mysql'
            ? `Boot the app once with schema.autoManage on, or run CREATE DATABASE \`${schema}\``
            : `Boot the app once with schema.autoManage on, or run CREATE SCHEMA "${schema}"`,
        docs,
      },
    ];
  }

  const found = new Set(
    rows(
      await client.rawQuery(
        'select table_name as name from information_schema.tables where table_schema = ?',
        [schema],
      ),
    ).map((r: any) => String(r.name ?? r.NAME ?? r.TABLE_NAME)),
  );
  const missing = AUTHKIT_TABLE_NAMES.filter((name) => !found.has(name));
  if (missing.length > 0) {
    return [
      {
        status: 'error',
        message: `AuthKit tables missing from schema "${schema}": ${missing.join(', ')}`,
        fix: 'Boot the app once with schema.autoManage on, or run ensureAuthkitSchema(db, { schema }) in a migration',
        docs,
      },
    ];
  }

  try {
    await client.transaction(async (trx: any) => {
      await trx.table(authkitTable({ schema }, 'auth_settings')).insert({
        key: '__authkit_doctor_probe',
        organization_id: null,
        value: 'null',
      });
      throw new ProbeRollback();
    });
  } catch (error) {
    if (!(error instanceof ProbeRollback)) {
      return [
        {
          status: 'error',
          message: `the connection cannot write to schema "${schema}": ${(error as Error)?.message ?? error}`,
          fix:
            dialect === 'mysql'
              ? `GRANT INSERT, UPDATE, DELETE ON \`${schema}\`.* TO the app user`
              : `GRANT USAGE ON SCHEMA "${schema}" and INSERT, UPDATE, DELETE on its tables to the app role`,
          docs,
        },
      ];
    }
  }
  return [
    {
      status: 'ok',
      message: `AuthKit tables are in schema "${schema}" and the connection can write there`,
    },
  ];
}
