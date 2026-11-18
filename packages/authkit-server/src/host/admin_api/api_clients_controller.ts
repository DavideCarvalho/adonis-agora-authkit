import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import vine from '@vinejs/vine';
import { CAPABILITY_PATTERN, MAX_CAPABILITIES } from '../../service_tenants/client_metadata.js';
import { AdminClientsService, type CreatedClient } from '../admin_clients_service.js';
import {
  clientCreateInput,
  clientInputValidator,
  clientPartialInput,
} from '../admin_validators.js';
import { ClientMetadataError } from '../client_metadata.js';
import { revokeClient } from '../client_revocation.js';
import { listClientsPage, withListQuery } from '../list_api.js';
import { apiError, clientDto, createdClientDto } from './dto.js';

/** Resolve o serviço (== OidcService) + o AdminClientsService. */
async function clientsService(ctx: HttpContext) {
  const service = await ctx.containerResolver.make('authkit.server');
  return { service, svc: new AdminClientsService(service) };
}

/**
 * Metadata incoerente com o tipo de client (ex.: nativo com secret, redirect
 * `myapp://` num client web) — 422, igual a um input que falha no Vine.
 */
function invalidMetadata(ctx: HttpContext, err: ClientMetadataError) {
  return ctx.response.unprocessableEntity(apiError('invalid_client_metadata', err.message));
}

/** `PUT /clients/:id/apps/:app` body. */
const appGrantValidator = vine.compile(
  vine.object({
    capabilities: vine
      .array(vine.string().trim().regex(CAPABILITY_PATTERN))
      .maxLength(MAX_CAPABILITIES)
      .optional(),
  }),
);

/**
 * Recurso de clients OIDC da Admin REST API (R6). Reaproveita o
 * {@link AdminClientsService} (mesmo que o console B6). O secret é retornado UMA vez
 * em create/regenerate. Audita create/update/delete.
 */
export default class ApiClientsController {
  /**
   * GET /clients — `?search=&sort=clientId|clientName&page=&size=` →
   * `{ data, meta: { total, perPage, currentPage, lastPage, firstPage }, canList }`.
   */
  async index(ctx: HttpContext) {
    const { svc } = await clientsService(ctx);
    return withListQuery(ctx, async () => {
      const page = await listClientsPage(svc.canList ? await svc.list() : [], ctx.request.qs());
      return { ...page, data: page.data.map(clientDto), canList: svc.canList };
    });
  }

  async show(ctx: HttpContext) {
    const { svc } = await clientsService(ctx);
    const client = await svc.find(ctx.request.param('id'));
    if (!client) return ctx.response.notFound(apiError('not_found', 'Client não encontrado.'));
    return clientDto(client);
  }

  async store(ctx: HttpContext) {
    const { service, svc } = await clientsService(ctx);
    const input = clientCreateInput(await ctx.request.validateUsing(clientInputValidator));
    let created: CreatedClient;
    try {
      created = await svc.create(input);
    } catch (err) {
      if (err instanceof ClientMetadataError) return invalidMetadata(ctx, err);
      throw err;
    }
    await service.config.audit?.record({
      type: 'client.created',
      clientId: created.clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { actor: 'admin-api' },
    });
    ctx.response.status(201);
    return createdClientDto(created);
  }

  async update(ctx: HttpContext) {
    const { service, svc } = await clientsService(ctx);
    const id = ctx.request.param('id');
    const existing = await svc.find(id);
    if (!existing) return ctx.response.notFound(apiError('not_found', 'Client não encontrado.'));
    try {
      await svc.update(
        id,
        clientPartialInput(await ctx.request.validateUsing(clientInputValidator)),
      );
    } catch (err) {
      if (err instanceof ClientMetadataError) return invalidMetadata(ctx, err);
      throw err;
    }
    await service.config.audit?.record({
      type: 'client.updated',
      clientId: id,
      ip: ctx.request.ip?.() ?? null,
      metadata: { actor: 'admin-api' },
    });
    const updated = await svc.find(id);
    return clientDto(updated!);
  }

