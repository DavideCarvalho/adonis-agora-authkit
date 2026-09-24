---
'@adonis-agora/authkit-server': minor
---

Clientes nativos (RFC 8252) e guard de access token (`oidcBearerGuard`)

**Clientes nativos.** Um client pode ser `applicationType: 'native'` (config estática,
Admin API/console — select "Application Type" — e `node ace authkit:clients:create --native`).
Antes todo client virava `application_type: 'web'` e o oidc-provider recusava redirect de app
mobile. Um client nativo aceita redirect de esquema privado (`com.example.app:/oauth`), https
"claimed" e loopback `http://127.0.0.1/…` com qualquer porta; é sempre público (sem secret,
`tokenEndpointAuthMethod: 'none'`, sem `client_credentials`) e o PKCE continua obrigatório.
O `AdminClientsService` valida a metadata pelo tipo antes de gravar (`ClientMetadataError`,
422 `invalid_client_metadata` na API); client web continua só com http/https e o payload dele
não muda. `offline_access` + rotação de refresh token valem igual para clients públicos
(reusar um RT já rotacionado revoga o grant), e o consent é pulado para o client nativo
listado em `branding.firstParty`, como para os web.

**`oidcBearerGuard`.** Guard de `@adonisjs/auth` para APIs chamadas com
`Authorization: Bearer <access token>` — app nativo, SPA, serviço. Verifica in-process contra
o issuer embarcado (token opaco pelo adapter, JWT RFC 9068 pelo JWKS do provider) ou, com
`remote`, como resource server (JWKS do issuer e introspecção RFC 7662 com client
credentials). Aplica `scopes`/`audience`/`clientIds`, recusa token expirado, revogado,
refresh token e sender-constrained, e responde `E_UNAUTHORIZED_ACCESS` (401 com
`WWW-Authenticate: Bearer …`, nunca redirect). `authenticateAsClient` emite um token real
(`loginAs` nos testes). Os verificadores também são exportados
(`inProcessAccessTokenVerifier`, `remoteAccessTokenVerifier`).

`getAccountId(ctx)` passa a devolver, quando não há conta na sessão, a conta que o
`oidcBearerGuard` autenticou na request — basta pôr o guard em `auth.guards` e usar
`middleware.auth({ guards: ['web', 'api'] })`, sem reescrever as chamadas. A sessão sempre
ganha, e quem não usa o guard bearer não vê diferença. `realAccountId` segue a mesma regra;
`hasAccountSession` continua olhando só a sessão.

Guia novo: "Native apps (React Native / Expo)".
