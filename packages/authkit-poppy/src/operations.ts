/**
 * Extensão Operations, versão 3 (https://personalagentprotocol.org/docs/1.0/extensions/operations),
 * lado da empresa: guardar operações e revisões, pedir aprovação (403 `approval_required`),
 * conferir aprovações (`Poppy-Approval`, `_meta` do MCP, `extensions.operations.approval` das
 * conversas), recusar (`approval_declined`), executar no máximo uma vez, e o `endpoint` das
 * operações do site (403 + `Poppy-Operation`).
 *
 * O app (ou o `@adonis-agora/agent`) chama {@link PoppyOperations.require} antes de executar uma
 * ação; `{ ok: true }` = aprovada e marcada `performing`: execute e chame `markPerformed`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  PoppyAlternative,
  PoppyApproval,
  PoppyDecline,
  PoppyPrincipalBase,
  ResolvedPoppyConfig,
} from './config.js';
import { OPERATIONS_EXTENSION, OPERATIONS_VERSION } from './config.js';
import type { OperationInterface, OperationRow, PoppyStore, RevisionRow } from './store.js';
import { parseSfDictionary, sfString } from './structured_fields.js';

/** Header da aprovação numa request de API e no `endpoint` (Operations 3, §6). */
export const POPPY_APPROVAL_HEADER = 'Poppy-Approval';
/** Header com a referência de uma operação do site (Operations 3, §4). */
export const POPPY_OPERATION_HEADER = 'Poppy-Operation';
/** Chave da aprovação no `_meta` de uma chamada de tool MCP (Operations 3, §6). */
export const MCP_APPROVAL_META = 'personalagentprotocol.org/approval';

/** Mesmos caracteres dos IDs da spec (§8.2). */
const ID = /^[A-Za-z0-9_-]{1,256}$/;
/** Referência do `Poppy-Operation`: até 2048 de A–Z, a–z, 0–9, `-`, `_` e `.`. */
const REF = /^[A-Za-z0-9._-]{1,2048}$/;
const INPUT_TYPE = /^[\x21-\x7e]{1,64}$/;
/** Quanto o agente espera antes de repetir uma operação em execução. */
const PERFORMING_RETRY_AFTER_S = 5;

/** Uma operação como a spec a manda (Operations 3, §3). */
export interface PoppyOperationWire {
  operation_id: string;
  revision: string;
  summary?: string;
  terms: Record<string, unknown>;
  /** RFC 3339. */
  expires_at: string;
}

/** A recusa como a spec a manda numa conversa (`extensions.operations.declined`). */
export interface PoppyDeclinedWire {
  operation_id: string;
  revision: string;
  reason?: string;
  alternative?: PoppyAlternative;
}

/** O que {@link PoppyOperations.require} recebe. */
export interface PoppyOperationInput {
  /** Por onde a request chegou: muda como a aprovação chega e como a resposta sai. */
  interface: OperationInterface;
  /**
   * O que a request pede, em JSON — método, URL e as partes do corpo que afetam a ação; os
   * argumentos da tool no MCP; o id da conversa numa conversa. Comparado pelo significado (JSON
   * canônico), não pelos bytes: a request com a aprovação precisa pedir o mesmo.
   */
  action: unknown;
  /** Os termos, como o app os calcula AGORA (preço de hoje…). Tudo que afeta a ação. */
  terms: Record<string, unknown>;
  /** Os mesmos termos em texto simples (Markdown básico), para o usuário. */
  summary?: string;
  /** Validade desta revisão. Default: `operations.expiresIn` (900 s). */
  expiresAt?: Date;
  /**
   * A aprovação que veio com a request: no MCP, `params._meta['personalagentprotocol.org/approval']`;
   * numa conversa, `extensions.operations.approval` da mensagem. Numa API ela é lida do header
   * `Poppy-Approval` da request quando não vem aqui.
   */
  approval?: unknown;
  /**
   * Numa conversa: o `operation_id` de uma operação ainda não executada que ganha uma revisão nova
   * (o usuário pediu outros termos).
   */
  operationId?: string;
  /** Prefixo dos ids novos (`exc_`…). Default: `op_`. */
  idPrefix?: string;
}

