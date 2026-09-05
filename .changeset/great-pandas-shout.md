---
"@adonis-agora/authkit-server": minor
---

feat(impersonation): typed start errors with IdP error code (no secret leak)

`startImpersonation` failures are now `ImpersonationStartError` with a
machine-readable `code` (`already_active`, `invalid_max_age`,
`no_admin_access_token`, `no_account_session`, `no_refresh_token`,
`refresh_rejected`, `exchange_rejected`), plus the token-endpoint `status`
and the IdP `error` code (`invalid_grant`, …) — allowlist codes only, never
tokens or `error_description`. The 4xx-without-refresh-token case (expired
admin access token, nothing to renew with) now throws `no_refresh_token`
with the original exchange error as `cause`, instead of rethrowing a bare
`Token exchange failed: 400` identical to a hard IdP refusal. Message
prefixes are preserved (`Token exchange failed: <status>`), so existing
`rejects(..., /Token exchange failed: 400/)` assertions keep passing.
Also exports `ImpersonationStartError`, `ImpersonationStartErrorCode`,
`StopImpersonationOptions` and `TokenExchangeResult` from the package root.
