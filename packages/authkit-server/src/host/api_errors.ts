/**
 * JSON errors for the machine APIs (`/api/apps/*`): a failure answers `{ error, message }` and is
 * logged server-side, never a stack trace in the body (AdonisJS' dev error page would print one).
 */

/** Postgres `42P01`, MySQL `ER_NO_SUCH_TABLE`, SQLite `no such table`. */
function isMissingTable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === '42P01' ||
    e?.code === 'ER_NO_SUCH_TABLE' ||
    (typeof e?.message === 'string' && /no such table|relation .* does not exist/i.test(e.message))
  );
}

async function logError(ctx: any, error: unknown, label: string): Promise<void> {
  try {
    const logger = ctx.logger ?? (await ctx.containerResolver.make('logger'));
    logger.error({ err: error }, `authkit: ${label} failed`);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`authkit: ${label} failed`, error);
  }
}

/** `schema.name` of the AuthKit server, when it can be read. */
async function schemaNameOf(ctx: any): Promise<string | undefined> {
  try {
    const service = await ctx.containerResolver.make('authkit.server');
    const name = service?.config?.schema?.name;
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Wraps a handler: any throw becomes a JSON 500 (503 for a missing AuthKit table). */
export function jsonApiErrors(
  label: string,
  table: string,
  handler: (ctx: any) => Promise<unknown>,
): (ctx: any) => Promise<unknown> {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (error) {
      await logError(ctx, error, label);
      ctx.response.header?.('cache-control', 'no-store');
      if (isMissingTable(error)) {
        const schema = await schemaNameOf(ctx);
        const where = schema ? `schema "${schema}"` : 'the schema AuthKit uses';
        return ctx.response.status(503).send({
          error: 'schema_missing',
          message: `The AuthKit table ${table} does not exist in ${where}. Run a migration that calls ensureAuthkitSchema(db, { schema: '${schema ?? '<schema>'}' }) where the identity schema is migrated: this app (or restart it with schema.autoManage on), or, when autoManage is false here, the app that owns that schema. It only adds what is missing; \`node ace agora:doctor\` lists the missing tables.`,
        });
      }
      return ctx.response.status(500).send({
        error: 'server_error',
        message: `${label} failed on the AuthKit server; the details are in its log.`,
      });
    }
  };
}
