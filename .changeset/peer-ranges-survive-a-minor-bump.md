---
'@adonis-agora/authkit-server': patch
'@adonis-agora/authkit-client': patch
'@adonis-agora/authkit-sdk': patch
---

Widen the `@adonis-agora/*` peer ranges so they survive the peer's next minor.

Below 1.0.0 a caret does not mean "this minor and up" — it stops at the next
minor, so `^0.22.0` expands to `>=0.22.0 <0.23.0`. Every sibling package in this
ecosystem ships minors constantly, which meant **all four** `@adonis-agora/*`
peers were unsatisfiable against the current release of the package they name.
Under npm this is not a warning: installing `@adonis-agora/authkit-server`
alongside `@adonis-agora/durable@0.24.0` failed outright with
`ERESOLVE — Conflicting peer dependency: @adonis-agora/durable@0.22.0`.

Each floor was chosen from what the code actually calls, not from what the range
happened to say:

| peer | was | now | why that floor |
| --- | --- | --- | --- |
| `@adonis-agora/durable` | `^0.22.0` | `>=0.7.0 <1.0.0` | first release with `ctx.localStep`, absent in 0.6.1 |
| `@adonis-agora/media` | `^0.1.0` | `>=0.5.0 <1.0.0` | first release exporting the `./single-file` subpath the avatar uploader imports, absent in 0.4.0 |
| `@adonis-agora/telescope` | `^0.1.0` | `>=0.1.0 <1.0.0` | all five imported types are shape-identical from 0.1.0 through 0.8.1 |
| `@adonis-agora/resilience` | `^0.1.0` | `>=0.1.0 <1.0.0` | `wrap()` has existed since 0.1.0, and the policy is duck-typed against a locally declared interface rather than imported |

The `^0.22.0` on durable in particular came from the `ctx.step` → `ctx.localStep`
migration and recorded the version current on that day, some fifteen minors above
what the migration actually required.

`@adonis-agora/authkit-sdk`'s peer on `@adonis-agora/authkit-server` gains the
same upper bound (`>=0.10.0 <1.0.0`), which it was missing entirely — it would
have accepted a future 1.0 with breaking changes.

A spec now scans every package manifest and fails on a caret or tilde over a 0.x
`@adonis-agora/*` peer, so this cannot come back quietly.
