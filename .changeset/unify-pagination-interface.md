---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-react': minor
'@adonis-agora/authkit-sdk': minor
---

**BREAKING (0.x minor):** todas as listagens paginadas do authkit passam a usar `{ page, size }` no lugar de `{ page, limit }` (e de `perPage`, na API do console), alinhando a interface de paginação com `@adonis-agora/filter` e com o restante do ecossistema `@adonis-agora/*`. `page` continua **1-based** com default `1`; `limit` foi apenas **renomeado** para `size` — a semântica (itens por página) não mudou. O casamento com `@adonis-agora/filter` é **estrutural** de propósito: nenhum pacote passa a depender dele.

Junto vem um **teto de `size`** que antes não existia de forma unificada: toda borda HTTP (Admin REST API e API JSON do console) agora corta `size` em `ADMIN_LIST_MAX_SIZE` (200), e as varreduras internas usam `ADMIN_LIST_DEFAULT_SIZE` (100) em vez de um `100` hardcoded por serviço.

### O que mudou

- **Wire HTTP** — `GET {adminApi}/users`, `GET {adminApi}/audit`, `GET {consolePrefix}/api/users` e `GET {consolePrefix}/api/audit` leem `?page=&size=` (antes `?page=&limit=`; o de usuários do console lia `?perPage=`). A resposta também troca `limit`/`perPage` por `size` no envelope `{ data, total, page, size }`.
- **Tipos do servidor** — `ListAccountsParams.limit` → `.size` e `ListAuditParams.limit` → `.size`. Stores de conta e sinks de auditoria customizados precisam ler o novo campo.
- **SDK** (`@adonis-agora/authkit-sdk`) — `ListUsersParams`, `ListUsersResult`, `ListAuditParams` e `ListAuditResult` passam a usar `size`, nos dois drivers (remoto e embedded).
- **React** (`@adonis-agora/authkit-react`) — `client.admin.users.list()`, `client.admin.audit.list()`, `useUsersQueryOptions()`, `useAuditQueryOptions()` e as query keys `authkitKeys.admin.users/audit` passam a usar `size`. Efeito colateral: o console admin enviava `limit=` para um endpoint que lia `perPage`, então o tamanho de página pedido pela UI era silenciosamente ignorado — agora vale.
- **Novas constantes exportadas** — `LIST_FIRST_PAGE`, `ADMIN_LIST_DEFAULT_SIZE` (100), `ADMIN_LIST_HTTP_DEFAULT_SIZE` (20), `ADMIN_LIST_MAX_SIZE` (200), mais os helpers `resolveListPage`, `normalizeListSize`, `clampListSize`, `parseListPage` e `parseListSize` (o SDK reexporta as três primeiras constantes com os mesmos nomes).

### Migração

```diff
  // HTTP
- GET /api/authkit/v1/users?page=2&limit=50
+ GET /api/authkit/v1/users?page=2&size=50

  // SDK
- const { data, total, page, limit } = await authkit.users.list({ page: 2, limit: 50 })
+ const { data, total, page, size } = await authkit.users.list({ page: 2, size: 50 })

  // React
- useUsersQueryOptions({ search, page, limit: 20 })
+ useUsersQueryOptions({ search, page, size: 20 })

  // AccountStore / AuditSink customizados
- async listAccounts({ search, page = 1, limit = 20 }: ListAccountsParams) {
-   return { data: rows.slice((page - 1) * limit, page * limit), total }
+ async listAccounts({ search, page = 1, size = 20 }: ListAccountsParams) {
+   return { data: rows.slice((page - 1) * size, page * size), total }
  }
```

Callers que pediam `limit > 200` via HTTP passam a receber 200 itens por página — pagine com `page` para cobrir o resto.
