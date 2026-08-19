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
