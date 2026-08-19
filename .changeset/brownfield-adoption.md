---
"@adonis-agora/authkit-server": minor
---

Adoção brownfield: `sub` string com id INTEGER, check de colunas no doctor, e a página que faltava

Ao seguir o caminho de quem "já tem uma tabela `users` com gente dentro" — a
pergunta mais comum de quem avalia o AuthKit — apareceram três problemas:

**1. Id inteiro vazava como número no `sub`.** `toAccount` fazia `id: row.id`
sem coerção. `AuthAccount.id` é tipado `string` e vira o claim `sub`, que a spec
OIDC exige que seja string — mas tabela legada quase sempre tem `id` INTEGER
auto-increment, e nesse caso o número ia direto para o token (e para todo
call-site tipado como string). Provado contra sqlite real: `findById`,
`verifyCredentials` e `findByEmail` devolviam `1`, não `'1'`. Agora coagido nos
dois `toAccount`. Efeito colateral bom: adotar o AuthKit não exige migrar para
UUID.

**2. Coluna faltando só quebrava em produção.** O `authkit:doctor` não olhava o
model por trás do account store. Faltando `password_reset_token`, o app subia
normalmente e a falha aparecia quando o primeiro usuário clicava em "esqueci
minha senha". Novo `checkAccountStoreColumns` (roteado no `runAllChecks`) lê
`$columnsDefinitions` e reporta as propriedades ausentes agrupadas pelo FLUXO
que quebra — citando também o `columnName` real, porque em brownfield a
propriedade `password` costuma morar numa coluna `senha`. Colunas opcionais
(`fullName`/`avatarUrl`/`disabledAt`/`passwordChangedAt`) são reportadas como
capability desligada, nunca erro. Store não-Lucid (sem `__model`) → silencioso.
Para isso o `lucidAccountStore` passou a expor `__model`, no mesmo idioma de
`__mfaIssuer`/`__webauthn`/`connectionName`.

**3. O caminho existia mas era invisível.** Nova página **Adopting an Existing
User Table**: o mapa exato de propriedades por fluxo, a migration aditiva (sem
drop/rename/cópia), mapeamento por `columnName` para schema em outra língua,
`legacyVerifier` por origem (Laravel `$2y$` / Rails `$2a$` / Django
`pbkdf2_sha256$` / node `$2b$`) com a distinção entre devolver `null` ("não é
meu formato") e `false` ("senha errada"), e como o lazy rehash migra a base
sozinha conforme as pessoas logam. Inclui o aviso de backfill de
`email_verified_at` — sem ele, uma política `requireVerifiedEmail` tranca a base
inteira no primeiro login.

Corrigido também um snippet que quebrava em runtime em duas páginas
(`passwords-and-migration`, `organizations`): mostravam
`lucidAccountStore({ model: () => import('#models/user'), … })`, assinatura que
não existe — a real é `lucidAccountStore(Model, options)`, sem overload de
objeto.
