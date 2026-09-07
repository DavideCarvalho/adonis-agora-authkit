---
'@adonis-agora/authkit-server': patch
---

Completa o fix do `AuthUser` scaffoldado (ver changeset anterior, "auth-user-stub-id-fullname"): mesmo com o stub do model corrigido, um host seguindo o getting-started ao pé da letra ainda batia em `SqliteError: no such table: auth_users` (ou o equivalente Postgres) no primeiro signup/login, porque `node ace configure` nunca publicava uma migration para essa tabela — só o model.

- `node ace configure @adonis-agora/authkit-server` agora também scaffolda `database/migrations/<timestamp>_create_auth_users_table.ts`, com exatamente as colunas que `models/auth_user.stub` e os mixins `withAuthUser`/`withCredentials` esperam (`id` string não auto-increment, `email` único, `password`, `global_roles`, as quatro colunas de `withCredentials`, `full_name`).
- Corrigido um segundo bug, descoberto pelo novo teste e2e desta mudança: o stub do model tinha o hook `@beforeCreate` que atribui o `randomUUID()`, mas faltava `static selfAssignPrimaryKey = true` — sem essa flag o Lucid sobrescrevia silenciosamente o id atribuído pelo hook com o retorno bruto do INSERT (o rowid interno do SQLite) assim que a linha era salva, reproduzindo exatamente a mesma falha ("conta inalcançável pelo id real na request seguinte") que o hook deveria ter resolvido.
- `docs/starter.mdx` e `docs/account-store.mdx` agora mostram a migration completa lado a lado com o model, e o texto do model foi atualizado com a flag `selfAssignPrimaryKey`.
- Novos testes: `tests/configure.spec.ts` passa a asserir o conteúdo da migration scaffoldada (e o `selfAssignPrimaryKey` no model), e `tests/e2e/scaffolded_auth_users_migration.spec.ts` roda a migration real contra um SQLite em memória e exercita signup → login, reset de senha e verificação de e-mail de ponta a ponta pelo `lucidAccountStore`.
