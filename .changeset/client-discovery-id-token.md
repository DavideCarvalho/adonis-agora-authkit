---
"@adonis-agora/authkit-client": minor
---

Third-party IdPs (Keycloak, Auth0, Okta, Entra) now work with the integrated client, and the id_token is validated (#237).

- **Discovery by default.** `defineConfig` gains `discovery` (default `true`) and `endpoints` (per-field overrides). The endpoints published at `{issuer}/.well-known/openid-configuration` are used everywhere: `registerOidcClient` login/callback/logout, `maybeRefresh`, impersonation, back-channel logout and the default `jwksUri` / introspection URL of `resolvers.jwt()` / `resolvers.opaque()`. Discovery is lazy (the app boots while the IdP is down), a failure throws `OidcDiscoveryError` and is retried on the next request, and a document discovered earlier keeps being served while refetches fail. The document's `issuer` must match the configured one; its exact value is used for `iss` checks, which fixes trailing-slash issuers (Auth0). `discovery: false` restores the previous behaviour (authkit-server route layout + `endpoints`), e.g. for tests that run against a fake issuer.
- **id_token validation.** New `validateIdToken` (signature, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, `max_age`, `sub`). The callback now sends and checks a `nonce` and validates the id_token; a refreshed id_token must be valid and about the same user, otherwise the refresh is discarded.
- **New flow helpers.** `createAuthorizationRequest` / `completeAuthorization` (also as `AuthkitClientManager` methods, together with `endpoints()` and `validateIdToken()`) wrap state, nonce, PKCE, the RFC 9207 `iss` check and id_token validation; failures throw `OidcCallbackError` with a `code` and `restartable`.
- **Container binding by class.** `AuthkitClientManager` is bound by class (with `authkit.client` kept as an alias), so it can be used with `@inject()`. The scaffolded `OidcSessionController` uses it.
- **No more silent failures.** A failing refresh is logged as a warning; `/auth/logout` goes straight to the post-logout destination when the IdP publishes no `end_session_endpoint`.
- Token endpoint failures now carry the IdP's `error` / `error_description` (`Token endpoint returned 400: not_allowed (…)`) instead of a bare status.
- `discoverEndpoints` gains `onError: 'fallback' | 'throw'`. With the default `'fallback'`, the convention fallback is no longer cached, and a document without a matching `issuer` is treated as unusable.
- `OidcEndpoints.issuer` is now always present: the document's exact issuer when discovered, the configured one otherwise (`conventionEndpoints(issuer)` fills it in). Code that builds an `OidcEndpoints` literal by hand must add it.
- Back-channel logout reuses the cached remote JWKS instead of fetching the IdP keys on every `logout_token`.
