---
'@adonis-agora/authkit-server': minor
---

O segundo fator passa a valer no login por link mágico e por código de e-mail

Só o login por senha passava pelo gate de MFA. O link mágico e o código por e-mail
chamavam `completeLogin(..., { amr: ['email'] })` direto, então uma conta com TOTP
confirmado ou passkey registrada entrava apresentando **só o e-mail** — quem tinha
ligado o segundo fator achava ter endurecido a conta, e na prática o link continuava
sendo uma porta de fator único.

Os quatro caminhos de login (senha, link, código e troca forçada de senha) agora
passam pelo mesmo `secondFactorGate`.

No mesmo movimento, a decisão deixou de ser `mfa.enabled` e passou a ser "existe um
fator que esta pessoa consegue apresentar agora?": TOTP confirmado ou ao menos uma
passkey. `enabled` também liga ao registrar uma passkey e **não** desliga ao remover
a última — pela regra antiga, quem registrava uma passkey e depois a removia, sem
nunca ter enrolado TOTP, caía num desafio de código de 6 dígitos impossível de
responder. `getMfaState` ganhou `totp?: boolean` para sustentar a distinção; stores
que não reportam a chave caem no `enabled`, o comportamento de antes.

A tela de desafio recebe `totpAvailable` e esconde o campo de código (e a seção de
códigos de recuperação) quando a conta só tem passkey.

**Quem usa MFA vai notar:** contas com segundo fator que antes entravam direto pelo
link agora veem o desafio. É a correção, não uma regressão.
