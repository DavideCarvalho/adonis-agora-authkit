---
'@adonis-agora/authkit-server': patch
---

fix(authkit-server): formulários de organizações sem token CSRF

`account/orgs.edge` era a **única** view da lib que renderizava formulários POST
sem `<input name="_csrf">` (ativar, desativar, sair, aceitar convite e criar org),
e o `accountOrgsController.index` não passava `csrfToken` no contexto de render —
ao contrário de todos os outros controllers, que passam
`csrfToken: ctx.request.csrfToken`.

Com CSRF ligado (o padrão de um app Adonis com `@adonisjs/shield`), **todo POST de
organização falhava com "Invalid or expired CSRF token"**: ativar ou trocar de
organização nunca funcionou. O usuário ficava preso no seletor de organização e,
como o token de sessão nunca ganhava a claim de org, **nenhuma rota de tenant
(`/o/:orgSlug/...`, protegida pelo `requireOrg`) abria** — mesmo o fluxo de código
já emitindo as claims de org corretamente.

O teste de `_csrf` em `edge_views` tinha a lista de views escrita à mão, e
`account/orgs.edge` não estava nela, então a falha passou despercebida. Ele agora
**varre o diretório de views** e exige `_csrf` em qualquer view que tenha form
POST, para que uma view nova não escape do mesmo jeito.
