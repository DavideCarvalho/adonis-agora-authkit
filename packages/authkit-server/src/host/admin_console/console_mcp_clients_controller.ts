import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { McpClientsSettingError, writeMcpClientsSetting } from '../../mcp/mcp_clients_setting.js';
import { buildMcpClientsStatus } from '../../mcp/mcp_clients_status.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { apiError } from '../admin_api/dto.js';
import { SettingLockedError } from '../config_locks.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { requireSudo } from '../sudo_mode.js';

/** Sudo (M9) das ações sensíveis do console (login de clientes MCP, revogar client) — o 403 JSON das chaves. */
export async function gateConsoleSudo(ctx: HttpContext): Promise<unknown | null> {
  const settings = await resolveRuntimeSettings(ctx);
  const result = await requireSudo(ctx, settings);
  if (result === true) return null;
  return ctx.response
    .status(403)
    .send(apiError('sudo_required', 'Identity confirmation required.'));
}

/**
 * Grava (`value`) ou apaga (`null`) a setting `mcp_clients` pelo console: sudo, trava de config
 * (423), validação (400) e o evento `mcp_clients.updated` com o admin como ator. Devolve `null`
 * quando gravou; senão a resposta de erro já enviada.
 */
export async function writeMcpClientsFromConsole(
  ctx: HttpContext,
  value: unknown | null,
): Promise<unknown | null> {
  const denied = await gateConsoleSudo(ctx);
  if (denied) return denied;
  const settings = await resolveRuntimeSettings(ctx);
  if (!settings || !(await settings.isTablePresent())) {
    return ctx.response.notFound(
      apiError(
        'capability_unsupported',
        'Runtime settings não é suportado nesta instalação (tabela auth_settings ausente).',
      ),
    );
  }
  const service = await ctx.containerResolver.make('authkit.server');
  try {
    await writeMcpClientsSetting(settings, value, {
      actorId: (ctx.session?.get(ACCOUNT_SESSION_KEY) as string | undefined) ?? null,
      source: 'admin-console',
      ip: ctx.request.ip?.() ?? null,
      audit: service.config.audit,
    });
  } catch (error) {
    if (error instanceof SettingLockedError) {
      return ctx.response
        .status(423)
        .send(apiError('setting_locked', error.message, { key: error.key, lockedBy: 'config' }));
    }
    if (error instanceof McpClientsSettingError) {
      return ctx.response.badRequest(apiError('invalid_setting', error.message));
    }
    throw error;
  }
  return null;
}

/**
 * Card "Login de clientes MCP" do console admin.
 *
 * GET {prefix}/api/mcp-clients → estado vivo (ligado/desligado e por quê, resources, contagens)
 * PUT {prefix}/api/mcp-clients → body `{ enabled: 'auto' | false, dynamicRegistration?, metadataDocuments? }`
 *                                (sudo; 423 com `mcpClients: false` na config)
 */
export default class ConsoleMcpClientsController {
  async show(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    return buildMcpClientsStatus(service);
  }

  async update(ctx: HttpContext) {
    const body = ctx.request.body() as Record<string, unknown>;
    const failed = await writeMcpClientsFromConsole(ctx, body);
    if (failed) return failed;
    const service = await ctx.containerResolver.make('authkit.server');
    return buildMcpClientsStatus(service);
  }
}
