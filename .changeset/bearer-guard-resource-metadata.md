---
"@adonis-agora/authkit-server": minor
---

`oidcBearerGuard({ resource })`: declare the protected resource an API guards (`'https://api.acme.com'`, `{ url }` or `{ path: '/api' }` on the issuer's origin, optional `name`). The 401 then carries `resource_metadata="<origin>/.well-known/oauth-protected-resource<path>"` (RFC 9728 §5.1) next to `error`/`scope`, AuthKit serves that metadata document (with `Access-Control-Allow-Origin: *`), the issuer accepts the resource as an RFC 8707 target even without `mcp`, and the token's `aud` must contain the resource. `mcp.resources` on the issuer's origin get their document too; paths a library serves itself (the agent's MCP) are left alone. Without `resource` nothing changes.
