---
'@adonis-agora/authkit-server': major
'@adonis-agora/authkit-react': major
---

Poppy (the Personal Agent Protocol) moves out of `@adonis-agora/authkit-server` into the new `@adonis-agora/authkit-poppy` package, and authkit-server gains a stable extension surface for personal-agent protocols. See [Install `@adonis-agora/authkit-poppy` for Poppy](https://github.com/DavideCarvalho/adonis-agora-authkit/blob/main/apps/docs/content/docs/migrating-to-1-0.mdx#install-adonis-agoraauthkit-poppy-for-poppy).

Breaking changes (`@adonis-agora/authkit-server`):

- `personalAgents.poppy` is removed: install `@adonis-agora/authkit-poppy` and use `personalAgents: { extensions: [poppy({ ... })] }` with the same options. A config that still has `personalAgents.poppy` fails at boot. Routes, tables, tokens and sessions are unchanged, so no data migration is needed.
- Every Poppy export (`PoppyConfigInput` and the other `Poppy*` types, `poppyEmailCodeSignIn`, `verifyPoppyRequest`, `poppyAuth`, `poppyOf`, `poppyWebSession`, `poppyWebSessionOf`, `installPoppySlots`, `POPPY_AUTHENTICATE_SLOT`, `POPPY_WEB_SESSION_KEY`, `PoppyError`, `verifyDpopProof`, `accessTokenHash`, `hmacNonceSource`, `databaseReplayStore`, `memoryReplayStore`, `redisReplayStore`, `safeFetchJson`, `isBlockedAddress`, `SafeFetchError`, `maskEmail`) now comes from `@adonis-agora/authkit-poppy`.
- `mail.onPoppySignInCode` is removed: pass `sendCode` to `poppyEmailCodeSignIn()`.
- `authkitCsrfExceptions` no longer takes `poppyPrefix`; extensions' endpoints are exempted from the config (`personalAgentExtensions: false` turns that off).
- `ensureAuthkitSchema()` no longer creates the `auth_poppy_*` tables (the extension's tables are ensured at boot; `ensurePoppySchema()` for migrations).
- Admin console API: an extension's `protocols` entry is `{ label, requireRegistration, hostResolver, allowHttpIdentifiers, identifierLabel, identifierPlaceholder }`.

New, stable for 1.x: `personalAgents.extensions` and the types `PersonalAgentExtension`, `PersonalAgentExtensionDefinition`, `PersonalAgentExtensionContext`, `PersonalAgentRouteKit`, `PersonalAgentHost`, `PersonalAgentGrantLedger`, `PersonalAgentGrant`, `PersonalAgentRefreshToken`, `PersonalAgentAccessTokens`, `PersonalAgentProtocolRuntime`, `PersonalAgentGrantSummary`, `PersonalAgentConsoleSummary`, `ResolvedPersonalAgentExtension`, `AuthkitTable`; the functions `personalAgentExtensionRuntime`, `ensureAuthkitTables`, `sendAuthkitCodeEmail`, `signInAccountSession` and `signOutAccountSession`; and the `tables` option of `ensureAuthkitSchema`.

Breaking changes (`@adonis-agora/authkit-react`):

- `PersonalAgentProtocol` is `'pact'` or any extension id, and `PersonalAgentsOverview.protocols` has one entry per extension (`PersonalAgentExtensionOverview`) instead of a fixed `poppy` key. `AccountAgentGrant.protocol` uses `PersonalAgentProtocol`.
