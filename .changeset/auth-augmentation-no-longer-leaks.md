---
'@adonis-agora/authkit-client': patch
'@adonis-agora/authkit-server': patch
---

Importing the middleware no longer forces `HttpContext.auth` on your app.

**If you pinned to 0.17.1 to get your typecheck passing, this releases you.**

0.17.2 added `import '../../types.js'` to the middleware's emitted declarations so
that `ctx.auth` would be typed for apps that had no declaration of their own. But
that same file also carries the library's *unparameterised*
`auth: Authenticator`, and `start/kernel.ts` imports the middleware — so the
declaration entered every consumer's type program.

`HttpContext.auth` declared twice with different types does not merge.
TypeScript keeps whichever declaration it reached first and reports the conflict
on the other; that conflict lands inside a `.d.ts`, where `skipLibCheck` — on in
every AdonisJS app — discards it. The library's file is reached first through the
kernel, so an app's own `auth: Authenticator<AppUser>` lost and `getUser()`
collapsed to `unknown` **across the entire codebase**. One app went from 24 type
errors to 351, another from 0 to 105, with nothing pointing at the cause.

The two augmentations are now separate modules:

- `container_bindings.ts` declares only `ContainerBindings['authkit.client']`, a
  key nothing else can claim. The provider and the middleware import this, so
  `containerResolver.make('authkit.client')` stays typed.
- `types.ts` declares only `HttpContext.auth`, and **nothing in the package
  imports it**. Apps that want the library's default typing opt in with
  `import '@adonis-agora/authkit-client/types'`; apps that declare their own
  parameterised version are left alone.

The library's middleware reads and writes `ctx.auth` through a local cast rather
than a global declaration, so the knowledge stays inside the package.

Nothing changes at runtime, and no app-level change is required: if you already
declare `auth: Authenticator<AppUser>`, it now simply wins, because it is the
only declaration in the program.

A spec walks the emitted declaration graph and fails if any consumer entrypoint
reaches the `HttpContext.auth` augmentation again — the monorepo's own typecheck
compiles every file in one program and structurally cannot catch this.

`@adonis-agora/authkit-server` was checked for the same defect and does not have
it: it ships no `HttpContext.auth`, and its four container bindings still reach
hosts through both the provider and the `./types` subpath. It gets the same guard
anyway, because the thing protecting it is easy to break by accident —
`src/host/augmentations.ts` loads the framework's own augmentations with
`import type {} from '…'`, a form tsc erases from the emitted declarations, and
rewriting any one of them as a bare `import '…'` would inherit
`@adonisjs/auth`'s `HttpContext.auth` and reproduce this bug package-wide. Both
guards now also reject a bare side-effect import of any external module from a
shipped declaration file.
