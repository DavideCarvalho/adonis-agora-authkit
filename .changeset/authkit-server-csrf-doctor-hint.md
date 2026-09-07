---
'@adonis-agora/authkit-server': patch
---

Hosts montando `registerAuthHost` atrás do `@adonisjs/shield` (CSRF ligado por default no `web` starter kit) tomavam a negação HTML de CSRF em `POST {mountPath}/token` em vez da resposta JSON — `exchangeCode()` no client quebrava com `SyntaxError: Unexpected token '<' ... is not valid JSON`. O helper exportado `authkitCsrfExceptions` (que resolve exatamente essa isenção, acompanhando o `mountPath` real) já existia, mas não era mencionado em nenhum doc de getting-started/quickstart, nem citado pelo nome no aviso do `authkit:doctor` (`checkShield`) — só um lembrete genérico de "coloque as rotas do IdP nas exceções de CSRF".

Adicionado um callout proeminente com um snippet copy-paste em getting-started.mdx (e starter.mdx) logo onde `registerAuthHost` é introduzido, e a mensagem de `checkShield` agora referencia `authkitCsrfExceptions` pelo nome. Adicionado um teste (`tests/host/csrf.spec.ts`) que registra as rotas reais via `registerAuthHost` e verifica que `authkitCsrfExceptions` cobre exatamente o `mountPath` do provider (e nenhuma rota interativa de `/auth/interaction/*`), para que o helper não saia de sincronia com o que a lib efetivamente monta.
