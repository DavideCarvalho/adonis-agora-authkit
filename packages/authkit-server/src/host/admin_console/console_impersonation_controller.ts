import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { apiError } from '../admin_api/dto.js';
import { AdminClientsService } from '../admin_clients_service.js';
import { type ImpersonationClientLike, buildImpersonationPanel } from '../impersonation.js';
import { resolveRuntimeSettingsOrNoop } from '../runtime_settings.js';
import { resolveEffectiveAdminImpersonation } from '../runtime_toggles.js';

/**
 * Endpoint JSON do painel de impersonation do console admin React.
 *
 * GET {prefix}/api/impersonation/:userId
 *
 * Retorna os parâmetros RFC 8693 (token exchange) para o admin assumir a
 * identidade de um usuário-alvo. 404 quando impersonation está desabilitado na
 * config, quando a setting de runtime `admin_impersonation` desliga o painel, ou
 * quando nenhum client tem o grant token-exchange habilitado.
 *
 * DUAS CAMADAS, PROPOSITALMENTE ASSIMÉTRICAS:
 *
 *   1. `config.admin.impersonation` decide se a CAPACIDADE existe. É decisão de
 *      boot: é ela que registra (ou não) o grant RFC 8693 no provider OIDC. Uma
 *      setting de runtime não desregistra rota que nunca foi registrada.
 *   2. a setting `admin_impersonation` decide se o CONSOLE OFERECE o painel.
 *      É decisão de runtime, mudável sem redeploy.
 *
 * A setting só APERTA, nunca AFROUXA — o gate de config é checado ANTES dela, e
 * declarar `admin.impersonation` no `defineConfig` TRAVA a key (ver
 * `host/config_locks.ts`), de forma que `getSetting` devolve null e o resolver
 * cai no valor do config. Config > runtime, a mesma precedência do resto da lib.
 */
export default class ConsoleImpersonationController {
  async handle(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    // Camada 1 — o kill switch de config. Sem ele o grant token-exchange nem
    // existe no provider; devolver os parâmetros do painel seria mentir.
    if (!cfg.admin.impersonation) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'Impersonation não está habilitado nesta instalação.'),
      );
    }

    // Camada 2 — a política de runtime. Fail-safe: sem tabela `auth_settings`
    // (ou com a key travada por config) o resolver cai no valor do config.
    const runtimeSettings = await resolveRuntimeSettingsOrNoop(ctx);
    const effective = await resolveEffectiveAdminImpersonation(
      runtimeSettings,
      cfg.admin.impersonation,
    );
    if (!effective.enabled) {
      return ctx.response.notFound(
        apiError(
          'capability_unsupported',
          'O painel de impersonation está desligado pela setting de runtime `admin_impersonation`.',
        ),
      );
    }

    const targetId = ctx.request.param('userId') as string;
    const account = await cfg.accountStore.findById(targetId);
    if (!account) {
      return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));
    }

    // Clients de RUNTIME. `cfg.clients` é sempre `[]` num host real — clients
    // vivem no adapter, criados pelo console/Admin API/`authkit:clients:create`.
    // Ler só o config fazia o painel devolver 404 SEMPRE, que é por que o botão
    // do console nunca funcionou. O fallback para o config cobre hosts legados
    // com clients estáticos e adapters que não enumeram.
    const panel = buildImpersonationPanel(cfg, targetId, await listRuntimeClients(service));
    if (!panel) {
      return ctx.response.notFound(
        apiError(
          'no_token_exchange_client',
          'Nenhum client habilitado ao grant token-exchange encontrado.',
        ),
      );
    }

    // Auditoria: o admin REVELOU os parâmetros de impersonation do alvo. Não é
    // `impersonation` — nenhuma identidade foi assumida aqui; quem registra isso
    // é o handler do token-exchange, quando o exchange de fato acontece
    // (`provider/token_exchange.ts`). Registrar "impersonation.started" neste
    // ponto fazia a trilha de auditoria afirmar uma impersonação que podia
    // nunca ocorrer — e, com o painel quebrado, NUNCA ocorria.
    //
    // Emitido DEPOIS de o painel existir: um evento antes do sucesso audita uma
    // intenção que a própria lib então recusa.
    await cfg.audit?.record({
      type: 'impersonation.panel_viewed',
      accountId: targetId,
      actorId: (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null,
      ip: ctx.request.ip?.() ?? null,
      metadata: { clientId: panel.clientId, channel: 'admin-console' },
    });

    return {
      targetUserId: targetId,
      targetEmail: account.email,
      ...panel,
    };
  }
}

/**
 * Clients persistidos que podem hospedar o token-exchange. Best-effort: um
 * adapter sem `list` (ou que falhe) devolve lista vazia e o
 * `buildImpersonationPanel` cai no `cfg.clients`.
 */
async function listRuntimeClients(service: {
  config: unknown;
}): Promise<ImpersonationClientLike[]> {
  try {
    const clients = new AdminClientsService(service as never);
    if (!clients.canList) return [];
    return (await clients.list()).map((c) => ({
      clientId: c.clientId,
      grants: c.grants,
      confidential: c.confidential,
    }));
  } catch {
    return [];
  }
}
