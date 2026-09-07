---
'@adonis-agora/authkit-server': patch
---

As telas built-in de login/consent/signup crashavam com `TypeError: Cannot read properties of undefined (reading 'clients')` quando o host não declarava `branding` no `defineConfig` — a config MÍNIMA que getting-started, quickstart e reference documentam. `branding` é tipado opcional, mas o interaction controller (e o registration controller) liam `cfg.branding!.clients`/`cfg.branding!.default` incondicionalmente, sem nenhum default aplicado na resolução do config.

Adicionado `resolveBranding` (`src/host/branding.ts`), seguindo o mesmo padrão já usado para as demais seções opcionais do config (`resolveRateLimit`, `resolveLockout`, `resolveAdmin`, etc.): quando o host não declara `branding`, `defineConfig` agora resolve um `BrandingConfig` default neutro (`clients: {}`, `firstParty: []`, um `default` de tema genérico) em vez de deixar o campo `undefined`. `ResolvedServerConfig.branding` deixou de ser opcional — está sempre presente após a resolução.
