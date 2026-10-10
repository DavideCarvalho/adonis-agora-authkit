import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pickApi } from './api.js';
import type { CompanyClient } from './company.js';
import type { PoppyApiEntry } from './types.js';
import { wwwAuthError } from './util.js';

export interface McpConnection {
  client: Client;
  api: PoppyApiEntry;
  close(): Promise<void>;
}

/**
 * Connects to a listed MCP server over Streamable HTTP with a Bearer Session Token issued for
 * that server's `url` (4.3 "Bearer tokens", section 6). On `invalid_token` the token is
 * re-minted once and the request retried.
 */
export async function connectMcp(
  company: CompanyClient,
  apiIndex?: number,
): Promise<McpConnection> {
  const api = pickApi(company, 'mcp', apiIndex);
  // `resource` MUST be the MCP server's `url` from poppy.json (4.3).
  const resource = api.url;
  let token = await company.bearerFor(resource);
  const authedFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      const res = await company.http.fetch(input, { ...init, headers });
      const err = wwwAuthError(res.headers.get('www-authenticate'));
      if (res.status === 401 && attempt === 0 && (!err.error || err.error === 'invalid_token')) {
        token = await company.bearerFor(resource, true);
        continue;
      }
      return res;
    }
  };
  const transport = new StreamableHTTPClientTransport(new URL(api.url), { fetch: authedFetch });
  const client = new Client({ name: 'poppy-agent', version: '0.0.0' });
  await client.connect(transport);
  return { client, api, close: () => client.close() };
}
