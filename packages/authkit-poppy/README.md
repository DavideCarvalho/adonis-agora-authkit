# @adonis-agora/authkit-poppy

The [Personal Agent Protocol ("Poppy")](https://personalagentprotocol.org/docs/spec) for
[AuthKit](https://davidecarvalho.github.io/agora/docs/authkit): discovery (`poppy.json`), signed
`Poppy-Session` agent sessions, Direct / Device / Mediated sign-in, DPoP, MCP tokens and browser
sessions — as an extension of `@adonis-agora/authkit-server`.

> **Experimental.** Poppy is a draft spec (this package targets Draft 0.3). The package stays on
> 0.x and any minor can break; pin it with `~0.x.y`.

```sh
node ace add @adonis-agora/authkit-poppy
```

```ts
// config/authkit.ts
import { poppy } from '@adonis-agora/authkit-poppy'

export default defineConfig({
  // ...
  personalAgents: {
    extensions: [
      poppy({
        organization: { name: 'Acme', domain: 'acme.com' },
        scopes: { 'orders:read': 'See your orders' },
      }),
    ],
  },
})
```

```ts
// start/routes.ts
import { poppyAuth, poppyOf } from '@adonis-agora/authkit-poppy'

router
  .get('/orders', async (ctx) => listOrders(poppyOf(ctx)!.accountId))
  .use(poppyAuth({ scopes: ['orders:read'] }))
```

Guide: [Personal agents — Poppy](https://davidecarvalho.github.io/agora/docs/authkit/personal-agents-poppy).
