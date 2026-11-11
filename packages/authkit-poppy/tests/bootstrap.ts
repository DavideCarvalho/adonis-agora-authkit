import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';

/** Database Lucid standalone sobre sqlite em memória. */
export function createTestDatabase() {
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {}) as any;
  const logger = new LoggerFactory().create();
  const emitter = new EmitterFactory().create(app);
  return new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
        },
      },
    },
    logger,
    emitter,
  );
}
