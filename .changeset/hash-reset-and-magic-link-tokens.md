---
"@adonis-agora/authkit-server": minor
---

Hasheia (sha256) os tokens de reset de senha e magic link em repouso — antes eram gravados em texto claro

**Segurança.** `passwordResetToken` guardava reset de senha, magic link (`ml:`)
e magic link com OTP (`ml2:`) EM TEXTO CLARO, e as três leituras eram por
igualdade/`LIKE` direto contra esse valor. Qualquer leitura da tabela de
usuários — um dump de backup, uma réplica de leitura, uma ferramenta de
suporte, um DBA, ou um SQL injection no host — devolvia credenciais
diretamente usáveis para logar como (ou resetar a senha de) qualquer conta com
um token pendente. O token de desbloqueio OTP, na MESMA coluna, já seguia o
padrão correto (`prefix + sha256(raw)`); reset e magic link eram os únicos
fluxos fora do padrão.

**Correção.** Os três fluxos agora armazenam `prefix + sha256(<parte
aleatória>)` em vez do token bruto:

- Reset de senha: sem prefixo, armazena só o hash.
- Magic link (`ml:`): o prefixo `ml:` continua em CLARO — só a parte aleatória
  é hasheada.
- Magic link com OTP (`ml2:`): o slot é um composto
  (`ml2:<linkToken>:<codeHash>:<codeExpMs>:<attempts>`) parseado pelo código e
  buscado por `LIKE` de prefixo (a URL carrega só `ml2:<linkToken>`, não o
  slot inteiro). Só o segmento `linkToken` é hasheado; `codeHash` já era
  `sha256(uid:code)` e não é re-hasheado.

Os guards de discriminação de fluxo (`consumePasswordResetToken` recusando
`ml:`/`ml2:`; `consumeMagicLinkToken` recusando o que não é `ml:`) continuam
funcionando — eles leem o prefixo, que permanece em texto claro.

**Consequência da atualização:** links de reset de senha e magic links
pendentes na hora do deploy são invalidados (o valor gravado muda de formato).
O raio de impacto é limitado — reset expira em 1h, magic link em 15min — então
na prática só afeta quem tinha um link em voo no momento exato do deploy;
basta pedir um novo.
