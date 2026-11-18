import { userInfo } from 'node:os';
import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

const ACTIONS = [
  'list',
  'create',
  'show',
  'update',
  'rotate-secret',
  'revoke',
  'disable',
  'enable',
  'delete',
  'grant-app',
  'revoke-app',
] as const;
type Action = (typeof ACTIONS)[number];

/** Quem agiu, nos eventos de auditoria: `cli:<usuário do SO>`. */
export function cliActor(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli';
  }
}

/**
 * Clients OAuth/OIDC pela linha de comando — os mesmos serviços do console admin e da Admin API
 * (mesma validação, mesmos eventos de auditoria, com o ator `cli:<usuário>`).
 */
export default class AuthkitClient extends BaseCommand {
  static commandName = 'authkit:client';
  static description =
    'Manage OAuth clients: list, create, show, update, rotate-secret, revoke, disable, enable, delete, grant-app, revoke-app.';

  static help = [
    'Actions:',
    '  list                 every client (--mcp: only MCP clients, registered or by metadata document)',
    '  create               a client; a confidential one prints its secret ONCE',
    '  show <id>            one client',
    '  update <id>          change its metadata (only the flags you pass)',
    '  rotate-secret <id>   a new secret, printed ONCE (the old one stops working)',
    '  revoke <id>          disable it and cut its grants/tokens in every account',
    '  disable <id>         stop it (invalid_client from the next request); grants are kept',
    '  enable <id>          turn a disabled or revoked client back on',
    '  delete <id>          delete it',
    '  grant-app <id>       let a service tenant call another app (--app, --capability)',
    '  revoke-app <id>      take that away (--app)',
    '',
    'Examples:',
    '  node ace authkit:client list --json',
    '  node ace authkit:client list --mcp',
    '  node ace authkit:client create --client-id=my-spa --redirect-uri=https://app/cb --public',
    '  node ace authkit:client create --client-id=my-api --redirect-uri=https://api/cb --scope=openid --scope=email',
    '  node ace authkit:client create --client-id=my-mobile --native --redirect-uri=com.example.app:/oauth',
    '  node ace authkit:client create --client-id=worker-acme --partition=acme --capability=reports',
    '  node ace authkit:client create --client-id=orders --partition=orders --app=billing=invoices:read',
    '  node ace authkit:client grant-app orders --app=billing --capability=invoices:read',
    '  node ace authkit:client revoke-app orders --app=billing',
    '  node ace authkit:client update my-spa --redirect-uri=https://app/cb --redirect-uri=https://app/cb2',
    '  node ace authkit:client update worker-acme --add-capability=payments:* (keeps the secret)',
    '  node ace authkit:client update worker-acme --capability=reports --environment=staging',
    '  node ace authkit:client rotate-secret my-api --force',
    '  node ace authkit:client revoke https://claude.ai/oauth/claude-code-client-metadata --force',
    '',
    'Destructive actions (rotate-secret, revoke, delete) ask for confirmation unless --force.',
  ];

  static options: CommandOptions = { startApp: true };

  @args.string({ description: `Action: ${ACTIONS.join(', ')}` })
  declare action: string;

  @args.string({
    description: 'Client id (show, update, rotate-secret, revoke, disable, enable, delete)',
    required: false,
  })
  declare id?: string;

  @flags.string({ description: 'create: the client_id (default: random).' })
  declare clientId?: string;

  @flags.string({ description: 'create/update: client_name.' })
  declare name?: string;

  @flags.array({ description: 'create/update: redirect_uri (repeatable).' })
  declare redirectUri?: string[];

  @flags.array({
    description: 'create/update: post_logout_redirect_uri (repeatable).',
  })
  declare postLogoutUri?: string[];

  @flags.array({
    description:
      'create/update: grant type (repeatable). Default: authorization_code + refresh_token.',
  })
  declare grant?: string[];

