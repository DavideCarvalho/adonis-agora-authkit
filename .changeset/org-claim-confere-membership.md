---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-sdk': patch
---

O claim de organização passa a refletir a membership atual, e remover um membro revoga o acesso na hora

O `org_id`/`org_slug`/`org_role` do token vinha do `activeOrg` gravado no `Grant` no
consent, e o refresh o reemitia **sem perguntar se a conta ainda era membro** da org,
nem se a org ainda existia. Com refresh token de 30 dias, quem era removido da equipe
seguia recebendo token com o claim da org por até um mês — e um rebaixado seguia com
o papel antigo.

- **Emissão/refresh:** antes de emitir `org_*`, a lib confere no account store que a
  conta ainda é membro da org (`getOrgMembership`) e que a org existe (`findOrgById`).
  Se não for, o token sai **sem** claims de org. `org_role` é sempre o papel **atual**
  da membership e `org_slug` o slug atual — nunca o retrato do consent. O
  `resolveTokenRoles` recebe o `activeOrg` já conferido.
- **Remoção:** sair da org, remover um membro (form `/account/orgs`, `/account/api/orgs`,
  console admin e Admin API) ou apagar a org revoga os grants que carregam aquela org
  para aquela conta (ou para todas, no `deleteOrg`), com os access/refresh tokens deles,
  e grava a revogação por `sub` para clients cookie-based. Grants de outras orgs e sem
  org ficam intactos. Novo método `AdminSessionsService.revokeOrgGrants(orgId, accountId?)`.
  O driver embedded do `@adonis-agora/authkit-sdk` (`organizations.delete`,
  `organizations.members.remove`) revoga do mesmo jeito.

Mudança de comportamento: um store sem `findOrgById`/`getOrgMembership` não tem como
conferir a membership, então deixa de emitir `org_*` (antes emitia o que viesse do
cookie/grant). As rotas que gravam o cookie de org só existem com a capacidade.
