---
"@adonis-agora/authkit-server": minor
"@adonis-agora/authkit-client": minor
---

Encryption at rest and webhook signatures through the Agora crypto kit (a verbatim copy at `src/crypto-kit/`, the same in every Agora lib), on top of Adonis' own encryption.

**authkit-server**
- The managed JWKS keystore and the TOTP secrets (`auth_mfa.totp_secret`) are sealed with the app's `encryption` service (`config/encryption.ts`), each bound to its use (`authkit:keystore`, `authkit:account-secrets`) and, for TOTP, to its account. Values written by earlier versions (the app's encryption, no purpose; keystore envelope `aes`) still open — no migration step. New writes use the kit's `agora:v1:` format (keystore envelope `agora`). An older AuthKit instance can't read a keystore rewritten by this version (e.g. after a rotation): upgrade every instance together.
- New `crypto` option: `keys` (newest first: the first seals, all open), `encryption` (an Adonis encryption instance) or `kms` (envelope encryption).
- `node ace authkit:crypto:reseal [--dry-run] [--all] [--json]` rewrites values sealed with an older key or in the old format (`--all`: every value, after rotating `config/encryption.ts`). Compare-and-swap writes; exit 1 when a value doesn't open.
- `authkit.crypto` doctor check (`--deep`): warns on old-format or retired-key values, errors on values that don't open.
- `AccountSecretEncrypter` may now be async and receives `{ accountId }`; `appKeyEncrypter()` is async (custom sync encrypters keep working).
- Webhooks are signed with Ed25519 on every delivery: `x-authkit-signature-ed25519: agora:sig1:<kid>:<sig>`. The public keys are in the discovery document as `authkit_webhook_jwks`. The default key is derived from `APP_KEY`; `events.signing: { keys }` gives your own (private Ed25519 JWKs, newest first), `false` turns it off. The HMAC `x-authkit-signature` is still sent when `webhook.secret` is set.

**authkit-client**
- `registerAuthkitWebhook` / `authkitWebhookHandler` verify the Ed25519 signature with the issuer's discovery keys (`issuer`), or given keys (`jwks`): no shared secret needed. Unknown key ids refetch the discovery (at most every `refreshCooldownMs`, default 30 s). `secret` is now optional; with it, the HMAC header is accepted too. New export: `webhookKeys`.
