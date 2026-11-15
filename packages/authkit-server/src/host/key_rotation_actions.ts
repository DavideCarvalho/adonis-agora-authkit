import type { ManagedKeyInfo } from '../keys/keystore.js';
import { apiError } from './admin_api/dto.js';
import { type ResolvedKeyRotationSetting, resolveEffectiveKeyRotation } from './key_rotation.js';
import type { SettingsCapability } from './runtime_settings.js';

/**
 * Ações compartilhadas de rotação de chave. Funções puras-ish que tanto a Admin
 * REST API (Bearer) quanto o console (sessão) chamam, evitando duplicar a lógica
 * de status (idade + política + ETA) e de rotação (validação de keep/retire).
 */

export interface KeysStatus {
  ageDays: number;
  policy: ResolvedKeyRotationSetting;
  nextRotationInDays: number | null;
  keys: ManagedKeyInfo[];
  /**
   * `jwks.readOnly`: esta instância lê o keystore de outra — o console esconde rotate/generate/
   * retire e trava a política (que é da instância que escreve).
   */
  readOnly: boolean;
}

/**
 * Status da chave de assinatura managed. Retorna null quando o serviço não tem
 * keystore gerenciável (jwks não é managed+store) — o controller traduz para 501.
 * A política vem do runtime settings; sem settings, usa defaults (rotação off).
 */
export async function buildKeysStatus(
  svc: {
    keystoreAgeDays(): Promise<number | null>;
    listManagedKeys(): Promise<ManagedKeyInfo[]>;
    keystoreReadOnly?: boolean;
  },
  settings: SettingsCapability | null,
): Promise<KeysStatus | null> {
  const ageDays = await svc.keystoreAgeDays();
  if (ageDays === null) return null;
  const policy = settings
    ? await resolveEffectiveKeyRotation(settings)
    : { enabled: false, maxAgeDays: 90, keep: 2 };
  const nextRotationInDays = policy.enabled ? Math.max(0, policy.maxAgeDays - ageDays) : null;
  const keys = await svc.listManagedKeys();
  // readOnly não rotaciona: sem ETA aqui (a instância que escreve é quem agenda).
  const readOnly = svc.keystoreReadOnly === true;
  return {
    ageDays,
    policy,
    nextRotationInDays: readOnly ? null : nextRotationInDays,
    keys,
    readOnly,
  };
}

/**
 * Rotaciona a chave agora. Valida `keep` (>= 1, default 2) e `retire` do body.
 * A aplicação ao vivo + auditoria (keys.rotated) acontecem dentro de svc.rotateKeys.
 */
export async function rotateNow(
  svc: {
    rotateKeys(
      keep: number,
      retire?: boolean,
    ): Promise<{ newKid: string; retiredKids: string[]; keptKids: string[] }>;
  },
  body: { retire?: boolean; keep?: number } | undefined,
): Promise<{ rotated: true; newKid: string; retiredKids: string[]; keptKids: string[] }> {
  const retire = body?.retire === true;
  const keep = typeof body?.keep === 'number' && body.keep >= 1 ? Math.floor(body.keep) : 2;
  const res = await svc.rotateKeys(keep, retire);
  return { rotated: true, ...res };
}

/** Corpo de erro do 409 que a Admin API e o console devolvem numa instância `jwks.readOnly`. */
export function keystoreReadOnlyBody(message?: string) {
  return apiError(
    'keystore_read_only',
    message ??
      'This instance has `jwks.readOnly` set: it reads the keystore another instance writes. Rotate, generate and retire keys on that instance.',
  );
}
