import type {
  AccessTokenFormat,
  AccessTokensConfig,
  ClientConfig,
  JwksConfig,
  KeystoreStoreConfig,
  ObservabilityConfig,
  TtlConfig,
} from '@adonis-agora/authkit-core';
import { configProvider } from '@adonisjs/core';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import type { AccountStore, AuthAccount } from './accounts/account_store.js';
import { type AdapterFactory, type OidcAdapterClass, adapters } from './adapters/factory.js';
import type { AuditSink } from './audit/audit_sink.js';
import { type EventsConfigInput, composeAuditSink, resolveEvents } from './events/dispatcher.js';
import {
  type BotProtectionConfigInput,
  type ResolvedBotProtectionConfig,
  resolveBotProtection,
} from './host/bot_protection.js';
import type { BrandingConfig } from './host/branding.js';
import {
  type PolicyRouteOption,
  deriveLockedRouteOptions,
  deriveLockedSettingKeys,
} from './host/config_locks.js';
import type { ResolveGeo } from './host/geo.js';
import { type AuthMessages, type I18nConfig, resolveMessages } from './host/i18n.js';
import {
  type OtpLoginConfigInput,
  type ResolvedOtpLoginConfig,
  resolveOtpLoginConfig,
} from './host/otp_login.js';
import type { AuthHostOptions } from './host/register_auth_host.js';
import { edgeRenderer } from './host/renderers/edge_renderer.js';
import { warnUnsatisfiableSudoConfig } from './host/sudo/satisfiability.js';
import type { SudoMethod } from './host/sudo/types.js';
import {
  type ResolvedTrustedDevicesConfig,
  type TrustedDevicesConfigInput,
  resolveTrustedDevices,
} from './host/trusted_device.js';
import { generateJwks } from './keys/jwks_manager.js';
import { KeystoreCodec } from './keys/keystore_codec.js';
import { loadEncryptionService } from './keys/keystore_crypto.js';
import { KeystoreManager, resolveKeystoreVault } from './keys/keystore_manager.js';
import type { PatStore } from './pat/pat_store.js';

export { adapters };
export type { AuthAccount };

export type AuthHostRenderer = (
  ctx: HttpContext,
  view: string,
  props: Record<string, unknown>,
) => unknown;

export interface AuthSocialConfig {
  providers: string[];
}

/**
 * Hooks de e-mail plugáveis (best-effort). Quando ausentes, o host-kit cai no
 * fallback de log em dev (sem enviar e-mail). O envio real fica a cargo do host
 * (ex.: @adonisjs/mail), mantendo a lib agnóstica de transporte.
 */
export interface MailHooks {
  /** Disparado após gerar o token de redefinição de senha. */
  onPasswordReset?: (data: {
    email: string;
    resetUrl: string;
    token: string;
  }) => Promise<void>;
  /** Disparado após gerar o token de verificação de e-mail. */
  onEmailVerification?: (data: {
    email: string;
    verifyUrl: string;
    token: string;
  }) => Promise<void>;
  /** Disparado após gerar o magic link de login (passwordless). */
  onMagicLink?: (data: {
    email: string;
    magicUrl: string;
    token: string;
    /**
     * Código OTP de login, presente APENAS quando `login.otp.enabled` está
     * ligado. O host pode montar o próprio e-mail com link E código. Ausente no
     * fluxo só-magic-link (back-compat).
     */
    code?: string;
    /**
     * Canal escolhido no seletor "choose-first": `'code'` = o host deveria
     * renderizar SÓ o código, `'link'` = SÓ o link. Ausente = ambos (histórico).
     * Puramente de superfície — os dois tokens continuam emitidos co-locados;
     * hosts existentes simplesmente ignoram este campo (back-compat).
     */
    channel?: 'code' | 'link';
  }) => Promise<void>;
  /**
   * Envia o link de CONFIRMAÇÃO DE IDENTIDADE (sudo). Distinto de
   * `onMagicLink`: aquele autentica, este só concede sudo a quem já está
   * logado.
   *
   * OPCIONAL, como todo hook de e-mail daqui: sem ele o próprio host-kit envia
   * pelo mailer default (`@adonisjs/mail`), com branding e i18n. Antes a
   * ausência deste hook tornava `sudoMethods.magicLink()` INDISPONÍVEL, e num
   * host passwordless isso fechava o deadlock de sudo — o único método sem
   * credencial prévia dependia de alguém ter escrito um hook.
   */
  onSudoLink?: (data: { email: string; sudoUrl: string }) => Promise<void>;
  /**
   * Disparado num login bem-sucedido a partir de um dispositivo NOVO (sem cookie
   * de dispositivo confiável válido para a conta). Best-effort, fire-and-forget:
   * uma falha aqui NUNCA quebra o login. Quando ausente mas o mail estiver
   * configurado, o host-kit envia o e-mail default de "novo dispositivo".
   */
  onNewDeviceLogin?: (data: {
    account: { id: string; email: string | null };
    ip?: string | null;
    userAgent?: string | null;
    timestamp: string;
  }) => Promise<void>;
  /** Disparado ao criar um convite de organização. */
  onOrgInvitation?: (data: {
    email: string;
    invitationId: string;
    orgName: string;
    orgSlug: string;
    role: string;
    acceptUrl: string;
    token: string;
  }) => Promise<void>;
  /**
   * Disparado quando o usuário solicita troca de e-mail: envia o link de
   * confirmação para o NOVO endereço. Quando ausente, o host-kit envia o
   * e-mail default. Best-effort, fire-and-forget.
   */
  onEmailChangeConfirm?: (data: {
    /** Novo e-mail que receberá o link de confirmação. */
    email: string;
    confirmUrl: string;
    token: string;
    /** E-mail ATUAL da conta (para contexto no template). */
    oldEmail: string;
  }) => Promise<void>;
  /**
   * Disparado quando o usuário solicita troca de e-mail: envia aviso de
   * segurança para o endereço ATUAL. Quando ausente, o host-kit envia o
   * e-mail default. Best-effort, fire-and-forget.
   */
  onEmailChangeNotice?: (data: {
    /** E-mail ATUAL que receberá o aviso. */
    email: string;
    /** Novo e-mail solicitado (para informação). */
    newEmail: string;
  }) => Promise<void>;
  /**
   * Disparado quando o fator OTP (TOTP/recovery) fica travado por excesso de
   * tentativas falhas. Envia o link de desbloqueio para o e-mail da conta.
   * Best-effort, fire-and-forget.
   */
  onOtpUnlock?: (data: {
    email: string;
    unlockUrl: string;
    token: string;
  }) => Promise<void>;
  /**
   * Disparado pelo `authkit:expire-scan` quando uma conta está prestes a ser
   * desativada por inatividade. Substitui o e-mail default de aviso quando
   * fornecido. Best-effort, fire-and-forget; deduplicado pela janela de
   * `warnDays` da setting `account_expiration`, então cada conta recebe no
   * máximo um aviso por janela.
   */
  onAccountExpirationWarning?: (data: {
    /** E-mail da conta que será desativada. */
    email: string;
    /** Dias restantes até a desativação. */
    expiresInDays: number;
  }) => Promise<void>;
  /**
   * Disparado após um evento de segurança (senha alterada, MFA habilitado/desabilitado,
   * passkey adicionada/removida, e-mail alterado). Substitui o e-mail default quando
   * fornecido. Best-effort, fire-and-forget. Quando ausente, o host-kit envia o e-mail
   * default correspondente a cada kind.
   */
  onSecurityNotice?: (data: {
    account: { id: string; email: string };
    kind:
      | 'password_changed'
      | 'mfa_enabled'
      | 'mfa_disabled'
      | 'passkey_added'
      | 'passkey_removed'
      | 'email_changed';
    ip?: string | null;
    userAgent?: string | null;
    timestamp: string;
    /** Metadados extras (ex.: oldEmail/newEmail para email_changed). */
    metadata?: Record<string, string>;
  }) => Promise<void>;
  /**
   * Remetente (`from`) dos e-mails que a PRÓPRIA lib envia (alertas de novo acesso/
   * dispositivo, reset de senha, verificação, magic link default, avisos de segurança).
   * Tem PRIORIDADE sobre o `from` global do `config/mail.ts` do host — permite que o auth
   * use um remetente próprio (ex.: `Segurança <no-reply-auth@dominio>`) sem trocar o
   * remetente dos e-mails gerais do app. Quando ausente, cai no `config.mail.from` do host
   * e, por fim, no default do @adonisjs/mail. Não afeta os hooks customizados (onMagicLink
   * etc.): nesses o host monta o próprio `from`.
   */
  from?: string | { address: string; name?: string };
  /**
   * Escape hatch: origem (`scheme://host[:port]`) usada para montar os links
   * EMAILADOS (reset de senha, magic link, desbloqueio OTP, convites de
   * organização, verificação/troca de e-mail, avisos de segurança), no lugar
   * do `issuer` resolvido.
   *
   * Por default (campo ausente) os links usam `new URL(issuer).origin` — NUNCA
   * `request.host()` / `X-Forwarded-Host`, que são client-supplied e abrem
   * "password-reset poisoning" (ver `host/origin.ts`). Use este campo apenas
   * quando o mesmo issuer é servido legitimamente sob MÚLTIPLOS hostnames
   * públicos e os links devem seguir um hostname fixo diferente do issuer —
   * o comportamento normal (issuer único) não precisa disto.
   */
  origin?: string;
}

