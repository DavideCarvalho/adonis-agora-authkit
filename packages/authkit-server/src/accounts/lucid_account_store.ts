import type { AuditSink } from '../audit/audit_sink.js';
import {
  ACCOUNT_SECRETS_PURPOSE,
  type AccountSecretsCapability,
  type AuthkitCryptoConfig,
  authkitKeyring,
  BIND_CRYPTO,
  emptyColumnReport,
} from '../crypto/authkit_crypto.js';
import { type Keyring, open, SEALED_PREFIX, seal, sealedStatus } from '../crypto-kit/index.js';
import { loadEncryptionService } from '../keys/keystore_crypto.js';
import { type PasswordConfigInput, PasswordManager } from '../password/password_manager.js';
import type { FetchLike, PwnedLogger } from '../password/pwned.js';
import {
  type AuthkitTablesLocation,
  authkitTable,
  authkitTablesClient,
  BIND_TABLES_LOCATION,
} from '../schema/tables_location.js';
import { describeStackUse, lucidUse } from '../stack.js';
import type { AccountStore, AuthAccount } from './account_store.js';
import { buildCore } from './lucid_store/core.js';
import { buildLoginMethods, supportsLoginMethodsColumn } from './lucid_store/login_methods.js';
import { buildMfa } from './lucid_store/mfa.js';
import {
  defaultOrganizationModels,
  type OrganizationModels,
  organizationModelsOn,
} from './lucid_store/organization_models.js';
import { buildOrganizations } from './lucid_store/organizations.js';
import { buildPasswordExpiration, buildPasswordHistory } from './lucid_store/password_hygiene.js';
import { buildProviderIdentity } from './lucid_store/provider_identity.js';
import {
  type AccountSecretContext,
  type AccountSecretEncrypter,
  buildMfaStateRepo,
  defaultWebauthnCeremonies,
  type KitAccountSecretEncrypter,
  type LucidStoreContext,
  type WebauthnCeremonies,
} from './lucid_store/shared.js';
import {
  buildDeletion,
  buildEmailVerificationStatus,
  buildProfile,
  buildStatus,
  hasColumn,
} from './lucid_store/status_profile.js';
import { buildWebauthn } from './lucid_store/webauthn.js';

export type {
  AccountSecretContext,
  AccountSecretEncrypter,
  KitAccountSecretEncrypter,
  WebauthnCeremonies,
};

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
 * Serviço de encryption do app (`config/encryption.ts`), carregado LAZY por
 * `loadEncryptionService` (o container do app bootado que o provider capturou; sem provider, o
 * `services/encryption` do core). Disparado na construção do encrypter (boot) e resolve antes da
 * primeira request; até lá (e em testes sem app) o encrypter degrada p/ plaintext.
 */
interface EncryptionService {
  encrypt(value: unknown, options?: { purpose?: string }): string;
  decrypt<T = string>(value: string, purpose?: string): T | null;
}
let encSvc: EncryptionService | undefined;
let encLoading: Promise<void> | undefined;
/** Muda a cada troca do serviço (testes): os keyrings em cache são refeitos. */
let encGeneration = 0;
/** Resolve quando o `loadEncryption()` corrente terminar (sucesso OU falha). */
function loadEncryption(): Promise<void> {
  if (encSvc) return Promise.resolve();
  if (encLoading) return encLoading;
  encLoading = loadEncryptionService()
    .then((svc) => {
      encSvc = svc as unknown as EncryptionService;
      encGeneration++;
    })
    .catch(() => {
      /* sem app (ex.: testes) → encSvc fica undefined → plaintext. Sem guardar a falha: a próxima
         chamada tenta de novo, em vez de deixar o processo inteiro em plaintext. */
      encLoading = undefined;
    });
  return encLoading;
}

/** Reset do cache de encryption — uso em testes. */
export function __resetAppKeyEncryption(): void {
  encSvc = undefined;
  encLoading = undefined;
  encGeneration++;
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
  encGeneration++;
}

