# @adonis-agora/authkit-vault-azure

## 0.4.0

### Minor Changes

- [#269](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/269) [`b0ca480`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/b0ca4802419aba93a9f913775f697cc4075cff88) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node 20, which reached end-of-life on 2026-04-30, and Node 22, which AdonisJS 7 does not support (it requires Node >=24): `engines.node` is now `>=24`. The supported Node lines are 24 and 26, and CI runs the test suite on each of them.

## 0.3.1

### Patch Changes

- 1f15367: Point `homepage` and `bugs.url` at the repository's current name.

  The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
  `homepage` and `bugs.url` did not. Every package therefore shipped a manifest
  that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
  on GitHub's rename redirect — which lasts only until someone claims the old
  name. All three fields now name the same repository.

## 0.3.0

### Minor Changes

- 0542665: Re-scope to @adonis-agora/authkit-\* (join the Agora ecosystem)

## 0.2.0

### Minor Changes

- a39352e: feat: packages de cofre do keystore JWKS para AWS Secrets Manager, GCP Secret Manager
  e Azure Key Vault. Cada um exporta `createKeystoreVault(cfg)`; o SDK da cloud é peer
  OPCIONAL (lazy-import). Consumidos pelo authkit-server via o driver `jwks.store`.
