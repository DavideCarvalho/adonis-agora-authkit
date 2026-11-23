---
'@adonis-agora/authkit-poppy': major
---

Poppy 1.0. The package now implements the published Personal Agent Protocol 1.0 and serves version `1.0` only; its version follows the spec version.

Breaking changes for apps:

- `agent.protocols[]` entries need a `description` (what the agent there can help with). An endpoint announced through the `@adonis-agora/poppy:endpoints` slot is published only with a `description` next to `conversations`.
- `feedback` and `excludedTasks` moved into `tasks` (`tasks.feedback`, `tasks.excludedTasks`, plus `tasks.skillIndex` and `tasks.resolve`); the package serves `GET /poppy/tasks` and lists it as `tasks.endpoint`. Pass `tasks: { endpoint }` to serve your own.
- `extensions` takes a list with one entry per version: `{ name: [{ version: '1', … }] }`.
- `poppy:browser-sign-in` is added to the scopes when browser join and sign-in are on; joining a browser with an access token needs it. `web.unscoped` (default `true`) and `web.disabled` are new.
- Requests verified with the Session header need `Poppy-Version: 1.x` (`version_unsupported` otherwise). Ended Sessions and account changes answer `session_ended`. Sessions are keyed by `client_id` + `sid` + User ID. Failures carry a `body` to send as JSON.
- Delegations are `poppy-delegation+jwt` in the `poppy_dlg` header.
- `assertionMaxLifetime` can't be lower than 300.

New: Pushed Authorization Requests (`POST /poppy/oauth/par`, `par: { required }`), refresh tokens bound to the sign-in's DPoP key (`dpop.bindRefreshTokens`), `auth.disabled` when no sign-in type is on, `organization.domain` with its port, `scopes_supported` in the protected resource metadata, `resource=https://{domain}` for the default token, `protocolVersion` and `extensions` on the principal, and `verifyPoppyRequest(…, { extension })`. A new table, `auth_poppy_grant_keys`, is created with the others.
