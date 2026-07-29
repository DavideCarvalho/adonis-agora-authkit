---
"@adonis-agora/authkit-server": minor
---

Aplica a política `account_expiration` também no login social — antes só `disabled` valia ali

**Segurança.** O callback do login social (`AuthSocialController#callback`)
chamava o gate de status compartilhado (`assertLoginAllowed`) **sem
`settings`**. Como `assertAccountNotExpired` guarda as duas checagens de
expiração atrás de `if (settings)`, o login social aplicava `disabled` e nada
mais. Uma conta bloqueada pela política `account_expiration` (não loga há mais
de `inactiveDays`) continuava entrando pelo "Continue with Google" — a política
valia no login por senha, magic link, OTP e passkey, e falhava exatamente no
caminho em que ninguém olha. Um operador que liga `account_expiration` acredita
que ela vale em todos os caminhos de login.

**Correção.** O callback agora resolve os runtime settings pelo caminho
canônico e os passa ao gate. O helper NON-NULL que faz isso
(`resolveRuntimeSettings` + degradação para um `RuntimeSettings` no-op) era
privado do `interaction_controller`; foi movido para
`src/host/runtime_settings.ts` como `resolveRuntimeSettingsOrNoop` e agora é
compartilhado pelos dois controllers, em vez de copiado.

**Consequência da atualização:** contas expiradas pela política
`account_expiration` deixam de completar o login social — onde antes
conseguiam. O evento de auditoria `account.expired_login_blocked` passa a ser
emitido também por este caminho.

**`password_expiration` não passa a valer aqui — de propósito.** Nenhuma senha é
usada no login social e este controller não renderiza a etapa de troca
obrigatória (`step: 'password_expired'`): o único caminho até ela passa por
`attemptPasswordLogin`, que só classifica a expiração DEPOIS de a senha correta
ser verificada. Recusar por senha vencida num fluxo sem senha não teria para
onde mandar o usuário, então o callback passa `passwordless: true` ao gate e
apenas essa checagem é pulada. O que este caminho aplica é `disabled` e a
expiração de conta por inatividade.

**Hosts sem a tabela `auth_settings` não são afetados:** a resolução degrada
para um `RuntimeSettings` no-op, toda leitura vira null e o comportamento é
idêntico ao anterior (login social conclui normalmente).
