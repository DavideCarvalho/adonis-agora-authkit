/**
 * Nome de exibição de cada client: o `client_name` que ele registrou (um cliente MCP registra o
 * seu, ex.: "Claude Code"), senão o próprio `client_id`. Client que sumiu do adapter → o id.
 */
export async function clientDisplayNames(
  service: { provider: { Client: { find(id: string): Promise<any> } } },
  clientIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(clientIds)].map(async (clientId) => {
      const client = await service.provider.Client.find(clientId).catch(() => null);
      names.set(clientId, client?.clientName || clientId);
    }),
  );
  return names;
}
