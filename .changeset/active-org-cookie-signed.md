---
'@adonis-agora/authkit-server': patch
---

fix(authkit-server): cookie de org assinado não era verificado no contexto Koa

O host grava o cookie `authkit_active_org` via `ctx.response.cookie`, e o AdonisJS
o **assina** (`s:<base64url>.<hmac>`, `MessageVerifier`). As duas leituras no
contexto do oidc-provider liam o valor cru e só tentavam URL-decode, então o
envelope assinado não parseava e a org era descartada:

- `readActiveOrgFromKoaCtx` — usada por `loadExistingGrant` no authorize.
- `readActiveOrgFromHostCtx` — no caminho Koa (o caminho Adonis já desassina sozinho).

Efeito: `loadExistingGrant` nunca reconciliava o `activeOrg` do Grant. Como o
consent só roda **uma vez por grant**, quem ativava a organização **depois** do
primeiro login não recebia `org_id`/`org_slug`/`org_role` no token — e
`/o/:orgSlug/...` (protegida pelo `requireOrg`) redirecionava de volta para a
escolha de organização, indefinidamente.

O leitor agora **verifica a assinatura** com a `appKey` antes de aceitar o valor:
HMAC-SHA256 sobre o payload, `purpose` = nome do cookie, comparação em tempo
constante. Sem a chave o valor assinado é recusado — este cookie decide a claim de
organização, e aceitar um valor não verificado deixaria o usuário trocar de tenant
forjando o cookie. As formas crua e URL-encoded continuam aceitas para hosts que
não assinam.