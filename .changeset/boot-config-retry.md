---
"@adonis-agora/authkit-server": patch
---

O config que não resolve no `boot()` do provider é tentado de novo no `booted`, em vez de ser descartado em silêncio.

Num host com keystore criptografado, o `jwks` precisa do serviço de encryption, que pode ainda não estar pronto durante o boot dos providers. A resolução falhava, o catch engolia o erro, e nada derivado do config valia: os locks de settings, o stash que o `registerAuthHost` lê (`sudo.methods`, headless, personal agents) e o `config.routes`. Agora a resolução é refeita no `booted`, depois de todos os providers e antes do preload `start/routes.ts`. Se falhar de novo, vira um warning.
