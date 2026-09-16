---
'@adonis-agora/authkit-server': minor
---

Garante a coluna `login_methods` na tabela da **conta** em vez de assumir `users`, e faz o boot avisar quando não deu para garantir.

O `ensureAuthkitSchema` adicionava a coluna numa tabela de nome fixo `users`. Como o nome da tabela da conta é decisão do host, isso errava nos dois sentidos: com a conta em `auth_users` (o nome que o próprio scaffold da lib usa) e uma tabela `users` qualquer no banco — o starter do AdonisJS cria uma — o `ALTER` acertava a tabela errada e **passava**; sem nenhuma `users`, nada acontecia. Nos dois casos a `LoginMethodsPreferenceCapability` ficava sem a coluna, sem erro e sem aviso.

Agora o `lucidAccountStore` expõe `accountTable` (de `Model.table` e, se o model ainda não bootou, da naming strategy — a mesma função que o Lucid usa), o provider repassa em `EnsureSchemaOptions.accountTable`, e o `ensure` usa esse nome. Store próprio que não exponha o metadado continua no `users` de antes, então nada muda para quem já estava certo.

O `EnsureSchemaReport` passa a trazer `loginMethods: { table, ensured }`: quando a tabela da conta não existe, o provider loga um warning — antes o sintoma só aparecia longe da causa, como login/callback OIDC quebrado por "column ...login_methods does not exist".

Cobertura em `tests/schema/ensure_schema.spec.ts`: o caso da tabela homônima (a coluna vai para `auth_users` e **não** para `users`), o back-compat sem `accountTable`, o `ensured: false` e a derivação do nome pelo store. Reverter só o `ensure.ts` derruba três desses casos.