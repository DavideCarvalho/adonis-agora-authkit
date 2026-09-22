---
'@adonis-agora/authkit-server': minor
---

O login com segundo fator passa a emitir `amr` com o fator primário

Quando o login passava pelo desafio do segundo fator, `mfaVerify` só passava acr/amr ao
`completeLogin` no step-up. Fora dele o `id_token` saía **sem `amr` nenhum** (o relying
party não tinha como saber que houve MFA), e o fator primário (senha `pwd` ou e-mail
`email`) se perdia até no step-up, que emitia só `['mfa', <método>]`.

O `secondFactorGate`, ponto de entrada comum dos quatro caminhos (senha, link mágico,
código por e-mail, troca forçada de senha), passa a guardar o fator primário na sessão
junto do accountId pendente. TOTP, recovery code e passkey como segundo fator completam
com `amr: [primário, 'mfa', método]` (ex.: `['pwd', 'mfa', 'totp']`,
`['email', 'mfa', 'webauthn']`). O step-up continua carimbando o `acr`. Passkey-first
continua `['webauthn']`.

Quem comparava `amr` do step-up por igualdade exata (`['mfa', 'totp']`) deve passar a
checar pertinência (`amr.includes('mfa')`).
