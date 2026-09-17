---
'@adonis-agora/authkit-server': minor
---

Organizations passa a existir por padrão: a `OrganizationsCapability` não some mais em silêncio quando o host esquece `organizationModels`.

O `lucidAccountStore(Model, options)` só anexava a capability quando `options.organizationModels` era `true` ou o trio explícito:

```ts
...(OrgModels ? buildOrganizations({...}) : {})
```

Consequência: um host que já tinha dito `organizations: { enabled: true }` — e cujas rotas `/account/orgs*` **já eram montadas por default** (`register_auth_host`, bloco `if (mountOrgs)`, controller capability-probed) — recebia a tela respondendo 403 em vez de funcionar, sem nenhum erro de boot. O `authkit:doctor` avisava, mas só para quem o rodasse.

Agora `organizationModels` é **opcional**:

- **Ausente (novo default)** → usa os models default da lib (`defaultOrganizationModels`, as três tabelas lib-owned criadas pelo `ensureAuthkitSchema`). A capability existe; a mesma tela que já estava montada passa a funcionar.
- `true` → idêntico ao default. É o atalho explícito que apps existentes já usam e continua valendo.
- `{ OrgModel, MemberModel, InvitationModel }` → escape hatch inalterado, para quem guarda as tabelas de auth numa conexão/schema próprios.
- **`false` (novo opt-out explícito)** → capability ausente. Preserva o comportamento antigo para quem hoje depende de `supportsOrganizations === false`.

**Como migrar:** se você dependia da ausência da capability sem declarar nada, passe `organizationModels: false`. Se quer conexão/schema próprios, continue passando o trio. Caso contrário, nada a fazer — a feature que você já habilitava agora funciona.

O `authkit:doctor` (`checkOrganizations`) acompanha: o `warn` de "enabled=true sem capability" passa a ser inalcançável no caminho default e menciona o `false`; a mensagem de `ok` diz de onde vêm os models (default da lib ou trio explícito). O `lucidStores` também aceita `organizations: false` para o mesmo opt-out.

Cobertura em `tests/organizations/organizations_store.spec.ts`: `lucidAccountStore(Model)` sem options liga a capability e roda CRUD de ponta a ponta; `organizationModels: false` desliga mesmo com as tabelas presentes; `true` e o trio explícito seguem iguais; e o `lucidStores` cobre default + opt-out. O teste "sem tabelas org → supportsOrganizations false" foi removido porque a premissa dele era exatamente o contrato que deixou de valer.
