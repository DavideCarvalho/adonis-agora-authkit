---
'@adonis-agora/authkit-server': patch
---

Security: on `/account/orgs` and `/account/api/orgs`, an org member can only remove or change the role of a member whose role is below their own. An `admin` can no longer demote or remove an `owner` (or another `admin`); only an owner acts on an owner. Refusals answer 403 with a message saying to ask an owner. The admin console and Admin API are unchanged.
