---
"@adonis-agora/authkit-server": patch
---

fix(roles): every role gate reads the host's role authority. When `resolveTokenRoles` is configured (e.g. roles kept in `@adonis-agora/authz`), the `roles` claim and the admin console already used it, but other gates read `account.globalRoles` directly: the maintenance-mode admin bypass (an admin whose role lives in authz was locked out during maintenance), PAT introspection (`/authkit/pat/introspect`) and the Admin API `POST /tokens/verify` returned the stored column. They now go through `resolveAccountRoles`; opaque access-token introspection passes the token's `clientId` to the hook, as at mint time. Without the hook nothing changes.
