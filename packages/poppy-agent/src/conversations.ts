import type { CompanyClient } from './company.js';
import { throwForResponse } from './company.js';
import { ConversationError, PoppyError } from './errors.js';
import { readJson } from './http.js';
import { parseSse } from './sse.js';
import type {
  ConversationEvent,
  ConversationState,
  EventsPage,
  OutgoingMessage,
  PoppyProtocolEntry,
  StartConversationResponse,
  TextDelta,
} from './types.js';
import { randomId, requireSecureUrl, sleep } from './util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** A fresh message ID: URL-safe base64, prefixed, unique for the User (7.2, 7.3). */
export function newMessageId(): string {
  return randomId('msg_', 12);
}

/** Picks the `poppy` conversation protocol entry (7.1); unknown types are skipped. */
export function poppyProtocol(company: CompanyClient): PoppyProtocolEntry | undefined {
  return company.document.agent?.protocols?.find((p) => p?.type === 'poppy');
}

export type StreamItem =
  | { kind: 'event'; event: ConversationEvent }
  | { kind: 'delta'; delta: TextDelta }
  /** The reader reconnected; any provisional `text-delta` pieces must be dropped (7.6). */
  | { kind: 'reconnected' }
  /** `cursor_expired`: the read restarted from the beginning; part of history is missing. */
  | { kind: 'history_gap' };

export interface FollowOptions {
  signal?: AbortSignal;
  /** Stop once the conversation is `idle`, `queued` or `closed` after this many events. */
  untilSettled?: boolean;
  /** Prefer SSE (default). When the Company answers with JSON, long-polling is used. */
  stream?: boolean;
  /** Long-poll `wait` seconds. */
  wait?: number;
}

/**
 * Client for one Company's Poppy conversation endpoint (section 7). Every request carries the
 * Session Token with a DPoP proof (7.2), through `CompanyClient.fetch`.
 */
export class ConversationClient {
  readonly endpoint: string;
  private readonly resource?: string;

  constructor(
    readonly company: CompanyClient,
    entry: PoppyProtocolEntry | undefined = poppyProtocol(company),
  ) {
    if (!entry)
      throw new PoppyError('no_conversation_protocol', 'Company lists no `poppy` protocol');
    this.endpoint = requireSecureUrl(entry.endpoint, 'agent endpoint', company.security)
      .toString()
      .replace(/\/+$/, '');
    this.resource = entry.resource;
  }

