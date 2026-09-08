---
'@adonis-agora/authkit-server': patch
'@adonis-agora/authkit-client': patch
'@adonis-agora/authkit-testing': patch
'@adonis-agora/authkit-react': patch
---

Bump runtime dependencies to their latest releases.

- `@simplewebauthn/server` and `@simplewebauthn/browser` go to `14.x`. The committed
  `src/host/assets/webauthn.js` bundle was regenerated from the new `@simplewebauthn/browser`
  (the `check:webauthn-bundle` guard would have caught the drift otherwise). The `authkit-react`
  peer was **widened** to `^13.3.0 || ^14.0.0` instead of moved, so apps still on 13 keep
  installing cleanly.
- `oidc-provider` 9.12.0 → 9.12.2 and `jose` 6.2.10 → 6.2.12 (patch releases on the token/JWT path).

No API change on our side: typecheck, tests, packaging smoke and the WebAuthn bundle check all pass.
