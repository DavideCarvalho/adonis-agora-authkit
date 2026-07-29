---
"@adonis-agora/authkit-server": minor
---

`admin.impersonation` vira um interruptor de verdade — antes era um controle que não fazia nada

**O que estava errado.** `admin.impersonation` aparecia como um controle
nomeado da lib, mas não existia como entrada de config: `AdminConfigInput`
declarava só `enabled` e `roles`, e `resolveAdmin` devolvia
`impersonation: false` HARDCODED, ignorando qualquer input. As consequências
eram as duas piores possíveis, cada uma no sentido oposto:

- **O painel de impersonation do console admin era código morto.**
  `console_impersonation_controller.ts` recusa com 404 quando
  `!cfg.admin.impersonation` — e como a flag era sempre `false`, ninguém no
  mundo conseguia habilitar aquele endpoint.
- **O grant de impersonation era sempre ligado, sem interruptor.** O grant
  RFC 8693 `urn:ietf:params:oauth:grant-type:token-exchange` era registrado
  INCONDICIONALMENTE no provider (`src/provider/oidc_service.ts`), independente
  da flag. Um operador que lesse `admin.impersonation` acreditaria, com toda a
  razão, poder governar impersonation. Não podia: não havia como desligar.

**O que mudou.** `impersonation?: boolean` agora é declarável no
`defineConfig({ admin: { … } })`, é lido pelo `resolveAdmin` e governa as DUAS
superfícies com uma única declaração: com `false`, o grant token-exchange
deixa de ser registrado no provider (o token endpoint responde
`unsupported_grant_type`, o grant não existe) E o painel do console responde
404. É um kill switch, não um esconde-UI.

Declarar a chave também trava a setting de runtime `admin_impersonation`
(config vence, a UI/Admin API não altera mais o valor) — o lock já existia em
`src/host/config_locks.ts` mas apontava para uma chave que o tipo não permitia
escrever.

**O default é `true`: NENHUM host existente muda de comportamento.** O grant
sempre foi registrado incondicionalmente, e há hosts que o consomem a partir do
PRÓPRIO `/admin`, sem montar o console desta lib. Um default `false` os
quebraria em runtime, em silêncio — o grant simplesmente sumiria. Então o
default preserva exatamente o comportamento de hoje.

**Quem quer impersonation desligada agora tem de dizer isso explicitamente:**

```ts
defineConfig({
  admin: { enabled: true, impersonation: false },
})
```

**Deferido para um major:** virar o default para `false`
(secure-by-default). É uma quebra de comportamento em runtime para hosts que
nunca declararam a chave, e não cabe num minor.
