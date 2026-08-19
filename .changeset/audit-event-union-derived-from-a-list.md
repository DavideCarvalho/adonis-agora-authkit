---
'@adonis-agora/authkit-server': minor
---

Derive `AuditEventType` from a runtime list, and declare the five events that
were missing from it.

The union was hand-written, and nothing checked it against the
`audit.record({ type: … })` call sites. Five event types shipped without ever
entering it — `login.magic_link_sent`, `session.revoked`, `account.signed_out_all`,
`client.secret_regenerated` and `roles_catalog.updated`. A consumer writing an
exhaustive `switch` over `AuditEventType` silently dropped all five, and
TypeScript could not say so: the events exist only as string literals inside the
library.

`AUDIT_EVENT_TYPES` is now exported as a `const` array and the union is
`(typeof AUDIT_EVENT_TYPES)[number]`. Because the list exists at runtime, a spec
can scan `src/` for audit emissions and fail when one is not declared — which is
what now stops the two from drifting apart again.
