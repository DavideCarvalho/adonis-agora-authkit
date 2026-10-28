---
"@adonis-agora/authkit-server": minor
---

fix(social): social login now honors the account's second factor, and no longer links or creates accounts from an e-mail the provider reports as unverified.

- The social callback used to call `completeLogin` right after the provider, so an account with TOTP or a passkey skipped it on "Continue with Google" while password, magic link and OTP went through `secondFactorGate`. When the account owes a factor, the callback now stores a one-shot pending login and redirects to the new `GET /auth/interaction/:uid/social/continue`, which runs the same gate (`amr: ['fed', ...]`).
- New `social.secondFactor` option: `'enrolled'` (default: challenge when a factor is enrolled), `'required'` (always; accounts without a factor see the "set up MFA" screen) or `'never'` (previous behavior), or a function per account, e.g. `'required'` for admin roles.
- When the provider reports `emailVerificationState: 'unverified'`, the callback no longer links the identity to an existing account by e-mail nor creates a new one. New accounts are created with `emailVerified` only when the provider confirmed the address (previously always `true`).

Accounts without an enrolled factor log in exactly as before.
