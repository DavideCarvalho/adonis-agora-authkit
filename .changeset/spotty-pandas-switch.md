---
"@adonis-agora/authkit-server": minor
---

feat(config): `session.adapter` splits OIDC storage by model lifetime

New opt-in `session: { adapter }` in `defineConfig`: session-scoped models
(`Session`, `Grant`, `AccessToken`, `RefreshToken`, `AuthorizationCode`,
`Interaction`, `DeviceCode`, PAR/CIBA — see `SESSION_SCOPED_MODELS`) use the
session adapter (e.g. Redis), everything else (`Client` in particular) stays
on the default `adapter` (e.g. database). Without `session`, both resolve to
the same class — zero behavior change.

Recommended split: sessions in Redis (ephemeral, native TTL, same fate as the
app session) and the rest in the database (losing `Client` is a full auth
outage). `AdminSessionsService`, the account-API session revoke and the
provider dispatcher all follow the same `pickModelAdapterClass` rule, so the
console reads sessions from the right backend.
