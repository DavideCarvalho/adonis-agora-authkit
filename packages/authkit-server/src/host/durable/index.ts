/**
 * Subpath OPT-IN: workflows duráveis para os fluxos LGPD/GDPR de deleção e export
 * de conta. ISOLADO do barrel principal (`@adonis-agora/authkit-server`) — só é
 * carregado quando o app importa `@adonis-agora/authkit-server/durable` e tem o
 * peer OPCIONAL `@adonis-agora/durable` instalado.
 *
 * Quando o modo durável NÃO está ligado (config `accountLifecycle.durable`
 * ausente/false), NADA aqui é importado e o comportamento síncrono de sempre
 * permanece byte-idêntico.
 *
 * Wiring no app:
 *
 * ```ts
 * import { WorkflowEngine } from '@adonis-agora/durable'
 * import {
 *   defineAccountDeletionWorkflow,
 *   defineAccountExportWorkflow,
 * } from '@adonis-agora/authkit-server/durable'
 *
 * const engine = await app.container.make(WorkflowEngine)
 * const oidc = () => app.container.make('authkit.server')
 * const del = defineAccountDeletionWorkflow({ oidc })
 * const exp = defineAccountExportWorkflow({ oidc })
 * engine.register(del.name, del.version, del.body)
 * engine.register(exp.name, exp.version, exp.body)
 * // ...e rode um worker (engine.runPending / runOne) p/ o grupo do authkit.
 * ```
 */

import type { DeletionActor } from '../account_deletion_service.js';
import {
  ACCOUNT_DELETE_WORKFLOW,
  type AccountDeleteWorkflowInput,
} from './account_deletion_workflow.js';
import {
  ACCOUNT_EXPORT_WORKFLOW,
  type AccountExportWorkflowInput,
} from './account_export_workflow.js';

export {
  ACCOUNT_DELETE_WORKFLOW,
  type AccountDeleteWorkflowInput,
  type AccountDeletionWorkflowDeps,
  type DurableStepCtx,
  defineAccountDeletionWorkflow,
  type WorkflowBody,
} from './account_deletion_workflow.js';
export {
  ACCOUNT_EXPORT_WORKFLOW,
  type AccountExportWorkflowDeps,
  type AccountExportWorkflowInput,
  type AccountExportWorkflowResult,
  type DeliverArtifact,
  defineAccountExportWorkflow,
  type PersistArtifact,
} from './account_export_workflow.js';

/**
 * Superfície mínima do `WorkflowEngine` que o enqueue usa (`start` idempotente por
 * run-id). Tipada estruturalmente p/ NÃO acoplar o build ao peer opcional.
 */
export interface EnqueueEngine {
  start(workflow: string, input: unknown, runId: string, opts?: unknown): Promise<unknown>;
}

/** Um resolver de container (`ctx.containerResolver` ou `app.container`). */
export interface ContainerResolverLike {
  make(binding: unknown): Promise<unknown>;
}

/**
 * Resolve o `WorkflowEngine` do container — SÓ no caminho durável. Importa
 * `@adonis-agora/durable` dinamicamente (peer opcional), então o barrel principal
 * nunca o carrega. Lança uma mensagem clara se o peer não estiver instalado.
 */
export async function resolveWorkflowEngine(
  resolver: ContainerResolverLike,
): Promise<EnqueueEngine> {
  let mod: { WorkflowEngine: abstract new (...args: any[]) => unknown };
  try {
    mod = (await import('@adonis-agora/durable')) as any;
  } catch {
    throw new Error(
      '[authkit] durable account-lifecycle is enabled but "@adonis-agora/durable" is not installed. ' +
        'Add it as a dependency and register the workflows on your WorkflowEngine.',
    );
  }
  return resolver.make(mod.WorkflowEngine) as Promise<EnqueueEngine>;
}

/**
 * Enfileira o workflow durável de deleção, idempotente por `accountId` (run-id =
 * `authkit.account.delete:<accountId>` → requests duplicadas dedupam no mesmo run).
 * Retorna o run-id usado.
 */
export async function enqueueAccountDeletion(
  engine: EnqueueEngine,
  input: AccountDeleteWorkflowInput,
): Promise<string> {
  const runId = `${ACCOUNT_DELETE_WORKFLOW}:${input.accountId}`;
  await engine.start(ACCOUNT_DELETE_WORKFLOW, input, runId);
  return runId;
}

/**
 * Enfileira o workflow durável de export. Idempotente por `accountId` no run-id —
 * uma exportação em voo dedupa pedidos repetidos do mesmo titular.
 */
export async function enqueueAccountExport(
  engine: EnqueueEngine,
  input: AccountExportWorkflowInput,
): Promise<string> {
  const runId = `${ACCOUNT_EXPORT_WORKFLOW}:${input.accountId}`;
  await engine.start(ACCOUNT_EXPORT_WORKFLOW, input, runId);
  return runId;
}

/**
 * Constrói um callback `EnqueueDeletion` (para `AdminUsersService.delete`) a partir
 * de um resolver de container — resolve o `WorkflowEngine` e enfileira o cascade.
 */
export function enqueueDeletionVia(
  resolver: ContainerResolverLike,
): (input: AccountDeleteWorkflowInput) => Promise<string> {
  return async (input) => {
    const engine = await resolveWorkflowEngine(resolver);
    return enqueueAccountDeletion(engine, input);
  };
}

/** Re-export por conveniência: o tipo do ator de deleção. */
export type { DeletionActor };
