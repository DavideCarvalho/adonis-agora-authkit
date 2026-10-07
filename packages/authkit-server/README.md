# @adonis-agora/authkit-server

OpenID Connect / OAuth2 Authorization Server (Identity Provider) for AdonisJS — an idiomatic
wrapper around [`oidc-provider`](https://github.com/panva/node-oidc-provider).

## Features

- **OIDC / OAuth2 AS** — authorization code + PKCE, refresh tokens (rotated), token exchange,
  discovery, JWKS (managed + rotatable), revocation, introspection.
- **MFA** — TOTP, WebAuthn passkeys, recovery codes, trusted-device skip.
- **Passwordless** — magic-link email login and passkey-first login.
- **Protocol extensions** — Device Flow (RFC 8628), DPoP (RFC 9449), PAR (RFC 9126), step-up
  auth via `acr_values`, Dynamic Client Registration (RFC 7591/7592).
- **Personal agents** — AI assistants acting for your users: agent identity by signed JWT
  (JWKS, no shared secrets) and user-approved, revocable delegation with scopes you define,
  over a pluggable protocol adapter ([PACT](https://openpactprotocol.org) built in).
- **Native apps** — RFC 8252 native clients (`authkit:clients:create --native`: private-use
  scheme / claimed https / loopback redirects, always public + PKCE) and the `@adonisjs/auth`
  guards `oidcRpGuard` (session) and `oidcBearerGuard` (`Authorization: Bearer` access tokens,
  in-process or remote resource server).
- **Admin console** — user CRUD (+ disable), client CRUD, sessions, audit log (opt-in,
  role-gated).
- **Account console** — self-service apps/consent, security (password/email/sessions),
  profile.
- **Tokens & federation** — Personal Access Tokens, admin impersonation, back-channel logout,
  RP-initiated logout.
- **Hardening** — progressive account lockout, per-IP rate-limiting, audit logging with an
  events/webhook fan-out, new-login email alerts.
- **Operability** — i18n (English default, pt-BR built in), OpenTelemetry metrics, the
  `authkit:doctor` and `authkit:rotate-keys` commands.

> The remaining sections are in Portuguese pending a full translation pass.

## Instalação

```bash
node ace add @adonis-agora/authkit-server
# ou: pnpm add @adonis-agora/authkit-server && node ace configure @adonis-agora/authkit-server
```

O `configure` publica `config/authkit.ts`, o model `app/models/auth_user.ts`,
o controller de interactions (`app/controllers/auth_interaction_controller.ts`) e
registra o provider.

## Montar as rotas OIDC

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'
import { registerOidcRoutes } from '@adonis-agora/authkit-server'

registerOidcRoutes(router) // monta em /oidc por padrão
```

Defina `AUTHKIT_ISSUER` apontando para `<host>/oidc` (o issuer deve terminar no mount path).

## Rotas de interaction (login/consentimento)

O `oidc-provider` redireciona o usuário não autenticado para `interactions.url`
(`/auth/interaction/:uid`). Essas telas são **suas** (o `configure` ejeta
`app/controllers/auth_interaction_controller.ts`). Registre as rotas que apontam para ele:

```ts
// start/routes.ts
import AuthInteractionController from '#controllers/auth_interaction_controller'

router.get('/auth/interaction/:uid', [AuthInteractionController, 'show'])
router.post('/auth/interaction/:uid/login', [AuthInteractionController, 'login'])
router.post('/auth/interaction/:uid/consent', [AuthInteractionController, 'consent'])
```

Sem essas rotas o fluxo de autorização cai num 404 ao chegar na tela de login.

## UI de login/consent (configurável)

O `configure` ejeta as telas de interaction a partir de um preset escolhido:

```bash
node ace configure @adonis-agora/authkit-server --ui=edge
# valores: edge | react | headless — se omitir, o configure pergunta
```

Cada preset publica:

- **`headless`** — apenas o controller (`app/controllers/auth_interaction_controller.ts`).
  `show` devolve JSON (`{ uid, prompt, params }`) e `login`/`consent` respondem JSON/erro.
  Você constrói o front como quiser.
- **`edge`** — controller + views Edge (`resources/views/authkit/login.edge` e
  `consent.edge`). `show` renderiza a view de acordo com o prompt.
- **`react`** — controller + páginas Inertia/React (`inertia/pages/authkit/login.tsx` e
  `consent.tsx`). `show` faz `inertia.render`. Exige `@adonisjs/inertia` + Vite + React no
  app — o `configure` valida essa stack antes de publicar o preset.

Em todos os presets o controller ejetado é **casca**: a lógica vive em
`service.interactions` (resolvido via `containerResolver.make('authkit.server')`), que expõe
`details(ctx)`, `login(ctx, { email, password })` e `consent(ctx)`. Você edita só a parte de
render/redirect.

Quem decide se as credenciais valem é o `verifyCredentials` do `config/authkit.ts`
— é o que o `service.interactions.login` chama. O default consulta o `AuthUser` por e-mail e
usa `verifyPassword`; sobrescreva para plugar sua própria base de usuários.

As 3 rotas que o consumidor registra são as mesmas da seção anterior:

```ts
import AuthInteractionController from '#controllers/auth_interaction_controller'

router.get('/auth/interaction/:uid', [AuthInteractionController, 'show'])
router.post('/auth/interaction/:uid/login', [AuthInteractionController, 'login'])
router.post('/auth/interaction/:uid/consent', [AuthInteractionController, 'consent'])
```

## Persistência

Escolha o backend no `config/authkit.ts`:
- `adapters.redis({ connection })` — requer `@adonisjs/redis` configurado.
- `adapters.database({ connection? })` — Lucid; rode a migração `authkit_oidc_payloads`.

## Observabilidade

A lib agrega métricas de auth (logins, tokens, refresh, grants revogados, duração/erros
de resolve) e as expõe de forma opt-in.

### Configuração

No `config/authkit.ts`, use a chave `observability`:

```ts
observability: {
  metrics: true,    // habilita a coleta/agregação de métricas
  jsonRoutes: true, // libera a rota JSON de snapshot
  dashboard: true,  // libera o dashboard HTML embutido
}
```

### Rotas

Passe as flags em `registerOidcRoutes` no `start/routes.ts`:

```ts
import { registerOidcRoutes } from '@adonis-agora/authkit-server'

registerOidcRoutes(router, { metrics: true, dashboard: true })
```

- `GET /authkit/metrics` — snapshot agregado em JSON (`{ counters, histograms, updatedAt }`).
- `GET /authkit/dashboard` — dashboard HTML embutido (auto-refresh a cada 5s, sem
  dependência do Edge do consumidor).

### OpenTelemetry

As métricas são emitidas via OpenTelemetry **quando** `@opentelemetry/api` e `@adonisjs/otel`
estão instalados. Sem esses pacotes a emissão é no-op — a agregação em memória (e as rotas
JSON/HTML) continua funcionando normalmente.

### Grafana

O arquivo `assets/grafana/authkit-dashboard.json` pode ser importado diretamente no Grafana
(Dashboards → Import). Ele usa nomes de métrica no padrão OTel→Prometheus (pontos viram
underscores e counters ganham `_total`), portanto requer um exporter Prometheus no pipeline
OTel para que as séries existam.

## Notas
- Access tokens são opacos; ID tokens são JWT (assinados pelo JWKS gerido).
- PKCE (S256) é obrigatório; refresh tokens são rotacionados.

### Custom primary login methods

Register a class or instance for a host-specific authentication flow. AuthKit resolves classes through the request container, so normal Adonis `@inject()` dependencies work. The host validates and consumes the credential; AuthKit applies account policies, maintenance, MFA, audit, and OIDC session completion.

```ts
import { inject } from '@adonisjs/core';
import type { HttpContext } from '@adonisjs/core/http';
import type { CustomLoginMethod } from '@adonis-agora/authkit-server';
import PhoneProofs from '#services/phone_proofs';

@inject()
export default class WhatsappLogin implements CustomLoginMethod {
  readonly passwordless = true;
  constructor(private proofs: PhoneProofs) {}

  async authenticate(ctx: HttpContext) {
    // Host service validates and atomically consumes the proof bound to this
    // browser session and OIDC interaction. Never trust request.accountId.
    const accountId = await this.proofs.consume(ctx);
    return accountId ? { accountId } : null;
  }
}
```

```ts
// config/authkit.ts
import WhatsappLogin from '#auth/whatsapp_login';
export default defineConfig({
  // issuer, adapter, accountStore, ...
  customLoginMethods: { whatsapp: WhatsappLogin },
});

// Native form controller, on the host's POST /auth/interaction/:uid/... route
return authenticateCustomLogin(ctx, 'whatsapp');
```

`authenticate` returns `{ accountId }` only after a valid proof, or `null` to deny login. It may also return a host-validated `remember` boolean; persistence is disabled by default and subject to the runtime session policy. The same session policy applies after MFA. Returning an identity does not skip MFA. The method name is retained in the OIDC `amr` claim, including when a second factor follows. Methods default to password-based policy; set `passwordless = true` for OTP, hardware or external proofs that do not use the account password.

A method may implement `begin(ctx)` to initiate a challenge. Call `beginCustomLogin(ctx, 'whatsapp')` from the host route. Both dispatchers check the current OIDC interaction and its `:uid` before invoking the method. Method names contain lowercase letters, digits, `:`, `_` or `-`, start with a letter, and have at most 64 characters. Built-in factor names (`pwd`, `email`, `mfa`, `totp`, `webauthn`, `recovery`) are reserved. Registration does not automatically create routes or UI: the host owns validation, CSRF, rate limits, bot protection, delivery, proof expiry, replay protection, account lookup/signup and the response renderer. Use native form navigation for final completion so AuthKit can render MFA or redirect to the relying party.

For an arbitrary flow that already verified its credential, `completeCustomLogin(ctx, { accountId, method, passwordless })` is the trusted escape hatch. Do not expose it as an endpoint accepting an account ID from the browser. A phone-only account may represent absent email as an empty string in the legacy `AuthAccount` DTO; OIDC omits `email` and `email_verified` in that case. `AuthAccount.phone`, when supplied, must represent a verified phone identity.

Denied proofs and handler exceptions produce a `login.failure` audit event with the method ID and a sanitized reason; proof contents and exception messages are never included. Host-owned challenge/OTP verification endpoints must audit their own earlier failures.

### WhatsApp OTP delivery providers

`whatsapp.sender` accepts any `WhatsappCodeSender` instance or class. It is separate from `customLoginMethods`: login classes verify identity, senders only deliver a code. Configuring a sender does not create an OTP store, route, validator, signup flow, or UI.

```ts
import { inject } from '@adonisjs/core';
import type { WhatsappCodeInput, WhatsappCodeSender } from '@adonis-agora/authkit-server';
import MyWhatsappSdk from '#services/my_whatsapp_sdk';

@inject()
class MyProvider implements WhatsappCodeSender {
  constructor(private sdk: MyWhatsappSdk) {}
  async sendCode(input: WhatsappCodeInput): Promise<void> {
    await this.sdk.sendText(input.phone, input.text ?? input.code);
  }
}

export default defineConfig({
  // issuer, adapter, accountStore, ...
  customLoginMethods: { whatsapp: WhatsappLogin },
  whatsapp: { sender: MyProvider }, // or an already-created instance
});
```

After generating an OTP, resolve the sender through the request container:

```ts
const service = await ctx.containerResolver.make('authkit.server');
const binding = service.config.whatsapp?.sender;
if (!binding) throw new Error('WhatsApp login is not configured');
const sender = await resolveWhatsappCodeSender(ctx.containerResolver, binding);
await sender.sendCode({
  phone: '5511999999999', code, locale: 'pt-BR', expiresInSeconds: 300,
  text: ctx.i18n.t('auth.code_message', { code }),
});
```

The sender must reject when delivery fails. The host should activate its stored OTP only after delivery acceptance and enforce expiry, retries, request binding, replay protection and rate limits. Provider acceptance is not a delivery/read receipt. `text` is optional localized copy for providers supporting free-form messages; structured providers receive the original code independently.

Native adapters can be supplied as instances:

```ts
whatsapp: {
  sender: new WhatsmiauCodeSender({ apiKey, instanceName }),
}

whatsapp: {
  sender: new MetaWhatsappCodeSender({
    accessToken, phoneNumberId, apiVersion, templateName,
    languageCode: 'pt_BR',
  }),
}
```

Whatsmiau's optional `baseUrl` includes the API version path and defaults to `https://api.whatsmiau.dev/v2`. Meta requires an explicit supported Graph API version and an approved authentication template with an OTP/copy-code button. Template language must exist for the configured template; `languageCode` overrides automatic locale mapping (`pt-BR` → `pt_BR`, `en` → `en_US`, `es` → `es`). Meta template text and displayed expiry are managed in the approved template; `expiresInSeconds` describes the host's verification TTL and does not change template expiry. Both native adapters use bounded requests, reject redirects and discard provider error bodies so credentials/OTPs do not enter error messages.


### Custom MFA methods (classes or instances)

Register additional methods separately from primary login methods. Registration never enrolls an account: `isEnabled` must consult your enrollment store. A method may send a challenge in `begin`, describe its form fields, and verify a proof in `verify`.

```ts
import { inject } from '@adonisjs/core'
import type { CustomMfaContext, CustomMfaMethod } from '@adonis-agora/authkit-server'

// Enrollment and challenge services belong to your application and are injected by Adonis.
@inject()
export class WhatsappMfa implements CustomMfaMethod {
  readonly factorId = 'phone'
  constructor(private enrollment: PhoneEnrollment, private challenges: PhoneChallenges) {}

  async isEnabled({ accountId }: CustomMfaContext) {
    return this.enrollment.hasVerifiedPhone(accountId)
  }
  async describe() {
    return { label: 'WhatsApp', fields: [{ name: 'code', label: 'Code', inputMode: 'numeric' as const }] }
  }
  async begin({ accountId, challengeId }: CustomMfaContext) {
    await this.challenges.sendWhatsapp(accountId, challengeId)
  }
  async verify({ ctx, accountId, challengeId }: CustomMfaContext) {
    const { code } = await ctx.request.validateUsing(phoneCodeValidator)
    return this.challenges.consume(accountId, challengeId, code)
  }
}

// In defineConfig:
mfa: {
  methods: { whatsapp: WhatsappMfa, sms: smsMfaInstance },
  requiredFactors: 3,
}
```

The sample enrollment/challenge services and Vine validator are host implementations. Bind proofs to both `accountId` and `challengeId`; expire them, hash stored codes, limit sends, and atomically consume successful proofs. Delivery can use the WhatsApp sender interface or any SMS/provider SDK. Proofs and provider credentials must never appear in descriptors.

`requiredFactors` counts the primary login plus distinct additional groups (2 by default, configurable from 2 through 8). Omit it to challenge only accounts with an enrolled method; setting it explicitly also requires unenrolled accounts to enroll before they can authenticate. This extension does not supply an enrollment screen. Native TOTP, recovery codes and passkeys remain available; recovery and TOTP share one group. WhatsApp and SMS using the same phone must share `factorId: 'phone'`. A WhatsApp primary login class should also expose that group, preventing the same phone from counting twice. Group names express application policy; they do not prove independent physical authentication factors.

AuthKit binds the challenge to the current login interaction and browser session, expires it after ten minutes, caps failed custom proofs at five, and completes OIDC only after the required number of groups. Edge and generated React challenge screens render custom descriptors and optional start buttons. The named POST routes `authkit.mfa.custom.begin` and `authkit.mfa.custom.verify` use the existing login throttling and CSRF pipeline. Public `beginCustomMfa`, `verifyCustomMfa`, and `customMfaViewProps` support host integrations; proof verification alone does not complete authentication. Use the registered routes for policy-controlled completion.

Without `mfa` configuration, existing native MFA behavior is preserved. Applications can ship this extension without enabling additional methods.