  private url(id?: string, suffix?: string, query?: Record<string, string | number | undefined>) {
    if (id !== undefined && !ID_RE.test(id))
      throw new PoppyError('invalid_id', `bad conversation id ${id}`);
    const u = new URL(id === undefined ? this.endpoint : `${this.endpoint}/${id}${suffix ?? ''}`);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  /**
   * POST with retries on network errors / 5xx. Safe because the message ID makes the request
   * idempotent: the Company returns the original response for a repeat (7.3).
   */
  private async post<T>(
    url: string,
    body: unknown,
    retries = 2,
  ): Promise<{ status: number; body: T }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.company.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          resource: this.resource,
        });
        if (res.status >= 500 && attempt < retries) {
          lastErr = new PoppyError(`http_${res.status}`);
          await sleep(300 * (attempt + 1));
          continue;
        }
        if (!res.ok) await throwForResponse(res);
        return { status: res.status, body: (await readJson<T>(res)) as T };
      } catch (e) {
        if (e instanceof PoppyError) throw e;
        lastErr = e;
        if (attempt < retries) await sleep(300 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  private remember(
    id: string,
    patch: Partial<{ cursor: string; closed: boolean; parent: string }>,
  ) {
    const convs = this.company.state.conversations;
    convs[id] ??= { endpoint: this.endpoint, createdAt: Date.now() };
    const rec = convs[id];
    if (patch.cursor !== undefined) rec.cursor = patch.cursor;
    if (patch.closed !== undefined) rec.closed = patch.closed;
    if (patch.parent !== undefined) rec.parentConversationId = patch.parent;
  }

  /** Starts a conversation (7.3), or a Direct Conversation with `parentConversationId` (7.10). */
  async start(
    message: OutgoingMessage,
    opts: { parentConversationId?: string; wait?: number; cursor?: string } = {},
  ): Promise<StartConversationResponse> {
    checkMessage(message);
    const body: Record<string, unknown> = { message };
    if (opts.parentConversationId) body.parent_conversation_id = opts.parentConversationId;
    const r = await this.post<StartConversationResponse>(
      this.url(undefined, undefined, { wait: opts.wait, cursor: opts.cursor }),
      body,
    );
    if (!r.body?.conversation_id) throw new PoppyError('invalid_response', 'no conversation_id');
    this.remember(r.body.conversation_id, { parent: opts.parentConversationId });
    await this.company.save();
    return r.body;
  }

  /** Sends another message (7.3). Returns 202 with `status`/`responder` (+ events with `wait`). */
  async send(
    id: string,
    message: OutgoingMessage,
    opts: { wait?: number; cursor?: string } = {},
  ): Promise<StartConversationResponse> {
    checkMessage(message);
    const r = await this.post<StartConversationResponse>(
      this.url(id, '/messages', { wait: opts.wait, cursor: opts.cursor }),
      { message },
    );
    return r.body;
  }

  /** One read of events after `cursor` (7.5). */
  async read(id: string, opts: { cursor?: string; wait?: number } = {}): Promise<EventsPage> {
    const { body } = await this.company.json<EventsPage>(this.url(id, '/events', opts), {
      headers: { accept: 'application/json' },
      resource: this.resource,
    });
    if (!Array.isArray(body?.events))
      throw new PoppyError('invalid_response', 'events must be a list');
    return body;
  }

  /** Asks for a person at the Company (7.9). */
  async handoff(id: string): Promise<ConversationState> {
    return (await this.post<ConversationState>(this.url(id, '/handoff'), {})).body;
  }

  /** Closes the conversation (7.12). */
  async close(id: string): Promise<ConversationState> {
    const r = (await this.post<ConversationState>(this.url(id, '/close'), {})).body;
    this.remember(id, { closed: true });
    await this.company.save();
    return r;
  }

  /**
   * Reads (long-polling, JSON) until the Company is no longer `working` and `has_more` is
   * false, returning the new events. Used by the autonomous `ask` mode.
   */
  async collect(
    id: string,
    opts: { timeoutMs?: number; wait?: number } = {},
  ): Promise<{ events: ConversationEvent[]; state: ConversationState }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const events: ConversationEvent[] = [];
    const seen = new Set<string>();
    let cursor = this.company.state.conversations[id]?.cursor || undefined;
    for (;;) {
      let page: EventsPage;
      try {
        page = await this.read(id, { cursor, wait: opts.wait ?? 20 });
      } catch (e) {
        if (e instanceof ConversationError && e.code === 'cursor_expired') {
          cursor = undefined;
          continue;
        }
        throw e;
      }
      for (const ev of page.events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        events.push(ev);
      }
      if (page.cursor) cursor = page.cursor;
      this.remember(id, { cursor });
      await this.company.save();
      if (page.has_more) continue;
      if (page.status !== 'working' || Date.now() > deadline) {
        return { events, state: { status: page.status, responder: page.responder } };
      }
    }
  }

  /**
   * Follows a conversation's events in order, from the saved cursor: SSE when the Company
   * streams (reconnecting with `Last-Event-ID`), long-polling otherwise. Skips event IDs it
   * already handled, restarts from the beginning on `cursor_expired`, and persists the cursor.
   */
  async *follow(id: string, opts: FollowOptions = {}): AsyncGenerator<StreamItem> {
    const seen = new Set<string>();
    let cursor = this.company.state.conversations[id]?.cursor;
    let useStream = opts.stream !== false;
    let firstConnect = true;
    let status: string | undefined;

    const handle = async (ev: ConversationEvent): Promise<boolean> => {
      if (!ev || typeof ev.id !== 'string' || seen.has(ev.id)) return false;
      seen.add(ev.id);
      cursor = ev.id;
      this.remember(id, { cursor });
      if (ev.type === 'state' && ev.status) status = ev.status;
      return true;
    };
    const settled = () =>
      opts.untilSettled && (status === 'idle' || status === 'queued' || status === 'closed');

    while (!opts.signal?.aborted) {
      if (!firstConnect) yield { kind: 'reconnected' };
      firstConnect = false;
      let res: Response;
      try {
        const headers: Record<string, string> = {
          accept: useStream ? 'text/event-stream' : 'application/json',
        };
        // Reconnects carry Last-Event-ID in place of `cursor` (7.6).
        if (useStream && cursor) headers['last-event-id'] = cursor;
        res = await this.company.fetch(
          this.url(id, '/events', useStream ? {} : { cursor, wait: opts.wait ?? 25 }),
          { headers, signal: opts.signal, resource: this.resource },
        );
      } catch (e) {
        if (opts.signal?.aborted) return;
        throw e;
      }
      if (!res.ok) {
        const body = await readJson<{ error?: string }>(res.clone());
        if (body?.error === 'cursor_expired') {
          cursor = undefined;
          this.remember(id, { cursor: '' });
          yield { kind: 'history_gap' };
          continue;
        }
        await throwForResponse(res);
      }
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream') && res.body) {
        try {
          for await (const sse of parseSse(res.body)) {
            if (sse.event === 'text-delta') {
              const delta = safeJson<TextDelta>(sse.data);
              if (delta?.message_id) yield { kind: 'delta', delta };
              continue;
            }
            if (sse.event !== 'message') continue; // unknown SSE event names are skipped
            const ev = safeJson<ConversationEvent>(sse.data);
            if (ev && (await handle(ev))) {
              yield { kind: 'event', event: ev };
              if (settled()) {
                await this.company.save();
                return;
              }
            }
          }
        } catch (e) {
          if (opts.signal?.aborted) return;
          this.company.agent.log(`stream interrupted: ${(e as Error).message}`);
        }
        await this.company.save();
        if (status === 'closed') return;
        await sleep(250, opts.signal).catch(() => {});
        continue;
      }
      // The Company answered with JSON: it doesn't stream, so long-poll from now on (7.6).
      useStream = false;
      const page = (await readJson<EventsPage>(res)) as EventsPage;
      status = page?.status ?? status;
      for (const ev of page?.events ?? []) {
        if (await handle(ev)) yield { kind: 'event', event: ev };
      }
      if (page?.cursor) {
        cursor = page.cursor;
        this.remember(id, { cursor });
      }
      await this.company.save();
      if (page?.has_more) {
        firstConnect = true; // not a reconnect, just the next page
        continue;
      }
      if (settled() || status === 'closed') return;
      firstConnect = true;
    }
  }
}

function safeJson<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/** 7.4: `id` + `sender` required, and at least one of `text`, `data`, `context`. */
function checkMessage(m: OutgoingMessage) {
  if (!ID_RE.test(m.id))
    throw new ConversationError('invalid_message', { description: 'bad message id' });
  if (m.sender !== 'agent' && m.sender !== 'human') {
    throw new ConversationError('invalid_message', {
      description: 'sender must be agent or human',
    });
  }
  if (m.text === undefined && m.data === undefined && m.context === undefined) {
    throw new ConversationError('invalid_message', {
      description: 'a message needs text, data or context',
    });
  }
}
