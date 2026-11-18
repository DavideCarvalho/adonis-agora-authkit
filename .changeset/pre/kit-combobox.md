---
'@adonis-agora/authkit-server': patch
---

Console: fields with autocomplete (kit `ComboSelect`/`ComboMultiSelect`). Org member and invitation roles offer the org's roles (`organizations_policy.roles`, org then global, else the defaults) and still accept a typed role; editing a member's role is no longer a free text box. Settings `list` fields are chips with autocomplete (the social 2FA "required roles" list suggests the roles catalog), and a `select` with more than six options gets autocomplete. The Audit page filters by several event types at once (`?type=a,b`), listing every type the server emits.
