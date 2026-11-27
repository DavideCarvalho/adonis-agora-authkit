# Skill spec — adonis-authkit (autonomous pass)

ONE domain map (see `_artifacts/domain_map.yaml`) covers the whole monorepo. The 3
consumer-facing packages carry the main skills; the add-on packages (`authkit-sdk`,
`authkit-testing`, `authkit-poppy`, `authkit-vault-aws/-azure/-gcp`) each ship one small
skill. `authkit-core` is listed in `coverage.ignored_packages` (types only).

## Scope decision

| Package | Skills | Why |
|---|---|---|
| `@adonis-agora/authkit-server` (0.60.0) | 2 | The flagship: an IdP app's whole setup lives here — config/adapter/JWKS + route mounting, and the host-owned interaction screens. |
| `@adonis-agora/authkit-client` (0.18.0) | 1 | The relying-party side: one skill covers config, resolvers, middleware ordering and session consumption end-to-end. |
| `@adonis-agora/authkit-react` (0.20.0) | 1 | Frontend ergonomics: `useAuth()` + gating + `AuthkitProvider` form one coherent surface. |

Main packages: 4 SKILL.md files (the server's two domains are the only ones with
distinct developer moments worth splitting), plus one skill per add-on package below
(10 total). Flat
structure (`packages/<pkg>/skills/<skill>/SKILL.md`),
all `metadata.type: core`, `router: false` (the `intent list` CLI is the discovery
surface; <15 skills).

### Add-on packages — one skill each (revised decision)

Skills ship inside the package that owns them, so an agent that installs only an add-on
never sees guidance kept in `authkit-server`. Each add-on therefore gets one small skill:

| Package | Skill | Why |
|---|---|---|
| `@adonis-agora/authkit-sdk` | `authkit-sdk` | Two drivers, Admin API enablement/prefix match, driver-specific errors. |
| `@adonis-agora/authkit-testing` | `authkit-testing` | Fakes on `ctx.authkit`, `tokenSource: 'bearer'` for minted tokens, JWKS server lifecycle. |
| `@adonis-agora/authkit-poppy` | `authkit-poppy` | Extension wiring, `poppyAuth` routes, replay store and CSRF gotchas. |
| `@adonis-agora/authkit-vault-aws` | `authkit-vault-aws` | Driver config, SDK peer, IAM. |
| `@adonis-agora/authkit-vault-azure` | `authkit-vault-azure` | Driver config, two SDK peers, RBAC. |
| `@adonis-agora/authkit-vault-gcp` | `authkit-vault-gcp` | Driver config, secret must pre-exist, IAM. |
| `@adonis-agora/authkit-core` | — (ignored) | Shared types, no runtime, transitive dependency. |

The three vault skills share a shape (driver selected in `jwks.store`, lazy import by
the server, `backend` test seam, encrypt default OFF) but differ in peers, credentials
and whether the secret is auto-created. `authkit-idp-setup` keeps a one-paragraph
summary of every `store` driver and points at the add-on skills; `authkit-interactions`
keeps a short testing pattern and points at `authkit-testing`.

## Skills

1. **core / authkit-idp-setup** (`packages/authkit-server/skills/`) — install via
   `node ace add`, `defineConfig` (`issuer`, `adapters.redis/database`, `jwks`
   managed/`'auto'`/inline, `ttl`, `globalRolesClaim`, `accountStore`:
   `lucidAccountStore`), `registerOidcRoutes` (+ observability routes), mounting
   consoles with `registerAuthHost` or `config.routes`, issuer/mountPath invariant.
   Mistakes: issuer not ending in mount path; forgetting `registerAuthHost`
   (consoles 404) or double-mounting with `config.routes`; `jwks:'auto'` in prod
   without `AUTHKIT_JWKS` (ephemeral keys).

2. **core / authkit-interactions** (`packages/authkit-server/skills/`) — the three
   host-owned interaction routes (`/auth/interaction/:uid` show/login/consent),
   `node ace configure --ui=edge|react|headless` presets, the shell-controller +
   `service.interactions` split (`details`/`login`/`consent`), `verifyCredentials`
   override, renderers (`edgeRenderer` default / `inertiaRenderer`). Mistakes:
   not registering the interaction routes (404 mid-flow); putting logic in the
   ejected shell instead of `service.interactions`; breaking `verifyCredentials`
   contract vs `accountStore`.

3. **core / authkit-rp-client** (`packages/authkit-client/skills/`) —
   `defineConfig` + `resolvers.jwt/pat/opaque`, `resolveUser` topologies
   (`identityToUser` / `createUserinfoResolver` / local Lucid model), middleware
   ordering (session BEFORE `authkit_middleware`), `ctx.auth`
   (`getIdentity`/`getUser`/`hasGlobalRole`), `registerOidcClient`, back-channel
   logout. Mistakes: session middleware after authkit middleware (silent null
   identity); app-role gating in the client (moved to `@adonis-agora/authz`);
   opaque resolver without `clientSecret` (throws at resolve time).

4. **core / authkit-react-auth** (`packages/authkit-react/skills/`) — the
   `authkit` shared prop contract, `useAuth()` semantics (never throws; context
   precedence), role helpers, `Authenticated`/`Guest` gating, `AuthkitProvider`
   config (`csrfToken`, `endpoints`, `idp:'external'` degradation). Mistakes:
   forgetting to share the `authkit` prop on the host (dev-warn + unauthenticated
   UI); wrong `user` shape; app-permission `<Can>` gating expected here (moved to
   `@adonis-agora/authz-react`).

## Frontmatter contract (per `intent validate` / generate-skill spec)

- Top level: `name` (kebab leaf == parent dir, no slashes), `description`, `metadata`.
  `license: MIT` where included (Agent-Skills-legal top-level key).
- `metadata`: `{ type: core, library, library_version, framework: adonisjs|react }`.
- `sources` use `DavideCarvalho/adonis-authkit:<path>` (the repo's GitHub slug;
  note the npm org is `@adonis-agora` while the repo is `DavideCarvalho/adonis-authkit`).
- Body: Setup → 2–4 Core Patterns → ≥3 Common Mistakes (Wrong/Correct real code +
  mechanism + Source). Every code block complete, real imports, no placeholders.

## Remaining Gaps (what a maintainer interview would have answered)

- **No interview ran.** Priorities/severities are inferred from source, stubs and
  READMEs (partly pt-BR), not confirmed by a maintainer.
- **Adapter choice guidance unknown** (Redis vs database) — see domain_map gaps.
- **JWKS posture in production** (`jwks:'auto'` vs managed with explicit `store`,
  and which vault backend is "blessed") is undocumented; the skill presents the
  surface, not a recommendation.
- **`verifyCredentials` ↔ `accountStore` contract** — whether custom credentials
  sources must resolve the same identity the accountStore serves is inferred, not stated.
- **`resolveUser` topology recommendation** for new client apps is not documented.
- **No GitHub issue mining** — real-world failure modes are inferred from code
  comments, READMEs and config JSDoc, not observed reports.
- **Docs site is "coming soon"** — `apps/docs` exists in-repo but was not mined this
  pass beyond package READMEs; a follow-up pass should mine it for the SDK and
  Admin API surfaces.
