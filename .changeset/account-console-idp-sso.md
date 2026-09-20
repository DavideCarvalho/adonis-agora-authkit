---
'@adonis-agora/authkit-server': minor
---

feat(authkit-server): área de conta aceita a sessão do IdP (SSO) — `accountSession.acceptIdpSession`

O console de conta (`/account/*`, admin) só aceitava a própria sessão
(`ACCOUNT_SESSION_KEY`, criada pelo `POST /account/login`); o login da interaction OIDC
cria só a sessão do oidc-provider. Resultado: quem acabou de entrar num app OIDC (ou no
próprio host, quando ele é IdP e RP) levava um segundo pedido de login ao abrir
`/account/*`.

Com `accountSession: { acceptIdpSession: true }`, os guards do console (e o
`AccountAuthMiddleware`/aceite de convite de org) abrem o console para a conta de uma
sessão do IdP válida (cookie assinado, não expirada, conta existente e habilitada). O
console aberto assim fica amarrado a essa sessão: termina quando ela termina, e o "Sair"
do console encerra também a sessão do IdP. Novo helper público `ensureConsoleSession(ctx)`
para guards do host. Default `false` — nada muda para quem não liga.
