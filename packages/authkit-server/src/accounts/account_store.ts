/** DTO público da conta — o que o provider e os controllers enxergam. Nunca um model Lucid. */
import type { UserLoginMethods } from '../host/user_login_methods.js';

export interface AuthAccount {
  id: string;
  email: string;
  globalRoles?: string[];
  name?: string;
  avatarUrl?: string;
}

export interface CreateAccountInput {
  email: string;
  password: string;
  fullName?: string | null;
  globalRoles?: string[];
  /** social/Google entra como true (provider já verificou o email). Default: false. */
  emailVerified?: boolean;
}

/** Dados para ligar uma identidade de provider a uma conta. */
export interface LinkProviderIdentityInput {
  accountId: string;
  provider: string;
  providerUserId: string;
  email?: string;
}

/** Parâmetros de listagem paginada de contas (console admin). */
export interface ListAccountsParams {
  /** Filtro por e-mail (substring, case-insensitive). */
  search?: string;
  /** Página (1-based). Default: 1. */
  page?: number;
  /** Itens por página. Default: 20. */
  limit?: number;
}

/** Página de resultados + total absoluto (para paginação na UI). */
export interface Paginated<T> {
  data: T[];
  total: number;
}

/**
 * Resumo de uma passkey (credencial WebAuthn) para exibição na UI de gerência.
 * Nunca expõe a chave pública nem o counter.
 */
export interface PasskeySummary {
  /** Credential id (base64url). */
  id: string;
  /** Rótulo legível opcional (ex.: nome do dispositivo). */
  label?: string;
  /** ISO timestamp de criação. */
  createdAt: string;
}

/**
 * Núcleo SEMPRE presente do store de contas: identidade (findById/verifyCredentials),
 * cadastro, reset de senha, verificação de e-mail e administração (listagem/roles).
 *
 * As demais funcionalidades (MFA, passkeys/WebAuthn, account linking por provider)
 * são CAPACIDADES separadas e opcionais — um store pode implementá-las ou não. Veja
 * {@link MfaCapability}, {@link WebauthnCapability}, {@link ProviderIdentityCapability}.
 * O tipo composto usado pela config é {@link AccountStore}.
 */
export interface CoreAccountStore extends AdminCapability {
  // Provider-facing
  findById(id: string): Promise<AuthAccount | null>;
  verifyCredentials(email: string, password: string): Promise<AuthAccount | null>;
  // Cadastro / social
  findByEmail(email: string): Promise<AuthAccount | null>;
  create(input: CreateAccountInput): Promise<AuthAccount>;
  // Reset de senha
  issuePasswordResetToken(email: string): Promise<{ token: string; account: AuthAccount } | null>;
  consumePasswordResetToken(token: string, newPassword: string): Promise<boolean>;
  // Verificação de e-mail
  issueEmailVerificationToken(
    email: string,
  ): Promise<{ token: string; account: AuthAccount } | null>;
  consumeEmailVerificationToken(token: string): Promise<boolean>;
}

/**
 * Administração (console admin opt-in — B6). Hoje faz parte do núcleo (os stores
 * default sempre a implementam e os controllers admin a chamam direto), mas é
 * modelada como capacidade própria para clareza e futura granularidade.
 */
export interface AdminCapability {
  /** Lista contas paginadas, opcionalmente filtrando por e-mail. */
  listAccounts(params: ListAccountsParams): Promise<Paginated<AuthAccount>>;
  /** Substitui as roles globais de uma conta. */
  setGlobalRoles(accountId: string, roles: string[]): Promise<void>;
  /**
   * Capacidade OPCIONAL: conta eficientemente quantas contas possuem a role
   * global `role` (ex.: para a invariante de "último admin", evitando paginar
   * a base inteira em memória). Retorna o número de contas que têm a role.
   *
   * Por que opcional: o formato de `globalRoles` é host-shaped (coluna JSON,
   * tabela de junção, claim externa, etc.), então a lib NÃO consegue emitir uma
   * query de contagem genérica. Hosts que conhecem o próprio shape implementam
   * isto (ex.: `whereJsonSuperset`/`EXISTS` no dialeto deles). Ausente → o
   * caller usa o fallback de scan paginado via {@link listAccounts}.
   *
   * Use {@link supportsCountByGlobalRole} para estreitar em runtime.
   */
  countByGlobalRole?(role: string): Promise<number>;
}

