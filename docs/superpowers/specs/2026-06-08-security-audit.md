# Auditoria de Segurança — adonis-authkit IdP (2026-06-08)

Auditoria defensiva do Authorization Server OIDC (`@adonis-agora/authkit-server` sobre `oidc-provider@9.8.4`) + integração prod `entre-textos`. 7 dimensões em paralelo, leitura do código real. `file:line` referem-se a `packages/authkit-server/src/...` salvo indicação.

**TL;DR:** nenhuma falha CRITICAL óbvia; a postura base é boa (PKCE S256 obrigatório, sem `none` alg, refresh reuse-detection, PAT/recovery codes hasheados, keystore sólido, guards admin aplicados, sem SQLi, CORS fechado). Mas há **5 HIGH** reais (escalonamento de privilégio, IDOR cross-org, token-exchange sem gate, enumeration por timing) e um tema recorrente de **drift entre settings do console e comportamento real** + **defesa-em-profundidade faltando** (sudo em ações admin, CSP, revogar sessões no reset).

---

## STATUS DE REMEDIAÇÃO (2026-06-09)

Corrigido em `adonis-authkit-server` **0.31.0** (fixes de código) e **0.32.0** (MFA lib-owned), + entre-textos config/runtime. Verificado em prod (login + account self-service + MFA schema + backchannel).

**CORRIGIDO (todos os HIGH + maioria dos MEDIUM/LOW):**
- H1 último-admin/auto-rebaixamento/catálogo REST · H2 token-exchange (bind client + interseção scope + audience + InvalidScope) · H3 IDOR convite escopado · H4 role de org contra catálogo · H5 dummy-hash anti-enumeration.
- M1 lockout via settings (incl. login do console) · M2 reset/troca revoga sessões · M3 TOTP anti-replay · M4 encrypter fail-closed · M5 regen no login · M6 destrói sessão no logout · M7 single-session propaga revogação · M8 throttle admin por IP · M10 allowlist grant_types.
- L1 CSRF ancorado (entre-textos, `/account/api` re-protegido — verificado) · L6 throttle `/account/login` · L7 pepper (entre-textos) · L9 returnTo backslash · L10 redirect_uri url.
- Runtime: #1 backchannel_logout_uri registrado no client entre-textos · #5 unique `lower(email)` · #3 LIMITER=redis (ok) · #4 passkeyFirst off (ok).
- BÔNUS: MFA totalmente lib-owned em `auth_mfa` auto-gerida; fix de `schema.connection='auth'` no entre-textos (autoManage caía no schema `public`).

**DEFERIDO / RISCO ACEITO (documentado):**
- M11: signup enumeration — mantido rate-limit; resposta uniforme deferida (acoplada à interaction OIDC).
- L2 client_secret plaintext (inerente ao oidc-provider; clients atuais são public/`none`) · L5 impersonation mira admin · L11 SSRF config-static · L13 TOTP drift 0 (estrito de propósito).

**M9 — CORRIGIDO no console admin (sessão de browser); REST API fica de fora (decisão, não pendência).** `ConsoleUsersController` (`disable`, `resetPassword`, `destroy`), `ConsoleSessionsController` (`revokeAll`, `userRevokeSessions`) e `ConsoleKeysController` (`rotate`) agora exigem sudo recente via `requireSudo` — mesma infra (`/account/confirm`) do self-service; sem sudo confirmado respondem `403 sudo_required`. `enable()` continua sem gate (não é destrutivo). A Admin REST API (Bearer, server-to-server) NÃO ganhou sudo: é um conceito de sessão de browser (reconfirmar identidade de um usuário), sem equivalente natural para uma API key — permanece fora de escopo até haver um mecanismo dedicado (não é wiring da infra existente).

