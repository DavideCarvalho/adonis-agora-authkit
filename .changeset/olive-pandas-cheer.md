---
"@adonis-agora/authkit-server": patch
---

impersonation: `stopImpersonation` preserva o `admin_access_token` do admin

Antes, sair da personificação limpava o `admin_access_token` da sessão junto
com o `impersonator_user_id`. Como o `startImpersonation` exige o access token
do admin como `subject_token` do token-exchange, a PRÓXIMA personificação
falhava com "No admin access token in session; call rememberAccessToken after
login" — o admin precisava relogar a cada ida e volta.

O token é do ADMIN (não do alvo) e o admin segue logado após o stop, então
preservá-lo é seguro: o token segue curto (TTL do access token do RP) e o
logout do app (`ctx.session.clear()`) continua limpando a sessão inteira.
`stopImpersonation` agora só remove `impersonator_user_id`.