/**
 * Self-service de segurança da conta (console de conta): trocar a senha e o
 * e-mail (com confirmação no NOVO endereço). É uma CAPACIDADE opcional — stores
 * sem suporte omitem os métodos e a UI esconde a seção correspondente.
 *
 * A troca de e-mail usa um token de confirmação que viaja para o NOVO endereço
 * ({@link requestEmailChange}) e é consumido por {@link confirmEmailChange}. O
 * store default (Lucid) reaproveita a coluna `emailVerificationToken` codificando
 * um payload `ec:<email>:<token>` — assim NÃO exige migração nova (ver
 * `lucid_store/core.ts`). O tradeoff é que um token de verificação de cadastro e
 * um de troca de e-mail não coexistem (mesma coluna); na prática são fluxos
 * distintos no tempo.
 */
export interface AccountSecurityCapability {
  /**
   * Define uma nova senha para a conta (após o controller confirmar a senha ATUAL
   * via {@link CoreAccountStore.verifyCredentials}). Retorna false se a conta não
   * existe.
   */
  changePassword(accountId: string, newPassword: string): Promise<boolean>;
  /**
   * Inicia a troca de e-mail: gera um token de confirmação para o `newEmail` e o
   * persiste. Retorna o token + a conta, ou null se a conta não existe OU se o
   * `newEmail` já pertence a outra conta.
   */
  requestEmailChange(
    accountId: string,
    newEmail: string,
  ): Promise<{ token: string; account: AuthAccount; newEmail: string } | null>;
  /**
   * Confirma a troca de e-mail consumindo o token (single-use). Em caso de
   * sucesso aplica o novo e-mail, marca-o como verificado e limpa o token.
   * Retorna `{ ok: true, account, oldEmail, newEmail }` ou `{ ok: false }`.
   * `oldEmail` é o e-mail da conta ANTES da troca (para avisos de segurança ao
   * endereço antigo e auditoria). `account.email` já reflete o novo endereço.
   */
  confirmEmailChange(
    token: string,
  ): Promise<
    { ok: true; account: AuthAccount; oldEmail: string; newEmail: string } | { ok: false }
  >;
}

/**
 * Status da conta (habilitar/desabilitar) — usado pelo console admin para
 * suspender uma conta sem apagá-la. É uma CAPACIDADE opcional: stores sem suporte
 * omitem os métodos e a UI esconde os botões de disable/enable. Quando suportada,
 * os fluxos de login (interaction OIDC + console de conta) DEVEM rejeitar contas
 * desabilitadas (ver `attemptPasswordLogin`).
 *
 * O store default (Lucid) implementa via uma coluna `disabled_at` (timestamp
 * nullable) NO model — quando a coluna existe (probe em `$columnsDefinitions`); se
 * o model não a tiver, a capacidade fica genuinamente ausente (nenhum método é
 * montado) e a UI esconde os botões. Hosts adicionam a coluna por migração própria
 * (mesmo padrão documentado das demais colunas opcionais).
 */
export interface AccountStatusCapability {
  /** Desabilita a conta (impede login). No-op se a conta não existe. */
  disableAccount(accountId: string): Promise<void>;
  /** Reabilita a conta. No-op se a conta não existe. */
  enableAccount(accountId: string): Promise<void>;
  /** Indica se a conta está desabilitada (false se a conta não existe). */
  isDisabled(accountId: string): Promise<boolean>;
}

/**
 * Edição do perfil próprio (console de conta): nome e avatar. CAPACIDADE opcional;
 * stores sem suporte omitem o método e a UI esconde a seção. O store default
 * (Lucid) grava nas colunas `full_name`/`avatar_url` do model — apenas as que
 * existirem (probe em `$columnsDefinitions`).
 */
