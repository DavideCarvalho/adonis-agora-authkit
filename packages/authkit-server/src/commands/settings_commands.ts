/**
 * Ace commands para gerenciamento de runtime settings da tabela `auth_settings`.
 *
 * Todos os commands usam o padrão dos commands existentes:
 *   - resolveAuthkitConfig + container para obter a config
 *   - SettingsCapability do store ou RuntimeSettings sobre o DB
 *   - Auditam settings.updated com actor 'cli'
 *
 * Commands disponíveis:
 *   authkit:settings:list               — lista todas as settings presentes
 *   authkit:settings:get  <key>         — obtém uma setting por key
 *   authkit:settings:set  <key> <json>  — grava (upsert) uma setting (valida shape se key conhecida)
 *   authkit:settings:unset <key>        — apaga uma setting (reset to config)
 *
 * Todas suportam --json para output machine-readable.
 */

import type { ApplicationService } from '@adonisjs/core/types';
import { RuntimeSettings } from '../host/runtime_settings.js';
import { SETTING_KEYS, type SettingKey } from '../host/runtime_toggles.js';
import { resolveAuthkitConfig } from './resolve_config.js';

// ---------------------------------------------------------------------------
// Known-key shape validators (best-effort — warn only, não rejeita)
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set<string>(Object.values(SETTING_KEYS));

