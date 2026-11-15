/**
 * Config locks — quando uma feature/política é definida explicitamente no
 * `defineConfig`, ela fica TRAVADA: o valor do config manda e a UI/Admin API NÃO
 * pode mais alterá-la em runtime. Quando NÃO está no config, a UI controla
 * livremente o valor (runtime setting em `auth_settings`).
 *
 * Mecânica (elegante, sem tocar nos ~20 resolvers):
 *   - `RuntimeSettings.getSetting` retorna `null` para keys travadas → cada
 *     `resolveEffective*` cai no `configDefault` (= o valor do config). Logo, config vence.
 *   - `RuntimeSettings.setSetting`/`deleteSetting` lançam {@link SettingLockedError}
 *     para keys travadas → o write path da Admin API/console rejeita com 423.
 *   - A UI lê a lista de keys travadas (`lockedSettingKeys()`) e desabilita o
 *     controle + mostra o aviso "definido via defineConfig".
 *
 * O registro é MODULE-LEVEL e setado uma vez no boot do provider — o IdP é um por
 * processo e os locks vêm de config estático (imutável pós-boot).
 */

import { SETTING_KEYS } from './runtime_toggles.js';

/**
 * Deriva as keys de `auth_settings` travadas a partir dos campos EXPLICITAMENTE
 * presentes no input do `defineConfig`. Só mapeia keys que têm contraparte tanto
 * em config quanto na UI (runtime setting); features sem campo de config nunca
 * travam (UI sempre controla).
 */
export function deriveLockedSettingKeys(config: Record<string, any>): string[] {
  const locked: string[] = [];
  const add = (present: unknown, key: string) => {
    if (present) locked.push(key);
  };
  add(config.registration !== undefined, SETTING_KEYS.REGISTRATION);
  // authMethods no config trava a key inteira `auth_methods`: os métodos passam a ser
  // controlados pelo arquivo (via cfg.authMethods → configOverrides no resolver) e a UI
  // desabilita os toggles com "definido via defineConfig".
  add(config.authMethods !== undefined, SETTING_KEYS.AUTH_METHODS);
  add(config.login?.requireVerifiedEmail !== undefined, SETTING_KEYS.REQUIRE_VERIFIED_EMAIL);
  add(config.lockout !== undefined, SETTING_KEYS.LOCKOUT);
  add(config.rateLimit !== undefined, SETTING_KEYS.RATE_LIMIT);
  add(config.trustedDevices !== undefined, SETTING_KEYS.TRUSTED_DEVICES);
  add(config.botProtection !== undefined, SETTING_KEYS.BOT_PROTECTION);
  add(config.organizations !== undefined, SETTING_KEYS.ORGANIZATIONS_POLICY);
  add(config.admin?.impersonation !== undefined, SETTING_KEYS.ADMIN_IMPERSONATION);
  add(config.ttl !== undefined, SETTING_KEYS.TOKEN_TTL);
  // `social.secondFactor` (política fixa ou função por conta) manda; o console não altera.
  add(config.social?.secondFactor !== undefined, SETTING_KEYS.SOCIAL_SECOND_FACTOR);
  // `mcpClients: false`: o login de clientes MCP nunca liga, e o console não o religa.
  add(config.mcpClients === false, SETTING_KEYS.MCP_CLIENTS);
  return locked;
}

/**
 * Opções de rota que são POLÍTICA (decidem o que é PERMITIDO), e não estrutura
 * (onde as rotas moram). Ver `AuthHostOptions` e o docblock de
 * `registerAuthHost`.
 */
export const POLICY_ROUTE_OPTIONS = [
  'social',
  'rateLimit',
  'sudoMethods',
  'admin',
  'adminApi',
] as const;

/** Uma opção de política de `AuthHostOptions`. */
export type PolicyRouteOption = (typeof POLICY_ROUTE_OPTIONS)[number];