/** Bucket de rate-limit: pontos (requests) permitidos por janela de duração. */
export interface RateLimitBucket {
  /** Número de requests permitidos na janela. */
  points: number;
  /** Duração da janela (ex.: '1 min', '15 mins', 60). */
  duration: string;
}

/**
 * Rate-limiting para as rotas sensíveis do host-kit.
 * Backed pelo `@adonisjs/limiter` (o host precisa tê-lo configurado: config/limiter.ts).
 * Ligado por default; se o limiter não estiver configurado, o throttle vira no-op
 * (fail-safe, sem quebra). Passe `enabled: false` para montar as rotas SEM throttle.
 *
 * Política (buckets login/introspection) é gerenciada em runtime via setting `rate_limit`
 * no admin console ou Admin API — sem necessidade de redeploy.
 */
export interface RateLimitConfigInput {
  /** Liga o rate-limit. Default: true. Infra — permanece no config estático. */
  enabled?: boolean;
  /** Nome do store configurado em config/limiter.ts a usar. Infra — permanece no config estático. */
  store?: string;
}

export interface ResolvedRateLimitConfig {
  enabled: boolean;
  login: RateLimitBucket;
  introspection: RateLimitBucket;
  /**
   * Bucket por IP do grupo admin-api (R6). Anti-brute-force REAL da Bearer key:
   * limita as tentativas vindas do MESMO IP independentemente de qual key foi
   * usada (M8). Default: 30/min — generoso para uso legítimo machine-to-machine,
   * apertado o suficiente para conter um ataque de força bruta por IP.
   */
  adminIp: RateLimitBucket;
  /**
   * Bucket das rotas dos métodos de sudo (`/account/confirm/*`). SEPARADO do
   * `login` de propósito, mesmo tendo os MESMOS limites: os dois orçamentos
   * respondem a perguntas diferentes.
   *
   * `login` conta tentativas de um usuário ANÔNIMO adivinhando credenciais.
   * `sudo` conta reprovas de identidade de um usuário JÁ AUTENTICADO, que
   * chegou na tela de confirmação para uma operação sensível. Compartilhar o
   * bucket cruza os dois: quem erra a senha algumas vezes no `/account/confirm`
   * gasta o orçamento de login do próprio IP (e passa a não conseguir logar em
   * outra aba), e um ataque de credencial no login tranca a confirmação de quem
   * está legitimamente logado atrás do mesmo NAT.
   *
   * Os limites são os mesmos do login (10/min) porque não há razão para
   * afrouxar — o ponto é separar a CONTAGEM, não o teto.
   */
  sudo: RateLimitBucket;
  /**
   * Bucket da verificação de código OTP de login (`/auth/interaction/:uid/otp-verify`),
   * keyed por IP. MAIS APERTADO que o login (5/min vs 10/min): um código de 6
   * dígitos é adivinhável, então o teto por IP é a primeira barreira anti-brute
   * force ANTES do lockout por interaction (contador persistido no slot do código).
   */
  otpLogin: RateLimitBucket;
  store?: string;
}

const RATE_LIMIT_DEFAULTS: {
  login: RateLimitBucket;
  introspection: RateLimitBucket;
  adminIp: RateLimitBucket;
  sudo: RateLimitBucket;
  otpLogin: RateLimitBucket;
} = {
  login: { points: 10, duration: '1 min' },
  introspection: { points: 60, duration: '1 min' },
  adminIp: { points: 30, duration: '1 min' },
  // Mesmos limites do login, bucket separado — ver `ResolvedRateLimitConfig.sudo`.
  sudo: { points: 10, duration: '1 min' },
  // Mais apertado que o login — verificação de código adivinhável.
  otpLogin: { points: 5, duration: '1 min' },
};

export function resolveRateLimit(input?: RateLimitConfigInput): ResolvedRateLimitConfig {
  const enabled = input?.enabled ?? true;
  return {
    enabled,
    login: RATE_LIMIT_DEFAULTS.login,
    introspection: RATE_LIMIT_DEFAULTS.introspection,
    adminIp: RATE_LIMIT_DEFAULTS.adminIp,
    sudo: RATE_LIMIT_DEFAULTS.sudo,
    otpLogin: RATE_LIMIT_DEFAULTS.otpLogin,
    store: input?.store,
  };
}

/**
 * Bloqueio progressivo de conta (anti-brute-force keyed por EMAIL, complementar ao
 * rate-limit por IP). Backed pelo mesmo `@adonisjs/limiter` do host (peer/opt-in) —
 * SEM migração nem DB. Ligado por default; vira no-op se o limiter não existir.
 *
 * Política (enabled/maxAttempts/windowSec/etc.) é gerenciada em runtime via setting
 * `lockout` no admin console ou Admin API — sem necessidade de redeploy.
 */
export interface LockoutConfigInput {
  /** Store do `config/limiter.ts` a usar. Infra — permanece no config estático. */
  store?: string;
}

export interface ResolvedLockoutConfig {
  enabled: boolean;
  maxAttempts: number;
  windowSec: number;
  baseLockoutSec: number;
  maxLockoutSec: number;
  store?: string;
}

export function resolveLockout(input?: LockoutConfigInput): ResolvedLockoutConfig {
  return {
    enabled: true,
    maxAttempts: 5,
    windowSec: 900,
    baseLockoutSec: 60,
    maxLockoutSec: 3600,
    store: input?.store,
  };
}

export interface ResolvedNotificationsConfig {
  newLoginEmail: boolean;
  newDeviceEmail: boolean;
}

export function resolveNotifications(): ResolvedNotificationsConfig {
  return {
    newLoginEmail: true,
    newDeviceEmail: true,
  };
}

/**
 * Registro dinâmico de clients (OIDC Dynamic Client Registration — RFC 7591).
 *
 * Quando habilitado, o oidc-provider expõe o endpoint de registro (`/reg`) e os
 * clients criados ali são PERSISTIDOS pelo MESMO adapter usado para os demais
 * artefatos OIDC. Assim, clients dinâmicos coexistem com os `clients` estáticos
 * da config e ficam disponíveis para uma futura UI admin que gerencia clients no DB.
 */
export interface DynamicRegistrationConfigInput {
  /** Liga o endpoint de registro dinâmico. Default: false (comportamento atual). */
  enabled: boolean;
  /**
   * Exige um Initial Access Token (IAT) como bearer para registrar (RFC 7591 §3).
   * Quando ausente/false, o registro é ABERTO (qualquer um pode registrar um client) —
   * isso raramente é desejável em produção; prefira sempre definir um IAT.
   */
  initialAccessToken?: string;
  /**
   * Habilita o Registration Management (RFC 7592): ler/atualizar/deletar o client
   * registrado via o `registration_access_token` devolvido no registro. Default: false.
   */
  management?: boolean;
}

export interface ResolvedDynamicRegistrationConfig {
  enabled: boolean;
  initialAccessToken?: string;
  management: boolean;
}

/**
 * Resolve a config de registro dinâmico e VALIDA invariantes em tempo de resolução.
 * O Registration Management (RFC 7592) só faz sentido com o registro habilitado
 * (RFC 7591) — `management: true` com `enabled: false` é um erro de configuração.
 */
export function resolveDynamicRegistration(
  input?: DynamicRegistrationConfigInput,
): ResolvedDynamicRegistrationConfig {
  const enabled = input?.enabled ?? false;
  const management = input?.management ?? false;
  if (management && !enabled) {
    throw new Error(
      'authkit: dynamicRegistration.management (RFC 7592) requer ' +
        'dynamicRegistration.enabled: true (RFC 7591). Habilite o registro dinâmico ' +
        'ou desligue o management.',
    );
  }
  return {
    enabled,
    initialAccessToken: input?.initialAccessToken,
    management,
  };
}

/**
 * Device Authorization Grant (RFC 8628). Quando habilitado, o oidc-provider expõe
 * o `device_authorization_endpoint` (`/device/auth`) e a tela de verificação de
 * user-code (`/device`). O grant `urn:ietf:params:oauth:grant-type:device_code`
 * deve ser concedido ao client (lista `grants`) para o fluxo funcionar.
 */
export interface DeviceFlowConfigInput {
  /** Liga o Device Authorization Grant. Default: false. */
  enabled: boolean;
}

export interface ResolvedDeviceFlowConfig {
  enabled: boolean;
}

export function resolveDeviceFlow(input?: DeviceFlowConfigInput): ResolvedDeviceFlowConfig {
  return { enabled: input?.enabled ?? false };
}

/**
 * Uploads — usa o `@adonisjs/drive` JÁ configurado no app (mesmo princípio do
 * mailer/limiter: a infra do host por padrão, sobreponível aqui). Hoje cobre o
 * upload de avatar no console de conta. Se o drive estiver ausente, a feature
 * degrada para o input de URL.
 */