/** Garante que só logamos UMA vez o aviso de degradação para plaintext (evita flood). */
let appKeyEncrypterPlaintextWarned = false;

/** O que amarra um segredo à sua linha: copiado para outra conta, não abre. */
const totpAad = (context?: AccountSecretContext) =>
  context?.accountId === undefined ? undefined : `auth_mfa.totp_secret:${context.accountId}`;

/**
 * Encrypter default do AuthKit: o crypto kit sobre a encryption do Adonis (o serviço
 * `encryption` do app, ou `crypto.keys`/`crypto.encryption` de `config/authkit.ts`), propósito
 * `authkit:account-secrets`, cada segredo amarrado à conta. Segredos gravados por versões
 * anteriores (a encryption do app, sem propósito) continuam abrindo. É o default do
 * {@link lucidAccountStore}; passe `encrypter: false` p/ desligar (plaintext).
 *
 * Resiliente: enquanto nenhuma encryption está disponível (boot inicial / testes sem app),
 * opera em plaintext (com um aviso); uma vez carregada, sela de verdade.
 */
export function appKeyEncrypter(
  options: { crypto?: () => AuthkitCryptoConfig | undefined } = {},
): KitAccountSecretEncrypter {
  // Dispara o carregamento do serviço de encryption no boot.
  loadEncryption();
  let cached: { key: unknown; generation: number; ring: Promise<Keyring | undefined> } | undefined;
  const keyring = async (): Promise<Keyring | undefined> => {
    await loadEncryption();
    const crypto = options.crypto?.();
    if (!cached || cached.key !== crypto || cached.generation !== encGeneration) {
      const hasSource = !!(crypto?.keys?.length || crypto?.encryption || encSvc);
      cached = {
        key: crypto,
        generation: encGeneration,
        ring: hasSource
          ? authkitKeyring(ACCOUNT_SECRETS_PURPOSE, crypto, encSvc)
          : Promise.resolve(undefined),
      };
    }
    return cached.ring;
  };
  return {
    async encrypt(value, context) {
      const ring = await keyring();
      if (ring) return seal(ring, value, aadOf(context));
      // M4: degradação para plaintext NÃO é silenciosa: um aviso CLARO (uma vez).
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
    },
    async decrypt(value, context) {
      try {
        const ring = await keyring();
        // Sem encryption (boot/teste sem app): o valor foi gravado em plaintext (ver encrypt).
        if (!ring) return value.startsWith(SEALED_PREFIX) ? null : value;
        return await open(ring, value, aadOf(context));
      } catch {
        // M4 (fail-closed): adulteração / chave errada NÃO degrada para o valor cru.
        return null;
      }
    },
    async status(value, context) {
      const ring = await keyring();
      return ring ? sealedStatus(ring, value, aadOf(context)) : 'unreadable';
    },
  };

  function aadOf(context: AccountSecretContext | undefined) {
    const aad = totpAad(context);
    return aad === undefined ? {} : { aad };
  }
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
   * Models Lucid para organizations (multi-tenancy).
   *
   * - **Ausente (default)** → usa os models DEFAULT da lib
   *   ({@link defaultOrganizationModels}), que já mapeiam as três tabelas
   *   lib-owned (`auth_organizations`, `auth_organization_members`,
   *   `auth_organization_invitations`). A `OrganizationsCapability` passa a
   *   existir por padrão. Isso é seguro porque as rotas do console de conta para
   *   orgs JÁ eram montadas por default (`register_auth_host`, bloco `if
   *   (mountOrgs)`, com controller capability-probed); antes, sem os models, a
   *   tela montada respondia 403; agora ela funciona. Não há tela nova — só uma
   *   que deixou de estar quebrada. As tabelas são criadas/evoluídas pelo
   *   `ensureAuthkitSchema`, então o mapeamento não é decisão do host.
   * - `true` → idêntico ao default (atalho explícito; é o que apps existentes
   *   já usam e continua valendo).
   * - `{ OrgModel, MemberModel, InvitationModel }` → escape hatch, para usar
   *   models próprios do host; eles rodam na conexão que declaram. Os defaults
   *   seguem `schema.connection`, como toda tabela lib-owned.
   * - `false` → opt-out explícito: `OrganizationsCapability` AUSENTE no store.
   *   Use quando a dependência atual é `supportsOrganizations === false` (ex.:
   *   store/rotas que assumem a ausência). O `authkit:doctor` avisa se
   *   `organizations.enabled: true` e o store não tem a capability.
   */
  organizationModels?:
    | true
    | false
    | {
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
 * de `withAuthUser()` + `withCredentials()`. O
 * model carrega `connection`/`table` (app-específico) e, por convenção, uma
 * coluna `fullName` (mapeada de `name`).
 *
 * Composição por CAPACIDADE: o núcleo + MFA são sempre montados; passkeys
 * (WebAuthn) e account linking por provider só são montados quando o model
 * correspondente é fornecido — caso contrário a capacidade fica ABSENTE (os
 * métodos não existem no objeto retornado, em vez de presentes-mas-lançando).
 * Organizations também é montada por padrão (models default da lib) e só some
 * com `organizationModels: false`.
 *
 * As tabelas lib-owned que o store lê (`auth_mfa`, `auth_password_history`, as de
 * organizations) usam `schema.connection` (via `tablesClient`/`organizationModelsOn`,
 * informado pelo `defineConfig`); só a tabela da conta segue a conexão do model.
 */
/**
 * Nome da tabela da conta, para o metadado `accountTable` do store.
 *
 * `Model.table` é atribuído no `boot()` do Lucid (naming strategy), então pode
 * ainda estar vazio quando o store é construído. Nesse caso caímos na MESMA
 * função que o Lucid usa (`namingStrategy.tableName`), para o metadado não
 * depender da ordem de inicialização.
 *
 * Best-effort de propósito: model exótico ou store próprio sem isso continua
 * funcionando — o ensure cai no `users` de sempre.
 */
/** Fatia do model Lucid que basta para resolver o nome da tabela. */
interface AccountTableSource {
  table?: unknown;
  namingStrategy?: { tableName?: (model: unknown) => unknown };
}

function resolveAccountTable(Model: AccountTableSource | null | undefined): string | undefined {
  try {
    if (typeof Model?.table === 'string' && Model.table.length > 0) {
      return Model.table;
    }

    const naming = Model?.namingStrategy;
    if (naming && typeof naming.tableName === 'function') {
      const resolved = naming.tableName(Model);
      if (typeof resolved === 'string' && resolved.length > 0) {
        return resolved;
      }
    }
  } catch {
    // Model ainda não pronto (ou não-Lucid) — metadado é opcional.
  }

  return undefined;
}

/** Up to this many ids, filter with `WHERE IN`; above it, read every id instead. */
const ADMIN_ORDER_IN_LIMIT = 500;

/**
 * Of `accountIds`, the ones that exist, in the order `listAccounts` pages them
 * (`ORDER BY email ASC`, sorted by the database so collation matches). One query,
 * plain rows (no model hydration), primary key only.
 */
async function listAccountIdsInAdminOrder(Model: any, accountIds: string[]): Promise<string[]> {
  if (accountIds.length === 0) return [];
  Model.boot?.();
  const pk = Model.$columnsDefinitions?.get?.('id')?.columnName ?? 'id';
  const readAll = async () =>
    (await Model.query().select(pk).orderBy('email', 'asc').pojo()) as any[];
  let rows: any[];
  if (accountIds.length <= ADMIN_ORDER_IN_LIMIT) {
    try {
      rows = await Model.query().select(pk).whereIn(pk, accountIds).orderBy('email', 'asc').pojo();
    } catch {
      // e.g. a member row whose account id doesn't fit the key type: the full read
      // never binds member ids, exactly like the `listAccounts` walk.
      rows = await readAll();
    }
  } else {
    rows = await readAll();
  }
  return rows.map((row) => String(row[pk]));
}

export function lucidAccountStore(
  Model: any,
  options: LucidAccountStoreOptions = {},
): AccountStore {
  const mfaIssuer = options.mfaIssuer ?? 'AuthKit';
  const recoveryCodeCount = options.recoveryCodeCount ?? 8;
  const emailTokens = resolveEmailTokens(options.emailTokens);
  // Default seguro: encripta o TOTP com APP_KEY. `false` desliga (plaintext).
  // O `defineConfig` informa o `crypto` de config/authkit.ts via BIND_CRYPTO (o store nasce antes).
  let boundCrypto: AuthkitCryptoConfig | undefined;
  const encrypter =
    options.encrypter === false
      ? undefined
      : (options.encrypter ?? appKeyEncrypter({ crypto: () => boundCrypto }));
  const ProviderIdentityModel = options.providerIdentityModel;
  const WebauthnCredentialModel = options.webauthnCredentialModel;
  // Organizations é padrão: ausente OU `true` → models default da lib. O
  // opt-out explícito é `false`. O trio explícito segue como escape hatch.
  const orgModelsOption = options.organizationModels;
  const usesDefaultOrgModels = orgModelsOption === undefined || orgModelsOption === true;
  const explicitOrgModels =
    orgModelsOption === false || usesDefaultOrgModels ? undefined : orgModelsOption;
  /**
   * Onde vivem as tabelas do AuthKit (`schema.connection`). O `defineConfig` informa
   * via {@link BIND_TABLES_LOCATION} — o store é construído antes de o config existir.
   * `null` = ainda não informado (store usado fora do `defineConfig`): as tabelas
   * lib-owned seguem a conexão do model e os models de org default, a primária.
   */
  let tablesLocation: AuthkitTablesLocation | null = null;
  const tablesClient = (): any => {
    const db = Model.$adapter?.db;
    if (!tablesLocation || !db) return Model.query().client;
    return authkitTablesClient(db, tablesLocation);
  };
  const orgModels = (): OrganizationModels =>
    explicitOrgModels ??
    (tablesLocation ? organizationModelsOn(tablesLocation) : defaultOrganizationModels);
  const OrgModels = orgModelsOption === false ? undefined : orgModels;
  // RP do WebAuthn: usado nas cerimônias. Default do rpName cai no mfaIssuer.
  const webauthn = options.webauthn ?? {
    rpName: mfaIssuer,
    rpId: 'localhost',
    origin: 'http://localhost',
  };
  // Cerimônias WebAuthn: reais por default, injetáveis para testes.
  const ceremonies: WebauthnCeremonies = {
    ...defaultWebauthnCeremonies,
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
    tablesClient,
    tableName: (name: string) => authkitTable(tablesLocation ?? undefined, name),
    // Encripta o segredo antes de persistir (no-op sem encrypter), amarrado à conta.
    sealSecret: async (secret: string, accountId: string) =>
      encrypter ? await encrypter.encrypt(secret, { accountId }) : secret,
    // Decripta o segredo armazenado; retorna null em falha/adulteração (no-op sem encrypter).
    openSecret: async (stored: string | null | undefined, accountId: string) => {
      if (!stored) return null;
      if (!encrypter) return stored;
      try {
        return (await encrypter.decrypt(stored, { accountId })) ?? null;
      } catch {
        return null;
      }
    },
    toAccount: (row: any): AuthAccount => ({
      // `String(...)`: o `id` do AuthAccount vira o claim `sub`, que a spec OIDC
      // exige que seja string. Tabelas adotadas em brownfield quase sempre têm
      // `id` INTEGER auto-increment, e sem a coerção o número vazava para o
      // token (e para todo call-site tipado como string).
      id: String(row.id),
      email: row.email,
      ...(row.phone && row.phoneVerifiedAt ? { phone: row.phone } : {}),
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
    // Metadado (não capacidade): a tabela da conta, para o ensure da coluna
    // `login_methods` e o doctor saberem onde ela pertence em vez de assumir
    // `users`. Ver `resolveAccountTable`.
    accountTable: resolveAccountTable(Model),
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
    // Preferência por usuário de tipos de login: só quando o model tem a coluna
    // `login_methods` (JSONB). Sem a coluna → capacidade ausente (feature no-op).
    ...(supportsLoginMethodsColumn(Model) ? buildLoginMethods(ctx) : {}),
    // Organizations (multi-tenancy): por padrão usa os models default da lib;
    // ausente só com `organizationModels: false` (opt-out explícito).
    ...(OrgModels
      ? {
          // Origem dos models, para o `authkit:doctor` reportar sem re-inferir.
          // NÃO faz parte do contrato AccountStore.
          __organizationModelsSource: usesDefaultOrgModels ? 'default' : 'explicit',
          ...buildOrganizations({
            get OrgModel() {
              return OrgModels().OrgModel;
            },
            get MemberModel() {
              return OrgModels().MemberModel;
            },
            get InvitationModel() {
              return OrgModels().InvitationModel;
            },
            findAccountEmail: async (accountId: string) => {
              const row = await Model.find(accountId);
              return row?.email ?? null;
            },
            listAccountIdsInAdminOrder: (accountIds: string[]) =>
              listAccountIdsInAdminOrder(Model, accountIds),
          }),
        }
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
     * Nome da conexão Lucid do MODEL da conta (deriva de `Model.connection`) — onde
     * vive a tabela da conta (e a coluna `login_methods`). As tabelas do authkit
     * NÃO seguem esta conexão: elas usam `schema.connection`.
     * Undefined quando o model usa a conexão default.
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

  // Histórico de senhas: tabela lib-owned `auth_password_history`, pela conexão
  // das tabelas do authkit (resolvida a cada uso, como no MFA).
  Object.assign(
    store,
    buildPasswordHistory(ctx, {
      query: () => tablesClient().query(),
      table: (name: string) => tablesClient().table(name),
    }),
  );

  // Não-enumerável: o `defineConfig` informa `schema.connection` por aqui.
  Object.defineProperty(store, BIND_TABLES_LOCATION, {
    value: (location: AuthkitTablesLocation) => {
      tablesLocation = { connection: location.connection, schema: location.schema };
    },
  });
  // Não-enumerável: o `defineConfig` informa o `crypto` de config/authkit.ts por aqui.
  Object.defineProperty(store, BIND_CRYPTO, {
    value: (crypto: AuthkitCryptoConfig | undefined) => {
      boundCrypto = crypto;
    },
  });

  // Segredos selados em repouso (`authkit:crypto:reseal`, doctor `authkit.crypto`): só com um
  // encrypter que sabe dizer como um valor está selado (o default).
  const status = encrypter?.status?.bind(encrypter);
  if (encrypter && status) {
    const repo = buildMfaStateRepo(Model, tablesClient, (name) =>
      authkitTable(tablesLocation ?? undefined, name),
    );
    const accountSecrets: AccountSecretsCapability = {
      async reseal(opts = {}) {
        const report = emptyColumnReport('auth_mfa.totp_secret');
        for (const { accountId, value } of await repo.listSecrets()) {
          const state = await status(value, { accountId });
          report.scanned++;
          report[state]++;
          if (opts.report) continue;
          if (state === 'unreadable') {
            report.failed++;
            continue;
          }
          if (state === 'active' && opts.all !== true) continue;
          const plain = await encrypter.decrypt(value, { accountId });
          if (plain == null) {
            report.failed++;
            continue;
          }
          const fresh = await encrypter.encrypt(plain, { accountId });
          if (opts.dryRun) report.resealed++;
          else if (await repo.replaceSecret(accountId, value, fresh)) report.resealed++;
          else report.skipped++;
        }
        return report;
      },
    };
    Object.defineProperty(store, 'accountSecrets', { value: accountSecrets, enumerable: false });
  }

  // Telescope's Architecture page: the account table lives on the model's connection.
  return describeStackUse(store, () =>
    lucidUse((Model.connection as string | undefined) ?? undefined, 'accounts'),
  );
}