export interface ProfileCapability {
  /**
   * Atualiza o perfil da conta. Campos `undefined` são deixados como estão;
   * `null` limpa o valor. Retorna a conta atualizada ou null se inexistente.
   */
  updateProfile(
    accountId: string,
    patch: { name?: string | null; avatarUrl?: string | null },
  ): Promise<AuthAccount | null>;
}

/**
 * Account linking por identidade de provider (Google, GitHub, …).
 * `(provider, providerUserId)` é a chave estável vinda do provider OAuth — não
 * depende do e-mail (que pode mudar / não estar presente). Uma conta pode ter
 * várias identidades. Stores sem suporte simplesmente NÃO expõem estes métodos
 * (a capacidade fica ausente) — não há fallback que lança.
 */
export interface ProviderIdentityCapability {
  /** Acha a conta ligada a uma identidade de provider; null se desconhecida. */
  findByProviderIdentity(provider: string, providerUserId: string): Promise<AuthAccount | null>;
  /** Liga (upsert idempotente na chave única) uma identidade de provider a uma conta. */
  linkProviderIdentity(data: LinkProviderIdentityInput): Promise<void>;
  /**
   * Remove TODAS as identidades de provider ligadas a uma conta (usado na deleção
   * de conta — LGPD). Retorna quantas foram removidas. No-op (0) se a conta não tem
   * identidades.
   */
  unlinkAllProviderIdentities(accountId: string): Promise<number>;
  /**
   * Lista as identidades de provider de uma conta (usado no export de dados —
   * LGPD). NUNCA expõe tokens/segredos do provider — só provider + providerUserId +
   * email (quando presente).
   */
  listProviderIdentities(accountId: string): Promise<ProviderIdentitySummary[]>;
}

/** Resumo de uma identidade de provider para export/exibição (sem tokens). */
export interface ProviderIdentitySummary {
  provider: string;
  providerUserId: string;
  email?: string | null;
}

/**
 * Preferência POR USUÁRIO de tipos de login (self-service no console de conta).
 * CAPACIDADE opcional, montada quando o model tem a coluna `login_methods`
 * (JSONB) — hosts adotam por migração própria. `null` = sem preferência (herda
 * os métodos globais efetivos). Ver `host/user_login_methods.ts` para o shape
 * canônico (`UserLoginMethods`) e a semântica da interseção.
 */
export interface LoginMethodsPreferenceCapability {
  /** Lê a preferência da conta; null quando não há preferência persistida. */
  getLoginMethods(accountId: string): Promise<UserLoginMethods | null>;
  /**
   * Grava a preferência da conta. Objeto vazio ou null REMOVE a preferência
   * (volta a herdar os globais). No-op se a conta não existe.
   */
  setLoginMethods(accountId: string, methods: UserLoginMethods | null): Promise<void>;
}

/**
 * MFA / TOTP. Stores sem suporte a MFA omitem a capacidade inteira; o interaction
 * flow trata a ausência como "MFA desligado".
 */
export interface MfaCapability {
  /**
   * Estado do MFA da conta (se o desafio TOTP deve ser exigido no login).
   * `enabledAt` (epoch ms) é o instante em que o MFA foi (re)enrolado, usado pelo
   * mecanismo de "trusted devices": um cookie de confiança emitido ANTES desse
   * instante é considerado inválido (re-enrolar MFA revoga a confiança). Pode ser
   * `null`/ausente quando o MFA não está ativo ou o store não rastreia o instante.
   */
  getMfaState(accountId: string): Promise<{ enabled: boolean; enabledAt?: number | null }>;
  /**
   * Inicia o enrollment TOTP: gera um segredo PENDENTE (mfaEnabledAt continua
   * null) e devolve o segredo + otpauth URI (keyuri). Não ativa o MFA ainda.
   */
  startTotpEnrollment(accountId: string): Promise<{ secret: string; otpauthUri: string } | null>;
  /**
   * Confirma o enrollment: verifica o código contra o segredo pendente; em caso
   * de sucesso ativa o MFA, gera N recovery codes e devolve os códigos em claro
   * (uma única vez).
   */
  confirmTotpEnrollment(
    accountId: string,
    code: string,
  ): Promise<{ ok: boolean; recoveryCodes?: string[] }>;
  /** Verifica um código TOTP contra o segredo ativo. */
  verifyTotp(accountId: string, code: string): Promise<boolean>;
  /** Consome (single-use) um recovery code; true se casou e foi removido. */
  consumeRecoveryCode(accountId: string, code: string): Promise<boolean>;
  /** Desliga o MFA: limpa segredo + mfaEnabledAt + recovery codes. */
  disableMfa(accountId: string): Promise<void>;
}

