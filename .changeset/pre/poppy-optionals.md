---
"@adonis-agora/authkit-poppy": minor
---

Poppy 1.0 optional parts:

- The consent page marks scopes the account already granted to the agent (still lists every scope).
- `signIn.limitToResource`: a sign-in whose first request names `resource` covers only those resources.
- A delegated key that already signed for another User ID gets `invalid_session` (`sessionJwt.oneUserPerKey`, default on).
- `versions` / `preferredVersion`: serve several protocol versions (`supported_versions`, a document per version on the same host, `Deprecation`/`Sunset` for a version being retired). The principal gains `documentVersion`; verified results carry `headers`.
- A Session keeps the `Poppy-Version` it started with (`session_ended` otherwise).
- `tasks.feedback` without `endpoint`: a built-in feedback endpoint (`POST /poppy/feedback`) that verifies the Session, stores reports in `auth_poppy_feedback` and calls `onReport`.
- `operations`: the Operations extension (version 3) — `requirePoppyOperation()`, website operations with `Poppy-Operation` and `POST /poppy/operations`, declines, at-most-once retries, and the `@adonis-agora/poppy:operations` global slot.
- `browserControl`: lists Browser Control (version 1), with `poppyUserStep()` (also an Edge global) and `poppyUserStepAttrs()`.
- `links` / `disclosures`: list the Links and Disclosures extensions.

New lib-owned tables (`auth_poppy_grant_resources`, `auth_poppy_delegated_keys`, `auth_poppy_feedback`, `auth_poppy_operations`, `auth_poppy_operation_revisions`) and `sid`/`protocol_version` columns on `auth_poppy_sessions`, created additively at boot (or with `ensurePoppySchema()`).
