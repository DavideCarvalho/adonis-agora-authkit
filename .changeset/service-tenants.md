---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-client': minor
'@adonis-agora/authkit-react': minor
'@adonis-agora/authkit-sdk': minor
---

Service tenants: a client can act as one partition of another service, such as a durable control plane.

- `serviceTenants: { resources: { 'urn:agora:durable': { expiresIn: 600 } } }` in `config/authkit.ts` declares the resources (RFC 8707) that issue service-tenant tokens: JWT access tokens (RFC 9068) with `aud` = the resource and the client's `partition` and `capabilities` as claims.
- A service-tenant client is confidential, uses only `client_credentials` and has no redirect URIs. Create and edit it from the console (**Service tenant** kind), the Admin API and the SDKs (`serviceTenant: { partition, capabilities? }`), or `node ace authkit:clients:create --partition=acme --capability=reports`.
- Any client can now be disabled and enabled again (console, `POST /clients/:id/disable|enable`, SDK `clients.disable/enable`): the token endpoint answers `invalid_client` from the next request on.
- `authkitTenantVerifier()` (authkit-server) verifies those tokens against the local issuer and keys and returns `{ tenant, capabilities }`; `authkitTenantToken({ issuer, clientId, clientSecret, resource })` (authkit-client) fetches, caches and refreshes them on the tenant side. Both fit durable's `verifyTenant` and `tenant.token` as a function or a class, without depending on durable.
- New audit events: `client.disabled`, `client.enabled`, `service_tenant.token_issued`.
- Access-token verification (`oidcBearerGuard`, in-process and remote) now refuses a token whose `sub` is a client (a `client_credentials` token), so a service-tenant token never authenticates a user.
