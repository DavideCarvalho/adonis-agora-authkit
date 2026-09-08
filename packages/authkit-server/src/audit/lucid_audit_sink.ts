import { createHash } from 'node:crypto';
import { ADMIN_LIST_HTTP_DEFAULT_SIZE, normalizeListSize, resolveListPage } from '../pagination.js';
import type {
  AuditEvent,
  AuditPage,
  AuditSink,
  ListAuditParams,
  StoredAuditEvent,
} from './audit_sink.js';

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
      const page = resolveListPage(params.page);
      const size = normalizeListSize(params.size, ADMIN_LIST_HTTP_DEFAULT_SIZE);

      const base = () => {
        const q = Model.query();
        if (params.type) q.where('type', params.type);
        if (params.subject) q.where('accountId', params.subject);
        return q;
      };

      const countResult = await base().count('* as total');
      const total = Number(countResult[0]?.$extras?.total ?? 0);

      const rows = await base()
        .orderBy('createdAt', 'desc')
        .offset((page - 1) * size)
        .limit(size);

      const data: StoredAuditEvent[] = rows.map((row: any) => ({
        id: String(row.id),
        type: row.type,
        accountId: row.accountId ?? null,
        email: row.email ?? null,
        clientId: row.clientId ?? null,
        actorId: row.actorId ?? null,
        ip: row.ip ?? null,
        metadata: row.metadata ?? undefined,
        // createdAt é um luxon DateTime no Lucid; normaliza para ISO string.
        createdAt: row.createdAt?.toISO?.() ?? row.createdAt ?? null,
      }));

      return { data, total };
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
