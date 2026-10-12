import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { displayNameFor } from '../../agents/agent_identity.js';
import { parseScope } from '../../agents/config.js';
import type { AgentProtocolId, AgentRegistryRow } from '../../agents/registry_store.js';
import { type PersonalAgentsRuntime, personalAgentsFor } from '../../agents/runtime.js';
import { parseListPage, parseListSize } from '../../pagination.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { apiError } from '../admin_api/dto.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { requireSudo } from '../sudo_mode.js';

/** Mesmo gate de sudo das outras ações destrutivas do console (sessões, chaves). */
async function gateSudo(ctx: HttpContext): Promise<unknown | null> {
  const settings = await resolveRuntimeSettings(ctx);
  const result = await requireSudo(ctx, settings);
  if (result === true) return null;
  return ctx.response
    .status(403)
    .send(apiError('sudo_required', 'Identity confirmation required.'));
}

function notSupported(ctx: HttpContext) {
  return ctx.response.notFound(
    apiError(
      'capability_unsupported',
      'Personal agents não estão configurados (`personalAgents` no defineConfig) ou não há banco.',
    ),
  );
}

/** O runtime com banco, ou `null` (404 honesto). */
async function runtimeFor(ctx: HttpContext): Promise<
  | (PersonalAgentsRuntime & {
      registry: NonNullable<PersonalAgentsRuntime['registry']>;
      grants: NonNullable<PersonalAgentsRuntime['grants']>;
    })
  | null
> {
  const runtime = await personalAgentsFor(ctx);
  if (!runtime?.registry || !runtime.grants) return null;
  return runtime as any;
}

function enabledProtocols(runtime: PersonalAgentsRuntime): AgentProtocolId[] {
  const out: AgentProtocolId[] = [];
  if (runtime.config.pact) out.push('pact');
  if (runtime.config.poppy) out.push('poppy');
  return out;
}

function isUrl(value: unknown, allowHttp: boolean): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')) && !url.hash;
  } catch {
    return false;
  }
}

async function agentName(
  runtime: PersonalAgentsRuntime,
  protocol: AgentProtocolId,
  identifier: string,
  fallback: string | null,
): Promise<string> {
  if (fallback) return fallback;
  if (protocol === 'poppy' && runtime.poppy) {
    return runtime.poppy.registry.displayName(identifier);
  }
  const registration = await runtime.config.resolveAgent(identifier);
  return displayNameFor(registration ?? { issuer: identifier, jwksUri: '' });
}

type ListStatus = 'allowed' | 'blocked';

interface AgentEntry {
  protocol: AgentProtocolId;
  identifier: string;
  name: string;
  /** O que o `defineConfig` diz (só listas estáticas); `null` = nada. */
  config: ListStatus | null;
  /** O que o console diz; `null` = nada. */
  console: { id: string; status: ListStatus; updatedAt: string; updatedBy: string | null } | null;
  /** Resultado: bloqueado em qualquer lado vence; senão liberado em qualquer lado; senão `unlisted`. */
  effective: ListStatus | 'unlisted';
  jwksUri: string | null;
  /** Conexões vivas (grants não revogados nem expirados). */
  connections: number;
}

/**
 * Endpoints JSON de personal agents (PACT e Poppy) do console admin React.
 *
 * GET    {prefix}/api/personal-agents                          → agentes (config + console + conectados)
 * GET    {prefix}/api/personal-agents/connections?clientId=&accountId=&protocol=&page=&size=
 * POST   {prefix}/api/personal-agents/connections/:grantId/revoke   (sudo)
 * POST   {prefix}/api/personal-agents/registry                 → libera/bloqueia (sudo)
 * DELETE {prefix}/api/personal-agents/registry/:id             → tira do registro do console (sudo)
 *
 * 404 `capability_unsupported` quando `personalAgents` não está configurado ou não há banco.
 */
