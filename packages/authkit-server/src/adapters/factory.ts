import type { ApplicationService } from '@adonisjs/core/types';
import type { OidcAdapter } from './adapter_contract.js';
import { DatabaseAdapter } from './database_adapter.js';
import { RedisAdapter } from './redis_adapter.js';

export type OidcAdapterClass = new (name: string) => OidcAdapter;

export interface AdapterFactory {
  resolver(app: ApplicationService): Promise<OidcAdapterClass>;
}

/**
 * Modelos do oidc-provider de vida curta, amarrados ao ciclo da sessão de
 * login (nomes exatos que o provider passa ao adapter). Perder qualquer um
 * deles custa no máximo um relogin — nunca um outage — então são os
 * candidatos ao adapter da `session:` (Redis). Todo modelo fora daqui
 * (`Client` em particular — sem ele nem a tela de login abre) fica no
 * adapter default (durável).
 */
export const SESSION_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Session',
  'Interaction',
  'Grant',
  'AccessToken',
  'RefreshToken',
  'AuthorizationCode',
  'DeviceCode',
  'PushedAuthorizationRequest',
  'BackchannelAuthenticationRequest',
  'ClientCredentials',
  'ReplayDetection',
  // `RegistrationAccessToken`/`InitialAccessToken` ficam FORA de propósito:
  // gerenciam o `Client` (rotação/reconfiguração) e precisam morar junto dele
  // no backend durável — senão um flush do Redis orfana o gerenciamento.
]);

/**
 * Escolhe a classe de adapter pro nome do modelo: session-scoped vai pra
 * `sessionClass`, o resto pra `defaultClass`. Pura (sem I/O) de propósito —
 * o dispatcher do provider (`build_provider.ts`) e os serviços que instanciam
 * adapter na mão (`AdminSessionsService`, account API) usam a MESMA regra.
 * Sem `session.adapter` configurado as duas classes são a mesma (back-compat:
 * tudo continua onde está hoje).
 */
export function pickModelAdapterClass(
  model: string,
  defaultClass: OidcAdapterClass,
  sessionClass: OidcAdapterClass,
): OidcAdapterClass {
  return SESSION_SCOPED_MODELS.has(model) ? sessionClass : defaultClass;
}

export interface RedisAdapterConfig {
  /**
   * Nome da conexão do @adonisjs/redis. OPCIONAL: omitido, usa a connection
   * DEFAULT do app (`config/redis.ts`, campo `connection`) — que é a mesma
   * que a sessão do app usa. É o recomendado (e o único jeito sensato pra
   * `session:`): as duas camadas de sessão no mesmo destino, sem como
   * divergir por typo em string duplicada. Passe explícito só pra um Redis
   * dedicado, sabendo o que está fazendo.
   */
  connection?: string;
  prefix?: string;
}

export interface DatabaseAdapterConfig {
  /** nome da conexão Lucid (default: a primária) */
  connection?: string;
}

export const adapters = {
  /**
   * Factory para o adapter Redis. O consumidor precisa ter o @adonisjs/redis
   * configurado, pois o resolver resolve o `RedisManager` pelo token `'redis'`
   * do container e obtém a conexão — a nomeada em `connection`, ou a DEFAULT
   * do app quando omitida (`manager.connection()`, que cai em
   * `config/redis.ts#connection`).
   */
  redis(config: RedisAdapterConfig = {}): AdapterFactory {
    return {
      async resolver(app) {
        const redisManager = await app.container.make('redis');
        const client = config.connection
          ? (redisManager as any).connection(config.connection)
          : (redisManager as any).connection();
        const prefix = config.prefix ?? 'authkit';
        return class extends RedisAdapter {
          constructor(name: string) {
            super(name, client, prefix);
          }
        };
      },
    };
  },

  /**
   * Factory para o adapter de banco (Lucid). Resolve o `Database` manager pelo
   * token `'lucid.db'`. O `DatabaseAdapter` consome o manager diretamente
   * (`db.query()`/`db.table()`); quando uma conexão específica é solicitada,
   * usamos `db.connection(name)` para obter o cliente daquela conexão.
   */
  database(config: DatabaseAdapterConfig = {}): AdapterFactory {
    return {
      async resolver(app) {
        const db = await app.container.make('lucid.db');
        const connection = config.connection;
        const conn = connection ? (db as any).connection(connection) : db;
        return class extends DatabaseAdapter {
          constructor(name: string) {
            super(name, conn);
          }
        };
      },
    };
  },
};
