---
"@adonis-agora/authkit-client": minor
"@adonis-agora/authkit-server": minor
---

The active organization is published as the request's tenant in `@adonis-agora/context`: `Context.tenant()` returns `{ id, kind: 'organization', source: 'authkit', slug, role }` (and `tenantId` as before). New client option `tenancy`: `eager` resolves the session at request start (default on when `config/context.ts` enables tenancy and the resolver is `jwt`), `personal` makes the user the tenant when there is no active organization (off by default), and `resolve` maps the session to your own (optionally nested) tenants. A tenant the app sets itself with `Context.setTenant` is never overwritten. authkit-server ships `authkitTenantLabels()`, a label resolver for `config/context.ts` → `tenancy.label` that shows organization names in the consoles, and account stores gain the optional `findOrgsByIds` (implemented by the Lucid store).
