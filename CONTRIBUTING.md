# Contributing to AuthKit

Thanks for your interest in contributing! AuthKit is a pnpm monorepo of packages
(`packages/authkit-{core,server,client,react,testing}`) plus a docs site
(`apps/docs`).

## Setup

```sh
# Requires Node >= 24 and pnpm 11.x
corepack enable
pnpm install
```

## Workflow

Build, typecheck and test the whole workspace:

```sh
pnpm -r build       # topological: core first, then dependents
pnpm -r typecheck
pnpm -r test
pnpm smoke          # packaging smoke: imports every built module
```

Run a single package:

```sh
pnpm --filter @adonis-agora/authkit-server test
```

Format before committing:

```sh
pnpm format         # prettier --write
pnpm lint           # prettier --check (CI gate)
```

### Notes

- The `core` package must build before the others (its `.d.ts` are consumed by
  the rest). `pnpm -r build` already orders this topologically.
- Peers (`@adonisjs/session`, `shield`, `ally`, `limiter`, `edge.js`, …) are
  **never** hard-imported by the library. The import smoke (`pnpm smoke`)
  enforces this against the build output.

## Changesets (release flow)

We use [Changesets](https://github.com/changesets/changesets) to version and
publish. When your change affects a published package, add a changeset:

```sh
pnpm changeset
```

Pick the affected packages and the semver bump (patch/minor/major) and write a
short summary — it becomes the CHANGELOG entry. Commit the generated file in
`.changeset/` with your PR.

Maintainers merge changesets into `main`; the Release workflow opens a "Version
Packages" PR and, once merged, publishes to npm (with provenance).

## Pull requests

- Branch from `main`.
- Keep PRs focused; add/adjust tests for behavior changes.
- Make sure `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm smoke`
  all pass locally.
- Add a changeset for user-facing changes.

## Commit messages

Conventional-ish prefixes are appreciated (`feat:`, `fix:`, `docs:`, `chore:`,
`test:`). Scope by package when helpful, e.g. `feat(authkit-server): ...`.
