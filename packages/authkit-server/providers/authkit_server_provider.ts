// Side-effect import, and it is load-bearing: the `ContainerBindings`
// augmentation for this package's four bindings lives in the root `types.ts`,
// and this is the module that carries it into a host app's declaration graph —
// every host registers this provider in `adonisrc.ts`.
//
// The declaration used to be duplicated here as well. One copy typed the hosts
// and the other backed the `./types` subpath, and the two had drifted: this one
// declared four bindings, `types.ts` declared one. There is a single table now.
//
// It must be a bare side-effect import — the `import type {} from` form is erased
// from the emitted `.d.ts` and would drop the augmentation. `build/types.js`
// compiles down to `export {}`, so the runtime cost is nil.
import '../types.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configProvider } from '@adonisjs/core';
import { RuntimeException } from '@adonisjs/core/exceptions';
import type { ApplicationService } from '@adonisjs/core/types';
import { setBootedApp } from '../services/booted_app.js';
import { type ResolvedServerConfig, defaultEncryptForStore } from '../src/define_config.js';
import { resolveAppKey } from '../src/host/app_key.js';
import { resolveEffectiveKeyRotation } from '../src/host/key_rotation.js';
import { RuntimeSettings } from '../src/host/runtime_settings.js';
import { KeystoreCodec } from '../src/keys/keystore_codec.js';
import { loadEncryptionService } from '../src/keys/keystore_crypto.js';
import { KeystoreManager, resolveKeystoreVault } from '../src/keys/keystore_manager.js';
import { KeyRotationScheduler } from '../src/provider/key_rotation_scheduler.js';
import { KeystoreReloadPoller } from '../src/provider/keystore_reload.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { makeSingleFlightLock } from '../src/provider/single_flight_lock.js';

