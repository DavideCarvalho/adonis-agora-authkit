---
'@adonis-agora/authkit-server': minor
---

Access tokens for MCP servers carry the user's roles (always) and email (with the `email` scope), so a
console gated by role admits callers coming through MCP. MCP servers listed in `mcpClients.resources`
(another process) now get JWT access tokens they verify from the JWKS; servers registered in-process
with `registerOAuthResource` keep opaque tokens.