  @flags.array({
    description: 'create/update: a scope the client may ask for (repeatable). Default: any.',
  })
  declare scope?: string[];

  @flags.boolean({
    description: 'create/update: public client (no secret, PKCE).',
  })
  declare public?: boolean;

  @flags.boolean({
    description: 'create/update: confidential client (with a secret).',
  })
  declare confidential?: boolean;

  @flags.boolean({
    description: 'create: native app (RFC 8252): public, private-scheme/loopback redirects.',
  })
  declare native?: boolean;

  @flags.string({
    allowEmptyValue: true,
    description:
      'create/update: OIDC back-channel logout endpoint (`--backchannel-logout-uri=` removes it).',
  })
  declare backchannelLogoutUri?: string;

  @flags.boolean({
    description:
      'create/update: back-channel logout needs the session id (`sid`). `--no-backchannel-logout-session-required` turns it off.',
  })
  declare backchannelLogoutSessionRequired?: boolean;

  @flags.string({
    allowEmptyValue: true,
    description: 'create/update: logo URL shown on the consent screen (`--logo-uri=` removes it).',
  })
  declare logoUri?: string;

  @flags.string({
    description: 'create: use this client_secret instead of a random one.',
  })
  declare clientSecret?: string;

  @flags.string({
    description: 'create/update: service tenant partition (client_credentials only).',
  })
  declare partition?: string;

  @flags.array({
    allowEmptyValue: true,
    description:
      'create/update: service tenant capability (repeatable). On update it REPLACES the list ' +
      '(`--capability=` empties it). Needs --partition on create.',
  })
  declare capability?: string[];

  @flags.array({
    description: 'update: add a capability to a service tenant, keeping the others (repeatable).',
  })
  declare addCapability?: string[];

  @flags.array({
    description: 'update: remove a capability from a service tenant (repeatable).',
  })
  declare removeCapability?: string[];

  @flags.string({
    allowEmptyValue: true,
    description:
      'create/update: service tenant environment (`environment` claim). `--environment=` clears it on update. Needs --partition on create.',
  })
  declare environment?: string;

  @flags.array({
    flagName: 'app',
    description:
      'create: an app the service tenant may call, `name` or `name=cap1,cap2` (repeatable). ' +
      'grant-app/revoke-app: the app.',
  })
  declare targetApp?: string[];

  @flags.boolean({
    description: 'list: only MCP clients (dynamic registration or metadata document).',
  })
  declare mcp?: boolean;

  @flags.boolean({ description: 'Do not ask for confirmation.' })
  declare force?: boolean;

  @flags.boolean({ description: 'Machine-readable output.' })
  declare json?: boolean;

