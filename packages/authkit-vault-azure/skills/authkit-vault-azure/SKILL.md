---
name: authkit-vault-azure
description: >-
  Persist the managed JWKS signing keystore of @adonis-agora/authkit-server in Azure
  Key Vault with @adonis-agora/authkit-vault-azure. Covers installing the package plus
  its two optional peers @azure/keyvault-secrets and @azure/identity, selecting it with
  jwks.store { driver: 'azure-key-vault', vaultUrl, secretName } (the server
  lazy-imports the package; you do not import it in config), DefaultAzureCredential and
  the Get+Set secret permissions (Key Vault Secrets Officer), auto-creation of the
  secret on first write, encrypt defaulting to OFF for cloud vaults, and
  createKeystoreVault({ backend }) for SDK-free tests. Use when moving signing keys into
  Azure Key Vault, or when boot fails with "instale o package
  @adonis-agora/authkit-vault-azure".
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-vault-azure"
  library_version: "1.0.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-vault-azure/src/vault.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/keys/keystore_manager.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/keys/keystore_vault.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-core/src/types/server_config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/define_config.ts"
  - "DavideCarvalho/adonis-authkit:apps/docs/content/docs/keystore-vaults/azure.mdx"
---

# Azure Key Vault keystore vault

With `jwks: { source: 'managed' }`, AuthKit generates, rotates and persists the
**private** signing keystore. This package stores that blob as one Azure Key Vault
secret (each rotation is a new secret version). Anyone who can read the secret can
mint tokens your relying parties trust, so scope access tightly.

## Setup

```bash
pnpm add @adonis-agora/authkit-vault-azure @azure/keyvault-secrets @azure/identity
```

Both Azure SDKs (>=4) are optional peers, imported lazily on first keystore I/O. Then
select the driver — do not import this package in config:

```ts
// config/authkit.ts (excerpt)
import type { AuthServerConfigInput } from '@adonis-agora/authkit-server'

export const jwks: AuthServerConfigInput['jwks'] = {
  source: 'managed',
  algorithm: 'RS256',
  store: {
    driver: 'azure-key-vault',
    vaultUrl: 'https://acme-authkit.vault.azure.net',
    secretName: 'authkit-jwks',
  },
}
```

Pass it as `defineConfig({ ..., jwks })`. `resolveKeystoreVault` maps the
`azure-key-vault` driver to `@adonis-agora/authkit-vault-azure` and wraps it in a
`LazyExternalVault`, which imports the package and calls its `createKeystoreVault(cfg)`
on the first read/write.

Source: `packages/authkit-server/src/keys/keystore_manager.ts` (`CLOUD_DRIVER_PACKAGE`,
`resolveKeystoreVault`), `src/keys/keystore_vault.ts` (`LazyExternalVault`).

## Core patterns

### Pattern 1 — credentials and permissions

No credentials go in AuthKit config: the vault builds
`new SecretClient(vaultUrl, new DefaultAzureCredential())`, so it resolves through the
standard Azure chain (environment variables, managed identity / AKS workload identity,
Azure CLI locally). The identity needs **Get** and **Set** on secrets — with Key Vault
RBAC that is `Key Vault Secrets Officer` (`Key Vault Secrets User` is read-only); with
access policies, grant secret `get` + `set`.

Source: `src/vault.ts` (`makeAzureBackend`), docs `keystore-vaults/azure.mdx`.

### Pattern 2 — first boot and multi-node rotation

The secret does not have to exist: `read()` returns `null` on HTTP 404 /
`SecretNotFound` (so the first boot generates a key), and `write()` is `setSecret`,
which creates the secret or adds a new version. `head()` returns
`properties.version`, which other nodes poll to hot-reload rotated keys.

Source: `src/vault.ts` (`get`, `put`, `version`).

### Pattern 3 — tests without Azure

`createKeystoreVault` accepts an injectable `backend` that bypasses both SDKs:

```ts
import { createKeystoreVault } from '@adonis-agora/authkit-vault-azure'

let stored: string | null = null
const vault = createKeystoreVault({
  vaultUrl: 'https://test.vault.azure.net',
  secretName: 'authkit-jwks',
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

Source: `src/vault.ts` (`SecretBackend`, `AzureVaultConfig.backend`).

## Common mistakes

### HIGH — Installing only one of the two Azure SDK peers

```bash
# Wrong — @azure/identity missing: the credential import fails at first keystore read
pnpm add @adonis-agora/authkit-vault-azure @azure/keyvault-secrets
```

```bash
# Correct
pnpm add @adonis-agora/authkit-vault-azure @azure/keyvault-secrets @azure/identity
```

The client is built lazily from both modules, so config loads fine and the failure
only surfaces when boot first reads the keystore. A missing add-on itself throws
"AuthKit keystore: instale o package ..."; the signing key never degrades to an
ephemeral one.

Source: `src/vault.ts` (`makeAzureBackend` imports both specs),
`packages/authkit-server/src/keys/keystore_vault.ts` (`LazyExternalVault`).

### HIGH — Read-only role (`Key Vault Secrets User`)

The keystore writes on first boot and on every rotation (`node ace authkit:key rotate`,
scheduled rotation). With Get-only access the generated key cannot be persisted and
rotations fail. Only a `jwks.readOnly: true` secondary instance can run with Get alone.

Source: `src/vault.ts` (`put` → `setSecret`),
`packages/authkit-core/src/types/server_config.ts` (`JwksConfig.readOnly`).

### MEDIUM — Assuming AuthKit also encrypts the blob

```ts no-check
// Implicit — cloud vault drivers default encrypt to false
store: { driver: 'azure-key-vault', vaultUrl, secretName: 'authkit-jwks' },
```

```ts no-check
// Explicit — also seal with the app's encryption service (APP_KEY)
store: { driver: 'azure-key-vault', vaultUrl, secretName: 'authkit-jwks' },
encrypt: true,
```

`defaultEncryptForStore` turns encryption on only for `file`/`drive`/`lucid`/`redis`;
for cloud vaults the protection is Key Vault's at-rest encryption plus RBAC. Set
`encrypt: true` to add AuthKit's own sealing (then the app's encryption key is needed
to read the keystore).

Source: `packages/authkit-server/src/define_config.ts` (`defaultEncryptForStore`).

See also: `authkit-idp-setup/SKILL.md` in `@adonis-agora/authkit-server` — the full
`jwks` config surface and the other `store` drivers.
