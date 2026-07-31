---
"@adonis-agora/authkit-client": minor
---

Amarra o restore da impersonação à sessão que guardou a credencial, e faz a revogação central levá-la junto

**Segurança — leia antes de subir. Impersonações EM VOO caem no upgrade** (ver
"O que acontece no upgrade", no fim).

Dois defeitos, ambos no `AuthkitClientManager`.

**A — `stopImpersonating()` restaurava uma credencial que não sabia atribuir.**
`impersonate()` parqueia o TokenSet INTEIRO do ator — refresh token incluso —
em `${sessionKey}_impersonator`, e a única conferência do restore era se a chave
existia. Como nada na lib limpava essa chave, a credencial sobrevivia à sessão
que a guardou. A cadeia completa: um admin impersona alguém, faz logout, uma
outra identidade loga no MESMO cookie jar e chama o endpoint de stop — e recebe
o TokenSet do admin, mantido vivo indefinidamente pelo `maybeRefresh` a cada
request. Em versões anteriores, **a lib entregava a credencial de impersonação a
quem ficasse com a sessão depois.**

**B — a revogação central deixava a credencial parqueada.**
`BackchannelRevocationMiddleware` fazia `session.forget(sessionKey)` e só. É o
mecanismo que o operador usa para matar uma sessão de fora, e ele deixava o
refresh token do ator parqueado no browser. **Nenhum consumidor conseguia
corrigir isso de fora** — o middleware é da lib. O logout RP-initiated do
`registerOidcClient` tinha o mesmo furo.

**O que mudou.** `impersonate()` gera um nonce e escreve o mesmo valor nos dois
lados: no registro parqueado e dentro do token set ATIVO da sessão
(`TokenSet.impersonationBinding`). O slot ativo é o único que todo caminho de
fim-de-sessão já limpa, então uma troca de identidade apaga o vínculo por
construção — não por convenção. `stopImpersonating()` exige que os dois batam;
`maybeRefresh` propaga o nonce (renovar o token do alvo não muda a sessão, então
não pode trancar o ator). Recusa é **fail-closed**: a credencial órfã é
descartada, nunca devolvida, e o token set da sessão cai junto — uma recusa não
é uma tentativa a repetir, e ninguém fica preso impersonando. Revogação
back-channel e logout passaram a usar `manager.endSession(ctx)`, o único ponto
que conhece as duas chaves.

**Limite honesto**, também no docblock: quem controla o cookie jar DURANTE uma
impersonação ativa continua indistinguível do ator — é literalmente a mesma
sessão. Isso é o modelo de sessão, não esta conferência. O que fecha é a janela
em que a credencial sobrevive à sessão que a guardou.

**O que acontece no upgrade.** Uma sessão parqueada por uma versão anterior não
tem vínculo nenhum — é exatamente a credencial que não dá para atribuir.
`stopImpersonating()` a **recusa e descarta**, e limpa o token set da sessão. Na
prática: **todo admin que estiver impersonando alguém no momento do deploy é
deslogado e precisa entrar de novo.** Nenhum outro usuário é afetado, e não
sobra nada a fazer depois do primeiro ciclo de requests.

A alternativa (restaurar uma vez com aviso) foi descartada: seria devolver
justamente a credencial deste aviso a justamente a parte que não conseguimos
identificar, e num cookie session store "uma vez" é por cookie jar — o atacante
também ganharia a dele. O custo do fail-closed é um login de admin; o da
leniência é manter o furo aberto por uma sessão inteira.

**API.** Nada removido. Novo `AuthkitClientManager.endSession(ctx)` (use no
lugar de `session.forget(sessionKey)` se o seu app derruba a sessão à mão) e
novo campo opcional `TokenSet.impersonationBinding` — gerenciado pela lib; não
escreva nele. Se o seu app escreve o TokenSet direto no `sessionKey` (ex.: um
refresh próprio), preserve esse campo, senão um stop legítimo será recusado
(fail-closed: o ator é deslogado, não travado).
