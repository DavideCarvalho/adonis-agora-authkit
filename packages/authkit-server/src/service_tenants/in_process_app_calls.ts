/**
 * Calls between apps served in-process, for an app that runs authkit-server and not
 * authkit-client (e.g. the Agora Hub). The other Agora libs reach authkit through the
 * `authkit.client` container binding, structurally; when authkit-client is not registered,
 * authkit-server binds this facade under that name, with the same method names and shapes:
 *
 * - `appCallTokens().token(app)` / `.reset()`: a token for `urn:agora:app:<app>`, minted by this
 *   server's own token endpoint for this app's service client (`serviceTenants.apps.client`, or
 *   the service tenant whose `partition` is the app's name). Same checks as a remote request: the
 *   grant (`apps` on the client) decides, through the real `client_credentials` path (the
 *   provider's own request handler, called in memory: no port is opened);
 * - `appCallerVerifier().verifyToken(token)`: verifies a token addressed to this app with this
 *   server's own keys;
 * - `appKey()` / `publishAppKey()`: this server's own key directory table.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { OidcAdapter } from '../adapters/adapter_contract.js';
import { appKeysStoreOf, type PublicOkpJwk, validateAppKeys } from './app_keys.js';
import { isClientDisabled, serviceTenantOf } from './client_metadata.js';
import { APP_NAME_PATTERN, APP_RESOURCE_PREFIX } from './config.js';
import { AuthkitTenantVerifier } from './tenant_verifier.js';

/** The caller of an app-call token, as authkit-client's `AgoraCaller`. */
export interface InProcessAgoraCaller {
  app: string;
  capabilities: string[];
  environment?: string;
  clientId: string;
  expiresAt: number;
}

/** What the facade needs from the server (the `authkit.server` binding). */
export interface InProcessAuthkitServer {
  readonly config: {
    issuer: string;
    AdapterClass: unknown;
    schema: { connection?: string; name?: string };
    serviceTenants?: { apps?: { client?: string } };
  };
  readonly callback: (req: any, res: any) => void;
  readonly provider: unknown;
  readonly publicJwks: { keys: Record<string, any>[] };
}

interface LoggerLike {
  warn(obj: object, msg: string): void;
}

export interface InProcessAppCallsDeps {
  server: () => Promise<InProcessAuthkitServer>;
  /** `lucid.db`, for the key directory. */
  db: () => Promise<any>;
  /**
   * The names this app goes by, in order (package.json `name`, the same without its npm scope,
   * AdonisJS `appName`): the default service client is the service tenant whose `partition` is
   * one of them.
   */
  appNames: string[];
  logger?: LoggerLike;
}

/**
 * Misconfiguration of the in-process app calls: names the exact line to add. The message never
 * ends with a period: the libs quote it inside their own sentence (`…: <reason>. To attach it…`).
 */
export class InProcessAppCallsError extends Error {
  constructor(message: string) {
    super(message.replace(/\.+$/, ''));
    this.name = 'InProcessAppCallsError';
  }
}

interface SelfClient {
  clientId: string;
  clientSecret: string;
  authMethod: string;
  partition: string;
}

/** Refresh a cached token this long before it expires. */
const EXPIRY_SKEW_MS = 30_000;

export class InProcessAppCalls {
  #deps: InProcessAppCallsDeps;
  #self: Promise<SelfClient> | undefined;
  #tokens = new Map<string, { token: string; expiresAt: number }>();
  #pending = new Map<string, Promise<string>>();
  #verifier: AuthkitTenantVerifier | undefined;

  constructor(deps: InProcessAppCallsDeps) {
    this.#deps = deps;
  }