/**
 * MFA / WebAuthn (passkeys) — 2º fator alternativo ao TOTP. Como o TOTP, é uma
 * capacidade INTEIRA opcional: stores sem suporte a passkeys não a expõem e a UI
 * esconde a seção de passkeys. O `expectedChallenge` é gerado no begin
 * (generate*Options) e DEVE ser guardado pelo controller (na sessão) para ser
 * passado de volta no finish (verify*) — o store não mantém estado de desafio
 * entre as chamadas.
 */
export interface WebauthnCapability {
  /**
   * Inicia o registro de uma passkey: gera as opções de criação
   * (`generateRegistrationOptions`) escopadas à conta (e excluindo credenciais já
   * registradas). Devolve as opções JSON (o controller serializa pro browser) e o
   * `challenge` (base64url) para guardar na sessão. null = conta inexistente.
   */
  generatePasskeyRegistrationOptions(
    accountId: string,
  ): Promise<{ options: Record<string, unknown>; challenge: string } | null>;
  /**
   * Finaliza o registro: verifica a resposta do browser
   * (`verifyRegistrationResponse`) contra o `expectedChallenge` guardado. Em caso
   * de sucesso persiste a credencial (id, publicKey, counter, transports) e
   * habilita o MFA. Retorna true se registrou.
   */
  verifyPasskeyRegistration(
    accountId: string,
    response: unknown,
    expectedChallenge: string,
  ): Promise<boolean>;
  /**
   * Inicia a autenticação por passkey no login: gera as opções
   * (`generateAuthenticationOptions`) restritas às credenciais da conta. Devolve
   * as opções JSON + o `challenge` para guardar na sessão. null = conta sem passkeys.
   */
  generatePasskeyAuthenticationOptions(
    accountId: string,
  ): Promise<{ options: Record<string, unknown>; challenge: string } | null>;
  /**
   * Verifica a resposta de autenticação por passkey
   * (`verifyAuthenticationResponse`) contra o `expectedChallenge` guardado. Em
   * caso de sucesso atualiza o signature counter armazenado. Retorna true se válido.
   */
  verifyPasskeyAuthentication(
    accountId: string,
    response: unknown,
    expectedChallenge: string,
  ): Promise<boolean>;
  /** Lista as passkeys da conta (sem expor chave pública / counter). */
  listPasskeys(accountId: string): Promise<PasskeySummary[]>;
  /** Remove uma passkey (por credential id) da conta. */
  removePasskey(accountId: string, credentialId: string): Promise<void>;
}

/**
 * Verificação de e-mail como ESTADO consultável da conta. CAPACIDADE opcional:
 * stores sem a noção de "e-mail verificado" (ex.: model sem a coluna
 * `email_verified_at`) NÃO expõem o método — e features que dependem dela
 * (`requireVerifiedEmail`) degradam graciosamente (não bloqueiam ninguém) e o
 * doctor avisa. Distinta de {@link CoreAccountStore.consumeEmailVerificationToken},
 * que ESCREVE o estado; aqui só LEMOS.
 */
export interface EmailVerificationStatusCapability {
  /** True se o e-mail da conta está verificado. False se a conta não existe. */
  isEmailVerified(accountId: string): Promise<boolean>;
}

/**
 * Deleção self-service / por admin da conta (LGPD/GDPR — "direito ao
 * esquecimento"). CAPACIDADE opcional: stores sem suporte a delete NÃO expõem o
 * método — a UI esconde a "danger zone" e o admin/REST respondem 409. Apenas
 * apaga a LINHA da conta; o cascade dos demais artefatos (sessões, grants, PATs,
 * passkeys, identidades, MFA, avatar) e a anonimização do audit ficam a cargo do
 * `accountDeletionService` (orquestrador no host).
 */
