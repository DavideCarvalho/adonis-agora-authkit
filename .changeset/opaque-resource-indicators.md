---
'@adonis-agora/authkit-server': minor
---

feat(authkit-server): resource indicators (RFC 8707) com access tokens opacos

A feature `resourceIndicators` do oidc-provider só era montada quando algum AT era JWT;
com tokens opacos, um `resource` no authorize (clientes MCP sempre mandam) era recusado
com `invalid_target`. Agora `accessTokens.resources` também liga a feature com tokens
opacos: o `resource` declarado (tolerando barra final) é concedido no consent e amarrado
ao AT (`aud`), que continua opaco, encontrável por `AccessToken.find` e introspecionável.
Pedidos sem `resource` não mudam (AT opaco sem `aud`, userinfo funciona).

`resource` fora da lista declarada (chaves de `resources` + o `audience` no modo JWT)
passa a ser recusado com `invalid_target` também no modo JWT — antes, um resource
desconhecido saía como token opaco com `aud` arbitrário.
