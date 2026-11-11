/**
 * O {@link PoppyService} do app — o runtime que o authkit montou para a extension `poppy`
 * (`personalAgents.extensions`).
 */
import { personalAgentExtensionRuntime } from '@adonis-agora/authkit-server';
import type { HttpContext } from '@adonisjs/core/http';
import type { PoppyService } from './service.js';

/** Id do protocolo no authkit (`auth_agent_registry.protocol`, `protocol` da API, auditoria). */
export const POPPY_PROTOCOL_ID = 'poppy';

/** O Poppy da request; `null` quando o app não ligou a extension (ou não há banco). */
export function poppyFor(ctx: HttpContext): Promise<PoppyService | null> {
  return personalAgentExtensionRuntime<PoppyService>(POPPY_PROTOCOL_ID, ctx);
}

/** O Poppy do app bootado (fora de uma request). */
export function poppyFromApp(): Promise<PoppyService | null> {
  return personalAgentExtensionRuntime<PoppyService>(POPPY_PROTOCOL_ID);
}
