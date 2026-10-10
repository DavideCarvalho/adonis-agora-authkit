/** One dispatched server-sent event (WHATWG HTML, "Server-sent events"). */
export interface SseEvent {
  /** `message` when the stream gave no `event:` field. */
  event: string;
  data: string;
  /** The `id:` field of this event, if it had one. */
  id?: string;
  retry?: number;
}

/**
 * Parses an SSE byte stream. Follows the WHATWG algorithm closely enough for Poppy: CRLF/CR/LF
 * line endings, `:` comments, multi-line `data`, `id` without NUL, `retry`.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  let retry: number | undefined;
  let sawCr = false;

  const dispatch = (): SseEvent | undefined => {
    const out =
      data.length > 0 ? { event: event || 'message', data: data.join('\n'), id, retry } : undefined;
    data = [];
    event = '';
    id = undefined;
    retry = undefined;
    return out;
  };

  const handleLine = (line: string): SseEvent | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
    return undefined;
  };

  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '\n' && sawCr) {
          sawCr = false;
          start = i + 1;
          continue;
        }
        sawCr = false;
        if (ch === '\r' || ch === '\n') {
          if (ch === '\r') sawCr = true;
          const ev = handleLine(buffer.slice(start, i));
          start = i + 1;
          if (ev) yield ev;
        }
      }
      buffer = buffer.slice(start);
    }
    // An event without its terminating blank line is discarded, per the spec.
  } finally {
    reader.releaseLock();
  }
}
