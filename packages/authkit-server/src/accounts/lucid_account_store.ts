import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuditSink } from '../audit/audit_sink.js';
import { type PasswordConfigInput, PasswordManager } from '../password/password_manager.js';
import type { FetchLike, PwnedLogger } from '../password/pwned.js';
import type { AccountStore, AuthAccount } from './account_store.js';
import { buildCore } from './lucid_store/core.js';
import { buildMfa } from './lucid_store/mfa.js';
import { buildOrganizations } from './lucid_store/organizations.js';
import { buildPasswordExpiration, buildPasswordHistory } from './lucid_store/password_hygiene.js';
import { buildProviderIdentity } from './lucid_store/provider_identity.js';
import {
  type AccountSecretEncrypter,
  type LucidStoreContext,
  type WebauthnCeremonies,
  hasTable,
} from './lucid_store/shared.js';
import {
  buildDeletion,
  buildEmailVerificationStatus,
  buildProfile,
  buildStatus,
  hasColumn,
} from './lucid_store/status_profile.js';
import { buildWebauthn } from './lucid_store/webauthn.js';

export type { AccountSecretEncrypter, WebauthnCeremonies };

/**
 * TTLs dos tokens de verificação de e-mail / troca de e-mail (plan 009).
 *
 * Segue o mesmo padrão input/resolved/`resolveX` usado em `define_config.ts`
 * (ex.: `resolveOrganizations`) — mas vive AQUI, não lá: `defineConfig` não
 * constrói o `accountStore` (o host já o entrega pronto, via
 * `config.accountStore`, tipicamente construído por `lucidAccountStore`/
 * `lucidStores` ANTES de chamar `defineConfig`), então não há caminho para um
 * valor resolvido em `define_config.ts` alcançar `buildCore` sem alterar a
 * assinatura dos métodos do `AccountStore` e todos os controllers que os
 * chamam (como acontece com `invitationTtlHours`/`createOrgInvitation`, que
 * recebe o TTL por parâmetro em cada chamada) — fora do escopo desta mudança.
 * O ponto real de wiring é aqui, na construção do store.
 */
export interface EmailTokensConfigInput {
  /** TTL do token de verificação de e-mail (cadastro). Default: 24h. */
  verificationTtlHours?: number;
  /**
   * TTL do token de troca de e-mail (self-service). Default: 1h — mesma
   * janela do reset de senha, porque reescreve o identificador de recovery
   * da conta.
   */
  changeTtlHours?: number;
}

export interface ResolvedEmailTokensConfig {
  verificationTtlHours: number;
  changeTtlHours: number;
}

export function resolveEmailTokens(input?: EmailTokensConfigInput): ResolvedEmailTokensConfig {
  return {
    verificationTtlHours: input?.verificationTtlHours ?? 24,
    changeTtlHours: input?.changeTtlHours ?? 1,
  };
}

/**
 * Serviço de encryption do app (APP_KEY), carregado LAZY via import dinâmico.
 *
 * Não importamos `@adonisjs/core/services/encryption` no topo do módulo de
 * propósito: esse módulo faz `await app.booted()` na carga, o que quebra em
 * contextos sem app (harness de teste). O import dinâmico é disparado na
 * construção do encrypter (boot) e resolve antes da primeira request; até lá (e
 * em testes sem app, onde o import rejeita) o encrypter degrada p/ plaintext.
 */
interface EncryptionService {
  encrypt(value: string): string;
  decrypt<T = string>(value: string): T | null;
}
let encSvc: EncryptionService | undefined;
let encLoading: Promise<void> | undefined;
/** Resolve quando o `loadEncryption()` corrente terminar (sucesso OU falha). */
function loadEncryption(): Promise<void> {
  if (encSvc) return Promise.resolve();
  if (encLoading) return encLoading;
  encLoading = import('@adonisjs/core/services/encryption')
    .then((m) => {
      encSvc = (m as { default: EncryptionService }).default;
    })
    .catch(() => {
      /* sem app booted (ex.: testes) → encSvc fica undefined → plaintext */
    });
  return encLoading;
}

/** Reset do cache de encryption — uso em testes. */
export function __resetAppKeyEncryption(): void {
  encSvc = undefined;
  encLoading = undefined;
  appKeyEncrypterPlaintextWarned = false;
}

