/**
 * Prefixo do console admin e da Admin REST API — singletons de processo.
 *
 * Definidos em tempo de registro das rotas (`registerAuthHost`) e lidos em
 * runtime pelos controllers e pelo `adminGuard`. Garantia de normalização:
 * começa com '/', sem trailing slash, defaults '/admin' e '/api/authkit/v1'.
 *
 * Por que módulos singleton e não bindings do container?
 * O container do AdonisJS só está disponível no ciclo de vida de uma request;
 * os prefixos precisam estar disponíveis ANTES da primeira request (ex.: na
 * closure do `adminGuard`, que é construída em tempo de registro) e DENTRO de
 * cada request. Um módulo ESM é inicializado uma vez por processo — perfeito
 * para configuração imutável definida no boot.
 */

// ─── Console admin ───────────────────────────────────────────────────────────

const DEFAULT_ADMIN_PREFIX = '/admin';

let _prefix: string = DEFAULT_ADMIN_PREFIX;

/**
 * Normaliza o prefixo: começa com '/', sem trailing slash.
 * `'/'` → `''` (raiz) é improvável mas seguro.
 */
export function normalizeAdminPrefix(raw: string): string {
  let p = raw.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  return p || '/';
}

/**
 * Define o prefixo do console admin para este processo.
 * Chamado UMA VEZ por `registerAuthHost` no boot da aplicação.
 *
 * @param prefix  Caminho base do console (ex.: `'/admin'`, `'/auth/admin'`).
 *                Normalizado automaticamente.
 */
export function setAdminPrefix(prefix: string): void {
  _prefix = normalizeAdminPrefix(prefix);
  _mounted = true;
}

/** Whether `registerAuthHost` mounted the admin console in this process. */
let _mounted = false;

/** `true` once `registerAuthHost` mounted the admin console (it sets the prefix then). */
export function isAdminConsoleMounted(): boolean {
  return _mounted;
}

/** Back to the defaults: `/admin`, not mounted (tests). */
export function resetAdminPrefix(): void {
  _prefix = DEFAULT_ADMIN_PREFIX;
  _mounted = false;
}

/**
 * Retorna o prefixo do console admin (default `'/admin'`).
 * Usado pelos controllers e pelo `adminGuard` para construir redirects/links.
 */
export function getAdminPrefix(): string {
  return _prefix;
}

// ─── Admin REST API ───────────────────────────────────────────────────────────

const DEFAULT_ADMIN_API_PREFIX = '/api/authkit/v1';

let _apiPrefix: string = DEFAULT_ADMIN_API_PREFIX;

/**
 * Normaliza o prefixo da Admin REST API: começa com '/', sem trailing slash.
 * Mesma semântica de `normalizeAdminPrefix`.
 */
export function normalizeAdminApiPrefix(raw: string): string {
  let p = raw.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/+$/, '');
  return p || '/';
}

/**
 * Define o prefixo da Admin REST API para este processo.
 * Chamado UMA VEZ por `registerAuthHost` no boot da aplicação.
 *
 * @param prefix  Caminho base da API (ex.: `'/api/authkit/v1'`, `'/authkit/api'`).
 *                Normalizado automaticamente.
 */
export function setAdminApiPrefix(prefix: string): void {
  _apiPrefix = normalizeAdminApiPrefix(prefix);
}

/**
 * Retorna o prefixo da Admin REST API (default `'/api/authkit/v1'`).
 * Usado pelo `adminApiGuard` e pelo SDK remoto para construir as URLs.
 */
export function getAdminApiPrefix(): string {
  return _apiPrefix;
}

// ─── Admin UI mode ────────────────────────────────────────────────────────────