export interface AccountDeletionCapability {
  /** Apaga a linha da conta. Retorna false se a conta não existe. */
  deleteAccount(accountId: string): Promise<boolean>;
}

/**
 * Histórico de senhas (disallow_password_reuse). CAPACIDADE opcional, presente
 * quando a tabela `auth_password_history` existe (capability-probed). Grava o
 * hash ANTERIOR a cada troca e rejeita reutilização dos últimos N hashes.
 *
 * Tabela mínima: `id UUID/SERIAL PK, account_id TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP NOT NULL`.
 */
export interface PasswordHistoryCapability {
  /**
   * Verifica se a senha em claro já foi usada recentemente (últimos `count` hashes).
   * Retorna true se é REUTILIZAÇÃO (deve ser rejeitada).
   *
   * @param nativeVerify - função de verificação do model (opcional: quando omitida
   *   ou null, o store usa seu próprio hook interno configurado via `nativeVerifyHash`
   *   do contexto Lucid). Mantido para extensibilidade.
   */
  isPasswordReused(
    accountId: string,
    plainPassword: string,
    count: number,
    nativeVerify?: ((hashed: string, plain: string) => Promise<boolean>) | null,
  ): Promise<boolean>;
  /**
   * Grava o hash ATUAL antes de substituí-lo (chamado ANTES de `changePassword`
   * ou equivalente). Best-effort: falha silenciosa não impede a troca.
   */
  recordPasswordHistory(accountId: string, oldHash: string): Promise<void>;
  /**
   * Remove entradas de histórico além dos últimos `count` por conta. Best-effort.
   */
  prunePasswordHistory(accountId: string, count: number): Promise<void>;
}

/**
 * Expiração de senha. CAPACIDADE opcional, presente quando a coluna
 * `password_changed_at` existe no model de auth_users (capability-probed).
 * Atualiza o timestamp em toda troca/criação de senha.
 */
export interface PasswordExpirationCapability {
  /**
   * Retorna o timestamp da última troca de senha, ou null se nunca foi definida
   * (conta legacy sem a coluna / coluna NULL).
   */
  getPasswordChangedAt(accountId: string): Promise<Date | null>;
  /**
   * Atualiza a coluna `password_changed_at` para o momento atual. Chamado após
   * toda troca/criação de senha. Best-effort: falha não impede a operação.
   */
  touchPasswordChangedAt(accountId: string): Promise<void>;
}

/** Entrada do import de uma conta (comando `authkit:users:import`). */
export interface ImportAccountInput {
  email: string;
  /**
   * Hash de senha JÁ pronto, vindo do sistema de origem (qualquer formato:
   * bcrypt `$2y$`, scrypt, pbkdf2, etc.). Inserido COMO ESTÁ — sem re-hash. O
   * lazy rehash no primeiro login transparente cuida da migração. Mutuamente
   * exclusivo com nada: se ausente, a conta nasce sem senha utilizável (até um
   * reset). NÃO passa pela política de senha (dado legado/confiável).
   */
  passwordHash?: string | null;
  fullName?: string | null;
  globalRoles?: string[];
  emailVerified?: boolean;
}

/**
 * Import em massa de contas (comando `authkit:users:import`). CAPACIDADE
 * opcional, presente no store Lucid default. Distinta de
 * {@link CoreAccountStore.create}: NÃO re-hasheia o `passwordHash` (insere como
 * está, para migração lazy) e NÃO aplica a política de senha.
 */
export interface AccountImportCapability {
  /**
   * Insere uma conta com o hash de senha já pronto (sem re-hash, sem política).
   * Retorna a conta criada, ou null se o e-mail já existe (skip).
   */
  importAccount(input: ImportAccountInput): Promise<AuthAccount | null>;
}

/**
 * Login sem senha por "magic link" — um token de uso único e curta duração
 * enviado por e-mail. CAPACIDADE opcional: stores sem suporte omitem os métodos e
 * a UI esconde o botão "me envie um link".
 *
 * O store default (Lucid) reaproveita as colunas de reset de senha
 * (`passwordResetToken` / `passwordResetExpiresAt`) codificando o token com o
 * prefixo `ml:` — assim NÃO exige migração nova (mesmo padrão do `ec:` da troca de
 * e-mail). O tradeoff é que um magic link e um reset de senha pendentes não
 * coexistem (mesma coluna); na prática são fluxos distintos no tempo. Consumir um
 * magic link NÃO altera a senha.
 */
