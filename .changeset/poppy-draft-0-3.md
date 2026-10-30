---
'@adonis-agora/authkit-server': minor
---

Poppy: update to Personal Agent Protocol Draft 0.3, without compatibility with Draft 0.1 (experimental API).

Sessions now come from the `Poppy-Session` header, a JWT signed with a delegated key, and account access is plain OAuth. Sign-in no longer knows the Session, and DPoP is optional. Discovery adds protected resource metadata and `protected_resources`, and scopes are defined by the app. Browsers join through a one-time code, and Mediated Sign-In is now an OAuth extension grant.

Breaking: `POPPY_READ`/`POPPY_WRITE`, `broadScopes`, `sessionTokenTtl`/`accountTokenTtl` (now `accessTokenTtl`/`refreshTokenTtl`) and the `/poppy/sign-in` routes are gone; `signIn.mediated.scopes` and `poppyEmailCodeSignIn({ scopes })` are required; `www.` is no longer ignored in `organization.domain`; the authenticate slot returns `invalid_session` (400) and a code-less 401 instead of `sign_in_required`.
