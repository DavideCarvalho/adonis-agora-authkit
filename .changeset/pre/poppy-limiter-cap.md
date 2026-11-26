---
'@adonis-agora/authkit-poppy': patch
'@adonis-agora/authkit-server': patch
---

Poppy's default in-memory rate limiter now has a hard cap (100 000 windows, oldest evicted first) and drops expired windows as it goes, so a stream of new identifiers on Mediated Sign-In can no longer grow it without bound.

The unauthenticated OAuth endpoints agents call server-to-server now sit behind a per-IP throttle by default (new `agentToken` bucket, 120/min, plain 429; off with the existing `rateLimit: { enabled: false }`): Poppy's `{prefix}/oauth/token`, `oauth/device`, `oauth/par` and `oauth/revoke`, and authkit-server's personal-agents `{personalAgents.prefix}/oauth/token` and `oauth/device_authorization`. Personal-agent extensions get the bucket as `kit.throttle.token(route)`.

The OIDC provider's own machine endpoints get the same treatment: inside the `${mountPath}/*` catch-all, only the POSTs to token, dynamic registration, device authorization, PAR, revocation, introspection and CIBA (paths read from the provider via `pathFor`, so custom `routes` and the issuer mount apply; disabled features are skipped) go through a new per-IP `oidcToken` bucket (120/min, plain 429). Authorize, userinfo, JWKS, discovery, end-session and the device code screen are never throttled. Poppy's `POST {prefix}/browser-session` now uses the login bucket, like its page. All of it is off with `rateLimit: { enabled: false }`.
