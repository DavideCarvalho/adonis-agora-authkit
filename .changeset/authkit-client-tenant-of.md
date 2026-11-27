---
'@adonis-agora/authkit-client': minor
---

Add `tenantOf(resource)` to the `authkit.client` binding: the control-plane URL (discovered from the issuer, like `controlPlaneUrl`), a cached service token for the resource (the `service` client credentials, like `authkitTenantToken`, with `reset()`) and the partition (`service.partition`, new and optional, else `service.name`). Agora libraries in `topology: 'tenant'` use it so `defineConfig({ topology: 'tenant' })` is enough when `service` is configured. Throws `TenantOfConfigError` (`E_AUTHKIT_SERVICE_NOT_CONFIGURED`) naming the config line when `service` or its credentials are missing.
