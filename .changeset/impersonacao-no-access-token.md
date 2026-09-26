---
"@adonis-agora/authkit-server": minor
---

A impersonation passa a valer também para o access token (app nativo), não só para a sessão do console.

O token-exchange (RFC 8693) punha o ator (`act`) só no `id_token`. O ACCESS token trocado saía idêntico a um token do próprio alvo, então num resource server com `oidcBearerGuard` (ex.: app nativo) nenhuma regra "negado durante impersonation" funcionava: `impersonationState` e `realAccountId` só olhavam a sessão.

- O access token trocado carrega `extra.act = { sub: <admin> }` (via `extraTokenClaims` do provider; sai no JWT e na introspecção). A resposta do token endpoint também traz `act`, o que finalmente preenche o `actSub` que o `startImpersonation` grava na sessão.
- `VerifiedAccessToken.actor` expõe o ator (in-process, JWT e introspecção remota). O `oidcBearerGuard` grava a impersonation na request e recusa o token se a conta do ator não existe mais.
- `impersonationState(ctx)` e `realAccountId(ctx)` entendem a impersonation pelo bearer (`source: 'bearer'`, `impersonatorId` = o admin, `expiresAt` = `exp` do token). Sessão de console logada continua mandando.
- O token-exchange recusa: impersonation encadeada (token que já é de impersonation como `subject_token`) e impersonar a si mesmo.
- Nova opção `admin.impersonateAdmins` (default `true`, back-compat): com `false`, alvo que também é admin vira `invalid_grant`.
