// agora crypto-kit v1 — copied verbatim from _1x/shared/crypto-kit; never edit in one lib only.
//
// The kit's tests, runner-agnostic (node:assert only). Each lib registers them with its own runner:
//   for (const [name, run] of Object.entries(cryptoKitCases)) test(name, run)
import assert from 'node:assert/strict';
import {
  deriveKeyPair,
  generateKeyPair,
  jwkThumbprint,
  openPrivateKey,
  openWith,
  publicJwk,
  sealedToKid,
  sealPrivateKey,
  sealTo,
  sign,
  toJwks,
  verify,
} from './asymmetric.js';
import { createKeyring, gcmEncryption } from './keyring.js';
import { createInMemoryKms } from './kms.js';
import {
  needsReseal,
  open,
  reseal,
  SEALED_PREFIX,
  SealedValueError,
  seal,
  sealedStatus,
} from './seal.js';

const KEY = 'a-test-app-key-of-32-characters!';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Another spelling of the same bytes (the last char's unused bits set): never accepted. */
function twin(part: string): string {
  const last = ALPHABET.indexOf(part.at(-1) as string);
  const other = `${part.slice(0, -1)}${ALPHABET[last ^ 0b0001]}`;
  assert.deepEqual(Buffer.from(other, 'base64url'), Buffer.from(part, 'base64url'));
  return other;
}
const NEW = 'another-app-key-of-32-characters';
const purpose = 'kit:test';

/** Flips one bit of one decoded base64url part found by `pick` in `split(separator)`. */
function flip(value: string, separator: string, index: number, byte = 0): string {
  const parts = value.split(separator);
  const part = parts[index] as string;
  const prefix = part.startsWith('v1:') ? 'v1:' : '';
  const bytes = Buffer.from(part.slice(prefix.length), 'base64url');
  bytes[byte % bytes.length] = (bytes[byte % bytes.length] as number) ^ 0x01;
  parts[index] = `${prefix}${bytes.toString('base64url')}`;
  return parts.join(separator);
}

/** Flips a bit inside Adonis' own ciphertext `<id>.v1:<ct>.<iv>.<tag>` of a kit value. */
function flipBody(sealed: string, dotIndex: number, byte = 0): string {
  const at = sealed.lastIndexOf(':', sealed.indexOf('.'));
  const head = sealed.slice(0, at + 1);
  const body = sealed.slice(at + 1);
  return `${head}${flip(body, '.', dotIndex, byte)}`;
}

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SealedValueError, `expected SealedValueError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function refusedSync(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof SealedValueError, `expected SealedValueError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

export const cryptoKitCases: Record<string, () => Promise<void>> = {
  async 'seals with Adonis encryption under the agora:v1: prefix and round-trips'() {
    const ring = createKeyring({ keys: [KEY], purpose });
    for (const value of ['hello', '', 'çãé ✓ 🙂', 'x'.repeat(10_000), '{"a":1}']) {
      const sealed = await seal(ring, value);
      assert.ok(sealed.startsWith(`${SEALED_PREFIX}agora.v1:`), sealed.slice(0, 20));
      assert.ok(!sealed.includes(value) || value === '');
      assert.equal(await open(ring, sealed), value);
    }
    assert.notEqual(await seal(ring, 'same'), await seal(ring, 'same'));
  },

  async 'refuses a tampered value, at every byte of ciphertext, iv and tag'() {
    const ring = createKeyring({ keys: [KEY], purpose });
    const sealed = await seal(ring, 'a secret value');
    const body = sealed.slice(SEALED_PREFIX.length);
    for (const index of [1, 2, 3]) {
      const length = Buffer.from(
        body.split('.')[index]?.replace(/^v1:/, '') ?? '',
        'base64url',
      ).length;
      for (let byte = 0; byte < length; byte++) {
        await refused(open(ring, flipBody(sealed, index, byte)), 'unreadable');
      }
    }
    await refused(open(ring, `${SEALED_PREFIX}`), 'format');
  },

  async 'binds the aad and the purpose'() {
    const ring = createKeyring({ keys: [KEY], purpose });
    const sealed = await seal(ring, 'totp', { aad: 'row:1' });
    assert.equal(await open(ring, sealed, { aad: 'row:1' }), 'totp');
    await refused(open(ring, sealed, { aad: 'row:2' }), 'unreadable');
    await refused(open(ring, sealed), 'unreadable');
    await refused(open(ring, await seal(ring, 'v'), { aad: '' }), 'unreadable');
    const other = createKeyring({ keys: [KEY], purpose: 'kit:other' });
    await refused(open(other, await seal(ring, 'v')), 'unreadable');
  },

  async 'rotation: an older key still opens, is `retired`, and reseal moves it to the first key'() {
    const before = createKeyring({ keys: [KEY], purpose });
    const old = await seal(before, 'v', { aad: 'r' });
    const after = createKeyring({ keys: [NEW, KEY], purpose });
    assert.equal(await sealedStatus(after, old, { aad: 'r' }), 'retired');
    assert.equal(await needsReseal(after, old, { aad: 'r' }), true);
    assert.equal(await open(after, old, { aad: 'r' }), 'v');
    const fresh = await reseal(after, old, { aad: 'r' });
    assert.notEqual(fresh, old);
    assert.equal(await sealedStatus(after, fresh, { aad: 'r' }), 'active');
    assert.equal(await needsReseal(after, fresh, { aad: 'r' }), false);
    assert.equal(await reseal(after, fresh, { aad: 'r' }), fresh);
    const onlyNew = createKeyring({ keys: [NEW], purpose });
    assert.equal(await open(onlyNew, fresh, { aad: 'r' }), 'v');
    assert.equal(await sealedStatus(onlyNew, old, { aad: 'r' }), 'unreadable');
    await refused(open(onlyNew, old, { aad: 'r' }), 'unreadable');
  },

  async 'an Adonis encryption instance (the app service) works, and reseal can be forced'() {
    const appEncryption = gcmEncryption([NEW, KEY], 'app');
    const ring = createKeyring({ encryption: appEncryption, purpose });
    const sealed = await seal(ring, 'v');
    assert.ok(sealed.startsWith(`${SEALED_PREFIX}app.v1:`));
    assert.equal(await open(ring, sealed), 'v');
    // The kit can't tell the app's keys apart: whatever opens is `active`.
    const byOld = await seal(
      createKeyring({ encryption: gcmEncryption([KEY], 'app'), purpose }),
      'v',
    );
    assert.equal(await sealedStatus(ring, byOld), 'active');
    assert.equal(await reseal(ring, byOld), byOld);
    const forced = await reseal(ring, byOld, { force: true });
    assert.notEqual(forced, byOld);
    assert.equal(
      await open(createKeyring({ encryption: gcmEncryption([NEW], 'app'), purpose }), forced),
      'v',
    );
  },

  async 'legacy readers open old values (e.g. plain Adonis encryption), which need a reseal'() {
    const appEncryption = gcmEncryption([KEY], 'app');
    const oldValue = appEncryption.encrypt('totp-secret');
    const ring = createKeyring({
      keys: [KEY],
      purpose,
      legacy: [
        () => {
          throw new Error('not mine');
        },
        (v) => appEncryption.decrypt<string>(v) ?? undefined,
        async (v) => (v.startsWith('async:') ? v.slice(6) : undefined),
      ],
    });
    assert.equal(await open(ring, oldValue), 'totp-secret');
    assert.equal(await open(ring, 'async:x'), 'x');
    assert.equal(await sealedStatus(ring, oldValue), 'legacy');
    assert.equal(await needsReseal(ring, oldValue), true);
    const fresh = await reseal(ring, oldValue, { aad: 'row:1' });
    assert.equal(await sealedStatus(ring, fresh, { aad: 'row:1' }), 'active');
    assert.equal(await open(ring, fresh, { aad: 'row:1' }), 'totp-secret');
    await refused(open(ring, 'nobody-knows-this'), 'legacy');
    assert.equal(await sealedStatus(ring, 'nobody-knows-this'), 'unreadable');
    assert.equal(await needsReseal(ring, 'nobody-knows-this'), false);
  },

  async 'envelope encryption: a KMS wraps a per-value data key stored inline'() {
    const kms = createInMemoryKms();
    const ring = createKeyring({ keys: [KEY], kms, purpose });
    const sealed = await seal(ring, 'v', { aad: 'a' });
    assert.ok(sealed.startsWith(`${SEALED_PREFIX}kms:`));
    assert.equal(await open(ring, sealed, { aad: 'a' }), 'v');
    assert.equal(await sealedStatus(ring, sealed, { aad: 'a' }), 'active');
    await refused(open(ring, sealed, { aad: 'b' }), 'unreadable');
    // The wrapped key is the 3rd `:` part; the ciphertext after it.
    const parts = sealed.split(':');
    const wrapped = Buffer.from(parts[3] as string, 'base64url');
    wrapped[wrapped.length - 5] = (wrapped[wrapped.length - 5] as number) ^ 0x01;
    await refused(
      open(
        ring,
        [...parts.slice(0, 3), wrapped.toString('base64url'), ...parts.slice(4)].join(':'),
        { aad: 'a' },
      ),
      'kms',
    );
    await refused(open(ring, flipBody(sealed, 1), { aad: 'a' }), 'unreadable');
    await refused(
      open(ring, [...parts.slice(0, 3), `${parts[3]}=`, ...parts.slice(4)].join(':')),
      'format',
    );
    const stranger = createKeyring({ keys: [KEY], kms: createInMemoryKms(), purpose });
    await refused(open(stranger, sealed, { aad: 'a' }), 'kms');
    const noKms = createKeyring({ keys: [KEY], purpose });
    await refused(open(noKms, sealed, { aad: 'a' }), 'kms');
    assert.equal(await sealedStatus(noKms, sealed, { aad: 'a' }), 'unreadable');
  },

  async 'a KMS-sealed value with a non-canonical wrapped key is refused'() {
    // 34-byte wrapped keys: 46 base64url chars, the last one with unused bits.
    const kms = {
      wrap: (dataKey: Uint8Array) => Buffer.concat([Buffer.from([1, 2]), dataKey]),
      unwrap: (wrapped: Uint8Array) => Buffer.from(wrapped).subarray(2),
    };
    const ring = createKeyring({ keys: [KEY], kms, purpose });
    const parts = (await seal(ring, 'v')).split(':');
    assert.equal(await open(ring, parts.join(':')), 'v');
    parts[3] = twin(parts[3] as string);
    await refused(open(ring, parts.join(':')), 'format');
  },

  async 'turning a KMS on: plain values are `retired` and reseal wraps them'() {
    const plain = await seal(createKeyring({ keys: [KEY], purpose }), 'v');
    const ring = createKeyring({ keys: [KEY], kms: createInMemoryKms(), purpose });
    assert.equal(await sealedStatus(ring, plain), 'retired');
    const fresh = await reseal(ring, plain);
    assert.ok(fresh.startsWith(`${SEALED_PREFIX}kms:`));
    assert.equal(await sealedStatus(ring, fresh), 'active');
  },

  async 'validates the keyring'() {
    assert.throws(() => createKeyring({ purpose }), /either `keys` or `encryption`/);
    assert.throws(
      () => createKeyring({ keys: [KEY], encryption: gcmEncryption([KEY]), purpose }),
      /either/,
    );
    assert.throws(() => createKeyring({ keys: [], purpose }), /at least one/);
    assert.throws(() => createKeyring({ keys: [KEY], purpose: '' }), /purpose/);
    assert.throws(() => createKeyring({ keys: ['short'], purpose }));
    const secret = { release: () => KEY };
    const ring = createKeyring({ keys: [secret], purpose });
    assert.equal(await open(ring, await seal(ring, 'v')), 'v');
  },

  async 'never puts the plaintext or a key in an error'() {
    const ring = createKeyring({ keys: [KEY], purpose });
    const sealed = await seal(ring, 'plain-text-value');
    try {
      await open(ring, flipBody(sealed, 1));
      assert.fail('should have thrown');
    } catch (error) {
      const text = String((error as Error).message);
      assert.ok(!text.includes('plain-text-value') && !text.includes(KEY));
    }
  },

  async 'key pairs: X25519/Ed25519 JWKs with a thumbprint kid; public halves for a JWKS'() {
    const { publicKey, privateKey } = generateKeyPair('ed25519');
    assert.equal(publicKey.kty, 'OKP');
    assert.equal(publicKey.crv, 'Ed25519');
    assert.equal(publicKey.kid, jwkThumbprint(publicKey));
    assert.equal(publicKey.d, undefined);
    assert.equal(typeof privateKey.d, 'string');
    assert.deepEqual(publicJwk(privateKey), publicKey);
    assert.deepEqual(toJwks([privateKey]), { keys: [publicKey] });
    assert.equal(generateKeyPair('x25519', { kid: 'app-2026-11' }).publicKey.kid, 'app-2026-11');
    assert.throws(() => generateKeyPair('x25519', { kid: 'bad:kid' }), /kid/);
  },

  async 'deriveKeyPair: the same pair from the same secret and purpose, another otherwise'() {
    const a = deriveKeyPair('ed25519', KEY, 'lib:webhooks');
    assert.deepEqual(deriveKeyPair('ed25519', { release: () => KEY }, 'lib:webhooks'), a);
    assert.equal(a.publicKey.kid, jwkThumbprint(a.publicKey));
    assert.notEqual(deriveKeyPair('ed25519', NEW, 'lib:webhooks').publicKey.x, a.publicKey.x);
    assert.notEqual(deriveKeyPair('ed25519', KEY, 'lib:other').publicKey.x, a.publicKey.x);
    assert.equal(verify(a.publicKey, 'm', sign(a.privateKey, 'm')), true);
    const x = deriveKeyPair('x25519', KEY, 'lib:secrets', { kid: 'app' });
    assert.equal(x.publicKey.crv, 'X25519');
    assert.notEqual(x.publicKey.x, a.publicKey.x);
    assert.equal(openWith(x.privateKey, sealTo(x.publicKey, 'v')), 'v');
    assert.throws(() => deriveKeyPair('ed25519', 'short', 'p'), /16/);
    assert.throws(() => deriveKeyPair('ed25519', KEY, ''), /purpose/);
  },

  async 'sealTo / openWith: only the private key opens; aad bound; every byte tamper-proof'() {
    const { publicKey, privateKey } = generateKeyPair('x25519', { kid: 'app-1' });
    const sealed = sealTo(publicKey, 'tenant secret', { aad: 'secrets.db_password' });
    assert.ok(sealed.startsWith('agora:pk1:app-1:'));
    assert.equal(sealedToKid(sealed), 'app-1');
    assert.equal(sealedToKid('nope'), undefined);
    assert.equal(openWith(privateKey, sealed, { aad: 'secrets.db_password' }), 'tenant secret');
    assert.equal(openWith(privateKey, sealTo(publicKey, ''), {}), '');
    assert.notEqual(sealTo(publicKey, 'x'), sealTo(publicKey, 'x'));
    refusedSync(() => openWith(privateKey, sealed, { aad: 'secrets.other' }), 'unreadable');
    refusedSync(() => openWith(privateKey, sealed), 'unreadable');
    refusedSync(() => openWith(publicKey, sealed, { aad: 'secrets.db_password' }), 'unreadable');
    const stranger = generateKeyPair('x25519', { kid: 'app-1' }).privateKey;
    refusedSync(() => openWith(stranger, sealed, { aad: 'secrets.db_password' }), 'unreadable');
    for (const index of [4, 5, 6]) {
      const length = Buffer.from(sealed.split(':')[index] as string, 'base64url').length;
      for (let byte = 0; byte < length; byte++) {
        refusedSync(
          () =>
            openWith(privateKey, flip(sealed, ':', index, byte), { aad: 'secrets.db_password' }),
          'unreadable',
        );
      }
    }
    // A flipped ephemeral key is a different (or invalid) point: never opens.
    for (let byte = 0; byte < 32; byte += 7) {
      assert.throws(() =>
        openWith(privateKey, flip(sealed, ':', 3, byte), { aad: 'secrets.db_password' }),
      );
    }
    refusedSync(() => openWith(privateKey, `${sealed}:x`), 'format');
    refusedSync(() => openWith(privateKey, 'agora:v1:x'), 'format');
    assert.throws(() =>
      sealTo(privateKey.crv === 'X25519' ? generateKeyPair('ed25519').publicKey : publicKey, 'v'),
    );
  },

  async 'sealTo with rotated keys: openWith finds the private key by kid'() {
    const old = generateKeyPair('x25519', { kid: 'k1' });
    const next = generateKeyPair('x25519', { kid: 'k2' });
    const a = sealTo(old.publicKey, 'a');
    const b = sealTo(next.publicKey, 'b');
    const keys = [next.privateKey, old.privateKey];
    assert.equal(openWith(keys, a), 'a');
    assert.equal(openWith({ keys }, b), 'b');
    refusedSync(() => openWith([next.privateKey], a), 'unreadable');
  },

  async 'sign / verify: Ed25519, JWKS lookup by kid, tamper and wrong key refused'() {
    const k1 = generateKeyPair('ed25519', { kid: 'sig-1' });
    const k2 = generateKeyPair('ed25519', { kid: 'sig-2' });
    const payload = '1731600000.{"event":"user.created"}';
    const signature = sign(k1.privateKey, payload);
    assert.ok(signature.startsWith('agora:sig1:sig-1:'));
    assert.equal(verify(k1.publicKey, payload, signature), true);
    assert.equal(verify(toJwks([k2.privateKey, k1.privateKey]), payload, signature), true);
    assert.equal(verify(Buffer.from(payload) as never, payload, signature), false);
    assert.equal(verify(k1.publicKey, Buffer.from(payload, 'utf8'), signature), true);
    assert.equal(verify(k1.publicKey, `${payload} `, signature), false);
    assert.equal(verify(k2.publicKey, payload, signature), false);
    assert.equal(verify([k2.publicKey], payload, signature), false);
    const sigBytes = Buffer.from(signature.split(':')[3] as string, 'base64url').length;
    for (let byte = 0; byte < sigBytes; byte++) {
      assert.equal(verify(k1.publicKey, payload, flip(signature, ':', 3, byte)), false);
    }
    assert.equal(verify(k1.publicKey, payload, signature.replace(':sig-1:', ':sig-2:')), false);
    assert.equal(verify(k1.publicKey, payload, 'garbage'), false);
    const sigParts = signature.split(':');
    sigParts[3] = twin(sigParts[3] as string);
    assert.equal(verify(k1.publicKey, payload, sigParts.join(':')), false);
    assert.equal(verify(k1.publicKey, payload, `${signature}:x`), false);
    const x = generateKeyPair('x25519', { kid: 'sig-1' });
    assert.equal(verify(x.publicKey, payload, signature), false);
    assert.throws(() => sign(k1.publicKey, payload), /private/);
  },

  async 'private keys at rest: sealed with the symmetric keyring, never plain'() {
    const ring = createKeyring({ keys: [KEY], purpose });
    const { privateKey } = generateKeyPair('ed25519');
    const stored = await sealPrivateKey(ring, privateKey, { aad: 'webhook-signing' });
    assert.ok(!stored.includes(privateKey.d as string));
    assert.deepEqual(await openPrivateKey(ring, stored, { aad: 'webhook-signing' }), privateKey);
    await refused(openPrivateKey(ring, stored), 'unreadable');
  },
};
