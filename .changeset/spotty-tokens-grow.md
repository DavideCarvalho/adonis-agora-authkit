---
"@adonis-agora/authkit-server": patch
---

token-exchange: gate do ator passa a resolver roles via `resolveTokenRoles` e aceitar allowlist `adminRoles`

O gate de impersonation (RFC 8693) checava `actor.globalRoles.includes('ADMIN')` —
a coluna `globalRoles` do authkit — ignorando o `resolveTokenRoles` que o resto
da lib usa (o console admin via `resolveAccountRoles`, e o claim `roles` na
mintagem). Para um host que gerencia papéis num store próprio (ex.:
`@adonis-agora/authz`), `globalRoles` fica vazio e **nenhum admin conseguia
personificar** (sempre `invalid_grant` 400).

Mudanças:

- **Ator**: as roles do admin são resolvidas pela mesma fonte do claim — o hook
  `resolveTokenRoles` quando configurado, senão `globalRoles` (comportamento
  histórico preservado).
- **Allowlist**: nova dep `adminRoles` (default `['ADMIN']`). A checagem passa a
  ser "alguma role do ator ∈ allowlist". O `oidc_service` já injeta
  `config.admin.roles` — hosts com papel próprio (ex.: `admin` minúsculo) só
  precisam configurar `admin: { roles: ['admin'] }`. `adminRole` singular segue
  aceito como alias de back-compat.
