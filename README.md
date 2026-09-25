# AuthKit for AdonisJS

AuthKit is a set of packages that turn an [AdonisJS](https://adonisjs.com) app into
a full **OpenID Connect / OAuth2 Authorization Server** (Identity Provider), let other
apps consume it as **OIDC clients**, and give React frontends typed auth ergonomics.

It is built as an idiomatic wrapper around
[`oidc-provider`](https://github.com/panva/node-oidc-provider).

## Features

- **OIDC / OAuth2 Authorization Server** — authorization code + PKCE, refresh tokens,
  token exchange, discovery, JWKS, revocation, introspection.
- **MFA** — TOTP, WebAuthn passkeys, recovery codes, and trusted-device skip.
- **Passwordless** — magic-link email login and passkey-first login.
- **Protocol extensions** — Device Flow (RFC 8628), DPoP (RFC 9449, with client-side
  proof generation), PAR (RFC 9126), step-up auth via `acr_values`, Dynamic Client
  Registration (RFC 7591/7592).
- **Native apps** — RFC 8252 native clients (private-use scheme / claimed https / loopback
  redirects, public + PKCE, rotated refresh tokens) and `oidcBearerGuard`, an
  `@adonisjs/auth` guard for APIs called with a bearer access token (in-process, or as a
  remote resource server via JWKS / introspection).
- **Consoles** — admin console (user & client CRUD, sessions, audit) and a self-service
  account console (apps/consent, security, profile).
- **Tokens & sessions** — Personal Access Tokens, admin impersonation, back-channel
  logout, RP-initiated logout.
- **Hardening** — progressive account lockout, per-IP rate-limiting, audit logging with
  an events/webhook fan-out, new-login email alerts.
- **Operability** — i18n (English + pt-BR built in), OpenTelemetry metrics, `authkit:doctor`
  and `authkit:rotate-keys` commands, and a `@adonis-agora/authkit-testing` helper package.
- **Client & React** — typed OIDC client resolvers (JWT/opaque/PAT) and a React
  `useAuth()` hook with role-gating components.
- **Backend SDK** — `@adonis-agora/authkit-sdk`: one typed interface with `remote`
  (HTTP Admin API) and `embedded` (in-process) drivers for managing users, clients,
  sessions, audit, and token verification.

## Packages

| Package | Description |
| --- | --- |
| [`@adonis-agora/authkit-core`](./packages/authkit-core) | Shared contracts and types (`Identity`, `SessionResolver`, server config types, metric names). No runtime — consumed by the server and client packages. |
| [`@adonis-agora/authkit-server`](./packages/authkit-server) | AdonisJS OIDC/OAuth2 Authorization Server (Identity Provider): ejectable auth server with sessions, rate-limiting, MFA/TOTP, audit log, federated logout, and OpenTelemetry metrics. |
| [`@adonis-agora/authkit-client`](./packages/authkit-client) | OIDC relying-party (client) adapter: session-based authentication against an OpenID Connect identity provider, with JWT/PAT user resolvers and OpenTelemetry metrics. |
| [`@adonis-agora/authkit-react`](./packages/authkit-react) | Frontend ergonomics for AdonisJS + Inertia + React apps: a typed `useAuth()` hook, role-gating hooks, and gating components. |
| [`@adonis-agora/authkit-sdk`](./packages/authkit-sdk) | Backend SDK over the Admin API with one typed interface and two drivers: `remote` (HTTP/Bearer) and `embedded` (in-process). |

## Install

Run the Authorization Server in your IdP app:

```bash
node ace add @adonis-agora/authkit-server
```

Consume it from a client app:

```bash
node ace add @adonis-agora/authkit-client
```

Add the React ergonomics to an Inertia + React frontend:

```bash
pnpm add @adonis-agora/authkit-react
```

`@adonis-agora/authkit-core` is pulled in transitively by the server and client
packages — you rarely install it directly.

## Documentation

Full documentation lives at the docs site (coming soon). Each package also ships its
own README with setup and usage details:

- [authkit-server README](./packages/authkit-server/README.md)
- [authkit-client README](./packages/authkit-client/README.md)
- [authkit-react README](./packages/authkit-react/README.md)
- [authkit-core README](./packages/authkit-core/README.md)

## Development

This is a pnpm monorepo. Common tasks:

```bash
pnpm install
pnpm build       # build all packages
pnpm typecheck   # typecheck all packages
pnpm test        # run all package test suites
pnpm format      # prettier --write
```

Releases are managed with [Changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset           # record a version bump
pnpm release             # build + changeset publish
```

## License

[MIT](./LICENSE) © Davi de Carvalho