export interface MagicLinkCapability {
  /**
   * Emite um magic link para o e-mail. Retorna o token + a conta, ou null se a
   * conta não existe (o controller SEMPRE renderiza "link enviado" para não vazar
   * a existência de contas).
   */
  issueMagicLinkToken(email: string): Promise<{ token: string; account: AuthAccount } | null>;
  /**
   * Consome (single-use) um magic link. Retorna a conta autenticada ou null se o
   * token é inválido/expirado. NÃO altera a senha.
   */
  consumeMagicLinkToken(token: string): Promise<AuthAccount | null>;
}

/** Resultado tipado da verificação de um código OTP de login. */
export type OtpLoginVerifyResult =
  | { status: 'ok'; account: AuthAccount }
  /** Código errado, tentativa contabilizada (ainda NÃO travado). */
  | { status: 'invalid' }
  /** Tentativas esgotadas → código invalidado (o link continua válido). */
  | { status: 'locked' }
  /** TTL do código expirou. */
  | { status: 'expired' }
  /** Nenhum código pendente para esta interaction/conta. */
  | { status: 'no_code' };

/**
 * Login por OTP (código digitável) — extensão do magic link. CAPACIDADE
 * opcional: quando ausente (ou `login.otp.enabled` desligado) o comportamento é
 * exatamente o de antes (só magic link).
 *
 * O store default (Lucid) CO-LOCALIZA o código com o magic link no MESMO slot
 * (`passwordResetToken`, prefixo `ml2:`), de modo que consumir um mata o outro
 * (single-use conjunto) e o contador de tentativas fica PERSISTIDO junto do
 * código (lockout fail-closed, sem depender de limiter). Ver `host/otp_login.ts`
 * para a decisão de armazenamento completa.
 */
export interface OtpLoginCapability {
  /**
   * Emite o magic link E um código OTP de uma vez (mesmo disparo/e-mail). O
   * `token` retornado vai na URL do link; o `code` (dígitos) vai no corpo do
   * e-mail. Retorna null se a conta não existe (o controller sempre responde
   * "enviado", anti-enumeração). O código fica atrelado ao `uid` da interaction.
   */
  issueMagicLinkWithCode(
    email: string,
    uid: string,
    opts: { digits: number; ttlMinutes: number },
  ): Promise<{ token: string; code: string; account: AuthAccount } | null>;
  /**
   * Verifica um código para a interaction `uid`. Em sucesso consome o código E o
   * magic link (single-use conjunto). Falha incrementa o contador persistido; ao
   * esgotar `maxAttempts` invalida o código mantendo o link válido.
   */
  verifyLoginCode(
    email: string,
    uid: string,
    code: string,
    opts: { maxAttempts: number },
  ): Promise<OtpLoginVerifyResult>;
}

/** DTO público de uma organização. */
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

/** Membro de uma organização. */
export interface OrgMember {
  accountId: string;
  email?: string | null;
  role: string;
  joinedAt: string;
}

/** Convite pendente de uma organização. */
export interface OrgInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt?: string | null;
  createdAt: string;
}

/** Informações da org ativa de uma conta (para emissão de claims). */
export interface ActiveOrgInfo {
  orgId: string;
  orgSlug: string;
  orgRole: string;
}

/**
 * Capacidade de Organizations (multi-tenancy). CAPACIDADE OPCIONAL: quando as três
 * tabelas (`auth_organizations`, `auth_organization_members`, `auth_organization_invitations`)
 * estão presentes, o store expõe estes métodos; caso contrário fica genuinamente ausente.
 */
