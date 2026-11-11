---
'@adonis-agora/authkit-server': major
---

The account and admin consoles now sign in through the IdP login by default.

- `accountSession.acceptIdpSession` defaults to `true`. Without a console session, `/account/*` and the admin console send the visitor to the IdP login (`/auth/console/sso`) and come back with the console open; a user already signed in to an app opens them directly.
- `/account/login` redirects to the IdP login. The password form stays at `/account/login?method=password` while password login is on.
- The console's idle timeout now also ends the IdP session the console was opened from, like "Sign out" already did.
- `accountSession: { acceptIdpSession: false }` with `authMethods: { password: false }` and no `accountLoginUrl` (passed to `registerAuthHost` or set in `routes`) now fails at boot when the routes are registered, since the consoles would have no way in. `authkit:doctor` warns about it, and when SSO is off.
- The client id `authkit-console` is reserved for the consoles' internal client (`response_type=none`, never listed in the console) and cannot be registered.
- New `admin.authorize`: an extra access check for the admin console, run after `admin.roles` (both must pass) on the shell and on every `{prefix}/api/*` route. It takes the same contract as every `@adonis-agora` console: an inline function, an authorizer class (built through the container, so `@inject()` works) or a lazy import (`() => import('#policies/console_access')`). Page navigations that are denied go to `accountHome` (or to `{ redirectTo }`); JSON calls get 403, or 401 for `reason: 'unauthenticated'` and `redirectTo`; a thrown error denies. Omitted, `admin.roles` alone decides, as before. The types `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass` and `ConsoleAuthorizeResult` are exported.