**M12 — o lado `authkit-server` está CORRIGIDO** (pré-requisito para o entre-textos poder ligar CSP sem quebrar o login do IdP): `login.edge`, `mfa-challenge.edge`, `account/confirm.edge`, `account/mfa.edge` e `partials/submit_lock.edge` tinham `<script>` inline (autofill/botão de passkey, verificação WebAuthn, anti-duplo-submit) — todos migrados para assets same-origin em `/authkit/assets/*.js` (mesmo padrão do splash de logout, `0.61.3`, e do bundle WebAuthn). **Ainda PENDENTE, no repo `streaming-educacao`:** habilitar de fato `csp:{enabled:true}` em `apps/entre-textos/config/shield.ts` (`default-src 'self'`, `frame-ancestors 'none'`, sem `unsafe-inline`) + policy/report endpoint contra o app rodando — isso é config do HOST, fora deste pacote.

**L3 — CORRIGIDO (2026-06-09, server 0.33.0 / client 0.8.0):** roles globais + claims de org saíram do scope `profile` → scope dedicado `roles`, com emissão **gated a clients first-party** (`branding.firstParty`) no `findAccount` — third-party NÃO recebe roles nem solicitando `scope=roles`. Default de scopes do authkit-client passou a incluir `roles`. Deploy coordenado (eduliberta → entre-textos) sem janela de authz. Verificado em prod: admin loga no app via OIDC e cai no `/admin/dashboard` (role ADMIN flui pelo token). Antes era "risco aceito" porque mover de scope sozinho quebraria authz; o gate por first-party resolveu de forma segura-por-default.
- PRÉ-EXISTENTE: duplicação de tabelas `auth_*` entre schemas `auth` e `public` (autoManage rodava na connection default) — `auth_mfa` consolidado no `auth`; o resto (`auth_session_revocations` em public, dupes de `auth_settings`/`auth_organizations`) funciona via searchPath mas merece limpeza dedicada.

---

## HIGH

### H1 — Privilege escalation: qualquer admin concede ADMIN; sem proteção de "último admin"; REST aceita roles fora do catálogo
`host/admin_api/api_users_controller.ts:84-87`, `host/admin_console/console_users_controller.ts:129-163`, `host/admin_api/admin_users_service.ts:153-181`
`PATCH /users/:id {globalRoles}` substitui roles sem checar se o ator pode conceder, sem preservar ≥1 ADMIN, sem impedir auto-rebaixamento. A REST API usa `setGlobalRoles` (sem validação de catálogo) → aceita qualquer string, incl. `ADMIN`. Risco: admin comprometido concede ADMIN a qualquer um, ou remove todos os admins → lockout permanente do console (só recuperável via DB).
**Fix:** bloquear remoção do último ADMIN + auto-rebaixamento; validar catálogo também no caminho REST; idealmente capability separada para conceder admin.

### H2 — Token-exchange (impersonation) sem gate de scope/audience/client
`provider/token_exchange.ts:54-56`, `:40-52`
O grant `urn:ietf:params:oauth:grant-type:token-exchange` exige só que o **actor** seja ADMIN, mas: repassa `scope` arbitrário direto pro AT/IdToken emitido (sem interseção com scopes do client/actor); não valida `audience`/`resource`; não exige `subject_token.clientId === client autenticado` (AT do client A trocável via client B). Admin (ou client com AT de admin) forja tokens p/ qualquer usuário, scope e audiência.
**Fix:** allowlist de clients confiáveis pro grant; validar scope contra catálogo/actor; vincular subject_token ao client; validar audience.
*A confirmar (runtime):* quais clients têm esse grant em `auth.authkit_oidc_payloads` (`node ace authkit:clients:list`).

### H3 — IDOR cross-org: revogação de convite não escopada por org
`host/controllers/account_orgs_controller.ts:300-321`, `accounts/lucid_store/organizations.ts:279-284` (e Admin API `admin_orgs_service.ts:349`)
`revokeInvitation` valida o ator na org A (`params.id`) mas deleta o convite por `invId` **sem filtrar `organization_id`**. Owner/admin de qualquer org revoga convite pendente de outra org sabendo o `invitationId`.
**Fix:** carregar o convite e exigir `inv.organizationId === orgId` antes de deletar (ou `.where('organization_id', orgId)`).

