import type { HttpContext } from '@adonisjs/core/http';

/**
 * Metadata do servidor de autorização no caminho da RFC 8414 §3.1: com o issuer em
 * `https://app/oidc`, o documento fica em `https://app/.well-known/oauth-authorization-server/oidc`
 * — onde os clientes MCP o procuram primeiro. O provider só o serve sob o próprio mount
 * (`/oidc/.well-known/...`); aqui a requisição é reescrita para lá.
 */
export default class AuthorizationServerMetadataController {
  async handle(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const req = ctx.request.request as any;
    const res = ctx.response.response;
    const issuerPath = new URL(service.config.issuer).pathname.replace(/\/+$/, '');
    req.url = `${issuerPath}/.well-known/oauth-authorization-server`;
    return new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      service.callback(req, res);
    });
  }
}