/** Validação superficial de shape para keys conhecidas. Retorna null se ok, string de erro se inválida. */
function validateKnownKey(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `Value for key "${key}" must be a JSON object, got ${Array.isArray(value) ? 'array' : typeof value}.`;
  }
  const obj = value as Record<string, unknown>;

  switch (key as SettingKey) {
    case SETTING_KEYS.LOCKOUT: {
      const fields: string[] = [
        'enabled',
        'maxAttempts',
        'windowSec',
        'baseLockoutSec',
        'maxLockoutSec',
      ];
      for (const f of fields) {
        if (f in obj && f === 'enabled' && typeof obj[f] !== 'boolean')
          return `lockout.${f} must be boolean`;
        if (f in obj && f !== 'enabled' && typeof obj[f] !== 'number')
          return `lockout.${f} must be number`;
      }
      return null;
    }
    case SETTING_KEYS.RATE_LIMIT: {
      for (const bucket of ['login', 'introspection'] as const) {
        if (bucket in obj && obj[bucket] !== null) {
          const b = obj[bucket] as Record<string, unknown>;
          if (typeof b !== 'object' || Array.isArray(b))
            return `rate_limit.${bucket} must be object`;
          if ('points' in b && typeof b.points !== 'number')
            return `rate_limit.${bucket}.points must be number`;
          if ('duration' in b && typeof b.duration !== 'string')
            return `rate_limit.${bucket}.duration must be string`;
        }
      }
      return null;
    }
    case SETTING_KEYS.PASSWORD_POLICY: {
      const boolFields = [
        'requireUppercase',
        'requireLowercase',
        'requireNumbers',
        'requireSymbols',
        'checkPwned',
      ];
      for (const f of boolFields) {
        if (f in obj && typeof obj[f] !== 'boolean') return `password_policy.${f} must be boolean`;
      }
      if ('minLength' in obj && typeof obj.minLength !== 'number')
        return 'password_policy.minLength must be number';
      return null;
    }
    case SETTING_KEYS.NOTIFICATIONS: {
      for (const f of ['newLoginEmail', 'newDeviceEmail']) {
        if (f in obj && typeof obj[f] !== 'boolean') return `notifications.${f} must be boolean`;
      }
      return null;
    }
    case SETTING_KEYS.SOCIAL_SECOND_FACTOR: {
      if ('policy' in obj && !['enrolled', 'required', 'never'].includes(obj.policy as string))
        return "social_second_factor.policy must be 'enrolled', 'required' or 'never'";
      if (
        'requiredRoles' in obj &&
        (!Array.isArray(obj.requiredRoles) ||
          obj.requiredRoles.some((r: unknown) => typeof r !== 'string'))
      )
        return 'social_second_factor.requiredRoles must be string[]';
      return null;
    }
    case SETTING_KEYS.TRUSTED_DEVICES: {
      if ('enabled' in obj && typeof obj.enabled !== 'boolean')
        return 'trusted_devices.enabled must be boolean';
      if ('days' in obj && typeof obj.days !== 'number')
        return 'trusted_devices.days must be number';
      return null;
    }
    case SETTING_KEYS.TOKEN_TTL: {
      const fields = ['accessTokenSec', 'idTokenSec', 'refreshTokenSec'];
      for (const f of fields) {
        if (f in obj && typeof obj[f] !== 'number') return `token_ttl.${f} must be number`;
      }
      return null;
    }
    case SETTING_KEYS.ADMIN_IMPERSONATION: {
      if ('enabled' in obj && typeof obj.enabled !== 'boolean')
        return 'admin_impersonation.enabled must be boolean';
      return null;
    }
    case SETTING_KEYS.ORGANIZATIONS_POLICY: {
      if ('allowSelfCreate' in obj && typeof obj.allowSelfCreate !== 'boolean')
        return 'organizations_policy.allowSelfCreate must be boolean';
      if ('invitationTtlHours' in obj && typeof obj.invitationTtlHours !== 'number')
        return 'organizations_policy.invitationTtlHours must be number';
      if ('roles' in obj && !Array.isArray(obj.roles))
        return 'organizations_policy.roles must be array';
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared helper: resolve settings service
// ---------------------------------------------------------------------------

async function resolveSettingsService(app: ApplicationService): Promise<RuntimeSettings | null> {
  try {
    const db = await app.container.make('lucid.db' as any);
    // Tenta derivar a conexão do accountStore para probe searchPath-aware.
    let connection: string | undefined;
    try {
      const cfg = await resolveCfg(app);
      connection = (cfg?.accountStore as any)?.connectionName;
    } catch {
      // Silencioso: sem config → default connection.
    }
    return new RuntimeSettings(db, connection ? { connection } : {});
  } catch {
    return null;
  }
}

async function resolveCfg(app: ApplicationService): Promise<Record<string, any> | null> {
  const raw = app.config?.get?.('authkit') ?? null;
  return resolveAuthkitConfig(app, raw);
}

// ---------------------------------------------------------------------------
// authkit:settings:list
// ---------------------------------------------------------------------------

export async function settingsList(
  app: ApplicationService,
  opts: { json?: boolean; logger: { info: (m: string) => void; warn: (m: string) => void } },
): Promise<void> {
  const svc = await resolveSettingsService(app);
  if (!svc) {
    opts.logger.warn('Could not connect to database — is lucid.db bound in the container?');
    return;
  }
  const tablePresent = await svc.isTablePresent();
  if (!tablePresent) {
    opts.logger.warn('The `auth_settings` table is not present. Run migrations to create it.');
    return;
  }
  const rows = await svc.listSettings();
  if (opts.json) {
    opts.logger.info(
      JSON.stringify(
        rows.map((r) => ({
          key: r.key,
          value: r.value,
          updatedAt: r.updatedAt,
          updatedBy: r.updatedBy,
        })),
      ),
    );
    return;
  }
  if (rows.length === 0) {
    opts.logger.info('No runtime settings found (table present but empty).');
    return;
  }
  for (const row of rows) {
    const updatedInfo = row.updatedAt ? ` [updated: ${row.updatedAt}]` : '';
    const byInfo = row.updatedBy ? ` by: ${row.updatedBy}` : '';
    opts.logger.info(`  ${row.key}${updatedInfo}${byInfo}: ${JSON.stringify(row.value)}`);
  }
}

// ---------------------------------------------------------------------------
// authkit:settings:get
// ---------------------------------------------------------------------------

export async function settingsGet(
  app: ApplicationService,
  key: string,
  opts: { json?: boolean; logger: { info: (m: string) => void; warn: (m: string) => void } },
): Promise<void> {
  const svc = await resolveSettingsService(app);
  if (!svc) {
    opts.logger.warn('Could not connect to database.');
    return;
  }
  const tablePresent = await svc.isTablePresent();
  if (!tablePresent) {
    opts.logger.warn('The `auth_settings` table is not present.');
    return;
  }
  const value = await svc.getSetting(key);
  if (value === null) {
    opts.logger.warn(`Setting "${key}" not found (not set — config/default applies).`);
    return;
  }
  if (opts.json) {
    opts.logger.info(JSON.stringify({ key, value }));
    return;
  }
  opts.logger.info(`${key}: ${JSON.stringify(value, null, 2)}`);
}

// ---------------------------------------------------------------------------
// authkit:settings:set
// ---------------------------------------------------------------------------

export async function settingsSet(
  app: ApplicationService,
  key: string,
  jsonValue: string,
  opts: {
    json?: boolean;
    logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonValue);
  } catch {
    opts.logger.error(`Invalid JSON for value: ${jsonValue}`);
    return false;
  }

  // Warn on unknown keys; validate shape for known keys.
  if (!KNOWN_KEYS.has(key)) {
    opts.logger.warn(
      `Key "${key}" is not in the known setting catalog. Proceeding with write (unknown keys are stored as-is).`,
    );
  } else {
    const validationError = validateKnownKey(key, parsed);
    if (validationError) {
      opts.logger.error(`Shape validation error for key "${key}": ${validationError}`);
      return false;
    }
  }

  const svc = await resolveSettingsService(app);
  if (!svc) {
    opts.logger.error('Could not connect to database.');
    return false;
  }
  const tablePresent = await svc.isTablePresent();
  if (!tablePresent) {
    opts.logger.error('The `auth_settings` table is not present. Run migrations to create it.');
    return false;
  }

  await svc.setSetting(key, parsed, 'cli');

  // Audit via config.audit if available.
  const cfg = await resolveCfg(app);
  await cfg?.audit?.record({
    type: 'settings.updated',
    actorId: 'cli',
    ip: null,
    metadata: { key, value: parsed },
  });

  if (opts.json) {
    opts.logger.info(JSON.stringify({ key, value: parsed, updated: true }));
    return true;
  }
  opts.logger.info(`Setting "${key}" saved.`);
  return true;
}

// ---------------------------------------------------------------------------
// authkit:settings:unset
// ---------------------------------------------------------------------------

export async function settingsUnset(
  app: ApplicationService,
  key: string,
  opts: {
    json?: boolean;
    logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  },
): Promise<void> {
  const svc = await resolveSettingsService(app);
  if (!svc) {
    opts.logger.error('Could not connect to database.');
    return;
  }
  const tablePresent = await svc.isTablePresent();
  if (!tablePresent) {
    opts.logger.error('The `auth_settings` table is not present.');
    return;
  }

  const existing = await svc.getSetting(key);
  if (existing === null) {
    opts.logger.warn(`Setting "${key}" was not set (nothing to unset).`);
    if (opts.json) opts.logger.info(JSON.stringify({ key, deleted: false }));
    return;
  }

  await svc.deleteSetting(key);

  // Audit.
  const cfg = await resolveCfg(app);
  await cfg?.audit?.record({
    type: 'settings.updated',
    actorId: 'cli',
    ip: null,
    metadata: { key, action: 'deleted' },
  });

  if (opts.json) {
    opts.logger.info(JSON.stringify({ key, deleted: true }));
    return;
  }
  opts.logger.info(`Setting "${key}" deleted — config/default is now the source of truth.`);
}