export default class AuthkitServerProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    // EAGER + LOUD (fail-fast): se o host configurou `config/authkit.ts`, a
    // `appKey` é indispensável — o oidc-provider a usa para assinar TODOS os
    // cookies (keygrip). Antes, essa validação só rodava dentro do factory
    // lazy do `authkit.server` (registrado abaixo): sem nada que resolvesse o
    // binding no boot, o app subia normalmente e o erro só aparecia (a) na
    // 1ª request que tocasse uma rota do authkit, como um 500 sem contexto
    // fora do modo dev, OU (b) nunca, porque `#startKeystoreReloadPoll`/
    // `#startKeyRotationScheduler` engolem qualquer erro do `container.make`
    // via `.catch(() => null)`. Validar aqui, fora do try/catch fail-safe
    // abaixo, propaga o erro para `app.boot()` e derruba o boot do processo
    // com a mensagem certa — em vez de um 500 misterioso depois.
    if (this.app.config.get('authkit')) {
      resolveAppKey(this.app);
    }

    // Config locks: trava as settings definidas explicitamente no defineConfig
    // (config vence em runtime; a UI/Admin API não pode alterá-las). Fail-safe:
    // qualquer erro → sem locks (comportamento legado).
    let resolvedConfig: ResolvedServerConfig | null = null;
    try {
      const value = this.app.config.get('authkit');
      if (value) {
        const config = (await configProvider.resolve(
          this.app,
          value,
        )) as ResolvedServerConfig | null;
        if (config) {
          resolvedConfig = config;
          if (config.lockedSettingKeys?.length) {
            const { setLockedSettingKeys } = await import('../src/host/config_locks.js');
            setLockedSettingKeys(config.lockedSettingKeys);
          }
          // Stash dos bits de routing p/ o registerAuthHost ler do config (dedup).
          // boot() roda antes do preload start/routes.ts, então estará disponível lá.
          const { setAuthHostConfig } = await import('../src/host/auth_host_config.js');
          setAuthHostConfig({
            mountPath: config.mountPath,
            social: config.social,
            rateLimit: config.rateLimit,
            adminEnabled: config.admin.enabled,
            adminApiEnabled: config.adminApi.enabled,
            // `config.sudo.methods` passa a decidir também o que é MONTADO — sem
            // isto o host teria de repetir a lista no `registerAuthHost`, e as
            // duas divergiriam (tela oferecendo endpoint que dá 404).
            sudoMethods: config.sudo?.methods,
            // Defaults estruturais de `config.routes` (o argumento ainda vence).
            routes: typeof config.routes === 'object' ? config.routes : undefined,
            lockedRouteOptions: config.lockedRouteOptions,
          });
        }
      }
    } catch {
      /* sem locks / sem stash → registerAuthHost cai em opts/defaults */
    }

    // Auto-montagem das rotas (`config.routes`). FORA do try/catch fail-safe
    // acima de propósito: "as rotas não subiram" não pode degradar em silêncio —
    // seria um app inteiro em 404 sem nenhuma pista. Chama a MESMA função
    // exportada que o `start/routes.ts` chamaria; não há segunda implementação.
    if (resolvedConfig?.routes) {
      const router = await this.app.container.make('router');
      const { autoMountAuthHost } = await import('../src/host/register_auth_host.js');
      autoMountAuthHost(router);
    }

    // Registra o disco "authkit" no edge.js para que os templates sejam referenciados
    // como `authkit::login`, `authkit::account/tokens`, etc.
    // Resolve o diretório das views tanto em produção (provider compilado em
    // `build/providers/`, views copiadas para `build/host/views`) quanto em dev
    // (rodando de `providers/` via ts-exec; views em `build/host/views` após build
    // ou em `src/host/views` sem build).
    const candidates = [
      new URL('../host/views', import.meta.url), // prod: build/providers → build/host/views
      new URL('../build/host/views', import.meta.url), // dev: providers → build/host/views
      new URL('../src/host/views', import.meta.url), // dev sem build: providers → src/host/views
    ];
    const viewsUrl = candidates.find((u) => existsSync(fileURLToPath(u)));
    if (!viewsUrl) return; // nenhum dir de views resolvível

    try {
      const edge = await import('edge.js');
      const edgeInstance = (edge as any).default ?? edge;
      edgeInstance.mount('authkit', viewsUrl);
    } catch {
      // edge.js ausente (host headless/Inertia-only que não usa edgeRenderer) — ignora.
    }
  }

  register() {
    // Entrega o app BOOTADO ao singleton de `services/main` (e ao
    // `recordSubRevocation` do AdminSessionsService) para que nunca precisem
    // `import`ar uma cópia de `@adonisjs/core`/`services/app` que pode não ser a
    // que o `bin/server` bootou — dual-package hazard do core (ver
    // `services/booted_app.ts`).
    setBootedApp(this.app);

    this.app.container.singleton('authkit.server', async () => {
      const configProviderValue = this.app.config.get('authkit');
      const config = (await configProvider.resolve(
        this.app,
        configProviderValue,
      )) as ResolvedServerConfig | null;
      if (!config) {
        throw new RuntimeException(
          'Config inválido em "config/authkit.ts". Use o método defineConfig de @adonis-agora/authkit-server.',
        );
      }

      // `app.appKey` pode ser uma string crua ou um `Secret` do AdonisJS — ver
      // `resolveAppKey` para o porquê e para a mensagem de erro (agora também
      // validada EAGER no `boot()`, acima; mantida aqui para o caso raro de
      // alguém resolver `authkit.server` diretamente sem passar pelo boot do
      // provider, ex.: testes unitários do binding).
      const appKey = resolveAppKey(this.app);
      const metrics = await this.app.container.make('authkit.metrics');

      const jwksInput = config.jwksConfig;
      let jwksLoader: (() => Promise<{ keys: Record<string, any>[] }>) | undefined;
      let keystoreHead: (() => Promise<string | null>) | undefined;
      let keystoreManager: (() => Promise<KeystoreManager>) | undefined;
      if (jwksInput?.source === 'managed' && jwksInput?.store) {
        const appRef = this.app;
        const buildManager = async () => {
          const vault = resolveKeystoreVault(jwksInput.store as any, {
            makePath: (p) => appRef.makePath(p),
            container: appRef.container,
          });
          const encrypt =
            (jwksInput as any).encrypt ?? defaultEncryptForStore(jwksInput.store as any);
          // best-effort (≠ boot, que lança): se a encryption sumir em runtime, o reload
          // degrada para "sem hot-reload" (o onError do poller engole) em vez de derrubar o processo.
          const enc = encrypt ? await loadEncryptionService().catch(() => undefined) : undefined;
          return new KeystoreManager(
            vault,
            new KeystoreCodec({ encrypt, enc }),
            jwksInput.algorithm ?? 'RS256',
          );
        };
        jwksLoader = async () => {
          const m = await buildManager();
          const store = (await m.read()) ?? (await m.ensure());
          return { keys: store.keys.map(({ iat: _iat, ...jwk }) => jwk) };
        };
        keystoreHead = async () => {
          const m = await buildManager();
          return m.head();
        };
        keystoreManager = async () => buildManager();
      }

      return new OidcService(config, appKey, metrics, {
        jwksLoader,
        keystoreHead,
        keystoreManager,
      });
    });

    this.app.container.singleton('authkit.metrics', async () => {
      const value = this.app.config.get('authkit');
      const config = (await configProvider.resolve(this.app, value)) as ResolvedServerConfig | null;
      const { createMetricsRecorder } = await import('../src/observability/metrics_service.js');
      return createMetricsRecorder(config?.observability ?? {}, 'authkit-server');
    });

    this.app.container.singleton('authkit.accountStore', async () => {
      const value = this.app.config.get('authkit');
      const config = (await configProvider.resolve(this.app, value)) as ResolvedServerConfig | null;
      if (!config?.accountStore) {
        throw new RuntimeException(
          'accountStore não configurado em "config/authkit.ts". Use defineConfig de @adonis-agora/authkit-server.',
        );
      }
      return config.accountStore;
    });

    this.app.container.singleton('authkit.patStore', async () => {
      const value = this.app.config.get('authkit');
      const config = (await configProvider.resolve(this.app, value)) as ResolvedServerConfig | null;
      if (!config?.patStore) {
        throw new RuntimeException(
          'patStore não configurado em "config/authkit.ts" — necessário para fluxos de PAT.',
        );
      }
      return config.patStore;
    });
  }

  /**
   * Gestão automática de schema: com `schema.autoManage` (default), garante
   * as tabelas do authkit no start — cria as que faltam e adiciona colunas
   * novas (aditivo). Falha de DB aqui não derruba o boot: loga warning e as
   * features degradam como sempre degradaram (capability probing).
   */
  async start() {
    try {
      const value = this.app.config.get('authkit');
      if (!value) return;
      const config = (await configProvider.resolve(this.app, value)) as ResolvedServerConfig | null;
      if (!config?.schema?.autoManage) return;

      const db = await this.app.container.make('lucid.db' as any).catch(() => null);
      if (!db) return; // host sem @adonisjs/lucid — nada a gerenciar

      const { ensureAuthkitSchema } = await import('../src/schema/ensure.js');
      const report = await ensureAuthkitSchema(db, { connection: config.schema.connection });

      const logger = await this.app.container.make('logger').catch(() => null);
      if (report.created.length > 0) {
        logger?.info('authkit: created tables %s', report.created.join(', '));
      }
      for (const [table, columns] of Object.entries(report.altered)) {
        logger?.info('authkit: added columns to %s: %s', table, columns.join(', '));
      }
    } catch (error) {
      const logger = await this.app.container.make('logger').catch(() => null);
      logger?.warn(
        { err: error },
        'authkit: schema auto-manage failed — features degrade gracefully; ' +
          'run ensureAuthkitSchema() in a migration or fix DB connectivity',
      );
    }

    await this.#startKeystoreReloadPoll();
    await this.#startKeyRotationScheduler();
  }

  /**
   * Inicia o poll de reload do keystore: a cada intervalo lê um `head` barato do
   * cofre e dispara `reloadKeys()` quando ele muda, propagando rotações feitas
   * por outro processo (`authkit:keys:rotate`) ou instância sem restart. Só roda
   * no ambiente `web` (evita pollers em comandos ace/testes) e só quando o
   * OidcService de fato tem um `keystoreHead` (managed + store). Fail-safe:
   * qualquer erro vira no-op (logado como warning); `unref()` impede o timer de
   * manter o processo vivo.
   */
  async #startKeystoreReloadPoll() {
    if (this.app.getEnvironment() !== 'web') return;
    const svc = await this.app.container.make('authkit.server').catch(() => null);
    const headFn = svc?.keystoreHead;
    if (!svc || !headFn) return;

    const logger = await this.app.container.make('logger').catch(() => null);
    const poller = new KeystoreReloadPoller({
      head: () => headFn(),
      reload: () => svc.reloadKeys(),
      intervalMs: 60_000,
      onError: (err) => logger?.warn({ err }, 'authkit: keystore reload poll falhou (fail-safe)'),
    });
    poller.start();
  }

  /**
   * Inicia o scheduler de rotação age-based (housekeeping). Só no ambiente `web` e
   * só quando o OidcService tem keystore gerenciável (rotateKeys disponível). Lê a
   * política via RuntimeSettings (construída a partir do lucid.db, sem request);
   * single-flight via @adonisjs/lock (opt-in). Fail-safe.
   */
  async #startKeyRotationScheduler() {
    if (this.app.getEnvironment() !== 'web') return;
    const svc: any = await this.app.container.make('authkit.server').catch(() => null);
    if (!svc || typeof svc.rotateKeys !== 'function' || typeof svc.keystoreAgeDays !== 'function')
      return;
    // só faz sentido com keystore gerenciável:
    if ((await svc.keystoreAgeDays().catch(() => null)) === null) return;

    const db = await this.app.container.make('lucid.db' as any).catch(() => null);
    if (!db) return; // sem Lucid → sem settings → política seria defaults(disabled); nada a agendar

    const logger = await this.app.container.make('logger').catch(() => null);

    // Resolve a connection do schema config para que RuntimeSettings use a mesma
    // conexão que o resto do authkit (mesmo padrão do expire_scan_command).
    const value = this.app.config.get('authkit');
    const config = value
      ? ((await configProvider
          .resolve(this.app, value)
          .catch(() => null)) as ResolvedServerConfig | null)
      : null;
    const connection = config?.schema?.connection;

    // RuntimeSettings sem request (mesmo padrão de expire_scan_command / security_notice_service).
    const settings = new RuntimeSettings(db, connection ? { connection } : {});

    const withLock = makeSingleFlightLock({ key: 'authkit:keys:rotate', ttlMs: 5 * 60_000 });
    const scheduler = new KeyRotationScheduler({
      policy: () => resolveEffectiveKeyRotation(settings),
      ageDays: () => svc.keystoreAgeDays(),
      rotateKeys: (keep: number) => svc.rotateKeys(keep),
      withLock,
      intervalMs: 60 * 60_000, // 1h
      onError: (err) => logger?.warn({ err }, 'authkit: key rotation scheduler falhou (fail-safe)'),
    });
    scheduler.start();
  }
}
