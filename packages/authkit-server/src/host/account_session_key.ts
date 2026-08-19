/**
 * Session key holding the signed-in account id for the account console.
 *
 * A module of its own, deliberately, and it must stay free of imports.
 *
 * The constant is re-exported from the package barrel, and it used to live in
 * `middleware/account_auth.ts` — which side-effect-imports `../augmentations.js`
 * to type `ctx.session` for its own body. That made every consumer of the barrel
 * load `augmentations.d.ts`, and with it this package's
 * `declare module '@adonisjs/core/http' { adminApiKeyId?: string }`.
 *
 * `adminApiKeyId` is a name only this library claims, so the blast radius was
 * small — but that is nomenclature luck, not design. The sibling client package
 * shipped the identical shape over `auth`, a name every app declares, and
 * consumers went from 24 type errors to 351 with nothing pointing at the cause.
 * A constant that hosts import should not be able to carry a `HttpContext`
 * augmentation in with it.
 *
 * Keep this file import-free: anything it imports, the barrel inherits.
 */
export const ACCOUNT_SESSION_KEY = 'account_user_id';