  #fail(message: string) {
    this.logger.logError(message);
    this.exitCode = 1;
  }

  #print(value: unknown) {
    this.logger.info(JSON.stringify(value, null, 2));
  }

  async #confirm(question: string): Promise<boolean> {
    if (this.force) return true;
    try {
      return await this.prompt.confirm(question);
    } catch {
      this.#fail('Refusing without confirmation: pass --force.');
      return false;
    }
  }

  async run() {
    const action = this.action as Action;
    if (!ACTIONS.includes(action)) {
      return this.#fail(`Unknown action "${this.action}". Use one of: ${ACTIONS.join(', ')}.`);
    }
    if (action !== 'list' && action !== 'create' && !this.id) {
      return this.#fail(`authkit:client ${action} needs a client id.`);
    }
    const service = await this.app.container.make('authkit.server');
    const { AdminClientsService } = await import('../src/host/admin_clients_service.js');
    const svc = new AdminClientsService(service);
    switch (action) {
      case 'list':
        return this.#list(service, svc);
      case 'create':
        return this.#create(service, svc);
      case 'show':
        return this.#show(service, svc, this.id!);
      case 'update':
        return this.#update(service, svc, this.id!);
      case 'rotate-secret':
        return this.#rotateSecret(service, svc, this.id!);
      case 'revoke':
        return this.#revoke(service, this.id!);
      case 'disable':
      case 'enable':
        return this.#setDisabled(service, svc, this.id!, action === 'disable');
      case 'delete':
        return this.#delete(service, svc, this.id!);
      case 'grant-app':
        return this.#appGrant(service, svc, this.id!, true);
      case 'revoke-app':
        return this.#appGrant(service, svc, this.id!, false);
    }
  }

  async #list(service: any, svc: any) {
    if (!svc.canList) {
      return this.#fail('The client adapter cannot list clients.');
    }
    const { isClientIdUrl } = await import('../src/cimd/client_id_url.js');
    const stored: any[] = await svc.list();
    const rows = stored.map((c) => ({
      clientId: c.clientId,
      name: c.clientName,
      kind: c.dynamicallyRegistered ? 'dynamic' : 'manual',
      confidential: c.confidential,
      disabled: c.disabled,
      registeredAt: c.registeredAt ? c.registeredAt.toISOString() : null,
    }));
    if (this.mcp) {
      // Clientes por Client ID Metadata Document não têm cadastro: os que têm grant vivo.
      const { AdminSessionsService } = await import('../src/host/admin_sessions_service.js');
      const storedIds = new Set(stored.map((c) => c.clientId));
      const withGrants: Set<string> = await new AdminSessionsService(service).clientIdsWithGrants();
      const documents = [...withGrants]
        .filter((id) => !storedIds.has(id) && isClientIdUrl(id))
        .map((id) => ({
          clientId: id,
          name: null,
          kind: 'metadata-document',
          confidential: false,
          disabled: false,
          registeredAt: null,
        }));
      const mcpRows = [...rows.filter((r) => r.kind === 'dynamic'), ...documents];
      return this.#table(mcpRows);
    }
    return this.#table(rows);
  }

  #table(rows: Array<Record<string, any>>) {
    if (this.json) return this.#print(rows);
    if (rows.length === 0) return this.logger.info('No clients.');
    const table = this.ui.table();
    table.head(['client_id', 'name', 'kind', 'type', 'status']);
    for (const r of rows) {
      table.row([
        r.clientId,
        r.name ?? '',
        r.kind,
        r.confidential ? 'confidential' : 'public',
        r.disabled ? 'disabled' : 'active',
      ]);
    }
    table.render();
  }

  #clientInput(base: { tokenEndpointAuthMethod?: string } = {}) {
    if (this.public && this.confidential) {
      throw new Error('--public and --confidential cannot be used together.');
    }
    const isPublic = this.public || this.native;
    const authMethod = isPublic
      ? 'none'
      : this.confidential
        ? 'client_secret_basic'
        : base.tokenEndpointAuthMethod;
    return {
      ...(this.name !== undefined ? { clientName: this.name || null } : {}),
      ...(this.redirectUri?.length ? { redirectUris: this.redirectUri } : {}),
      ...(this.postLogoutUri?.length ? { postLogoutRedirectUris: this.postLogoutUri } : {}),
      ...(this.grant?.length ? { grantTypes: this.grant } : {}),
      ...(this.scope?.length ? { scopes: this.scope } : {}),
      ...(authMethod ? { tokenEndpointAuthMethod: authMethod } : {}),
      ...(this.native ? { applicationType: 'native' } : {}),
      ...(this.backchannelLogoutUri !== undefined
        ? { backchannelLogoutUri: this.backchannelLogoutUri || null }
        : {}),
      ...(this.backchannelLogoutSessionRequired !== undefined
        ? { backchannelLogoutSessionRequired: this.backchannelLogoutSessionRequired }
        : {}),
      ...(this.logoUri !== undefined ? { logoUri: this.logoUri.trim() || null } : {}),
    };
  }

  async #create(service: any, svc: any) {
    const { ClientMetadataError } = await import('../src/host/client_metadata.js');
    const tenant =
      this.partition !== undefined ||
      !!this.capability?.length ||
      this.environment !== undefined ||
      !!this.targetApp?.length;
    if (tenant && !this.partition) {
      return this.#fail('--capability, --environment and --app need --partition.');
    }
    let apps: Record<string, string[]> = {};
    try {
      apps = parseAppFlags(this.targetApp ?? []);
    } catch (error) {
      return this.#fail((error as Error).message);
    }
    if (tenant) {
      const conflicting = [
        this.redirectUri?.length && '--redirect-uri',
        this.postLogoutUri?.length && '--post-logout-uri',
        this.public && '--public',
        this.native && '--native',
        this.backchannelLogoutUri !== undefined && '--backchannel-logout-uri',
        this.backchannelLogoutSessionRequired !== undefined &&
          '--backchannel-logout-session-required',
        this.logoUri !== undefined && '--logo-uri',
        this.grant?.some((g) => g !== 'client_credentials') && '--grant',
      ].filter(Boolean);
      if (conflicting.length) {
        return this.#fail(
          `${conflicting.join(', ')} cannot be used with --partition (a service tenant only uses client_credentials).`,
        );
      }
    } else if (!this.redirectUri?.length) {
      return this.#fail('--redirect-uri is required (at least one callback URI).');
    } else {
      const sidRefusal = this.#sessionRequiredRefusal(null);
      if (sidRefusal) return this.#fail(sidRefusal);
    }
    let input: any;
    try {
      input = tenant
        ? {
            clientId: this.clientId,
            clientName: this.name,
            applicationType: 'web',
            redirectUris: [],
            postLogoutRedirectUris: [],
            grantTypes: ['client_credentials'],
            tokenEndpointAuthMethod: 'client_secret_basic',
            ...(this.scope?.length ? { scopes: this.scope } : {}),
            serviceTenant: {
              partition: this.partition,
              capabilities: this.capability ?? [],
              ...(this.environment ? { environment: this.environment } : {}),
              ...(Object.keys(apps).length ? { apps } : {}),
            },
          }
        : {
            clientId: this.clientId,
            applicationType: 'web',
            postLogoutRedirectUris: [],
            grantTypes: ['authorization_code', 'refresh_token'],
            ...this.#clientInput({
              tokenEndpointAuthMethod: 'client_secret_basic',
            }),
          };
    } catch (error) {
      return this.#fail((error as Error).message);
    }
    if (input.tokenEndpointAuthMethod === 'none' && this.clientSecret) {
      return this.#fail('--client-secret does not apply to a public client.');
    }
    let created: { clientId: string; clientSecret?: string };
    try {
      created = this.clientSecret
        ? await svc.createWithSecret(input, this.clientSecret)
        : await svc.create(input);
    } catch (error) {
      if (error instanceof ClientMetadataError) return this.#fail(error.message);
      throw error;
    }
    const client = await svc.find(created.clientId);
    await service.config.audit?.record({
      type: 'client.created',
      clientId: created.clientId,
      actorId: cliActor(),
      ip: null,
      metadata: {
        actor: 'cli',
        ...(client?.serviceTenant ? { partition: client.serviceTenant.partition } : {}),
      },
    });
    if (this.json) {
      return this.#print({
        ...this.#dto(client),
        clientSecret: created.clientSecret ?? null,
      });
    }
    this.logger.success(
      tenant
        ? `Service tenant created: ${created.clientId}`
        : `Client created: ${created.clientId}`,
    );
    this.#describe(client);
    if (created.clientSecret) {
      this.logger.info('');
      this.logger.success('CLIENT SECRET (shown ONCE - store it now):');
      this.logger.success(`  ${created.clientSecret}`);
      this.logger.info('');
    }
  }

  #dto(c: any) {
    return {
      clientId: c.clientId,
      clientName: c.clientName,
      confidential: c.confidential,
      tokenEndpointAuthMethod: c.tokenEndpointAuthMethod,
      applicationType: c.applicationType,
      grantTypes: c.grantTypes,
      redirectUris: c.redirectUris,
      postLogoutRedirectUris: c.postLogoutRedirectUris,
      scope: c.scope,
      backchannelLogoutUri: c.backchannelLogoutUri ?? null,
      disabled: c.disabled,
      dynamicallyRegistered: c.dynamicallyRegistered,
      registeredAt: c.registeredAt ? c.registeredAt.toISOString() : null,
      serviceTenant: c.serviceTenant,
    };
  }

  #describe(c: any) {
    const lines: Array<[string, unknown]> = [
      ['client_id', c.clientId],
      ['name', c.clientName ?? ''],
      ['type', c.confidential ? 'confidential' : 'public'],
      ['application', c.applicationType],
      ['grant_types', c.grantTypes.join(', ')],
      ['redirect_uris', c.redirectUris.join(', ')],
      ['scope', c.scope ?? '(any)'],
      ['status', c.disabled ? 'disabled' : 'active'],
      ['registered', c.dynamicallyRegistered ? 'dynamic registration (/reg)' : 'manual'],
    ];
    if (c.serviceTenant) {
      lines.push(['partition', c.serviceTenant.partition]);
      lines.push(['capabilities', c.serviceTenant.capabilities.join(', ')]);
      if (c.serviceTenant.environment) lines.push(['environment', c.serviceTenant.environment]);
      for (const [app, caps] of Object.entries(c.serviceTenant.apps ?? {})) {
        lines.push([`calls ${app}`, (caps as string[]).join(', ') || '(no capabilities)']);
      }
    }
    for (const [k, v] of lines) this.logger.info(`  ${k.padEnd(14)} ${v}`);
  }

  /** `grant-app` / `revoke-app`: which other apps a service tenant may call. */
  async #appGrant(service: any, svc: any, id: string, grant: boolean) {
    const { ClientMetadataError } = await import('../src/host/client_metadata.js');
    const app = this.targetApp?.length === 1 ? this.targetApp[0]!.trim() : '';
    if (!app || app.includes('=')) {
      return this.#fail(`authkit:client ${this.action} needs exactly one --app=<name>.`);
    }
    let client: any;
    try {
      client = await svc.setAppGrant(id, app, grant ? (this.capability ?? []) : null);
    } catch (error) {
      if (error instanceof ClientMetadataError) return this.#fail(error.message);
      throw error;
    }
    if (!client) return this.#fail(`Client ${id} not found.`);
    await service.config.audit?.record({
      type: 'client.updated',
      clientId: id,
      actorId: cliActor(),
      ip: null,
      metadata: {
        actor: 'cli',
        action: grant ? 'grant_app' : 'revoke_app',
        app,
        partition: client.serviceTenant?.partition,
      },
    });
    if (this.json) return this.#print(this.#dto(client));
    this.logger.success(grant ? `${id} may now call ${app}.` : `${id} may no longer call ${app}.`);
    this.#describe(client);
  }

  async #show(service: any, svc: any, id: string) {
    const client = await svc.find(id);
    if (!client) {
      const { isClientIdUrl } = await import('../src/cimd/client_id_url.js');
      if (isClientIdUrl(id)) {
        const doc = service.metadataDocuments?.cached().find((c: any) => c.clientId === id);
        const info = {
          clientId: id,
          kind: 'metadata-document',
          clientName: doc?.clientName ?? null,
        };
        if (this.json) return this.#print(info);
        this.logger.info(`  client_id      ${id}`);
        this.logger.info('  registered     Client ID Metadata Document (no stored record)');
        return;
      }
      return this.#fail(`Client ${id} not found.`);
    }
    if (this.json) return this.#print(this.#dto(client));
    this.#describe(client);
  }

  async #update(service: any, svc: any, id: string) {
    const { ClientMetadataError } = await import('../src/host/client_metadata.js');
    const existing = await svc.find(id);
    if (!existing) return this.#fail(`Client ${id} not found.`);
    let input: Record<string, unknown>;
    try {
      input = this.#clientInput();
    } catch (error) {
      return this.#fail((error as Error).message);
    }
    const sidRefusal = this.#sessionRequiredRefusal(existing.backchannelLogoutUri ?? null);
    if (sidRefusal) return this.#fail(sidRefusal);
    const tenant = this.#serviceTenantUpdate(existing.serviceTenant ?? null);
    if (typeof tenant === 'string') return this.#fail(tenant);
    if (tenant) input.serviceTenant = tenant;
    if (Object.keys(input).length === 0) {
      return this.#fail(
        'Nothing to update: pass at least one flag (--name, --redirect-uri, --add-capability, …).',
      );
    }
    try {
      await svc.update(id, input);
    } catch (error) {
      if (error instanceof ClientMetadataError) return this.#fail(error.message);
      throw error;
    }
    await service.config.audit?.record({
      type: 'client.updated',
      clientId: id,
      actorId: cliActor(),
      ip: null,
      metadata: {
        actor: 'cli',
        ...(tenant
          ? {
              partition: tenant.partition,
              capabilities: tenant.capabilities,
              previousCapabilities: existing.serviceTenant.capabilities,
            }
          : {}),
      },
    });
    const updated = await svc.find(id);
    if (this.json) return this.#print(this.#dto(updated));
    this.logger.success(`Client updated: ${id}`);
    this.#describe(updated);
  }

  /**
   * `update`: the service-tenant flags applied over the client's current grant (the same
   * `serviceTenant` the console and the Admin API write). `null` = no tenant flag passed;
   * a string = the refusal. The secret is never touched.
   */
  #serviceTenantUpdate(
    current: {
      partition: string;
      capabilities: string[];
      environment?: string;
      apps?: Record<string, string[]>;
    } | null,
  ):
    | {
        partition: string;
        capabilities: string[];
        environment?: string;
        apps?: Record<string, string[]>;
      }
    | string
    | null {
    const add = (this.addCapability ?? []).map((c) => c.trim()).filter(Boolean);
    const remove = new Set((this.removeCapability ?? []).map((c) => c.trim()).filter(Boolean));
    const touched =
      this.partition !== undefined ||
      this.capability !== undefined ||
      this.environment !== undefined ||
      add.length > 0 ||
      remove.size > 0;
    if (this.targetApp?.length) {
      return 'update does not take --app: use grant-app / revoke-app.';
    }
    if (!touched) return null;
    if (!current) {
      return 'Not a service tenant: --partition, --capability, --add-capability, --remove-capability and --environment only change a service tenant (create one with `create --partition`).';
    }
    if (this.capability !== undefined && (add.length > 0 || remove.size > 0)) {
      return '--capability replaces the whole list: do not mix it with --add-capability / --remove-capability.';
    }
    const base = this.capability
      ? this.capability.map((c) => c.trim()).filter(Boolean)
      : current.capabilities;
    const capabilities = [...new Set([...base, ...add])].filter((c) => !remove.has(c));
    const environment =
      this.environment === undefined ? current.environment : this.environment.trim() || undefined;
    return {
      partition: this.partition?.trim() || current.partition,
      capabilities,
      ...(environment ? { environment } : {}),
      ...(current.apps ? { apps: current.apps } : {}),
    };
  }

  /**
   * `--backchannel-logout-session-required` only means something with a back-channel logout URI
   * (the server stores it with the URI): refused when the client would end up without one.
   */
  #sessionRequiredRefusal(currentUri: string | null): string | null {
    if (!this.backchannelLogoutSessionRequired) return null;
    const uri =
      this.backchannelLogoutUri === undefined ? currentUri : this.backchannelLogoutUri.trim();
    return uri
      ? null
      : '--backchannel-logout-session-required needs a back-channel logout URI (--backchannel-logout-uri).';
  }

  /** `disable` / `enable`: the client gets `invalid_client` while disabled; nothing else changes. */
  async #setDisabled(service: any, svc: any, id: string, disabled: boolean) {
    if (!(await svc.setDisabled(id, disabled))) return this.#fail(`Client ${id} not found.`);
    const client = await svc.find(id);
    await service.config.audit?.record({
      type: disabled ? 'client.disabled' : 'client.enabled',
      clientId: id,
      actorId: cliActor(),
      ip: null,
      metadata: {
        actor: 'cli',
        ...(client?.serviceTenant ? { partition: client.serviceTenant.partition } : {}),
      },
    });
    if (this.json) return this.#print(this.#dto(client));
    this.logger.success(disabled ? `Client disabled: ${id}` : `Client enabled: ${id}`);
  }

  async #rotateSecret(service: any, svc: any, id: string) {
    const existing = await svc.find(id);
    if (!existing) return this.#fail(`Client ${id} not found.`);
    if (!existing.confidential) return this.#fail(`Client ${id} is public: it has no secret.`);
    if (!(await this.#confirm(`Rotate the secret of ${id}? The current one stops working.`))) {
      if (!this.exitCode) this.#fail('Cancelled.');
      return;
    }
    const secret = await svc.regenerateSecret(id);
    await service.config.audit?.record({
      type: 'client.secret_regenerated',
      clientId: id,
      actorId: cliActor(),
      ip: null,
      metadata: { actor: 'cli' },
    });
    if (this.json) return this.#print({ clientId: id, clientSecret: secret });
    this.logger.success('CLIENT SECRET (shown ONCE - store it now):');
    this.logger.success(`  ${secret}`);
  }

  async #revoke(service: any, id: string) {
    if (
      !(await this.#confirm(
        `Revoke ${id}? It is disabled and its grants and tokens are cut in every account.`,
      ))
    ) {
      if (!this.exitCode) this.#fail('Cancelled.');
      return;
    }
    const { revokeClient } = await import('../src/host/client_revocation.js');
    const result = await revokeClient(service, id, {
      actorId: cliActor(),
      source: 'cli',
    });
    if (this.json) return this.#print(result);
    this.logger.success(
      `Revoked ${id}: ${result.grants} grant(s), ${result.accessTokens} access token(s), ${result.refreshTokens} refresh token(s).`,
    );
    if (!result.stored) {
      this.logger.info(
        '  No stored record (a Client ID Metadata Document client): it can sign in again while MCP client login is on. Turn it off with `node ace authkit:settings:set mcp_clients \'{"enabled":false}\'`.',
      );
    }
  }

  async #delete(service: any, svc: any, id: string) {
    const existing = await svc.find(id);
    if (!existing) return this.#fail(`Client ${id} not found.`);
    if (!(await this.#confirm(`Delete client ${id}?`))) {
      if (!this.exitCode) this.#fail('Cancelled.');
      return;
    }
    await svc.delete(id);
    await service.config.audit?.record({
      type: 'client.deleted',
      clientId: id,
      actorId: cliActor(),
      ip: null,
      metadata: { actor: 'cli' },
    });
    if (this.json) return this.#print({ clientId: id, deleted: true });
    this.logger.success(`Client deleted: ${id}`);
  }
}

/** `--app=billing` / `--app=billing=invoices:read,invoices:write` → `{ billing: [...] }`. */
export function parseAppFlags(values: string[]): Record<string, string[]> {
  const apps: Record<string, string[]> = {};
  for (const raw of values) {
    const at = raw.indexOf('=');
    const name = (at === -1 ? raw : raw.slice(0, at)).trim();
    if (!name) throw new Error(`--app "${raw}" has no app name.`);
    const caps =
      at === -1
        ? []
        : raw
            .slice(at + 1)
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
    apps[name] = [...new Set([...(apps[name] ?? []), ...caps])];
  }
  return apps;
}