/**
 * Injeta um serviço de encryption fake — uso EXCLUSIVO em testes. Permite exercitar
 * o caminho fail-closed do {@link appKeyEncrypter} (decrypt que lança → null) sem
 * precisar de um app AdonisJS booted. Marca `encLoading` como resolvido para que o
 * encrypter use o serviço imediatamente.
 */
export function __setAppKeyEncryptionForTesting(svc: EncryptionService | undefined): void {
  encSvc = svc;
  encLoading = Promise.resolve();
}

/** Garante que só logamos UMA vez o aviso de degradação para plaintext (evita flood). */
let appKeyEncrypterPlaintextWarned = false;

/**
 * Encrypter default do AuthKit, baseado no `APP_KEY` (`@adonisjs/core/services/encryption`).
 * É o default do {@link lucidAccountStore} — o segredo TOTP é encriptado em repouso
 * sem nenhum wiring no app. Passe `encrypter: false` p/ desligar (plaintext).
 *
 * Resiliente: enquanto o serviço de encryption não está disponível (boot inicial /
 * testes sem app), opera em plaintext; uma vez carregado, encripta de verdade.
 */
export function appKeyEncrypter(): AccountSecretEncrypter {
  // Dispara o carregamento do serviço de encryption no boot. A primeira request
  // já o encontra pronto; o `await` interno de `loadEncryption()` é exposto para
  // call-sites que precisem garantir o serviço antes de aceitar escrita.
  loadEncryption();
  return {
    encrypt: (value) => {
      try {
        if (encSvc) return encSvc.encrypt(value);
        // M4: degradação para plaintext NÃO é silenciosa. Em vez de gravar o
        // segredo em claro sem rastro, logamos um aviso CLARO (uma vez) para que
        // o operador detecte a anomalia. O valor ainda é retornado as-is para não
        // quebrar contextos de boot/teste sem app, mas o sinal fica visível.
        if (!appKeyEncrypterPlaintextWarned) {
          appKeyEncrypterPlaintextWarned = true;
          console.warn(
            '[authkit] appKeyEncrypter: serviço de encryption indisponível — ' +
              'segredo TOTP sendo gravado em PLAINTEXT. Garanta que o app esteja ' +
              'booted antes da primeira escrita, ou passe `encrypter: false` para ' +
              'opt-out explícito.',
          );
        }
        return value;
      } catch {
        return value;
      }
    },
    decrypt: (value) => {
      try {
        // Com serviço: decrypt real; falha de integridade/formato → null (negar).
        if (encSvc) return encSvc.decrypt<string>(value) ?? null;
        // Sem serviço (boot/teste sem app): o valor foi gravado em plaintext (ver
        // encrypt acima), então devolvê-lo as-is é o round-trip correto.
        return value;
      } catch {
        // M4 (fail-closed): adulteração / ciphertext inválido NÃO degrada para o
        // valor cru (que mascararia a adulteração e poderia devolver o ciphertext
        // como se fosse o segredo). Negamos o fator retornando null.
        return null;
      }
    },
  };
}