### H4 — Escalonamento de papel na org: `role` de membro/convite sem allowlist
`host/controllers/account_orgs_controller.ts:159-185`, `host/admin_validators.ts:161-183`
`role` é só `vine.string().minLength(1)` — sem interseção com `cfg.organizations.roles`. Um **admin** (não-owner) convida/atribui `role:'owner'` arbitrário (a invariante "último owner" protege contagem ao remover, não promoção). Também aceita roles fora do catálogo.
**Fix:** validar `role` contra `resolveEffectiveOrganizationsPolicy().roles`; só owner promove a owner.

### H5 — Account enumeration por timing no login (sem dummy-hash)
`accounts/lucid_store/core.ts:41-48`
`verifyCredentials`: email inexistente retorna `null` **antes** de qualquer hash; existente roda scrypt (~50-100ms). Mensagens/status são uniformes, mas o **tempo** distingue email cadastrado. Não há dummy-hash.
**Fix:** comparar contra hash scrypt fixo "dummy" quando `!row` (OWASP).

---

## MEDIUM

### M1 — Settings de lockout do console NÃO afetam o runtime (drift)
`host/login_attempt.ts:207` usa `cfg.lockout` (config de boot), ignorando `resolveEffectiveLockout(settings,…)` (`host/runtime_toggles.ts:766`) que existe mas nunca é chamado no login. Ajustar lockout no admin console é silenciosamente inócuo. **Tema importante:** o console expõe controles que não fazem nada — validar que o resto das settings (incl. a `key_rotation` nova, que SIM funciona via scheduler) realmente surte efeito. **Fix:** passar `settings` ao construir o lockout.

### M2 — Reset de senha (e changePassword) não invalida sessões existentes
`host/controllers/registration_controller.ts:318-381`, `host/controllers/account_security_controller.ts:303-383`
Vítima faz "esqueci a senha" p/ expulsar atacante, mas sessões/refresh-tokens ativos do atacante continuam válidos (offline_access até 30d). **Fix:** `AdminSessionsService.revokeAll(account)` após reset/troca.

### M3 — TOTP sem proteção de replay
`accounts/lucid_store/mfa.ts:51-57`
`verifyTotp` não persiste o step consumido → mesmo código reusável dentro da janela (~30s). `otp_lockout` só conta falhas. **Fix:** gravar o último step aceito (via `authenticator.checkDelta`) e rejeitar step ≤ último.

### M4 — Segredo TOTP pode persistir em plaintext (degradação cega)
`accounts/lucid_account_store.ts:48-88`
`appKeyEncrypter()` carrega encryption via `import()` async; enquanto `encSvc` é undefined, `encrypt()` retorna **plaintext**; o `catch` do `decrypt` retorna `value` (ciphertext cru), sem envelope que distinga enc/plaintext. Difere do keystore (envelope versionado + fail-closed). **Fix:** alinhar ao keystore — marcar `enc`, `await` da encryption antes de aceitar escrita, e `catch → null` (negar) no decrypt.

### M5 — Session fixation: sessão não regenerada no login
`host/controllers/account_session_controller.ts:75-77` (e `interaction_controller.ts` nos `session.put` de pré-login)
Login não chama `session.regenerate()` (embora o "sign out all" chame). Cookie de sessão não muda na elevação de privilégio. **Fix:** `await ctx.session.regenerate()` após autenticar, antes de gravar a chave de conta.

### M6 — Logout do console só faz `forget`, não destrói a sessão
`host/controllers/account_session_controller.ts:83-86`
Sobram na sessão `authkit_sudo_at` (sudo), `authkit_last_seen` etc.; session id inalterado. **Fix:** `session.regenerate()`/`clear()` no logout (ou forget explícito do sudo).