export interface UploadsConfigInput {
  avatars?: {
    /**
     * Backend de storage do avatar. Default: `'auto'` (media se
     * `@adonis-agora/media` estiver presente/configurado, senão o drive builtin).
     * `'builtin'` força o `@adonisjs/drive`; `'media'` força o media (degrada para
     * o input de URL se indisponível).
     */
    storage?: 'auto' | 'builtin' | 'media';
    /** Disk do `@adonisjs/drive` a usar (backend builtin). Default: o disk DEFAULT do app. */
    disk?: string;
    /** Diretório/prefixo das chaves (backend builtin). Default: 'authkit/avatars'. */
    directory?: string;
    /** Collection single-file do media (backend media). Default: 'avatar'. */
    collection?: string;
    /** ownerType do media (backend media). Default: 'AuthAccount'. */
    ownerType?: string;
    /** Tamanho máximo em MB. Default: 5. */
    maxSizeMb?: number;
  };
}

export interface ResolvedUploadsConfig {
  avatars: {
    /** Backend ativo (default 'auto'). */
    storage: 'auto' | 'builtin' | 'media';
    /** Disk explícito; `undefined` = disk DEFAULT do app (backend builtin). */
    disk?: string;
    directory: string;
    /** Collection single-file do media (backend media). */
    collection: string;
    /** ownerType do media (backend media). */
    ownerType: string;
    maxSizeMb: number;
  };
}

export function resolveUploads(input?: UploadsConfigInput): ResolvedUploadsConfig {
  return {
    avatars: {
      storage: input?.avatars?.storage ?? 'auto',
      disk: input?.avatars?.disk,
      directory: input?.avatars?.directory ?? 'authkit/avatars',
      collection: input?.avatars?.collection ?? 'avatar',
      ownerType: input?.avatars?.ownerType ?? 'AuthAccount',
      maxSizeMb: input?.avatars?.maxSizeMb ?? 5,
    },
  };
}

/**
 * DPoP — Demonstrating Proof of Possession (RFC 9449). Quando habilitado, o
 * oidc-provider aceita DPoP proofs e emite tokens sender-constrained
 * (`token_type: DPoP`, com `cnf.jkt`). A discovery passa a anunciar
 * `dpop_signing_alg_values_supported`. Os resolvers do authkit-client aceitam o
 * token via introspecção (a cnf viaja no resultado) — a geração de provas DPoP no
 * client está fora de escopo (documentado como trabalho futuro).
 */
export interface DpopConfigInput {
  /** Liga o DPoP. Default: false. */
  enabled: boolean;
}

export interface ResolvedDpopConfig {
  enabled: boolean;
}

export function resolveDpop(input?: DpopConfigInput): ResolvedDpopConfig {
  return { enabled: input?.enabled ?? false };
}

/**
 * PAR — Pushed Authorization Requests (RFC 9126). Quando habilitado, o
 * oidc-provider expõe o `pushed_authorization_request_endpoint` (`/request`): o
 * client POSTa os parâmetros de authorize e recebe um `request_uri` opaco para
 * usar no `/auth`. Com `requirePushedAuthorizationRequests`, o `/auth` SÓ aceita
 * requests via `request_uri` (parâmetros inline são rejeitados).
 */
export interface ParConfigInput {
  /** Liga o PAR. Default: false. */
  enabled: boolean;
  /** Exige que TODO authorize venha via request_uri do PAR. Default: false. */
  requirePushedAuthorizationRequests?: boolean;
}

export interface ResolvedParConfig {
  enabled: boolean;
  requirePushedAuthorizationRequests: boolean;
}

export function resolvePar(input?: ParConfigInput): ResolvedParConfig {
  return {
    enabled: input?.enabled ?? false,
    requirePushedAuthorizationRequests: input?.requirePushedAuthorizationRequests ?? false,
  };
}

/**
 * Step-up authentication via `acr_values` (MVP pragmático de MFA por requisição).
 * Quando o client solicita `acr_values` contendo `mfaAcr`, o login EXIGE o 2º
 * fator: contas com MFA enrolado passam pelo desafio (o `acr` do id_token vira
 * `mfaAcr` e `amr` recebe `['mfa', método]`); contas SEM MFA enrolado têm o login
 * bloqueado naquela requisição com a instrução de configurar MFA no console.
 */
export interface StepUpConfigInput {
  /** Lista de acr_values anunciados como suportados (discovery). */
  acrValues?: string[];
  /** O acr que dispara a exigência de MFA. Default: 'urn:authkit:mfa'. */
  mfaAcr?: string;
}

export interface ResolvedStepUpConfig {
  acrValues: string[];
  mfaAcr: string;
}

export function resolveStepUp(input?: StepUpConfigInput): ResolvedStepUpConfig {
  const mfaAcr = input?.mfaAcr ?? 'urn:authkit:mfa';
  // Garante que o mfaAcr esteja sempre na lista anunciada como suportada.
  const acrValues = Array.from(new Set([...(input?.acrValues ?? []), mfaAcr]));
  return { acrValues, mfaAcr };
}

/**
 * Login passwordless. Duas vias independentes e opcionais:
 *   - `magicLink`: na tela de senha, oferece "me envie um link de login". Um token
 *     de uso único e curta duração é enviado por e-mail; abrir o link finaliza o
 *     login (amr `['email']`). Sempre responde "link enviado" (não vaza contas).
 *   - `passkeyFirst`: na tela de senha, se a conta tem passkeys, oferece "entrar
 *     com passkey" ANTES da senha. Verificar a passkey já conta como o 2º fator
 *     (amr `['webauthn']`) — não pede senha nem MFA.
 *
 * Ambas exigem que o accountStore implemente a capacidade correspondente
 * (MagicLinkCapability / WebauthnCapability), senão a opção fica oculta.
 */
export interface PasswordlessConfigInput {
  /** Liga o login por magic link (e-mail). Default: false. */
  magicLink?: boolean;
  /** Liga o "entrar com passkey" antes da senha. Default: false. */
  passkeyFirst?: boolean;
  /**
   * Liga o cadastro público passwordless: o signup pede só e-mail + nome (sem
   * senha), cria a conta com uma senha aleatória inutilizável e envia um magic
   * link que finaliza o login (o mesmo fluxo do login por magic link). Default:
   * false. Exige que o accountStore implemente {@link MagicLinkCapability}; sem
   * ela o cadastro passwordless fica indisponível e o fluxo de senha segue valendo.
   */
  signup?: boolean;
}

export interface ResolvedPasswordlessConfig {
  magicLink: boolean;
  passkeyFirst: boolean;
  signup: boolean;
}

export function resolvePasswordless(input?: PasswordlessConfigInput): ResolvedPasswordlessConfig {
  return {
    magicLink: input?.magicLink ?? false,
    passkeyFirst: input?.passkeyFirst ?? false,
    signup: input?.signup ?? false,
  };
}

/**
 * Fixa métodos de login PELO ARQUIVO DE CONFIG, com PRIORIDADE sobre o runtime
 * setting `auth_methods` (o inverso do default — normalmente o runtime manda).
 *
 * Cada campo declarado aqui é AUTORITATIVO: o console admin não sobrescreve em
 * runtime (a UI mostra o toggle travado, "definido no config"). Campos omitidos
 * continuam controlados pelo runtime → default por capability.
 *
 * Guards preservados no resolver:
 *   - Fixar um método em `true` só o liga se a CAPACIDADE existir (ex.: `magicLink: true`
 *     sem store capaz continua oculto). Fixar em `false` é sempre respeitado.
 *   - Fail-safe all-off: se pins + runtime zerarem TODOS os métodos, volta ao default
 *     (nunca trancar todo mundo pra fora).
 *
 * @example
 * // Login sem senha (magic-link + passkey), travado pelo config — sem comando por ambiente:
 * authMethods: { password: false }
 */
export interface AuthMethodsConfigInput {
  /** Fixa o login por senha. */
  password?: boolean;
  /** Fixa o login por magic link (respeitando a capacidade do store). */
  magicLink?: boolean;
  /** Fixa o "entrar com passkey" (respeitando a capacidade do store). */
  passkey?: boolean;
  /** Fixa o link "esqueci a senha" (só aparece com senha ligada, de qualquer forma). */
  forgotPassword?: boolean;
}

/** authMethods resolvido: só os campos que o config FIXOU (os demais ficam a cargo do runtime). */
export type ResolvedAuthMethodsConfig = AuthMethodsConfigInput;

/** Normaliza o input: mantém só os campos booleanos declarados (os pins). */
export function resolveAuthMethodsConfig(
  input?: AuthMethodsConfigInput,
): ResolvedAuthMethodsConfig {
  if (!input) return {};
  const out: ResolvedAuthMethodsConfig = {};
  if (typeof input.password === 'boolean') out.password = input.password;
  if (typeof input.magicLink === 'boolean') out.magicLink = input.magicLink;
  if (typeof input.passkey === 'boolean') out.passkey = input.passkey;
  if (typeof input.forgotPassword === 'boolean') out.forgotPassword = input.forgotPassword;
  return out;
}

