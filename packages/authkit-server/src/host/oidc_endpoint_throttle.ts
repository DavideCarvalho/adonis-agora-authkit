import type { HttpContext } from '@adonisjs/core/http';
import type { ThrottleMiddleware } from './rate_limit.js';

/**
 * Os endpoints do oidc-provider que recebem POST de máquina SEM sessão: o client se
 * autentica (ou nem isso, no registro dinâmico aberto) no próprio corpo, então o IP é
 * o único eixo de throttle antes dele. Nomes de rota do oidc-provider — os paths saem
 * do provider (`pathFor`), nunca de uma lista fixa, então `routes` customizado e o
 * mount do issuer valem. Um endpoint cuja feature está desligada não existe no router
 * do provider e simplesmente fica de fora.
 *
 * FORA de propósito: `authorization` (browser), `userinfo` (Bearer), `jwks`/discovery
 * (documentos públicos), `end_session` e `code_verification` (telas de browser).
 */
export const OIDC_MACHINE_ROUTES = [
  'token',
  'registration',
  'device_authorization',
  'pushed_authorization_request',
  'revocation',
  'introspection',
  'backchannel_authentication',
] as const;

interface PathForProvider {
  pathFor(name: string): string;
}

const pathsByProvider = new WeakMap<object, Set<string>>();

/**
 * Os paths (com o mount do issuer) dos endpoints de máquina deste provider (uma
 * instância do `oidc-provider`; o tipo dele não declara `pathFor`, mas ele existe).
 */
export function oidcMachinePaths(provider: object): Set<string> {
  const cached = pathsByProvider.get(provider);
  if (cached) return cached;
  const paths = new Set<string>();
  const { pathFor } = provider as Partial<PathForProvider>;
  for (const name of OIDC_MACHINE_ROUTES) {
    try {
      if (typeof pathFor === 'function') paths.add(normalize(pathFor.call(provider, name)));
    } catch {
      // Feature desligada: a rota não existe no provider.
    }
  }
  pathsByProvider.set(provider, paths);
  return paths;
}

function normalize(path: string): string {
  const p = path.split('?')[0] ?? '';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Middleware do wildcard `${mount}/*`: aplica `throttle` só aos POSTs dos endpoints
 * de máquina do provider ({@link OIDC_MACHINE_ROUTES}); todo o resto passa direto.
 * O provider é lido por request (troca num reload de chaves; o cache é por instância).
 */
export function oidcMachineThrottle(throttle: ThrottleMiddleware): ThrottleMiddleware {
  return async (ctx: HttpContext, next) => {
    if (ctx.request.method() !== 'POST') return next();
    const service = await ctx.containerResolver.make('authkit.server');
    const provider = (service as { provider?: PathForProvider }).provider;
    if (!provider || typeof provider.pathFor !== 'function') return next();
    if (!oidcMachinePaths(provider).has(normalize(ctx.request.url()))) return next();
    return throttle(ctx, next);
  };
}
