---
'@adonis-agora/authkit-server': patch
---

Widen the optional `@adonisjs/redis` peer to include `^11.0.0` — apps upgrading to redis 11 no
longer hit a peer conflict. No code change: the surface authkit-server touches is unchanged across
the major.
