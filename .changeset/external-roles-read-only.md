---
"@adonis-agora/authkit-server": minor
"@adonis-agora/authkit-react": patch
---

feat(admin): roles are read-only in the console and the Admin API when they come from outside authkit.

With `resolveTokenRoles` configured (roles kept in `@adonis-agora/authz` or the host's own table), `globalRoles` decides nothing, but the console and `PATCH /users/:id` still wrote to it and answered "saved". Now:

- User DTOs (console and Admin API) carry `roles`: the effective roles from `resolveAccountRoles`, the same source as the `roles` claim. Without the hook it equals `globalRoles`. `globalRoles` keeps meaning the stored column.
- Editing roles answers `409 roles_managed_externally` (console `PATCH /api/users/:id/roles`, Admin API `PATCH /users/:id` with `globalRoles`). Other fields stay editable.
- The console shows the effective roles as read-only, with a note that the application manages them (`features.rolesManagedExternally` in the injected config).
- `AdminUser.roles?: string[]` in `@adonis-agora/authkit-react`.

Hosts without `resolveTokenRoles` keep editing `globalRoles` as before.
