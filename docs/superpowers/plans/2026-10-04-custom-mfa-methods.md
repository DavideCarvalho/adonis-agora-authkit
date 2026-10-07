# Custom MFA methods plan

**Goal:** Add provider-neutral MFA classes and policies supporting two or more distinct factors to AuthKit, without activating new MFA methods in MeuProntoo.

**Architecture:** A host registers method classes or instances. Each method reports enrollment, describes fields, optionally starts a challenge, and verifies a proof. AuthKit binds challenges to the authenticated account/OIDC interaction, enforces expiry/attempts and distinct factor groups, and completes login only after the configured total factor count. Native TOTP/recovery/passkeys remain available. Recovery shares the TOTP factor group. Delivery adapters remain separate from authentication.

**Policy:** requiredFactors counts the primary factor plus additional distinct groups, default 2. Host methods explicitly report isEnabled; registration alone never enables a factor for an account. A group matching the primary cannot count twice. Custom primary classes may identify their factor group (e.g. WhatsApp/SMS phone possession). Existing deployments without mfa config keep their native behavior.

- Test generic runtime class/instance DI, enrollment, challenge binding, expiry, failed proofs, challenge start, replay and distinct group counting.
- Test native/shared controller gate for custom MFA, complete three-factor chains, combination with TOTP, primary-group exclusion and expired challenge rejection.
- Add optional MFA registry/policy config and exports; integrate class handlers and named CSRF/throttled native form endpoints.
- Extend Edge and generated React challenge UI with generic method descriptors, leaving MeuProntoo pages and MFA settings unchanged.
- Document custom WhatsApp/SMS/provider implementations and add changeset. Build/source typecheck/full regression tests; refresh app source artifact and run existing WhatsApp regression suite.

Meuprontoo policy remains: common people use WhatsApp login; laboratories, clinicians, pharmacies and other professional users retain email. This task does not enable new additional factors in that application.

Validation completed: 2,249 server tests passed; server, UI and existing test-type ratchet checks passed (273 baseline); production package build passed. Independent review identified live-interaction and custom-password-policy gaps, which were corrected and covered by regressions. App MFA registration remains absent.
