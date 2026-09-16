---
'@adonis-agora/authkit-server': minor
---

`organizationModels: true` passa a usar models default das tabelas de organizations — sem o host precisar escrever model nenhum.

As três tabelas (`auth_organizations`, `auth_organization_members`, `auth_organization_invitations`) são **lib-owned**: quem as cria e evolui é o `ensureAuthkitSchema`. Ainda assim, para ligar a `OrganizationsCapability` cada host tinha que transcrever à mão os models que espelham essas colunas. Isso rendia duas coisas ruins: boilerplate sem nenhuma decisão do host, e drift silencioso — uma coluna nova chega pelo `autoManage` e o model escrito à mão no host não sabe dela, sem erro nenhum. Foi o que aconteceu no próprio fixture de teste deste pacote: ele criava `auth_organization_members` sem `updated_at`, que existe na tabela real.

Agora `lucidAccountStore(Model, { organizationModels: true })` usa os models default da lib (exportados como `defaultOrganizationModels`, junto de `AuthOrganization`, `AuthOrganizationMember` e `AuthOrganizationInvitation`). O caminho explícito `{ OrgModel, MemberModel, InvitationModel }` continua valendo como escape hatch — é para quem guarda as tabelas de auth numa conexão/schema próprios, que os defaults não declaram (`static connection`).

A mensagem do `authkit:doctor` para o caso "organizations.enabled: true sem capability" passa a apontar o `organizationModels: true` primeiro.

Cobertura em `tests/organizations/organizations_store.spec.ts`: `organizationModels: true` liga a capability e roda `createOrg`/`findOrgBySlug`/`getOrgMembership`/`listOrgsForAccount` de ponta a ponta contra as tabelas reais; o escape hatch explícito continua funcionando; e ficou registrado o comportamento de desenho — sem as tabelas, a capability está ligada e o erro é alto no uso (barulhento de propósito: o silêncio era o problema).

O mesmo vale no caminho do `lucidStores`, que tem tipo próprio: `organizations: true` também é aceito lá — sem isso o atalho não chegava no wiring "declarado uma vez", que é o recomendado em app maior.

A documentação foi atualizada junto (`organizations.mdx`, `account-store.mdx`): o `true` aparece como caminho recomendado, o objeto explícito fica como escape hatch, e a linha do `enabled` deixou de dizer que ele "detecta tabelas" — ele é sinal de intenção para o `authkit:doctor`, e quem monta as rotas é a capability.