export default class ConsolePersonalAgentsController {
  /** GET {prefix}/api/personal-agents */
  async index(ctx: HttpContext) {
    const runtime = await runtimeFor(ctx);
    if (!runtime) return notSupported(ctx);
    const cfg = runtime.config;
    const now = new Date();
    const entries = new Map<string, AgentEntry>();
    const keyOf = (p: AgentProtocolId, id: string) => `${p} ${id}`;
    const entry = (protocol: AgentProtocolId, identifier: string): AgentEntry => {
      const k = keyOf(protocol, identifier);
      let e = entries.get(k);
      if (!e) {
        e = {
          protocol,
          identifier,
          name: '',
          config: null,
          console: null,
          effective: 'unlisted',
          jwksUri: null,
          connections: 0,
        };
        entries.set(k, e);
      }
      return e;
    };
    const names = new Map<string, string | null>();

    if (cfg.pact) {
      for (const agent of cfg.staticAgents ?? []) {
        const e = entry('pact', agent.issuer);
        e.config = agent.enabled === false ? 'blocked' : 'allowed';
        e.jwksUri = agent.jwksUri;
        names.set(keyOf('pact', agent.issuer), agent.name ?? null);
      }
      for (const [clientId, count] of await runtime.grants.countLiveGrantsByClient(now, 'pact')) {
        entry('pact', clientId).connections = count;
      }
    }
    if (cfg.poppy) {
      for (const id of cfg.poppy.clients.registeredList ?? [])
        entry('poppy', id).config = 'allowed';
      for (const id of cfg.poppy.clients.blockedList ?? []) entry('poppy', id).config = 'blocked';
      for (const [clientId, count] of await runtime.grants.countLiveGrantsByClient(now, 'poppy')) {
        entry('poppy', clientId).connections = count;
      }
    }
    for (const row of await runtime.registry.list()) {
      if (!enabledProtocols(runtime).includes(row.protocol)) continue;
      const e = entry(row.protocol, row.identifier);
      e.console = {
        id: row.id,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy,
      };
      if (row.jwksUri) e.jwksUri = row.jwksUri;
      if (row.name) names.set(keyOf(row.protocol, row.identifier), row.name);
    }

    const agents = await Promise.all(
      [...entries.values()].map(async (e) => {
        const statuses = [e.config, e.console?.status];
        e.effective = statuses.includes('blocked')
          ? 'blocked'
          : statuses.includes('allowed')
            ? 'allowed'
            : 'unlisted';
        e.name = await agentName(
          runtime,
          e.protocol,
          e.identifier,
          names.get(keyOf(e.protocol, e.identifier)) ?? null,
        );
        return e;
      }),
    );
    agents.sort((a, b) => b.connections - a.connections || a.name.localeCompare(b.name));

    return {
      protocols: {
        pact: cfg.pact
          ? {
              open: cfg.open,
              /** A lista do config é uma função do host (o console não enxerga). */
              hostResolver: cfg.staticAgents === null,
            }
          : null,
        poppy: cfg.poppy
          ? {
              requireRegistration: cfg.poppy.clients.requireRegistration,
              hostResolver:
                cfg.poppy.clients.registeredList === null || cfg.poppy.clients.blockedList === null,
              allowInsecureClientIds: cfg.poppy.allowInsecureClientIds,
            }
          : null,
      },
      agents,
    };
  }

  /** GET {prefix}/api/personal-agents/connections */
  async connections(ctx: HttpContext) {
    const runtime = await runtimeFor(ctx);
    if (!runtime) return notSupported(ctx);
    const qs = ctx.request.qs() as Record<string, string | undefined>;
    const page = parseListPage(qs.page);
    const size = parseListSize(qs.size);
    const protocol =
      qs.protocol === 'pact' || qs.protocol === 'poppy'
        ? (qs.protocol as AgentProtocolId)
        : undefined;
    const filter = {
      protocol,
      clientId: qs.clientId?.trim() || undefined,
      accountId: qs.accountId?.trim() || undefined,
    };
    const now = new Date();
    const [total, rows] = await Promise.all([
      runtime.grants.countLiveGrants(now, filter),
      runtime.grants.listLiveGrants({ ...filter, now, offset: (page - 1) * size, limit: size }),
    ]);

    const store = (await ctx.containerResolver.make('authkit.server')).config.accountStore;
    const emails = new Map<string, string | null>();
    const nameCache = new Map<string, Promise<string>>();
    const data = await Promise.all(
      rows.map(async (g) => {
        const rowProtocol: AgentProtocolId = g.id.startsWith('pgrant_') ? 'poppy' : 'pact';
        if (!emails.has(g.accountId)) {
          const account = await store.findById(g.accountId).catch(() => null);
          emails.set(g.accountId, account?.email ?? null);
        }
        const k = `${rowProtocol} ${g.clientId}`;
        if (!nameCache.has(k)) nameCache.set(k, agentName(runtime, rowProtocol, g.clientId, null));
        return {
          id: g.id,
          protocol: rowProtocol,
          clientId: g.clientId,
          agentName: await nameCache.get(k)!,
          accountId: g.accountId,
          accountEmail: emails.get(g.accountId) ?? null,
          scopes: parseScope(g.scope),
          createdAt: g.createdAt.toISOString(),
          updatedAt: g.updatedAt.toISOString(),
          expiresAt: g.expiresAt.toISOString(),
        };
      }),
    );
    return { meta: { page, size, total }, data };
  }

