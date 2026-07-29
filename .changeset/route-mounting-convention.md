---
"@adonis-agora/authkit-server": minor
---

Uma convenção só de montagem de rotas: config E função, com uma regra de precedência

**A regra, em uma frase:** argumento omitido HERDA do config; chaves
ESTRUTURAIS (`mountPath`, prefixos, quais telas montar, `accountLoginUrl`) o
argumento vence; chaves de POLÍTICA (`social`, `rateLimit`, `sudoMethods` e o
liga/desliga de `admin`/`adminApi`) o **config vence e trava** quando o
`defineConfig` as declara — um `start/routes.ts` não pode afrouxar o que o
arquivo de config permite, senão o config deixa de ser auditável.

**A mudança de comportamento mais provável de surpreender:** argumentos
omitidos agora herdam do config em vez de caírem no default da lib. Em
concreto, `config.sudo.methods` passa a decidir também o que é **MONTADO** —
antes decidia só o que a tela oferecia e o que os handlers aceitavam, e a lista
tinha de ser repetida em `registerAuthHost(router, { sudoMethods })`. Se você
mantinha as duas listas, pode apagar a do `start/routes.ts`. Se elas
divergiam, o que vale agora é a do config (era ela que já valia em runtime; o
que mudava era só quais endpoints existiam, e os que sobravam falhavam
fechados). Passar `sudoMethods` na chamada com `config.sudo.methods` presente
passa a ser ignorado, com aviso nomeando a chave.

**Novidades:**

- `defineConfig({ routes })` — auto-montagem opcional. `true` ou um objeto faz
  o provider montar as rotas no boot chamando **a mesma** `registerAuthHost`
  exportada (não há segunda implementação); ausente ou `false` mantém o
  comportamento atual (você chama no `start/routes.ts`). Auto-montar E chamar à
  mão agora lança um erro explicando qual dos dois remover, em vez do
  `route name already exists` do AdonisJS.
- `registerAuthHost` devolve o `AuthHostRouteMap` resolvido (prefixos, path de
  cada tela do console de conta, base da JSON API, telas montadas, rotas
  nomeadas, métodos de sudo montados). Entregue-o ao frontend — um override de
  `accountRoutes.paths` era meio recurso enquanto os `href`s do React tinham de
  ser atualizados à mão.
- Divergências de política aparecem em `AuthHostRouteMap.overriddenByConfig` e
  como `console.warn` no boot; nunca são ignoradas em silêncio.
