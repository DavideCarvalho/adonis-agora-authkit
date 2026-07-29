---
"@adonis-agora/authkit-server": patch
---

Ativa de fato o gate de status no token-exchange (impersonation) — ele estava INERTE

**Segurança.** A mudança anterior (ver
`gate-account-status-passwordless-logins`) adicionou um `accountStore` opcional
a `TokenExchangeDeps` e uma checagem de status do `requested_subject` dentro de
`src/provider/token_exchange.ts`. A lógica estava correta e coberta por teste —
mas o ÚNICO call site de produção, `registerTokenExchange(provider, { … })` em
`src/provider/oidc_service.ts`, nunca passava esse campo. Como o campo é
opcional e degrada para "permitido" quando ausente (de propósito, para não
quebrar hosts com stores mínimos), **a metade token-exchange daquela mudança
nunca rodou no servidor de verdade**: um admin continuava conseguindo
impersonar uma conta que acabara de desabilitar e receber um `access_token` e
um `id_token` plenamente funcionais.

Se você rodou uma versão publicada com aquele changeset e sem este, o gate de
impersonation estava inerte nela.

**Correção.** `oidc_service.ts` agora repassa `accountStore: config.accountStore`
para `registerTokenExchange`. Nenhuma outra mudança de comportamento: o gate
segue capability-probed (`supportsAccountStatus`), então hosts cujo
`accountStore` não implementa a capacidade de status continuam permitindo o
token-exchange exatamente como antes.

**Consequência da atualização:** um token-exchange cujo `requested_subject` é
uma conta desabilitada passa a ser recusado com `invalid_grant` — onde antes
mintava tokens.

**Nota de teste (a lição real).** O teste que existia construía o objeto de
deps na mão e passava `accountStore` ele mesmo, então passava com ou sem o
wiring de produção — foi exatamente assim que o gap sobreviveu. O teste
adicionado aqui sobe o `OidcService` real e bate no endpoint `/token`, e falha
se o wiring for removido. Dependência opcional que degrada para permissiva
precisa de teste na raiz de composição, não só no consumidor.