/**
 * Política de login por senha/identidade. Hoje cobre `requireVerifiedEmail`:
 * quando ligado, TODO fluxo de login que materializa uma sessão (login por senha,
 * magic link e passkey-first) rejeita contas cujo e-mail ainda NÃO foi verificado,
 * com a instrução de verificar o e-mail.
 *
 * Capability-probed: a checagem depende do accountStore expor
 * {@link EmailVerificationStatusCapability} (`isEmailVerified`). Se o store não
 * tem noção de "e-mail verificado", a feature degrada para NO-OP (não bloqueia
 * ninguém) e o `authkit:doctor` avisa.
 */
export interface LoginConfigInput {
  /** Exige e-mail verificado para autenticar (senha/magic link/passkey-first). Default: false. */
  requireVerifiedEmail?: boolean;
  /**
   * Login por OTP (código digitável) — extensão do magic link. Quando ligado, o
   * MESMO e-mail passa a carregar link E código, os dois completando a mesma
   * interaction. Default: **desligado** (opt-in; sem a config o comportamento é
   * idêntico ao de antes, e-mail idêntico). Ver `host/otp_login.ts`.
   */
  otp?: OtpLoginConfigInput;
}

export interface ResolvedLoginConfig {
  requireVerifiedEmail: boolean;
  otp: ResolvedOtpLoginConfig;
}

export function resolveLogin(input?: LoginConfigInput): ResolvedLoginConfig {
  return {
    requireVerifiedEmail: input?.requireVerifiedEmail ?? false,
    otp: resolveOtpLoginConfig(input?.otp),
  };
}

/**
 * Configuração de cadastro público (signup). Controla se novos usuários podem
 * se auto-registrar. Quando `enabled: false`, a tela de signup mostra uma
 * mensagem de "registro desabilitado" e o POST rejeita. Fluxos administrativos
 * (admin create + org invite) NÃO são afetados — são fluxos privilegiados.
 *
 * O runtime setting `registration` (em `auth_settings`) sobrescreve este valor
 * em tempo de execução sem necessidade de redeploy.
 */
export interface RegistrationConfigInput {
  /** Permite o cadastro público (signup). Default: true. */
  enabled?: boolean;
}

export interface ResolvedRegistrationConfig {
  enabled: boolean;
}

export function resolveRegistration(input?: RegistrationConfigInput): ResolvedRegistrationConfig {
  return {
    enabled: input?.enabled ?? true,
  };
}

/**
 * Access Tokens (RFC 9068) resolvido. `format` é o formato default; `audience` é a
 * `aud` do JWT no modo simples (default issuer). `resources` é o mapa de Resource
 * Servers (RFC 8707) com defaults já aplicados por entrada. Sempre presente — o
 * default (`opaque`, sem resources) preserva 100% o comportamento atual.
 */
export interface ResolvedAccessTokensConfig {
  format: AccessTokenFormat;
  /** `aud` do JWT no modo simples e resource indicator default. */
  audience: string;
  /** Indica se ALGUM AT deve ser JWT (modo simples jwt OU alguma resource jwt). */
  anyJwt: boolean;
  resources: Record<
    string,
    {
      audience: string;
      scopes?: string[];
      format: AccessTokenFormat;
      expiresIn?: number;
    }
  >;
}

/**
 * Resolve a config de access tokens. No modo simples (`format: 'jwt'` sem
 * `resources`), o `audience` default vira o próprio issuer e materializamos uma
 * resource implícita com essa URI para que o oidc-provider emita o JWT (um JWT AT
 * SEMPRE exige um resource indicator com `aud`). Cada entrada de `resources`
 * herda o `format` raiz quando não especifica o seu.
 */
export function resolveAccessTokens(
  issuer: string,
  input?: AccessTokensConfig,
): ResolvedAccessTokensConfig {
  const format: AccessTokenFormat = input?.format ?? 'opaque';
  const audience = input?.audience ?? issuer;
  const resources: ResolvedAccessTokensConfig['resources'] = {};

  for (const [indicator, rc] of Object.entries(input?.resources ?? {})) {
    resources[indicator] = {
      audience: rc.audience ?? indicator,
      scopes: rc.scopes,
      format: rc.format ?? format,
      expiresIn: rc.expiresIn,
    };
  }

  const anyResourceJwt = Object.values(resources).some((r) => r.format === 'jwt');
  const anyJwt = format === 'jwt' || anyResourceJwt;

  return { format, audience, anyJwt, resources };
}

/**
 * Console admin opt-in do IdP (B6). Quando habilitado, monta o grupo `/admin/*`
 * (dashboard, usuários/papéis, clients, audit) atrás de um guard que exige sessão
 * de conta E que a conta tenha pelo menos um dos `roles` nas suas roles globais.
 * Default: DESLIGADO — hosts existentes não mudam de comportamento.
 */
export interface AdminConfigInput {
  /** Liga o console admin. Default: false. */
  enabled: boolean;
  /** Roles globais que dão acesso ao /admin. Default: ['ADMIN']. */
  roles?: string[];
  /**
   * Interruptor de impersonation. Governa as DUAS superfícies:
   *
   *   1. o grant RFC 8693 `urn:ietf:params:oauth:grant-type:token-exchange`
   *      registrado no provider OIDC (`src/provider/oidc_service.ts`) — é por
   *      ele que um admin troca o próprio access token pelo de outra conta;
   *   2. o painel de impersonation do console admin
   *      (`GET {prefix}/api/impersonation/:userId`).
   *
   * `false` desliga as duas: o grant deixa de existir no provider (o token
   * endpoint passa a responder `unsupported_grant_type`) e o painel responde
   * 404. É um kill switch de verdade, não só um esconde-UI.
   *
   * Default: **`true`** — back-compat. O grant sempre foi registrado
   * incondicionalmente e há hosts que o consomem a partir do PRÓPRIO /admin,
   * sem montar o console desta lib; um default `false` os quebraria em runtime,
   * em silêncio. Virar o default para `false` (secure-by-default) é decisão de
   * major.
   *
   * Declarar esta chave também TRAVA a setting de runtime `admin_impersonation`
   * (ver `src/host/config_locks.ts`): o arquivo passa a mandar e a UI/Admin API
   * não altera mais o valor.
   */
  impersonation?: boolean;
}

export interface ResolvedAdminConfig {
  enabled: boolean;
  roles: string[];
  impersonation: boolean;
}

export function resolveAdmin(input?: AdminConfigInput): ResolvedAdminConfig {
  return {
    enabled: input?.enabled ?? false,
    roles: input?.roles && input.roles.length > 0 ? input.roles : ['ADMIN'],
    // Default `true`: preserva o comportamento histórico (grant sempre
    // registrado). Ver o docblock de `AdminConfigInput.impersonation`.
    impersonation: input?.impersonation !== false,
  };
}

/**
 * Admin REST API (R6) — superfície de gestão machine-to-machine, consumida por um
 * futuro SDK. Default: DESLIGADA. A autenticação é por API key (Bearer), checada
 * em tempo constante contra `apiKeys`. Independente do console admin (B6): pode
 * ligar uma sem a outra.
 */
export interface AdminApiConfigInput {
  /**
   * Liga a Admin REST API (`/api/authkit/v1`). Default: auto — ligada quando há
   * ao menos uma apiKey resolvida (incl. via `'env'`). Passe `false` p/ forçar off.
   */
  enabled?: boolean;
  /**
   * API keys aceitas em `Authorization: Bearer <key>`, OU `'env'` para ler de
   * `AUTHKIT_ADMIN_API_KEY` (uma ou várias, separadas por vírgula). Elimina o
   * spread condicional `...(env.get('AUTHKIT_ADMIN_API_KEY') ? {...} : {})`.
   */
  apiKeys?: string[] | 'env';
}

export interface ResolvedAdminApiConfig {
  enabled: boolean;
  apiKeys: string[];
}

