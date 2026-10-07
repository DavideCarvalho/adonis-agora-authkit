---
"@adonis-agora/authkit-server": patch
---

O redirect para o login (e para a confirmação de sudo) perdia a query string do `return_to` no AdonisJS 7.

O código lia `request.parsedUrl.search`, que o AdonisJS 7 não tem mais (`parsedUrl` virou `{ pathname, query }`). Quem caía no login a partir de `/admin/users?page=3` voltava para `/admin/users`. Agora o destino vem de `request.url(true)`, a API que inclui a query.
