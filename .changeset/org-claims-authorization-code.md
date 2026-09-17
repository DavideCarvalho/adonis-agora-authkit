---
"@adonis-agora/authkit-server": patch
---

fix(authkit-server): claims de organização no fluxo authorization code

As claims `org_id`/`org_slug`/`org_role` nunca eram emitidas no fluxo `response_type=code`: a org ativa tem uma única fonte — o cookie do browser — e o `id_token` desse fluxo é emitido no `/oidc/token`, uma requisição **server-a-servidor** do app, sem os cookies do usuário. O `findAccount` lia apenas o cookie, `activeOrg` era `null` e as três claims (opcionais) sumiam em silêncio — o `requireOrg` do `authkit-client` então recusava toda rota de tenant.

A correção persiste a org no **Grant** durante o consent (aí a request é do browser, com o cookie presente) e a lê no mint via `ctx.oidc.entities.Grant.activeOrg`, com o cookie como fallback para fluxos em que o `id_token` sai no próprio authorize. Como o modelo `Grant` do oidc-provider filtra o payload por `IN_PAYLOAD`, a lib estende `IN_PAYLOAD` com `activeOrg` e injeta a subclasse na instância do provider (o oidc-provider v9 não expõe a opção `models`). Grants reaproveitados (consent já lembrado) são reconciliados com o cookie no authorize, para que uma troca de org não fique presa na org antiga até o grant expirar. O leitor do cookie via jar Koa também passou a URL-decodificar o valor, que o `cookies` devolve como está no header.
