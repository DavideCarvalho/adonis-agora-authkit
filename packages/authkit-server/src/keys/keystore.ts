import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import type { SigningAlg } from './jwks_manager.js';

/**
 * Helpers PUROS do keystore managed (sem I/O). A persistência/rotação com I/O vive
 * no {@link KeystoreManager} (compõe um cofre + codec); estas funções geram a chave,
 * computam idade, planejam rotação (dry-run) e derivam o JWKS público.
 *
 * O modo `managed` "puro" gera UMA chave efêmera por boot (em {@link generateJwks})
 * — não persiste, então rotacionar não faz sentido. Para rotação de verdade, o
 * keystore persiste o JWKS PRIVADO (via cofre): a rotação gera um novo par (novo
 * kid) e mantém as N chaves mais recentes; o JWKS público servido inclui todas (as
 * antigas continuam validando), e a PRIMEIRA chave é a de assinatura corrente.
 */

/** Estrutura persistida: JWKS privado (chaves com `d`). */
export interface PersistedKeystore {
  keys: Record<string, any>[];
}

/** Gera uma chave de assinatura privada como JWK (com use/alg/kid + carimbo de criação). */
export async function generateSigningJwk(alg: SigningAlg): Promise<Record<string, any>> {
  const { privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = (await exportJWK(privateKey)) as Record<string, any>;
  jwk.use = 'sig';
  jwk.alg = alg;
  jwk.kid = randomUUID();
  // Metadado NÃO-padrão usado só para reportar idade da chave (doctor / rotação).
  // O oidc-provider e o JWKS público ignoram campos desconhecidos; `toPublicJwks`
  // remove apenas a parte privada — `iat` continua interno, não vaza nada sensível.
  jwk.iat = Math.floor(Date.now() / 1000);
  return jwk;
}

/** Idade (em dias) da chave de assinatura corrente (primeira do keystore), ou null. */
export function signingKeyAgeDays(store: PersistedKeystore | null): number | null {
  const iat = store?.keys?.[0]?.iat;
  if (typeof iat !== 'number') return null;
  return Math.max(0, Math.floor((Date.now() / 1000 - iat) / 86400));
}

/** Info pública de uma chave managed para o painel admin (sem material privado). */
export interface ManagedKeyInfo {
  kid: string;
  alg: string;
  ageDays: number;
  /** true para a chave de assinatura corrente (a primeira do keystore). */
  active: boolean;
  /**
   * `active`: assina. `verification`: antiga, publicada até os tokens dela expirarem.
   * `staged`: gerada e já publicada no JWKS, assina a partir da próxima rotação.
   */
  status: 'active' | 'verification' | 'staged';
  /** Criação da chave (ISO), quando conhecida. */
  createdAt: string | null;
}

/** Mapeia o keystore privado para infos públicas (kid/alg/idade/estado). Vazio se null. */
export function listKeyInfos(store: PersistedKeystore | null): ManagedKeyInfo[] {
  const keys = store?.keys ?? [];
  const now = Date.now() / 1000;
  return keys.map((k, i) => ({
    kid: k.kid as string,
    alg: (k.alg as string) ?? 'RS256',
    ageDays: typeof k.iat === 'number' ? Math.max(0, Math.floor((now - k.iat) / 86400)) : 0,
    active: i === 0,
    status: i === 0 ? 'active' : k.staged === true ? 'staged' : 'verification',
    createdAt: typeof k.iat === 'number' ? new Date(k.iat * 1000).toISOString() : null,
  }));
}

/** Metadados internos do keystore que nunca vão para o oidc-provider nem para o JWKS. */
const INTERNAL_FIELDS = ['iat', 'staged'];

/** As chaves (privadas) como o oidc-provider as recebe: sem os metadados internos. */
export function toProviderJwks(store: PersistedKeystore): { keys: Record<string, any>[] } {
  return {
    keys: store.keys.map((jwk) => {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(jwk)) if (!INTERNAL_FIELDS.includes(k)) out[k] = v;
      return out;
    }),
  };
}

/** Plano de uma rotação — o que SERIA feito (dry-run) sem tocar disco. */
export interface RotationPlan {
  /** kid da chave de assinatura corrente (será deslocada para verificação), ou null. */
  currentKid: string | null;
  /** kids que permanecem no JWKS público após a rotação (a nova vem primeiro). */
  keptKids: string[];
  /** kids removidos do JWKS (tokens assinados por eles deixam de validar). */
  retiredKids: string[];
  /** Quantas chaves o keystore mantém após a rotação. */
  keep: number;
}

/**
 * Calcula o plano de rotação (PURO, sem I/O nem geração de chave). `newKidPlaceholder`
 * representa a chave nova que entraria na frente. Período de graça = manter as
 * `keep` chaves mais recentes; `retire: true` força `keep = 1` (remove TODAS as
 * antigas imediatamente — só a nova valida).
 */
export function planRotation(
  store: PersistedKeystore | null,
  keep: number,
  retire: boolean,
): RotationPlan {
  const current = store?.keys ?? [];
  const effectiveKeep = retire ? 1 : Math.max(1, keep);
  // Uma chave `staged` (gerada antes) é a que passa a assinar; senão, uma nova.
  const staged = current.find((k) => k.staged === true);
  const projected = [
    (staged?.kid as string | undefined) ?? '<new>',
    ...current.filter((k) => k !== staged).map((k) => k.kid as string),
  ];
  const keptKids = projected.slice(0, effectiveKeep);
  const retiredKids = projected.slice(effectiveKeep);
  return {
    currentKid: current[0]?.kid ?? null,
    keptKids,
    retiredKids,
    keep: effectiveKeep,
  };
}

/** Deriva o JWKS PÚBLICO (sem `d` e demais campos privados) a partir do privado. */
export function toPublicJwks(store: PersistedKeystore): { keys: Record<string, any>[] } {
  // `iat` é um metadado interno do keystore (idade da chave), não um membro JWK —
  // removido do JWKS público junto com os campos da chave privada.
  const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'iat', 'staged'];
  return {
    keys: store.keys.map((jwk) => {
      const pub: Record<string, any> = {};
      for (const [k, v] of Object.entries(jwk)) {
        if (!PRIVATE_FIELDS.includes(k)) pub[k] = v;
      }
      return pub;
    }),
  };
}
