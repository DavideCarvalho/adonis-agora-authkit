---
'@adonis-agora/authkit-server': patch
---

O `AuthUser` publicado por `node ace configure @adonis-agora/authkit-server` (`models/auth_user.stub`) — e o modelo mínimo mostrado em getting-started/quickstart/account-store — produzia contas quebradas. Dois problemas compunham: (a) nem `withAuthUser()` nem `withCredentials()` geram o `id`, então sem um hook `@beforeCreate` o Lucid insere `NULL` na coluna string `id` e a conta volta com o rowid interno do banco em vez de um id real, tornando-a inalcançável na request seguinte; (b) a tela de signup embutida sempre coleta um campo "Nome" que o Lucid store passa direto para `AuthUser.create({ fullName, ... })`, e sem essa coluna o primeiro signup quebra.

O stub agora inclui `@beforeCreate() assignUuid` (gera um `randomUUID()`) e a coluna `fullName: string | null`. Os docs (`starter.mdx`, `account-store.mdx`) foram atualizados para mostrar o mesmo modelo completo, com uma nota explicando por que cada peça é necessária.
