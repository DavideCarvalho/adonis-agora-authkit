---
'@adonis-agora/authkit-server': patch
---

Declare `onAccountExpirationWarning` in the `MailHooks` interface.

`authkit:expire-scan` has always called `mail.onAccountExpirationWarning({ email, expiresInDays })`
before deactivating an inactive account, but the hook was never declared on
`MailHooks` — the call site reads the config through `Record<string, any>`, so
nothing checked it. A host that supplied the hook got no type for its payload,
and a host that mistyped the key got no error; the docs, having no type to read,
documented a different payload entirely.

The hook is now part of the interface with its real payload, so editors complete
it and a wrong shape fails the build.