  /** POST {prefix}/api/personal-agents/connections/:grantId/revoke */
  async revokeConnection(ctx: HttpContext) {
    const runtime = await runtimeFor(ctx);
    if (!runtime) return notSupported(ctx);
    const denied = await gateSudo(ctx);
    if (denied) return denied;
    const grantId = ctx.request.param('grantId') as string;
    const grant = await runtime.revokeGrantById(grantId);
    if (!grant) {
      return ctx.response.notFound(apiError('not_found', 'Conexão não encontrada ou já revogada.'));
    }
    const cfg = (await ctx.containerResolver.make('authkit.server')).config;
    await cfg.audit?.record({
      type: 'agent.grant_revoked_by_admin',
      accountId: grant.accountId,
      clientId: grant.clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { grantId, actor: ctx.session.get(ACCOUNT_SESSION_KEY) ?? null },
    });
    return { revoked: true };
  }

  /**
   * POST {prefix}/api/personal-agents/registry
   * body: `{ protocol, identifier, status: 'allowed'|'blocked', name?, jwksUri? }`.
   * Bloquear também desconecta o agente de todas as contas, na hora.
   */
  async upsert(ctx: HttpContext) {
    const runtime = await runtimeFor(ctx);
    if (!runtime) return notSupported(ctx);
    const body = (ctx.request.body() ?? {}) as Record<string, unknown>;
    const invalid = (message: string) =>
      ctx.response.unprocessableEntity(apiError('invalid_request', message));

    const protocol = body.protocol as AgentProtocolId;
    if (!enabledProtocols(runtime).includes(protocol)) {
      return invalid('`protocol` precisa ser um protocolo ligado (`pact` ou `poppy`).');
    }
    const status = body.status;
    if (status !== 'allowed' && status !== 'blocked') {
      return invalid('`status` precisa ser `allowed` ou `blocked`.');
    }
    const allowHttp = protocol === 'poppy' && !!runtime.config.poppy?.allowInsecureClientIds;
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    if (!isUrl(identifier, allowHttp)) {
      return invalid(
        protocol === 'poppy'
          ? '`identifier` precisa ser o `client_id` do agente (URL HTTPS do documento de metadata).'
          : '`identifier` precisa ser o `iss` do agente (URL HTTPS).',
      );
    }
    const name =
      typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : null;
    let jwksUri: string | null = null;
    if (protocol === 'pact') {
      const raw = typeof body.jwksUri === 'string' ? body.jwksUri.trim() : '';
      if (raw && !isUrl(raw, false)) return invalid('`jwksUri` precisa ser uma URL HTTPS.');
      jwksUri = raw || null;
      if (status === 'allowed' && !jwksUri) {
        return invalid('Liberar um agente PACT exige o `jwksUri` dele.');
      }
    }

    const denied = await gateSudo(ctx);
    if (denied) return denied;

    const actor = (ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined) ?? null;
    const row: AgentRegistryRow = await runtime.registry.upsert({
      protocol,
      identifier,
      status,
      name,
      jwksUri,
      updatedBy: actor,
    });
    const disconnected =
      status === 'blocked' ? await runtime.disconnectAgent(protocol, identifier) : 0;

    const cfg = (await ctx.containerResolver.make('authkit.server')).config;
    const event = {
      clientId: identifier,
      ip: ctx.request.ip?.() ?? null,
      metadata: { protocol, actor, disconnected },
    };
    if (status === 'blocked') await cfg.audit?.record({ type: 'agent.blocked', ...event });
    else await cfg.audit?.record({ type: 'agent.allowed', ...event });
    return {
      entry: {
        id: row.id,
        protocol: row.protocol,
        identifier: row.identifier,
        status: row.status,
        name: row.name,
        jwksUri: row.jwksUri,
        updatedAt: row.updatedAt.toISOString(),
      },
      disconnected,
    };
  }

  /** DELETE {prefix}/api/personal-agents/registry/:id */
  async destroy(ctx: HttpContext) {
    const runtime = await runtimeFor(ctx);
    if (!runtime) return notSupported(ctx);
    const denied = await gateSudo(ctx);
    if (denied) return denied;
    const id = ctx.request.param('id') as string;
    const row = await runtime.registry.findById(id);
    if (!row || !(await runtime.registry.delete(id))) {
      return ctx.response.notFound(apiError('not_found', 'Entrada não encontrada.'));
    }
    const cfg = (await ctx.containerResolver.make('authkit.server')).config;
    await cfg.audit?.record({
      type: 'agent.registry_removed',
      clientId: row.identifier,
      ip: ctx.request.ip?.() ?? null,
      metadata: {
        protocol: row.protocol,
        status: row.status,
        actor: ctx.session.get(ACCOUNT_SESSION_KEY) ?? null,
      },
    });
    return { removed: true };
  }
}
