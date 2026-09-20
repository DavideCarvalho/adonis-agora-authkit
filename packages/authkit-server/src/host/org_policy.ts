/**
 * Política EFETIVA de organizações — ponto de verdade ÚNICO das duas
 * superfícies member-facing.
 *
 * O console HTML (`AccountOrgsController`) e o espelho JSON
 * (`AccountOrgsApiController`) precisam responder à MESMA pergunta — "este
 * usuário pode criar org? que papéis existem? quanto tempo o convite vale?" —
 * e a resposta não está no config estático: ela é resolvida na ordem setting da
 * org → setting global → `config.organizations` → default da lib.
 *
 * Mora num módulo próprio, e não dentro de um dos controllers, porque duas
 * cópias desta resolução são exatamente como o caminho JSON acaba mais frouxo
 * (ou mais apertado) que o formulário que ele espelha — o bug que este pacote
 * de mudanças existe para não ter.
 */

import './augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { resolveRuntimeSettings } from './runtime_settings.js';
import {
  type OrganizationsPolicyConfigDefaults,
  type ResolvedOrganizationsPolicySetting,
  resolveEffectiveOrganizationsPolicy,
} from './runtime_toggles.js';

/** Defaults estáticos da política de org (config do host) — o fallback da setting. */
export function orgPolicyDefaults(cfg: any): OrganizationsPolicyConfigDefaults {
  return {
    roles: cfg.organizations.roles,
    allowSelfCreate: cfg.organizations.allowSelfCreate,
    invitationTtlHours: cfg.organizations.invitationTtlHours,
  };
}

/**
 * Política efetiva para o `orgId` (ou global, quando ausente). `settings` nulo —
 * DB fora do ar, app sem lucid — cai no config estático, fail-safe herdado de
 * {@link resolveEffectiveOrganizationsPolicy}.
 */
export async function effectiveOrgPolicy(
  ctx: HttpContext,
  cfg: any,
  orgId?: string | null,
): Promise<ResolvedOrganizationsPolicySetting> {
  const settings = await resolveRuntimeSettings(ctx);
  return resolveEffectiveOrganizationsPolicy(settings, orgPolicyDefaults(cfg), orgId);
}
