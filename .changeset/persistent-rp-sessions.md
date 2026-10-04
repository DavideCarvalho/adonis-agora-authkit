---
'@adonis-agora/authkit-server': minor
---

Support opt-in same-host RP session restoration and rolling remembered-session renewal directly in AuthKit. Database and Redis adapters renew existing persistent sessions atomically without recreating expired or revoked records. RP logout revokes the signed IdP credential, and bridged console login preserves its IdP session association after synchronizing the host guard.