export interface OrganizationsCapability {
  // --- Org CRUD ---
  createOrg(input: {
    name: string;
    slug: string;
    logoUrl?: string | null;
    metadata?: Record<string, unknown> | null;
    ownerAccountId: string;
  }): Promise<OrgSummary>;
  findOrgById(orgId: string): Promise<OrgSummary | null>;
  findOrgBySlug(slug: string): Promise<OrgSummary | null>;
  listOrgsForAccount(accountId: string): Promise<Array<OrgSummary & { role: string }>>;
  updateOrg(
    orgId: string,
    patch: { name?: string; logoUrl?: string | null; metadata?: Record<string, unknown> | null },
  ): Promise<OrgSummary | null>;
  deleteOrg(orgId: string): Promise<boolean>;

  // --- Members ---
  listOrgMembers(orgId: string): Promise<OrgMember[]>;
  addOrgMember(orgId: string, accountId: string, role: string): Promise<void>;
  removeOrgMember(
    orgId: string,
    accountId: string,
  ): Promise<{ ok: boolean; reason?: 'not_found' | 'last_owner' }>;
  updateOrgMemberRole(
    orgId: string,
    accountId: string,
    newRole: string,
  ): Promise<{ ok: boolean; reason?: 'not_found' | 'last_owner' }>;
  getOrgMembership(orgId: string, accountId: string): Promise<{ role: string } | null>;

  // --- Invitations ---
  createOrgInvitation(input: {
    organizationId: string;
    email: string;
    role: string;
    invitedBy: string;
    ttlHours: number;
  }): Promise<{ invitation: OrgInvitation; token: string }>;
  findInvitationByTokenHash(tokenHash: string): Promise<OrgInvitation | null>;
  listPendingInvitationsForOrg(orgId: string): Promise<OrgInvitation[]>;
  listPendingInvitationsForEmail(email: string): Promise<OrgInvitation[]>;
  acceptInvitation(
    invitationId: string,
    accountId: string,
  ): Promise<{
    ok: boolean;
    reason?: 'not_found' | 'expired' | 'email_mismatch' | 'already_member';
  }>;
  /**
   * Revoga (deleta) um convite pendente. ESCOPADO POR ORG: o convite só é
   * deletado se pertencer à `organizationId` informada — previne IDOR cross-org
   * onde um owner/admin de outra org revogaria o convite sabendo apenas o id.
   * Retorna `false` quando o convite não existe OU não pertence à org (not-found).
   */
  revokeInvitation(organizationId: string, invitationId: string): Promise<boolean>;

  // --- Cascade LGPD ---
  /** Remove todas as memberships e convites enviados pela conta. Best-effort. */
  removeAccountFromAllOrgs(
    accountId: string,
  ): Promise<{ memberships: number; invitations: number }>;
}

/** Type guard: o store implementa a capacidade de Organizations. */
export function supportsOrganizations(
  store: AccountStore,
): store is AccountStore & OrganizationsCapability {
  return typeof (store as any).createOrg === 'function';
}

/**
 * Store de contas usado pela config. É o núcleo SEMPRE presente
 * ({@link CoreAccountStore}) + as capacidades opcionais (MFA, WebAuthn, account
 * linking por provider) marcadas como `Partial` — assim configs/hosts existentes
 * (que referenciam `AccountStore`) compilam sem mudança, e stores que NÃO
 * implementam uma capacidade simplesmente omitem os métodos (em vez de tê-los
 * presentes-mas-lançando). Use os type guards {@link supportsMfa},
 * {@link supportsPasskeys}, {@link supportsProviderIdentity} para estreitar.
 */
export type AccountStore = CoreAccountStore & {
  /**
   * Nome da conexão Lucid usada por este store (deriva de `Model.connection` no
   * store default — ver `lucid_account_store.ts`). Quando presente, os call-sites
   * de RuntimeSettings o repassam como `{ connection }` para que o probe da tabela
   * `auth_settings` seja searchPath-aware (auth vivendo numa conexão/schema
   * próprios). Undefined → conexão default (back-compat total). É metadado
   * opcional, não um método de capacidade — por isso `readonly` e fora dos
   * blocos `Partial<...>` de capacidades probáveis.
   */
  readonly connectionName?: string;
} & Partial<
    MfaCapability &
      WebauthnCapability &
      ProviderIdentityCapability &
      AccountSecurityCapability &
      AccountStatusCapability &
      ProfileCapability &
      MagicLinkCapability &
      OtpLoginCapability &
      EmailVerificationStatusCapability &
      AccountDeletionCapability &
      AccountImportCapability &
      OrganizationsCapability &
      PasswordHistoryCapability &
      PasswordExpirationCapability &
      LoginMethodsPreferenceCapability
  >;

