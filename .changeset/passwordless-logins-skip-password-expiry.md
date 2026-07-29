---
"@adonis-agora/authkit-server": patch
---

Login social, magic link, OTP e passkey não aplicam mais `password_expiration`

**Correção de bloqueio total.** Os fluxos passwordless chamam o gate combinado
`assertLoginAllowed`, e `assertAccountNotExpired` guardava as DUAS checagens de
expiração atrás do mesmo `if (settings)` — não havia como ligar a de conta
inativa sem ligar junto a de senha vencida.

O problema é que `isPasswordExpired` trata `password_changed_at` NULL como
"vencida". Isso é correto no fluxo de senha, que tem o passo de troca
obrigatória (`step: 'password_expired'`) para onde mandar o usuário. Uma conta
que nunca definiu senha — social-only, importada via `importAccount` (que não
escreve a coluna), anterior à migração da coluna — não tem esse passo
alcançável: o único caminho até ele passa por `attemptPasswordLogin`, que exige
a senha CORRETA antes de classificar a expiração.

Resultado, com `password_expiration` ligada: todo usuário sem senha ficava
**permanentemente trancado fora** de "Continue with Google", do magic link, do
OTP e do passkey-first, devolvido a uma tela que não oferece senha nenhuma que
ele pudesse trocar. No passkey-first o beco era ainda mais fechado — a view de
erro (`mfa-challenge`) só oferece o desafio da passkey. Contas social criadas
por esta lib recebem `password_changed_at = now` no `create`, então para elas o
bloqueio não era imediato: chegava sozinho depois de `maxAgeDays` (default 90).

**Correção.** `LoginAllowedInput` ganha `passwordless?: boolean`. Quando `true`,
apenas a checagem de senha vencida é pulada. Os quatro fluxos passwordless
passam a flag; `attemptPasswordLogin` e o token-exchange não, e seguem
inalterados. O default (ausente/`false`) mantém a checagem valendo.

**`account_expiration` (inatividade) continua valendo em todos eles**, incluindo
o login social — o que a versão anterior corrigiu não foi desfeito. A checagem
de conta desabilitada também segue valendo.

`isPasswordExpired` não foi alterado: seu comportamento com a coluna NULL
continua correto para o fluxo de senha, que é quem tem para onde mandar o
usuário.
