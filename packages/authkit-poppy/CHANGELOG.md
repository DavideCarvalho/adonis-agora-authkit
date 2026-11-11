# @adonis-agora/authkit-poppy

## 0.1.0-rc.0

### Minor Changes

- [#456](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/456) [`9c12ef9`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/9c12ef9c1c49db9d54a7da6d241264499ad76e18) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: the Personal Agent Protocol ("Poppy", Draft 0.3) as an extension of `@adonis-agora/authkit-server` 1.x — `personalAgents: { extensions: [poppy({ ... })] }`. Same options, routes, tables, tokens and global slots as the Poppy that was built into authkit-server 0.x; `poppyEmailCodeSignIn` takes `sendCode` in place of the old `mail.onPoppySignInCode` hook, `ensurePoppySchema()` creates its tables in a migration, and `node ace configure @adonis-agora/authkit-poppy` checks the install and shows the config change. Experimental: this package stays on 0.x while the spec is a draft.
