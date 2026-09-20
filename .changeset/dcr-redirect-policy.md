---
'@adonis-agora/authkit-server': minor
---

feat(authkit-server): política de redirect URI no registro dinâmico (RFC 7591/7592)

O `/reg` aceitava qualquer redirect sintaticamente válido (qualquer `https://`): com
registro aberto, qualquer um registrava um client com callback no próprio domínio e
usava a tela de consent do IdP como isca. Nova opção
`dynamicRegistration.redirectUriPolicy` (`loopback`, `exact`, `appSchemes`, `anyHttps`),
aplicada antes do provider no `POST /reg` e no `PUT /reg/:id`, que também restringe o
client ao fluxo de código (`authorization_code` + `refresh_token`, `response_type=code`)
e registra clientes só-loopback/app instalado como `application_type: native`. Gancho
`dynamicRegistration.validateRegistration` para regras do host (`RegistrationPolicyError`
→ `400`).

**Mudança de default:** registro **aberto** (sem `initialAccessToken`) passa a aceitar só
redirects loopback (`http://localhost|127.0.0.1|[::1]`, qualquer porta). Callbacks web de
fornecedores e esquemas de app precisam ser listados em `exact`/`appSchemes`
(`anyHttps: true` ou `redirectUriPolicy: false` restauram o comportamento anterior).
Registro com `initialAccessToken` não muda.
