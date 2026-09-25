import vine from '@vinejs/vine';
import type { ClientInput, TokenEndpointAuthMethod } from './admin_clients_service.js';
import { APPLICATION_TYPES, type ApplicationType, redirectUriProblem } from './client_metadata.js';
import { normalizeEmailIdentifier } from './email_identifier.js';

/**
 * Validators VineJS dos recursos administrativos (Admin REST API + console admin).
 *
 * O console (B6) e a Admin REST API (R6) compartilham as MESMAS formas de input,
 * então compartilham os MESMOS validators daqui. Cada controller chama
 * `request.validateUsing(<validator>)` — um input inválido vira `E_VALIDATION_ERROR`
 * (HTTP 422) pelo handler padrão do AdonisJS, substituindo as checagens manuais
 * `request.input(...)` + 400 ad-hoc que existiam antes.
 *
 * `request.validateUsing` valida `request.all()` (body+query); para valores que
 * vêm de OUTRAS fontes (route param, ou um accountId que pode vir de query OU
 * param), chame o validator direto — `validator.validate({ ... })` — montando o
 * objeto antes (ver {@link sessionAccountValidator}). Vine valida qualquer dado,
 * não só o body.
 *
 * ── O que NÃO usa Vine (de propósito) ──────────────────────────────────────
 * Nem todo input é candidato a validator com schema. Estes ficam com leitura
 * manual de propósito (migrar seria regressão, não melhoria):
 *
 *   - **Forms Edge** (`account_orgs`, `account_confirm`, `account_session`): são
 *     POSTs de formulário de sessão que, em input ausente, REDIRECIONAM de forma
 *     graciosa (ex.: de volta p/ `/account/orgs`). O throw→422 do Vine quebraria
 *     esse fluxo (vira flash-error/redirect do handler, não o redirect desenhado).
 *   - **Blobs WebAuthn** (`response` em interaction/account_mfa/account_confirm):
 *     credential JSON opaco, parseado pela lib de WebAuthn — não tem shape de
 *     campos p/ validar.
 *   - **Flags de checkbox** (`remember`, `trustDevice`): presença booleana.
 *   - **`pat_introspection`** (`token`): endpoint RFC 7662 — token ausente/inválido
 *     responde `{ active: false }`, não 422.
 *   - **`createToken` (`name`)**: opcional com default (`'Token'`) — nada a exigir.
 *
 * Regra de bolso: use Vine onde há INPUT ESTRUTURADO de API JSON que deva ser
 * REJEITADO quando inválido (422). Form-redirect, blob opaco, flag e semântica de
 * protocolo ficam de fora.
 */

const authMethod = vine.enum(['client_secret_basic', 'client_secret_post', 'none'] as const);

/**
 * Opções de validação de URL (L10): exige protocolo (URI absoluta), restringe a
 * http/https (bloqueia `javascript:`, `ftp:`, etc.) e permite hosts de label única
 * (`require_tld:false`) p/ não rejeitar `localhost` ou hostnames internos legítimos.
 */
const URL_OPTS = { require_protocol: true, require_tld: false, protocols: ['http', 'https'] };

/**
 * Regra de redirect URI ciente do `applicationType` do MESMO payload (RFC 8252):
 * client web continua restrito a http/https (L10); client nativo aceita esquema
 * privado (`com.example.app:/cb`), https claimed e loopback http. Sem o tipo no
 * payload (PATCH parcial) só as regras universais valem aqui — URI absoluta, sem
 * fragmento, sem `javascript:`/`data:`/… — e o `AdminClientsService` confere o
 * resto contra o tipo EFETIVO do client (ver `client_metadata.ts`).
 */
const redirectUriRule = vine.createRule((value, _options, field) => {
  if (typeof value !== 'string') return;
  const declared = field.data?.applicationType;
  const type: ApplicationType | undefined =
    declared === 'web' || declared === 'native' ? declared : undefined;
  const problem = redirectUriProblem(value, type);
  if (problem) field.report(`The {{ field }} field ${problem}`, 'redirectUri', field);
});

/** Array de redirect URIs (ver {@link redirectUriRule}). Rejeita strings que não são URI válida. */
const redirectUriArray = vine.array(vine.string().trim().use(redirectUriRule()));

/**
 * Allowlist de grant_types aceitos no registro/edição de client (M10). Bloqueia
 * `implicit` (tokens no fragment da URL — sem PKCE/refresh) e qualquer valor fora
 * desta lista. Mantém os fluxos suportados: authorization_code, refresh_token,
 * client_credentials e token-exchange (impersonation, gateada em token_exchange.ts).
 */
