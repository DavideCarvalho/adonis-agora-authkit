import { createHmac } from 'node:crypto';
import type { AuditEvent, AuditSink } from '../audit/audit_sink.js';
import { emitDiagnostic } from '../observability/diagnostics_bridge.js';

/**
 * Configuração de eventos/webhooks para o host observar tudo que o IdP audita.
 *
 *   - `onEvent`: callback in-process disparado para CADA evento de auditoria
 *     (best-effort, fire-and-forget). Útil para encaminhar a um bus interno.
 *   - `webhook`: POST JSON do evento para uma URL externa. Quando `secret` é dado,
 *     assina o corpo com HMAC-SHA256 no header `x-authkit-signature`.
 *
 * Nada aqui pode lançar para dentro do caminho da request: todo erro é engolido.
 */
export interface EventsConfigInput {
  /** Callback in-process para cada evento auditado (best-effort). */
  onEvent?: (event: AuditEvent) => void | Promise<void>;
  /** Webhook HTTP: POST do evento em JSON. */
  webhook?: {
    /** URL de destino do POST. */
    url: string;
    /** Segredo opcional para assinar o corpo (HMAC-SHA256). */
    secret?: string;
  };
}

export interface ResolvedEventsConfig {
  onEvent?: (event: AuditEvent) => void | Promise<void>;
  webhook?: { url: string; secret?: string };
}

export function resolveEvents(input?: EventsConfigInput): ResolvedEventsConfig | undefined {
  if (!input || (!input.onEvent && !input.webhook)) return undefined;
  return {
    onEvent: input.onEvent,
    webhook: input.webhook,
  };
}

/** Timeout (ms) do POST do webhook antes de abortar. */
const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Constrói o corpo JSON canônico do webhook a partir de um evento de auditoria.
 * O `ts` é o instante do dispatch (ISO 8601).
 */
export function buildWebhookBody(event: AuditEvent): string {
  return JSON.stringify({
    type: event.type,
    accountId: event.accountId ?? null,
    email: event.email ?? null,
    clientId: event.clientId ?? null,
    orgId: event.orgId ?? null,
    ip: event.ip ?? null,
    metadata: event.metadata ?? {},
    ts: new Date().toISOString(),
  });
}

/** Calcula o header de assinatura `sha256=<hmac>` para um corpo + segredo. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Projeta um {@link AuditEvent} para o barramento `@agora/diagnostics` SEM PII
 * direta (LGPD/GDPR — completude do "direito ao esquecimento").
 *
 * Motivação: o ramo de diagnostics espelha CADA evento de auditoria no barramento,
 * de onde o Telescope o captura como um `diagnostic` INDEPENDENTE (tag
 * `lib:authkit`) na SUA PRÓPRIA store. Esse espelho NÃO é alcançado pelo cascade de
 * deleção de conta — o passo `anonymizeAudit` só anonimiza as linhas do audit-sink,
 * não as cópias que vazaram para o Telescope. Se o evento bruto fosse para o
 * barramento, o `email`/`ip` de uma conta deletada sobreviveria no store do
 * Telescope.
 *
 * Para fechar isso na origem (mais robusto que um purge cross-store), a projeção que
 * vai para o barramento já NASCE sem os identificadores diretos:
 *
 *   - REMOVE `email` e `ip` (PII direta);
 *   - REMOVE `metadata` — é livre (`Record<string, unknown>`) e pode carregar PII,
 *     p.ex. `{ email }` (convites de org) ou `{ oldEmail, newEmail }` (troca de
 *     e-mail). Nenhum data provider do dashboard lê `metadata`, então dropá-lo é
 *     seguro;
 *   - MANTÉM `type` (a família do evento — o que os providers agregam) e os ids
 *     internos opacos `accountId`/`actorId`/`clientId`/`orgId` (correlação de
 *     subject/actor/tenant no dashboard; NÃO são PII direta e, sem `email`/`ip`/
 *     `metadata` e com a linha da conta já deletada, não são reidentificáveis).
 *     O `orgId` está aqui porque é o que torna o barramento UTILIZÁVEL para
 *     provisioning multi-tenant (o `@adonis-agora/authz` escuta
 *     `agora:authkit:organization.*` e precisa saber qual tenant escopar) —
 *     sem ele o consumidor recebia o tipo do evento e mais nada.
 *
 * Assim o Telescope nunca armazena PII bruta e a deleção de conta não precisa de uma
 * etapa de purge cross-lib. Os ramos `onEvent`/`webhook` (integrações que o host
 * habilita explicitamente) continuam recebendo o evento COMPLETO — só a ponte de
 * diagnostics é redigida.
 */
