---
'@adonis-agora/authkit-server': major
---

The account and admin consoles now sign in through the IdP login by default.

- `accountSession.acceptIdpSession` defaults to `true`. Without a console session, `/account/*` and the admin console send the visitor to the IdP login (`/auth/console/sso`) and come back with the console open; a user already signed in to an app opens them directly.
- `/account/login` redirects to the IdP login. The password form stays at `/account/login?method=password` while password login is on.
- The console's idle timeout now also ends the IdP session the console was opened from, like "Sign out" already did.
- `accountSession: { acceptIdpSession: false }` with `authMethods: { password: false }` and no `accountLoginUrl` (passed to `registerAuthHost` or set in `routes`) now fails at boot when the routes are registered, since the consoles would have no way in. `authkit:doctor` warns about it, and when SSO is off.
- The client id `authkit-console` is reserved for the consoles' internal client (`response_type=none`, never listed in the console) and cannot be registered.
- New `admin.authorize`, the access check every `@adonis-agora` console takes: an inline function, an authorizer class (built through the container, so `@inject()` works) or a lazy import (`() => import('#policies/console_access')`). It runs after `admin.roles` (both must pass) on the shell and on every `{prefix}/api/*` route. An account without one of the roles still goes to `accountHome`.
- **Breaking:** without `admin.authorize`, the admin console is open outside production and answers 403 to every request in production. The app logs `[@adonis-agora/authkit-server] console has no \`authorize\` configured: …` once at boot, and `authkit:doctor` warns. To keep letting every admin in, set `admin: { enabled: true, roles: ['ADMIN'], authorize: () => true }`.
- An `authorize` denial answers 403 (an access-denied page, or `{ error: 'forbidden' }` for JSON); `reason: 'unauthenticated'` answers 401 (`{ error: 'unauthenticated' }`); `{ redirectTo }` redirects page navigations and answers 401 `{ error: 'unauthenticated', redirectTo }` to JSON calls; a thrown error is a 403.
- New `authorizeByToken({ token })`: a `ConsoleAuthorize` that allows `Authorization: Bearer <token>` (timing-safe compare) and answers 401 otherwise. An empty token throws when the config loads.
- The types `ConsoleAuthorize`, `ConsoleAuthorizer`, `ConsoleAuthorizerClass` and `ConsoleAuthorizeResult` are exported, next to `authorizeByToken`.
