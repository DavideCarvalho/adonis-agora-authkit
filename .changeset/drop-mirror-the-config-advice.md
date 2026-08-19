---
'@adonis-agora/authkit-server': patch
---

Stop the `AuthHostOptions` docblocks telling hosts to mirror policy options.

`social`, `rateLimit`, `sudoMethods` and the on/off of `admin`/`adminApi` are
policy: once `defineConfig` declares one, `registerAuthHost` ignores the matching
argument, warns on boot, and lists the key in `AuthHostRouteMap.overriddenByConfig`.
The docblocks still said "mirror `rateLimit` from config/authkit.ts" and "when
enabled, the host must also pass `admin: true`" — advice that now produces a
boot warning and an argument with no effect.

Each affected docblock now states the real precedence, and the `admin`/`adminApi`
entries spell out the two axes: the on/off is policy (config wins and locks),
the prefix is structural (the argument still wins).
