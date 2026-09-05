"@adonis-agora/authkit-server": minor
---

feat(impersonation): registry per impersonation (id, timings, exchange proof, stop audit)

`startImpersonation` now records each impersonation: a unique `impersonationId`,
`startedAt`, optional `expiresAt` (only with the new opt-in `maxAge`, in seconds —
no expiry by default, preserving the historic stay-until-stopped behavior), plus the
non-secret metadata from the token-exchange response (`actSub`, `exchangeExpiresIn`).
The exchanged access token itself is still deliberately discarded (bearer credential
of the target with no consumer in the flow). `startImpersonation` returns the created
`ImpersonationState`, and `impersonationState()` exposes the new fields, reading
`active: false` past the deadline (lazy expiry — stopping stays explicit).

`stopImpersonation` now clears all impersonation session keys, accepts an optional
`{ audit, ip }`, emits `impersonation.stopped` (closing the pair opened by
`impersonation`), and returns the stopped state (or `null` when no-op).
