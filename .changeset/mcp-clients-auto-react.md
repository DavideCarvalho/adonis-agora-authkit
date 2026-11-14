---
"@adonis-agora/authkit-react": minor
---

Admin client: `admin.mcpClients.status()` / `admin.mcpClients.update()` with `useMcpClientsQueryOptions` / `useUpdateMcpClientsMutationOptions`, for the live state and switch of automatic MCP client login. Also `admin.clients.revoke(id)` with `useRevokeClientMutationOptions`. `AdminClient` now carries `dynamicallyRegistered`, `registeredAt` and `scope`.
