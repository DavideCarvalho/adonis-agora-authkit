import { createHash } from 'node:crypto';
import { decodeCursor, encodeCursor } from '@adonis-agora/filter';
import { DateTime } from 'luxon';
import { ADMIN_LIST_HTTP_DEFAULT_SIZE, normalizeListSize } from '../pagination.js';
import type {
  AuditEvent,
  AuditPage,
  AuditSink,
  CountAuditParams,
  ListAuditParams,
  StoredAuditEvent,
} from './audit_sink.js';

/** Narrows an audit query to the requested type(s) and subject. */
function filtered(q: any, params: CountAuditParams): any {
  const types = params.type === undefined ? [] : ([] as string[]).concat(params.type);
  if (types.length === 1) q.where('type', types[0]);
  else if (types.length > 1) q.whereIn('type', types);
  if (params.subject) q.where('accountId', params.subject);
  return q;
}

/** A Lucid `createdAt` (luxon), a `Date` or an ISO string, as an ISO string. */
function isoOf(value: any): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value.toISO === 'function') return value.toISO();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toStored(row: any): StoredAuditEvent {
  return {
    id: String(row.id),
    type: row.type,
    accountId: row.accountId ?? null,
    email: row.email ?? null,
    clientId: row.clientId ?? null,
    actorId: row.actorId ?? null,
    ip: row.ip ?? null,
    metadata: row.metadata ?? undefined,
    createdAt: isoOf(row.createdAt),
  };
}

/** The row's position in the log (`createdAt`, primary key), as an opaque cursor. */
function encodeAuditCursor(row: any): string {
  return encodeCursor([isoOf(row.createdAt), row.$primaryKeyValue ?? row.id]);
}

/** A cursor back to `{ at, id }`; `null` for anything this sink did not produce. */
function decodeAuditCursor(cursor: string): { at: DateTime; id: unknown } | null {
  const values = decodeCursor(cursor);
  if (!values || values.length !== 2 || typeof values[0] !== 'string') return null;
  const at = DateTime.fromISO(values[0]);
  if (!at.isValid) return null;
  const id = values[1];
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return { at, id };
}

/**
 * Pseudônimo estável para um accountId anonimizado: `anon:<sha256(accountId)[:16]>`.
 * Mantém os eventos de uma conta deletada correlacionáveis ENTRE SI (mesmo
 * pseudônimo) sem permitir reidentificar a pessoa (one-way).
 */
function anonId(accountId: string): string {
  return `anon:${createHash('sha256').update(accountId).digest('hex').slice(0, 16)}`;
}

/**
 * Implementação default do {@link AuditSink} sobre um model Lucid composto de
 * `withAuditLog()`. Insere o evento na tabela `audit_logs` e suporta consulta
 * paginada para o console admin.
 *
 * BEST-EFFORT: erros de inserção são logados via `console.error` e engolidos —
 * a auditoria nunca deve lançar para dentro do caminho da request.
 */
export function lucidAuditSink(Model: any): AuditSink {
  return {
    async record(event: AuditEvent) {
      try {
        await Model.create({
          type: event.type,
          accountId: event.accountId ?? null,
          email: event.email ?? null,
          clientId: event.clientId ?? null,
          actorId: event.actorId ?? null,
          ip: event.ip ?? null,
          metadata: event.metadata ?? null,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[authkit] audit sink falhou ao registrar evento', event.type, error);
      }
    },

    async list(params: ListAuditParams): Promise<AuditPage> {
      // The primary key breaks ties between events written in the same instant.
      const pk: string = Model.primaryKey ?? 'id';
      const size = normalizeListSize(params.size, ADMIN_LIST_HTTP_DEFAULT_SIZE);
      const after = params.after ? decodeAuditCursor(params.after) : null;
      const before = !after && params.before ? decodeAuditCursor(params.before) : null;
      const backward = before !== null;
      const seek = after ?? before;

      // Newest first: (createdAt, id) DESC. Going backward the seek and the order flip, and the
      // rows are flipped back below. One extra row tells whether a further page exists.
      const q = filtered(Model.query(), params);
      if (seek) {
        const op = backward ? '>' : '<';
        // Formatted the way Lucid writes `createdAt` for this dialect: nested `where` callbacks
        // do not convert a luxon value, and the comparison must be against the stored form.
        const format = q.client?.dialect?.dateTimeFormat;
        const at = format ? seek.at.toFormat(format) : seek.at.toJSDate();
        q.where((w: any) => {
          w.where('createdAt', op, at).orWhere((eq: any) => {
            eq.where('createdAt', at).where(pk, op, seek.id);
          });
        });
      }
      const dir = backward ? 'asc' : 'desc';
      const rows = await q
        .orderBy('createdAt', dir)
        .orderBy(pk, dir)
        .limit(size + 1);

      const hasMore = rows.length > size;
      let page = hasMore ? rows.slice(0, size) : rows;
      if (backward) page = page.slice().reverse();

      const data: StoredAuditEvent[] = page.map(toStored);
      const first = page[0];
      const last = page[page.length - 1];
      const hasNext = backward ? seek !== null : hasMore;
      const hasPrev = backward ? hasMore : seek !== null;
      return {
        data,
        nextCursor: hasNext && last ? encodeAuditCursor(last) : null,
        prevCursor: hasPrev && first ? encodeAuditCursor(first) : null,
        hasNext,
        hasPrev,
      };
    },

    async count(params: CountAuditParams): Promise<number> {
      const result = await filtered(Model.query(), params).count('* as total');
      return Number(result[0]?.$extras?.total ?? 0);
    },

    /**
     * Anonimiza (LGPD/GDPR) as linhas de audit cujo subject (`accountId`) OU ator
     * (`actorId`) é a conta dada: substitui o id pelo pseudônimo estável e zera os
     * identificadores pessoais (`email`, `ip`). Preserva `type`, `clientId`,
     * `metadata` e o timestamp — o histórico continua íntegro, só não é mais
     * reidentificável. Best-effort: erros são logados e engolidos (retorna 0).
     */
    async anonymizeAccount(accountId: string): Promise<number> {
      if (!accountId) return 0;
      const pseudonym = anonId(accountId);
      try {
        // accountId === conta deletada → subject.
        const asSubject = await Model.query()
          .where('accountId', accountId)
          .update({ accountId: pseudonym, email: null, ip: null });
        // actorId === conta deletada (ações que ela fez como admin) → ator.
        const asActor = await Model.query()
          .where('actorId', accountId)
          .update({ actorId: pseudonym });
        // O retorno do update varia por dialeto (número ou array). Normaliza.
        const n = (v: unknown) => (Array.isArray(v) ? Number(v[0] ?? 0) : Number(v ?? 0));
        return n(asSubject) + n(asActor);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[authkit] audit sink falhou ao anonimizar conta', accountId, error);
        return 0;
      }
    },
  };
}
