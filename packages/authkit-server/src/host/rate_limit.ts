import type { HttpContext } from '@adonisjs/core/http';
import type { ResolvedRateLimitConfig } from '../define_config.js';
import { brandFor } from './branding.js';

/**
 * Assinatura mínima de um middleware do AdonisJS. Evita acoplar o tipo concreto
 * do `@adonisjs/limiter` (que pode não estar instalado no host).
 */
export type ThrottleMiddleware = (ctx: HttpContext, next: () => Promise<void>) => Promise<void>;

/**
 * Os throttles construídos para as rotas sensíveis do host-kit.
 * - `login`: compartilhado por login/signup/forgot/reset (keyed por IP).
 * - `introspection`: introspecção de PAT (keyed por IP ou pelo bearer secret).
 */
export interface AuthThrottles {
  login: ThrottleMiddleware;
  introspection: ThrottleMiddleware;
  /**
   * Throttle por IP do grupo admin-api (R6). Anti-brute-force REAL da Bearer key:
   * diferente do `introspection` (keyed pelo próprio token, então cada key tentada
   * cai em bucket distinto), este é keyed por `ctx.request.ip()` — limita o número
   * de tentativas vindas do MESMO IP independentemente de qual key foi usada (M8).
   */
  adminIp: ThrottleMiddleware;
  /**
   * Throttle das rotas dos métodos de sudo (`/account/confirm/*`), keyed por IP
   * como o `login` — e com os MESMOS limites — mas em bucket PRÓPRIO.
   *
   * A separação é o ponto: `login` mede um anônimo tentando adivinhar
   * credenciais, `sudo` mede um usuário já autenticado reprovando a própria
   * identidade. Ver `ResolvedRateLimitConfig.sudo` para o porquê de os dois
   * orçamentos não poderem se consumir.
   */
  sudo: ThrottleMiddleware;
  /**
   * Throttle da verificação de código OTP de login, keyed por IP em bucket
   * PRÓPRIO (`authkit_otp_login`) e mais apertado que o `login`. Primeira barreira
   * anti-brute-force do código adivinhável, ANTES do lockout por interaction.
   */
  otpLogin: ThrottleMiddleware;
}

/**
 * Service do `@adonisjs/limiter` resolvido de forma preguiçosa. Tipado como `any`
 * de propósito: a lib NÃO depende do limiter em tempo de compilação (peer/opt-in).
 */
type LimiterService = any;

let limiterServicePromise: Promise<LimiterService | null> | undefined;

/**
 * Importa o service do limiter do HOST de forma preguiçosa e fail-safe.
 * Se `@adonisjs/limiter` não estiver instalado/configurado, resolve `null`
 * e o throttle vira no-op (não quebra o boot nem a request).
 */
async function loadLimiter(): Promise<LimiterService | null> {
  if (!limiterServicePromise) {
    // Indireção via variável: o `@adonisjs/limiter` é peer/opcional e pode não
    // estar instalado na lib, então o specifier não é resolvido em build-time.
    const specifier = '@adonisjs/limiter/services/main';
    limiterServicePromise = import(specifier)
      .then((mod) => (mod as any).default ?? null)
      .catch(() => null);
  }
  return limiterServicePromise;
}

/**
 * Permite reapontar/limpar o loader do limiter (usado em testes).
 * @internal
 */
export function __setLimiterLoaderForTests(
  fn: (() => Promise<LimiterService | null>) | undefined,
): void {
  if (fn) {
    limiterServicePromise = fn();
  } else {
    limiterServicePromise = undefined;
  }
}

/**
 * Constrói um middleware de throttle preguiçoso. A configuração do limiter
 * (`allowRequests().every().usingKey()`) só é resolvida na primeira request,
 * porque o service do limiter é importado de forma assíncrona. Se o limiter
 * não existir, o middleware passa adiante sem throttle (fail-safe).
 */
function buildThrottle(
  name: string,
  bucket: { points: number; duration: string },
  store: string | undefined,
  keyOf?: (ctx: HttpContext) => string | undefined,
): ThrottleMiddleware {
  let middleware: ThrottleMiddleware | undefined;

  return async (ctx, next) => {
    if (!middleware) {
      const limiter = await loadLimiter();
      if (!limiter) {
        // Limiter indisponível: degrada para no-op (sem quebrar a request).
        middleware = async (_ctx, n) => n();
      } else {
        middleware = limiter.define(name, (reqCtx: HttpContext) => {
          let b = limiter.allowRequests(bucket.points).every(bucket.duration);
          if (store) b = b.store(store);
          const key = keyOf?.(reqCtx);
          if (key) b = b.usingKey(key);
          return b;
        }) as ThrottleMiddleware;
      }
    }
    return middleware(ctx, next);
  };
}

/**
 * Cria os throttles do host-kit a partir da config resolvida.
 * Retorna `undefined` quando rate-limit está desligado (rotas montadas sem throttle).
 */
