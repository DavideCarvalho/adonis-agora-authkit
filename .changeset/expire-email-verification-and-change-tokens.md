---
"@adonis-agora/authkit-server": minor
---

Adiciona expiração aos tokens de verificação de e-mail (cadastro) e de troca de e-mail — antes válidos para sempre

**Segurança.** `emailVerificationToken` (verificação de cadastro) e o token
`ec:` de troca de e-mail nunca expiravam — eram os únicos tokens desta lib sem
janela de validade (reset de senha: 1h; magic link: 15min; OTP: janela
configurável). Isso importa mais para a troca de e-mail, porque
`confirmEmailChange` REESCREVE o identificador de recovery da conta (o e-mail
usado por reset de senha e magic-link login); um link de confirmação enviado
anos atrás, esquecido numa caixa de entrada antiga, continuava funcionando
hoje.

**Correção.** A deadline (`exp`, epoch ms) agora vai embutida DENTRO do
próprio token, não numa coluna nova — esta lib não é dona da tabela `users`
(ver header de `src/schema/ensure.ts`), então não pode adicionar uma coluna
`emailVerificationExpiresAt` como o reset de senha tem. Isso só é seguro
porque o token já é hasheado em repouso (mesma mudança que fechou o
plaintext-at-rest para reset/magic-link): o lookup reconstrói o valor de DB a
partir do token bruto recebido e busca por IGUALDADE — se o `exp` for
adulterado pelo cliente, o valor reconstruído não bate com nenhuma linha, e é
esse MATCH (não uma assinatura separada) que prova que o `exp` não foi
mexido. Um `exp` ausente ou não-parseável conta como EXPIRADO (fail-closed),
o mesmo padrão já usado no reset de senha (`!row.passwordResetExpiresAt || ...`).
Como efeito colateral de reusar o hashing, o token `ec:` também deixa de ser
gravado em claro na coluna `emailVerificationToken`.

As duas janelas de validade são configuráveis via `emailTokens` nas opções do
`lucidAccountStore`/`lucidStores` (`verificationTtlHours`, default 24h;
`changeTtlHours`, default 1h — mesma janela do reset de senha, por reescrever
o identificador de recovery).

**Consequência da atualização:** todo link de verificação de e-mail ou de
troca de e-mail pendente no momento do upgrade passa a ser recusado —
tokens gravados por versões anteriores não carregam `exp` nenhum, e a
ausência conta como expirado (deliberado, não é regressão). Usuários no meio
desses fluxos precisam solicitar um novo link. **Nenhuma migração no host é
necessária** — a deadline vive dentro do valor já gravado na coluna
existente, não numa coluna nova.
