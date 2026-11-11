---
'@adonis-agora/authkit-poppy': minor
---

First release: the Personal Agent Protocol ("Poppy", Draft 0.3) as an extension of `@adonis-agora/authkit-server` 1.x — `personalAgents: { extensions: [poppy({ ... })] }`. Same options, routes, tables, tokens and global slots as the Poppy that was built into authkit-server 0.x; `poppyEmailCodeSignIn` takes `sendCode` in place of the old `mail.onPoppySignInCode` hook, `ensurePoppySchema()` creates its tables in a migration, and `node ace configure @adonis-agora/authkit-poppy` checks the install and shows the config change. Experimental: this package stays on 0.x while the spec is a draft.
