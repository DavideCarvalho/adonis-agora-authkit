# Skill spec — adonis-authkit (autonomous pass)

ONE domain map (see `_artifacts/domain_map.yaml`) covers the whole monorepo. Skills
are scoped to the 3 consumer-facing packages; `authkit-core`, `authkit-sdk`,
`authkit-testing` and the `authkit-vault-*` add-ons are intentionally out of scope
(see Scope decision and Remaining Gaps).

## Scope decision

| Package | Skills | Why |
|---|---|---|
| `@adonis-agora/authkit-server` (0.60.0) | 2 | The flagship: an IdP app's whole setup lives here — config/adapter/JWKS + route mounting, and the host-owned interaction screens. |
| `@adonis-agora/authkit-client` (0.18.0) | 1 | The relying-party side: one skill covers config, resolvers, middleware ordering and session consumption end-to-end. |
| `@adonis-agora/authkit-react` (0.20.0) | 1 | Frontend ergonomics: `useAuth()` + gating + `AuthkitProvider` form one coherent surface. |

Total: 4 SKILL.md files (right-sized within the ~5–7 budget; the server's two
domains are the only ones with distinct developer moments worth splitting). Flat
structure (`packages/<pkg>/skills/<skill>/SKILL.md`),
all `metadata.type: core`, `router: false` (the `intent list` CLI is the discovery
surface; <15 skills).

### Vault providers & testing utilities — summarized, not split out (recorded decision)

Per task constraints, the vault provider add-ons (`@adonis-agora/authkit-vault-aws`,
`-azure`, `-gcp`, each exporting `createKeystoreVault` over a `SecretBackend`) and the
testing package (`@adonis-agora/authkit-testing`: `createTestIdentity`,
`mintTestIdToken`, `serveJwks`, `fakeAuthenticator`, `fakeAccountStore`) do NOT get
their own skills. They are summarized inside the server skills:

- The **keystore vault surface** (`jwks.store`: `file` / `drive` / `lucid` / `redis` /
  `hashicorp` built-ins via `resolveKeystoreVault`, plus the three cloud add-ons and
  the "pass any object with `read()`" SPI) is summarized in `authkit-idp-setup`
  (it is a config-surface concern of `defineConfig`).
- The **testing utilities** are summarized in `authkit-interactions`
  (the skill where an agent most often needs to test the login flow end-to-end:
  `mintTestIdToken` + `serveJwks` + `fakeAuthenticator` are the building blocks).

Rationale: each add-on's public surface is one function; a dedicated skill per
add-on would be a single-pattern file and dilute routing. If the vaults grow
config surfaces (per-provider auth, caching, key labels), revisit with one
`authkit-vault-providers` skill.

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
- **authkit-sdk, authkit-testing, authkit-core, authkit-vault-\*** have no dedicated
  skills (scope decision above); their workflows were only summarized.
- **No GitHub issue mining** — real-world failure modes are inferred from code
  comments, READMEs and config JSDoc, not observed reports.
- **Docs site is "coming soon"** — `apps/docs` exists in-repo but was not mined this
  pass beyond package READMEs; a follow-up pass should mine it for the SDK and
  Admin API surfaces.
