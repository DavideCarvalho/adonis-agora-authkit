/**
 * `fetch` de documentos JSON de terceiros à prova de SSRF.
 *
 * O `client_id` de um agente Poppy é uma URL que QUALQUER um escolhe — buscá-la
 * sem cuidado faria deste app um proxy para a rede interna. Regras:
 *  - só `https:`; sem credenciais na URL; porta qualquer;
 *  - o IP é conferido NA CONEXÃO (o `lookup` do socket), não num DNS separado —
 *    sem janela para DNS rebinding; loopback, privados, link-local, CGNAT,
 *    multicast, reservados e os equivalentes IPv6 são recusados;
 *  - IP literal na URL passa pela mesma regra;
 *  - sem redirects (o `client_id` tem de ser exatamente a URL buscada);
 *  - teto de tempo e de bytes.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface FetchedJson {
  status: number;
  body: unknown;
  /** `max-age` do `Cache-Control`, em segundos, quando há. */
  maxAge: number | null;
}

/** Busca um JSON (GET). Lança {@link SafeFetchError} em qualquer recusa. */
export type JsonFetcher = (url: string) => Promise<FetchedJson>;

export type LookupFn = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Resolução de nomes — injetável nos testes. Default: `dns.lookup`. */
  lookup?: LookupFn;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip: number, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

/** Expande um IPv6 em 8 grupos de 16 bits. */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0];
  // Sufixo IPv4 (::ffff:1.2.3.4).
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = `${addr.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => Number.parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** `true` quando o IP não pode ser alvo de uma busca de saída. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some((cidr) => inV4(n, cidr));
  }
  if (family !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) e IPv4-compatible: decide pelo IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return isBlockedAddress(v4);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 (site-local)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 (doc)
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x2002) {
    // 6to4: o IPv4 embutido.
    return isBlockedAddress(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`);
  }
  return false;
}

function parseMaxAge(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return null;
  if (/\bno-store\b|\bno-cache\b/i.test(value)) return 0;
  const match = /\bmax-age=(\d+)/i.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * Busca `url` e devolve o JSON. Só HTTPS, sem redirect, IP público conferido na
 * conexão, `timeoutMs` (default 5 s) e `maxBytes` (default 64 KiB).
 */
export function safeFetchJson(url: string, options: SafeFetchOptions = {}): Promise<FetchedJson> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const resolve = options.lookup ?? (dnsLookup as unknown as LookupFn);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.reject(new SafeFetchError('invalid URL'));
  }
  if (parsed.protocol !== 'https:') return Promise.reject(new SafeFetchError('only https URLs'));
  if (parsed.username || parsed.password) {
    return Promise.reject(new SafeFetchError('credentials in URL'));
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) {
    return Promise.reject(new SafeFetchError('blocked address'));
  }

  // `lookup` do socket: resolve e recusa se QUALQUER endereço for interno.
  const guardedLookup = (
    hostname: string,
    opts: any,
    callback: (err: Error | null, address?: any, family?: number) => void,
  ) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = addresses ?? [];
      if (list.length === 0) return callback(new SafeFetchError('no address'));
      if (list.some((a) => isBlockedAddress(a.address))) {
        return callback(new SafeFetchError('blocked address'));
      }
      if (opts?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };

  return new Promise<FetchedJson>((done, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = httpsRequest(
      parsed,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'authkit-poppy/0.1' },
        lookup: guardedLookup as any,
        // IP literal: o `lookup` não roda — já conferido acima.
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return finish(() => reject(new SafeFetchError('redirects are not followed')));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            finish(() => reject(new SafeFetchError('response too large')));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(() => {
            if (status !== 200) return reject(new SafeFetchError(`HTTP ${status}`));
            try {
              done({
                status,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                maxAge: parseMaxAge(res.headers['cache-control']),
              });
            } catch {
              reject(new SafeFetchError('invalid JSON'));
            }
          }),
        );
        res.on('error', (e) => finish(() => reject(new SafeFetchError(e.message))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new SafeFetchError('timeout')));
    }, timeoutMs);
    req.on('error', (e) =>
      finish(() => reject(e instanceof SafeFetchError ? e : new SafeFetchError(e.message))),
    );
    req.end();
  });
}
