---
"@adonis-agora/authkit-server": minor
"@adonis-agora/authkit-react": minor
---

Created and updated times everywhere. `AuthAccount` gains optional `createdAt` / `updatedAt`, which the Lucid account store reads from the model's `created_at` / `updated_at` (nothing when the table has no such column). The Admin API and the admin console now send `createdAt` / `updatedAt` (ISO 8601, or `null`) for users, clients, organizations, invitations and roles; clients written by authkit are stamped on create and on every change (a `/reg` client keeps `client_id_issued_at` as its creation time), roles in the catalog are stamped when created or edited, and the app catalog (`auth_app_catalog`) gets a `created_at` column. The console shows a "Created" column on the users list, "Updated" on roles, and "Created · Updated" on the user, client and organization details.

The new `auth_app_catalog.created_at` column is added at boot by `schema.autoManage` (the default). With `autoManage: false`, run `ensureAuthkitSchema(db)` in a migration.

The email-verification grace window (`requireVerifiedEmail` with `graceDays`) now applies: it reads the account's `createdAt`, which the Lucid store did not provide before.
