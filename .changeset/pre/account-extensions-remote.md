---
'@adonis-agora/authkit-core': minor
'@adonis-agora/authkit-client': minor
'@adonis-agora/authkit-server': minor
---

Account console extensions from another app. An app that signs in through an authkit IdP can now add pages to the IdP's account console:

- authkit-client binds the same `authkit.accountExtensions` registry, so packages register their pages the same way in both setups. With `accountConsole: { remote: true }` the app serves them at `/.well-known/agora-account-extensions` (mounted by `registerOidcClient`, or `registerAccountExtensionsEndpoint(router)`), only to requests the IdP signed for its client id with the scope `authkit:account-extensions`. `accountConsole.subject` maps the IdP account to the app's user.
- authkit-server: `accountConsole.remote: [{ clientId, url }]` lists those apps; their pages show in the console next to the in-process ones, with the same sign-in, sudo, confirmation, rate limit and audit rules.
- The contract types and validation now live in authkit-core (still exported from `@adonis-agora/authkit-server/account-extension`).
