import type { OidcService } from '../../provider/oidc_service.js';
import { type AccountExport, AccountExportService } from '../account_export_service.js';
import type { DurableStepCtx } from './account_deletion_workflow.js';

/** Nome canônico do workflow durável de export de dados de conta. */
export const ACCOUNT_EXPORT_WORKFLOW = 'authkit.account.export';

/** Input do workflow `authkit.account.export`. */
export interface AccountExportWorkflowInput {
  accountId: string;
  /** IP da request, p/ auditoria (opcional). */
  ip?: string | null;
}

/** Resultado do workflow de export (referência ao artefato persistido). */
export interface AccountExportWorkflowResult {
  ok: boolean;
  /** Key/URL do artefato persistido no drive (quando persistido). */
  artifactKey: string | null;
  /** Bytes do payload serializado (diagnóstico). */
  bytes: number;
}

/**
 * Persiste o artefato (JSON serializado) e devolve a sua key/URL. O default usa o
 * disk do drive do app (`@adonisjs/drive`), gravando em
 * `<uploads.exports.directory>/authkit-data-export-<accountId>-<runId>.json`. O
 * app pode injetar a sua própria implementação (ex.: S3 com URL assinada).
 */
export type PersistArtifact = (artifact: {
  accountId: string;
  runId: string;
  json: string;
  oidc: OidcService;
}) => Promise<string | null>;

/**
 * Entrega o artefato ao titular: via signal durável (token `export:<runId>`)
 * e/ou um link por e-mail. O default emite o signal (best-effort) — o app pluga
 * o e-mail. Read-only quanto ao cascade (apenas notifica).
 */
export type DeliverArtifact = (delivery: {
  accountId: string;
  runId: string;
  artifactKey: string | null;
  oidc: OidcService;
}) => Promise<void>;

/** Deps que o app injeta ao definir o workflow de export. */
export interface AccountExportWorkflowDeps {
  oidc: () => OidcService | Promise<OidcService>;
  /** Persistência do artefato (default: drive do app). */
  persist?: PersistArtifact;
  /** Entrega ao titular (default: no-op — o app pluga e-mail/signal). */
  deliver?: DeliverArtifact;
}

/** Persistência default: grava o JSON no disk do drive do app (best-effort). */
const defaultPersist: PersistArtifact = async ({ accountId, runId, json, oidc }) => {
  // Indireção via variável: `@adonisjs/drive` é peer/opcional — pode não estar
  // instalado, então o specifier não é resolvido em build-time.
  const specifier = '@adonisjs/drive/services/main';
  let drive: any = null;
  try {
    const mod = await import(specifier);
    drive = (mod as any).default ?? null;
  } catch {
    return null;
  }
  if (!drive) return null;
  const cfg = oidc.config;
  const exportsCfg = (cfg.uploads as any).exports;
  const directory = (exportsCfg?.directory ?? 'authkit/exports').replace(/\/+$/, '');
  const diskName = exportsCfg?.disk ?? (cfg.uploads as any).avatars?.disk;
  const key = `${directory}/authkit-data-export-${accountId}-${runId}.json`;
  try {
    const disk = diskName ? drive.use(diskName) : drive.use();
    await disk.put(key, json, {
      contentType: 'application/json; charset=utf-8',
    });
    return key;
  } catch {
    return null;
  }
};

/** Entrega default: emite o signal `export:<runId>` (best-effort, fail-safe). */
const noopDeliver: DeliverArtifact = async () => {};

/**
 * Define a REGISTRAÇÃO do workflow durável `authkit.account.export`.
 *
 * Etapas (todas efeitos colaterais dentro de `ctx.localStep`, corpo determinístico):
 *   1. `collect`  — reúne o payload (reusa {@link AccountExportService.collect});
 *   2. `audit`    — registra `account.exported`;
 *   3. `persist`  — serializa + grava o artefato no drive;
 *   4. `deliver`  — notifica o titular (signal + link por e-mail, pluggable).
 *
 * Read-only + artefato → SEM compensação. Sub-fetches flaky podem ter retry
 * por-etapa (a coleta é best-effort por dentro).
 */
export function defineAccountExportWorkflow(deps: AccountExportWorkflowDeps): {
  name: string;
  version: string;
  body: (
    ctx: DurableStepCtx & { runId?: string },
    input: AccountExportWorkflowInput,
  ) => Promise<unknown>;
} {
  const persist = deps.persist ?? defaultPersist;
  const deliver = deps.deliver ?? noopDeliver;

  const body = async (
    ctx: DurableStepCtx & { runId?: string },
    input: AccountExportWorkflowInput,
  ): Promise<AccountExportWorkflowResult> => {
    const { accountId } = input;
    const runId = ctx.runId ?? accountId;

    // 1) Coleta o payload (reusa a coleta inline do AccountExportService).
    const payload = await ctx.localStep('collect', async (): Promise<AccountExport | null> => {
      const oidc = await deps.oidc();
      return new AccountExportService(oidc).collect(accountId);
    });
    if (!payload) return { ok: false, artifactKey: null, bytes: 0 };

    // 2) Audita o export (account.exported).
    await ctx.localStep('audit', async () => {
      const cfg = (await deps.oidc()).config;
      await cfg.audit?.record({
        type: 'account.exported',
        accountId,
        ip: input.ip ?? null,
      });
    });

    // 3) Serializa + persiste o artefato.
    const json = JSON.stringify(payload, null, 2);
    const artifactKey = await ctx.localStep('persist', async () => {
      const oidc = await deps.oidc();
      return persist({ accountId, runId, json, oidc });
    });

    // 4) Entrega ao titular (signal + e-mail, pluggable).
    await ctx.localStep('deliver', async () => {
      const oidc = await deps.oidc();
      await deliver({ accountId, runId, artifactKey, oidc });
    });

    return { ok: true, artifactKey, bytes: json.length };
  };

  return { name: ACCOUNT_EXPORT_WORKFLOW, version: '1', body };
}
