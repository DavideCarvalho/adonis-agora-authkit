import type { ApplicationService } from '@adonisjs/core/types';
import type {
  AddedOrgMember,
  AddOrgMemberInput,
  Authkit,
  AuthkitClient,
  AuthkitCreatedClient,
  AuthkitCreatedUser,
  AuthkitOrganization,
  AuthkitOrganizationDetail,
  AuthkitOrgInvitation,
  AuthkitOrgMember,
  AuthkitSetting,
  AuthkitStats,
  AuthkitUser,
  ClientInput,
  CreateOrganizationInput,
  CreateOrgInvitationInput,
  CreateUserInput,
  DeletedClient,
  DeletedOrganization,
  DeletedSetting,
  DeletedUser,
  KeysRotateInput,
  KeysRotateResult,
  KeysStatus,
  ListAuditParams,
  ListAuditResult,
  ListClientsResult,
  ListOrganizationsResult,
  ListSessionsResult,
  ListSettingsResult,
  ListUsersParams,
  ListUsersResult,
  RegeneratedSecret,
  RemovedOrgMember,
  ResetPasswordResult,
  RevokedOrgInvitation,
  RevokeSessionsResult,
  UpdatedOrgMemberRole,
  UpdateOrganizationInput,
  UpdateUserInput,
  UserStatusResult,
  VerifyTokenResult,
} from './types.js';

export interface EmbeddedOptions {
  /** The AdonisJS application service (e.g. injected `app`). */
  app: ApplicationService;
}

/** Audit actor used for SDK-originated writes — mirrors the REST `admin-api` source. */
const ACTOR = { actorId: null, ip: null, source: 'admin-api' as const };

/**
 * Builds a minimal HttpContext-shaped object good enough for the server
 * services that only touch `request.protocol()`/`request.host()` (used when
 * composing the password-reset URL) and `request.ip()`. We deliberately do NOT
 * import `@adonisjs/core/http` here — out-of-band SDK calls have no real request.
 *
 * It also carries `containerResolver.app` and `logger`, which is all the server's
 * default mailer reads (host config for the sender, branding and locale; the
 * logger for the dev fallback). Without them, an SDK-created organization
 * invitation reached the database and no inbox — the same silent failure the
 * missing `onOrgInvitation` fallback caused on the HTTP path.
 */
function fakeCtx(app: ApplicationService): any {
  const origin = (app.config.get<string>('authkit.issuer', '') || '').replace(/\/+$/, '');
  let protocol = 'https';
  let host = 'localhost';
  if (origin) {
    try {
      const url = new URL(origin);
      protocol = url.protocol.replace(/:$/, '');
      host = url.host;
    } catch {
      /* keep defaults */
    }
  }
  return {
    request: {
      protocol: () => protocol,
      host: () => host,
      ip: () => null,
    },
    containerResolver: { app },
    // Pino-shaped shim. `ApplicationService` exposes no logger synchronously (it
    // is a container binding), and the only thing the server's default mailer
    // does with it is the dev-time "no @adonisjs/mail installed, here is the
    // link" notice. Dropping the field would make that notice vanish, which is
    // the one case where an SDK caller most needs to be told nothing was sent.
    logger: {
      info: (...args: unknown[]) => console.info(...args),
      error: (...args: unknown[]) => console.error(...args),
    },
  };
}

/**
 * Embedded driver: when the IdP runs IN-PROCESS in the same AdonisJS app, this
 * resolves the server services from the container (`authkit.server`) and calls
 * the SAME underlying services the Admin API controllers use
 * (`AdminUsersService`, `AdminClientsService`, `AdminSessionsService`,
 * `TokenVerifyService`), producing identical return shapes. The
 * `@adonis-agora/authkit-server` package is imported LAZILY so remote-mode
 * users never need it installed (it's an optional peer dependency).
 */
