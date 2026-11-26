/**
 * Quem pode mexer em quem dentro de uma org (remover ou trocar o papel de um
 * membro), pelas superfícies member-facing — o form `/account/orgs` e a JSON API
 * `/account/api/orgs`. O console admin (`AdminOrgsService`) não passa por aqui:
 * ele age como operador do IdP, acima de qualquer papel de org.
 *
 * A regra: só se age sobre quem está ABAIXO do próprio papel. `owner` > `admin` >
 * qualquer outro papel do catálogo. A exceção é o owner, que age sobre outro
 * owner (é o único jeito de passar a posse adiante; a trava de `last_owner` do
 * store segue valendo). Agir sobre si mesmo também passa: a pessoa só consegue
 * se rebaixar, e sair da org já é livre pelo `leave`.
 */

const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2 };

/** Posição do papel na hierarquia: `owner` 3, `admin` 2, qualquer outro 1. */
export function orgRoleRank(role: string | null | undefined): number {
  return (role && ROLE_RANK[role]) || 1;
}

export type OrgMemberActionCheck = { ok: true } | { ok: false; message: string };

/**
 * Decide se `actor` pode remover `target` ou trocar o papel dele. Devolve a
 * mensagem do 403 quando não pode — a mesma nas duas superfícies.
 */
export function checkOrgMemberAction(
  actor: { accountId: string; role: string },
  target: { accountId: string; role: string },
): OrgMemberActionCheck {
  if (actor.accountId === target.accountId) return { ok: true };
  const actorRank = orgRoleRank(actor.role);
  const targetRank = orgRoleRank(target.role);
  if (actor.role === 'owner' || targetRank < actorRank) return { ok: true };
  if (target.role === 'owner') {
    return { ok: false, message: 'Only an owner can remove or change the role of an owner.' };
  }
  return {
    ok: false,
    message: `Your role (${actor.role}) cannot remove or change the role of a member whose role (${target.role}) is the same or higher. Ask an owner.`,
  };
}
