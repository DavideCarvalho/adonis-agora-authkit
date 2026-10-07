---
'@adonis-agora/authkit-server': minor
---

`mcp: true` makes AuthKit the authorization server of your MCP servers, so `claude mcp add <url>` (and Claude, ChatGPT, VS Code, Cursor) signs users in with their own accounts and no app code:

- Dynamic registration opens, restricted to the redirects of the known MCP clients (loopback, claude.ai/claude.com, ChatGPT, VS Code, Cursor); `mcp.redirectUris` adds more. A declared `dynamicRegistration` still wins.
- Clients registered through `/reg` with the `refresh_token` grant get `offline_access` and `prompt=consent` on their authorize, so they stay connected. Static and console/CLI clients are untouched.
- Tokens are bound to the MCP server (`resource`, RFC 8707) declared in `mcp.resources` or registered at runtime with `registerOAuthResource()`, which `@adonis-agora/agent`'s MCP server does on its own.
- The RFC 8414 metadata is also served at the root path (`/.well-known/oauth-authorization-server/oidc`).

The consent screen now names the client that asks (its registered `client_name`, escaped) instead of the IdP's own app name, and lists the scopes it asked for; the Connected apps page (and `GET /account/api/apps`, as `name`) shows clients by that name.
