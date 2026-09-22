import { getBootedApp } from '../../services/booted_app.js';
import type { OidcService } from '../provider/oidc_service.js';
import { AdminSessionsService, type RevokeResult } from './admin_sessions_service.js';

/**
 * Derruba os grants (e os tokens deles) que carregam a org `orgId` — de uma conta
 * (membro removido / saiu da org) ou de todas (org apagada, `accountId` omitido).
 *
 * Chamado DEPOIS que o store confirmou a remoção. Os quatro caminhos que removem
 * membro (form `/account/orgs`, `/account/api/orgs`, console admin, Admin API) e o
 * `deleteOrg` passam por aqui, para que a regra seja uma só.
 *
 * Best-effort, e nunca silencioso: a membership JÁ saiu do store, então falhar a
 * request aqui só mentiria para quem removeu ("deu erro", mas o membro saiu). A
 * conferência da emissão (`verifyActiveOrgMembership`) continua sendo a rede de
 * segurança — no pior caso, o claim cai no próximo refresh. A falha é logada em
 * `error`, porque uma revogação que não aconteceu precisa aparecer.
 *
 * `service` sem `config.AdapterClass` (um ctx de teste que só carrega a config)
 * não tem adapter OIDC onde revogar: devolve `null` sem tentar.
 */
export async function revokeOrgAccess(
  service: Pick<OidcService, 'config'> | undefined,
  orgId: string,
  accountId?: string,
): Promise<RevokeResult | null> {
  if (!service?.config?.AdapterClass) return null;
  try {
    return await new AdminSessionsService(service as OidcService).revokeOrgGrants(orgId, accountId);
  } catch (error) {
    await logFailure(error, orgId, accountId);
    return null;
  }
}

async function logFailure(error: unknown, orgId: string, accountId?: string): Promise<void> {
  const msg =
    'authkit: falha ao revogar os grants da org — o claim de org cai só no próximo refresh';
  try {
    const logger = await getBootedApp().container.make('logger');
    (logger as any).error({ err: error, orgId, accountId }, msg);
  } catch {
    // eslint-disable-next-line no-console
    console.error(msg, { orgId, accountId, error });
  }
}
