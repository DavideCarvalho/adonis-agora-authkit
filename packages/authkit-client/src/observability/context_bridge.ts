import { deriveOrgId } from '@adonis-agora/authkit-core';
import type { Identity } from '@adonis-agora/authkit-core';

/**
 * Ponte estrutural (best-effort) entre a sessão resolvida do authkit e o
 * contexto do Agora. Lê o slot global `@agora/context:set` de forma ESTRUTURAL —
 * nunca importa `@adonis-agora/context` — e degrada para no-op quando o context
 * não está instalado. Mesmo idioma da `diagnostics_bridge`.
 */
const SET_SLOT = Symbol.for('@agora/context:set');

type SetFn = (patch: {
  userRef?: { type: string; id: string };
  tenantId?: string;
  globalRoles?: string[];
  [k: string]: unknown;
}) => void;

/**
 * Deriva o tenant ativo da identidade. Prefere o `orgId` já resolvido (o caminho
 * normal — `buildIdentityFromClaims` o preenche); cai para as claims cruas
 * quando a `Identity` veio de um `SessionResolver` customizado que não o
 * populou. A tabela de claims aceitas vive em `@adonis-agora/authkit-core`
 * (`ORG_ID_CLAIMS`) para não divergir entre a identidade e esta ponte.
 */
function deriveTenant(identity: Identity): string | undefined {
  return identity.orgId ?? deriveOrgId(identity.raw) ?? undefined;
}

/**
 * Popula o contexto do Agora a partir de uma identidade recém-resolvida:
 * `userRef` ({ type: 'user', id: userId }), os `globalRoles` da identidade e,
 * quando presente nas claims, `tenantId`. Best-effort: qualquer erro é engolido
 * e nada acontece sem o slot.
 */
export function populateContext(identity: Identity): void {
  try {
    const set = (globalThis as Record<symbol, unknown>)[SET_SLOT] as SetFn | undefined;
    if (!set) return;
    const tenant = deriveTenant(identity);
    set({
      userRef: { type: 'user', id: identity.userId },
      globalRoles: identity.globalRoles,
      ...(tenant ? { tenantId: tenant } : {}),
    });
  } catch {
    // best-effort: a ponte de contexto nunca quebra o caminho da request.
  }
}
