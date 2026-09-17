---
'@adonis-agora/authkit-client': patch
---

fix(authkit-client): redirect de login/callback encaminhava a query string da request

O AdonisJS encaminha a query string da request atual no `redirect` por padrão
(`redirect.forwardQueryString`). O `registerOidcClient` chamava
`ctx.response.redirect(destino)` sem o segundo argumento, e **todos** os seus
destinos são URLs que a própria lib monta — então a query da request não tinha
por que ir junto. Duas consequências visíveis:

- **Pós-login:** o callback redireciona para o destino do app, mas arrastava
  `code`/`state`/`iss` consigo. Quem entrava caía em `/?code=…&state=…&iss=…`
  em vez de `/` — parecia que o botão "Entrar" não fazia nada.
- **Callback falho:** o redirect para `/auth/login` levava o `code`/`state`
  antigos, que então eram encaminhados de novo para o authorize seguinte —
  lixo de uma tentativa anterior viajando pelo fluxo.

Os cinco redirects (`login`, `/auth/login` de recuperação, destino pós-login,
hook `afterLogin` e `end-session` do logout) agora passam `forwardQueryString:
false`. O destino já carrega a query que precisa; nada da request atual deve ser
somado a ela.