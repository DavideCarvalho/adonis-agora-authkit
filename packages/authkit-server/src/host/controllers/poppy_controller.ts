import type { HttpContext } from '@adonisjs/core/http';
import { PoppyError } from '../../agents/poppy/errors.js';
import {
  type PoppyAuthResult,
  publicRequestUrl,
  writePoppyAuthError,
} from '../../agents/poppy/resource.js';
import type { PoppyService } from '../../agents/poppy/service.js';
import { loginPoppyBrowser } from '../../agents/poppy/web_session.js';
import { personalAgentsFor } from '../../agents/runtime.js';

function noStore(ctx: HttpContext) {
  ctx.response.header('Cache-Control', 'no-store');
  ctx.response.header('Pragma', 'no-cache');
}

function withNonce(ctx: HttpContext, poppy: PoppyService) {
  const nonce = poppy.nonce();
  if (nonce) ctx.response.header('DPoP-Nonce', nonce);
}

function oauthError(ctx: HttpContext, error: PoppyError) {
  noStore(ctx);
  for (const [k, v] of Object.entries(error.headers)) ctx.response.header(k, v);
  // Limite de taxa: 429 com `Retry-After`, sem corpo próprio (§5.6).
  if (error.status === 429) return ctx.response.status(429).send('');
  if (error.code === 'invalid_dpop_proof' || error.code === 'use_dpop_nonce') {
    ctx.response.header('WWW-Authenticate', `DPoP error="${error.code}"`);
  }
  return ctx.response.status(error.status).json(error.toJSON());
}

async function poppyOr404(ctx: HttpContext): Promise<PoppyService | null> {
  const poppy = (await personalAgentsFor(ctx))?.poppy ?? null;
  if (!poppy) ctx.response.notFound();
  return poppy;
}

/** Formulário (`application/x-www-form-urlencoded`) da request. */
function form(ctx: HttpContext): Record<string, unknown> {
  return ctx.request.all() as Record<string, unknown>;
}

/**
 * Endpoints do Poppy (§3, §4, §6): descoberta, protected resource metadata, metadata RFC 8414,
 * token, revogação, device authorization e a entrada do navegador na Session. Os POSTs são isentos
 * de CSRF — ver `authkitCsrfExceptions`.
 */
