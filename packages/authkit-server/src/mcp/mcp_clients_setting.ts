/**
 * Escrita da setting de runtime `mcp_clients` — o liga/desliga do login de clientes MCP. Um só
 * caminho para o console admin, a Admin API e `node ace authkit:settings:set`: mesma validação,
 * mesma trava de config (`mcpClients: false` → {@link SettingLockedError}) e o mesmo evento de
 * auditoria `mcp_clients.updated` (quem, de → para).
 */
import type { AuditSink } from '../audit/audit_sink.js';
import { isSettingLocked, SettingLockedError } from '../host/config_locks.js';
import type { SettingsCapability } from '../host/runtime_settings.js';
import {
  MCP_CLIENTS_SETTING_KEY,
  normalizeMcpClientsSetting,
  noteMcpClientsSetting,
  type ResolvedMcpClientsSetting,
  validateMcpClientsSetting,
} from './mcp_clients.js';

/** Valor recusado pela validação (400). */
export class McpClientsSettingError extends Error {
  readonly code = 'invalid_setting';
  constructor(message: string) {
    super(message);
    this.name = 'McpClientsSettingError';
  }
}

export interface McpClientsSettingWrite {
  /** Quem mudou: o id da conta do admin, `cli`, ou `null` (Admin API). */
  actorId: string | null;
  source: 'admin-console' | 'admin-api' | 'cli';
  ip?: string | null;
  audit?: AuditSink;
}

export interface McpClientsSettingChange {
  from: ResolvedMcpClientsSetting;
  to: ResolvedMcpClientsSetting;
}

/**
 * Grava (`value`) ou apaga (`null`, volta ao default `'auto'`) a setting. Lança
 * {@link McpClientsSettingError} (shape) ou {@link SettingLockedError} (`mcpClients: false`).
 * Vale no próximo request: o `/reg` e os documentos leem a setting por request.
 */
export async function writeMcpClientsSetting(
  settings: SettingsCapability,
  value: unknown | null,
  options: McpClientsSettingWrite,
): Promise<McpClientsSettingChange> {
  if (isSettingLocked(MCP_CLIENTS_SETTING_KEY)) {
    throw new SettingLockedError(MCP_CLIENTS_SETTING_KEY);
  }
  if (value !== null) {
    const error = validateMcpClientsSetting(value);
    if (error) throw new McpClientsSettingError(error);
  }
  const from = normalizeMcpClientsSetting(await settings.getSetting(MCP_CLIENTS_SETTING_KEY));
  if (value === null) await settings.deleteSetting(MCP_CLIENTS_SETTING_KEY);
  else await settings.setSetting(MCP_CLIENTS_SETTING_KEY, value, options.actorId);
  const to = normalizeMcpClientsSetting(value);
  noteMcpClientsSetting(to);
  await options.audit?.record({
    type: 'mcp_clients.updated',
    actorId: options.actorId,
    ip: options.ip ?? null,
    metadata: { from, to, source: options.source },
  });
  return { from, to };
}
