---
"@adonis-agora/authkit-server": patch
---

Os redirects que a lib monta com query (`return_to` do login e do sudo, convite de organização) saíam quebrados em apps com `redirect.forwardQueryString: true`, o default do starter do AdonisJS.

O `response.redirect(url)` colava a query da request atual no fim da URL que já tinha a dela: `/login?return_to=%2Fx%3Fa%3D1?a=1`. Agora esses redirects vão exatamente como a lib os monta (`redirect().clearQs().toPath(url)`). O argumento `forwardQueryString = false` do `redirect()` não bastava, porque não desliga o que vem do config.