/** Opções do {@link lucidAccountStore}. */
export interface LucidAccountStoreOptions {
  /** Label de issuer mostrado no app autenticador (keyuri). Default: 'AuthKit'. */
  mfaIssuer?: string;
  /** Quantidade de recovery codes gerados no enrollment. Default: 8. */
  recoveryCodeCount?: number;
  /**
   * Encripta o segredo TOTP em repouso. **Default: {@link appKeyEncrypter} (APP_KEY)** —
   * seguro por padrão, sem wiring. Passe um encrypter custom para usar outro KMS, ou
   * `false` para desligar (segredo em claro; ex.: testes / migração).
   *
   * ⚠️ Breaking (0.x): segredos TOTP gravados em CLARO por versões anteriores deixam de
   * decriptar sob o default. Migre (re-encriptar) ou passe `encrypter: false`.
   */
  encrypter?: AccountSecretEncrypter | false;
  /**
   * Model Lucid das identidades de provider (composto de `withProviderIdentity()`),
   * usado por `findByProviderIdentity`/`linkProviderIdentity` (account linking
   * social). Ausente → a capacidade de account linking fica AUSENTE do store (os
   * métodos não existem; hosts email-only continuam funcionando).
   */
  providerIdentityModel?: any;
  /**
   * Model Lucid das credenciais WebAuthn / passkeys (composto de
   * `withWebauthnCredential()`), usado pelos métodos `*Passkey*`. Ausente → a
   * capacidade de passkeys fica AUSENTE do store (os métodos não existem; a UI
   * esconde a seção de passkeys).
   */
  webauthnCredentialModel?: any;
  /**
   * Parâmetros do Relying Party (RP) usados nas cerimônias WebAuthn. Resolvidos a
   * partir do `issuer` no `define_config` quando omitidos. Necessários sempre que
   * `webauthnCredentialModel` é fornecido.
   */
  webauthn?: {
    /** Nome do RP mostrado pelo authenticator. Default: `mfaIssuer`. */
    rpName: string;
    /** RP ID — normalmente o hostname (sem porta) do issuer. */
    rpId: string;
    /** Origin(s) esperada(s) na verificação (scheme://host[:port]). */
    origin: string | string[];
  };
  /**
   * Seam de injeção das cerimônias WebAuthn (generate/verify). Default: as funções
   * reais do `@simplewebauthn/server`. Existe para testes (mockar a verificação SEM
   * um authenticator real) — produção não precisa fornecer.
   */
  webauthnCeremonies?: Partial<WebauthnCeremonies>;
  /**
   * Gerência de senha: verificador de hashes legados (import de outros sistemas),
   * política de complexidade e checagem contra vazamentos (HIBP). Tudo opcional —
   * sem config, a política cai no default (min 8) e o lazy rehash usa só o hasher
   * nativo do model. Veja {@link PasswordConfigInput}.
   */
  password?: PasswordConfigInput;
  /**
   * Sink de auditoria (best-effort), usado para emitir `password.rehashed` quando
   * o lazy rehash acontece. Ausente → o evento não é emitido. Normalmente o
   * `define_config` injeta o `audit` resolvido aqui.
   */
  audit?: AuditSink;
  /**
   * Logger do app (subconjunto `warn`), usado pela checagem de vazamento para
   * registrar falhas fail-safe (timeout/rede). Ausente → silencioso.
   */
  logger?: PwnedLogger;
  /**
   * Seam de injeção do cliente HTTP da checagem de vazamento (HIBP). Default: o
   * `fetch` nativo. Existe para testes — produção não precisa fornecer.
   */
  pwnedFetch?: FetchLike;
  /**
   * Models Lucid para organizations (multi-tenancy). Quando os três forem fornecidos,
   * a capacidade `OrganizationsCapability` fica disponível no store. Os models devem
   * ser tabelas `auth_organizations`, `auth_organization_members` e
   * `auth_organization_invitations`. Ausente → capability AUSENTE (sem tabelas = desligado).
   */
  organizationModels?: {
    OrgModel: any;
    MemberModel: any;
    InvitationModel: any;
  };
  /**
   * TTLs dos tokens de verificação de e-mail / troca de e-mail. Ver
   * {@link EmailTokensConfigInput}. Ausente → 24h / 1h (defaults de
   * `resolveEmailTokens`).
   */
  emailTokens?: EmailTokensConfigInput;
}

/**
 * Implementação default do {@link AccountStore} sobre um model Lucid composto
 * de `withAuthUser()` + `withCredentials()` (+ opcionalmente `withMfa()`). O
 * model carrega `connection`/`table` (app-específico) e, por convenção, uma
 * coluna `fullName` (mapeada de `name`).
 *
 * Composição por CAPACIDADE: o núcleo + MFA são sempre montados; passkeys
 * (WebAuthn) e account linking por provider só são montados quando o model
 * correspondente é fornecido — caso contrário a capacidade fica ABSENTE (os
 * métodos não existem no objeto retornado, em vez de presentes-mas-lançando).
 *
 * @remarks Para capabilities que dependem de tabelas opcionais (ex.:
 *   `auth_password_history`), use {@link lucidAccountStoreAsync} que probe o DB
 *   e monta o store já com as capabilities detectadas, sem a necessidade de
 *   fornecer um model separado. A versão síncrona (`lucidAccountStore`) é mantida
 *   por back-compat — capabilities de tabela ficam AUSENTES nela.
 */
