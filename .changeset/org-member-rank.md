---
"@adonis-agora/authkit-server": patch
---

**Security:** on the self-service organization routes (`/account/orgs` and `/account/api/orgs`), a member can now only remove or change the role of a member ranked below them (`owner` > `admin` > other roles). Only an owner can act on another owner. Refusals answer 403. The admin console and the Admin API are unchanged.
