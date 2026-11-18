---
'@adonis-agora/authkit-server': minor
---

App graph for other Agora libs. authkit-server publishes on a global slot (`AUTHKIT_APP_GRAPH_SLOT`) a reader that lists each service-tenant app: its client, whether the client is disabled, its environment, and the apps it may call with which capabilities. The reader also returns the catalogs the apps published. Each snapshot is cached for 30 s. Telescope's Architecture page reads it without importing authkit.
