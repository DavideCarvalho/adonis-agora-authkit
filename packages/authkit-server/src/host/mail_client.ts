import type { HttpContext } from '@adonisjs/core/http';
import type { MailHookClient, ResolvedServerConfig } from '../define_config.js';

export type MailClient = MailHookClient;

/**
 * Monta o `client` dos hooks `mail.on*` (o app da interaction/login em curso) a partir
 * de um `clientId`: `appName` = `branding.clients[clientId].appName`, senão o `client_name`
 * registrado. Sem `clientId` → `undefined` (o hook
 * recebe o payload sem `client`). Best-effort: uma falha ao ler o client registrado
 * só omite `appName`, nunca quebra o envio.
 */
export async function resolveMailClient(
  ctx: HttpContext | undefined,
  cfg: Pick<ResolvedServerConfig, 'branding'> | undefined,
  clientId: string | null | undefined,
): Promise<MailClient | undefined> {
  if (!clientId) return undefined;
  const branded = cfg?.branding?.clients?.[clientId]?.appName;
  if (branded) return { clientId, appName: branded };
  const registered = await registeredClientName(ctx, clientId);
  return registered ? { clientId, appName: registered } : { clientId };
}

async function registeredClientName(
  ctx: HttpContext | undefined,
  clientId: string,
): Promise<string | undefined> {
  try {
    const service = (await ctx?.containerResolver?.make?.('authkit.server')) as
      | { provider?: { Client?: { find?: (id: string) => Promise<unknown> } } }
      | undefined;
    const client = (await service?.provider?.Client?.find?.(clientId)) as
      | { clientName?: unknown }
      | undefined;
    return typeof client?.clientName === 'string' && client.clientName
      ? client.clientName
      : undefined;
  } catch {
    return undefined;
  }
}

/** `{ client }` quando há client, `{}` senão — para espalhar no payload do hook. */
export function mailClientField(client: MailClient | undefined): { client?: MailClient } {
  return client ? { client } : {};
}
