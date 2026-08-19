---
'@adonis-agora/authkit-server': minor
---

The roles claim no longer disappears on hosts without a `branding` block.

The gate deciding who receives the authorization claims — `<globalRolesClaim>`,
`org_id`, `org_slug`, `org_role` — read `config.branding ? isFirstParty(…) : false`.
So the absence of a **theming** block meant "nobody is first-party": on any host
that had not customised its look, every relying party received `globalRoles: []`.
Silently, and asymmetrically, because the admin console reads roles from the
account session rather than from a token and kept working — which is what made it
so hard to see, on the very feature positioned as "authz is the single authority
on roles".

An authorization decision must not depend on whether the host picked a colour.
The allowlist now has its own key, `firstPartyClients: string[]`, and **not
declaring one means every registered client is first-party**. That is not a
free-for-all: the claims are bound to the `roles` scope in the provider, so a
client still has to be registered by an admin *and* ask for `scope=roles`. The
allowlist is a third, optional barrier for hosts that register third-party
clients. `branding.firstParty` is still read as a fallback, so hosts that already
declared it keep exactly the restriction they have today, and an explicitly empty
list still means "nobody".

`authkit:doctor` gains `checkFirstPartyClients`, which warns when no allowlist is
declared and reports the list when it is. New export: `isFirstPartyClient`.
