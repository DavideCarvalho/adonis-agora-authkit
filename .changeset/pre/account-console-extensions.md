---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-react': minor
---

Account console extensions: other packages (and your app) can add pages to `/account/*`.

- New subpath `@adonis-agora/authkit-server/account-extension` with the stable contract (`AccountExtension`, blocks, actions) and the `authkit.accountExtensions` registry binding. Contributors register from their provider's `boot()`; AuthKit renders the pages (Edge or your Inertia page) behind the account sign-in, with CSRF, sudo for sensitive actions, a per-account rate limit, and audit of external redirects.
- Blocks: `notice`, `keyValue`, `list`, `table`, `meter`, `actions`, `link`, `toolPreview` (approve/reject previews) and `component` (a provider's card fields, scripts loaded with the response's CSP nonce, with a link fallback).
- `accountConsole` in `config/authkit.ts`: one `subject(account, { activeOrg, tenant })` mapping shared by every extension, host overrides to disable, rename or reorder pages, and `loadTimeoutMs`.
- The account screens share one navigation (`accountNav`) that lists the mounted screens and the extension pages; `AuthHostRouteMap.account.extensions` lists the pages.
- JSON API: `GET {prefix}/api/extensions`, `GET {prefix}/api/x/:pageId`, `POST {prefix}/api/x/:pageId/actions/:action`.
- authkit-react: `<AccountExtensionPage>`, `useAccountExtensions()`, the page/action query options and `client.account.extensions.*`.