/** Quem está na request: o principal Poppy (APIs, MCP, conversas) ou o navegador (site). */
export interface PoppyOperationActor {
  clientId: string;
  userId: string;
  /** Conta da request; `null` deslogada. */
  accountId: string | null;
  signedIn: boolean;
  /** As extensões declaradas, `nome → versão`. */
  extensions: Record<string, string>;
  /** O `sid` do agente: vai no `Poppy-Operation` (só site). */
  sid?: string | null;
  /** O principal completo, quando a request é de API/MCP/conversa (vai para o `decide`). */
  principal?: PoppyPrincipalBase;
}

/** Uma resposta pronta: `body` JSON (ou `null` = sem corpo) e headers. */
interface Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export type PoppyOperationResult =
  | {
      ok: true;
      kind: 'approved';
      operationId: string;
      revision: string;
      operation: PoppyOperationWire;
      approval: PoppyApproval;
    }
  | (Reply & {
      ok: false;
      /**
       * - `approval_required`: nada foi feito; devolva `status`/`body`/`headers` (ou, numa conversa,
       *   mande `operation` em `extensions.operations.operation`).
       * - `approval_declined`: a empresa recusou a aprovação (`declined`).
       * - `performed`: já executada — `body`/`status` são os da primeira vez.
       * - `performing`: em execução (503 + `Retry-After`).
       * - `challenge`: a operação é de uma conta e a request está deslogada (401).
       * - `extension_required`: a request não declarou `operations` v3 — ou a empresa aprova de
       *   outro jeito, ou recusa com isto.
       * - `invalid_request`: `Poppy-Approval` malformado (400).
       * - `unsupported` (só site): o navegador não está na Session pela entrada ou não declarou a
       *   extensão: o site aprova do próprio jeito.
       */
      kind:
        | 'approval_required'
        | 'approval_declined'
        | 'performed'
        | 'performing'
        | 'challenge'
        | 'extension_required'
        | 'invalid_request'
        | 'unsupported';
      operation?: PoppyOperationWire;
      declined?: PoppyDeclinedWire;
      /** Site, `approval_required`: a página que diz que a ação espera aprovação. */
      html?: string;
    });

