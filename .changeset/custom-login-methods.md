---
"@adonis-agora/authkit-server": minor
---

Support host-defined primary login methods as dependency-injected classes or instances. Add beginCustomLogin, authenticateCustomLogin, and trusted completeCustomLogin APIs, preserving account policies, maintenance, MFA, audit and OIDC authentication method claims.

Support verified phone identity in the Lucid account DTO and account deletion confirmation for accounts without email. Omit absent email claims and report actual email verification state.
