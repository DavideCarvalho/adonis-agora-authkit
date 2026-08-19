---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-react': minor
---

Fix the admin console's "Impersonate" button, both halves of it.

**It could never have worked.** The panel was built from `cfg.clients`, which is
always `[]` in a real installation — clients live in the OIDC adapter, created
through the console, the Admin API or `authkit:clients:create`, and the resolved
config never carries them. So the endpoint answered `404 no_token_exchange_client`
on every host that had not kept legacy static clients. Only the test suite, which
declared static clients, ever saw it succeed. `buildImpersonationPanel` now takes
the candidate clients as an argument and the controller reads them from the
adapter, falling back to static config clients for legacy hosts and for adapters
that cannot enumerate. A confidential runtime client renders a `<CLIENT_SECRET>`
placeholder rather than an empty secret, because the adapter cannot hand back a
secret that was shown once at creation.

**And the audit trail lied about it.** The endpoint recorded
`impersonation.started` before the UI had done anything — so a request that then
404'd, or that the admin abandoned, left a record claiming an impersonation had
begun. Viewing the exchange parameters is not assuming an identity. The console
now records `impersonation.panel_viewed`, emitted only once a usable panel
exists; `impersonation` still belongs to the token-exchange handler, which is
where an identity is actually assumed. `impersonation.started` is gone from
`AuditEventType` — nothing emitted it under a truthful reading.

**The UI opened a field that never existed.** `result.data.url` type-checked only
because `ImpersonationPanel` in `@adonis-agora/authkit-react` carried an
`[key: string]: unknown` index signature; at runtime it was always
`window.open(undefined)`. The type is now closed over the real response, so that
line no longer compiles, and the console renders the exchange parameters with a
copyable request instead of trying to navigate somewhere.