/** Type guard: o store implementa a capacidade de MFA / TOTP. */
export function supportsMfa(store: AccountStore): store is AccountStore & MfaCapability {
  return typeof store.getMfaState === 'function';
}

/**
 * Type guard: o store implementa a contagem eficiente por role global
 * ({@link AdminCapability.countByGlobalRole}). Quando ausente, callers caem no
 * fallback de scan paginado.
 */
export function supportsCountByGlobalRole(
  store: AccountStore,
): store is AccountStore & { countByGlobalRole(role: string): Promise<number> } {
  return typeof store.countByGlobalRole === 'function';
}

/** Type guard: o store implementa a capacidade de passkeys / WebAuthn. */
export function supportsPasskeys(store: AccountStore): store is AccountStore & WebauthnCapability {
  return typeof store.listPasskeys === 'function';
}

/** Type guard: o store implementa account linking por identidade de provider. */
export function supportsProviderIdentity(
  store: AccountStore,
): store is AccountStore & ProviderIdentityCapability {
  return typeof store.findByProviderIdentity === 'function';
}

/** Type guard: o store implementa o self-service de segurança (senha/e-mail). */
export function supportsAccountSecurity(
  store: AccountStore,
): store is AccountStore & AccountSecurityCapability {
  return typeof store.changePassword === 'function';
}

/** Type guard: o store implementa habilitar/desabilitar conta. */
export function supportsAccountStatus(
  store: AccountStore,
): store is AccountStore & AccountStatusCapability {
  return typeof store.disableAccount === 'function';
}

/** Type guard: o store implementa a edição de perfil (nome/avatar). */
export function supportsProfile(store: AccountStore): store is AccountStore & ProfileCapability {
  return typeof store.updateProfile === 'function';
}

/** Type guard: o store implementa login por magic link (passwordless). */
export function supportsMagicLink(
  store: AccountStore,
): store is AccountStore & MagicLinkCapability {
  return typeof store.issueMagicLinkToken === 'function';
}

/** Type guard: o store implementa o login por OTP (código digitável). */
export function supportsOtpLogin(store: AccountStore): store is AccountStore & OtpLoginCapability {
  return (
    typeof store.issueMagicLinkWithCode === 'function' &&
    typeof store.verifyLoginCode === 'function'
  );
}

/** Type guard: o store consegue dizer se o e-mail de uma conta está verificado. */
export function supportsEmailVerificationStatus(
  store: AccountStore,
): store is AccountStore & EmailVerificationStatusCapability {
  return typeof store.isEmailVerified === 'function';
}

/** Type guard: o store implementa a deleção (hard delete) da conta. */
export function supportsAccountDeletion(
  store: AccountStore,
): store is AccountStore & AccountDeletionCapability {
  return typeof store.deleteAccount === 'function';
}

/** Type guard: o store implementa o import em massa de contas. */
export function supportsAccountImport(
  store: AccountStore,
): store is AccountStore & AccountImportCapability {
  return typeof store.importAccount === 'function';
}

/** Type guard: o store implementa histórico de senhas (disallow_password_reuse). */
export function supportsPasswordHistory(
  store: AccountStore,
): store is AccountStore & PasswordHistoryCapability {
  return typeof store.isPasswordReused === 'function';
}

/** Type guard: o store implementa expiração de senha (password_changed_at coluna). */
export function supportsPasswordExpiration(
  store: AccountStore,
): store is AccountStore & PasswordExpirationCapability {
  return typeof store.getPasswordChangedAt === 'function';
}

/** Type guard: o store implementa a preferência por usuário de tipos de login. */
export function supportsLoginMethodsPreference(
  store: AccountStore,
): store is AccountStore & LoginMethodsPreferenceCapability {
  return typeof store.getLoginMethods === 'function';
}
