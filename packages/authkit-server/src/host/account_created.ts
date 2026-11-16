import type { HttpContext } from '@adonisjs/core/http';
import type {
  AccountCreatedEvent,
  AccountCreatedSource,
  ResolvedServerConfig,
} from '../define_config.js';

type Logger = { error?: (...args: unknown[]) => void };

/**
 * Dispara o `onAccountCreated` do host para uma conta que acabou de nascer. Chamado pelos
 * caminhos que criam conta (cadastro, login social, admin, import), uma vez por conta,
 * depois do ponto em que a criação não é mais desfeita.
 *
 * Aguardado (o que o hook grava vale já para o login seguinte) e FAIL-SAFE: um hook que
 * lança só é logado — a conta fica e o fluxo segue. Mesma regra dos alertas de login.
 */
export async function notifyAccountCreated(
  cfg: Partial<Pick<ResolvedServerConfig, 'onAccountCreated' | 'branding'>>,
  input: {
    account: { id: string; email: string | null };
    source: AccountCreatedSource;
    provider?: string;
    clientId?: string | null;
    actorId?: string | null;
  },
  context: { ctx?: HttpContext; logger?: Logger } = {},
): Promise<void> {
  const hook = cfg.onAccountCreated;
  if (!hook) return;
  const logger: Logger | undefined = context.logger ?? (context.ctx?.logger as Logger | undefined);
  try {
    const client = await resolveClient(cfg, context.ctx, input.clientId);
    const event: AccountCreatedEvent = {
      account: { id: input.account.id, email: input.account.email ?? null },
      source: input.source,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(client ? { client } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    };
    await hook(event);
  } catch (error) {
    logger?.error?.(
      { err: error, accountId: input.account.id, source: input.source },
      'authkit: falha no hook onAccountCreated',
    );
  }
}

async function resolveClient(
  cfg: Partial<Pick<ResolvedServerConfig, 'branding'>>,
  ctx: HttpContext | undefined,
  clientId: string | null | undefined,
): Promise<AccountCreatedEvent['client']> {
  if (!clientId) return undefined;
  const branded = cfg.branding?.clients?.[clientId]?.appName;
  if (branded) return { clientId, appName: branded };
  try {
    const service = (await ctx?.containerResolver?.make?.('authkit.server')) as
      | { provider?: { Client?: { find?: (id: string) => Promise<unknown> } } }
      | undefined;
    const client = (await service?.provider?.Client?.find?.(clientId)) as
      | { clientName?: unknown }
      | undefined;
    if (typeof client?.clientName === 'string' && client.clientName) {
      return { clientId, appName: client.clientName };
    }
  } catch {
    // Sem o client registrado: segue só com o clientId.
  }
  return { clientId };
}
