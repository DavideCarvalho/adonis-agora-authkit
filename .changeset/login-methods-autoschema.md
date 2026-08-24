---
"@adonis-agora/authkit-server": patch
---

Auto-create the `login_methods` column on an existing host `users` table

The `login_methods` column (used by the `LoginMethodsPreferenceCapability`) is
host-owned — it normally enters via a host migration on the `auth` schema.
Some host deploys only migrate the domain schema, not `auth`, so that migration
can silently never run. The moment the host model started declaring the column,
every user read (including the OIDC login/callback) failed with
`column users.login_methods does not exist`, turning login into a 500.

`ensureAuthkitSchema` (run automatically at boot when `schema.autoManage` is
on) now also guarantees `login_methods` on `auth.users`: if the host `users`
table exists and the column is missing, it adds a nullable `jsonb` column.
Idempotent and additive — it never creates the host-owned `users` table, only
adds the column the library consumes. Existing deployments self-heal on the
next boot/deploy without a manual migration step.