export function lucidAccountStore(
  Model: any,
  options: LucidAccountStoreOptions = {},
): AccountStore {
  const mfaIssuer = options.mfaIssuer ?? 'AuthKit';
  const recoveryCodeCount = options.recoveryCodeCount ?? 8;
  const emailTokens = resolveEmailTokens(options.emailTokens);
  // Default seguro: encripta o TOTP com APP_KEY. `false` desliga (plaintext).
  const encrypter =
    options.encrypter === false ? undefined : (options.encrypter ?? appKeyEncrypter());
  const ProviderIdentityModel = options.providerIdentityModel;
  const WebauthnCredentialModel = options.webauthnCredentialModel;
  const OrgModels = options.organizationModels;
  // RP do WebAuthn: usado nas cerimônias. Default do rpName cai no mfaIssuer.
  const webauthn = options.webauthn ?? {
    rpName: mfaIssuer,
    rpId: 'localhost',
    origin: 'http://localhost',
  };
  // Cerimônias WebAuthn: reais por default, injetáveis para testes.
  const ceremonies: WebauthnCeremonies = {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
    ...options.webauthnCeremonies,
  };

  const passwords = new PasswordManager(options.password, {
    logger: options.logger,
    fetchImpl: options.pwnedFetch,
  });

  const ctx: LucidStoreContext = {
    Model,
    mfaIssuer,
    recoveryCodeCount,
    passwords,
    audit: options.audit,
    emailVerificationTtlHours: emailTokens.verificationTtlHours,
    emailChangeTtlHours: emailTokens.changeTtlHours,
    // Encripta o segredo antes de persistir (no-op sem encrypter).
    sealSecret: (secret: string) => (encrypter ? encrypter.encrypt(secret) : secret),
    // Decripta o segredo armazenado; retorna null em falha/adulteração (no-op sem encrypter).
    openSecret: (stored: string | null | undefined) => {
      if (!stored) return null;
      if (!encrypter) return stored;
      return encrypter.decrypt(stored);
    },
    toAccount: (row: any): AuthAccount => ({
      // `String(...)`: o `id` do AuthAccount vira o claim `sub`, que a spec OIDC
      // exige que seja string. Tabelas adotadas em brownfield quase sempre têm
      // `id` INTEGER auto-increment, e sem a coerção o número vazava para o
      // token (e para todo call-site tipado como string).
      id: String(row.id),
      email: row.email,
      globalRoles: row.globalRoles ?? [],
      name: row.fullName ?? undefined,
      avatarUrl: row.avatarUrl ?? undefined,
    }),
    // nativeVerifyHash: usa o verifyPassword do model para verificar hashes históricos.
    nativeVerifyHash: async (hash: string, plain: string) => {
      // Cria uma instância temporária do model só para usar o método de hash.
      try {
        const tempRow = new Model();
        tempRow.password = hash;
        // verifyPassword é injetado pelo mixin withAuthUser.
        if (typeof tempRow.verifyPassword === 'function') {
          return tempRow.verifyPassword(plain);
        }
        return false;
      } catch {
        return false;
      }
    },
  };

  // Núcleo + MFA são sempre presentes. Passkeys e provider-identity só entram
  // quando o model correspondente foi fornecido (capacidade genuinamente ausente
  // quando não configurada).
  const store = {
    ...buildCore(ctx),
    ...buildMfa(ctx),
    ...(ProviderIdentityModel ? buildProviderIdentity(ctx, ProviderIdentityModel) : {}),
    ...(WebauthnCredentialModel
      ? buildWebauthn(ctx, WebauthnCredentialModel, webauthn, ceremonies)
      : {}),
    // Status (disable/enable) só quando o model tem a coluna `disabled_at`.
    ...(hasColumn(Model, 'disabledAt') ? buildStatus(ctx) : {}),
    // Perfil (nome/avatar) só quando o model tem ao menos uma das colunas.
    ...(hasColumn(Model, 'fullName') || hasColumn(Model, 'avatarUrl') ? buildProfile(ctx) : {}),
    // Estado de verificação de e-mail (leitura) só quando o model tem a coluna.
    ...(hasColumn(Model, 'emailVerifiedAt') ? buildEmailVerificationStatus(ctx) : {}),
    // Deleção da conta: sempre disponível (qualquer model Lucid pode deletar).
    ...buildDeletion(ctx),
    // Expiração de senha: só quando o model tem a coluna `password_changed_at`.
    ...(hasColumn(Model, 'passwordChangedAt') ? buildPasswordExpiration(ctx) : {}),
    // Organizations (multi-tenancy): só quando os três models foram fornecidos.
    ...(OrgModels
      ? buildOrganizations({
          OrgModel: OrgModels.OrgModel,
          MemberModel: OrgModels.MemberModel,
          InvitationModel: OrgModels.InvitationModel,
          findAccountEmail: async (accountId: string) => {
            const row = await Model.find(accountId);
            return row?.email ?? null;
          },
        })
      : {}),
    // Config de senha resolvida — exposta (não-enumerável) para o authkit:doctor
    // inspecionar policy/checkPwned. NÃO faz parte do contrato AccountStore.
    __passwordConfig: passwords.config,
    // Pepper configurado — exposto para o doctor verificar.
    __pepper: passwords.pepper,
    // PasswordManager exposto para controllers poderem aplicar pepper e verificar.
    __passwordManager: passwords,
    // Helper para o controller buscar o hash atual antes de gravar no histórico.
    __getRawRow: async (accountId: string) => {
      try {
        return await Model.find(accountId);
      } catch {
        return null;
      }
    },
    /**
     * Nome da conexão Lucid usada por este store (deriva de `Model.connection`).
     * Exposto para que os call-sites de RuntimeSettings possam passar
     * `{ connection: store.connectionName }` e usar a conexão correta.
     * Undefined quando o model usa a conexão default (back-compat total).
     * NÃO faz parte do contrato AccountStore.
     */
    connectionName: (Model.connection as string | undefined) ?? undefined,
    /**
     * mfaIssuer/webauthn deste store — expostos para o `defineConfig` REUSAR e o
     * consumidor declarar UMA vez (evita repetir mfaIssuer/webauthn no top-level do
     * defineConfig E aqui). NÃO fazem parte do contrato AccountStore.
     */
    __mfaIssuer: mfaIssuer,
    __webauthn: options.webauthn,
    /**
     * O model Lucid por trás deste store — exposto para o `authkit:doctor`
     * inspecionar `$columnsDefinitions` e avisar sobre colunas ausentes ANTES
     * que o fluxo correspondente quebre em produção (ver
     * `doctor/checks.ts#checkAccountStoreColumns`). Importa sobretudo em
     * adoção brownfield, onde o model aponta para uma tabela `users` que já
     * existia e não passou pelas migrations do authkit.
     * NÃO faz parte do contrato AccountStore.
     */
    __model: Model,
  } as AccountStore;

  // Histórico de senhas: capability-probed via tabela `auth_password_history`.
  // A versão síncrona não pode fazer o probe de DB, então a capability fica
  // AUSENTE aqui. Use `lucidAccountStoreAsync` para probe automático, OU injete
  // o `passwordHistoryDb` nas options para montagem síncrona com DB explícito.
  const passwordHistoryDb = (options as any).passwordHistoryDb;
  if (passwordHistoryDb) {
    Object.assign(store, buildPasswordHistory(ctx, passwordHistoryDb));
  }

  return store;
}

