# Security Remediation Plan (auditoria 2026-06-08)

> Executar via subagentes (implementer + suíte verde por grupo). Detalhes/evidência: `docs/superpowers/specs/2026-06-08-security-audit.md`. Branch: `fix-security-audit`.

**Runtime confirmado:** entre-textos SEM backchannel_logout_uri (gap aberto); ambos clients têm token-exchange (public); LIMITER_STORE=redis ✓; passkeyFirst OFF ✓; email unique case-sensitive (varchar, sem citext).

**Escopo:** corrigir HIGH + MEDIUM + LOWs claros + runtime. Cada grupo = 1+ commit atômico, com teste, suíte verde antes de seguir. Regra: `pnpm --filter @adonis-agora/authkit-server test` verde no fim de cada grupo. Não dar push até o fim.

---

## Grupo A — OAuth/client hardening
Arquivos: `provider/token_exchange.ts`, `host/admin_validators.ts`, `host/admin_clients_service.ts`, `provider/build_provider.ts`.

- **H2** `token_exchange.ts`: gate do grant. (1) interseção do `scope` pedido com os scopes permitidos do `client` (e não exceder); (2) validar `audience`/`resource` contra resource indicators ou rejeitar se não suportado; (3) exigir `subjectAt.clientId === client.clientId` (subject_token emitido pro mesmo client que autentica); (4) opcional: allowlist de clients que podem usar o grant (config). Manter exigência de actor ADMIN.
- **M10** `admin_validators.ts` (`adminClientCreate/Update`): `grantTypes`/`grants` vira `vine.enum`/allowlist: `authorization_code`, `refresh_token`, `client_credentials`, `urn:ietf:params:oauth:grant-type:token-exchange`. **Bloquear `implicit`**. `responseTypes` idem (só `code`).
- **L10** `admin_validators.ts`: `redirectUris`/`postLogoutRedirectUris` → `vine.array(vine.string().url())`.
- **L3** `build_provider.ts:190`: mover `globalRolesClaim`/`org_*` do `claims.profile` para um scope dedicado `roles` (não atrelar a `profile`). Manter scope `roles` no catálogo.

## Grupo B — Admin authz hardening
Arquivos: `host/admin_api/api_users_controller.ts`, `host/admin_api/admin_users_service.ts`, `host/admin_console/console_users_controller.ts`, `host/rate_limit.ts`, `host/register_auth_host.ts`.

- **H1** proteção de roles globais: (1) bloquear remoção do ÚLTIMO ADMIN (contar admins antes de tirar a role); (2) bloquear auto-rebaixamento do próprio ator (comparar actorId == targetId removendo a própria role admin); (3) na REST API (`api_users_controller.update`), usar o caminho VALIDADO contra catálogo (mesmo do console `setGlobalRolesValidated`), não `setGlobalRoles` cru. Mensagens de erro claras (`last_admin`, `cannot_self_demote`).
- **M8** `rate_limit.ts`: throttle do grupo admin-api por IP (não keyed pelo bearer) — ao menos no caminho de auth falha. Adicionar/usar um throttle keyed por IP.
- **M9** auditoria: na REST API, propagar um identificador da admin key no `actorId`/metadata (ex.: `admin-key:<kid/prefixo>`) em vez de `null`. (Sudo no admin: ver Grupo E/decisão — wiring de sudo no console é maior; se inviável agora, deixar TODO documentado e focar em last-admin + audit.)

## Grupo C — Org isolation
Arquivos: `accounts/lucid_store/organizations.ts`, `host/controllers/account_orgs_controller.ts`, `host/admin_api/admin_orgs_service.ts`, `host/admin_validators.ts`.

- **H3** `organizations.ts` `revokeInvitation(orgId, invitationId)`: carregar o convite e exigir `inv.organizationId === orgId` (ou `.where('organization_id', orgId)` no delete). Mesma correção no caminho Admin API (`admin_orgs_service.ts`). Assinatura precisa receber `orgId` — ajustar callers.
- **H4** `admin_validators.ts` (`orgAddMember`/`orgInvitation`/`orgMemberRole`): validar `role` contra catálogo `cfg.organizations.roles` (`resolveEffectiveOrganizationsPolicy().roles`). No fluxo member-facing, impedir admin (não-owner) de atribuir/promover a `owner`.

## Grupo D — Auth/credentials
Arquivos: `accounts/lucid_store/core.ts`, `host/controllers/registration_controller.ts`, `host/controllers/account_security_controller.ts`, `host/login_attempt.ts`, `host/register_auth_host.ts`, `host/controllers/account_session_controller.ts`.

