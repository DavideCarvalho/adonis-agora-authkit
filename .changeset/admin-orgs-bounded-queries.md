---
"@adonis-agora/authkit-server": patch
---

perf(admin): list organizations in a bounded number of queries. The admin org list (`AdminOrgsService.listOrgs`, console + Admin REST API) used to walk every account and query its orgs and each org's members, so the query count grew with the account base. The Lucid store now answers it in 3 queries via a new optional `listAllOrgsWithMemberCount` store capability, returning exactly the same list in the same order; custom stores without it keep the previous path.
