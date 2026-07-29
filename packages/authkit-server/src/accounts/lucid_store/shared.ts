import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuditSink } from '../../audit/audit_sink.js';
import type { PasswordManager } from '../../password/password_manager.js';
import type { AuthAccount } from '../account_store.js';

/**
 * Encripta/decripta um valor (ex.: o segredo TOTP) em repouso. Mantém a lib
 * desacoplada do serviço de encryption do app — qualquer implementação que
 * faça round-trip serve (em prod, normalmente o `@adonisjs/core/services/encryption`).
 * `decrypt` retorna `null` se o valor foi adulterado/é inválido.
 */
export interface AccountSecretEncrypter {
  encrypt(value: string): string;
  decrypt(value: string): string | null;
}

/**
 * Funções das cerimônias WebAuthn. Espelham a assinatura do `@simplewebauthn/server`
 * (subconjunto usado). Injetáveis via {@link LucidAccountStoreOptions.webauthnCeremonies}
 * para testes.
 */
export interface WebauthnCeremonies {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

/** RP (Relying Party) do WebAuthn usado nas cerimônias. */
export interface ResolvedRp {
  rpName: string;
  rpId: string;
  origin: string | string[];
}

/**
 * Contexto compartilhado pelos builders de capacidade. Carrega o model principal,
 * os helpers de segredo e (quando configurados) os models/parametros das capacidades.
 */
export interface LucidStoreContext {
  Model: any;
  mfaIssuer: string;
  recoveryCodeCount: number;
  /** Encripta o segredo antes de persistir (no-op sem encrypter). */
  sealSecret(secret: string): string;
  /** Decripta o segredo armazenado; null em falha/adulteração (no-op sem encrypter). */
  openSecret(stored: string | null | undefined): string | null;
  toAccount(row: any): AuthAccount;
  /**
   * Gerência de senha: validação de política/vazamento (ao definir) e
   * verificação com lazy rehash + legacy verifier (ao autenticar).
   */
  passwords: PasswordManager;
  /**
   * Sink de auditoria (best-effort), usado para o evento `password.rehashed`.
   * Ausente → o evento não é emitido (capability-probed).
   */
  audit?: AuditSink;
  /**
   * Verifica uma senha em claro contra um hash armazenado usando o hasher nativo
   * do app (Scrypt). Injetado pelo `lucidAccountStore` a partir do modelo. Usado
   * pela verificação de histórico de senhas.
   */
  nativeVerifyHash?: (hash: string, plain: string) => Promise<boolean>;
  /**
   * TTL (em horas) do token de verificação de e-mail (cadastro). Default: 24h
   * (aplicado em `buildCore` quando ausente). Ver `resolveEmailTokens` em
   * `lucid_account_store.ts` — não vem de `define_config.ts` porque o
   * `defineConfig` não constrói o `accountStore` (o host já o entrega pronto
   * via `config.accountStore`); o valor precisa chegar aqui na construção.
   */
  emailVerificationTtlHours?: number;
  /**
   * TTL (em horas) do token de troca de e-mail (self-service). Default: 1h —
   * mesma janela do reset de senha, porque reescreve o identificador de
   * recovery da conta. Ver nota de `emailVerificationTtlHours`.
   */
  emailChangeTtlHours?: number;
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Recovery code legível: 10 chars hex em duas metades (ex.: a1b2c-3d4e5). */
export function generateRecoveryCode(): string {
  const raw = randomBytes(5).toString('hex');
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}

/** Comparação de hashes hex resistente a timing. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Indica se o model Lucid tem sua tabela registrada no adapter do DB (runtime probe).
 * Usado para detectar tabelas opcionais como auth_organizations/members/invitations.
 * Mais robusto do que checar colunas: detecta a presença da tabela inteira.
 * Em testes, as tabelas existem se foram criadas na migration do teste.
 */
export async function hasTable(db: any, tableName: string): Promise<boolean> {
  try {
    return await db.connection().schema.hasTable(tableName);
  } catch {
    return false;
  }
}

/**
 * Estado de MFA (lido de `auth_mfa`). Forma normalizada usada pela {@link MfaCapability}:
 *  - `mfaEnabledAt` em EPOCH MS (ou null) — o trusted-device compara contra isso.
 *  - `recoveryCodes` já desserializado (array de hashes) — o repo cuida do JSON.
 */
export interface MfaState {
  totpSecret: string | null;
  mfaEnabledAt: number | null;
  recoveryCodes: string[] | null;
  lastTotpStep: number | null;
}

/** Patch parcial para o upsert em `auth_mfa` — campos ausentes são preservados. */
export interface MfaStatePatch {
  totpSecret?: string | null;
  /** Epoch ms (ou null para limpar). */
  mfaEnabledAt?: number | null;
  recoveryCodes?: string[] | null;
  lastTotpStep?: number | null;
}

/**
 * Repositório do estado de MFA na tabela LIB-OWNED `auth_mfa`, keyed por
 * `account_id`. Acessa o banco pela CONEXÃO do próprio model (`Model.query().client`),
 * a mesma usada pelo restante do store — sem exigir migration no host.
 *
 * O `upsert` é portável (sqlite + pg sem UPSERT nativo): tenta UPDATE pela PK;
 * se não afetou nenhuma linha, faz INSERT. `recovery_codes` é serializado como
 * JSON (string) na escrita e desserializado na leitura (aceita tanto string —
 * sqlite/text — quanto array já parseado — pg jsonb).
 */
export function buildMfaStateRepo(Model: any) {
  const TABLE = 'auth_mfa';

  /** QueryClient ligado à conexão do model (equivale ao `db` do password_history). */
  function client(): any {
    return Model.query().client;
  }

  /** Normaliza `recovery_codes` vindo do banco (json string OU array já parseado). */
  function parseRecoveryCodes(raw: unknown): string[] | null {
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Converte o valor de `mfa_enabled_at` do banco em epoch ms (ou null). */
  function toEpochMs(raw: unknown): number | null {
    if (raw === null || raw === undefined) return null;
    if (raw instanceof Date) return raw.getTime();
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const t = new Date(raw).getTime();
      return Number.isNaN(t) ? null : t;
    }
    // Luxon DateTime (defensivo) — alguns clients podem hidratar assim.
    if (raw && typeof (raw as any).toMillis === 'function') return (raw as any).toMillis();
    return null;
  }

  return {
    /** Lê o estado de MFA da conta; null se não há linha em `auth_mfa`. */
    async read(accountId: string): Promise<MfaState | null> {
      const row = await client().from(TABLE).where('account_id', accountId).first();
      if (!row) return null;
      return {
        totpSecret: row.totp_secret ?? null,
        mfaEnabledAt: toEpochMs(row.mfa_enabled_at),
        recoveryCodes: parseRecoveryCodes(row.recovery_codes),
        lastTotpStep:
          row.last_totp_step === null || row.last_totp_step === undefined
            ? null
            : Number(row.last_totp_step),
      };
    },

    /**
     * Upsert parcial: cria a linha se não existir, senão atualiza apenas os campos
     * presentes no patch (campos ausentes preservados). Portável (sqlite + pg).
     */
    async upsert(accountId: string, patch: MfaStatePatch): Promise<void> {
      const update: Record<string, unknown> = {};
      if ('totpSecret' in patch) update.totp_secret = patch.totpSecret ?? null;
      if ('mfaEnabledAt' in patch) {
        update.mfa_enabled_at =
          patch.mfaEnabledAt === null || patch.mfaEnabledAt === undefined
            ? null
            : new Date(patch.mfaEnabledAt);
      }
      if ('recoveryCodes' in patch) {
        update.recovery_codes =
          patch.recoveryCodes === null || patch.recoveryCodes === undefined
            ? null
            : JSON.stringify(patch.recoveryCodes);
      }
      if ('lastTotpStep' in patch) update.last_totp_step = patch.lastTotpStep ?? null;

      const affected = await client().from(TABLE).where('account_id', accountId).update(update);
      // knex update retorna o nº de linhas afetadas (0 = linha ainda não existe).
      if (!affected) {
        await client()
          .table(TABLE)
          .insert({ account_id: accountId, ...update });
      }
    },

    /** Remove o estado de MFA da conta (disable / reset total). No-op se ausente. */
    async clear(accountId: string): Promise<void> {
      await client().from(TABLE).where('account_id', accountId).delete();
    },
  };
}