/** Uma operação lida por {@link PoppyOperations.get}. */
export interface PoppyOperationRecord {
  operationId: string;
  interface: OperationInterface;
  status: OperationRow['status'];
  accountId: string | null;
  /** A revisão atual. */
  operation: PoppyOperationWire;
  /** A aprovação aceita (ou gravada, no site); `null` = nenhuma. */
  approval: PoppyApproval | null;
  /** A resposta guardada por `markPerformed`. */
  response: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface PoppyOperationsDeps {
  cfg: ResolvedPoppyConfig;
  store: PoppyStore;
  now: () => Date;
  /** `WWW-Authenticate` de um challenge sem código (precisa da conta). */
  challenge: () => string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON canônico (chaves ordenadas), para comparar pelo significado (como RFC 8785). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function fingerprint(kind: OperationInterface, action: unknown): string {
  return sha256(canonicalJson({ interface: kind, action }));
}

function wire(op: { id: string }, rev: RevisionRow): PoppyOperationWire {
  return {
    operation_id: op.id,
    revision: rev.revision,
    ...(rev.summary ? { summary: rev.summary } : {}),
    terms: rev.terms,
    expires_at: rev.expiresAt.toISOString(),
  };
}

/**
 * Lê uma aprovação (Operations 3, §6) de um objeto (MCP, conversa) — `null` = ausente,
 * `'invalid'` = sem os membros obrigatórios. Membros desconhecidos são ignorados; `input_type` só
 * vale com `user`; `reference` fora do formato é descartada (nunca motivo de recusa).
 */
export function normalizeApproval(value: unknown): PoppyApproval | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as Record<string, unknown>;
  if (typeof v.operation_id !== 'string' || !ID.test(v.operation_id)) return 'invalid';
  if (typeof v.revision !== 'string' || !ID.test(v.revision)) return 'invalid';
  if (v.approver !== 'user' && v.approver !== 'agent') return 'invalid';
  const approval: PoppyApproval = {
    operation_id: v.operation_id,
    revision: v.revision,
    approver: v.approver,
  };
  if (typeof v.approved_at === 'number' && Number.isInteger(v.approved_at) && v.approved_at > 0) {
    approval.approved_at = v.approved_at;
  }
  if (v.approver === 'user' && typeof v.input_type === 'string' && INPUT_TYPE.test(v.input_type)) {
    approval.input_type = v.input_type;
  }
  if (typeof v.reference === 'string' && ID.test(v.reference)) approval.reference = v.reference;
  return approval;
}

/** O header `Poppy-Approval` (um Dictionary da RFC 9651) como aprovação. */
export function parseApprovalHeader(
  value: string | string[] | undefined,
): PoppyApproval | null | 'invalid' {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const dict = parseSfDictionary(value);
  if (!dict) return 'invalid';
  const plain: Record<string, unknown> = {};
  for (const [k, item] of dict) {
    if (typeof item === 'string' || typeof item === 'number') plain[k] = item;
  }
  return normalizeApproval(plain);
}

/** A aprovação que uma chamada de tool MCP traz em `params._meta`. */
export function approvalFromMcpMeta(meta: unknown): unknown {
  if (typeof meta !== 'object' || meta === null) return undefined;
  return (meta as Record<string, unknown>)[MCP_APPROVAL_META];
}

/**
 * O resultado de tool MCP (Operations 3, §4 e §6) para `approval_required` e `approval_declined`:
 * `isError`, o texto e o `structuredContent`. `null` para os outros resultados.
 */
export function poppyOperationToolResult(result: PoppyOperationResult): {
  isError: true;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} | null {
  if (result.ok) return null;
  if (result.kind === 'approval_required' && result.operation) {
    const op = result.operation;
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Not done yet. This needs approval${op.summary ? `: ${op.summary}` : '.'}`,
        },
      ],
      structuredContent: { operation: op },
    };
  }
  if (result.kind === 'approval_declined' && result.declined) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Not done. The approval was declined${result.declined.reason ? `: ${result.declined.reason}` : '.'}`,
        },
      ],
      structuredContent: { error: 'approval_declined', ...result.declined },
    };
  }
  return null;
}

const WAITING_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Waiting for approval</title></head><body><p>This action is waiting for your approval in your personal agent.</p><form method="get"><button>Continue</button></form></body></html>';

export class PoppyOperations {
  #cfg: ResolvedPoppyConfig;
  #store: PoppyStore;
  #now: () => Date;
  #challenge: () => string;

  constructor(deps: PoppyOperationsDeps) {
    this.#cfg = deps.cfg;
    this.#store = deps.store;
    this.#now = deps.now;
    this.#challenge = deps.challenge;
  }

