---
'@adonis-agora/authkit-server': minor
---

Throttle no `/identifier` e escape hatch para o host cuidar das rotas do login.

**Throttle nos passos anônimos do login.** `POST /auth/interaction/:uid/identifier` e
`POST /auth/interaction/:uid/passkey/options` eram as duas rotas do fluxo sem rate-limit: o
`/magic` (envio do e-mail) já tinha, os passos anteriores não. O fluxo é passwordless, então o risco não é força bruta nem enumeração (a resposta é
uniforme) — é criação ilimitada de estado de interaction por um anônimo. Os dois agora
consomem o bucket `login` (por IP), o mesmo do `magic`: um login normal gasta 2 a 3 dos 10
pontos por minuto.

**Rotas exportadas.** `registerAuthHost()` passou a devolver, no `AuthHostRouteMap`:

- `routes`: handle do AdonisJS de cada rota do fluxo (`identifier`, `magic`, `consent`, …),
  para pendurar middleware depois do registro;
- `urls`: o pattern de cada uma, e `interactionUrl(key, uid)` para a URL concreta;
- `extraMiddleware`: opção para declarar middleware por rota (aplicado **depois** do
  throttle da lib), sem precisar de fork.

```ts
registerAuthHost(router, {
  extraMiddleware: {
    identifier: [throttle({ limit: 5, window: '1 minute' })],
  },
})
```

Não é opção de política: não é travada pelo `defineConfig` e não substitui o limite
padrão — soma-se a ele.
