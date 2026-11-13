import type { HttpContext } from '@adonisjs/core/http';
import {
  PROTECTED_RESOURCE_WELL_KNOWN,
  protectedResourceMetadata,
  servedProtectedResources,
} from '../mcp/mcp_oauth.js';

/**
 * Documento RFC 9728 de um protected resource declarado ao authkit (`oidcBearerGuard({ resource })`
 * e `mcp.resources`), em `/.well-known/oauth-protected-resource<path>`. É para onde o
 * `resource_metadata` do 401 aponta: o cliente OAuth/MCP lê o issuer daqui e abre o login.
 */
export default class ProtectedResourceMetadataController {
  async handle(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const { issuer, mcp } = service.config;
    const path = ctx.request.url().slice(PROTECTED_RESOURCE_WELL_KNOWN.length).replace(/\/+$/, '');
    const entry = servedProtectedResources({
      issuer,
      mcpResources: mcp?.enabled ? mcp.resources : [],
    }).find((r) => r.path === path);
    ctx.response.header('Access-Control-Allow-Origin', '*');
    if (!entry) return ctx.response.notFound({ error: 'not_found' });
    return ctx.response.json(
      protectedResourceMetadata({
        resource: entry.url ?? `${new URL(issuer).origin}${entry.path}`,
        issuer,
        scopes: entry.scopes,
        name: entry.name,
      }),
    );
  }
}
