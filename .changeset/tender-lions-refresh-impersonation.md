---
'@adonis-agora/authkit-server': minor
---

**impersonation_session: renova o access token expirado via refresh token.**

O `startImpersonation` falhava com `Token exchange failed: 400` quando o access
token do admin (curto, ~15min) expirava antes do token-exchange RFC 8693 — o
admin precisava relogar a cada expiração. Agora:

- `rememberRefreshToken(ctx, refreshToken)` guarda o refresh token (do scope
  `offline_access`) na sessão, junto do access token.
- `refreshAccessToken(ctx, params)` renova o access token via refresh grant
  (RFC 6749 §6), rotacionando o refresh token quando o IdP emite um novo.
- `startImpersonation` detecta o 4xx do exchange (token expirado), renova via
  refresh e tenta de novo automaticamente — sem forçar relogin.

O app RP deve pedir `offline_access` no scope do login e chamar
`rememberRefreshToken` no callback OIDC junto de `rememberAccessToken`.
