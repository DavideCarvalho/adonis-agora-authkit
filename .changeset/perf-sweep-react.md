---
"@adonis-agora/authkit-react": patch
---

Performance: smaller bundles and fewer re-renders.

- The package declares `"sideEffects": ["*.css"]`, so bundlers drop the modules an app doesn't import. A bundle that imports only `useAuth` went from 3.1 kB to 0.8 kB minified. `styles.css` is still kept as a side effect.
- `AuthkitProvider` memoizes the resolved config on the `config` prop, and `AuthkitClientProvider` memoizes the client it creates on the `client`/`opts` props. Before, each render of these providers produced a new context value, which re-rendered every consumer.
