---
"@adonis-agora/authkit-server": minor
---

Tipos de login por usuário — preferência self-service no console de conta

O usuário passa a poder escolher, no console de conta, **quais métodos de login
ficam habilitados para a SUA conta** (senha, magic link, passkey, social). É uma
camada por usuário sobre os switches globais existentes (`auth_methods` + pins
de config): o usuário nunca LIGA um método que o host desligou, só restringe.

**Storage**: coluna `login_methods` (JSONB) em `auth.users` — o host adota por
migração própria; sem a coluna no model, a feature é no-op (mesmo padrão de
`hasColumn` das colunas opcionais). `NULL` = sem preferência = herda os globais.

**Account API**: `GET/PUT /account/api/login-methods`. O GET devolve `{ supported,
methods, available, locked }` — `methods` é a preferência crua do usuário,
`available` o estado final (global ∩ preferência, com derivações de
forgotPassword/passkeyAutofill) e `locked` os métodos fora do controle dele
(globalmente off ou fixados em `cfg.authMethods`). O PUT recusa com 400
`all_methods_off` quando a preferência zeraria todos os métodos globais.

**Enforcement no login** (interseção global × preferência):

- Passo 2+ da tela de login (`show()`): métodos que o usuário desligou não
  aparecem — inclusive `magicLinkAvailable`, `otpEnabled` e `passkeyFirstAvailable`.
- POST de senha: método desligado → erro de credencial inválida ANTES de verificar
  a senha (sem vazar preferência), auditado como `login.failure`
  `method_disabled_by_user`.
- POST magic link: não emite token; resposta uniforme "link enviado".
- Consumo de magic link/OTP: token emitido antes do desligamento também é
  barrado — a sessão não materializa.
- Passkey: assertion válida é recusada quando o usuário desligou explicitamente
  a passkey (switches globais continuam governando a exibição).
- Callback social: identidade ligada + social desligado para a conta → redireciona
  de volta ao login.

Fail-safe em todo caminho: store sem a capacidade, conta sem preferência ou erro
qualquer → comportamento atual intacto. Fail-safe all-off: preferência que zera
tudo é ignorada (nunca trancar o dono fora da própria conta).

Novos exports: `UserLoginMethods`, `UserLoginMethodKey`,
`ResolvedUserLoginMethods`, `resolveEffectiveUserLoginMethods`,
`normalizeUserLoginMethods`, `parseUserLoginMethodsPayload`,
`USER_LOGIN_METHOD_KEYS`, `supportsLoginMethodsPreference`,
`LoginMethodsPreferenceCapability`.
