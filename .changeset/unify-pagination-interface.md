---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-react': minor
'@adonis-agora/authkit-sdk': minor
---

**BREAKING (0.x minor):** todas as listagens paginadas do authkit passam a usar `{ page, size }` no lugar de `{ page, limit }` (e de `perPage`, na API do console), alinhando a interface de paginação com `@adonis-agora/filter` e com o restante do ecossistema `@adonis-agora/*`. `page` continua **1-based** com default `1`; `limit` foi apenas **renomeado** para `size` — a semântica (itens por página) não mudou. O casamento com `@adonis-agora/filter` é **estrutural** de propósito: nenhum pacote passa a depender dele.

Na **resposta**, as mesmas listagens passam a devolver o envelope `{ meta, data }` — com `page`, `size` e `total` dentro de `meta` — no lugar do antigo shape achatado `{ data, total, page, size }`. `meta` é a convenção do próprio `.paginate()` do Lucid (`{ meta, data }`), que é onde o caminho por offset de `@adonis-agora/filter` desemboca, e agora é o envelope de TODAS as listagens paginadas do ecossistema `@adonis-agora/*`.

Junto vem um **teto de `size`** que antes não existia de forma unificada: toda borda HTTP (Admin REST API e API JSON do console) agora corta `size` em `ADMIN_LIST_MAX_SIZE` (200), e as varreduras internas usam `ADMIN_LIST_DEFAULT_SIZE` (100) em vez de um `100` hardcoded por serviço.

### O que mudou

- **Wire HTTP** — `GET {adminApi}/users`, `GET {adminApi}/audit`, `GET {consolePrefix}/api/users` e `GET {consolePrefix}/api/audit` leem `?page=&size=` (antes `?page=&limit=`; o de usuários do console lia `?perPage=`) e respondem `{ meta: { page, size, total }, data }` (antes `{ data, total, page, size }` achatado). Endpoints de listagem NÃO paginados (`/clients`, `/settings`, `/organizations`, `/roles`, `/sessions`) continuam como estão — eles nunca tiveram metadados de paginação e não ganham envelope agora.
- **Tipos do servidor** — `ListAccountsParams.limit` → `.size` e `ListAuditParams.limit` → `.size`. Stores de conta e sinks de auditoria customizados precisam ler o novo campo.
- **SDK** (`@adonis-agora/authkit-sdk`) — `ListUsersParams` e `ListAuditParams` passam a usar `size`; `ListUsersResult` e `ListAuditResult` viram `{ meta: ListMeta; data: T[] }` (novo tipo `ListMeta` exportado), nos dois drivers (remoto e embedded).
- **React** (`@adonis-agora/authkit-react`) — `client.admin.users.list()`, `client.admin.audit.list()`, `useUsersQueryOptions()`, `useAuditQueryOptions()` e as query keys `authkitKeys.admin.users/audit` passam a usar `size`; `AdminUserListResult` e `AuditListResult` viram `{ meta: ListMeta; data: T[] }` (novo tipo `ListMeta` exportado). Efeito colateral: o console admin enviava `limit=` para um endpoint que lia `perPage`, então o tamanho de página pedido pela UI era silenciosamente ignorado — agora vale.
- **Novas constantes exportadas** — `LIST_FIRST_PAGE`, `ADMIN_LIST_DEFAULT_SIZE` (100), `ADMIN_LIST_HTTP_DEFAULT_SIZE` (20), `ADMIN_LIST_MAX_SIZE` (200), mais os helpers `resolveListPage`, `normalizeListSize`, `clampListSize`, `parseListPage` e `parseListSize` (o SDK reexporta as três primeiras constantes com os mesmos nomes).
- **Novos tipos exportados** — `ListMeta` (`{ page, size, total }`) e `PaginatedResponse<T>` (`{ meta, data }`) em `@adonis-agora/authkit-server`; `ListMeta` também em `@adonis-agora/authkit-sdk` e `@adonis-agora/authkit-react`.
- **Inalterado** — o contrato INTERNO dos stores continua `Paginated<T> = { data, total }`: `AccountStore.listAccounts()` e `AuditSink.list()` NÃO ganham envelope `meta` (quem monta o `meta` é a borda HTTP/SDK). Implementações customizadas de store/sink só precisam da renomeação `limit` → `size`.

### Migração

```diff
  // HTTP
- GET /api/authkit/v1/users?page=2&limit=50
+ GET /api/authkit/v1/users?page=2&size=50

  // HTTP — resposta
- { "data": [...], "total": 137, "page": 2, "size": 50 }
+ { "meta": { "page": 2, "size": 50, "total": 137 }, "data": [...] }

  // SDK
- const { data, total, page, limit } = await authkit.users.list({ page: 2, limit: 50 })
+ const { data, meta } = await authkit.users.list({ page: 2, size: 50 })
+ // meta.page / meta.size / meta.total

  // React
- useUsersQueryOptions({ search, page, limit: 20 })
+ useUsersQueryOptions({ search, page, size: 20 })
- const total = data?.total ?? 0
+ const total = data?.meta.total ?? 0

  // AccountStore / AuditSink customizados
- async listAccounts({ search, page = 1, limit = 20 }: ListAccountsParams) {
-   return { data: rows.slice((page - 1) * limit, page * limit), total }
+ async listAccounts({ search, page = 1, size = 20 }: ListAccountsParams) {
+   return { data: rows.slice((page - 1) * size, page * size), total }
  }
```

Callers que pediam `limit > 200` via HTTP passam a receber 200 itens por página — pagine com `page` para cobrir o resto.
