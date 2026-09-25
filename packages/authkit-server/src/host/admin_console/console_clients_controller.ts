import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { apiError, clientDto, createdClientDto } from '../admin_api/dto.js';
import { AdminClientsService, type CreatedClient } from '../admin_clients_service.js';
import {
  clientCreateInput,
  clientInputValidator,
  clientPartialInput,
} from '../admin_validators.js';
import { ClientMetadataError } from '../client_metadata.js';

/**
 * Metadata incoerente com o tipo de client (ex.: nativo com secret, redirect
 * `myapp://` num client web) — 422, igual a um input que falha no Vine.
 */
function invalidMetadata(ctx: HttpContext, err: ClientMetadataError) {
  return ctx.response.unprocessableEntity(apiError('invalid_client_metadata', err.message));
}

/**
 * Endpoints JSON de clients OIDC do console admin React.
 *
 * GET    {prefix}/api/clients                 → lista clients dinâmicos
 * POST   {prefix}/api/clients                 → criar client (secret retornado UMA vez)
 * PATCH  {prefix}/api/clients/:id             → atualizar metadata
 * DELETE {prefix}/api/clients/:id             → remover client
 * POST   {prefix}/api/clients/:id/regenerate-secret → gerar novo secret
 */
export default class ConsoleClientsController {
  /** GET {prefix}/api/clients */
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const svc = new AdminClientsService(service);
    if (!svc.canList) {
      return { data: [], canList: false };
    }
    const clients = await svc.list();
    return { data: clients.map(clientDto), canList: true };
  }

  /** POST {prefix}/api/clients */
  async store(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const svc = new AdminClientsService(service);
    const input = clientCreateInput(await ctx.request.validateUsing(clientInputValidator));
    let created: CreatedClient;
    try {
      created = await svc.create(input);
    } catch (err) {
      if (err instanceof ClientMetadataError) return invalidMetadata(ctx, err);
      throw err;
    }

    await cfg.audit?.record({
      type: 'client.created',
      clientId: created.clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { actor: 'admin-console' },
    });

    ctx.response.status(201);
    return createdClientDto(created);
  }

  /** PATCH {prefix}/api/clients/:id */
  async update(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const svc = new AdminClientsService(service);
    const id = ctx.request.param('id') as string;

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

    await cfg.audit?.record({
      type: 'client.updated',
      clientId: id,
      ip: ctx.request.ip?.() ?? null,
      metadata: { actor: 'admin-console' },
    });

    const updated = await svc.find(id);
    return clientDto(updated!);
  }

  /** DELETE {prefix}/api/clients/:id */
  async destroy(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const svc = new AdminClientsService(service);
    const id = ctx.request.param('id') as string;

    const existing = await svc.find(id);
    if (!existing) return ctx.response.notFound(apiError('not_found', 'Client não encontrado.'));

    await svc.delete(id);

    await cfg.audit?.record({
      type: 'client.deleted',
      clientId: id,
      ip: ctx.request.ip?.() ?? null,
      metadata: { actor: 'admin-console' },
    });

    return { ok: true, deleted: id };
  }

  /** POST {prefix}/api/clients/:id/regenerate-secret */
  async regenerateSecret(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const svc = new AdminClientsService(service);
    const id = ctx.request.param('id') as string;

    const existing = await svc.find(id);
    if (!existing) return ctx.response.notFound(apiError('not_found', 'Client não encontrado.'));

    let newSecret: string;
    try {
      newSecret = await svc.regenerateSecret(id);
    } catch (err: any) {
      return ctx.response
        .status(409)
        .send(
          apiError(
            'not_applicable',
            err.message ?? 'Cannot regenerate secret for a public client.',
          ),
        );
    }

    await cfg.audit?.record({
      type: 'client.secret_regenerated',
      clientId: id,
      ip: ctx.request.ip?.() ?? null,
      metadata: { actor: 'admin-console' },
    });

    return { clientId: id, clientSecret: newSecret };
  }
}
