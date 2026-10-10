import type { HttpContext } from '@adonisjs/core/http';
import { PoppyError } from '../../agents/poppy/errors.js';
import { publicRequestUrl, writePoppyAuthError } from '../../agents/poppy/resource.js';
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
 * Endpoints server-to-server do Poppy (§3, §4): descoberta, metadata RFC 8414,
 * token, revogação, device authorization, Mediated Sign-In e a sessão de
 * navegador (§5). Todos isentos de CSRF — ver `authkitCsrfExceptions`.
 */
export default class PoppyController {
  /** `GET /.well-known/poppy.json` — só no domínio da empresa (ignorando `www.`). */
  async discovery(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy) return;
    const doc = poppy.discoveryDocument(ctx.request.hostname() ?? '');
    if (!doc) return ctx.response.notFound();
    ctx.response.header('Access-Control-Allow-Origin', '*');
    ctx.response.header('Cache-Control', 'public, max-age=300');
    return ctx.response.json(doc);
  }

  /** `GET /.well-known/oauth-authorization-server{prefix}` (RFC 8414 + `poppy_domains`). */
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
      const body = await poppy.token(form(ctx), ctx.request.header('dpop'));
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

  /** `POST auth.mediated.endpoint` (§4.7) — com o Session Token (DPoP). */
  async mediatedStart(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy?.cfg.signIn.mediated) return poppy ? ctx.response.notFound() : undefined;
    const auth = await poppy.verifyAccess({
      method: ctx.request.method(),
      url: publicRequestUrl(ctx, poppy),
      headers: ctx.request.headers() as Record<string, string | string[] | undefined>,
    });
    if (!auth.ok) {
      const { ok: _ok, ...rest } = auth;
      return writePoppyAuthError(ctx, { ok: false, ...rest });
    }
    try {
      const body = await poppy.mediatedStart(auth.principal, auth.jkt, ctx.request.body(), ctx);
      noStore(ctx);
      return ctx.response.json(body);
    } catch (error) {
      if (error instanceof PoppyError) return oauthError(ctx, error);
      throw error;
    }
  }

  /** `POST {mediated}/{sign_in_id}` (§4.7). */
  async mediatedCode(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy?.cfg.signIn.mediated) return poppy ? ctx.response.notFound() : undefined;
    const auth = await poppy.verifyAccess({
      method: ctx.request.method(),
      url: publicRequestUrl(ctx, poppy),
      headers: ctx.request.headers() as Record<string, string | string[] | undefined>,
    });
    if (!auth.ok) {
      const { ok: _ok, ...rest } = auth;
      return writePoppyAuthError(ctx, { ok: false, ...rest });
    }
    try {
      const body = await poppy.mediatedCode(
        auth.principal,
        auth.jkt,
        String(ctx.request.param('id') ?? ''),
        ctx.request.body(),
      );
      noStore(ctx);
      if (!body) {
        return ctx.response
          .status(404)
          .json({ error: 'invalid_request', error_description: 'Unknown sign_in_id' });
      }
      return ctx.response.json(body);
    } catch (error) {
      if (error instanceof PoppyError) return oauthError(ctx, error);
      throw error;
    }
  }

  /**
   * `POST web.browser_session_endpoint` (§5): asserção no corpo → cookie do app
   * para a Session e 303 para `return_to`; qualquer falha → 400, sem cookie.
   */
  async browserSession(ctx: HttpContext) {
    const poppy = await poppyOr404(ctx);
    if (!poppy?.cfg.web?.browserSession) return poppy ? ctx.response.notFound() : undefined;
    noStore(ctx);
    // A asserção vai NO CORPO, nunca na URL (§5).
    if (ctx.request.qs().assertion !== undefined) return badBrowserRequest(ctx);
    let result: Awaited<ReturnType<PoppyService['verifyBrowserAssertion']>>;
    try {
      result = await poppy.verifyBrowserAssertion(
        ctx.request.input('assertion'),
        new URL(publicRequestUrl(ctx, poppy)).origin,
      );
    } catch (error) {
      if (error instanceof PoppyError) return badBrowserRequest(ctx);
      throw error;
    }
    await loginPoppyBrowser(ctx, result);
    ctx.response.header('Location', result.returnTo);
    return ctx.response.status(303).send('');
  }
}

function badBrowserRequest(ctx: HttpContext) {
  ctx.response.header('Content-Type', 'text/html; charset=utf-8');
  return ctx.response
    .status(400)
    .send(
      '<!doctype html><html><head><meta charset="utf-8"><title>Bad request</title></head><body><h1>Invalid browser session request</h1></body></html>',
    );
}
