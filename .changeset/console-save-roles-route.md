---
"@adonis-agora/authkit-server": patch
---

The console's "Save roles" button returned 404. It calls `client.admin.users.update`, which sends `PATCH {console}/api/users/:id` with `{ globalRoles }`, and the console only had `PATCH /api/users/:id/roles`. That route now exists and goes through the same checks as `/roles`: 404, 409 when roles are managed outside authkit, last admin, self-demotion, and validation against the catalog.
