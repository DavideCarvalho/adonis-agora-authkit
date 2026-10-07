import type { HttpContext } from '@adonisjs/core/http';
import type { PersonalAgentIdentity } from '../../agents/agent_identity.js';
import {
  AgentOAuthError,
  DEVICE_CODE_GRANT_TYPE,
  REFRESH_TOKEN_GRANT_TYPE,
} from '../../agents/delegation_service.js';
import { personalAgentUnauthorized } from '../../agents/middleware.js';
import { type PersonalAgentsRuntime, personalAgentsFor } from '../../agents/runtime.js';

function noStore(ctx: HttpContext) {
  ctx.response.header('Cache-Control', 'no-store');
  ctx.response.header('Pragma', 'no-cache');
}

function oauthError(ctx: HttpContext, error: AgentOAuthError) {
  noStore(ctx);
  return ctx.response
    .status(error.status)
    .json({ error: error.code, error_description: error.description });
}

/**
 * Authorization server de delegação para personal agents (PACT §5.3): metadata
 * RFC 8414, JWKS e os endpoints RFC 8628 que o AGENTE chama. O cliente OAuth é
 * o agente, autenticado pelo JWT dele em `Authorization: Bearer` em toda
 * chamada — `client_id` tem de ser o `iss` desse JWT.
 */
export default class AgentOAuthController {
  async metadata(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    if (!runtime?.delegation) return ctx.response.notFound();
    ctx.response.header('Access-Control-Allow-Origin', '*');
    return {
      issuer: runtime.urls.issuer,
      device_authorization_endpoint: runtime.urls.deviceAuthorization,
      token_endpoint: runtime.urls.token,
      jwks_uri: runtime.urls.jwks,
      scopes_supported: Object.keys(runtime.delegation.scopes),
      grant_types_supported: [DEVICE_CODE_GRANT_TYPE, REFRESH_TOKEN_GRANT_TYPE],
      response_types_supported: [],
      // Sem `token_endpoint_auth_methods_supported`: o agente se autentica com o
      // JWT dele em `Authorization: Bearer` (PACT §5.3), método sem nome
      // registrado — anunciar `private_key_jwt` levaria um cliente genérico a
      // mandar `client_assertion` e tomar 401.
    };
  }

  /** Chaves que assinam tokens de delegação e recibos — as mesmas do IdP. */
  async jwks(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    if (!runtime?.delegation) return ctx.response.notFound();
    const service = await ctx.containerResolver.make('authkit.server');
    ctx.response.header('Access-Control-Allow-Origin', '*');
    ctx.response.header('Cache-Control', 'public, max-age=300');
    return service.publicJwks;
  }

  async deviceAuthorization(ctx: HttpContext) {
    const auth = await this.#authenticate(ctx);
    if (!auth) return;
    try {
      const body = await auth.runtime.delegation!.requestDevice(
        auth.agent,
        ctx.request.input('scope'),
      );
      noStore(ctx);
      return ctx.response.json(body);
    } catch (error) {
      if (error instanceof AgentOAuthError) return oauthError(ctx, error);
      throw error;
    }
  }

  async token(ctx: HttpContext) {
    const auth = await this.#authenticate(ctx);
    if (!auth) return;
    const delegation = auth.runtime.delegation!;
    try {
      const grantType = ctx.request.input('grant_type');
      const body =
        grantType === DEVICE_CODE_GRANT_TYPE
          ? await delegation.exchangeDeviceCode(auth.agent, ctx.request.input('device_code'))
          : grantType === REFRESH_TOKEN_GRANT_TYPE
            ? await delegation.refresh(auth.agent, ctx.request.input('refresh_token'))
            : null;
      if (!body) {
        throw new AgentOAuthError('unsupported_grant_type', 'Unsupported grant_type');
      }
      noStore(ctx);
      return ctx.response.json(body);
    } catch (error) {
      if (error instanceof AgentOAuthError) return oauthError(ctx, error);
      throw error;
    }
  }

  /**
   * JWT do agente + `client_id` coerente. Já respondeu (401/404) quando
   * devolve `null`.
   */
  async #authenticate(
    ctx: HttpContext,
  ): Promise<{ runtime: PersonalAgentsRuntime; agent: PersonalAgentIdentity } | null> {
    const runtime = await personalAgentsFor(ctx);
    if (!runtime?.delegation) {
      ctx.response.notFound();
      return null;
    }
    const agent = await runtime.verifier.verify(ctx.request.header('authorization'));
    if (!agent) {
      personalAgentUnauthorized(ctx, runtime.config.protocol);
      return null;
    }
    if (ctx.request.input('client_id') !== agent.issuer) {
      oauthError(
        ctx,
        new AgentOAuthError(
          'invalid_client',
          'client_id must equal the personal-agent issuer',
          401,
        ),
      );
      return null;
    }
    return { runtime, agent };
  }
}
