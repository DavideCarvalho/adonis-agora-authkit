---
'@adonis-agora/authkit-server': patch
---

`agora:doctor`'s `authkit.shield` check now reads the app's `config/shield.ts` and only warns when shield's CSRF check would really reject one of authkit's server-to-server POST endpoints (`{mountPath}/token`, `/token/introspection`, `/token/revocation`, `/authkit/pat/introspect`, and the personal-agent OAuth endpoints when enabled). It mirrors shield: CSRF off or a `methods` list without POST passes, an empty `methods` checks every method, and `exceptRoutes` may be a function (probed with a token-less POST) or a route-pattern array. `authkitCsrfExceptions` now matches the pathname anchored (`/oidc` or `/oidc/...`) instead of a substring, so `/admin/oidc/x`, `/oidc-clients` or `?next=/oidc` are no longer exempted.