/** Lê API keys de `AUTHKIT_ADMIN_API_KEY` (uma ou várias, separadas por vírgula). */
function adminApiKeysFromEnv(): string[] {
  return (process.env.AUTHKIT_ADMIN_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

export function resolveAdminApi(input?: AdminApiConfigInput): ResolvedAdminApiConfig {
  const apiKeys = input?.apiKeys === 'env' ? adminApiKeysFromEnv() : (input?.apiKeys ?? []);
  return {
    // Default inteligente: liga quando há key resolvida (a menos que enabled:false explícito).
    enabled: input?.enabled ?? apiKeys.length > 0,
    apiKeys,
  };
}

/**
 * Organizations (multi-tenancy). Feature opcional — ativa-se automaticamente
 * quando as três tabelas (`auth_organizations`, `auth_organization_members`,
 * `auth_organization_invitations`) estão presentes no DB (capability-probing).
 *
 * Roles disponíveis definem quais values são aceitos em `addMember`/`inviteByEmail`.
 * A role `'owner'` é reservada: uma org SEMPRE precisa de pelo menos um owner.
 * `allowSelfCreate`: se um usuário autenticado pode criar sua própria org (default false).
 * `invitationTtlHours`: TTL dos convites em horas (default 168 = 7 dias).
 * `claimStrategy: 'active'`: emite claims da org ATIVA da sessão (única estratégia implementada).
 */
export interface OrganizationsConfigInput {
  /** Liga explicitamente. Default: auto (liga quando as tabelas existem). */
  enabled?: boolean;
  /**
   * Estratégia de emissão de claims. Só 'active' é suportado:
   * emite org_id/org_slug/org_role da org ativa da sessão via cookie assinado.
   * Default: 'active'.
   */
  claimStrategy?: 'active';
}

export interface ResolvedOrganizationsConfig {
  /** `undefined` = auto (decide em runtime pelo capability-probing do store). */
  enabled: boolean | undefined;
  roles: string[];
  allowSelfCreate: boolean;
  invitationTtlHours: number;
  claimStrategy: 'active';
}

export function resolveOrganizations(
  input?: OrganizationsConfigInput,
): ResolvedOrganizationsConfig {
  return {
    enabled: input?.enabled,
    roles: ['owner', 'admin', 'member'],
    allowSelfCreate: false,
    invitationTtlHours: 168,
    claimStrategy: input?.claimStrategy ?? 'active',
  };
}

/**
 * Parâmetros do Relying Party (RP) das cerimônias WebAuthn / passkeys. Quando
 * omitidos, são derivados do `issuer`: `rpId` = hostname (sem porta), `origin` =
 * origem (scheme://host[:port]) do issuer, `rpName` = nome do app/branding.
 */
export interface WebauthnConfigInput {
  /** Nome do RP mostrado pelo authenticator. Default: branding/app name. */
  rpName?: string;
  /** RP ID — hostname (sem porta) do issuer. Default: hostname do issuer. */
  rpId?: string;
  /** Origin(s) esperada(s) na verificação. Default: origem do issuer. */
  origin?: string | string[];
}

export interface ResolvedWebauthnConfig {
  rpName: string;
  rpId: string;
  origin: string | string[];
}

/**
 * Resolve os parâmetros do RP de WebAuthn a partir do `issuer` quando omitidos.
 * `rpName` cai no `fallbackName` (branding/mfaIssuer) quando ausente.
 */
export function resolveWebauthn(
  issuer: string,
  fallbackName: string,
  input?: WebauthnConfigInput,
): ResolvedWebauthnConfig {
  let host = 'localhost';
  let origin = 'http://localhost';
  try {
    const url = new URL(issuer);
    host = url.hostname;
    origin = url.origin;
  } catch {
    // issuer inválido → mantém defaults de localhost (dev).
  }
  return {
    rpName: input?.rpName ?? fallbackName,
    rpId: input?.rpId ?? host,
    origin: input?.origin ?? origin,
  };
}

/**
 * Recuperação da sessão de interaction OIDC perdida (expirada, cookie velho, F5
 * tardio, restart do servidor). Perder essa sessão é um caso NORMAL: em vez de
 * vazar o `SessionNotFound` cru do `oidc-provider`, o authkit RECUPERA.
 */
export interface InteractionRecoveryConfigInput {
  /**
   * - `'screen'` (default): renderiza a tela themeável `session-expired` (view
   *   Edge built-in `session-expired`, ou a página React do host quando listada
   *   no allowlist do `inertiaRenderer`). Props: `{ loginUrl, brand }`.
   * - `'redirect'`: responde 302 para `redirectTo` (recomeço limpo do login).
   */
  mode?: 'screen' | 'redirect';
  /**
   * Destino do link "voltar ao login" (screen) / do 302 (redirect). Default:
   * `getAccountLoginUrl()` (respeita `accountLoginUrl`). NÃO aponte para uma URL
   * de interaction — evita loop de redirect.
   */
  redirectTo?: string;
}

export interface ResolvedInteractionRecoveryConfig {
  mode: 'screen' | 'redirect';
  redirectTo?: string;
}

export interface AuthServerConfigInput {
  issuer: string;
  adapter: AdapterFactory;
  /**
   * Clientes OIDC pré-carregados no provider ao subir. Útil para testes e
   * migrações pontuais. Para uso em produção, gerencie clients via console admin
   * ou Admin API (`node ace authkit:clients:create`).
   * @internal
   */
  clients?: ClientConfig[];
  /**
   * Config de JWKS, ou `'auto'` (recomendado p/ deploys efêmeros): se a env
   * `AUTHKIT_JWKS` (JSON `{"keys":[...]}`) estiver presente, usa-a inline
   * (`source: 'jwks'`) — sobrevive a restarts/deploys; senão cai no managed
   * persistido em arquivo (`tmp/authkit_jwks.json`) p/ dev. Elimina o ternário
   * env-aware que todo app escrevia.
   */
  jwks: JwksConfig | 'auto';
  ttl?: TtlConfig;
  /** Nome da CLAIM (não do scope) onde os papéis globais são emitidos. Default: 'roles'. */
  globalRolesClaim?: string;
  /**
   * Resolves the global-roles claim at token-mint time. Return the roles to embed
   * in the `<globalRolesClaim>` claim for a first-party client. Lets the host source
   * roles from an external authority (e.g. @adonis-agora/authz) or a custom store
   * instead of the account's stored `globalRoles`. Default when omitted:
   * `account.globalRoles ?? []` (unchanged behavior).
   */
  resolveTokenRoles?: (
    account: AuthAccount,
    context: {
      clientId?: string;
      activeOrg?: { orgId: string; orgSlug: string; orgRole: string } | null;
    },
  ) => string[] | Promise<string[]>;
  cookieKeys?: string[];
  observability?: ObservabilityConfig;
  /** Contrato primário de identidade. Deriva findAccount/verifyCredentials do provider. */
  accountStore: AccountStore;
  /** Opcional — necessário só para fluxos de Personal Access Token. */
  patStore?: PatStore;
  /** Caminho base onde o host-kit monta as rotas OIDC. Default: '/oidc'. */
  mountPath?: string;
  /**
   * Montagem AUTOMÁTICA das rotas do host-kit, sem `registerAuthHost` no
   * `start/routes.ts`.
   *
   * - ausente (default) → NÃO auto-monta. O app chama `registerAuthHost(router)`
   *   no `start/routes.ts`, como sempre (back-compat).
   * - `true` → o provider monta as rotas no boot chamando `registerAuthHost` —
   *   literalmente a mesma função, não uma segunda implementação.
   * - objeto → auto-monta usando estes valores como DEFAULTS estruturais.
   * - `false` → não auto-monta, explicitamente (o kill switch documentado).
   *
   * ⚠️ Auto-montar E chamar `registerAuthHost` no `start/routes.ts` é duplo
   * registro: a chamada manual LANÇA com a instrução de qual dos dois remover
   * (duas rotas com o mesmo nome derrubam o boot do AdonisJS).
   *
   * ⚠️ A auto-montagem roda no `boot()` do provider, ANTES do `start/routes.ts`
   * — as rotas do authkit ficam registradas primeiro, e os wildcards
   * (`${mountPath}/*`, `${adminPrefix}/*`) casam antes de rotas do app com
   * padrão sobreposto. Quem precisa da ordem inversa continua chamando
   * `registerAuthHost` na posição que quiser.
   *
   * As chaves de POLÍTICA aqui dentro (`social`, `rateLimit`, `sudoMethods`,
   * `admin`, `adminApi`) são redundantes: elas já vêm dos campos de topo do
   * config e são travadas por eles. Use este objeto para o ESTRUTURAL —
   * `accountRoutes`, `account`, `accountLoginUrl`, `mountPath`.
   */
  routes?: boolean | AuthHostOptions;
  /**
   * Destino default da área da conta: pós-login do console (sem `return_to`),
   * confirmações de e-mail e fallback de redirects. Default: '/account/security'.
   * Hosts que preferem mandar o usuário direto pro app podem apontar pra rota deles.
   */
  accountHome?: string;
  /**
   * Renderer de páginas do host (Inertia ou Edge). Default (quando omitido):
   * {@link edgeRenderer}. Sem isso, TODA request a `/account/*` e
   * `/auth/interaction/*` estourava um 500 sem explicação — `render` era
   * `undefined` e o controller chamava `render(ctx, ...)` diretamente.
   */
  render?: AuthHostRenderer;
  /**
   * Recuperação graciosa da sessão de interaction OIDC perdida. Default:
   * `{ mode: 'screen' }` — renderiza a tela themeável `session-expired`. Use
   * `{ mode: 'redirect' }` para um 302 ao login. Ver
   * {@link InteractionRecoveryConfigInput}.
   */
  interactionRecovery?: InteractionRecoveryConfigInput;
  /** Configuração de branding por cliente. */
  branding?: BrandingConfig;
  /** Internacionalização das telas. Default: pt-BR embutido (zero config). */
  i18n?: I18nConfig;
  /** Configuração de providers sociais. */
  social?: AuthSocialConfig;
  /** Segredo para autenticar requests de introspecção de PAT. */
  patIntrospectionSecret?: string;
  /** Rate-limiting das rotas sensíveis (anti-brute-force). Default: ligado (no-op se o limiter não estiver configurado). */
  rateLimit?: RateLimitConfigInput;
  /** Bloqueio progressivo de conta por email em falhas repetidas. Default: ligado (no-op sem limiter). */
  lockout?: LockoutConfigInput;
  /** Hooks de e-mail (reset de senha / verificação). Opcional — fallback de log em dev. */
  mail?: MailHooks;
  /** Sink de auditoria (best-effort). Opcional — quando ausente, auditoria é no-op. */
  audit?: AuditSink;
  /**
   * Métodos de confirmação de identidade (sudo mode). A ordem do array é a
   * ordem de exibição; o último método usado com sucesso é promovido ao topo.
   *
   * Ausente → a lista que `registerAuthHost` MONTOU, DERIVADA contra este
   * config: `[password, passkey]` num host com senha (o comportamento
   * histórico) e `[passkey, magicLink]` num host que declarou
   * `authMethods: { password: false }` — que de outra forma não teria um único
   * método satisfazível. É a mesma resposta que os handlers dão nesse caso —
   * "vale o que tem rota, menos o que este host não consegue satisfazer" —, e é
   * o que impede a tela de oferecer um método sem endpoint ou de esconder um que
   * funciona. Ver `derivedSudoMethods` em `host/sudo/runtime.ts`.
   *
   * DECLARAR esta lista DESLIGA a derivação: ela SUBSTITUI os defaults e vale ao
   * pé da letra. Um host passwordless que a declare PRECISA incluir ao menos um
   * método que não exija credencial previamente cadastrada — `oidcStepUp()` ou
   * `magicLink()` — senão o usuário fica sem caminho para exportar/excluir os
   * próprios dados, e é isso que o aviso de boot de
   * `host/sudo/satisfiability.ts` denuncia.
   */
  sudo?: { methods?: SudoMethod[] };
  /**
   * Eventos/webhooks: o host observa CADA evento de auditoria via callback
   * in-process (`onEvent`) e/ou POST de webhook (`webhook`). Best-effort, nunca
   * lança para a request. Quando setado, o `audit` resolvido vira um fan-out
   * (sink original + onEvent + webhook).
   */
  events?: EventsConfigInput;
  /**
   * Label de issuer TOTP mostrado nos apps autenticadores (MFA). Default: 'AuthKit'.
   * O `lucidAccountStore` lê isso para montar o keyuri/QR.
   */
  mfaIssuer?: string;
  /**
   * Parâmetros do RP de WebAuthn / passkeys (2º fator alternativo ao TOTP).
   * Opcional — quando omitido, é derivado do `issuer`. As passkeys só ficam
   * disponíveis quando o accountStore + o model de credenciais suportam.
   */
  webauthn?: WebauthnConfigInput;
  /**
   * Registro dinâmico de clients (RFC 7591/7592). Default: desligado. Quando ligado,
   * os clients registrados são persistidos pelo mesmo adapter OIDC.
   */
  dynamicRegistration?: DynamicRegistrationConfigInput;
  /** Device Authorization Grant (RFC 8628). Default: desligado. */
  deviceFlow?: DeviceFlowConfigInput;

  /** Uploads (avatar) via o `@adonisjs/drive` do app. Default: drive default, 5MB. */
  uploads?: UploadsConfigInput;
  /** DPoP — sender-constrained tokens (RFC 9449). Default: desligado. */
  dpop?: DpopConfigInput;
  /** Pushed Authorization Requests (RFC 9126). Default: desligado. */
  par?: ParConfigInput;
  /** Step-up auth via acr_values (MFA por requisição). Default: vazio (só o mfaAcr derivado). */
  stepUp?: StepUpConfigInput;
  /**
   * Trusted devices: pular o MFA neste dispositivo por N dias via cookie
   * encriptado (appKey-backed), sem migração. Default: ligado, 30 dias. Step-up
   * (acr_values) sempre ignora o cookie e força o MFA.
   */
  trustedDevices?: TrustedDevicesConfigInput;
  /**
   * Bot protection plugável (CAPTCHA/challenge), agnóstica de vendor. O HOST
   * fornece o `verify`; a lib injeta o widget nas telas e checa o token ANTES de
   * processar credenciais. Default: desligado. Fail-safe: erro/timeout no `verify`
   * PERMITE o fluxo (disponibilidade > proteção).
   */
  botProtection?: BotProtectionConfigInput;
  /**
   * Login passwordless (magic link por e-mail e/ou passkey-first). Default: ambos
   * desligados. Exigem as capacidades correspondentes no accountStore.
   */
  passwordless?: PasswordlessConfigInput;
  /**
   * Fixa métodos de login pelo arquivo de config, com PRIORIDADE sobre o runtime
   * setting `auth_methods`. Cada campo declarado trava o método (o console admin não
   * sobrescreve). Default: `{}` (tudo controlado pelo runtime). Ver {@link AuthMethodsConfigInput}.
   */
  authMethods?: AuthMethodsConfigInput;
  /**
   * Política de login (hoje: `requireVerifiedEmail`). Default: tudo desligado.
   * `requireVerifiedEmail` é capability-probed (precisa de `isEmailVerified` no store).
   */
  login?: LoginConfigInput;
  /**
   * Configuração de cadastro público. Default: `{ enabled: true }` (aberto).
   * O runtime setting `registration` em `auth_settings` sobrescreve este valor
   * sem necessidade de redeploy.
   */
  registration?: RegistrationConfigInput;
  /**
   * Access Tokens (RFC 9068). Default: `{ format: 'opaque' }` (comportamento atual).
   * `{ format: 'jwt' }` faz TODO AT virar JWT RFC 9068 validável via jwks_uri.
   * `resources` mapeia resource indicators (RFC 8707) para audiences/scopes/formato/TTL por API.
   */
  accessTokens?: AccessTokensConfig;
  /**
   * Console admin do IdP (B6). Default: desligado.
   *
   * Declarar esta chave TRAVA o liga/desliga: `registerAuthHost(router, { admin })`
   * passa a ser ignorado (ver `deriveLockedRouteOptions`). Não repita o
   * `enabled` no `start/routes.ts` — no máximo passe `admin: { prefix }`, que é
   * estrutural e continua valendo.
   */
  admin?: AdminConfigInput;
  /**
   * Admin REST API (R6). Default: desligada. Autenticação por API key.
   *
   * Declarar esta chave TRAVA o liga/desliga: `registerAuthHost(router, { adminApi })`
   * passa a ser ignorado (ver `deriveLockedRouteOptions`). Não repita o
   * `enabled` no `start/routes.ts` — no máximo passe `adminApi: { prefix }`, que
   * é estrutural e continua valendo.
   */
  adminApi?: AdminApiConfigInput;
  /**
   * Organizations (multi-tenancy). Default: auto (liga quando as tabelas
   * `auth_organizations`, `auth_organization_members`, `auth_organization_invitations`
   * existem no DB). Veja {@link OrganizationsConfigInput}.
   */
  organizations?: OrganizationsConfigInput;
  /**
   * Resolução de geolocalização PLUGÁVEL para o IP das sessões (console + Admin
   * API). A lib NÃO embute banco de geo: o host pluga (ex.: MaxMind/ipapi). Default:
   * ausente → as sessões mostram só o IP (sem localização). Fail-safe com timeout
   * curto: erro/timeout → sem localização.
   */
  resolveGeo?: ResolveGeo;
  /**
   * Gestão automática do schema das OITO tabelas do authkit:
   * `authkit_oidc_payloads`, `auth_settings`, `auth_password_history`,
   * `auth_mfa`, `auth_session_revocations` e as três de organizations
   * (`auth_organizations`, `auth_organization_members`,
   * `auth_organization_invitations`). Ver `TABLES` em `schema/ensure.ts` — a
   * lista aqui existe para o leitor, mas quem manda é aquele array.
   *
   * FORA desta gestão: `authkit_keystore`, criada sob demanda pelo
   * `LucidKeystoreVault` na primeira escrita, e as tabelas do MODEL do host
   * (`auth_users` etc.), que são migrations do app.
   *
   * - `autoManage` (default `true`): no boot, cria as tabelas que faltam e
   *   adiciona colunas novas (aditivo — nunca dropa nem altera tipos).
   * - `autoManage: false`: nada roda no boot; gerencie o schema você mesmo —
   *   de preferência chamando `ensureAuthkitSchema(this.db)` numa migration.
   * - `connection`: conexão Lucid a usar (default: primária).
   */
  schema?: { autoManage?: boolean; connection?: string };
  /**
   * Ciclo de vida da conta (LGPD/GDPR). OPT-IN para workflows DURÁVEIS:
   *
   * - `durable` (default `false`/ausente): comportamento SÍNCRONO de sempre — a
   *   deleção/export rodam in-process via `AccountDeletionService`/
   *   `AccountExportService` (byte-idêntico ao anterior).
   * - `durable: true`: os endpoints ENFILEIRAM os workflows duráveis
   *   (`authkit.account.delete` / `authkit.account.export`) no `WorkflowEngine` do
   *   app. O app DEVE registrar os workflows (via
   *   `@adonis-agora/authkit-server/durable`) e rodar um worker. No self-service de
   *   deleção, a sessão do ator é revogada SINCRONAMENTE (logout imediato) e o
   *   resto do cascade roda async.
   */
  accountLifecycle?: { durable?: boolean };
  /**
   * Integração OPT-IN com `@adonisjs/auth`. authkit-server autentica a área de
   * conta (`/account/*`) com sua PRÓPRIA sessão (`ACCOUNT_SESSION_KEY`, via
   * `@adonisjs/session` diretamente) — nunca chamou `@adonisjs/auth` em lugar
   * nenhum, então `ctx.auth.user`/`middleware.auth()`/Bouncer's
   * `() => ctx.auth.user` ficavam sempre `undefined` num host que os use.
   *
   * Quando `adonisAuth.guard` é setado, `AccountSessionController#login`/`logout`
   * TAMBÉM chamam `ctx.auth.use(guard).login(account)`/`.logout()` do guard
   * indicado — em paralelo ao cookie bespoke do authkit, que continua sendo a
   * fonte de verdade das rotas do próprio authkit. Requer um user provider
   * plugado nesse guard em `config/auth.ts` — veja {@link authkitUserProvider}.
   *
   * Default (ausente): comportamento de sempre, sem tocar em `ctx.auth`.
   * Degrada limpo mesmo sem `@adonisjs/auth` instalado (peer opcional): o
   * código só acessa `ctx.auth` quando esta opção está setada E a propriedade
   * existe no ctx (host com `@adonisjs/auth` de fato inicializado).
   */
  adonisAuth?: { guard: string };
}

export interface ResolvedServerConfig {
  issuer: string;
  AdapterClass: OidcAdapterClass;
  clients: ClientConfig[];
  jwks: { keys: Record<string, any>[] };
  /**
   * Eco do `jwks` de INPUT (source/store/algorithm) — o `jwks` resolvido acima é o
   * keyset materializado e perde esses campos; comandos como `authkit:keys:rotate`
   * precisam do shape original para localizar o keystore.
   */
  jwksConfig: JwksConfig;
  ttl: {
    accessToken: number;
    refreshToken: number;
    idToken: number;
    session: number;
  };
  globalRolesClaim: string;
  /**
   * Resolves the global-roles claim at token-mint time (first-party only). When
   * omitted, the mint falls back to `account.globalRoles ?? []` (unchanged behavior).
   */
  resolveTokenRoles?: (
    account: AuthAccount,
    context: {
      clientId?: string;
      activeOrg?: { orgId: string; orgSlug: string; orgRole: string } | null;
    },
  ) => string[] | Promise<string[]>;
  cookieKeys: string[];
  observability: ObservabilityConfig;
  findAccount: (sub: string) => Promise<AuthAccount | null>;
  verifyCredentials: (email: string, password: string) => Promise<{ id: string } | null>;
  accountStore: AccountStore;
  patStore?: PatStore;
  mountPath: string;
  /** Destino default pós-confirmação do console (sudo mode) e demais fallbacks de conta. Default: '/account/security'. */
  accountHome?: string;
  render?: AuthHostRenderer;
  /** Recuperação de sessão de interaction perdida resolvida (default `{ mode: 'screen' }`). */
  interactionRecovery: ResolvedInteractionRecoveryConfig;
  branding?: BrandingConfig;
  social?: AuthSocialConfig;
  patIntrospectionSecret?: string;
  rateLimit: ResolvedRateLimitConfig;
  /** Bloqueio progressivo de conta resolvido (sempre presente; default ligado). */
  lockout: ResolvedLockoutConfig;
  /** Notificações de segurança resolvidas (sempre presente; default ligado). */
  notifications: ResolvedNotificationsConfig;
  mail?: MailHooks;
  audit?: AuditSink;
  /** Métodos de sudo configurados pelo host. Ausente → defaults do controller. */
  sudo?: { methods?: SudoMethod[] };
  mfaIssuer: string;
  /** RP de WebAuthn resolvido (sempre presente; derivado do issuer por default). */
  webauthn: ResolvedWebauthnConfig;
  dynamicRegistration: ResolvedDynamicRegistrationConfig;
  /** Device Authorization Grant resolvido (default desligado). */
  deviceFlow: ResolvedDeviceFlowConfig;
  /** Uploads resolvido (avatar via drive do app; sempre presente). */
  uploads: ResolvedUploadsConfig;
  /** DPoP resolvido (default desligado). */
  dpop: ResolvedDpopConfig;
  /** PAR resolvido (default desligado). */
  par: ResolvedParConfig;
  /** Step-up auth resolvido (mfaAcr sempre presente). */
  stepUp: ResolvedStepUpConfig;
  /** Trusted devices resolvido (default ligado, 30 dias). */
  trustedDevices: ResolvedTrustedDevicesConfig;
  /** Bot protection resolvido (undefined quando não configurado). */
  botProtection?: ResolvedBotProtectionConfig;
  /** Passwordless resolvido (default tudo desligado). */
  passwordless: ResolvedPasswordlessConfig;
  /** Métodos de login fixados pelo config (prioridade sobre runtime; default `{}`). */
  authMethods: ResolvedAuthMethodsConfig;
  /** Política de login resolvida (requireVerifiedEmail; default desligado). */
  login: ResolvedLoginConfig;
  /** Configuração de cadastro público resolvida (enabled; default true). */
  registration: ResolvedRegistrationConfig;
  /** Access Tokens resolvido (RFC 9068; default opaque). */
  accessTokens: ResolvedAccessTokensConfig;
  /** Console admin resolvido (sempre presente; default desligado). */
  admin: ResolvedAdminConfig;
  /** Admin REST API resolvida (sempre presente; default desligada). */
  adminApi: ResolvedAdminApiConfig;
  /** Organizations resolvido (sempre presente; default auto). */
  organizations: ResolvedOrganizationsConfig;
  /** Resolver de geo plugável (undefined quando o host não plugou). */
  resolveGeo?: ResolveGeo;
  /** Catálogo de mensagens ativo (locale resolvido), pronto para os renderers. */
  messages: AuthMessages;
  /** Locale ativo (default 'pt-BR'). */
  locale: string;
  /** Gestão automática de schema resolvida (default ligada). */
  schema: { autoManage: boolean; connection?: string };
  /**
   * Ciclo de vida da conta resolvido. `durable` default `false` → caminho
   * síncrono de sempre. `true` → endpoints enfileiram os workflows duráveis.
   */
  accountLifecycle: { durable: boolean };
  /** Keys de `auth_settings` travadas por terem sido definidas no defineConfig. */
  lockedSettingKeys: string[];
  /** Auto-montagem das rotas do host-kit. Ver {@link AuthServerConfigInput.routes}. */
  routes?: boolean | AuthHostOptions;
  /**
   * Opções de POLÍTICA de `registerAuthHost` travadas por terem sido definidas
   * no defineConfig (config vence sobre o argumento). Ver `deriveLockedRouteOptions`.
   */
  lockedRouteOptions: PolicyRouteOption[];
  /** Integração opt-in com `@adonisjs/auth` (ausente = não integrado; comportamento de sempre). */
  adonisAuth?: { guard: string };
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function toSeconds(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const m = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!m) throw new Error(`TTL inválido: ${value}`);
  return Number(m[1]) * UNITS[m[2]];
}

/**
 * Default backend-aware de encryption: file/drive/lucid/redis ON; vaults reais OFF.
 * Evita gravar chaves privadas em texto claro em stores que não gerenciam segredos
 * (blobs burros). Vaults reais (aws-secrets-manager, etc.) cuidam da criptografia
 * internamente — encrypt OFF para não duplo-encriptar.
 */
export function defaultEncryptForStore(store: KeystoreStoreConfig): boolean {
  if (typeof store === 'string') return true;
  return ['file', 'drive', 'lucid', 'redis'].includes((store as any).driver);
}

/**
 * Mensagem de aviso quando `jwks: 'auto'` cai no fallback de disco (sem
 * AUTHKIT_JWKS): a chave privada será persistida em arquivo. `null` = sem aviso.
 */
export function jwksAutoFallbackWarning(storePath: string | null): string | null {
  if (!storePath) return null;
  return `AuthKit: jwks 'auto' caiu no fallback de disco (${storePath}) — a chave privada de assinatura será persistida em arquivo. Para produção, defina AUTHKIT_JWKS (secret manager) ou configure jwks.store explicitamente.`;
}

export function defineConfig(config: AuthServerConfigInput) {
  return configProvider.create(async (app: ApplicationService): Promise<ResolvedServerConfig> => {
    const AdapterClass = await config.adapter.resolver(app);

    // `jwks: 'auto'` → resolve env-aware: AUTHKIT_JWKS inline, senão managed em arquivo.
    const jwksConfig: JwksConfig =
      config.jwks === 'auto'
        ? process.env.AUTHKIT_JWKS
          ? {
              source: 'jwks',
              keys: JSON.parse(process.env.AUTHKIT_JWKS).keys,
            }
          : {
              source: 'managed',
              algorithm: 'RS256',
              store: 'tmp/authkit_jwks.json',
            }
        : config.jwks;

    if (config.jwks === 'auto' && !process.env.AUTHKIT_JWKS) {
      const warning = jwksAutoFallbackWarning((jwksConfig as { store?: string }).store ?? null);
      if (warning) {
        await app.container
          .make('logger')
          .then((l: any) => l?.warn(warning))
          .catch(() => {});
      }
    }

    const storeCfg = (jwksConfig as { store?: any }).store;
    if (
      jwksConfig.source === 'managed' &&
      storeCfg &&
      typeof storeCfg === 'object' &&
      storeCfg.driver === 'redis'
    ) {
      await app.container
        .make('logger')
        .then((l: any) =>
          l?.warn(
            'AuthKit: keystore no driver "redis" — garanta PERSISTÊNCIA (RDB/AOF). Num Redis cache-only, um flush apaga o keystore e invalida todos os tokens.',
          ),
        )
        .catch(() => {});
    }

    let jwks: { keys: Record<string, any>[] };
    if (jwksConfig.source === 'managed') {
      const alg = jwksConfig.algorithm ?? 'RS256';
      if (jwksConfig.store) {
        const vault = resolveKeystoreVault(jwksConfig.store as any, {
          makePath: (p) => app.makePath(p),
          container: app.container,
        });
        const encrypt = jwksConfig.encrypt ?? defaultEncryptForStore(jwksConfig.store as any);
        const enc = encrypt ? await loadEncryptionService() : undefined;
        const manager = new KeystoreManager(vault, new KeystoreCodec({ encrypt, enc }), alg);
        const store = await manager.ensure();
        // Remove o metadado interno `iat` antes de entregar ao oidc-provider.
        jwks = { keys: store.keys.map(({ iat: _iat, ...jwk }) => jwk) };
      } else {
        jwks = await generateJwks(alg);
      }
    } else {
      jwks = { keys: jwksConfig.keys ?? [] };
    }

    // BACKSTOP DE SUDO. Um host cujo `sudo.methods` não tem um único método
    // satisfazível por conta sem senha fica bricado para TODA operação sob
    // `requireSudo` — e hoje isso só se descobre quando um usuário não consegue
    // excluir a própria conta. Aqui é o único ponto do pacote onde `sudo.methods`,
    // `authMethods` e `passwordless` estão os três resolvidos e juntos, e este
    // callback roda no boot (`configProvider.resolve` no `boot()` do provider),
    // antes de qualquer request. Ver `host/sudo/satisfiability.ts` para as quatro
    // condições e para o porquê de ser WARN e não THROW.
    //
    // LIMITE CONHECIDO: só vê a lista que passou pelo CONFIG. Um host que declare
    // a lista APENAS no argumento `registerAuthHost(router, { sudoMethods })` não
    // é coberto — o registro de rotas acontece fora daqui e o `authMethods` não
    // chega lá. É o caso do ator informado (quem escreveu a lista à mão), não o
    // do host que herdou os defaults, que é quem o aviso existe para pegar.
    warnUnsatisfiableSudoConfig({
      methods: config.sudo?.methods,
      passwordPinnedOff: config.authMethods?.password === false,
      passwordlessSignup: config.passwordless?.signup === true,
    });

    // #9: mfaIssuer efetivo — top-level do defineConfig vence; senão o do lucidAccountStore; senão default.
    const effectiveMfaIssuer =
      config.mfaIssuer ??
      ((config.accountStore as any)?.__mfaIssuer as string | undefined) ??
      'AuthKit';

    return {
      issuer: config.issuer,
      AdapterClass,
      clients: config.clients ?? [],
      jwks: jwks as { keys: Record<string, any>[] },
      jwksConfig,
      ttl: {
        accessToken: toSeconds(config.ttl?.accessToken, 900),
        refreshToken: toSeconds(config.ttl?.refreshToken, 2592000),
        idToken: toSeconds(config.ttl?.idToken, 900),
        session: toSeconds(config.ttl?.session, 604800),
      },
      globalRolesClaim: config.globalRolesClaim ?? 'roles',
      resolveTokenRoles: config.resolveTokenRoles,
      cookieKeys: config.cookieKeys ?? [],
      observability: config.observability ?? {},
      findAccount: (sub: string) => config.accountStore.findById(sub),
      verifyCredentials: async (email: string, password: string) => {
        const acc = await config.accountStore.verifyCredentials(email, password);
        return acc ? { id: acc.id } : null;
      },
      accountStore: config.accountStore,
      patStore: config.patStore,
      mountPath: config.mountPath ?? '/oidc',
      accountHome: config.accountHome,
      // Default de runtime: sem isso, `render` ficava `undefined` e TODA
      // request a `/account/*`/`/auth/interaction/*` estourava um 500 sem
      // contexto (os controllers fazem `cfg.render!(...)`). `edgeRenderer()`
      // só usa `ctx.view` quando de fato invocado por uma request — não
      // importa `edge.js` eagerly, então é seguro construir mesmo em hosts
      // sem o peer opcional instalado (só quebraria se a request realmente
      // chegasse sem Edge configurado, exatamente como hoje).
      render: config.render ?? edgeRenderer(),
      // Recuperação de sessão de interaction perdida: default gracioso 'screen'
      // (tela themeável `session-expired`); 'redirect' opt-in para 302 ao login.
      interactionRecovery: {
        mode: config.interactionRecovery?.mode ?? 'screen',
        redirectTo: config.interactionRecovery?.redirectTo,
      },
      branding: config.branding,
      social: config.social,
      patIntrospectionSecret: config.patIntrospectionSecret,
      rateLimit: resolveRateLimit(config.rateLimit),
      lockout: resolveLockout(config.lockout),
      notifications: resolveNotifications(),
      mail: config.mail,
      // Propaga os métodos de sudo para o config resolvido. Sem esta linha o
      // campo existiria só no config de ENTRADA e `cfg.sudo` seria sempre
      // undefined em runtime — exatamente o bug que `accountHome` tinha.
      sudo: config.sudo,
      audit: (() => {
        // Sempre compõe o fan-out: além de onEvent/webhook (quando configurados),
        // o sink composto republica TODO evento de auditoria no barramento de
        // diagnostics do Agora (best-effort, zero-config, no-op sem o slot).
        const events = resolveEvents(config.events);
        return composeAuditSink(config.audit, events ?? {});
      })(),
      // #9: reusa mfaIssuer/webauthn declarados no lucidAccountStore quando o
      // top-level não os fornece — consumidor declara UMA vez. Top-level ainda vence.
      mfaIssuer: effectiveMfaIssuer,
      webauthn: resolveWebauthn(
        config.issuer,
        effectiveMfaIssuer,
        config.webauthn ?? ((config.accountStore as any)?.__webauthn as typeof config.webauthn),
      ),
      dynamicRegistration: resolveDynamicRegistration(config.dynamicRegistration),
      deviceFlow: resolveDeviceFlow(config.deviceFlow),
      uploads: resolveUploads(config.uploads),
      dpop: resolveDpop(config.dpop),
      par: resolvePar(config.par),
      stepUp: resolveStepUp(config.stepUp),
      trustedDevices: resolveTrustedDevices(config.trustedDevices),
      botProtection: resolveBotProtection(config.botProtection),
      passwordless: resolvePasswordless(config.passwordless),
      authMethods: resolveAuthMethodsConfig(config.authMethods),
      login: resolveLogin(config.login),
      registration: resolveRegistration(config.registration),
      accessTokens: resolveAccessTokens(config.issuer, config.accessTokens),
      admin: resolveAdmin(config.admin),
      adminApi: resolveAdminApi(config.adminApi),
      organizations: resolveOrganizations(config.organizations),
      resolveGeo: config.resolveGeo,
      messages: resolveMessages(config.i18n),
      locale: config.i18n?.locale ?? 'pt-BR',
      schema: {
        autoManage: config.schema?.autoManage !== false,
        connection: config.schema?.connection,
      },
      // OPT-IN: default false → caminho síncrono de sempre (byte-idêntico).
      accountLifecycle: {
        durable: config.accountLifecycle?.durable === true,
      },
      // Keys de auth_settings travadas porque foram definidas no defineConfig:
      // config vence e a UI/Admin API não pode alterá-las (ver host/config_locks.ts).
      lockedSettingKeys: deriveLockedSettingKeys(config as Record<string, any>),
      routes: config.routes,
      // Mesma regra do `lockedSettingKeys`, outro eixo: config × argumento de
      // `registerAuthHost` (ver host/config_locks.ts).
      lockedRouteOptions: deriveLockedRouteOptions(config as Record<string, any>),
      // Opt-in: ausente = authkit nunca toca `ctx.auth` (comportamento de sempre).
      adonisAuth: config.adonisAuth,
    };
  });
}
