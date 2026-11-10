/**
 * Nome de exibição de cada client: o `client_name` que ele registrou (um cliente MCP registra o
 * seu, ex.: "Claude Code"), senão o próprio `client_id`. Client que sumiu do adapter → o id.
 */
export async function clientDisplayNames(
  service: ClientLookup,
  clientIds: string[],
): Promise<Map<string, string>> {
  const info = await clientDisplayInfo(service, clientIds);
  return new Map([...info].map(([id, v]) => [id, v.name]));
}

type ClientLookup = { provider: { Client: { find(id: string): Promise<any> } } };

/** Nome de exibição e logo (`logo_uri` registrado, ou `null`) de cada client. */
export async function clientDisplayInfo(
  service: ClientLookup,
  clientIds: string[],
): Promise<Map<string, { name: string; logoUrl: string | null }>> {
  const info = new Map<string, { name: string; logoUrl: string | null }>();
  await Promise.all(
    [...new Set(clientIds)].map(async (clientId) => {
      const client = await service.provider.Client.find(clientId).catch(() => null);
      info.set(clientId, {
        name: client?.clientName || clientId,
        logoUrl: typeof client?.logoUri === 'string' && client.logoUri ? client.logoUri : null,
      });
    }),
  );
  return info;
}
