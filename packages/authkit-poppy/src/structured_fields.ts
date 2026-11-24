/**
 * O pedaço da RFC 9651 (Structured Field Values) que os headers da extensão Operations usam:
 * Dictionaries de itens simples (`Poppy-Approval`, `Poppy-Operation`). Listas internas e byte
 * sequences não aparecem neles: um header com elas não parseia.
 */

export type SfBareItem = string | number | boolean | { token: string };

/** `null` = o header não parseia (RFC 9651 §4.2: trate como ausente/inválido). */
export function parseSfDictionary(
  value: string | string[] | undefined,
): Map<string, SfBareItem> | null {
  const raw = Array.isArray(value) ? value.join(', ') : value;
  if (raw === undefined) return null;
  const out = new Map<string, SfBareItem>();
  let i = 0;
  const n = raw.length;
  const ows = () => {
    while (i < n && (raw[i] === ' ' || raw[i] === '\t')) i++;
  };
  const sp = () => {
    while (i < n && raw[i] === ' ') i++;
  };
  const key = (): string | null => {
    if (i >= n || !/[a-z*]/.test(raw[i])) return null;
    const start = i;
    while (i < n && /[a-z0-9_\-.*]/.test(raw[i])) i++;
    return raw.slice(start, i);
  };
  const string = (): string | null => {
    i++; // "
    let text = '';
    while (i < n) {
      const c = raw[i++];
      if (c === '\\') {
        const next = raw[i++];
        if (next !== '"' && next !== '\\') return null;
        text += next;
      } else if (c === '"') {
        return text;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) return null;
        text += c;
      }
    }
    return null;
  };
  const number = (): number | null => {
    const match = /^-?\d{1,15}(\.\d{1,3})?/.exec(raw.slice(i));
    if (!match) return null;
    const text = match[0];
    if (!text.includes('.') && text.replace('-', '').length > 15) return null;
    i += text.length;
    return Number(text);
  };
  const bare = (): SfBareItem | null => {
    const c = raw[i];
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    if (c === '?') {
      const b = raw[i + 1];
      if (b !== '0' && b !== '1') return null;
      i += 2;
      return b === '1';
    }
    if (c !== undefined && /[A-Za-z*]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_\-.:%*/!#$&'+^`|~]/.test(raw[i])) i++;
      return { token: raw.slice(start, i) };
    }
    return null;
  };
  const params = (): boolean => {
    while (raw[i] === ';') {
      i++;
      sp();
      if (key() === null) return false;
      if (raw[i] === '=') {
        i++;
        if (bare() === null) return false;
      }
    }
    return true;
  };
  sp();
  if (i >= n) return out;
  while (i < n) {
    const name = key();
    if (name === null) return null;
    let item: SfBareItem = true;
    if (raw[i] === '=') {
      i++;
      const parsed = bare();
      if (parsed === null) return null;
      item = parsed;
    }
    if (!params()) return null;
    out.set(name, item);
    ows();
    if (i >= n) break;
    if (raw[i] !== ',') return null;
    i++;
    ows();
    if (i >= n) return null;
  }
  return out;
}

/** Uma String da RFC 9651, com aspas e escapes. Só ASCII visível e espaço. */
export function sfString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error('sf-string precisa ser ASCII visível');
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
