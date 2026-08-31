export type { FakeAccountStoreOptions, FakeAuthAccount } from './src/account_store.js';
export { fakeAccountStore } from './src/account_store.js';
export type { FakeAuthenticatorLike, FakeAuthenticatorOptions } from './src/authenticator.js';
export { fakeAuthenticator } from './src/authenticator.js';
export { createTestIdentity } from './src/identity.js';
export type {
  MintedToken,
  MintTestIdTokenOptions,
  ServedJwks,
  TestKeyPair,
} from './src/jwt.js';
export {
  generateTestKeyPair,
  jwksFromKey,
  mintTestIdToken,
  serveJwks,
  testJwks,
} from './src/jwt.js';
