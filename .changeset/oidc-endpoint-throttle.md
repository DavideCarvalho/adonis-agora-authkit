---
"@adonis-agora/authkit-server": patch
---

**Security:** the unauthenticated OAuth/OIDC machine endpoints are now rate limited per IP by default. The provider's token, dynamic registration, device authorization, PAR, revocation, introspection and CIBA endpoints use a new `oidcToken` bucket, and the personal agents' `oauth/token` and `oauth/device_authorization` use a new `agentToken` bucket (120 requests per minute each). Authorize, userinfo, JWKS and discovery are not throttled. `rateLimit: { enabled: false }` turns them off with the other buckets.
