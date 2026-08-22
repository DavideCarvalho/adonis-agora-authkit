/**
 * Tipos de login POR USUÁRIO — preferência self-service do dono da conta.
 *
 * Diferente do runtime setting global `auth_methods` (que o operador controla via
 * console admin), aqui é o PRÓPRIO usuário quem decide, no console de conta,
 * quais métodos de login ficam habilitados para a SUA conta. A preferência é
 * persistida na coluna `login_methods` (JSONB) de `auth.users` e SEMPRE se
 * intersecta com os métodos globais efetivos: o usuário nunca pode LIGAR um
 * método que o host desligou (config pin ou setting), só restringir.
 *
 * Contratos:
 *   - Coluna ausente no model → capacidade AUSENTE → feature no-op (mesmo padrão
 *     das demais colunas opcionais; hosts adotam por migração própria).
 *   - `NULL` na coluna = sem preferência = herda os globais (comportamento atual).
 *   - Fail-safe all-off: uma preferência que zere TODOS os métodos disponíveis
 *     deixa de restringir (nunca trancamos o usuário fora da própria conta).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Chaves de método que o usuário pode ligar/desligar para a própria conta. */
export type UserLoginMethodKey = 'password' | 'magicLink' | 'passkey' | 'social';

export const USER_LOGIN_METHOD_KEYS: readonly UserLoginMethodKey[] = [
  'password',
  'magicLink',
  'passkey',
  'social',
] as const;

/**
 * Shape persistido na coluna `login_methods` (JSONB) de `auth.users`.
 * Campos ausentes = herda o global. Campos presentes = ON/OFF explícito.
 */
export interface UserLoginMethods {
  password?: boolean;
  magicLink?: boolean;
  passkey?: boolean;
  /**
   * O método social como um todo (não por provider — a interseção com os
   * providers configurados já acontece no resolver global).
   */
  social?: boolean;
}

/**
 * Preferência NORMALIZADA pronta para consumo: cada campo presente indica o que
 * o usuário escolheu; ausente = herda o global. É o que o store devolve/gravа.
 */
export type NormalizedUserLoginMethods = UserLoginMethods;

/**
 * Resultado da interseção global × por-usuário, pronto para as telas/POSTs.
 * Espelha {@link ResolvedAuthMethods} (global) mas já filtrado pela preferência.
 */
export interface ResolvedUserLoginMethods {
  password: boolean;
  magicLink: boolean;
  passkey: boolean;
  /** Providers sociais finais (global ∩ preferência). */
  social: string[];
  forgotPassword: boolean;
  passkeyAutofill: boolean;
}

// ---------------------------------------------------------------------------
// Normalização / validação
// ---------------------------------------------------------------------------

function boolOrUndefined(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Normaliza um valor cru vindo do DB (JSONB) ou do request body para o shape
 * canônico. Campos inválidos são descartados silenciosamente (fail-safe).
 * Objetos vazios viram null (sem preferência).
 */
export function normalizeUserLoginMethods(raw: unknown): NormalizedUserLoginMethods | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: NormalizedUserLoginMethods = {};
  for (const key of USER_LOGIN_METHOD_KEYS) {
    const v = boolOrUndefined(r[key]);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Valida e normaliza o payload de update vindo do PUT da account API.
 * Espera `{ methods: {...} }`; só aceita chaves conhecidas com valores booleanos.
 * `{ methods: {} }` = limpar a preferência (voltar a herdar os globais).
 */
export function parseUserLoginMethodsPayload(body: unknown): ParsedUserLoginMethodsPayload {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'invalid_body' };
  }
  const b = body as Record<string, unknown>;
  if (!('methods' in b) || typeof b.methods !== 'object' || b.methods === null) {
    return { ok: false, error: 'invalid_methods' };
  }
  const methods = normalizeUserLoginMethods(b.methods);
  // Objeto com só campos inválidos → trata como reset ({}).
  return { ok: true, value: methods ?? {} };
}

export type ParsedUserLoginMethodsPayload =
  | { ok: true; value: UserLoginMethods }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Resolver puro — interseção global × por-usuário
// ---------------------------------------------------------------------------

/**
 * Interseção dos métodos globais efetivos com a preferência do usuário.
 *
 * Regras:
 *   - `pref` null/vazio → globais inalterados (herança).
 *   - Campo `false` na preferência DESLIGA o método (só pode restringir).
 *   - Campo `true` NUNCA liga método globalmente indisponível (interseção).
 *   - FAIL-SAFE all-off: se a preferência zerar todos os métodos disponíveis,
 *     volta aos globais (nunca deixar a conta sem nenhum método de entrada).
 *     Loga um aviso (console.warn) — sinaliza preferência órfã após o host ter
 *     desligado métodos globalmente.
 *   - Qualquer erro → globais (a chamada nunca deve derrubar o login).
 */
export function resolveEffectiveUserLoginMethods(
  global: ResolvedAuthMethodsLike,
  pref: UserLoginMethods | null | undefined,
): ResolvedUserLoginMethods {
  try {
    const p = normalizeUserLoginMethods(pref);
    if (!p) {
      return passthrough(global);
    }

    const password = applyPref(global.password, p.password);
    const magicLink = applyPref(global.magicLink, p.magicLink);
    const passkey = applyPref(global.passkey, p.passkey);
    const social = p.social === false ? [] : global.social;

    const resolved: ResolvedUserLoginMethods = {
      password,
      magicLink,
      passkey,
      social,
      // forgotPassword é derivado do password (mesma derivação do global).
      forgotPassword: password && global.forgotPassword,
      passkeyAutofill: passkey && global.passkeyAutofill,
    };

    const allOff = !resolved.password && !resolved.magicLink && !resolved.passkey && resolved.social.length === 0;
    if (allOff) {
      console.warn(
        '[authkit] user login_methods zerou todos os métodos — ignorando a preferência (fail-safe).',
      );
      return passthrough(global);
    }
    return resolved;
  } catch {
    // Nunca derruba o login por causa da preferência.
    return passthrough(global);
  }
}

/** Interseção: false do usuário desliga; true não liga o que o global não tem. */
function applyPref(globalValue: boolean, prefValue?: boolean): boolean {
  if (prefValue === false) return false;
  return globalValue;
}

/** Cópia dos métodos globais como resultado por-usuário (sem preferência). */
function passthrough(global: ResolvedAuthMethodsLike): ResolvedUserLoginMethods {
  return {
    password: global.password,
    magicLink: global.magicLink,
    passkey: global.passkey,
    social: [...(global.social ?? [])],
    forgotPassword: global.forgotPassword,
    passkeyAutofill: global.passkeyAutofill,
  };
}

/** Mínimo que o resolver precisa dos métodos globais (evita import circular). */
export interface ResolvedAuthMethodsLike {
  password: boolean;
  magicLink: boolean;
  passkey: boolean;
  social: string[];
  forgotPassword: boolean;
  passkeyAutofill: boolean;
}
