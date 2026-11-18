---
'@adonis-agora/authkit-server': minor
---

App graph for other Agora libs. authkit-server publishes a reader on a global slot (`AUTHKIT_APP_GRAPH_SLOT`). The reader lists each service-tenant app once, merging its clients: their ids (`clientIds`), whether every client is disabled, their environments, and the apps it may call with which capabilities. It also returns the catalogs the apps published. Each snapshot is cached for 30 s. Telescope's Architecture page reads it without importing authkit.
