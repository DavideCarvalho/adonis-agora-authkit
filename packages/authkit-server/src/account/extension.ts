/**
 * Account console extensions — the surface another package (or the app) uses to add pages to the
 * signed-in user's own console (`/account/*`).
 *
 * **Stable for all of 1.x.** Types and constants only (the same ones `@adonis-agora/authkit-client`
 * binds for an app whose IdP runs elsewhere), so a contributor can `import type` it from an
 * internal module without a runtime dependency on authkit.
 */

export type {
  AccountAction,
  AccountActionField,
  AccountActionResult,
  AccountActiveOrg,
  AccountBlockKind,
  AccountExtension,
  AccountExtensionContext,
  AccountExtensionOverride,
  AccountExtensionRegistry,
  AccountPage,
  AccountPageNav,
  AccountPageView,
  AccountSubject,
  AccountTenantLevel,
  AccountTenantRef,
  ActionRef,
  Block,
  ComponentScript,
  ListItem,
  Text,
  Value,
} from '@adonis-agora/authkit-core';
export {
  ACCOUNT_BLOCK_KINDS,
  ACCOUNT_EXTENSION_CONTRACT,
  ACCOUNT_EXTENSIONS_BINDING,
} from '@adonis-agora/authkit-core';
