# Extensible WhatsApp code delivery plan

**Goal:** Let hosts choose native Meta/Whatsmiau adapters or arbitrary provider classes without changing AuthKit's login proof flow.

**Architecture:** AuthKit exposes WhatsappCodeSender, its input and class/instance binding, and a DI-aware resolver. Optional whatsapp.sender config stores the binding. The host owns OTP issuance/verification and account mapping; the sender only transports the code. Official Meta sends an authentication template, Whatsmiau sends localized text supplied by the host. Custom implementations use the same interface.

**Tech stack:** TypeScript, Adonis request/app container, fetch, Japa.

1. Test sender resolution, DI, real request payloads and sanitized provider failures before implementing native adapters.
2. Expose optional typed whatsapp.sender in AuthKit config and public exports; document instance/class registration and add a changeset.
3. Test that MeuProntoo sends codes through an injected custom sender with expiry/locale metadata, preserving atomic proof consumption and failed-delivery handling.
4. Configure native sender selection in the app, pass metadata to requestWhatsappCode, and derive login availability from configured sender rather than Whatsmiau credentials.
5. Build and test AuthKit; refresh its source package in vendor and lockfile. Run app OTP/HTTP regressions and TypeScript checks. No provider calls, npm publication or deployment.

Validation completed: AuthKit build, source/UI/test type checks passed; all 2,224 library tests passed. Native adapter payload/DI/redirect tests passed. MeuProntoo's 35 WhatsApp regression tests passed, with 10 OTP/login tests rechecked after final assertion typing fixes; app TypeScript, i18n and ESLint checks passed. The file dependency integrity matches the generated source package.
