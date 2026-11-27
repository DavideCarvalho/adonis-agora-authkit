---
name: authkit-vault-aws
description: >-
  Persist the managed JWKS signing keystore of @adonis-agora/authkit-server in AWS
  Secrets Manager with @adonis-agora/authkit-vault-aws. Covers installing the package
  plus its optional peer @aws-sdk/client-secrets-manager, selecting it with
  jwks.store { driver: 'aws-secrets-manager', secretId, region? } (the server
  lazy-imports the package; you do not import it in config), the AWS credential chain
  and IAM actions (GetSecretValue, PutSecretValue, CreateSecret), auto-creation of the
  secret on first write, encrypt defaulting to OFF for cloud vaults, and
  createKeystoreVault({ backend }) for SDK-free tests. Use when moving signing keys off
  disk/database into AWS, or when boot fails with "instale o package
  @adonis-agora/authkit-vault-aws".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-vault-aws"
  library_version: "1.0.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-vault-aws/src/vault.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/keys/keystore_manager.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/keys/keystore_vault.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-core/src/types/server_config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/define_config.ts"
  - "DavideCarvalho/adonis-authkit:apps/docs/content/docs/keystore-vaults/aws.mdx"
---

# AWS Secrets Manager keystore vault

With `jwks: { source: 'managed' }`, AuthKit generates, rotates and persists the
**private** signing keystore. This package stores that blob as one AWS Secrets Manager
secret (each rotation is a new secret version). Anyone who can read the secret can
mint tokens your relying parties trust, so scope IAM tightly.

## Setup

```bash
pnpm add @adonis-agora/authkit-vault-aws @aws-sdk/client-secrets-manager
```

`@aws-sdk/client-secrets-manager` (>=3) is an optional peer, imported lazily on first
keystore I/O. Then select the driver — do not import this package in config:

```ts
// config/authkit.ts (excerpt)
import type { AuthServerConfigInput } from '@adonis-agora/authkit-server'

export const jwks: AuthServerConfigInput['jwks'] = {
  source: 'managed',
  algorithm: 'RS256',
  store: {
    driver: 'aws-secrets-manager',
    secretId: 'prod/authkit/jwks',
    region: 'us-east-1', // optional; omitted → SDK default region chain
  },
}
```

Pass it as `defineConfig({ ..., jwks })`. `resolveKeystoreVault` maps the
`aws-secrets-manager` driver to `@adonis-agora/authkit-vault-aws` and wraps it in a
`LazyExternalVault`, which imports the package and calls its `createKeystoreVault(cfg)`
on the first read/write.

Source: `packages/authkit-server/src/keys/keystore_manager.ts` (`CLOUD_DRIVER_PACKAGE`,
`resolveKeystoreVault`), `src/keys/keystore_vault.ts` (`LazyExternalVault`).

## Core patterns

### Pattern 1 — credentials and IAM

No credentials go in AuthKit config: the SDK client is built with `{ region }` only, so
it uses the standard AWS credential chain (env vars, shared config, instance/task
roles, IRSA). The execution role needs, scoped to the secret ARN:

- `secretsmanager:GetSecretValue` — `read()` and the `head()` change token (`VersionId`)
- `secretsmanager:PutSecretValue` — `write()` on rotation
- `secretsmanager:CreateSecret` — only if you let the vault create the secret (below)

Add `kms:Decrypt` / `kms:GenerateDataKey` when the secret uses a customer-managed KMS key.

Source: `src/vault.ts` (`makeAwsBackend`), docs `keystore-vaults/aws.mdx`.

### Pattern 2 — first boot and multi-node rotation

The secret does not have to exist: `read()` returns `null` on
`ResourceNotFoundException` (so the first boot generates a key), and `write()` falls
back to `CreateSecret` when `PutSecretValue` hits a missing secret. `head()` returns
the current `VersionId`, which other nodes poll to hot-reload rotated keys.

Source: `src/vault.ts` (`get`, `put`, `version`).

### Pattern 3 — tests without AWS

`createKeystoreVault` accepts an injectable `backend` that bypasses the SDK entirely:

```ts
import { createKeystoreVault } from '@adonis-agora/authkit-vault-aws'

let stored: string | null = null
const vault = createKeystoreVault({
  secretId: 'test/authkit/jwks',
  backend: {
    get: async () => stored,
    put: async (blob) => {
      stored = blob
    },
    version: async () => (stored ? 'v1' : null),
  },
})

await vault.write('{"keys":[]}')
await vault.read() // '{"keys":[]}'
```

Source: `src/vault.ts` (`SecretBackend`, `AwsVaultConfig.backend`).

## Common mistakes

### HIGH — Driver selected but the SDK peer (or the package) not installed

```bash
# Wrong — only the add-on; the SDK peer is optional and not pulled in
pnpm add @adonis-agora/authkit-vault-aws
```

```bash
# Correct
pnpm add @adonis-agora/authkit-vault-aws @aws-sdk/client-secrets-manager
```

Nothing fails at config load: the vault is lazy, so the error only surfaces on the
first keystore read at boot ("AuthKit keystore: instale o package ..." when the add-on
is missing, a module-not-found from the dynamic import when the SDK is). The signing
key is critical, so it never degrades to an ephemeral key.

Source: `packages/authkit-server/src/keys/keystore_vault.ts` (`LazyExternalVault`).

### HIGH — Read-only IAM policy

```json
{ "Action": ["secretsmanager:GetSecretValue"] }
```

```json
{ "Action": ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:CreateSecret"] }
```

The keystore writes on first boot and on every rotation (`node ace authkit:key rotate`,
scheduled rotation). With read-only access the first boot cannot persist the generated
key and rotations fail. Only a `readOnly: true` secondary instance can run read-only.

Source: `src/vault.ts` (`put`), `packages/authkit-core/src/types/server_config.ts`
(`JwksConfig.readOnly`).

### MEDIUM — Assuming AuthKit also encrypts the blob

```ts no-check
// Implicit — cloud vault drivers default encrypt to false
store: { driver: 'aws-secrets-manager', secretId: 'prod/authkit/jwks' },
```

```ts no-check
// Explicit — also seal with the app's encryption service (APP_KEY)
store: { driver: 'aws-secrets-manager', secretId: 'prod/authkit/jwks' },
encrypt: true,
```

`defaultEncryptForStore` turns encryption on only for `file`/`drive`/`lucid`/`redis`;
for cloud vaults the protection is AWS's KMS at-rest encryption plus IAM. Set
`encrypt: true` if you want AuthKit's own sealing on top (then the app's encryption
key is needed to read the keystore).

Source: `packages/authkit-server/src/define_config.ts` (`defaultEncryptForStore`).

See also: `authkit-idp-setup/SKILL.md` in `@adonis-agora/authkit-server` — the full
`jwks` config surface and the other `store` drivers.
