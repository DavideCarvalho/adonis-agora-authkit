---
"@adonis-agora/authkit-server": minor
---

feat(settings): the social login second factor is a console setting, locked by the config file.

`social.secondFactor` (0.83.0) only existed in `defineConfig`, unlike the other policies. It now follows the config-locks rule: declared in the file it wins and locks the setting; omitted, the new runtime setting `social_second_factor` decides, editable in the admin console (Settings → "Login social: 2º fator") and via the Admin API / `authkit:settings` CLI:

- `policy`: `'enrolled'` (default) | `'required'` | `'never'`.
- `requiredRoles`: roles that always require the factor, whatever the policy (e.g. `['ADMIN', 'COORDINATOR']`). Roles come from `resolveAccountRoles`, so they follow `resolveTokenRoles` (e.g. `@adonis-agora/authz`).

Without the setting nothing changes (`'enrolled'`). The console's settings fields gain `select` and `list` types.
