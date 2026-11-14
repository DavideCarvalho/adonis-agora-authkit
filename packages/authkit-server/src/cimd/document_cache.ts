/**
 * Cache de documentos JSON de terceiros buscados por URL — o Client ID Metadata Document de um
 * cliente MCP, o documento e o JWKS de um agente do `@adonis-agora/authkit-poppy`.
 *
 * Cada URL vira UMA busca em voo (pedidos simultâneos esperam a mesma promise), o sucesso fica em
 * cache pelo `max-age` do `Cache-Control` dentro de `[min, max]`, e a FALHA também fica um tempo
 * curto em cache, para que o mesmo `client_id` ruim não vire uma busca de saída por request. O
 * número de entradas é limitado (a mais antiga sai).
 */
import { type FetchedJson, type JsonFetcher, SafeFetchError } from './safe_fetch.js';

/** Limites do cache, em SEGUNDOS. */
export interface DocumentCacheTtl {
  /** Piso do tempo em cache de um documento. Default: 60. */
  min?: number;
  /** Teto do tempo em cache de um documento. Default: 86400 (24 h). */
  max?: number;
  /** Sem `max-age` na resposta. Default: 3600, dentro de `[min, max]`. */
  fallback?: number;
}

export interface MetadataDocumentCacheOptions<T> {
  /** Busca do JSON (à prova de SSRF em produção: {@link safeFetchJson}). */
  fetchJson: JsonFetcher;
  /** Valida o corpo buscado de `url` e devolve o valor guardado. Lança para recusar. */
  validate: (url: string, body: unknown) => T;
  /** Erro de uma busca que falhou; `why` = a razão da recusa (`timeout`, `blocked address`…). */
  fetchError?: (url: string, why: string) => Error;
  ttl?: DocumentCacheTtl;
  /** Quanto uma falha fica em cache, em segundos. Default: 60. */
  failureTtl?: number;
  /** Máximo de entradas. Default: 1000. */
  maxEntries?: number;
  /** Intervalo mínimo entre duas buscas forçadas da mesma URL, em segundos. Default: 30. */
  refreshCooldown?: number;
  now?: () => number;
}

interface Entry<T> {
  value: Promise<T>;
  /** O valor, quando a busca deu certo. */
  settled?: { ok: true; value: T } | { ok: false };
  expiresAt: number;
  fetchedAt: number;
}

/** Limites efetivos (segundos) de um {@link DocumentCacheTtl}. */
export function resolveDocumentCacheTtl(ttl: DocumentCacheTtl = {}): Required<DocumentCacheTtl> {
  const min = Math.max(0, ttl.min ?? 60);
  const max = Math.max(min, ttl.max ?? 86_400);
  const fallback = Math.min(max, Math.max(min, ttl.fallback ?? 3600));
  return { min, max, fallback };
}

export class MetadataDocumentCache<T> {
  #fetch: JsonFetcher;
  #validate: (url: string, body: unknown) => T;
  #fetchError: (url: string, why: string) => Error;
  #ttl: Required<DocumentCacheTtl>;
  #failureMs: number;
  #maxEntries: number;
  #cooldownMs: number;
  #now: () => number;
  #entries = new Map<string, Entry<T>>();

  constructor(options: MetadataDocumentCacheOptions<T>) {
    this.#fetch = options.fetchJson;
    this.#validate = options.validate;
    this.#fetchError = options.fetchError ?? ((url, why) => new SafeFetchError(`${url}: ${why}`));
    this.#ttl = resolveDocumentCacheTtl(options.ttl);
    this.#failureMs = (options.failureTtl ?? 60) * 1000;
    this.#maxEntries = Math.max(1, options.maxEntries ?? 1000);
    this.#cooldownMs = (options.refreshCooldown ?? 30) * 1000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * O documento de `url`: do cache enquanto vale, senão buscado e validado. `force` busca de novo
   * (ex.: um `kid` desconhecido num JWKS), no máximo uma vez por `refreshCooldown`.
   */
  get(url: string, options: { force?: boolean } = {}): Promise<T> {
    const now = this.#now();
    const cached = this.#entries.get(url);
    if (cached && !options.force && cached.expiresAt > now) return cached.value;
    if (cached && options.force && now - cached.fetchedAt < this.#cooldownMs) return cached.value;

    const entry: Entry<T> = {
      value: Promise.resolve(undefined as T),
      expiresAt: now + this.#failureMs,
      fetchedAt: now,
    };
    entry.value = (async () => {
      let fetched: FetchedJson;
      try {
        fetched = await this.#fetch(url);
      } catch (error) {
        throw this.#fetchError(
          url,
          error instanceof SafeFetchError ? error.message : 'unreachable',
        );
      }
      const value = this.#validate(url, fetched.body);
      entry.expiresAt = this.#now() + this.#ttlMs(fetched.maxAge);
      entry.settled = { ok: true, value };
      return value;
    })();
    entry.value.catch(() => {
      entry.settled = { ok: false };
      entry.expiresAt = this.#now() + this.#failureMs;
    });
    this.#entries.delete(url);
    this.#entries.set(url, entry);
    if (this.#entries.size > this.#maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value as string);
    }
    return entry.value;
  }

  /** O valor em cache e ainda válido de `url`, sem buscar. */
  peek(url: string): T | undefined {
    const entry = this.#entries.get(url);
    if (!entry || entry.expiresAt <= this.#now() || entry.settled?.ok !== true) return undefined;
    return entry.settled.value;
  }

  /** As URLs com um documento válido em cache, com o valor. */
  entries(): Array<[url: string, value: T]> {
    const now = this.#now();
    const out: Array<[string, T]> = [];
    for (const [url, entry] of this.#entries) {
      if (entry.expiresAt > now && entry.settled?.ok === true) out.push([url, entry.settled.value]);
    }
    return out;
  }

  delete(url: string): void {
    this.#entries.delete(url);
  }

  clear(): void {
    this.#entries.clear();
  }

  #ttlMs(maxAge: number | null): number {
    const seconds = maxAge === null ? this.#ttl.fallback : maxAge;
    return Math.min(this.#ttl.max, Math.max(this.#ttl.min, seconds)) * 1000;
  }
}