### M7 — Single-session não propaga revogação a clients cookie-based
`host/admin_sessions_service.ts:226-256`
`revokeAllExcept` (política single-session no login) destrói grants no OP mas não grava `auth_session_revocations` por `sub` (ao contrário de `revokeAll`). 1º dispositivo só cai quando o AT expira. **Fix:** gravar `#recordSubRevocation` também em `revokeAllExcept` (cuidando do `iat` p/ não derrubar a sessão nova).

### M8 — Throttle da Bearer key admin é keyed pelo próprio token (sem anti-brute-force real)
`host/rate_limit.ts:108-115`
`keyOf = bearer:<token>` → cada key tentada cai em bucket distinto; 60/min só limita a MESMA key. Sem lockout por IP na auth admin. Mitigado por entropia alta da key. **Fix:** throttle por IP no grupo admin-api (ou fallback de IP quando a auth falha).

### M9 — Ações destrutivas de admin sem sudo/reauth + `actorId:null` na auditoria REST
`host/admin_api/api_users_controller.ts:13-18,101-145`, `host/admin_console/console_keys_controller.ts:48-60`
Nenhuma ação destrutiva (delete user, disable, revoke-sessions, reset-password, rotate keys) exige sudo; a infra de sudo (`/account/confirm`) nunca foi wired no admin. REST audita com `actorId:null` (não dá pra saber qual key agiu). **Fix:** exigir sudo recente p/ ações destrutivas no console; incluir keyId no actor/metadata da REST.

### M10 — Admin pode criar client com grant_types arbitrários (reintroduz implicit)
`host/admin_validators.ts:57-58`, `host/admin_clients_service.ts:202-206`
`grantTypes` é array de strings sem `enum` (≠ `tokenEndpointAuthMethod` que é restrito). Admin registra client com `implicit` (tokens na URL fragment) ou com o grant token-exchange (ver H2). **Fix:** `vine.enum` allowlist bloqueando `implicit`.

### M11 — Signup vaza existência de email
`host/controllers/registration_controller.ts:131-140` — resposta distinta p/ email já cadastrado. Enumeration via cadastro (login/forgot/magic-link são safe). **Fix:** resposta uniforme + email de aviso ao titular; garantir bot-protection no signup em prod.

### M12 — CSP desabilitada no entre-textos
`streaming-educacao/apps/entre-textos/config/shield.ts` — `csp:{enabled:false}`. Telas de login/consent/MFA (com `<script>` inline) sem CSP. Num IdP, XSS aí = roubo de sessão SSO. (HSTS/nosniff/xFrame OK.) **Fix:** habilitar CSP (`default-src 'self'`, `frame-ancestors 'none'`, sem unsafe-inline → nonce/arquivos).

---

## LOW (defesa-em-profundidade / regressão futura)

