---
'@adonis-agora/authkit-client': patch
---

fix(authkit-client): opt-out do encaminhamento de query precisa ser `withQs(false)`

A correção anterior (0.18.6) passou `false` como segundo argumento de
`ctx.response.redirect(destino, false)`. **Isso não desliga o encaminhamento**
quando o app declara `redirect.forwardQueryString: true` no `config/app.ts`, que
é o caso comum: nessa situação o positional é ignorado e o `Redirect` herda a
configuração global, continuando a encaminhar. O sintoma seguia igual — o
callback mandava `code`/`state`/`iss` para o destino e o app terminava em
`/?code=…` depois do login.

O opt-out por redirect é o builder: `ctx.response.redirect().withQs(false).toPath(destino)`.
Os cinco redirects do `registerOidcClient` (login, `/auth/login` de recuperação,
destino pós-login, hook `afterLogin` e `end-session` do logout) passam a usá-lo.

O teste passava antes porque o `response` falso honrava o argumento posicional —
ou seja, testava uma premissa que o framework não cumpre. Ele agora modela o
comportamento real (config ligada ⇒ positional ignorado; só `withQs(false)`
desliga), então falha com a forma antiga e passa com a correta.
