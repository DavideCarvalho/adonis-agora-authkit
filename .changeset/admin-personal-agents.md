---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-react': minor
---

Admin console: a **Personal agents** page (PACT and Poppy). Lists every agent with its live
connection count, lists and revokes connections across all accounts, and allows or blocks agents
at runtime on top of `defineConfig` (lib-owned `auth_agent_registry` table). Blocking also revokes
every connection and ends the agent's Poppy sessions. Writes need sudo and are audited.
`@adonis-agora/authkit-react` gets the matching `client.admin.personalAgents.*` methods and query
options.
