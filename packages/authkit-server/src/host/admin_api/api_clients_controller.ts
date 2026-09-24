import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { AdminClientsService, type CreatedClient } from '../admin_clients_service.js';
import {
  clientCreateInput,
  clientInputValidator,
  clientPartialInput,
} from '../admin_validators.js';
import { ClientMetadataError } from '../client_metadata.js';
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

/**
 * Recurso de clients OIDC da Admin REST API (R6). Reaproveita o
 * {@link AdminClientsService} (mesmo que o console B6). O secret é retornado UMA vez
 * em create/regenerate. Audita create/update/delete.
 */
export default class ApiClientsController {
  async index(ctx: HttpContext) {
    const { svc } = await clientsService(ctx);
    if (!svc.canList) {
      return { data: [], canList: false };
    }
    const clients = await svc.list();
    return { data: clients.map(clientDto), canList: true };
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
      await service.config.audit?.record({
        type: 'client.updated',
        clientId: id,
        ip: ctx.request.ip?.() ?? null,
        metadata: { actor: 'admin-api', action: 'regenerate_secret' },
      });
      return { clientId: id, clientSecret: secret };
    } catch (e) {
      return ctx.response.conflict(apiError('cannot_regenerate', (e as Error).message));
    }
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
