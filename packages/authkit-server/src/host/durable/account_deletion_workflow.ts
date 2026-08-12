import type { ResolvedServerConfig } from '../../define_config.js';
import type { OidcService } from '../../provider/oidc_service.js';
import {
  type AccountSnapshot,
  anonymizeAudit,
  auditDeleted,
  deleteAccountAvatar,
  deleteAccountRow,
  disableMfa,
  removeFromOrgs,
  removePasskeys,
  revokePats,
  revokeSessions,
  snapshotAccount,
  unlinkProviders,
} from '../account_deletion_ops.js';
import type { DeletionActor, DeletionResult } from '../account_deletion_service.js';

/** Nome canônico do workflow durável de deleção de conta. */
export const ACCOUNT_DELETE_WORKFLOW = 'authkit.account.delete';

/** Input do workflow `authkit.account.delete`. */
export interface AccountDeleteWorkflowInput {
  accountId: string;
  actor: DeletionActor;
}

/** Estado inicial vazio do {@link DeletionResult} (acumulado etapa a etapa). */
function emptyResult(): DeletionResult {
  return {
    ok: false,
    sessions: 0,
    grants: 0,
    accessTokens: 0,
    refreshTokens: 0,
    pats: 0,
    passkeys: 0,
    providerIdentities: 0,
    auditAnonymized: 0,
    avatarDeleted: false,
    orgMemberships: 0,
    orgInvitations: 0,
  };
}

/**
 * Forma mínima do `ctx` durável que o corpo usa (um `ctx.localStep` checkpointado
 * e idempotente — executado IN-PROCESS, nunca dispatchado a um worker remoto;
 * distinto do `ctx.step` do engine, que é SEMPRE dispatchado a um handler
 * registrado por nome). Tipada estruturalmente para NÃO acoplar o build do
 * authkit ao pacote `@adonis-agora/durable` (peer OPCIONAL): o app passa o
 * `engine.register` real e o ctx satisfaz esta interface em runtime.
 */
export interface DurableStepCtx {
  localStep<T>(name: string, fn: (...args: any[]) => Promise<T>, options?: unknown): Promise<T>;
}

/** A assinatura do corpo do workflow (compatível com `engine.register`). */
export type WorkflowBody = (
  ctx: DurableStepCtx,
  input: AccountDeleteWorkflowInput,
) => Promise<unknown>;

/** Deps que o app injeta ao definir o workflow no seu próprio `WorkflowEngine`. */
export interface AccountDeletionWorkflowDeps {
  /** Resolve o {@link OidcService} (de onde sai a config). Chamado DENTRO de um step. */
  oidc: () => OidcService | Promise<OidcService>;
}

/**
 * Define a REGISTRAÇÃO do workflow durável `authkit.account.delete`.
 *
 * Retorna `{ name, version, body }` para o app registrar no seu `WorkflowEngine`:
 *
 * ```ts
 * import { defineAccountDeletionWorkflow } from '@adonis-agora/authkit-server/durable'
 * const wf = defineAccountDeletionWorkflow({ oidc: () => app.container.make('authkit.server') })
 * engine.register(wf.name, wf.version, wf.body)
 * ```
 *
 * O corpo é FORWARD-ONLY (sem compensação — nunca des-deleta): cada etapa do
 * cascade é um `ctx.localStep` checkpointado, com retry por-etapa e resumabilidade. A
 * linha da conta é a ÚLTIMA etapa. Todos os efeitos colaterais ficam DENTRO de
 * `ctx.localStep` (corpo determinístico: nada de Date.now()/random no corpo). A
 * idempotência por `accountId` é feita pelo run-id no enqueue (ver
 * `enqueueAccountDeletion`).
 */
export function defineAccountDeletionWorkflow(deps: AccountDeletionWorkflowDeps): {
  name: string;
  version: string;
  body: WorkflowBody;
} {
  const body: WorkflowBody = async (ctx, input) => {
    const { accountId, actor } = input;

    // Snapshot da conta ANTES de destruir (e-mail + avatar) — capturado num step
    // para ser determinístico no replay. Se a conta não existe (ou já foi
    // deletada num run anterior), encerra como no-op.
    const snapshot = await ctx.localStep('snapshot', async (): Promise<AccountSnapshot | null> => {
      const cfg = (await deps.oidc()).config;
      return snapshotAccount(cfg, accountId);
    });
    if (!snapshot) return emptyResult();

    const result = emptyResult();

    // 1) Audit `account.deleted` ANTES de qualquer destruição.
    await ctx.localStep('audit.deleted', async () => {
      const cfg: ResolvedServerConfig = (await deps.oidc()).config;
      await auditDeleted(cfg, snapshot, actor);
    });

    // 2) Sessões + grants (cascateia os tokens do oidc-provider).
    const revoke = await ctx.localStep('revoke.sessions', async () =>
      revokeSessions(await deps.oidc(), accountId),
    );
    result.sessions = revoke.sessions;
    result.grants = revoke.grants;
    result.accessTokens = revoke.accessTokens;
    result.refreshTokens = revoke.refreshTokens;

    // 3) Personal Access Tokens.
    result.pats = (
      await ctx.localStep('revoke.pats', async () => revokePats((await deps.oidc()).config, accountId))
    ).pats;

    // 4) Passkeys / credenciais WebAuthn.
    result.passkeys = (
      await ctx.localStep('remove.passkeys', async () =>
        removePasskeys((await deps.oidc()).config, accountId),
      )
    ).passkeys;

    // 5) MFA / TOTP.
    await ctx.localStep('disable.mfa', async () => {
      await disableMfa((await deps.oidc()).config, accountId);
    });

    // 6) Identidades de provider linkadas.
    result.providerIdentities = (
      await ctx.localStep('unlink.providers', async () =>
        unlinkProviders((await deps.oidc()).config, accountId),
      )
    ).providerIdentities;

    // 6b) Organizations.
    const orgResult = await ctx.localStep('remove.orgs', async () =>
      removeFromOrgs((await deps.oidc()).config, accountId),
    );
    result.orgMemberships = orgResult.orgMemberships;
    result.orgInvitations = orgResult.orgInvitations;

    // 7) Avatar no drive.
    result.avatarDeleted = (
      await ctx.localStep('delete.avatar', async () =>
        deleteAccountAvatar((await deps.oidc()).config, accountId, snapshot.avatarUrl),
      )
    ).avatarDeleted;

    // 8) Anonimiza o histórico de audit.
    result.auditAnonymized = (
      await ctx.localStep('anonymize.audit', async () =>
        anonymizeAudit((await deps.oidc()).config, accountId),
      )
    ).auditAnonymized;

    // 9) Deleta a linha da conta (ÚLTIMA etapa, forward-only).
    result.ok = (
      await ctx.localStep('delete.account', async () =>
        deleteAccountRow((await deps.oidc()).config, accountId),
      )
    ).ok;

    return result;
  };

  return { name: ACCOUNT_DELETE_WORKFLOW, version: '1', body };
}
