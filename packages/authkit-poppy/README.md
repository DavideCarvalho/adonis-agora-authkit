# @adonis-agora/authkit-poppy

The [Personal Agent Protocol ("Poppy") 1.0](https://personalagentprotocol.org/docs/1.0/spec) for
[AuthKit](https://davidecarvalho.github.io/agora/docs/authkit): discovery (`poppy.json`), signed
`Poppy-Session` agent sessions, Direct / Device / Mediated sign-in, DPoP, MCP tokens and browser
sessions — as an extension of `@adonis-agora/authkit-server`.

> The package version follows the spec version it implements: `1.x` is Poppy `1.x`.

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
