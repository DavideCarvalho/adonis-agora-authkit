---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-core': minor
'@adonis-agora/authkit-react': minor
'@adonis-agora/authkit-sdk': minor
---

Read-only keystore: `jwks: { source: 'managed', store, readOnly: true }` lets a second authkit-server serve the same identity (same keystore, same `auth_settings`) under another issuer while only the first one writes the keys. A read-only instance never runs the scheduled rotation and picks up the writer's rotations through the reload poll. Rotate, generate, retire and reseal throw `KeystoreReadOnlyError` (`E_KEYSTORE_READ_ONLY`): `authkit:key generate|rotate|retire` and `authkit:crypto:reseal` exit 1 (their `--dry-run` still works), the Admin API and the console answer `409 keystore_read_only`, and the console's Keys page hides those actions (`GET /keys` returns `readOnly: true`). The `key_rotation` setting reads but can't be changed there (`409 keystore_read_only`). At boot it reads the keystore and fails with `KeystoreUnavailableError` (`E_KEYSTORE_UNAVAILABLE`) when it's missing or doesn't open: it never creates a key or a table. `agora:doctor` adds the **Keystore read-only** check. `authkit:settings:unset` now exits 1 when it refuses a locked key (it used to print the refusal and exit 0, and for a key locked by `defineConfig` it reported "not set").
