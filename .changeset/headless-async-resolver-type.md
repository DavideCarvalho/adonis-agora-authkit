---
"@adonis-agora/authkit-server": patch
---

Corrige o tipo de `headless.resolveAccountId` para aceitar `Promise`

O resolver do host comumente é assíncrono (ex.: `await ctx.auth.getUserOrFail()`
para devolver o `user.id`). A assinatura publicada em 0.61.0 era síncrona
(`(ctx) => string | null`), o que fazia um resolver `async` estourar o typecheck
do app. Agora o tipo aceita `string | null | Promise<string | null>` — o
controller já `await`s o retorno. Nenhuma mudança de runtime.