- **H5** `core.ts` `verifyCredentials`: quando `!row`, comparar senha contra um hash scrypt "dummy" fixo (mesmo custo) antes de retornar null — elimina o oráculo de timing.
- **M1** `login_attempt.ts:207`: construir o lockout a partir de `resolveEffectiveLockout(settings, cfg.lockout)` (o `settings` já é recebido) em vez de só `cfg.lockout`.
- **M2** após reset de senha (`registration_controller.consumePasswordResetToken`/`reset`) e changePassword (`account_security_controller`): revogar todas as sessões/grants OIDC da conta (`AdminSessionsService.revokeAll`).
- **M11** `registration_controller.ts:131` signup: resposta uniforme p/ email já existente (não revelar) — ou ao menos garantir bot-protection; preferir resposta genérica + (opcional) email de aviso ao titular. (Se mudar UX for arriscado, no mínimo documentar e manter rate-limit.)
- **L6** `register_auth_host.ts:327`: envolver `/account/login` (e `/account/logout`) com `withLogin` (throttle por IP); normalizar email (`trim().toLowerCase()`) no `account_session_controller.login`.

## Grupo E — Session/MFA
Arquivos: `host/controllers/account_session_controller.ts`, `accounts/lucid_store/mfa.ts`, `accounts/lucid_account_store.ts`, `host/admin_sessions_service.ts`, mixin webauthn/totp store.

- **M5** `account_session_controller.login` (e os `session.put` de pré-login no `interaction_controller`): `await ctx.session.regenerate()` após autenticar, antes de gravar a chave de conta.
- **M6** `account_session_controller.logout`: `session.regenerate()`/`clear()` (forget explícito de sudo/last-seen).
- **M3** `mfa.ts` `verifyTotp`: usar `authenticator.checkDelta` p/ obter o step e persistir o último step aceito por conta (nova coluna ou campo); rejeitar step ≤ último (anti-replay). Requer migration/coluna `last_totp_step` (via schema auto-manage da lib).
- **M4** `lucid_account_store.ts:48-88` `appKeyEncrypter`: `catch` do `decrypt` retorna `null` (negar), não `value`; garantir `await` da encryption antes de aceitar escrita; (opcional) envelope/prefixo p/ distinguir enc/plaintext.
- **M7** `admin_sessions_service.revokeAllExcept`: gravar `#recordSubRevocation(accountId)` também (cuidando do `iat` p/ não derrubar a sessão nova).
- **L9** `account_session_controller.validateReturnTo`: rejeitar valores contendo `\`.

## Grupo F — entre-textos (config) + runtime
Repo `streaming-educacao` + DB prod. (Fora do release da lib.)

- **M12** `apps/entre-textos/config/shield.ts`: habilitar CSP (`default-src 'self'`, `frame-ancestors 'none'`, sem `unsafe-inline`; começar em report-only se houver risco de quebrar). HSTS `includeSubDomains`. **O bloqueador do lado da lib já foi resolvido** (`login.edge`/`mfa-challenge.edge`/`account/confirm.edge`/`account/mfa.edge`/`partials/submit_lock.edge` não têm mais `<script>` inline — migrados p/ assets same-origin em `/authkit/assets/*.js`, mesmo padrão do splash de logout); falta só o toggle + policy neste repo.
- **L1** `config/shield.ts` + lib `host/csrf.ts`: trocar `url.includes('/api')` por prefixo ancorado; não isentar `/account/api/*` de CSRF.
- **L7** `config/authkit.ts`: `password: { pepper: env.get('PASSWORD_PEPPER') }` (+ env schema + setar no Guara).
- **Runtime #1**: registrar `backchannel_logout_uri=https://www.entretextosassessoria.com.br/auth/backchannel-logout` + `backchannel_logout_session_required=true` no client `entre-textos` (via Admin API update de client, ou DB se a API não expuser o campo).
- **Runtime #5**: migration p/ unique case-insensitive no `auth.users.email` (índice `lower(email)` único ou citext) — avaliar impacto; defense-in-depth.
- **Runtime token-exchange**: confirmar com Davi se entre-textos/eduliberta REALMENTE usam impersonation; se não, remover o grant dos clients (some o vetor H2 na prática).

## Deferir/documentar (não corrigir agora)
- **L2** client_secret plaintext: inerente ao oidc-provider; documentar (DB auth = cofre). Clients atuais são public (`none`), sem secret — risco atual nulo.
- **L11** SSRF webhook/hashicorp: config estática, não runtime; documentar.
- **L13** TOTP drift 0: manter estrito.

## Pós-código
1. changeset (minor authkit-server; patch/minor authkit-react se tipos mudarem). `pnpm changeset version` → merge main → push → CI publica.
2. entre-textos: bump + Grupo F config + `pnpm install` + deploy.
3. Runtime fixes (#1 backchannel, #5 email index) contra prod.
4. Atualizar o audit doc com o status de cada item (CORRIGIDO/DEFERIDO).