export async function createEmbeddedAuthkit(opts: EmbeddedOptions): Promise<Authkit> {
  const { app } = opts;
  // Lazy import: only remote-mode consumers may not have the server installed.
  const server = await import('@adonis-agora/authkit-server');
  const {
    AdminUsersService,
    AdminClientsService,
    AdminSessionsService,
    AdminOrgsService,
    TokenVerifyService,
    enrichSessionsWithContext,
    computeAdminStats,
    buildKeysStatus,
    rotateNow,
  } = server as unknown as {
    AdminUsersService: any;
    AdminClientsService: any;
    AdminSessionsService: any;
    AdminOrgsService: any;
    TokenVerifyService: any;
    enrichSessionsWithContext: (cfg: any, accountId: string, sessions: any[]) => Promise<any[]>;
    computeAdminStats: (cfg: any, sessionsService: any) => Promise<AuthkitStats>;
    buildKeysStatus: (svc: any, settings: any) => Promise<KeysStatus | null>;
    rotateNow: (
      svc: any,
      body: any,
    ) => Promise<{ rotated: true; newKid: string; retiredKids: string[]; keptKids: string[] }>;
  };

  const service = await app.container.make('authkit.server');
  const cfg = (service as any).config;
  const ctx = fakeCtx(app);

  // ---- DTO projections (mirror admin_api/dto.ts) ----
  const usersService = new AdminUsersService(cfg);

  async function userDto(account: any): Promise<AuthkitUser> {
    return {
      id: account.id,
      email: account.email,
      name: account.name ?? null,
      avatarUrl: account.avatarUrl ?? null,
      globalRoles: account.globalRoles ?? [],
      disabled: await usersService.isDisabled(account.id),
    };
  }

  function clientDto(client: any): AuthkitClient {
    return {
      clientId: client.clientId,
      confidential: client.confidential,
      grants: client.grants,
      redirectUris: client.redirectUris,
      postLogoutRedirectUris: client.postLogoutRedirectUris,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    };
  }

  function sessionDto(s: any) {
    return {
      id: s.id,
      accountId: s.accountId,
      loginTs: s.loginTs ?? null,
      amr: s.amr ?? [],
      userAgent: s.userAgent ?? null,
      browser: s.browser ?? null,
      os: s.os ?? null,
      ip: s.ip ?? null,
      location: s.location ?? null,
    };
  }
  function grantDto(g: any) {
    return {
      id: g.id,
      accountId: g.accountId,
      clientId: g.clientId ?? null,
      accessTokens: g.accessTokens,
      refreshTokens: g.refreshTokens,
    };
  }
  function auditDto(e: any) {
    return {
      id: e.id,
      type: e.type,
      accountId: e.accountId ?? null,
      email: e.email ?? null,
      clientId: e.clientId ?? null,
      actorId: e.actorId ?? null,
      ip: e.ip ?? null,
      metadata: e.metadata ?? null,
      createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
    };
  }

  function normalizeClientInput(input: ClientInput) {
    return {
      clientId: input.clientId?.trim() || undefined,
      redirectUris: input.redirectUris ?? [],
      postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
      grantTypes: input.grantTypes ?? [],
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? 'client_secret_basic',
    };
  }

  return {
    users: {
      async list(params: ListUsersParams = {}): Promise<ListUsersResult> {
        const search = (params.search ?? '').trim();
        const page = Math.max(1, params.page ?? 1);
        const limit = Math.max(1, Math.min(100, params.limit ?? 20));
        const result = await cfg.accountStore.listAccounts({ search, page, limit });
        const data = await Promise.all(result.data.map((u: any) => userDto(u)));
        return { data, total: result.total, page, limit };
      },
      async get(id: string): Promise<AuthkitUser> {
        const account = await cfg.accountStore.findById(id);
        if (!account) throw new Error('Usuário não encontrado.');
        return userDto(account);
      },
      async create(input: CreateUserInput): Promise<AuthkitCreatedUser> {
        const result = await usersService.create(
          ctx,
          {
            email: input.email.trim(),
            name: input.name ?? null,
            password: input.password ?? null,
            invite: input.invite === true,
          },
          ACTOR,
        );
        if (!result.ok) throw new Error('Já existe uma conta com este e-mail.');
        return { ...(await userDto(result.account)), invited: result.invited };
      },
      async update(id: string, input: UpdateUserInput): Promise<AuthkitUser> {
        const account = await cfg.accountStore.findById(id);
        if (!account) throw new Error('Usuário não encontrado.');
        if (Array.isArray(input.globalRoles)) {
          const normalized = Array.from(
            new Set(input.globalRoles.map((r) => String(r).trim()).filter(Boolean)),
          );
          await usersService.setGlobalRoles(id, normalized);
        }
        if (input.name !== undefined || input.avatarUrl !== undefined) {
          const patch: { name?: string | null; avatarUrl?: string | null } = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.avatarUrl !== undefined) patch.avatarUrl = input.avatarUrl;
          await usersService.updateProfile(id, patch);
        }
        const updated = await cfg.accountStore.findById(id);
        return userDto(updated);
      },
      async disable(id: string): Promise<UserStatusResult> {
        const applied = await usersService.setStatus(id, true, ACTOR);
        if (!applied) throw new Error('O store de contas não suporta habilitar/desabilitar.');
        return { id, disabled: true };
      },
      async enable(id: string): Promise<UserStatusResult> {
        const applied = await usersService.setStatus(id, false, ACTOR);
        if (!applied) throw new Error('O store de contas não suporta habilitar/desabilitar.');
        return { id, disabled: false };
      },
      async resetPassword(id: string): Promise<ResetPasswordResult> {
        const account = await usersService.resetPassword(ctx, id, ACTOR);
        if (!account) throw new Error('Usuário não encontrado.');
        return { id, sent: true };
      },
      async delete(id: string): Promise<DeletedUser> {
        const outcome = await usersService.delete(service, id, ACTOR);
        if (!outcome.ok) {
          throw new Error(
            outcome.reason === 'not_found'
              ? 'Usuário não encontrado.'
              : 'O store de contas não suporta deletar usuários.',
          );
        }
        return { id, deleted: true, ...outcome.result };
      },
    },
    sessions: {
      async list(userId: string): Promise<ListSessionsResult> {
        const admin = new AdminSessionsService(service);
        const sessions = await enrichSessionsWithContext(
          cfg,
          userId,
          await admin.listSessions(userId),
        );
        const grants = await admin.listGrants(userId);
        return {
          canList: admin.canList,
          sessions: sessions.map(sessionDto),
          grants: grants.map(grantDto),
        };
      },
      async revokeAll(userId: string): Promise<RevokeSessionsResult> {
        const result = await new AdminSessionsService(service).revokeAll(userId);
        await cfg.audit?.record({
          type: 'session.revoked_all',
          accountId: userId,
          actorId: ACTOR.actorId,
          ip: ACTOR.ip,
          metadata: { actor: ACTOR.source, ...result },
        });
        return result;
      },
    },
    clients: {
      async list(): Promise<ListClientsResult> {
        const svc = new AdminClientsService(service);
        if (!svc.canList) return { data: [], canList: false };
        const clients = await svc.list();
        return { data: clients.map(clientDto), canList: true };
      },
      async get(id: string): Promise<AuthkitClient> {
        const client = await new AdminClientsService(service).find(id);
        if (!client) throw new Error('Client não encontrado.');
        return clientDto(client);
      },
      async create(input: ClientInput): Promise<AuthkitCreatedClient> {
        const svc = new AdminClientsService(service);
        const created = await svc.create(normalizeClientInput(input));
        await cfg.audit?.record({
          type: 'client.created',
          clientId: created.clientId,
          ip: null,
          metadata: { actor: 'admin-api' },
        });
        return { clientId: created.clientId, clientSecret: created.clientSecret ?? null };
      },
      async update(id: string, input: ClientInput): Promise<AuthkitClient> {
        const svc = new AdminClientsService(service);
        const existing = await svc.find(id);
        if (!existing) throw new Error('Client não encontrado.');
        await svc.update(id, normalizeClientInput(input));
        await cfg.audit?.record({
          type: 'client.updated',
          clientId: id,
          ip: null,
          metadata: { actor: 'admin-api' },
        });
        return clientDto(await svc.find(id));
      },
      async regenerateSecret(id: string): Promise<RegeneratedSecret> {
        const svc = new AdminClientsService(service);
        const secret = await svc.regenerateSecret(id);
        await cfg.audit?.record({
          type: 'client.updated',
          clientId: id,
          ip: null,
          metadata: { actor: 'admin-api', action: 'regenerate_secret' },
        });
        return { clientId: id, clientSecret: secret };
      },
      async delete(id: string): Promise<DeletedClient> {
        const svc = new AdminClientsService(service);
        await svc.delete(id);
        await cfg.audit?.record({
          type: 'client.deleted',
          clientId: id,
          ip: null,
          metadata: { actor: 'admin-api' },
        });
        return { clientId: id, deleted: true };
      },
    },
    audit: {
      async list(params: ListAuditParams = {}): Promise<ListAuditResult> {
        const sink = cfg.audit;
        if (!sink || typeof sink.list !== 'function') {
          throw new Error('O sink de auditoria configurado não suporta consulta.');
        }
        const page = Math.max(1, params.page ?? 1);
        const limit = Math.max(1, Math.min(100, params.limit ?? 20));
        const type = params.type?.trim() || undefined;
        const subject = params.subject?.trim() || undefined;
        const result = await sink.list({ page, limit, type, subject });
        return { data: result.data.map(auditDto), total: result.total, page, limit };
      },
    },
    async stats(): Promise<AuthkitStats> {
      const sessions = new AdminSessionsService(service);
      return computeAdminStats(cfg, sessions);
    },
    tokens: {
      async verify(token: string): Promise<VerifyTokenResult> {
        const verifier = new TokenVerifyService(cfg, (service as any).provider);
        return verifier.verify(token);
      },
    },
    organizations: (() => {
      const orgsService = new AdminOrgsService(cfg);
      const ACTOR = { actorId: null, ip: null, source: 'admin-api' as const };
      const origin = (cfg.issuer ?? '').replace(/\/+$/, '');

      function orgDto(org: any): AuthkitOrganization {
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          logoUrl: org.logoUrl ?? null,
          metadata: org.metadata ?? null,
          createdAt: org.createdAt,
          memberCount: org.memberCount,
        };
      }
      function memberDto(m: any): AuthkitOrgMember {
        return {
          accountId: m.accountId,
          email: m.email ?? null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }
      function invitationDto(inv: any): AuthkitOrgInvitation {
        return {
          id: inv.id,
          organizationId: inv.organizationId,
          email: inv.email,
          role: inv.role,
          invitedBy: inv.invitedBy,
          expiresAt: inv.expiresAt,
          acceptedAt: inv.acceptedAt ?? null,
          createdAt: inv.createdAt,
        };
      }

      return {
        async list(): Promise<ListOrganizationsResult> {
          const result = await orgsService.listOrgs();
          if (!Array.isArray(result))
            throw new Error('Organizations não é suportado nesta instalação.');
          return { data: result.map(orgDto) };
        },
        async create(input: CreateOrganizationInput): Promise<AuthkitOrganization> {
          const result = await orgsService.createOrg(input, ACTOR);
          if ('ok' in result && result.ok === false) {
            throw new Error(
              result.reason === 'not_supported'
                ? 'Organizations não suportado.'
                : 'Slug já em uso.',
            );
          }
          return orgDto(result);
        },
        async get(id: string): Promise<AuthkitOrganizationDetail> {
          const result = await orgsService.getOrg(id);
          if ('ok' in result && result.ok === false) {
            throw new Error(
              result.reason === 'not_supported'
                ? 'Organizations não suportado.'
                : 'Organização não encontrada.',
            );
          }
          const detail = result as any;
          return {
            ...orgDto(detail),
            members: detail.members.map(memberDto),
            pendingInvitations: detail.pendingInvitations.map(invitationDto),
          };
        },
        async update(id: string, input: UpdateOrganizationInput): Promise<AuthkitOrganization> {
          const result = await orgsService.updateOrg(id, input, ACTOR);
          if ('ok' in result && result.ok === false) {
            throw new Error('Organização não encontrada ou slug já em uso.');
          }
          return orgDto(result);
        },
        async delete(id: string): Promise<DeletedOrganization> {
          const result = await orgsService.deleteOrg(id, ACTOR);
          if (!result.ok) throw new Error('Organização não encontrada.');
          return { id, deleted: true };
        },
        members: {
          async list(orgId: string): Promise<AuthkitOrgMember[]> {
            const result = await orgsService.getOrg(orgId);
            if ('ok' in result && result.ok === false)
              throw new Error('Organização não encontrada.');
            return (result as any).members.map(memberDto);
          },
          async add(orgId: string, input: AddOrgMemberInput): Promise<AddedOrgMember> {
            const result = await orgsService.addMember(orgId, input, ACTOR);
            if (!result.ok) throw new Error('Não foi possível adicionar membro.');
            return { orgId, accountId: input.accountId, role: input.role, added: true };
          },
          async remove(orgId: string, accountId: string): Promise<RemovedOrgMember> {
            const result = await orgsService.removeMember(orgId, accountId, ACTOR);
            if (!result.ok) {
              if ((result as any).reason === 'last_owner')
                throw new Error('Não é possível remover o último owner.');
              throw new Error('Membro não encontrado.');
            }
            return { orgId, accountId, removed: true };
          },
          async updateRole(
            orgId: string,
            accountId: string,
            role: string,
          ): Promise<UpdatedOrgMemberRole> {
            const result = await orgsService.updateMemberRole(orgId, accountId, role, ACTOR);
            if (!result.ok) {
              if ((result as any).reason === 'last_owner')
                throw new Error('Não é possível rebaixar o último owner.');
              throw new Error('Membro não encontrado.');
            }
            return { orgId, accountId, role, updated: true };
          },
        },
        invitations: {
          async create(
            orgId: string,
            input: CreateOrgInvitationInput,
          ): Promise<AuthkitOrgInvitation> {
            // `ctx` is what lets the server fall back to its own invitation email
            // when the host defines no `mail.onOrgInvitation` hook.
            const result = await orgsService.createInvitation(
              orgId,
              input,
              ACTOR,
              origin,
              null,
              ctx,
            );
            if (!result.ok) throw new Error('Organização não encontrada.');
            return invitationDto(result.invitation);
          },
          async revoke(orgId: string, invitationId: string): Promise<RevokedOrgInvitation> {
            const result = await orgsService.revokeInvitation(orgId, invitationId, ACTOR);
            if (!result.ok) throw new Error('Convite não encontrado.');
            return { orgId, invitationId, revoked: true };
          },
        },
      };
    })(),
    settings: {
      async list(): Promise<ListSettingsResult> {
        const { RuntimeSettings } = (await import('@adonis-agora/authkit-server')) as unknown as {
          RuntimeSettings: any;
        };
        let db: any;
        try {
          db = await app.container.make('lucid.db');
        } catch {
          return { data: [] };
        }
        const connection: string | undefined = (cfg.accountStore as any)?.connectionName;
        const svc = new RuntimeSettings(db, connection ? { connection } : {});
        const rows = await svc.listSettings();
        return {
          data: rows.map(
            (r: any): AuthkitSetting => ({
              key: r.key,
              value: r.value,
              updatedAt:
                r.updatedAt instanceof Date ? r.updatedAt.toISOString() : (r.updatedAt ?? null),
              updatedBy: r.updatedBy ?? null,
            }),
          ),
        };
      },
      async get(key: string): Promise<AuthkitSetting> {
        const { RuntimeSettings } = (await import('@adonis-agora/authkit-server')) as unknown as {
          RuntimeSettings: any;
        };
        let db: any;
        try {
          db = await app.container.make('lucid.db');
        } catch {
          throw new Error('Runtime settings not available.');
        }
        const connection: string | undefined = (cfg.accountStore as any)?.connectionName;
        const svc = new RuntimeSettings(db, connection ? { connection } : {});
        const value = await svc.getSetting(key);
        if (value === null) throw new Error(`Setting '${key}' not found.`);
        return { key, value, updatedAt: null, updatedBy: null };
      },
      async set(key: string, value: unknown): Promise<AuthkitSetting> {
        const { RuntimeSettings } = (await import('@adonis-agora/authkit-server')) as unknown as {
          RuntimeSettings: any;
        };
        let db: any;
        try {
          db = await app.container.make('lucid.db');
        } catch {
          throw new Error('Runtime settings not available.');
        }
        const connection: string | undefined = (cfg.accountStore as any)?.connectionName;
        const svc = new RuntimeSettings(db, connection ? { connection } : {});
        await svc.setSetting(key, value, null);
        const saved = await svc.getSetting(key);
        await cfg.audit?.record({
          type: 'settings.updated',
          actorId: null,
          ip: null,
          metadata: { key, value },
        });
        return { key, value: saved, updatedAt: new Date().toISOString(), updatedBy: null };
      },
      async delete(key: string): Promise<DeletedSetting> {
        const { RuntimeSettings } = (await import('@adonis-agora/authkit-server')) as unknown as {
          RuntimeSettings: any;
        };
        let db: any;
        try {
          db = await app.container.make('lucid.db');
        } catch {
          throw new Error('Runtime settings not available.');
        }
        const connection: string | undefined = (cfg.accountStore as any)?.connectionName;
        const svc = new RuntimeSettings(db, connection ? { connection } : {});
        await svc.deleteSetting(key);
        await cfg.audit?.record({
          type: 'settings.updated',
          actorId: null,
          ip: null,
          metadata: { key, action: 'deleted' },
        });
        return { key, deleted: true };
      },
    },
    keys: {
      async status(): Promise<KeysStatus> {
        // Build a settings capability for the policy (optional; falls back to defaults when absent).
        const { RuntimeSettings } = (await import('@adonis-agora/authkit-server')) as unknown as {
          RuntimeSettings: any;
        };
        let settingsSvc: any = null;
        try {
          const db = await app.container.make('lucid.db');
          const connection: string | undefined = (cfg.accountStore as any)?.connectionName;
          settingsSvc = new RuntimeSettings(db, connection ? { connection } : {});
        } catch {
          // RuntimeSettings unavailable — buildKeysStatus will fall back to defaults.
        }
        const status = await buildKeysStatus(service, settingsSvc);
        if (!status) throw new Error('jwks não é managed+store.');
        return status;
      },
      async rotate(input?: KeysRotateInput): Promise<KeysRotateResult> {
        return rotateNow(service, input);
      },
    },
  };
}
