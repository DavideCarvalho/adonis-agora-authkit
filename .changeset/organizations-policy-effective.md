---
'@adonis-agora/authkit-server': patch
---

fix(authkit-server): política de organizations (`allowSelfCreate`, `roles`, `invitationTtlHours`) volta a valer

Desde a remoção da config de política legada, `resolveOrganizations` fixava
`allowSelfCreate: false` (e roles/TTL no default), e o `AccountOrgsController` lia só
esse valor estático — nunca a setting `organizations_policy` que a doc manda usar. Pior:
declarar `organizations` no `defineConfig` **trava** a setting, então um host com
`organizations: { enabled: true }` não tinha jeito nenhum de ligar o self-create
(`POST /account/orgs` → 403).

- `OrganizationsConfigInput` aceita de novo `allowSelfCreate`, `roles` e
  `invitationTtlHours` — com a setting travada, eles são a política efetiva.
- `/account/orgs` (tela, criação e convites) e o TTL dos convites do admin/Admin API
  resolvem a política **efetiva**: setting da org → setting global → config → default.
