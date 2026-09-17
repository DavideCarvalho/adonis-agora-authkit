---
'@adonis-agora/authkit-server': patch
---

fix(authkit-server): cookie de org assinado chega URL-encoded no contexto Koa

Complemento do fix anterior (0.68.3). A verificação da assinatura checava
`startsWith('s:')` no valor **cru**, mas o jar Koa do oidc-provider devolve o valor
como está no header — **sem URL-decode** — e o browser reenvia o cookie exatamente
como o host o escreveu. Na prática chega `s%3A<b64>.<hmac>`, então a checagem nunca
casava e a org continuava sendo descartada: o `loadExistingGrant` seguia sem
reconciliar o `activeOrg`.

O leitor agora **normaliza antes de decidir o formato** (tenta `decodeURIComponent`
e só então checa o prefixo assinado). Confirmado contra o cookie real do app, com a
`APP_KEY` real:

```
raw (como no header): s%3AeyJtZXNzYWdlIjoib3JnLWZtby1kZW1v…
SEM appKey : null
COM appKey : { orgId: 'org-fmo-demo', orgSlug: 'demo', orgRole: 'owner' }
```

O teste ganhou o caso da forma URL-encoded, que é a que o browser de fato envia.
