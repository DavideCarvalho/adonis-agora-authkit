---
"@adonis-agora/authkit-server": minor
---

Aplica o gate de status de conta (disabled/expired) em TODOS os caminhos de login passwordless, não só no de senha

**Segurança.** `isDisabled`, `isPasswordExpired` e `isAccountExpired` eram
checados em um único lugar: `attemptPasswordLogin`. Todo outro jeito de
completar o login — magic link, código OTP por e-mail e passkey (incluindo o
modo passkey-first) — chamava `completeLogin` direto, sem consultar o status
da conta. Um admin que desabilita uma conta pelo console acredita ter revogado
o acesso; em um deployment passwordless (que esta lib suporta explicitamente
via `passwordless.magicLink`, `passwordless.passkeyFirst` e `login.otp`), o
botão "desabilitar" não tinha efeito algum — a conta continuava logando pelo
magic link, pelo código, ou pela passkey.

**Correção.** O gate de status foi extraído de `attemptPasswordLogin` para
`assertAccountEnabled`/`assertAccountNotExpired`/`assertLoginAllowed`
(`src/host/login_attempt.ts`, todos exportados), preservando exatamente o
mesmo probe de capacidade (`supportsAccountStatus`) e os mesmos eventos de
auditoria (`login.failure` com `reason: 'disabled'`,
`password.expired_change_forced`, `account.expired_login_blocked`) do fluxo de
senha. Magic link, OTP e passkey agora chamam esse gate imediatamente antes de
`completeLogin`, cada um re-renderizando o erro na sua própria convenção
(magic link e OTP re-renderizam a view `login`; passkey re-renderiza
`mfa-challenge`) — o mesmo padrão já usado pelo gate de e-mail não verificado
nesses fluxos. O login social (`social_controller.ts`) também passou a checar
o gate antes de completar o login e, adicionalmente, ganhou auditoria de falha
de login pela primeira vez (não existia nenhuma antes desta mudança).

**Consequência da atualização:** contas desabilitadas ou com
`password_expiration`/`account_expiration` vencidos deixam de completar login
por magic link, OTP, passkey ou social — onde antes conseguiam. Hosts cujo
`accountStore` não implementa a capacidade de status (`supportsAccountStatus`
retorna false) não são afetados: o gate degrada para "permitido", exatamente
como já acontecia no fluxo de senha.

**Limitação conhecida (não fechada nesta mudança):** o alvo de um
token-exchange (impersonation, `src/provider/token_exchange.ts`) agora aceita
um `accountStore` opcional em `TokenExchangeDeps` para recusar impersonar uma
conta desabilitada, e a lógica está coberta por teste isolado — mas o ÚNICO
call site de produção (`registerTokenExchange` em
`src/provider/oidc_service.ts:158`) ainda não passa esse campo. Até esse
1-line de wiring ser adicionado, impersonar uma conta desabilitada via
token-exchange continua funcionando como antes desta mudança. Ver plano
`plans/003-account-status-gate-all-login-paths.md` para o detalhe.
