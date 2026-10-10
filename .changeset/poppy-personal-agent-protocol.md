---
"@adonis-agora/authkit-server": minor
---

**Experimental:** Personal Agent Protocol ("Poppy", Draft 0.1 — https://personalagentprotocol.org/docs/spec) as a second personal-agent protocol next to PACT, under `personalAgents.poppy`. The spec is a draft in development: this config and its exports (`verifyPoppyRequest`, `poppyAuth`, `poppyOf`, `poppyWebSession`, `verifyDpopProof`, the `@adonis-agora/poppy:*` global slots…) track it and WILL change, possibly in breaking ways outside semver majors, while the spec is a draft.

- Discovery (`/.well-known/poppy.json`, per company domain) and RFC 8414 metadata with `poppy_domains`.
- Agent identity by Client ID Metadata Document (SSRF-safe fetch, cache, validation, registration/blocklist) and `private_key_jwt` with `jti` replay protection.
- Sessions via the JWT bearer grant, opaque DPoP-bound Session Tokens (RFC 9449, nonces, replay store: database/memory/redis), Account Tokens as refresh tokens (reusing the personal-agent grants), scope/resource narrowing and the spec's error codes.
- Direct (PKCE + RFC 9207 `iss`), Device (RFC 8628) and pluggable Mediated Sign-In (off by default).
- Resource-server verification (`verifyPoppyRequest`/`poppyAuth`) with `invalid_token`/`sign_in_required`/`insufficient_scope`; MCP Bearer tokens minted as oidc-provider access tokens so the existing MCP integration accepts them.
- Global slots for `@adonis-agora/agent`: `Symbol.for('@adonis-agora/poppy:authenticate')` (request authentication) and `Symbol.for('@adonis-agora/poppy:endpoints')` (conversation endpoint fallback for `poppy.json`).
- Browser session endpoint (signed assertion → app session cookie, 303), `poppyWebSession()` to follow the session state, RFC 7009 revocation and disconnect from the account console.
- `personalAgents.audience` is now optional when only Poppy is configured.
