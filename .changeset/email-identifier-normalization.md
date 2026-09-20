---
'@adonis-agora/authkit-server': minor
---

fix(authkit-server): uma normalização só para a identidade por e-mail (cadastro e login)

O cadastro validava o e-mail com `.normalizeEmail()` do VineJS — os defaults do
validator.js, que no gmail **removem os pontos e o sub-endereço `+tag`** — enquanto o passo
de identificador do login não normalizava nada e buscava por igualdade exata. Quem se
cadastrou com `davi.carvalho96@gmail.com` teve a conta gravada como
`davicarvalho96@gmail.com` e, ao tentar entrar com o endereço certo, nunca recebia e-mail;
por a tela ser à prova de enumeração, sem nenhuma mensagem de erro. E, por o login ser
sensível a maiúsculas, nem `Davi@x.com` achava `davi@x.com`.

Agora há UMA normalização, conservadora e exportada — `normalizeEmailIdentifier`
(`trim` + `toLowerCase`, nada além disso) —, aplicada no cadastro (com e sem senha), no
"esqueci a senha", na troca de e-mail, na criação de usuário por admin, no convite de
organização, no import de usuários, no cadastro social e **no passo de identificador do
login**, que antes não usava nenhuma.

**Mudança de comportamento observável:** o cadastro passa a gravar o endereço que a pessoa
digitou. `davi.carvalho96@gmail.com` e `davi.carvalho96+lastro@gmail.com` deixam de colapsar
em `davicarvalho96@gmail.com` — são identidades distintas, como em qualquer outro provedor.
Contas já gravadas não são alteradas.

**Compatibilidade:** `login.legacyEmailFallback` (default `true`) é uma ponte temporária —
quando o endereço normalizado não acha conta, o login (OIDC e console de conta) e o
"esqueci a senha" tentam a forma exatamente como digitada e a normalização legada, e só
aceitam se apontarem para **exatamente uma** conta; empate é tratado como "não achei". O
cadastro e o "Continuar com o Google" usam a mesma resolução para não criar uma SEGUNDA
conta para quem já tem uma gravada mutilada. Nada disso muda a tela, a mensagem ou o
comportamento à prova de enumeração. Migre os endereços gravados e desligue a ponte.
