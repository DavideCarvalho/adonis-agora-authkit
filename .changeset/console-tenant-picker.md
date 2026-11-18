---
'@adonis-agora/authkit-server': patch
'@adonis-agora/authkit-react': patch
---

Clients, the same on every surface:

- `serviceTenants.resources[x].capabilities` declares the capabilities a control plane checks. The console's capabilities field becomes a picker over them (any other value can still be typed), and "Apps it can call" becomes one row per app with that app's capabilities.
- Allowed scopes: the console and the Admin API now set them (`scopes`, `null` lifts the restriction); the client shows them as `scope`.
- The console no longer offers the `implicit` grant (the server refuses it) and offers token-exchange.
- Admin API: `POST /clients/:id/revoke` (disable + cut grants and tokens), like the console and the CLI.
- CLI: `authkit:client disable` / `enable`, `--logo-uri` and `--backchannel-logout-session-required`.