export function createAuthThrottles(config: ResolvedRateLimitConfig): AuthThrottles | undefined {
  if (!config.enabled) return undefined;

  return {
    // Login/signup/forgot/reset: keyed por IP (default do HttpLimiter).
    // `friendly`: rota de BROWSER — 429 vira a tela themeável `throttled`
    // em vez do erro cru do limiter (ver `withFriendly429`).
    login: withFriendly429(buildThrottle('authkit_login', config.login, config.store)),
    // Introspecção de PAT: keyed pelo bearer secret quando presente, senão por IP.
    introspection: buildThrottle(
      'authkit_pat_introspection',
      config.introspection,
      config.store,
      (ctx) => {
        const auth = ctx.request.header('authorization');
        if (auth?.toLowerCase().startsWith('bearer ')) {
          return `bearer:${auth.slice(7).trim()}`;
        }
        return undefined;
      },
    ),
    // Admin-api por IP: anti-brute-force REAL da Bearer key (M8). Keyed por IP —
    // tentar muitas keys diferentes do mesmo IP cai no MESMO bucket, ao contrário
    // do `introspection` (bucket por token). Camada adicional, não substitui o
    // throttle de introspection nas rotas que o usam.
    adminIp: buildThrottle('authkit_admin_ip', config.adminIp, config.store, (ctx) => {
      return `admin-ip:${ctx.request.ip?.() ?? 'unknown'}`;
    }),
    // Rotas dos métodos de sudo: keyed por IP (default do HttpLimiter), igual ao
    // login. O que separa os dois é o NOME do bucket — o limiter namespaceia a
    // contagem por nome, então `authkit_login` e `authkit_sudo` nunca somam,
    // mesmo vindo do mesmo IP. Sem `usingKey` próprio de propósito: inventar uma
    // key aqui seria mudar o EIXO da contagem, e o eixo certo continua sendo o IP.
    sudo: withFriendly429(buildThrottle('authkit_sudo', config.sudo, config.store)),
    // Verificação de código OTP: keyed por IP (default), bucket próprio e mais
    // apertado que o login. O namespace do nome mantém a contagem separada.
    otpLogin: withFriendly429(buildThrottle('authkit_otp_login', config.otpLogin, config.store)),
  };
}

/**
 * Discriminador de "estourou o throttle" por DUCK-TYPING — o `@adonisjs/limiter`
 * é peer opcional, então a classe `ThrottleException` não é importável aqui. O
 * `code` é o identificador estável; o `status` é o fallback.
 */
function isThrottleExceeded(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown };
  return e.code === 'E_TOO_MANY_REQUESTS' || e.status === 429;
}

/** `response.availableIn` (segundos) da `LimiterResponse` embutida na exceção. */
function retryAfterSeconds(err: unknown): number | null {
  const availableIn = (err as { response?: { availableIn?: unknown } })?.response?.availableIn;
  return typeof availableIn === 'number' && availableIn > 0 ? Math.ceil(availableIn) : null;
}

/**
 * Embrulha um throttle de rota de BROWSER para trocar o 429 cru do limiter pela
 * tela themeável `throttled` (Edge built-in, ou a página React do host quando
 * listada no allowlist do `inertiaRenderer`).
 *
 * Antes deste wrapper, estourar o throttle no meio do login (ex.: cliques
 * repetidos no "Receber link mágico") cuspia um "Too many requests" sem marca,
 * sem marca de tempo e sem caminho de volta — o usuário ficava preso numa página
 * de erro morta. A tela mostra o `Retry-After` e linka de volta pro passo atual
 * (raiz da interaction quando há `uid`; a própria URL nas demais).
 *
 * Aplicado SÓ nos throttles de browser (`login`, `sudo`, `otpLogin`) —
 * `introspection`/`adminIp` servem APIs, onde o 429 cru (JSON/headers) é o
 * contrato correto.
 *
 * O `send` explícito com o guard `hasLazyBody` espelha o contrato de
 * `interaction_recovery.ts`: funciona tanto se o http-server usar o valor de
 * retorno quanto se o renderer já tiver escrito o body.
 */
export function withFriendly429(throttle: ThrottleMiddleware): ThrottleMiddleware {
  return async (ctx, next) => {
    try {
      await throttle(ctx, next);
    } catch (err) {
      if (!isThrottleExceeded(err)) throw err;
      const service = await (ctx as any).containerResolver.make('authkit.server');
      const cfg = service.config;
      const render = cfg.render as
        | ((ctx: HttpContext, view: string, props: Record<string, unknown>) => unknown)
        | undefined;
      if (!render) throw err; // Sem renderer configurado — mantém o 429 cru.

      const retryAfter = retryAfterSeconds(err);
      const uid = ctx.request.param('uid');
      const retryUrl = uid ? `/auth/interaction/${uid}` : ctx.request.url();
      const brand = cfg.branding ? brandFor(cfg.branding, undefined, undefined) : undefined;

      ctx.response.status(429);
      if (retryAfter) ctx.response.header('Retry-After', String(retryAfter));
      const body = await render(ctx, 'throttled', { brand, retryAfter, retryUrl });
      const res = ctx.response as any;
      if (body !== undefined && !res.hasLazyBody && body !== ctx.response) {
        res.send(body);
      }
      // Não retorna o body: a `ThrottleMiddleware` é `Promise<void>` e o `send`
      // explícito (com o guard `hasLazyBody` contra double-write) já entregou
      // a resposta — mesmo contrato de `interaction_recovery.ts`.
    }
  };
}
