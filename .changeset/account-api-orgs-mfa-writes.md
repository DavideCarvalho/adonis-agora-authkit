---
'@adonis-agora/authkit-server': minor
---

feat(authkit-server): escritas de organização e de segundo fator em JSON (`/account/api/*`)

Um host que desenha as PRÓPRIAS telas de conta não tinha como criar org, convidar, trocar
papel, remover membro, revogar/aceitar convite nem gerenciar TOTP/passkeys sem mandar o
usuário ao console `/account/*`: essas operações só existiam como POST de formulário, com
redirect. As leituras já eram JSON; faltava o outro lado.

- **Orgs**: `POST /account/api/orgs`, `/orgs/deactivate`, `/orgs/invitations/:token/accept`,
  `/orgs/:id/{activate,leave,invitations}`, `DELETE /orgs/:id/invitations/:invId`,
  `PATCH|DELETE /orgs/:id/members/:accountId`. Mesmos guards do formulário (escopo por
  conta, owner/admin na org do path, catálogo de papéis, `owner` só por owner) e a MESMA
  política efetiva — o resolver saiu para `host/org_policy.ts`, compartilhado com o console.
- **Segundo fator**: `POST /account/api/mfa/totp/{enroll,confirm,disable}`,
  `/mfa/recovery-codes` e a cerimônia de passkey em JSON
  (`/mfa/passkeys/{options,verify}`) — a clássica responde 302 e não cabe numa SPA. Mesmos
  gates de sudo do console; a recusa vira `403 sudo_required` em vez de um redirect.
  `requireSudo` passa a delegar a decisão ao novo `isSudoSatisfied`, que é o que o caminho
  JSON consome — uma política só, duas formas de recusar. O `confirm` leva o throttle do
  bucket de sudo (o form não tem; o JSON fica mais apertado, nunca mais frouxo).
- **`MfaCapability`** ganha `countRecoveryCodes` e `regenerateRecoveryCodes` OPCIONAIS
  (capability-probe via `supportsRecoveryCodeCount` / `supportsRecoveryCodeRegeneration`),
  implementados no `lucidAccountStore`. `GET /account/api/mfa` passa a devolver
  `recovery.remaining` e `recovery.regenerable`. Novo evento de auditoria
  `mfa.recovery_codes_regenerated`.

Compatível: o console HTML não muda: rota nova, resposta nova. As rotas JSON são montadas
mesmo com as telas `orgs`/`mfa` desligadas — é justamente o host com telas próprias que
precisa delas.
