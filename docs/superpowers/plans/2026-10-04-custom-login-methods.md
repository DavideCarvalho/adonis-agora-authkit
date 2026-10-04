# Custom login methods implementation plan

**Goal:** Support host-defined authentication classes in AuthKit and remove MeuProntoo's dependency patch.

**Architecture:** The host registers a class under a stable method name. Adonis resolves its dependencies; its authenticate method establishes proof and returns an account ID. AuthKit owns account policies, maintenance, MFA, audit and OIDC completion. Optional begin lets a method start a challenge without imposing an OTP workflow. Host routes, validation and delivery remain host-owned.

**Tech stack:** TypeScript, Adonis container, Japa, pnpm.

- Add regression tests for class resolution, failed proofs, interaction binding, disabled accounts, email policy, MFA and preservation of the custom AMR after MFA.
- Add CustomLoginMethod and binding types, configured registry, begin/authenticate dispatch, trusted completion helper, and extend shared interaction gate.
- Port phone-only account claim/store/deletion fixes with their own regressions.
- Document class registration, DI, proof ownership, optional begin, and host route security responsibilities; add a changeset.
- Build/test the source library, pack a local distributable, install it in MeuProntoo, remove its AuthKit patch, and register the WhatsApp method class.
- Run MeuProntoo WhatsApp regression tests and typecheck; verify clean patch removal and no unrelated edits.

The distributable is built from the source branch and stored in the app repository so dependency installation remains reproducible before the normal library release. No registry publication is required for this local integration.

Validation: server build and source TypeScript check passed; all 2,212 server tests passed. The UI TypeScript check passed after building workspace dependencies. The existing test-type ratchet reports 278 errors against its 273 baseline both on untouched main and on this branch; the new test files add no type diagnostics. MeuProntoo's 33 WhatsApp regressions passed against the source-built package, including native login, MFA and phone-only account deletion.
