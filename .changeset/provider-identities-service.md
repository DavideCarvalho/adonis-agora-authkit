---
"@adonis-agora/authkit-server": minor
---

`authkit.identities`: API pública para o host ligar uma conta a um provider (Google, GitHub, …) fora do login social, sem tocar no account store cru nem na tabela. `link()` faz o upsert na chave `(provider, providerUserId)`, mudando a identidade de conta se preciso, e devolve `previousAccountId`; `find`/`list`/`unlinkAll` completam. Store sem account linking: `supported === false` e os métodos lançam `ProviderIdentitiesUnsupportedError`.
