---
'@adonis-agora/authkit-server': minor
---

Throttle no `/identifier` e escape hatch para o host cuidar das rotas do login.

**Throttle no passo de e-mail.** `POST /auth/interaction/:uid/identifier` era a única rota
do fluxo de login sem rate-limit: o `/magic` (envio do e-mail) já tinha, o passo anterior
não. O fluxo é passwordless, então o risco não é força bruta nem enumeração (a resposta é
uniforme) — é criação ilimitada de estado de interaction por um anônimo. O `identifier`
agora consome o bucket `login` (por IP), o mesmo do `magic`: um login normal gasta 2 dos 10
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
