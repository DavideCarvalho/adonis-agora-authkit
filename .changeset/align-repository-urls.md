---
'@adonis-agora/authkit-server': patch
'@adonis-agora/authkit-client': patch
'@adonis-agora/authkit-react': patch
'@adonis-agora/authkit-core': patch
'@adonis-agora/authkit-sdk': patch
'@adonis-agora/authkit-testing': patch
'@adonis-agora/authkit-vault-aws': patch
'@adonis-agora/authkit-vault-azure': patch
'@adonis-agora/authkit-vault-gcp': patch
---

Point `homepage` and `bugs.url` at the repository's current name.

The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
`homepage` and `bugs.url` did not. Every package therefore shipped a manifest
that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
on GitHub's rename redirect — which lasts only until someone claims the old
name. All three fields now name the same repository.
