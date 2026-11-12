import type { ApplicationService } from '@adonisjs/core/types';
import { DatabaseAdapter } from '../adapters/database_adapter.js';
import { resolveAuthkitConfig } from '../commands/resolve_config.js';
import { defaultEncryptForStore } from '../define_config.js';
import { signingKeyAgeDays } from '../keys/keystore.js';
import { KeystoreCodec } from '../keys/keystore_codec.js';
import { loadEncryptionService } from '../keys/keystore_crypto.js';
import { KeystoreManager, resolveKeystoreVault } from '../keys/keystore_manager.js';
import { type DoctorInput, type Finding, signingKeyAgeFinding } from './checks.js';

/** Logger mínimo para reportar peers instalados-mas-quebrados. */
export interface CanImportLogger {
  warning(msg: string): void;
}

/**
 * Tenta importar um peer; `true` se importável.
 *
 * Distingue "não instalado" de "instalado mas quebrado": só um erro de
 * módulo-não-encontrado (`ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`) é tratado como
 * peer ausente (silencioso — é o caso esperado). Qualquer outro erro significa que
 * o peer ESTÁ presente mas falhou ao carregar (import circular, erro de sintaxe,
 * config inválida) — isso o doctor precisa gritar, senão um peer quebrado aparece
 * como "ausente" e o diagnóstico mente.
 */
export async function canImport(specifier: string, logger?: CanImportLogger): Promise<boolean> {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
      logger?.warning(
        `⚠️  ${specifier} está instalado mas falhou ao carregar: ${(err as Error).message}`,
      );
    }
    return false;
  }
}

/**
 * Monta o `DoctorInput` a partir do app (config `authkit` resolvida, `session`, peers). Usado por
 * `authkit:doctor` e pelos checks do `agora:doctor`. Lança se `config/authkit.ts` não resolver.
 */
export async function buildDoctorInput(
  app: ApplicationService,
  logger?: CanImportLogger,
): Promise<DoctorInput> {
  const config = await app.container.make('config');
  // `defineConfig` exporta um config provider — resolve antes de inspecionar,
  // senão todo campo aparece como "ausente" (provider cru não tem issuer etc.).
  const authkitConfig = await resolveAuthkitConfig(app, config.get('authkit', null));
  const sessionConfig = (config.get('session', null) as Record<string, any> | null) ?? null;
  return {
    authkitConfig,
    sessionConfig,
    peers: {
      session: await canImport('@adonisjs/session', logger),
      shield: await canImport('@adonisjs/shield', logger),
      ally: await canImport('@adonisjs/ally', logger),
      limiter: await canImport('@adonisjs/limiter', logger),
    },
    __adapterClasses: { DatabaseAdapter },
  };
}

/**
 * O finding de idade da chave de assinatura managed (best-effort): `null` quando o jwks não é
 * `managed` com store, ou quando o keystore não pôde ser lido.
 */
export async function managedSigningKeyAgeFinding(
  app: ApplicationService,
  authkitConfig: Record<string, any> | null,
): Promise<Finding | null> {
  const jwksInput = (authkitConfig?.jwksConfig ?? authkitConfig?.jwks) as any;
  if (jwksInput?.source !== 'managed' || !jwksInput?.store) return null;
  try {
    const vault = resolveKeystoreVault(jwksInput.store, {
      makePath: (p) => app.makePath(p),
      container: app.container,
    });
    const encrypt = jwksInput.encrypt ?? defaultEncryptForStore(jwksInput.store);
    const enc = encrypt ? await loadEncryptionService().catch(() => undefined) : undefined;
    const mgr = new KeystoreManager(
      vault,
      new KeystoreCodec({ encrypt, enc }),
      jwksInput.algorithm ?? 'RS256',
    );
    const store = await mgr.read().catch(() => null);
    const maxAge = jwksInput.rotationDays ?? 90;
    return signingKeyAgeFinding(signingKeyAgeDays(store), maxAge);
  } catch {
    /* idade é best-effort no doctor */
    return null;
  }
}
