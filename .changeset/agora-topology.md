---
'@adonis-agora/authkit-client': minor
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-core': minor
'@adonis-agora/authkit-sdk': minor
'@adonis-agora/authkit-react': minor
---

Separate servers: every piece of an Agora deployment can run without authkit-server in its process.

- `authkitTenantVerifier({ issuer, resource, environment? })` (authkit-client) verifies service-tenant tokens on any server against the issuer's discovered JWKS and returns `{ partition, environment?, capabilities, clientId, expiresAt }` or `null`. `authkitTenantToken` now takes the token endpoint only from discovery (no guessed path).
- Service tenants get an optional `environment` (console, Admin API, SDK, `--environment`), emitted as the `environment` claim. One service-tenant client gets tokens for every `urn:agora:*` resource declared.
- `registerOidcClient` announces `POST /auth/logout` as `account.signOut` on the `agora.consoles` registry (skipped when authkit-server runs in the app), so every console shows a sign-out.
- `Identity.actor` (`{ sub, email? }`) from the RFC 8693 `act` claim of an impersonated token (`deriveActor` in authkit-core).
- Org labels: authkit-server serves `GET /api/orgs/labels?ids=` (first-party confidential clients, Basic auth) and emits `org_name` for the active org; authkit-client installs a cached `Context.setTenantLabeler` (`orgLabels` option, `authkitOrgLabels`).
- Webhooks: the body carries `id` and `actorId`, `events.webhook` accepts a list; authkit-client's `registerAuthkitWebhook` / `authkitWebhookHandler` verify the HMAC, the `ts` window and the id, and re-emit on the diagnostics bus as `agora:authkit:<type>` with the in-process payload.
- `identityFromAccessToken`, `bindAuthkitIdentity` and `bridgeAuthkitToken` put a verified authkit bearer token on `ctx.authkit`.
