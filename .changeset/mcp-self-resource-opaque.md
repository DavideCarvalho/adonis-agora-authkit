---
'@adonis-agora/authkit-server': patch
---

MCP resource registered in this process wins over the same URL declared in `mcpClients.resources`, and the access token stays opaque.

An app that is its own IdP registers its MCP endpoint at boot (`registerOAuthResource`, what `@adonis-agora/agent` does for `/mcp/agora`) and may also name its own public URL in `mcpClients.resources`. The declared list used to win, so the token came out JWT (RFC 9068) — self-contained, never persisted by the oidc-provider — while the endpoint verifying it ran in the same process and looked it up with `provider.AccessToken.find`, which reads the adapter. Every call answered `401 unauthenticated`, with nothing in the config to say why.

`findMcpResource` now returns which side the resource came from (`inProcess`) and checks the runtime registration first, and `getResourceServerInfo` keys the token format on that instead of on the declared list. A URL that only exists in `mcpClients.resources` keeps getting a JWT: that server lives in another process and only ever sees the token.
