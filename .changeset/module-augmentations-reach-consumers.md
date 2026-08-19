---
'@adonis-agora/authkit-client': patch
'@adonis-agora/authkit-server': patch
---

Ship the module augmentations so they actually reach a consuming app.

**The client.** `HttpContext.auth` was declared in the package's root `types.ts`,
and nothing reachable from `build/index.d.ts` referenced that file — so TypeScript
never loaded it in a host app and `ctx.auth` came back as `Property 'auth' does
not exist on type 'HttpContext'`, no matter what the app imported. Verified
against packed tarballs in a scratch AdonisJS app across five wiring variants; a
`/// <reference path>` straight at the built `types.d.ts` type-checked cleanly,
which isolates it to reachability rather than to the declarations. The
augmentation is now pulled in by a bare side-effect import from
`authkit_middleware` — the middleware that actually assigns `ctx.auth`, and the
one `configure` registers.

Putting that import in `index.ts` was considered and rejected: apps that hand
`ctx.auth` to `@adonisjs/auth` through `authkitClientGuard` would then load two
competing `HttpContext.auth` declarations, and because `skipLibCheck` is on in
every AdonisJS app the conflict is not reported — one simply wins by include
order. Anchoring on the middleware keeps the two owners of `ctx.auth` mutually
exclusive, the same way `@adonisjs/auth` does with its own
`initialize_auth_middleware`.

**The server** was a smaller problem than it first looked. Hosts *were* getting
`app.container.make('authkit.server')` typed all along, because the service
provider carried its own copy of the `ContainerBindings` declaration and every
host registers the provider. What was broken is that `exports["./types"]` pointed
at the barrel rather than at the built `types.js`, so importing
`@adonis-agora/authkit-server/types` gave `Property 'authkit.server' does not
exist on type 'ContainerBindings'`.

Retargeting that subpath exposed a second problem: the root `types.ts` declared
one binding while the provider declared four, so the newly-live subpath was a
partial view. Two binding tables with nothing checking they agree is how they
drifted in the first place, so there is one table now — in `types.ts`, with the
provider reaching it through a side-effect import.

**`adonisjs.types` covers neither package.** No version of `@adonisjs/core`,
`@adonisjs/assembler` or `@adonisjs/application` in this repo's dependency tree
reads that package.json field. It is an AdonisJS 5 leftover, left alone.