  get #config() {
    const config = this.#cfg.operations;
    if (!config)
      throw new Error('authkit-poppy: a extensão Operations não está ligada (operations).');
    return config;
  }

  // ─── APIs, MCP e conversas ────────────────────────────────────────────────

  /**
   * Confere a aprovação de uma ação antes de executá-la (Operations 3, §4–§7). Sem aprovação:
   * guarda a operação e devolve `approval_required`. Com uma aprovação que passa nas checagens (e
   * no `decide`): marca `performing` e devolve `{ ok: true }` — execute e chame `markPerformed`.
   * `approvalHeader` é o `Poppy-Approval` da request (APIs).
   */
  async require(
    actor: PoppyOperationActor,
    input: PoppyOperationInput,
    approvalHeader?: string | string[],
  ): Promise<PoppyOperationResult> {
    const config = this.#config;
    if (input.interface === 'website') {
      throw new Error('authkit-poppy: operações do site passam por requireWebsite(ctx).');
    }
    if (actor.extensions[OPERATIONS_EXTENSION] !== OPERATIONS_VERSION) {
      return {
        ok: false,
        kind: 'extension_required',
        status: 403,
        body: { error: 'extension_required', extension: OPERATIONS_EXTENSION },
        headers: {},
      };
    }
    const approval =
      input.approval !== undefined
        ? normalizeApproval(input.approval)
        : input.interface === 'api'
          ? parseApprovalHeader(approvalHeader)
          : null;
    if (approval === 'invalid') {
      return {
        ok: false,
        kind: 'invalid_request',
        status: 400,
        body: {
          error: 'invalid_request',
          error_description:
            'The approval needs operation_id, revision and approver (user or agent)',
        },
        headers: {},
      };
    }
    const fp = fingerprint(input.interface, input.action);
    if (!approval) return this.#ask(actor, input, fp, input.operationId ?? null);

    const op = await this.#store.findOperation(approval.operation_id);
    if (!op || op.interface !== input.interface || !this.#sameUser(op, actor)) {
      return this.#ask(actor, input, fp, null);
    }
    // Check 1: a Session pode aprovar (Operations 3, §3).
    if (op.accountId !== null && !actor.signedIn) return this.#challengeReply();
    if (op.accountId !== actor.accountId) return this.#ask(actor, input, fp, null);
    // Check 2: já executada ou em execução (§7).
    if (op.status === 'performed') return this.#performedReply(op);
    if (op.status === 'performing') return this.#performingReply(op);
    // Check 3: a revisão é a atual desta operação, vale, e a request pede exatamente o mesmo.
    const rev = await this.#store.findRevision(approval.revision);
    const now = this.#now();
    if (
      !rev ||
      rev.operationId !== op.id ||
      rev.revision !== op.revision ||
      rev.expiresAt <= now ||
      rev.fingerprint !== fp ||
      canonicalJson(rev.terms) !== canonicalJson(input.terms)
    ) {
      // Uma revisão nova (nunca a que a aprovação nomeia), com o mesmo `operation_id`.
      return this.#ask(actor, input, fp, op.id);
    }
    const declined = await this.#decline(actor, op, rev, approval, config);
    if (declined) return declined;
    const moved = await this.#store.transitionOperation(op.id, ['pending'], {
      status: 'performing',
      approvedRevision: rev.revision,
      approver: approval.approver,
      approvedAt: approval.approved_at ?? null,
      inputType: approval.approver === 'user' ? (approval.input_type ?? null) : null,
      reference: approval.reference ?? null,
      recordedAt: now,
      at: now,
    });
    if (!moved) {
      // Outra request com a mesma aprovação ganhou: responda como ela (§7).
      const current = await this.#store.findOperation(op.id);
      if (current?.status === 'performed') return this.#performedReply(current);
      return this.#performingReply(op);
    }
    return {
      ok: true,
      kind: 'approved',
      operationId: op.id,
      revision: rev.revision,
      operation: wire(op, rev),
      approval,
    };
  }

  /** Guarda uma operação (ou uma revisão nova de `reuseId`) e devolve `approval_required`. */
  async #ask(
    actor: PoppyOperationActor,
    input: PoppyOperationInput,
    fp: string,
    reuseId: string | null,
  ): Promise<PoppyOperationResult> {
    const { op, rev } = await this.#newRevision(actor, input, fp, reuseId);
    const operation = wire(op, rev);
    return {
      ok: false,
      kind: 'approval_required',
      status: 403,
      body: { error: 'approval_required', operation },
      headers: {},
      operation,
    };
  }

  async #newRevision(
    actor: PoppyOperationActor,
    input: PoppyOperationInput,
    fp: string,
    reuseId: string | null,
    refHash: string | null = null,
  ): Promise<{ op: OperationRow; rev: RevisionRow }> {
    const now = this.#now();
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + this.#config.expiresIn * 1000);
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      throw new Error('authkit-poppy: operations — expiresAt precisa ser uma Date no futuro.');
    }
    if (typeof input.terms !== 'object' || input.terms === null || Array.isArray(input.terms)) {
      throw new Error('authkit-poppy: operations — terms precisa ser um objeto JSON.');
    }
    // A revisão: a validade em Unix + aleatório (como o exemplo da spec), nunca reaproveitada.
    const revision = `${Math.floor(expiresAt.getTime() / 1000)}-${randomBytes(12).toString('base64url')}`;
    let op: OperationRow | null = null;
    if (reuseId) {
      const existing = await this.#store.findOperation(reuseId);
      if (
        existing &&
        existing.status === 'pending' &&
        existing.interface === input.interface &&
        this.#sameUser(existing, actor) &&
        existing.accountId === actor.accountId &&
        (await this.#store.replaceRevision(existing.id, revision, expiresAt, now))
      ) {
        op = { ...existing, revision };
      }
    }
    if (!op) {
      const prefix = input.idPrefix ?? 'op_';
      const id = `${prefix}${randomBytes(12).toString('base64url')}`;
      if (!ID.test(id)) throw new Error('authkit-poppy: operations — idPrefix inválido.');
      await this.#store.insertOperation({
        id,
        clientId: actor.clientId,
        userId: actor.userId,
        accountId: actor.accountId,
        interface: input.interface,
        revision,
        refHash,
        expiresAt,
        at: now,
      });
      op = (await this.#store.findOperation(id))!;
    }
    const rev: RevisionRow = {
      revision,
      operationId: op.id,
      fingerprint: fp,
      terms: structuredClone(input.terms),
      summary: typeof input.summary === 'string' && input.summary ? input.summary : null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.insertRevision(rev);
    return { op, rev };
  }

  /** O `decide` do app; uma recusa não grava a aprovação (Operations 3, §6). */
  async #decline(
    actor: PoppyOperationActor,
    op: OperationRow,
    rev: RevisionRow,
    approval: PoppyApproval,
    config: NonNullable<ResolvedPoppyConfig['operations']>,
  ): Promise<Extract<PoppyOperationResult, { ok: false }> | null> {
    if (!config.decide) return null;
    const principal =
      actor.principal ??
      ({
        userId: actor.userId,
        agentId: null,
        accountId: actor.accountId,
        clientId: actor.clientId,
        scopes: [],
        sessionId: '',
        protocolVersion: '',
        documentVersion: '',
        extensions: actor.extensions,
        signedIn: actor.signedIn,
        resource: null,
        tokenType: null,
      } satisfies PoppyPrincipalBase);
    const decline: PoppyDecline | undefined = await config.decide({
      principal,
      operation: { operationId: op.id, revision: rev.revision, terms: structuredClone(rev.terms) },
      approval,
    });
    if (!decline) return null;
    const declined: PoppyDeclinedWire = {
      operation_id: op.id,
      revision: rev.revision,
      ...(typeof decline.reason === 'string' && decline.reason ? { reason: decline.reason } : {}),
      ...(decline.alternative ? { alternative: decline.alternative } : {}),
    };
    return {
      ok: false,
      kind: 'approval_declined',
      status: 403,
      body: { error: 'approval_declined', ...declined },
      headers: {},
      declined,
    };
  }

  #sameUser(op: OperationRow, actor: PoppyOperationActor): boolean {
    return op.clientId === actor.clientId && op.userId === actor.userId;
  }

  #challengeReply(): PoppyOperationResult {
    return {
      ok: false,
      kind: 'challenge',
      status: 401,
      body: null,
      headers: { 'WWW-Authenticate': this.#challenge() },
    };
  }

  /** A resposta da primeira execução (§7), ou uma que diz o mesmo. */
  #performedReply(op: OperationRow): PoppyOperationResult {
    const stored = op.response as Partial<Reply> | null;
    if (stored && typeof stored.status === 'number') {
      return {
        ok: false,
        kind: 'performed',
        status: stored.status,
        body: stored.body ?? null,
        headers: { ...(stored.headers ?? {}) },
      };
    }
    return {
      ok: false,
      kind: 'performed',
      status: 200,
      body: { operation_id: op.id, status: 'performed' },
      headers: {},
    };
  }

  #performingReply(op: OperationRow): PoppyOperationResult {
    return {
      ok: false,
      kind: 'performing',
      status: 503,
      body: { operation_id: op.id, status: 'performing' },
      headers: { 'Retry-After': String(PERFORMING_RETRY_AFTER_S) },
    };
  }

  // ─── execução ─────────────────────────────────────────────────────────────

  /**
   * A ação foi executada: a operação vira `performed` e `response` (o que a request respondeu)
   * volta nos retries com a mesma aprovação. `false` = a operação não estava em execução.
   */
  async markPerformed(
    operationId: string,
    response?: { status: number; body?: unknown; headers?: Record<string, string> },
  ): Promise<boolean> {
    const now = this.#now();
    return this.#store.transitionOperation(operationId, ['performing'], {
      status: 'performed',
      response: response
        ? { status: response.status, body: response.body ?? null, headers: response.headers ?? {} }
        : null,
      at: now,
    });
  }

  /**
   * A execução falhou sem efeito: a aprovação volta a valer para um retry (§7). No site, ela volta
   * a ficar gravada (`approved`); nas outras interfaces a operação volta a `pending`.
   */
  async release(operationId: string): Promise<boolean> {
    const op = await this.#store.findOperation(operationId);
    if (!op || op.status !== 'performing') return false;
    return this.#store.transitionOperation(operationId, ['performing'], {
      status: op.interface === 'website' ? 'approved' : 'pending',
      at: this.#now(),
    });
  }

  /** Uma operação de quem pergunta (mesmo `client_id` + User ID); `null` = não existe ou é de outro. */
  async get(
    actor: Pick<PoppyOperationActor, 'clientId' | 'userId'>,
    operationId: string,
  ): Promise<PoppyOperationRecord | null> {
    const op = await this.#store.findOperation(operationId);
    if (!op || op.clientId !== actor.clientId || op.userId !== actor.userId) return null;
    const rev = await this.#store.findRevision(op.revision);
    if (!rev) return null;
    return {
      operationId: op.id,
      interface: op.interface,
      status: op.status,
      accountId: op.accountId,
      operation: wire(op, rev),
      approval:
        op.approvedRevision && op.approver
          ? {
              operation_id: op.id,
              revision: op.approvedRevision,
              approver: op.approver,
              ...(op.approvedAt !== null ? { approved_at: op.approvedAt } : {}),
              ...(op.inputType ? { input_type: op.inputType } : {}),
              ...(op.reference ? { reference: op.reference } : {}),
            }
          : null,
      response: op.response,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
    };
  }

  // ─── site ─────────────────────────────────────────────────────────────────

  /**
   * Uma ação pedida por um navegador na Session (Operations 3, §4 e §6 "Websites"). Usa a
   * aprovação gravada mais antiga que casa com a request (a operação vira `performing`); sem
   * nenhuma, guarda uma operação nova e devolve 403 com `Poppy-Operation`.
   */
  async requireWebsite(
    actor: PoppyOperationActor & { sid: string | null },
    input: PoppyOperationInput,
  ): Promise<PoppyOperationResult> {
    if (!this.#config.website) {
      throw new Error('authkit-poppy: operações do site estão desligadas (operations.website).');
    }
    const unsupported: PoppyOperationResult = {
      ok: false,
      kind: 'unsupported',
      status: 0,
      body: null,
      headers: {},
    };
    if (actor.extensions[OPERATIONS_EXTENSION] !== OPERATIONS_VERSION || !actor.sid) {
      return unsupported;
    }
    const fp = fingerprint('website', input.action);
    const now = this.#now();
    const recorded = await this.#store.listRecordedWebsiteApprovals(actor);
    for (const op of recorded) {
      const rev = op.approvedRevision ? await this.#store.findRevision(op.approvedRevision) : null;
      if (
        !rev ||
        rev.expiresAt <= now ||
        rev.fingerprint !== fp ||
        canonicalJson(rev.terms) !== canonicalJson(input.terms)
      ) {
        continue;
      }
      const moved = await this.#store.transitionOperation(op.id, ['approved'], {
        status: 'performing',
        at: now,
      });
      if (!moved) continue;
      return {
        ok: true,
        kind: 'approved',
        operationId: op.id,
        revision: rev.revision,
        operation: wire(op, rev),
        approval: {
          operation_id: op.id,
          revision: rev.revision,
          approver: op.approver ?? 'user',
          ...(op.approvedAt !== null ? { approved_at: op.approvedAt } : {}),
          ...(op.inputType ? { input_type: op.inputType } : {}),
          ...(op.reference ? { reference: op.reference } : {}),
        },
      };
    }
    // A referência: o id da operação + um segredo (só o hash do segredo fica guardado).
    const secret = randomBytes(24).toString('base64url');
    const { op, rev } = await this.#newRevision(
      actor,
      { ...input, interface: 'website' },
      fp,
      null,
      sha256(secret),
    );
    const ref = `${op.id}.${secret}`;
    return {
      ok: false,
      kind: 'approval_required',
      status: 403,
      body: { error: 'approval_required' },
      headers: {
        [POPPY_OPERATION_HEADER]: `sid=${sfString(actor.sid)}, ref=${sfString(ref)}`,
        'Cache-Control': 'no-store',
      },
      operation: wire(op, rev),
      html: WAITING_PAGE,
    };
  }

  /**
   * `POST {endpoint}` (Operations 3, §4 e §6 "Websites"): com `{ ref }` e sem aprovação, devolve a
   * operação (403 `approval_required`) ou, já aprovada, o status (200); com `Poppy-Approval`,
   * confere e grava a aprovação (204) ou recusa. A Session e o token já foram verificados.
   */
  async endpoint(
    actor: PoppyOperationActor,
    body: unknown,
    approvalHeader: string | string[] | undefined,
  ): Promise<Reply> {
    const config = this.#config;
    const invalid = (description: string): Reply => ({
      status: 400,
      body: { error: 'invalid_request', error_description: description },
      headers: {},
    });
    const ref = (body as Record<string, unknown> | null)?.ref;
    if (typeof ref !== 'string' || !REF.test(ref)) return invalid('ref is required');
    const dot = ref.indexOf('.');
    const op =
      dot > 0 ? await this.#store.findOperationByRefHash(sha256(ref.slice(dot + 1))) : null;
    if (!op || op.interface !== 'website' || op.id !== ref.slice(0, dot)) {
      return invalid('Unknown or expired reference');
    }
    if (!this.#sameUser(op, actor)) return invalid('Unknown or expired reference');
    if (op.accountId !== null && !actor.signedIn) {
      const challenge = this.#challengeReply() as Reply;
      return { status: challenge.status, body: null, headers: challenge.headers };
    }
    if (op.accountId !== actor.accountId) return invalid('Unknown or expired reference');

    const approval = parseApprovalHeader(approvalHeader);
    if (approval === 'invalid') {
      return invalid('The approval needs operation_id, revision and approver (user or agent)');
    }
    if (op.status !== 'pending') {
      // Já tem aprovação gravada: a consulta diz o status (approved, performing, performed).
      if (!approval) {
        return { status: 200, body: { operation_id: op.id, status: op.status }, headers: {} };
      }
      if (op.status === 'approved' && approval.revision === op.approvedRevision) {
        return { status: 204, body: null, headers: {} };
      }
      return { status: 200, body: { operation_id: op.id, status: op.status }, headers: {} };
    }
    const rev = await this.#store.findRevision(op.revision);
    const now = this.#now();
    if (!rev || rev.expiresAt <= now) return invalid('Unknown or expired reference');
    const current: Reply = {
      status: 403,
      body: { error: 'approval_required', operation: wire(op, rev) },
      headers: {},
    };
    if (!approval) return current;
    if (approval.operation_id !== op.id || approval.revision !== rev.revision) return current;
    const declined = await this.#decline(actor, op, rev, approval, config);
    if (declined) return { status: declined.status, body: declined.body, headers: {} };
    const recorded = await this.#store.transitionOperation(op.id, ['pending'], {
      status: 'approved',
      approvedRevision: rev.revision,
      approver: approval.approver,
      approvedAt: approval.approved_at ?? null,
      inputType: approval.approver === 'user' ? (approval.input_type ?? null) : null,
      reference: approval.reference ?? null,
      recordedAt: now,
      at: now,
    });
    if (!recorded) {
      const latest = await this.#store.findOperation(op.id);
      return {
        status: 200,
        body: { operation_id: op.id, status: latest?.status ?? 'approved' },
        headers: {},
      };
    }
    return { status: 204, body: null, headers: {} };
  }
}
