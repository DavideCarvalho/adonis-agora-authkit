# @adonis-agora/authkit-vault-gcp

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
