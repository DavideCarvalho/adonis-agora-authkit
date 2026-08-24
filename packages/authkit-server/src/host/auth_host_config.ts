import type { HttpContext } from '@adonisjs/core/http';
import type { AuthSocialConfig, ResolvedRateLimitConfig } from '../define_config.js';
import type { PolicyRouteOption } from './config_locks.js';
import type { AuthHostOptions } from './register_auth_host.js';
import type { SudoMethod } from './sudo/types.js';

/**
 * Bits de routing do config resolvido que o `registerAuthHost` precisa em tempo de
 * REGISTRO de rota (síncrono). Stash feito no `boot()` do provider — que roda ANTES
 * dos preloads (start/routes.ts) — para que `registerAuthHost` leia do config em vez
 * de exigir que o consumidor reespecifique tudo (elimina o drift config↔registerAuthHost).
 *
 * Module-level porque o IdP é um por processo (mesmo padrão de config_locks).
 */
export interface AuthHostRuntimeConfig {
  mountPath: string;
  social?: AuthSocialConfig;
  rateLimit: ResolvedRateLimitConfig;
  adminEnabled: boolean;
  adminApiEnabled: boolean;
  /**
   * `config.sudo.methods` — a lista que a TELA oferece e que os handlers
   * ACEITAM. Presente aqui para que `registerAuthHost` MONTE exatamente ela,
   * em vez de exigir que o host repita a lista no `start/routes.ts`.
   */
  sudoMethods?: SudoMethod[];
  /**
   * Defaults ESTRUTURAIS declarados em `config.routes` (prefixo do console de
   * conta, telas montadas, destino de login). Argumentos de `registerAuthHost`
   * continuam vencendo sobre estes — ver a regra de precedência no docblock de
   * `registerAuthHost`.
   */
  routes?: AuthHostOptions;
  /**
   * Opções de POLÍTICA travadas por terem sido declaradas no `defineConfig`.
   * Ver `deriveLockedRouteOptions`.
   */
  lockedRouteOptions?: PolicyRouteOption[];
  /**
   * API headless (Clerk-style). Presente quando o host a declarou — o provider o
   * stash no boot para `registerAuthHost` montar as rotas sem reler o config inteiro.
   */
  headless?: {
    baseUrl: string;
    resolveAccountId: (ctx: HttpContext) => string | null | Promise<string | null>;
  };
}

let stashed: AuthHostRuntimeConfig | undefined;
let autoMounted = false;

/** Stash dos bits de routing (chamado no boot do provider). */
export function setAuthHostConfig(config: AuthHostRuntimeConfig): void {
  stashed = config;
}

/** Lê os bits de routing stashados; undefined se o boot ainda não rodou (fallback p/ opts/defaults). */
export function getAuthHostConfig(): AuthHostRuntimeConfig | undefined {
  return stashed;
}

/**
 * Registra que o provider já montou as rotas automaticamente (`config.routes`).
 * A partir daí uma chamada manual a `registerAuthHost` é um DUPLO REGISTRO —
 * duas rotas com o mesmo nome derrubam o boot do AdonisJS —, então ela lança
 * com a instrução de qual dos dois caminhos remover.
 */
export function markAuthHostAutoMounted(): void {
  autoMounted = true;
}

/** O provider já auto-montou as rotas neste processo? */
export function wasAuthHostAutoMounted(): boolean {
  return autoMounted;
}

/** Limpa o stash — uso em testes. */
export function resetAuthHostConfig(): void {
  stashed = undefined;
  autoMounted = false;
}
