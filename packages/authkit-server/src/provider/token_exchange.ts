import { errors } from 'oidc-provider';
import type { AccountStore, AuthAccount } from '../accounts/account_store.js';
import type { AuditSink } from '../audit/audit_sink.js';
import { assertAccountEnabled } from '../host/login_attempt.js';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export interface TokenExchangeAccount {
  id: string;
  email?: string;
  name?: string;
  globalRoles?: string[];
}

export interface TokenExchangeDeps {
  findAccount: (sub: string) => Promise<TokenExchangeAccount | null>;
  globalRolesClaim: string;
  /**
   * Resolves the global-roles claim at token-mint time. When omitted, falls back to
   * `target.globalRoles ?? []` (unchanged behavior). Mirrors the mint-time hook used
   * by the authorization-code flow so impersonated tokens source roles from the same
   * authority (e.g. @adonis-agora/authz) or custom store.
   *
   * The SAME hook also gates the ACTOR (the admin trying to impersonate): its roles
   * are resolved through it too, so an app that keeps roles in its own table
   * (e.g. via `@adonis-agora/authz`) can impersonate without storing roles in the
   * authkit `globalRoles` column. When omitted, falls back to `actor.globalRoles`.
   */
  resolveTokenRoles?: (
    account: AuthAccount,
    context: {
      clientId?: string;
      activeOrg?: { orgId: string; orgSlug: string; orgRole: string } | null;
    },
  ) => string[] | Promise<string[]>;
  /**
   * Allowlist de roles que autorizam a impersonation. Default: `['ADMIN']`.
   * Aceita o papel EXATO (ex.: `'admin'` minúsculo) do app — resolve contra a
   * MESMA fonte de roles do `resolveTokenRoles`/`globalRoles`, não a um papel
   * hardcoded. Mantém `adminRole` como alias singular para back-compat.
   */
  adminRoles?: string[];
  /** @deprecated Use `adminRoles` (allowlist). Mantido como alias singular. */
  adminRole?: string;
  /**
   * Resource indicators (RFC 8707) suportados pelo provider. Quando o pedido traz
   * `audience`/`resource`, validamos contra esta lista; um alvo não suportado é
   * rejeitado (conservador). Vazio/ausente => nenhum resource é aceito no pedido.
   */
  supportedResources?: string[];
  /** Sink de auditoria (best-effort). Quando presente, registra `impersonation`. */
  audit?: AuditSink;
  /**
   * AccountStore do host, usado para checar se o alvo da impersonação está
   * desabilitado/expirado (mesmo gate de `attemptPasswordLogin`, via
   * `assertAccountEnabled`). Impersonar uma conta desabilitada mintaria tokens
   * funcionais para uma identidade que deveria estar sem acesso algum.
   *
   * OPCIONAL e capability-probed (via `supportsAccountStatus`, dentro do
   * helper): ausente ou sem a capacidade → degrada para "permitido" (mesma
   * regra de todo o resto da lib — nunca quebra hosts com um store mínimo).
   */
  accountStore?: AccountStore;
}

/**
 * Interseção entre os scopes pedidos e os scopes permitidos do client (allowlist).
 * Preserva a ordem do pedido. Nunca excede a allowlist do client.
 */
function intersectScopes(requested: string, allowed: Set<string>): string {
  const out: string[] = [];
  for (const s of requested.split(' ')) {
    const t = s.trim();
    if (t && allowed.has(t) && !out.includes(t)) out.push(t);
  }
  return out.join(' ');
}