  /** The adapter of the `Client` model (raw: sees authkit's own keys). */
  async #clients(): Promise<OidcAdapter> {
    const server = await this.#deps.server();
    return new (server.config.AdapterClass as any)('Client') as OidcAdapter;
  }

  /** This app's service client, resolved once (a failure is retried on the next call). */
  #selfClient(): Promise<SelfClient> {
    this.#self ??= this.#resolveSelf().catch((error) => {
      this.#self = undefined;
      throw error;
    });
    return this.#self;
  }

  async #resolveSelf(): Promise<SelfClient> {
    const server = await this.#deps.server();
    const configured = server.config.serviceTenants?.apps?.client;
    const adapter = await this.#clients();
    const line = `serviceTenants: { apps: { client: '<this app's service client id>' } }`;
    let found: { id: string; payload: Record<string, unknown> } | undefined;
    if (configured) {
      const payload = (await adapter.find(configured)) as Record<string, unknown> | undefined;
      if (!payload) {
        throw new InProcessAppCallsError(
          `authkit: serviceTenants.apps.client is "${configured}", but no such client exists. Create it as a service tenant (node ace authkit:client) or fix the id in config/authkit.ts`,
        );
      }
      found = { id: configured, payload };
    } else if (typeof adapter.list === 'function') {
      const tenants = (await adapter.list())
        .map((row) => ({ id: row.id, payload: row.payload as Record<string, unknown> }))
        .filter((row) => !isClientDisabled(row.payload) && serviceTenantOf(row.payload));
      const names = this.#deps.appNames;
      // 1) the service tenant named after this app (first name that matches wins).
      for (const name of names) {
        const byName = tenants.filter((t) => serviceTenantOf(t.payload)!.partition === name);
        if (byName.length > 1) {
          throw new InProcessAppCallsError(
            `authkit: several service clients have partition "${name}" (${byName.map((m) => m.id).join(', ')}). Pick the one this app calls other apps with: add ${line} to config/authkit.ts`,
          );
        }
        if (byName[0]) {
          found = byName[0];
          break;
        }
      }
      // 2) otherwise the only service tenant granted other apps (the one this server's own app,
      //    e.g. the Hub's consoles, calls them with).
      if (!found) {
        const callers = tenants.filter(
          (t) => Object.keys(serviceTenantOf(t.payload)!.apps ?? {}).length > 0,
        );
        if (callers.length > 1) {
          throw new InProcessAppCallsError(
            `authkit: this app calls other apps in-process, but no service client has its name as partition (${names.map((n) => `"${n}"`).join(', ')}) and several are granted other apps (${callers.map((c) => c.id).join(', ')}). Pick this app's: add ${line} to config/authkit.ts`,
          );
        }
        found = callers[0];
      }
    }
    if (!found) {
      throw new InProcessAppCallsError(
        `authkit: this app calls other apps in-process (an Agora lib asked authkit for an app-call token or verifier), but it has no service client. Create a service tenant with partition "${this.#deps.appNames[0] ?? 'this-app'}" and grant it the apps it calls (node ace authkit:client), or add ${line} to config/authkit.ts`,
      );
    }
    const tenant = serviceTenantOf(found.payload);
    if (!tenant || isClientDisabled(found.payload)) {
      throw new InProcessAppCallsError(
        `authkit: serviceTenants.apps.client "${found.id}" is not an enabled service tenant. Make it one in the admin console (Clients → service tenant) or pick another client`,
      );
    }
    const secret = found.payload.client_secret;
    const authMethod = String(found.payload.token_endpoint_auth_method ?? 'client_secret_basic');
    if (
      typeof secret !== 'string' ||
      !secret ||
      (authMethod !== 'client_secret_basic' && authMethod !== 'client_secret_post')
    ) {
      throw new InProcessAppCallsError(
        `authkit: the service client "${found.id}" must authenticate with a client secret (client_secret_basic or client_secret_post) to mint app-call tokens in-process`,
      );
    }
    return { clientId: found.id, clientSecret: secret, authMethod, partition: tenant.partition };
  }

  /** `authkit.client`'s token source for calls between apps. */
  appCallTokens(): { token(app: string): Promise<string>; reset(): void } {
    return {
      token: (app: string) => this.#token(app),
      reset: () => {
        this.#tokens.clear();
      },
    };
  }

  async #token(app: string): Promise<string> {
    if (!APP_NAME_PATTERN.test(String(app))) {
      throw new InProcessAppCallsError(`authkit: "${app}" is not a valid app name`);
    }
    const cached = this.#tokens.get(app);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;
    let pending = this.#pending.get(app);
    if (!pending) {
      pending = this.#mint(app).finally(() => this.#pending.delete(app));
      this.#pending.set(app, pending);
    }
    return pending;
  }

  /**
   * Runs a real `client_credentials` request through this server's own request handler (the one
   * the HTTP routes use), in memory: the grant, the claims, the audit and the throttle are exactly
   * those of a remote request from 127.0.0.1, and no port is opened.
   */
  async #mint(app: string): Promise<string> {
    const [server, self] = await Promise.all([this.#deps.server(), this.#selfClient()]);
    const tokenPath = (server.provider as { pathFor(name: string): string }).pathFor('token');
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      resource: `${APP_RESOURCE_PREFIX}${app}`,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (self.authMethod === 'client_secret_post') {
      body.set('client_id', self.clientId);
      body.set('client_secret', self.clientSecret);
    } else {
      const basic = `${encodeURIComponent(self.clientId)}:${encodeURIComponent(self.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
    }
    const issuer = new URL(server.config.issuer);
    headers.host = issuer.host;
    headers['x-forwarded-proto'] = issuer.protocol.replace(':', '');
    headers['x-forwarded-host'] = issuer.host;

    const res = await dispatchInMemory(server.callback, {
      method: 'POST',
      url: tokenPath,
      headers,
      body: body.toString(),
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      // not JSON: the status says what happened
    }
    if (res.status < 200 || res.status >= 300 || typeof json.access_token !== 'string') {
      const reason = [json.error, json.error_description].filter(Boolean).join(': ');
      throw new InProcessAppCallsError(
        `authkit: could not get an app-call token for "${app}" as "${self.partition}" (${reason || `HTTP ${res.status}`}).${json.error === 'invalid_target' ? ` Grant it: node ace authkit:client grant-app ${self.clientId} ${app} <capabilities> (or in the admin console)` : ''}`,
      );
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 60;
    this.#tokens.set(app, { token: json.access_token, expiresAt: Date.now() + expiresIn * 1000 });
    return json.access_token;
  }

  /** Verifies app-call tokens addressed to this app (`urn:agora:app:<partition>`), locally. */
  appCallerVerifier(): {
    verifyToken(token: string): Promise<InProcessAgoraCaller | null>;
  } {
    return { verifyToken: (token: string) => this.#verify(token) };
  }

  async #verify(token: string): Promise<InProcessAgoraCaller | null> {
    if (typeof token !== 'string' || !token) return null;
    const self = await this.#selfClient();
    this.#verifier ??= new AuthkitTenantVerifier({
      audience: `${APP_RESOURCE_PREFIX}${self.partition}`,
      issuer: () => this.#deps.server() as any,
    });
    const verified = await this.#verifier.verify({ token });
    if (!verified) return null;
    return {
      app: verified.partition,
      capabilities: verified.capabilities,
      ...(verified.environment ? { environment: verified.environment } : {}),
      clientId: verified.clientId,
      expiresAt: verified.expiresAt,
    };
  }

  async #store() {
    const server = await this.#deps.server();
    return appKeysStoreOf(server as any, this.#deps.db);
  }

  /** Another app's current public key for `purpose` in this server's directory, or `null`. */
  async appKey(input: { app: string; purpose: string }): Promise<PublicOkpJwk | null> {
    const store = await this.#store();
    const entry = store ? await store.find(input.app, input.purpose) : null;
    return entry?.keys[0] ?? null;
  }

  /**
   * Publishes one of this app's public keys in this server's directory (for this app's
   * `partition`). Never rejects: a refusal or a failure is logged.
   */
  async publishAppKey(input: { purpose: string; jwk: PublicOkpJwk }): Promise<void> {
    try {
      const keys = validateAppKeys([{ purpose: input?.purpose, jwk: input?.jwk }]);
      if (!(keys instanceof Map)) {
        this.#deps.logger?.warn(
          { purpose: input?.purpose },
          `authkit: publishAppKey: ${keys.error}; not published`,
        );
        return;
      }
      const [self, store] = await Promise.all([this.#selfClient(), this.#store()]);
      if (!store) {
        this.#deps.logger?.warn(
          { purpose: input.purpose },
          'authkit: publishAppKey: no database (lucid.db) for the key directory; not published',
        );
        return;
      }
      await store.put(self.partition, keys);
    } catch (error) {
      this.#deps.logger?.warn(
        { err: error, purpose: input?.purpose },
        `authkit: publishAppKey failed: ${(error as Error)?.message ?? error}`,
      );
    }
  }
}

/** Longest an in-memory request may take before it is abandoned. */
const DISPATCH_TIMEOUT_MS = 30_000;

/**
 * Runs one request through a Node request handler (`(req, res) => void`) without a socket: the
 * request body is pushed into an {@link IncomingMessage}, and what the handler writes to its
 * {@link ServerResponse} is collected. The connection looks like a loopback one (127.0.0.1).
 */
export function dispatchInMemory(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  input: { method: string; url: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const socket = new Socket();
  for (const [name, value] of [
    ['remoteAddress', '127.0.0.1'],
    ['remotePort', 0],
    ['remoteFamily', 'IPv4'],
  ] as const) {
    Object.defineProperty(socket, name, { value, configurable: true });
  }
  const payload = Buffer.from(input.body);
  const req = new IncomingMessage(socket);
  req.method = input.method;
  req.url = input.url;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  const headers: Record<string, string> = {
    ...input.headers,
    'content-length': String(payload.length),
  };
  for (const [name, value] of Object.entries(headers)) {
    req.headers[name.toLowerCase()] = value;
    req.rawHeaders.push(name, value);
  }
  req.push(payload);
  req.push(null);

  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const collect = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(
            chunk as string,
            typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8',
          ),
    );
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('authkit: the in-process token request did not answer'));
    }, DISPATCH_TIMEOUT_MS);
    timer.unref?.();
    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      collect(chunk, encoding);
      const cb = [encoding, callback].find((c) => typeof c === 'function') as
        | (() => void)
        | undefined;
      cb?.();
      return true;
    }) as ServerResponse['write'];
    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      collect(chunk, encoding);
      clearTimeout(timer);
      const cb = [chunk, encoding, callback].find((c) => typeof c === 'function') as
        | (() => void)
        | undefined;
      Object.defineProperty(res, 'writableEnded', { value: true, configurable: true });
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      cb?.();
      res.emit('finish');
      res.emit('close');
      return res;
    }) as ServerResponse['end'];
    try {
      handler(req, res);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

interface ContainerAppLike {
  appName: string;
  /** The app root (where package.json is). */
  appRoot?: URL;
  container: {
    hasBinding(name: string): boolean;
    singleton(name: string, factory: () => Promise<unknown>): void;
    make(name: string): Promise<any>;
  };
}

/**
 * Binds {@link InProcessAppCalls} as `authkit.client` unless something already is (authkit-client
 * binds it in `register()`, so when it is installed it wins). `true` when this bound it.
 */
export function bindInProcessAppCalls(app: ContainerAppLike): boolean {
  if (app.container.hasBinding('authkit.client')) return false;
  let facade: InProcessAppCalls | undefined;
  app.container.singleton('authkit.client', async () => {
    facade ??= new InProcessAppCalls({
      server: async () => (await app.container.make('authkit.server')) as InProcessAuthkitServer,
      db: () => app.container.make('lucid.db'),
      appNames: await appNamesOf(app),
      logger: {
        warn: (obj, msg) => {
          void app.container
            .make('logger')
            .then((logger: LoggerLike) => logger.warn(obj, msg))
            .catch(() => {});
        },
      },
    });
    return facade;
  });
  return true;
}

/**
 * The names this app goes by: package.json `name` (`@acme/hub`), the same without its npm scope
 * (`hub`), and AdonisJS `appName` (which is `adonisjs_app` for a scoped package). Deduplicated, in
 * that order.
 */
export async function appNamesOf(
  app: Pick<ContainerAppLike, 'appName' | 'appRoot'>,
): Promise<string[]> {
  const names: string[] = [];
  if (app.appRoot) {
    try {
      const { readFile } = await import('node:fs/promises');
      const pkg = JSON.parse(await readFile(new URL('package.json', app.appRoot), 'utf8')) as {
        name?: unknown;
      };
      if (typeof pkg.name === 'string' && pkg.name) {
        names.push(pkg.name);
        const unscoped = pkg.name.replace(/^@[^/]+\//, '');
        names.push(unscoped);
      }
    } catch {
      // no readable package.json: appName only
    }
  }
  if (app.appName) names.push(app.appName);
  return [...new Set(names)];
}
