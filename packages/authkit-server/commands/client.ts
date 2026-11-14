import { userInfo } from 'node:os';
import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';

const ACTIONS = ['list', 'create', 'show', 'update', 'rotate-secret', 'revoke', 'delete'] as const;
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
    'Manage OAuth clients: list, create, show, update, rotate-secret, revoke, delete.';

  static help = [
    'Actions:',
    '  list                 every client (--mcp: only MCP clients, registered or by metadata document)',
    '  create               a client; a confidential one prints its secret ONCE',
    '  show <id>            one client',
    '  update <id>          change its metadata (only the flags you pass)',
    '  rotate-secret <id>   a new secret, printed ONCE (the old one stops working)',
    '  revoke <id>          disable it and cut its grants/tokens in every account',
    '  delete <id>          delete it',
    '',
    'Examples:',
    '  node ace authkit:client list --json',
    '  node ace authkit:client list --mcp',
    '  node ace authkit:client create --client-id=my-spa --redirect-uri=https://app/cb --public',
    '  node ace authkit:client create --client-id=my-api --redirect-uri=https://api/cb --scope=openid --scope=email',
    '  node ace authkit:client create --client-id=my-mobile --native --redirect-uri=com.example.app:/oauth',
    '  node ace authkit:client create --client-id=worker-acme --partition=acme --capability=reports',
    '  node ace authkit:client update my-spa --redirect-uri=https://app/cb --redirect-uri=https://app/cb2',
    '  node ace authkit:client rotate-secret my-api --force',
    '  node ace authkit:client revoke https://claude.ai/oauth/claude-code-client-metadata --force',
    '',
    'Destructive actions (rotate-secret, revoke, delete) ask for confirmation unless --force.',
  ];

  static options: CommandOptions = { startApp: true };

  @args.string({ description: `Action: ${ACTIONS.join(', ')}` })
  declare action: string;

  @args.string({
    description: 'Client id (show, update, rotate-secret, revoke, delete)',
    required: false,
  })
  declare id?: string;

  @flags.string({ description: 'create: the client_id (default: random).' })
  declare clientId?: string;

  @flags.string({ description: 'create/update: client_name.' })
  declare name?: string;

  @flags.array({ description: 'create/update: redirect_uri (repeatable).' })
  declare redirectUri?: string[];

  @flags.array({ description: 'create/update: post_logout_redirect_uri (repeatable).' })
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

  @flags.boolean({ description: 'create/update: public client (no secret, PKCE).' })
  declare public?: boolean;

  @flags.boolean({ description: 'create/update: confidential client (with a secret).' })
  declare confidential?: boolean;

  @flags.boolean({
    description: 'create: native app (RFC 8252): public, private-scheme/loopback redirects.',
  })
  declare native?: boolean;

  @flags.string({ description: 'create/update: OIDC back-channel logout endpoint.' })
  declare backchannelLogoutUri?: string;

  @flags.string({ description: 'create: use this client_secret instead of a random one.' })
  declare clientSecret?: string;

  @flags.string({ description: 'create: service tenant partition (client_credentials only).' })
  declare partition?: string;

  @flags.array({
    description: 'create: service tenant capability (repeatable). Needs --partition.',
  })
  declare capability?: string[];

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
      case 'delete':
        return this.#delete(service, svc, this.id!);
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
    };
  }

  async #create(service: any, svc: any) {
    const { ClientMetadataError } = await import('../src/host/client_metadata.js');
    const tenant = this.partition !== undefined || !!this.capability?.length;
    if (tenant && !this.partition) return this.#fail('--capability needs --partition.');
    if (tenant) {
      const conflicting = [
        this.redirectUri?.length && '--redirect-uri',
        this.postLogoutUri?.length && '--post-logout-uri',
        this.public && '--public',
        this.native && '--native',
        this.backchannelLogoutUri && '--backchannel-logout-uri',
        this.grant?.some((g) => g !== 'client_credentials') && '--grant',
      ].filter(Boolean);
      if (conflicting.length) {
        return this.#fail(
          `${conflicting.join(', ')} cannot be used with --partition (a service tenant only uses client_credentials).`,
        );
      }
    } else if (!this.redirectUri?.length) {
      return this.#fail('--redirect-uri is required (at least one callback URI).');
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
            serviceTenant: { partition: this.partition, capabilities: this.capability ?? [] },
          }
        : {
            clientId: this.clientId,
            applicationType: 'web',
            postLogoutRedirectUris: [],
            grantTypes: ['authorization_code', 'refresh_token'],
            ...this.#clientInput({ tokenEndpointAuthMethod: 'client_secret_basic' }),
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
      return this.#print({ ...this.#dto(client), clientSecret: created.clientSecret ?? null });
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
    }
    for (const [k, v] of lines) this.logger.info(`  ${k.padEnd(14)} ${v}`);
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
    if (Object.keys(input).length === 0) {
      return this.#fail('Nothing to update: pass at least one flag (--name, --redirect-uri, …).');
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
      metadata: { actor: 'cli' },
    });
    const updated = await svc.find(id);
    if (this.json) return this.#print(this.#dto(updated));
    this.logger.success(`Client updated: ${id}`);
    this.#describe(updated);
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
    const result = await revokeClient(service, id, { actorId: cliActor(), source: 'cli' });
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