export function registerTokenExchange(provider: any, deps: TokenExchangeDeps): void {
  const adminRoles = deps.adminRoles ?? (deps.adminRole ? [deps.adminRole] : ['ADMIN']);
  const supportedResources = new Set(deps.supportedResources ?? []);

  const handler = async (ctx: any) => {
    const { params, client } = ctx.oidc;

    if (params.subject_token_type !== ACCESS_TOKEN_TYPE) {
      throw new errors.InvalidRequest('unsupported subject_token_type');
    }
    if (!params.subject_token) {
      throw new errors.InvalidRequest('subject_token is required');
    }

    const subjectAt = await provider.AccessToken.find(params.subject_token);
    if (!subjectAt || subjectAt.isExpired) {
      throw new errors.InvalidGrant('subject_token invalid or expired');
    }

    // O subject_token DEVE ter sido emitido para o MESMO client autenticado: senão
    // um client B poderia trocar um AT emitido para o client A (cross-client).
    if (subjectAt.clientId !== client?.clientId) {
      throw new errors.InvalidGrant('subject_token was not issued to this client');
    }

    const actor = await deps.findAccount(subjectAt.accountId);
    if (!actor) {
      throw new errors.InvalidGrant('actor not permitted to impersonate');
    }
    // Resolve as roles do ATOR pela MESMA fonte do claim (resolveTokenRoles
    // quando o host configura — ex.: roles em tabela própria via
    // `@adonis-agora/authz`), com fallback pro `globalRoles` do store. Sem isso
    // um host que não grava roles na coluna `globalRoles` do authkit nunca
    // conseguiria impersonar (o gate bateria sempre em `[]`). Mesmo padrão do
    // console (`resolveAccountRoles` em `host/account_roles.ts`).
    const actorRoles = deps.resolveTokenRoles
      ? await deps.resolveTokenRoles(actor as AuthAccount, {
          clientId: client?.clientId,
          activeOrg: null,
        })
      : (actor.globalRoles ?? []);
    if (!actorRoles.some((r) => adminRoles.includes(r))) {
      throw new errors.InvalidGrant('actor not permitted to impersonate');
    }

    const targetId = params.requested_subject;
    if (!targetId) {
      throw new errors.InvalidRequest('requested_subject is required');
    }
    const target = await deps.findAccount(targetId);
    if (!target) {
      throw new errors.InvalidGrant('requested_subject not found');
    }

    // Status do alvo (disabled/expirado): mesmo gate de `attemptPasswordLogin`.
    // Sem isso, impersonar um alvo desabilitado mintava tokens funcionais para
    // uma identidade que o admin acreditava ter revogado. `accountStore` é
    // opcional/capability-probed — sem ele (ou sem a capacidade), permanece
    // "permitido" como antes.
    if (deps.accountStore) {
      const statusGate = await assertAccountEnabled(
        { accountStore: deps.accountStore, audit: deps.audit },
        target.id,
        { email: target.email ?? '', ip: ctx.req?.socket?.remoteAddress ?? null },
      );
      if (!statusGate.allowed) {
        throw new errors.InvalidGrant('requested_subject is disabled');
      }
    }

    // audience/resource: se o pedido vier com um alvo, ele PRECISA estar entre os
    // resource indicators suportados. Caso contrário rejeitamos (conservador) —
    // nunca embutimos audiência arbitrária no token emitido.
    const requestedTargets = [params.audience, params.resource].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    for (const tgt of requestedTargets) {
      if (!supportedResources.has(tgt)) {
        throw new errors.InvalidTarget('requested audience/resource is not supported');
      }
    }

    // scope: nunca exceder os scopes permitidos do client autenticado. Quando o
    // client DECLARA `scope` (allowlist), o pedido é reduzido à INTERSEÇÃO com ela.
    // Quando o client NÃO declara `scope` (metadata ausente nesta lib = "não
    // configurado", não "nenhum scope"), preservamos o comportamento atual: usa o
    // `scope` pedido, ou o default mínimo se o pedido vier vazio.
    const clientScopes = new Set<string>(
      String(client?.scope ?? '')
        .split(' ')
        .map((s: string) => s.trim())
        .filter(Boolean),
    );
    const DEFAULT_SCOPE = 'openid profile email';
    let scope: string;
    if (clientScopes.size) {
      // Client com allowlist explícita: interseção (pedido) ou a própria allowlist.
      scope = params.scope
        ? intersectScopes(params.scope, clientScopes)
        : [...clientScopes].join(' ');
      // Pedido explícito sem nenhuma interseção → erro claro, não token de scope vazio.
      if (params.scope && !scope) {
        throw new errors.InvalidScope(
          'requested scope is not allowed for this client',
          params.scope,
        );
      }
    } else {
      // Client sem allowlist declarada: comportamento atual preservado.
      scope = params.scope || DEFAULT_SCOPE;
    }

    const at = new provider.AccessToken({ accountId: target.id, client, scope });
    const accessToken = await at.save();

    // Token exchange is not tied to a browser session, so there is no active org
    // context here — roles are resolved for the impersonated target with clientId only.
    const roles = deps.resolveTokenRoles
      ? await deps.resolveTokenRoles(target as AuthAccount, {
          clientId: client?.clientId,
          activeOrg: null,
        })
      : (target.globalRoles ?? []);

    const idToken = new provider.IdToken(
      {
        sub: target.id,
        email: target.email,
        email_verified: true,
        name: target.name,
        [deps.globalRolesClaim]: roles,
      },
      { ctx },
    );
    idToken.scope = scope;
    idToken.set('act', { sub: actor.id });
    const idTokenJwt = await idToken.issue({ use: 'idtoken' });

    await deps.audit?.record({
      type: 'impersonation',
      actorId: actor.id,
      accountId: target.id,
      email: target.email ?? null,
      clientId: client?.clientId ?? null,
      ip: ctx.req?.socket?.remoteAddress ?? null,
      metadata: { scope },
    });

    ctx.body = {
      access_token: accessToken,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: at.tokenType ?? 'Bearer',
      expires_in: at.expiration ?? 3600,
      id_token: idTokenJwt,
      scope,
    };
  };

  provider.registerGrantType(
    TOKEN_EXCHANGE,
    handler,
    [
      'subject_token',
      'subject_token_type',
      'requested_subject',
      'requested_token_type',
      'scope',
      'audience',
      'resource',
      'actor_token',
      'actor_token_type',
    ],
    ['audience', 'resource'],
  );
}
