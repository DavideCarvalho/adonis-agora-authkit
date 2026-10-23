---
'@adonis-agora/authkit-server': patch
---

Durable account-lifecycle runs are now attributed to `@adonis-agora/authkit-server` (`WorkflowRun.origin`), so the durable console's ORIGIN facet separates them from the app's own runs. `enqueueAccountDeletion` / `enqueueAccountExport` stamp the origin at start, and `defineAccountDeletionWorkflow` / `defineAccountExportWorkflow` now also return `options: { origin }` to pass as the fourth `engine.register` argument. Engines older than `@adonis-agora/durable` 0.36 ignore it.
