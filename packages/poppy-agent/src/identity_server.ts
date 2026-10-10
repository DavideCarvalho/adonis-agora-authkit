import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AgentIdentity } from './identity.js';
import { sleep } from './util.js';

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#7c3aed"/><text x="32" y="42" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#fff">P</text></svg>`;

const STATE_RE = /^[A-Za-z0-9_-]{8,128}$/;

export interface IdentityServerOptions {
  host?: string;
  port?: number;
  /**
   * Directory where Direct Sign-In callbacks are relayed as `{state}.json` (0600), so a
   * `poppy-agent signin` process can pick up a redirect received by `serve-identity`.
   */
  relayDir?: string;
  /** In-process callback hook (used when `signin` runs the server itself). */
  onCallback?: (params: URLSearchParams) => void;
  log?: (line: string) => void;
}

/**
 * Serves the agent's Client ID Metadata Document, JWKS (public keys only), logo, and the
 * Direct Sign-In redirect target, under the paths of `identity.baseUrl` (4.1).
 */
export async function startIdentityServer(
  identity: AgentIdentity,
  opts: IdentityServerOptions = {},
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const base = new URL(identity.baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const paths = {
    meta: new URL(identity.clientId).pathname,
    jwks: new URL(identity.jwksUri).pathname,
    callback: new URL(identity.redirectUri).pathname,
    logo: `${prefix}/logo.svg`,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const send = (
      status: number,
      type: string,
      body: string,
      extra: Record<string, string> = {},
    ) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    opts.log?.(`${req.method} ${url.pathname}`);
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(405, 'text/plain', 'method not allowed');
    if (url.pathname === paths.meta) {
      return send(200, 'application/json', JSON.stringify(identity.metadata(), null, 2), {
        'cache-control': 'public, max-age=300',
      });
    }
    if (url.pathname === paths.jwks) {
      return send(200, 'application/json', JSON.stringify(identity.jwks(), null, 2), {
        'cache-control': 'public, max-age=300',
      });
    }
    if (url.pathname === paths.logo) return send(200, 'image/svg+xml', LOGO_SVG);
    if (url.pathname === paths.callback) {
      const state = url.searchParams.get('state') ?? '';
      if (!STATE_RE.test(state)) return send(400, 'text/plain', 'invalid state');
      opts.onCallback?.(url.searchParams);
      if (opts.relayDir) {
        const dir = join(opts.relayDir, 'callbacks');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, `${state}.json`), url.searchParams.toString(), { mode: 0o600 });
      }
      const ok = !url.searchParams.get('error');
      return send(
        200,
        'text/html; charset=utf-8',
        `<!doctype html><meta charset="utf-8"><title>poppy-agent</title><p>${
          ok ? 'Sign-in received.' : 'Sign-in was not completed.'
        } You can close this tab and return to the terminal.</p>`,
        { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      );
    }
    send(404, 'text/plain', 'not found');
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Waits for a relayed callback file for `state` (written by `serve-identity`). */
export async function waitForRelayedCallback(
  relayDir: string,
  state: string,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<URLSearchParams> {
  const file = join(relayDir, 'callbacks', `${state}.json`);
  for (;;) {
    try {
      const raw = await readFile(file, 'utf8');
      await rm(file, { force: true });
      return new URLSearchParams(raw);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await sleep(opts.pollMs ?? 500, opts.signal);
  }
}