const ALLOWED_GRANT_TYPES = [
  'authorization_code',
  'refresh_token',
  'client_credentials',
  'urn:ietf:params:oauth:grant-type:token-exchange',
] as const;
const grantTypeArray = vine.array(vine.enum(ALLOWED_GRANT_TYPES));
// NOTA: `response_types` NÃO é input de client nesta lib — é derivado por
// `AdminClientsService.create` (`['code']` quando há authorization_code, senão
// `[]`). Logo já está restrito a `code` sem precisar de validator (M10 ✓).

// ─── Clients OIDC ───────────────────────────────────────────────────────────

/**
 * Input de client OIDC — serve create E update (PATCH). Tudo opcional: no create
 * o controller aplica defaults (ver {@link clientCreateInput}); no update os campos
 * ausentes (undefined) são preservados pelo `AdminClientsService.update` (merge,
 * ver {@link clientPartialInput}). `grants` é aceito como alias de `grantTypes`
 * (o DTO de saída usa `grants`).
 */
export const clientInputValidator = vine.compile(
  vine.object({
    clientId: vine.string().trim().optional(),
    // `web` (default) ou `native` (RFC 8252 — app mobile/desktop, sempre público).
    applicationType: vine.enum(APPLICATION_TYPES).optional(),
    // redirect/postLogout: URIs ABSOLUTAS (L10), http/https para client web;
    // esquema privado/loopback só para `native` (ver `redirectUriRule`).
    redirectUris: redirectUriArray.optional(),
    postLogoutRedirectUris: redirectUriArray.optional(),
    // grant_types restrito à allowlist; `implicit` e desconhecidos viram 422 (M10).
    grantTypes: grantTypeArray.optional(),
    grants: grantTypeArray.optional(),
    tokenEndpointAuthMethod: authMethod.optional(),
    // backchannel_logout_uri também precisa ser URI absoluta (L10).
    backchannelLogoutUri: vine.string().trim().url(URL_OPTS).optional(),
    backchannelLogoutSessionRequired: vine.boolean().optional(),
  }),
);

/** Forma validada de um client (saída do {@link clientInputValidator}). */
export type ClientInputFields = {
  clientId?: string;
  applicationType?: ApplicationType;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  grantTypes?: string[];
  grants?: string[];
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  backchannelLogoutUri?: string;
  backchannelLogoutSessionRequired?: boolean;
};

/**
 * Mapeia o input validado para um {@link ClientInput} COMPLETO (create), com defaults.
 * Client nativo sem `tokenEndpointAuthMethod` explícito vira público (`none`); um
 * nativo confidencial explícito é recusado pelo service (422).
 */
export function clientCreateInput(v: ClientInputFields): ClientInput {
  const applicationType = v.applicationType ?? 'web';
  return {
    clientId: v.clientId?.trim() || undefined,
    applicationType,
    redirectUris: v.redirectUris ?? [],
    postLogoutRedirectUris: v.postLogoutRedirectUris ?? [],
    grantTypes: v.grantTypes ?? v.grants ?? [],
    tokenEndpointAuthMethod:
      v.tokenEndpointAuthMethod ?? (applicationType === 'native' ? 'none' : 'client_secret_basic'),
    backchannelLogoutUri: v.backchannelLogoutUri || undefined,
    backchannelLogoutSessionRequired: v.backchannelLogoutSessionRequired,
  };
}

/**
 * Mapeia o input validado para um {@link ClientInput} PARCIAL (PATCH): só inclui
 * os campos presentes; o `AdminClientsService.update` preserva o resto via merge.
 */
export function clientPartialInput(v: ClientInputFields): Partial<ClientInput> {
  const out: Partial<ClientInput> = {};
  if (v.applicationType !== undefined) out.applicationType = v.applicationType;
  if (v.redirectUris !== undefined) out.redirectUris = v.redirectUris;
  if (v.postLogoutRedirectUris !== undefined) out.postLogoutRedirectUris = v.postLogoutRedirectUris;
  const grants = v.grantTypes ?? v.grants;
  if (grants !== undefined) out.grantTypes = grants;
  if (v.tokenEndpointAuthMethod !== undefined)
    out.tokenEndpointAuthMethod = v.tokenEndpointAuthMethod;
  if (v.backchannelLogoutUri !== undefined)
    out.backchannelLogoutUri = v.backchannelLogoutUri.trim() || undefined;
  if (v.backchannelLogoutSessionRequired !== undefined)
    out.backchannelLogoutSessionRequired = v.backchannelLogoutSessionRequired;
  return out;
}

