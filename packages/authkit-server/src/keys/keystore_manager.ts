import type { KeystoreStoreConfig } from '@adonis-agora/authkit-core';
import { validateSchemaName } from '../schema/tables_location.js';
import type { SigningAlg } from './jwks_manager.js';
import {
  generateSigningJwk,
  type PersistedKeystore,
  planRotation,
  type RotationPlan,
} from './keystore.js';
import type { KeystoreCodec } from './keystore_codec.js';
import {
  DriveKeystoreVault,
  FileKeystoreVault,
  HashicorpVaultKeystoreVault,
  type KeystoreVault,
  LazyExternalVault,
  LucidKeystoreVault,
  RedisKeystoreVault,
} from './keystore_vault.js';

/**
 * Único caminho de I/O do keystore managed: compõe um {@link KeystoreVault} (onde
 * o blob mora) com um {@link KeystoreCodec} (serialização + encryption). As helpers
 * puras (gerar chave, planejar rotação) continuam em `keystore.ts`.
 */
export class KeystoreManager {
  constructor(
    private vault: KeystoreVault,
    private codec: KeystoreCodec,
    private alg: SigningAlg,
  ) {}

  /** Lê o keystore (privado) ou null se ausente. */
  async read(): Promise<PersistedKeystore | null> {
    const blob = await this.vault.read();
    if (blob == null) return null;
    return this.codec.decode(blob);
  }

  /** Garante que exista: gera+persiste se ausente; senão decodifica e retorna. */
  async ensure(): Promise<PersistedKeystore> {
    const blob = await this.vault.read();
    if (blob == null) {
      const store: PersistedKeystore = { keys: [await generateSigningJwk(this.alg)] };
      await this.vault.write(await this.codec.encode(store));
      return store;
    }
    return this.codec.decode(blob);
  }

  /**
   * Rotaciona: a chave nova vai para a frente (passa a assinar) e as `keep` mais recentes ficam
   * publicadas. Uma chave `staged` (de {@link generate}) é a que passa a assinar; senão, uma nova.
   * Persiste.
   */
  async rotate(
    keep = 2,
    retire = false,
  ): Promise<{ store: PersistedKeystore; newKid: string; retiredKids: string[] }> {
    const current = (await this.read()) ?? { keys: [] };
    const staged = current.keys.find((k) => k.staged === true);
    let fresh: Record<string, any>;
    if (staged) {
      const { staged: _staged, ...promoted } = staged;
      fresh = promoted;
    } else {
      fresh = await generateSigningJwk(this.alg);
    }
    const next = [fresh, ...current.keys.filter((k) => k !== staged)];
    const effectiveKeep = retire ? 1 : Math.max(1, keep);
    const kept = next.slice(0, effectiveKeep);
    const retiredKids = next.slice(effectiveKeep).map((k) => k.kid as string);
    const store: PersistedKeystore = { keys: kept };
    await this.vault.write(await this.codec.encode(store));
    return { store, newKid: fresh.kid as string, retiredKids };
  }

  /**
   * Gera uma chave e a publica no JWKS SEM assinar com ela (`staged`): os caches de JWKS dos
   * resource servers a pegam antes da troca. A próxima {@link rotate} a promove. Uma chave staged
   * anterior é substituída. Persiste.
   */
  async generate(alg: SigningAlg = this.alg): Promise<{ store: PersistedKeystore; kid: string }> {
    const current = await this.ensure();
    const fresh: Record<string, any> = { ...(await generateSigningJwk(alg)), staged: true };
    const store: PersistedKeystore = {
      keys: [...current.keys.filter((k) => k.staged !== true), fresh],
    };
    await this.vault.write(await this.codec.encode(store));
    return { store, kid: fresh.kid as string };
  }

  /**
   * Retira uma chave que não assina (antiga ou staged): sai do JWKS, e tokens assinados por ela
   * deixam de validar. Lança para a chave ativa ou um `kid` desconhecido. Persiste.
   */
  async retire(kid: string): Promise<PersistedKeystore> {
    const current = (await this.read()) ?? { keys: [] };
    const index = current.keys.findIndex((k) => k.kid === kid);
    if (index === -1) throw new Error(`key ${kid} not found`);
    if (index === 0) throw new Error(`key ${kid} is the active signing key: rotate first`);
    const store: PersistedKeystore = { keys: current.keys.filter((_, i) => i !== index) };
    await this.vault.write(await this.codec.encode(store));
    return store;
  }

  /** Plano de rotação (puro, sem I/O de escrita). */
  async plan(keep: number, retire: boolean): Promise<RotationPlan> {
    return planRotation(await this.read(), keep, retire);
  }

  /** Token barato de mudança (delegado ao vault; fallback p/ read completo). */
  async head(): Promise<string | null> {
    if (this.vault.head) return this.vault.head();
    return this.vault.read();
  }
}

/** Packages-irmãos que entregam os cofres de cloud (planos futuros). */
const CLOUD_DRIVER_PACKAGE: Record<string, string> = {
  'aws-secrets-manager': '@adonis-agora/authkit-vault-aws',
  'gcp-secret-manager': '@adonis-agora/authkit-vault-gcp',
  'azure-key-vault': '@adonis-agora/authkit-vault-azure',
};

/** Acesso mínimo ao app que o resolver precisa (paths + container p/ lucid/redis). */
export interface KeystoreVaultContext {
  makePath: (p: string) => string;
  container: { make: (token: string) => Promise<any> };
}

/**
 * Resolve a config `store` num {@link KeystoreVault}. `ctx.makePath` = `app.makePath`
 * (resolve paths relativos à raiz do app). Instância custom (com `read`/`write`)
 * passa direto. Drivers de cloud lançam nesta fatia (chegam nos packages-irmãos).
 */
export function resolveKeystoreVault(
  store: KeystoreStoreConfig | KeystoreVault,
  ctx: KeystoreVaultContext,
): KeystoreVault {
  if (typeof store === 'string') return new FileKeystoreVault(ctx.makePath(store));
  if (typeof (store as KeystoreVault).read === 'function') return store as KeystoreVault;
  const cfg = store as Exclude<KeystoreStoreConfig, string>;
  switch (cfg.driver) {
    case 'file':
      return new FileKeystoreVault(ctx.makePath(cfg.path));
    case 'drive':
      return new DriveKeystoreVault(cfg.key, cfg.disk);
    case 'lucid':
      return new LucidKeystoreVault(
        async () => {
          const db: any = await ctx.container.make('lucid.db');
          return cfg.connection ? db.connection(cfg.connection) : db.connection();
        },
        cfg.table,
        cfg.key,
        validateSchemaName(cfg.schema, 'jwks.store.schema'),
      );
    case 'redis':
      return new RedisKeystoreVault(async () => {
        const rm: any = await ctx.container.make('redis');
        return cfg.connection ? rm.connection(cfg.connection) : rm.connection();
      }, cfg.key);
    case 'hashicorp-vault':
      return new HashicorpVaultKeystoreVault({
        endpoint: cfg.endpoint,
        path: cfg.path,
        token: cfg.token,
        mount: (cfg as any).mount,
        field: (cfg as any).field,
      });
    default: {
      const pkg = CLOUD_DRIVER_PACKAGE[(cfg as any).driver];
      if (!pkg) throw new Error(`AuthKit keystore: driver "${(cfg as any).driver}" desconhecido.`);
      return new LazyExternalVault(pkg, cfg);
    }
  }
}