/**
 * Options estendidas para uso em testes ou quando o DB é injetado diretamente
 * para o probe de histórico de senhas. Uso interno/avançado.
 */
export interface LucidAccountStoreAsyncOptions extends LucidAccountStoreOptions {
  /**
   * Instância de DB Lucid. Quando fornecida, o factory faz o probe da tabela
   * `auth_password_history` e monta a capability automaticamente.
   */
  db?: any;
}

/**
 * Versão assíncrona do {@link lucidAccountStore} que faz o probe de DB para
 * detectar tabelas opcionais (`auth_password_history`) e monta as capabilities
 * correspondentes. Use esta versão quando o `db` está disponível no momento do
 * boot (ex.: no `register_auth_host.ts` ou no `app/providers/auth_provider.ts`).
 */
export async function lucidAccountStoreAsync(
  Model: any,
  options: LucidAccountStoreAsyncOptions = {},
): Promise<AccountStore> {
  const { db, ...rest } = options;
  const base = lucidAccountStore(Model, rest);

  if (db) {
    // Probe da tabela auth_password_history.
    const historyPresent = await hasTable(db, 'auth_password_history');
    if (historyPresent) {
      const ctx: LucidStoreContext = {
        Model,
        mfaIssuer: options.mfaIssuer ?? 'AuthKit',
        recoveryCodeCount: options.recoveryCodeCount ?? 8,
        passwords: new PasswordManager(options.password, {
          logger: options.logger,
          fetchImpl: options.pwnedFetch,
        }),
        audit: options.audit,
        sealSecret: (s) => s,
        openSecret: (s) => s ?? null,
        toAccount: (row: any) => ({
          // Ver a nota em `toAccount` acima: `sub` precisa ser string.
          id: String(row.id),
          email: row.email,
          globalRoles: row.globalRoles ?? [],
          name: row.fullName ?? undefined,
          avatarUrl: row.avatarUrl ?? undefined,
        }),
      };
      Object.assign(base, buildPasswordHistory(ctx, db));
    }
  }

  return base;
}
