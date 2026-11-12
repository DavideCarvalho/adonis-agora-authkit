import type { HttpContext } from '@adonisjs/core/http';
import {
  supportsAccountStatus,
  supportsMfa,
  supportsProviderIdentity,
} from '../accounts/account_store.js';
import { AdminOrgsService } from '../host/admin_api/admin_orgs_service.js';
import { AdminUsersService } from '../host/admin_api/admin_users_service.js';
import {
  auditDto,
  orgDetailDto,
  orgDto,
  sessionDto,
  userDtoWithRoles,
} from '../host/admin_api/dto.js';
import { AdminClientsService } from '../host/admin_clients_service.js';
import { AdminSessionsService } from '../host/admin_sessions_service.js';
import { computeAdminStats } from '../host/admin_stats_service.js';
import { enrichSessionsWithContext } from '../host/session_context.js';
import { LIST_FIRST_PAGE } from '../pagination.js';
import type { DevTool, DevToolCall, DevToolInputProperty } from './contract.js';

/** Rows a list tool returns when `limit` is omitted. */
export const DEV_TOOLS_DEFAULT_LIMIT = 20;
/** The largest `limit` a list tool accepts. */
export const DEV_TOOLS_MAX_LIMIT = 100;

/** What the tools need from the app; tests replace any of it. */
export interface AuthkitDevToolsDeps {
  /** The `authkit.server` service. Default: resolved from the request's container. */
  service?(ctx: HttpContext): Promise<any>;
  sessions?(
    service: any,
  ): Pick<
    AdminSessionsService,
    'canList' | 'countActiveSessions' | 'listSessions' | 'listGrants' | 'revokeAll'
  >;
  clients?(service: any): Pick<AdminClientsService, 'canList' | 'list' | 'find'>;
  /** The `authkit.server` service outside a request, for `available()`. */
  resolve?(): Promise<any>;
}

const page: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  description: 'Page number, 1-based (default 1). The result says the next one in `next`.',
};
const limit: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  maximum: DEV_TOOLS_MAX_LIMIT,
  description: `Rows per page (default ${DEV_TOOLS_DEFAULT_LIMIT}, max ${DEV_TOOLS_MAX_LIMIT}).`,
};
const accountId: DevToolInputProperty = { type: 'string', description: 'The account id.' };

function pageOf(input: Record<string, unknown>): { page: number; limit: number } {
  const p = Math.trunc(Number(input.page));
  const l = Math.trunc(Number(input.limit));
  return {
    page: Number.isFinite(p) && p >= LIST_FIRST_PAGE ? p : LIST_FIRST_PAGE,
    limit:
      Number.isFinite(l) && l >= 1 ? Math.min(l, DEV_TOOLS_MAX_LIMIT) : DEV_TOOLS_DEFAULT_LIMIT,
  };
}

function nextPage(current: number, size: number, total: number): number | null {
  return current * size < total ? current + 1 : null;
}

/** One page of an array the service returns whole. */
function slice<T>(rows: readonly T[], p: { page: number; limit: number }) {
  const start = (p.page - 1) * p.limit;
  return {
    items: rows.slice(start, start + p.limit),
    total: rows.length,
    next: nextPage(p.page, p.limit, rows.length),
  };
}

function text(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = text(input, key);
  if (value === undefined) throw new Error(`"${key}" is required`);
  return value;
}

/** A session as the console shows it, without its id (an id is a handle on the session). */
function sessionView(session: Parameters<typeof sessionDto>[0]) {
  const { id: _id, ...rest } = sessionDto(session);
  return rest;
}

function grantView(grant: {
  accountId: string;
  clientId?: string;
  accessTokens: number;
  refreshTokens: number;
}) {
  return {
    accountId: grant.accountId,
    clientId: grant.clientId ?? null,
    accessTokens: grant.accessTokens,
    refreshTokens: grant.refreshTokens,
  };
}

/** The audit actor of an action taken over MCP. */
function mcpActor(call: DevToolCall): string {
  return `mcp:${call.caller.id}`;
}