/**
 * Deriva as opções de rota TRAVADAS a partir dos campos EXPLICITAMENTE presentes
 * no input do `defineConfig` — a MESMA regra de {@link deriveLockedSettingKeys}
 * ("declarou no arquivo → o arquivo manda"), aplicada ao outro eixo: config vs.
 * argumento de `registerAuthHost` (em vez de config vs. runtime setting).
 *
 * Travada significa: `registerAuthHost(router, { <key>: ... })` NÃO altera o
 * comportamento; o valor do config vence e a divergência é reportada
 * (`AuthHostRouteMap.overriddenByConfig` + `console.warn` no boot).
 *
 * O motivo de existir: sem isso, `start/routes.ts` pode AFROUXAR o que o config
 * declarou — desligar o rate-limit, montar login social que o config não
 * declara, trocar a lista de métodos de sudo — e o `config/authkit.ts` deixa de
 * ser auditável (seria preciso ler o routes.ts de cada app para saber o que
 * está valendo).
 *
 * Só trava o que o config DECLARA. Um campo ausente do config nunca trava: o
 * argumento continua livre (back-compat com quem só configura pelo routes.ts) —
 * exatamente como `authMethods` só trava os métodos que ele lista.
 */
export function deriveLockedRouteOptions(config: Record<string, any>): PolicyRouteOption[] {
  const locked: PolicyRouteOption[] = [];
  if (config.social !== undefined) locked.push('social');
  if (config.rateLimit !== undefined) locked.push('rateLimit');
  if (config.sudo?.methods !== undefined) locked.push('sudoMethods');
  if (config.admin !== undefined) locked.push('admin');
  if (config.adminApi !== undefined) locked.push('adminApi');
  return locked;
}

/** Erro lançado ao tentar gravar/remover uma setting travada via `defineConfig`. */
export class SettingLockedError extends Error {
  readonly code: string = 'E_SETTING_LOCKED';
  readonly key: string;
  constructor(key: string) {
    super(
      `The setting "${key}" is declared in defineConfig() and is therefore locked — it cannot be changed at runtime through the console or the Admin API. Remove it from defineConfig to hand the key back to the UI.`,
    );
    this.name = 'SettingLockedError';
    this.key = key;
  }
}

let lockedKeys = new Set<string>();

/** Define o conjunto de keys travadas (chamado uma vez no boot do provider). */
export function setLockedSettingKeys(keys: Iterable<string>): void {
  lockedKeys = new Set(keys);
}

/** Limpa os locks (e as keys só-leitura) — uso em testes. */
export function resetLockedSettingKeys(): void {
  lockedKeys = new Set();
  readOnlyKeys = new Set();
}

/** A setting `key` está travada por config? */
export function isSettingLocked(key: string): boolean {
  return lockedKeys.has(key);
}

/** Lista (snapshot) das keys travadas — consumida pelo read path da UI. */
export function lockedSettingKeys(): string[] {
  return [...lockedKeys];
}

/**
 * Keys de `auth_settings` que esta instância LÊ mas não grava: com `jwks.readOnly`, a política
 * `key_rotation` pertence à instância que escreve o keystore. Diferente de um lock de config, a
 * leitura continua valendo (a UI mostra a política compartilhada); só a escrita é recusada.
 */
export function deriveReadOnlySettingKeys(config: {
  jwksConfig?: { readOnly?: boolean } | null;
}): string[] {
  return config.jwksConfig?.readOnly === true ? [SETTING_KEYS.KEY_ROTATION] : [];
}

/** Escrita recusada numa key que esta instância só lê (`jwks.readOnly`). Admin API/console → 409. */
export class SettingReadOnlyError extends SettingLockedError {
  override readonly code: string = 'E_KEYSTORE_READ_ONLY';
  constructor(key: string) {
    super(key);
    this.name = 'SettingReadOnlyError';
    this.message = `The setting "${key}" belongs to the instance that writes the keystore: this instance has \`jwks.readOnly\` set and cannot change it. Change it on the writer instance.`;
  }
}

let readOnlyKeys = new Set<string>();

/** Define as keys só-leitura desta instância (chamado uma vez no boot do provider). */
export function setReadOnlySettingKeys(keys: Iterable<string>): void {
  readOnlyKeys = new Set(keys);
}

/** A setting `key` é só-leitura nesta instância? */
export function isSettingReadOnly(key: string): boolean {
  return readOnlyKeys.has(key);
}

/** Lista (snapshot) das keys só-leitura — consumida pelo read path da UI. */
export function readOnlySettingKeys(): string[] {
  return [...readOnlyKeys];
}
