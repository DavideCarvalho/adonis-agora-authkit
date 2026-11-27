---
name: authkit-vault-gcp
description: >-
  Persist the managed JWKS signing keystore of @adonis-agora/authkit-server in Google
  Cloud Secret Manager with @adonis-agora/authkit-vault-gcp. Covers installing the
  package plus its optional peer @google-cloud/secret-manager, selecting it with
  jwks.store { driver: 'gcp-secret-manager', name: 'projects/{p}/secrets/{s}' } (the
  server lazy-imports the package; you do not import it in config), Application Default
  Credentials and roles/secretmanager.secretVersionManager, the secret that must be
  created beforehand (this vault only adds versions), encrypt defaulting to OFF for
  cloud vaults, and createKeystoreVault({ backend }) for SDK-free tests. Use when moving
  signing keys into GCP, or when the first boot fails NOT_FOUND writing the keystore.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-vault-gcp"
  library_version: "1.0.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-vault-gcp/src/vault.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/keys/keystore_manager.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/keys/keystore_vault.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-core/src/types/server_config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/define_config.ts"
  - "DavideCarvalho/adonis-authkit:apps/docs/content/docs/keystore-vaults/gcp.mdx"
---

# GCP Secret Manager keystore vault

With `jwks: { source: 'managed' }`, AuthKit generates, rotates and persists the
**private** signing keystore. This package stores that blob in one Secret Manager
secret (each rotation adds a secret version). Anyone who can read the secret can mint
tokens your relying parties trust, so scope IAM tightly.

## Setup

```bash
pnpm add @adonis-agora/authkit-vault-gcp @google-cloud/secret-manager
# The secret container must exist before first boot (see Common mistakes)
gcloud secrets create authkit-jwks --replication-policy=automatic --project=acme-123
```

`@google-cloud/secret-manager` (>=5) is an optional peer, imported lazily on first
keystore I/O. Then select the driver — do not import this package in config:

```ts
// config/authkit.ts (excerpt)
import type { AuthServerConfigInput } from '@adonis-agora/authkit-server'

export const jwks: AuthServerConfigInput['jwks'] = {
  source: 'managed',
  algorithm: 'RS256',
  store: {
    driver: 'gcp-secret-manager',
    name: 'projects/acme-123/secrets/authkit-jwks', // full resource name, no /versions
  },
}
```

Pass it as `defineConfig({ ..., jwks })`. `resolveKeystoreVault` maps the
`gcp-secret-manager` driver to `@adonis-agora/authkit-vault-gcp` and wraps it in a
`LazyExternalVault`, which imports the package and calls its `createKeystoreVault(cfg)`
on the first read/write.

Source: `packages/authkit-server/src/keys/keystore_manager.ts` (`CLOUD_DRIVER_PACKAGE`,
`resolveKeystoreVault`), `src/keys/keystore_vault.ts` (`LazyExternalVault`).

## Core patterns

### Pattern 1 — credentials and IAM

No credentials go in AuthKit config: the vault builds `new SecretManagerServiceClient()`
with no options, so it uses Application Default Credentials (metadata server on
GKE/Cloud Run/GCE, `GOOGLE_APPLICATION_CREDENTIALS`, or
`gcloud auth application-default login`). The service account needs
`accessSecretVersion` and `addSecretVersion` on the secret —
`roles/secretmanager.secretVersionManager` covers both.

Source: `src/vault.ts` (`makeGcpBackend`), docs `keystore-vaults/gcp.mdx`.

### Pattern 2 — reads, writes and multi-node rotation

`read()` accesses `${name}/versions/latest` and decodes the payload as UTF-8, returning
`null` on gRPC code 5 (NOT_FOUND — e.g. a secret with no versions yet, so the first
boot generates a key). `write()` is `addSecretVersion({ parent: name })`. `head()`
returns the latest version's resource name, which other nodes poll to hot-reload
rotated keys.

Source: `src/vault.ts` (`get`, `put`, `version`).

### Pattern 3 — tests without GCP

`createKeystoreVault` accepts an injectable `backend` that bypasses the SDK:

```ts
import { createKeystoreVault } from '@adonis-agora/authkit-vault-gcp'

let stored: string | null = null
const vault = createKeystoreVault({
  name: 'projects/test/secrets/authkit-jwks',
  backend: {
    get: async () => stored,
    put: async (blob) => {
      stored = blob
    },
    version: async () => (stored ? 'projects/test/secrets/authkit-jwks/versions/1' : null),
  },
})

await vault.write('{"keys":[]}')
await vault.read() // '{"keys":[]}'
```

Source: `src/vault.ts` (`SecretBackend`, `GcpVaultConfig.backend`).

## Common mistakes

### HIGH — Expecting the vault to create the secret

```bash
# Wrong — booting before the secret container exists: the first read returns null,
# a key is generated, then addSecretVersion fails NOT_FOUND and boot errors
node ace serve
```

```bash
# Correct — create the container once (Terraform/console/gcloud), then boot
gcloud secrets create authkit-jwks --replication-policy=automatic --project=acme-123
```

Unlike the AWS and Azure vaults (which create on first write), `put` only calls
`addSecretVersion` and does not catch NOT_FOUND, so the error propagates.

Source: `src/vault.ts` (`put`).

### HIGH — Pointing `name` at a version or a bare secret id

```ts no-check
// Wrong — the vault appends /versions/latest itself; a short id is not a resource name
store: { driver: 'gcp-secret-manager', name: 'authkit-jwks/versions/latest' },
```

```ts no-check
// Correct — full secret resource name
store: { driver: 'gcp-secret-manager', name: 'projects/acme-123/secrets/authkit-jwks' },
```

`name` is used both as `${name}/versions/latest` for reads and as the `parent` of new
versions, so it must be exactly `projects/{project}/secrets/{secret}`.

Source: `src/vault.ts` (`GcpVaultConfig` JSDoc, `get`, `put`).

### MEDIUM — Assuming AuthKit also encrypts the blob

```ts no-check
// Explicit — also seal with the app's encryption service (APP_KEY)
store: { driver: 'gcp-secret-manager', name: 'projects/acme-123/secrets/authkit-jwks' },
encrypt: true,
```

`defaultEncryptForStore` turns encryption on only for `file`/`drive`/`lucid`/`redis`;
for cloud vaults the default protection is Google's at-rest encryption plus IAM. Set
`encrypt: true` to add AuthKit's own sealing (then the app's encryption key is needed
to read the keystore). Also avoid destroying versions still inside your JWKS grace
window — tokens signed with them stop verifying.

Source: `packages/authkit-server/src/define_config.ts` (`defaultEncryptForStore`).

See also: `authkit-idp-setup/SKILL.md` in `@adonis-agora/authkit-server` — the full
`jwks` config surface and the other `store` drivers.
