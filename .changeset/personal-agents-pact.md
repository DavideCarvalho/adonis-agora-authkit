---
"@adonis-agora/authkit-server": minor
---

Personal agents: assistentes de IA (ChatGPT, Meta AI, um agente próprio…) que falam com o app em nome de um usuário, com o PACT 1.0 (https://openpactprotocol.org) como protocolo embutido.

Desligado por default; liga com `personalAgents` no `defineConfig`.

- **Identidade do agente**: JWT assinado pela chave do agente e verificado pelo JWKS dele, sem segredo compartilhado (ES256/RS256, vida ≤ 300 s, 30 s de relógio, `aud` único). Os agentes vêm de uma lista estática, de uma função (registro no banco) ou, com `open: true`, de qualquer `iss` com OIDC discovery.
- **Delegação** (`personalAgents.delegation`): device flow RFC 8628 em que o cliente OAuth é o agente. O usuário loga NESTE app e aprova os scopes do app em checkboxes que pode desmarcar. A tela recusa durante impersonation. O agente recebe um token assinado pelo keystore do IdP, preso ao agente e ao usuário do agente, com refresh rotativo. Aprovar de novo (step-up) soma scopes ao grant existente.
- **Revogação imediata** no console de conta (`/account/apps`) e na JSON API (`/account/api/agents`). Apagar ou desabilitar a conta corta a delegação do mesmo jeito, assim como toda revogação total (sair de todas as sessões, reset de senha, revogação pelo admin) — o `RevokeResult` ganha `agentGrants`. Reusar um refresh token já gasto revoga o grant (RFC 9700). Auditoria: `agent.delegation_approved`, `agent.delegation_denied`, `agent.grant_revoked`.
- **Tela de consentimento** protegida por CSRF, com rate limit por IP (bucket do OTP) e sem poder ser emoldurada (`X-Frame-Options: DENY`). Delegação com keystore sem chave ES256/RS256 falha no boot.
- **Rotas do app**: `personalAgentAuth()` protege o endpoint que os agentes chamam e `personalAgentOf(ctx)` devolve o agente e a delegação. `personalAgentSecurity`, `personalAgentStepUp` e `personalAgentReceipt` geram o bloco do Agent Card, o metadata de step-up e o recibo assinado.
- **Protocolo plugável** (`personalAgents.protocol`): o núcleo não depende do fio. `'pact'` é o default e o `pactProtocol` exportado serve de referência para um adapter próprio.
- **Schema**: três tabelas novas da lib no `ensureAuthkitSchema`: `auth_agent_device_codes`, `auth_agent_grants` e `auth_agent_refresh_tokens`.
- **CSRF**: `authkitCsrfExceptions` isenta `{prefix}/oauth/*` sozinho quando `personalAgents` está ligado. A opção nova `personalAgentsPrefix` sobrepõe isso; `false` desliga.