  async regenerateSecret(ctx: HttpContext) {
    const { service, svc } = await clientsService(ctx);
    const id = ctx.request.param('id');
    try {
      const secret = await svc.regenerateSecret(id);
      const tenant = (await svc.find(id))?.serviceTenant;
      await service.config.audit?.record({
        type: 'client.updated',
        clientId: id,
        ip: ctx.request.ip?.() ?? null,
        metadata: {
          actor: 'admin-api',
          action: 'regenerate_secret',
          ...(tenant ? { partition: tenant.partition } : {}),
        },
      });
      return { clientId: id, clientSecret: secret };
    } catch (e) {
      return ctx.response.conflict(apiError('cannot_regenerate', (e as Error).message));
    }
  }

  /**
   * PUT /clients/:id/apps/:app — `{ capabilities?: string[] }`: the service tenant may call
   * that app (tokens for `urn:agora:app:<app>`). DELETE takes the grant away.
   */
  async grantApp(ctx: HttpContext) {
    const { capabilities } = await ctx.request.validateUsing(appGrantValidator);
    return this.#setAppGrant(ctx, capabilities ?? []);
  }

  async revokeApp(ctx: HttpContext) {
    return this.#setAppGrant(ctx, null);
  }

  async #setAppGrant(ctx: HttpContext, capabilities: string[] | null) {
    const { service, svc } = await clientsService(ctx);
    const id = ctx.request.param('id');
    const app = ctx.request.param('app');
    let client: Awaited<ReturnType<typeof svc.find>>;
    try {
      client = await svc.setAppGrant(id, app, capabilities);
    } catch (err) {
      if (err instanceof ClientMetadataError) return invalidMetadata(ctx, err);
      throw err;
    }
    if (!client) return ctx.response.notFound(apiError('not_found', 'Client não encontrado.'));
    await service.config.audit?.record({
      type: 'client.updated',
      clientId: id,
      ip: ctx.request.ip?.() ?? null,
      metadata: {
        actor: 'admin-api',
        action: capabilities === null ? 'revoke_app' : 'grant_app',
        app,
        ...(client.serviceTenant ? { partition: client.serviceTenant.partition } : {}),
      },
    });
    return clientDto(client);
  }

  async disable(ctx: HttpContext) {
    return this.#setDisabled(ctx, true);
  }

  async enable(ctx: HttpContext) {
    return this.#setDisabled(ctx, false);
  }

  /** Disabled clients get `invalid_client` from the next request on. */
  async #setDisabled(ctx: HttpContext, disabled: boolean) {
    const { service, svc } = await clientsService(ctx);
    const id = ctx.request.param('id');
    if (!(await svc.setDisabled(id, disabled))) {
      return ctx.response.notFound(apiError('not_found', 'Client não encontrado.'));
    }
    const client = await svc.find(id);
    await service.config.audit?.record({
      type: disabled ? 'client.disabled' : 'client.enabled',
      clientId: id,
      ip: ctx.request.ip?.() ?? null,
      metadata: {
        actor: 'admin-api',
        ...(client?.serviceTenant ? { partition: client.serviceTenant.partition } : {}),
      },
    });
    return clientDto(client!);
  }

  /**
   * POST /clients/:id/revoke — disables the client and cuts its grants and tokens in every
   * account (the console's and the CLI's `revoke`). Works for a Client ID Metadata Document
   * client too (no stored record: `stored: false`). Audited by `revokeClient`.
   */
  async revoke(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    return revokeClient(service, ctx.request.param('id') as string, {
      actorId: null,
      source: 'admin-api',
      ip: ctx.request.ip?.() ?? null,
    });
  }

  async destroy(ctx: HttpContext) {
    const { service, svc } = await clientsService(ctx);
    const id = ctx.request.param('id');
    await svc.delete(id);
    await service.config.audit?.record({
      type: 'client.deleted',
      clientId: id,
      ip: ctx.request.ip?.() ?? null,
      metadata: { actor: 'admin-api' },
    });
    return { clientId: id, deleted: true };
  }
}