/**
 * authkit's developer tools for the Agora dev MCP endpoint: the admin console's reads, and two
 * destructive actions (revoke sessions, disable a user) that the app must opt into on the endpoint.
 * Every tool goes through the same services as the console; outputs never carry session ids, client
 * secrets, key material, token values or MFA secrets.
 */
export function authkitDevTools(deps: AuthkitDevToolsDeps = {}): DevTool[] {
  const service = (ctx: HttpContext) =>
    deps.service ? deps.service(ctx) : ctx.containerResolver.make('authkit.server');
  const sessions = (svc: any) =>
    deps.sessions ? deps.sessions(svc) : new AdminSessionsService(svc);
  const clients = (svc: any) => (deps.clients ? deps.clients(svc) : new AdminClientsService(svc));

  async function findAccount(cfg: any, id: string) {
    const account = await cfg.accountStore.findById(id);
    if (!account) throw new Error(`No account with id "${id}"`);
    return account;
  }

  return [
    {
      name: 'authkit_get_overview',
      kind: 'read',
      description:
        'Identity provider summary: total users, active sessions, monthly active users, sign-ins and sign-ups per day (last 30 days), number of OIDC clients, audit total and the 5 latest audit events.',
      input: { type: 'object', properties: {} },
      async run(_input, call) {
        const svc = await service(call.ctx);
        const cfg = svc.config;
        const stats = await computeAdminStats(cfg, sessions(svc));
        const clientSvc = clients(svc);
        const clientsCount = clientSvc.canList ? (await clientSvc.list()).length : 0;
        const recent =
          typeof cfg.audit?.list === 'function'
            ? await cfg.audit.list({ page: LIST_FIRST_PAGE, size: 5 })
            : null;
        return {
          usersTotal: stats.totalUsers,
          activeSessions: stats.activeSessions,
          mau: stats.mau,
          signInsTotal: stats.signInsTotal,
          signUpsTotal: stats.signUpsTotal,
          signInsPerDay: stats.signInsPerDay,
          signUpsPerDay: stats.signUpsPerDay,
          windowDays: stats.windowDays,
          auditSupported: stats.auditSupported,
          clientsCount,
          auditTotal: recent?.total ?? 0,
          recentEvents: (recent?.data ?? []).map(auditDto),
        };
      },
    },
    {
      name: 'authkit_list_users',
      kind: 'read',
      description:
        'Accounts, newest first as the admin console lists them: id, email, name, stored global roles, effective roles and whether the account is disabled. `search` filters by email. Returns { items, total, next }.',
      input: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Part of an email address.' },
          page,
          limit,
        },
      },
      async run(input, call) {
        const cfg = (await service(call.ctx)).config;
        const p = pageOf(input);
        const result = await cfg.accountStore.listAccounts({
          search: text(input, 'search') ?? '',
          page: p.page,
          size: p.limit,
        });
        const users = new AdminUsersService(cfg);
        const items = await Promise.all(
          result.data.map(async (u: any) => userDtoWithRoles(cfg, u, await users.isDisabled(u.id))),
        );
        return { items, total: result.total, next: nextPage(p.page, p.limit, result.total) };
      },
    },
    {
      name: 'authkit_get_user',
      kind: 'read',
      description:
        'One account: profile, stored and effective roles, disabled flag, MFA on/off (and whether an authenticator app is set up), linked sign-in providers, and how many active sessions and app grants it has. No session ids.',
      input: { type: 'object', properties: { id: accountId }, required: ['id'] },
      async run(input, call) {
        const svc = await service(call.ctx);
        const cfg = svc.config;
        const id = required(input, 'id');
        const account = await findAccount(cfg, id);
        const users = new AdminUsersService(cfg);
        const store = cfg.accountStore;
        const sessionSvc = sessions(svc);
        const [disabled, mfa, identities, sessionList, grants] = await Promise.all([
          users.isDisabled(id),
          supportsMfa(store) ? store.getMfaState(id) : Promise.resolve(null),
          supportsProviderIdentity(store) ? store.listProviderIdentities(id) : Promise.resolve([]),
          sessionSvc.canList ? sessionSvc.listSessions(id) : Promise.resolve(null),
          sessionSvc.canList ? sessionSvc.listGrants(id) : Promise.resolve(null),
        ]);
        return {
          ...(await userDtoWithRoles(cfg, account, disabled)),
          mfa: mfa === null ? null : { enabled: mfa.enabled, totp: mfa.totp ?? null },
          identities: identities.map((i: any) => ({
            provider: i.provider,
            providerUserId: i.providerUserId,
            email: i.email ?? null,
          })),
          sessionCount: sessionList === null ? null : sessionList.length,
          grantCount: grants === null ? null : grants.length,
          statusSupported: supportsAccountStatus(store),
        };
      },
    },
    {
      name: 'authkit_list_user_sessions',
      kind: 'read',
      description:
        "An account's active sign-in sessions as the admin console shows them: sign-in time, methods (amr), browser, OS, IP and approximate location. No session ids. Returns { supported, items, total, next }.",
      input: {
        type: 'object',
        properties: { accountId, page, limit },
        required: ['accountId'],
      },
      async run(input, call) {
        const svc = await service(call.ctx);
        const id = required(input, 'accountId');
        await findAccount(svc.config, id);
        const sessionSvc = sessions(svc);
        if (!sessionSvc.canList) return { supported: false, items: [], total: 0, next: null };
        const raw = await sessionSvc.listSessions(id);
        const enriched = await enrichSessionsWithContext(svc.config, id, raw);
        return { supported: true, ...slice(enriched.map(sessionView), pageOf(input)) };
      },
    },
    {
      name: 'authkit_list_user_grants',
      kind: 'read',
      description:
        'The apps (OIDC clients) an account granted access to, with how many access and refresh tokens are live for each. Token values are never returned. Returns { supported, items, total, next }.',
      input: {
        type: 'object',
        properties: { accountId, page, limit },
        required: ['accountId'],
      },
      async run(input, call) {
        const svc = await service(call.ctx);
        const id = required(input, 'accountId');
        await findAccount(svc.config, id);
        const sessionSvc = sessions(svc);
        if (!sessionSvc.canList) return { supported: false, items: [], total: 0, next: null };
        const grants = await sessionSvc.listGrants(id);
        return { supported: true, ...slice(grants.map(grantView), pageOf(input)) };
      },
    },
    {
      name: 'authkit_list_orgs',
      kind: 'read',
      description:
        'Organizations with their member count. Returns { supported, items, total, next }; `supported: false` when the account store has no organizations.',
      input: { type: 'object', properties: { page, limit } },
      async run(input, call) {
        const svc = await service(call.ctx);
        const orgs = new AdminOrgsService(svc.config, svc);
        if (!orgs.supported) return { supported: false, items: [], total: 0, next: null };
        const result = await orgs.listOrgs();
        if (!Array.isArray(result)) return { supported: false, items: [], total: 0, next: null };
        return {
          supported: true,
          ...slice(
            result.map((o) => orgDto(o)),
            pageOf(input),
          ),
        };
      },
    },
    {
      name: 'authkit_get_org',
      kind: 'read',
      description:
        'One organization: name, slug, members (account id, email, role, joined at) and pending invitations.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The organization id.' } },
        required: ['id'],
      },
      async run(input, call) {
        const svc = await service(call.ctx);
        const orgs = new AdminOrgsService(svc.config, svc);
        if (!orgs.supported) throw new Error('The account store has no organizations');
        const result = await orgs.getOrg(required(input, 'id'));
        if ('ok' in result && result.ok === false) {
          throw new Error(
            result.reason === 'not_found'
              ? `No organization with id "${input.id}"`
              : 'The account store has no organizations',
          );
        }
        return orgDetailDto(result as any);
      },
    },
    {
      name: 'authkit_list_clients',
      kind: 'read',
      description:
        'OIDC clients (apps that sign in through this identity provider): client id, name, confidential or public, grant types, redirect URIs, auth method, disabled flag. Never the client secret. Returns { supported, items, total, next }.',
      input: { type: 'object', properties: { page, limit } },
      async run(input, call) {
        const svc = await service(call.ctx);
        const clientSvc = clients(svc);
        if (!clientSvc.canList) return { supported: false, items: [], total: 0, next: null };
        const list = await clientSvc.list();
        const items = list.map((c: any) => ({
          clientId: c.clientId,
          clientName: c.clientName ?? null,
          confidential: c.confidential,
          applicationType: c.applicationType ?? null,
          grantTypes: c.grantTypes ?? [],
          redirectUris: c.redirectUris ?? [],
          postLogoutRedirectUris: c.postLogoutRedirectUris ?? [],
          authMethod: c.tokenEndpointAuthMethod ?? null,
          backchannelLogoutUri: c.backchannelLogoutUri ?? null,
          logoUri: c.logoUri ?? null,
          disabled: c.disabled === true,
          serviceTenant: c.serviceTenant ?? null,
        }));
        return { supported: true, ...slice(items, pageOf(input)) };
      },
    },
    {
      name: 'authkit_list_audit',
      kind: 'read',
      description:
        'The audit log, newest first: event type, account, actor, client, IP, metadata, time. Filter by `type` (e.g. "login.failure") and `subject` (an account id). Returns { supported, items, total, next }.',
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Event type, e.g. "login.success".' },
          subject: { type: 'string', description: 'Account id the events are about.' },
          page,
          limit,
        },
      },
      async run(input, call) {
        const cfg = (await service(call.ctx)).config;
        const sink = cfg.audit;
        if (!sink || typeof sink.list !== 'function') {
          return { supported: false, items: [], total: 0, next: null };
        }
        const p = pageOf(input);
        const result = await sink.list({
          page: p.page,
          size: p.limit,
          type: text(input, 'type'),
          subject: text(input, 'subject'),
        });
        return {
          supported: true,
          items: result.data.map(auditDto),
          total: result.total,
          next: nextPage(p.page, p.limit, result.total),
        };
      },
    },
    {
      name: 'authkit_revoke_user_sessions',
      kind: 'action',
      destructive: true,
      description:
        "Signs an account out everywhere: ends every session and revokes every app grant and its tokens. Recorded in authkit's audit log (session.revoked_all) with the MCP caller as actor. Returns the counts revoked.",
      input: { type: 'object', properties: { accountId }, required: ['accountId'] },
      async run(input, call) {
        const svc = await service(call.ctx);
        const cfg = svc.config;
        const id = required(input, 'accountId');
        await findAccount(cfg, id);
        const result = await sessions(svc).revokeAll(id);
        await cfg.audit?.record({
          type: 'session.revoked_all',
          accountId: id,
          actorId: mcpActor(call),
          ip: call.ctx.request?.ip?.() ?? null,
          metadata: {
            sessions: result.sessions,
            grants: result.grants,
            accessTokens: result.accessTokens,
            refreshTokens: result.refreshTokens,
            source: 'mcp',
            actor: 'mcp',
          },
        });
        return { ok: true, accountId: id, ...result };
      },
    },
    {
      name: 'authkit_disable_user',
      kind: 'action',
      destructive: true,
      description:
        "Disables an account: it can no longer sign in (re-enable it from the admin console). Recorded in authkit's audit log (user.disabled) with the MCP caller as actor. Only listed when the account store supports disabling accounts.",
      input: { type: 'object', properties: { accountId }, required: ['accountId'] },
      async available() {
        if (!deps.resolve) return true;
        try {
          return supportsAccountStatus((await deps.resolve()).config.accountStore);
        } catch {
          return false;
        }
      },
      async run(input, call) {
        const cfg = (await service(call.ctx)).config;
        const id = required(input, 'accountId');
        await findAccount(cfg, id);
        const applied = await new AdminUsersService(cfg).setStatus(id, true, {
          actorId: mcpActor(call),
          ip: call.ctx.request?.ip?.() ?? null,
          source: 'mcp',
        });
        if (!applied) throw new Error('The account store cannot disable accounts');
        return { ok: true, accountId: id, disabled: true };
      },
    },
  ];
}