- **L1 — CSRF `exceptRoutes` por substring** (`shield.ts` + `host/csrf.ts:30`): `url.includes('/api')` isenta `/account/api/*` (session+cookie, mutáveis) de CSRF. Mitigado por SameSite=Lax. **Fix:** ancorar prefixo; não isentar `/account/api/*`. (2 agentes)
- **L2 — client_secret em plaintext no adapter** (`admin_clients_service.ts:215`): inerente ao oidc-provider (`client_secret_basic`); compare é timing-safe. **Fix:** encriptar payload de client em repouso ou migrar sensíveis p/ `private_key_jwt`; tratar DB `auth` como cofre. (2 agentes)
- **L3 — roles/org claims no scope `profile`** (`provider/build_provider.ts:190`): qualquer client com `profile` recebe `roles`/`org_*`. Baixo hoje (só first-party); vira HIGH com dynamic registration/third-party. **Fix:** mover p/ scope `roles` dedicado e não atrelar a `profile`.
- **L4 — refresh token 30d com rotação sliding até ~1 ano** (`build_provider.ts:228`): `rotateRefreshToken:true` reseta TTL; sessão viva ~1y. Conecta com o gap de back-channel logout. **Fix:** `expiresWithSession` ou TTL absoluto p/ offline_access.
- **L5 — Impersonation pode mirar admin, sem sudo, TTL longo** (`provider/impersonation.ts:30`): não escala (já é admin) mas quebra não-repúdio/separação de deveres. **Fix:** bloquear impersonar admin; capability+sudo; TTL/scope reduzidos.
- **L6 — `/account/login` sem throttle por IP + email não normalizado** (`register_auth_host.ts:327`, `account_session_controller.ts:49`): lockout por-email ainda protege (sem bypass por casing), mas falta teto por IP. **Fix:** envolver com `withLogin`.
- **L7 — Sem pepper no entre-textos** (`config/authkit.ts`): hashes scrypt sem camada HMAC extra; vazamento só do DB fica atacável offline. **Fix:** `password:{pepper: env('PASSWORD_PEPPER')}` (re-hash lazy no login).
- **L8 — `LIMITER_STORE=memory` perde lockout em restart/multi-pod**: garantir `=redis` em prod (validar no doctor).
- **L9 — `validateReturnTo` não rejeita `\`** (`account_session_controller.ts:21`): `/\evil.com` → open redirect em browsers que normalizam `\`→`/`. **Fix:** rejeitar/normalizar `\`.
- **L10 — redirect_uris sem validação de esquema no admin** (`admin_validators.ts:55`): aceita `http://`/fragment (match runtime é exato, então só "admin distraído"). **Fix:** `vine.string().url()` + exigir https em prod.
- **L11 — SSRF teórico webhook/Hashicorp** (`events/dispatcher.ts:77`, `keys/keystore_vault.ts:150`): URLs são config estática (não runtime), por isso LOW. **Fix:** allowlist de IP se virarem runtime-settable.
- **L12 — userVerification `'preferred'` em WebAuthn** (`webauthn.ts:39,91`): ok p/ 2º fator; se `passkeyFirst` estiver ON em prod, passkey vira fator único sem UV garantido → considerar `'required'` nesse modo. *A confirmar.*
- **L13 — TOTP drift window 0**: postura estrita (seguro); só registrar que pode gerar falso-negativo com clock dessincronizado.

---

## Verificado e OK (postura sólida — não mexer)
PKCE S256 obrigatório p/ todos os clients (`build_provider.ts:200`); redirect_uri match exato (sem wildcard); implicit/`token` off por padrão; **sem `none` alg**, sem alg-confusion RS↔HS; devInteractions/jwtIntrospection/dynamicRegistration off; refresh rotation + **reuse-detection** (revoga grant inteiro); `token_endpoint_auth_method:none` só p/ public; client_secret compare timing-safe. PAT hasheado (SHA-256) + introspection secret timing-safe; recovery codes hasheados + single-use timing-safe; TOTP secret encriptado em repouso (ressalva M4); WebAuthn challenge single-use server-side + origin/rpId validados + credencial bound à conta; MFA enforcement sem bypass; trusted-device encriptado + invalidado no re-enroll. Keystore JWKS sólido (envelope AES, fail-closed, 0600, campos privados filtrados). Guards admin (Bearer timing-safe + fail-safe; adminGuard global-role) aplicados em TODAS as rotas; settings lockout (423) honrado; last-owner de org protegido. **Sem SQL injection** (Lucid parametrizado em todo o src); CORS fechado (`origin:[]`); back-channel logout **implementado** (valida assinatura/iss/aud/iat, anti alg-confusion). Resolvers de runtime fail-*safe* p/ config estático (não desligam proteção silenciosamente) — os catch-all problemáticos anteriores foram corrigidos.

## A confirmar em runtime (fora do código)
1. Client `entre-textos` tem `backchannel_logout_uri` + `session_required` registrados? (sem isso, o gap de sessão stale 30d reabre — `entretextos-backchannel-logout-gap`).
2. Quais clients têm o grant `token-exchange`? (H2).
3. `LIMITER_STORE=redis` em prod? (L8).
4. `passwordless.passkeyFirst` ligado? (L12).
5. Coluna `email` é case-insensitive/UNIQUE no Postgres `auth`? (evita contas duplicadas por casing).
