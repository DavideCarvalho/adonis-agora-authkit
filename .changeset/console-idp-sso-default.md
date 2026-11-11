---
'@adonis-agora/authkit-server': major
---

The account and admin consoles now sign in through the IdP login by default.

- `accountSession.acceptIdpSession` defaults to `true`. Without a console session, `/account/*` and the admin console send the visitor to the IdP login (`/auth/console/sso`) and come back with the console open; a user already signed in to an app opens them directly.
- `/account/login` redirects to the IdP login. The password form stays at `/account/login?method=password` while password login is on.
- The console's idle timeout now also ends the IdP session the console was opened from, like "Sign out" already did.
- `accountSession: { acceptIdpSession: false }` with `authMethods: { password: false }` and no `routes.accountLoginUrl` now fails at boot, since the consoles would have no way in. `authkit:doctor` reports it, and warns when SSO is off.
- The client id `authkit-console` is reserved for the consoles' internal client (`response_type=none`, never listed in the console) and cannot be registered.
