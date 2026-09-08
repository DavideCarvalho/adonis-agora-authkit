/**
 * Convenções de paginação por OFFSET compartilhadas por TODAS as listagens
 * paginadas do authkit (contas, log de auditoria, console admin e Admin API).
 *
 * O shape `{ page, size }` espelha INTENCIONALMENTE o de `@adonis-agora/filter`
 * (`FilterInput.page` / `FilterInput.size` → `ResolvedPagination { page, size }`),
 * para que todos os pacotes `@adonis-agora/*` exponham a MESMA interface de
 * paginação. O casamento é ESTRUTURAL de propósito: NÃO dependemos de
 * `@adonis-agora/filter` — só seguimos o mesmo contrato.
 *
 * - `page` é 1-based; default {@link LIST_FIRST_PAGE}.
 * - `size` é o tamanho da página; default {@link ADMIN_LIST_DEFAULT_SIZE} nas
 *   varreduras programáticas e {@link ADMIN_LIST_HTTP_DEFAULT_SIZE} na wire HTTP.
 * - Na wire HTTP os parâmetros são `?page=1&size=25`.
 */

/** Primeira página. A paginação é 1-based, como em `@adonis-agora/filter`. */
export const LIST_FIRST_PAGE = 1;

/**
 * Tamanho de página default das varreduras programáticas internas (ex.: contagem
 * de admins e agregação de orgs, que paginam o `accountStore` até o fim).
 */
export const ADMIN_LIST_DEFAULT_SIZE = 100;

/**
 * Tamanho de página default quando a request HTTP não manda `?size=`. Menor que
 * {@link ADMIN_LIST_DEFAULT_SIZE} porque é o que a UI do console renderiza por página.
 */
export const ADMIN_LIST_HTTP_DEFAULT_SIZE = 20;

/**
 * Teto de `size` aceito de um caller NÃO CONFIÁVEL — ou seja, de query params
 * HTTP ({@link parseListSize}). Antes não havia teto nenhum no console admin
 * nem na Admin API além de um `Math.min` solto por controller; agora é um só
 * número, para que um `?size=100000` não vire um scan de tabela inteira.
 *
 * NÃO é aplicado a chamadas programáticas de dentro da lib (ex.: o export
 * LGPD/GDPR lê 1000 eventos de auditoria de uma vez): essas são confiáveis e
 * usam {@link normalizeListSize}.
 */
export const ADMIN_LIST_MAX_SIZE = 200;

/** Normaliza um `page` arbitrário para um inteiro 1-based válido. */
export function resolveListPage(page: number | undefined): number {
  const n = Math.trunc(Number(page));
  return Number.isFinite(n) && n >= LIST_FIRST_PAGE ? n : LIST_FIRST_PAGE;
}

/**
 * Normaliza um `size` de caller CONFIÁVEL para um inteiro `>= 1`, caindo em
 * `fallback` quando ausente/inválido. Sem teto — veja {@link clampListSize}.
 */
export function normalizeListSize(
  size: number | undefined,
  fallback: number = ADMIN_LIST_DEFAULT_SIZE,
): number {
  const n = Math.trunc(Number(size));
  return Number.isFinite(n) && n >= 1 ? n : Math.max(1, fallback);
}

/**
 * Idem {@link normalizeListSize}, mas limitado a {@link ADMIN_LIST_MAX_SIZE}.
 * Use em TODA borda que recebe `size` de fora do processo.
 */
export function clampListSize(
  size: number | undefined,
  fallback: number = ADMIN_LIST_DEFAULT_SIZE,
): number {
  return Math.min(ADMIN_LIST_MAX_SIZE, normalizeListSize(size, fallback));
}

/** {@link resolveListPage} a partir do valor cru de um query param. */
export function parseListPage(raw: unknown): number {
  return resolveListPage(Number.parseInt(String(raw ?? ''), 10));
}

/** {@link clampListSize} a partir do valor cru de um query param. */
export function parseListSize(
  raw: unknown,
  fallback: number = ADMIN_LIST_HTTP_DEFAULT_SIZE,
): number {
  return clampListSize(Number.parseInt(String(raw ?? ''), 10), fallback);
}

/**
 * Envelope de METADADOS de uma listagem paginada — a chave `meta` de toda
 * resposta paginada do authkit (`{ meta, data }`).
 *
 * O nome `meta` e a co-locação de `{ page, size }` dentro dele são a convenção
 * do `.paginate()` do Lucid (`{ meta, data }`) — que é onde o caminho por
 * offset de `@adonis-agora/filter` desemboca — e por isso a convenção adotada
 * por TODO o ecossistema `@adonis-agora/*`. Antes o authkit achatava
 * `total`/`page`/`size` ao lado de `data`, sem envelope.
 */
export interface ListMeta {
  /** Página devolvida (1-based). */
  page: number;
  /** Tamanho de página efetivamente aplicado (já normalizado/limitado). */
  size: number;
  /** Total absoluto de itens que casam com o filtro, através de todas as páginas. */
  total: number;
}

/** Resposta paginada padrão: `{ meta, data }`, na ordem do `.paginate()` do Lucid. */
export interface PaginatedResponse<T> {
  meta: ListMeta;
  data: T[];
}