// ─── Usuários ───────────────────────────────────────────────────────────────

/**
 * Criação de usuário pelo admin (API + console). E-mail obrigatório e validado;
 * nome/senha opcionais; `invite:true` cria sem senha e dispara o convite. A
 * política de senha (força, comprimento mínimo do projeto) é checada DEPOIS pelo
 * AdminUsersService.create (retorna `password_policy`); por isso aqui NÃO fixamos
 * `minLength` — seria duplicar/contornar a policy configurável do projeto.
 */
export const adminUserCreateValidator = vine.compile(
  vine.object({
    email: vine.string().trim().email().transform(normalizeEmailIdentifier),
    name: vine.string().trim().maxLength(255).optional(),
    password: vine.string().maxLength(255).optional(),
    invite: vine.boolean().optional(),
  }),
);

/** Atualização de usuário (PATCH): roles globais e/ou perfil. Tudo opcional. */
export const adminUserUpdateValidator = vine.compile(
  vine.object({
    globalRoles: vine.array(vine.string().trim()).optional(),
    name: vine.string().trim().maxLength(255).nullable().optional(),
    avatarUrl: vine.string().trim().maxLength(2048).nullable().optional(),
  }),
);

/** Substituição de roles globais no console (PATCH /users/:id/roles). */
export const adminUserRolesValidator = vine.compile(
  vine.object({
    roles: vine.array(vine.string().trim()).optional(),
  }),
);

// ─── Organizações ─────────────────────────────────────────────────────────────

/** Criação de org: name, slug e ownerAccountId obrigatórios; logo opcional. */
export const orgCreateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(255),
    slug: vine.string().trim().minLength(1).maxLength(255),
    ownerAccountId: vine.string().trim().minLength(1),
    logoUrl: vine.string().trim().nullable().optional(),
  }),
);

/** Atualização de org (PATCH): nome e/ou logo, ambos opcionais. */
export const orgUpdateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(255).optional(),
    logoUrl: vine.string().trim().nullable().optional(),
  }),
);

/** Adição de membro: accountId obrigatório; role opcional (default `member`). */
export const orgAddMemberValidator = vine.compile(
  vine.object({
    accountId: vine.string().trim().minLength(1),
    role: vine.string().trim().minLength(1).optional(),
  }),
);

/** Troca de papel de membro: role obrigatório. */
export const orgMemberRoleValidator = vine.compile(
  vine.object({
    role: vine.string().trim().minLength(1),
  }),
);

/** Criação de convite: e-mail obrigatório e validado; role opcional (default `member`). */
export const orgInvitationValidator = vine.compile(
  vine.object({
    email: vine.string().trim().email().transform(normalizeEmailIdentifier),
    role: vine.string().trim().minLength(1).optional(),
  }),
);

// ─── Catálogo de roles ──────────────────────────────────────────────────────

/**
 * Criação de role no catálogo: `name` obrigatório (o formato — uppercase +
 * `ROLE_NAME_RE` — e a mensagem custom continuam no controller); `description`
 * opcional.
 */
export const roleCreateValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1),
    description: vine.string().trim().optional(),
  }),
);

/** Edição de role (PATCH): só `description` (o `name` vem da rota). */
export const roleUpdateValidator = vine.compile(
  vine.object({
    description: vine.string().trim().optional(),
  }),
);

// ─── Introspecção de token ──────────────────────────────────────────────────

/** `POST /tokens/verify` — token obrigatório. */
export const tokenVerifyValidator = vine.compile(
  vine.object({
    token: vine.string().trim().minLength(1),
  }),
);

// ─── Sessões ──────────────────────────────────────────────────────────────────

/**
 * `accountId` obrigatório — para endpoints que o recebem por query/body (ex.:
 * `POST /sessions/revoke-all?accountId=`). Como o valor pode vir de fontes
 * diferentes (query OU route param), o controller monta o objeto e valida com
 * `sessionAccountValidator.validate({ accountId })` (Vine valida qualquer dado,
 * não só o body — `request.validateUsing` é só o atalho que valida `request.all()`).
 */
export const sessionAccountValidator = vine.compile(
  vine.object({
    accountId: vine.string().trim().minLength(1),
  }),
);