export function redactAuditEventForDiagnostics(event: AuditEvent): AuditEvent {
  return {
    type: event.type,
    accountId: event.accountId ?? null,
    actorId: event.actorId ?? null,
    clientId: event.clientId ?? null,
    orgId: event.orgId ?? null,
  };
}

/**
 * Dispara o webhook de forma fire-and-forget: timeout de 5s via AbortSignal,
 * captura QUALQUER erro (rede, abort, HMAC) sem propagar. Nunca lança.
 */
async function dispatchWebhook(
  webhook: { url: string; secret?: string },
  event: AuditEvent,
): Promise<void> {
  try {
    const body = buildWebhookBody(event);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (webhook.secret) {
      headers['x-authkit-signature'] = signWebhookBody(body, webhook.secret);
    }
    await fetch(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    // best-effort: erro de webhook nunca quebra o caminho da request.
  }
}

/**
 * Decora um AuditSink (ou cria um do zero) num sink fan-out: cada `record`
 * persiste no sink original (se houver) E dispara onEvent + webhook. Falhas em
 * qualquer ramo são isoladas — uma não impede as outras nem a request.
 *
 * `list` é delegado ao sink original quando existir (preserva a consulta admin).
 */
export function composeAuditSink(
  original: AuditSink | undefined,
  events: ResolvedEventsConfig = {},
): AuditSink {
  const composed: AuditSink = {
    async record(event: AuditEvent): Promise<void> {
      // Persistência original (best-effort, isolada).
      if (original) {
        try {
          await original.record(event);
        } catch {
          // sink original com defeito não impede os demais ramos.
        }
      }
      // Callback in-process (best-effort, isolado).
      if (events.onEvent) {
        try {
          await events.onEvent(event);
        } catch {
          // onEvent com defeito não quebra a request.
        }
      }
      // Webhook fire-and-forget (não aguardamos a entrega).
      if (events.webhook) {
        void dispatchWebhook(events.webhook, event);
      }
      // Diagnostics Agora (best-effort, sempre ligado, no-op sem o slot).
      // Canal: `agora:authkit:<AuditEventType>` (o `type` É o sufixo).
      // Emite uma projeção REDIGIDA (sem `email`/`ip`/`metadata`) para que o
      // Telescope nunca armazene PII bruta — ver `redactAuditEventForDiagnostics`.
      emitDiagnostic(event.type, redactAuditEventForDiagnostics(event));
    },
  };
  // Preserva a capacidade de consulta do sink original (console admin).
  if (original && typeof original.list === 'function') {
    composed.list = original.list.bind(original);
  }
  // Preserva a anonimização (LGPD) do sink original (deleção de conta).
  if (original && typeof original.anonymizeAccount === 'function') {
    composed.anonymizeAccount = original.anonymizeAccount.bind(original);
  }
  // Preserva quaisquer propriedades extras do sink original (ex.: campos de
  // introspecção/diagnóstico que sinks customizados expõem) — o fan-out é um
  // decorador transparente sobre a superfície do sink original. Funções são
  // re-ligadas ao original para manter o `this`; métodos já tratados acima e o
  // `record` (sobrescrito) não são copiados.
  if (original) {
    const src = original as unknown as Record<string, unknown>;
    const dst = composed as unknown as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      if (key === 'record' || key === 'list' || key === 'anonymizeAccount') continue;
      const value = src[key];
      dst[key] = typeof value === 'function' ? value.bind(original) : value;
    }
  }
  return composed;
}
