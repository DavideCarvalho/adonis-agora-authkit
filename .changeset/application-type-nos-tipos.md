---
'@adonis-agora/authkit-core': minor
'@adonis-agora/authkit-react': minor
---

`applicationType?: 'web' | 'native'` nos tipos de client

`ClientConfig` (core) e `AdminClient`/`CreateClientInput` (react) ganham o campo opcional
`applicationType`, para os clientes nativos (RFC 8252) do `@adonis-agora/authkit-server`.