export default class PoppyController {
  /** `GET /.well-known/poppy.json` — só no domínio da empresa; `www.` redireciona para ele. */
  async discovery(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy) return;
    // `host()` mantém a porta (dev em `localhost:3333`): o `browser_session_endpoint` sai dele.
    const host = ctx.request.host() ?? ctx.request.hostname() ?? '';
    const redirect = poppy.discoveryRedirect(host);
    if (redirect) {
      ctx.response.header('Location', redirect);
      return ctx.response.status(308).send('');
    }
    const doc = poppy.discoveryDocument(host);
    if (!doc) return ctx.response.notFound();
    ctx.response.header('Access-Control-Allow-Origin', '*');
    ctx.response.header('Cache-Control', 'public, max-age=300');
    return ctx.response.json(doc);
  }

  /** `GET /.well-known/oauth-protected-resource` do domínio (§3.2, RFC 9728). */
  async protectedResource(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy) return;
    const doc = poppy.protectedResourceMetadata(ctx.request.host() ?? ctx.request.hostname() ?? '');
    if (!doc) return ctx.response.notFound();
    ctx.response.header('Access-Control-Allow-Origin', '*');
    ctx.response.header('Cache-Control', 'public, max-age=300');
    return ctx.response.json(doc);
  }

  /** `GET /.well-known/oauth-authorization-server{prefix}` (RFC 8414 + `protected_resources`). */
  async metadata(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy) return;
    ctx.response.header('Access-Control-Allow-Origin', '*');
    ctx.response.header('Cache-Control', 'public, max-age=300');
    return ctx.response.json(poppy.authorizationServerMetadata());
  }

  async token(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy) return;
    withNonce(ctx, poppy);
    try {
      const body = await poppy.token(form(ctx), ctx.request.header('dpop'), ctx);
      noStore(ctx);
      return ctx.response.json(body);
    } catch (error) {
      if (error instanceof PoppyError) return oauthError(ctx, error);
      throw error;
    }
  }

  async deviceAuthorization(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy) return;
    try {
      const body = await poppy.deviceAuthorization(form(ctx));
      noStore(ctx);
      return ctx.response.json(body);
    } catch (error) {
      if (error instanceof PoppyError) return oauthError(ctx, error);
      throw error;
    }
  }

  /** RFC 7009: 200 também para token desconhecido. */
  async revoke(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy) return;
    try {
      await poppy.revoke(form(ctx));
      noStore(ctx);
      return ctx.response.status(200).send('');
    } catch (error) {
      if (error instanceof PoppyError) return oauthError(ctx, error);
      throw error;
    }
  }

  /**
   * `GET web.browser_session_endpoint` (§6, passo 1): a página com o código de uso único e o cookie
   * que o prende a este navegador. Não mexe em Session nem nos outros cookies.
   */
  async browserSessionPage(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy?.cfg.web?.browserSession) return poppy ? ctx.response.notFound() : undefined;
    const { code, cookie, maxAge } = await poppy.startBrowserJoin();
    const name = joinCookieName(poppy);
    ctx.response.append(
      'Set-Cookie',
      `${name}=${cookie}; Path=/; Max-Age=${maxAge}; ${cookieSecure(poppy)}HttpOnly; SameSite=Strict`,
    );
    browserHeaders(ctx);
    // `code` só tem caracteres base64url; o `action` é o path do próprio endpoint.
    const action = new URL(poppy.urls.browserSession).pathname;
    return ctx.response
      .status(200)
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Connecting</title></head><body><form method="post" action="${action}"><input type="hidden" name="code" value="${code}"><button>Continue</button></form></body></html>`,
      );
  }

  /**
   * `POST {browser_session_endpoint}/authorize` (§6, passo 2): o agente autoriza o código, com o
   * header da Session e, se logado, o access token. 204; código inválido → 400 `invalid_request`.
   */
  async browserSessionAuthorize(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy?.cfg.web?.browserSession) return poppy ? ctx.response.notFound() : undefined;
    noStore(ctx);
    try {
      const result = await poppy.authorizeBrowserJoin(
        {
          method: ctx.request.method(),
          url: publicRequestUrl(ctx, poppy),
          headers: ctx.request.headers() as Record<string, string | string[] | undefined>,
        },
        (ctx.request.body() as Record<string, unknown>)?.code,
      );
      if (!result.ok)
        return writePoppyAuthError(ctx, result as Extract<PoppyAuthResult, { ok: false }>);
      return ctx.response.status(204).send('');
    } catch (error) {
      if (error instanceof PoppyError) {
        return ctx.response.status(400).json({ error: 'invalid_request' });
      }
      throw error;
    }
  }

  /**
   * `POST web.browser_session_endpoint` (§6, passo 3): o navegador submete o código → cookie do app
   * para a Session, limpa o cookie do passo 1 e redireciona para o site; falha → página de erro.
   */
  async browserSession(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy?.cfg.web?.browserSession) return poppy ? ctx.response.notFound() : undefined;
    browserHeaders(ctx);
    const name = joinCookieName(poppy);
    const result = await poppy.completeBrowserJoin(
      ctx.request.input('code'),
      readCookie(ctx.request.header('cookie'), name),
    );
    if (!result) return badBrowserRequest(ctx);
    await loginPoppyBrowser(ctx, result);
    ctx.response.append(
      'Set-Cookie',
      `${name}=; Path=/; Max-Age=0; ${cookieSecure(poppy)}HttpOnly; SameSite=Strict`,
    );
    ctx.response.header('Location', poppy.cfg.web.redirectTo);
    return ctx.response.status(303).send('');
  }
}

/** `__Host-` exige `Secure`; em dev com o issuer em http o cookie sai sem os dois. */
function joinCookieName(poppy: PoppyService): string {
  return new URL(poppy.urls.origin).protocol === 'https:' ? '__Host-poppy_join' : 'poppy_join';
}

function cookieSecure(poppy: PoppyService): string {
  return new URL(poppy.urls.origin).protocol === 'https:' ? 'Secure; ' : '';
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Sem cache, sem moldura e sem referência da página que abriu (§6, passo 1). */
function browserHeaders(ctx: HttpContext) {
  noStore(ctx);
  ctx.response.header('Content-Type', 'text/html; charset=utf-8');
  ctx.response.header('Content-Security-Policy', "frame-ancestors 'none'");
  ctx.response.header('Cross-Origin-Opener-Policy', 'same-origin');
  ctx.response.header('Referrer-Policy', 'no-referrer');
}

function badBrowserRequest(ctx: HttpContext) {
  return ctx.response
    .status(400)
    .send(
      '<!doctype html><html><head><meta charset="utf-8"><title>Bad request</title></head><body><h1>Invalid browser session request</h1></body></html>',
    );
}
