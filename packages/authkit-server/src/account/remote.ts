import {
  ACCOUNT_EXTENSION_CONTRACT,
  ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT,
  ACCOUNT_EXTENSIONS_SCOPE,
  ACCOUNT_EXTENSIONS_TOKEN_TYP,
  ACCOUNT_EXTENSIONS_WELL_KNOWN,
  ACCOUNT_EXTENSIONS_WIRE_VERSION,
  ACCOUNT_RESERVED_SEGMENTS,
  ACCOUNT_SEGMENT,
  type AccountAction,
  type AccountActionResult,
  type AccountExtension,
  type AccountExtensionContext,
  type AccountExtensionOverride,
  type AccountExtensionsManifest,
  type AccountPage,
  type AccountPageView,
  accountExtensionsBodyHash,
  type RemoteCall,
  type RemoteExtensionManifest,
  validateAccountExtension,
} from '@adonis-agora/authkit-core';
import { importJWK, SignJWT } from 'jose';
import type { RegisteredAccountPage } from './registry.js';

/**
 * One app that signs in through this IdP and contributes account console pages
 * (`accountConsole.remote` in `config/authkit.ts`).
 */
export interface RemoteAccountExtensionSource {
  /** The app's OIDC client id: the `aud` of every token this IdP sends it. */
  clientId: string;
  /** Base URL the app serves `/.well-known/agora-account-extensions` under (`https://app.example.com`). */
  url: string;
  /** How long a fetched manifest is reused, in ms. Default 300 000 (5 min). */
  ttlMs?: number;
  /** Budget of one call to the app, in ms. Default 5000 (actions: `actionTimeoutMs`). */
  timeoutMs?: number;
}

/** Where the IdP's issuer and signing keys come from (the OIDC service; read on every call). */
export interface RemoteSigningSource {
  issuer: string;
  signingJwks: { keys: Record<string, any>[] };
}

export interface RemoteAccountExtensionsDeps {
  signing: () => RemoteSigningSource | Promise<RemoteSigningSource>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Same-origin path of a page segment (`billing` → `/account/billing`). */
  pathOf: (segment: string) => string;
  actionTimeoutMs?: number;
}

const SIGNING_ALGS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);

function algOf(jwk: Record<string, any>): string | null {
  if (typeof jwk.alg === 'string') return SIGNING_ALGS.has(jwk.alg) ? jwk.alg : null;
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  if (jwk.kty === 'EC' && jwk.crv === 'P-384') return 'ES384';
  if (jwk.kty === 'OKP') return 'EdDSA';
  return null;
}

/** Signs a remote-extension token with the IdP's current signing key. */
export async function signRemoteExtensionToken(
  signing: RemoteSigningSource,
  claims: { audience: string; subject: string; bodyHash?: string; ttlSec?: number; now?: number },
): Promise<string> {
  const jwk = signing.signingJwks.keys.find((key) => algOf(key) !== null && key.d !== undefined);
  if (!jwk) throw new Error('authkit: no signing key can sign remote account extension tokens.');
  const alg = algOf(jwk) as string;
  const key = await importJWK(jwk, alg);
  const iat = Math.floor((claims.now ?? Date.now()) / 1000);
  const payload: Record<string, unknown> = {
    scope: ACCOUNT_EXTENSIONS_SCOPE,
    jti: crypto.randomUUID(),
  };
  if (claims.bodyHash !== undefined) payload.bh = claims.bodyHash;
  return new SignJWT(payload)
    .setProtectedHeader({
      alg,
      typ: ACCOUNT_EXTENSIONS_TOKEN_TYP,
      ...(typeof jwk.kid === 'string' ? { kid: jwk.kid } : {}),
    })
    .setIssuer(signing.issuer)
    .setAudience(claims.audience)
    .setSubject(claims.subject)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (claims.ttlSec ?? 60))
    .sign(key);
}

/** Thrown when an app answers a call with an error or cannot be reached. */
export class RemoteAccountExtensionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RemoteAccountExtensionError';
  }
}

interface Entry {
  source: RemoteAccountExtensionSource;
  extensions: AccountExtension[];
  fetchedAt: number;
  /** Bumped on every manifest change, to recompute the served pages. */
  version: number;
  inflight: Promise<void> | null;
  retryAt: number;
}

function baseUrl(source: RemoteAccountExtensionSource): string {
  return `${source.url.replace(/\/+$/, '')}${ACCOUNT_EXTENSIONS_WELL_KNOWN}`;
}

function validSource(source: RemoteAccountExtensionSource, production: boolean): string | null {
  if (!source || typeof source.clientId !== 'string' || source.clientId === '') {
    return 'needs a clientId';
  }
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return `has an invalid url "${String(source.url)}"`;
  }
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) {
    return `url "${source.url}" must be https`;
  }
  return null;
}

/**
 * The remote account extensions of this IdP: fetches each app's manifest (cached for `ttlMs`,
 * refreshed in the background), turns it into extensions whose `visible`, `load` and actions call
 * the app, and serves their pages next to the in-process ones. An app that is down keeps its last
 * manifest (its pages then show the load-failure notice) or, never reached, contributes nothing.
 */
export class RemoteAccountExtensions {
  readonly #entries: Entry[];
  readonly #deps: RemoteAccountExtensionsDeps;
  readonly #visible = new WeakMap<object, Map<string, Promise<Set<string>>>>();
  readonly #warned = new Set<string>();
  #pagesKey = '';
  #pages: RegisteredAccountPage[] = [];

  constructor(
    sources: readonly RemoteAccountExtensionSource[],
    deps: RemoteAccountExtensionsDeps & { production?: boolean },
  ) {
    this.#deps = deps;
    const seen = new Set<string>();
    this.#entries = [];
    for (const source of sources) {
      const problem = validSource(source, deps.production === true);
      if (problem) {
        throw new Error(`authkit: accountConsole.remote entry ${problem}.`);
      }
      if (seen.has(source.clientId)) {
        throw new Error(
          `authkit: accountConsole.remote lists the client "${source.clientId}" twice.`,
        );
      }
      seen.add(source.clientId);
      this.#entries.push({
        source,
        extensions: [],
        fetchedAt: 0,
        version: 0,
        inflight: null,
        retryAt: 0,
      });
    }
  }

  get size(): number {
    return this.#entries.length;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #log(message: string): void {
    (this.#deps.log ?? ((m: string) => console.error(m)))(message);
  }

  /** Fetches every manifest now; resolves when all settled or after `timeoutMs`. */
  async start(timeoutMs = 3000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(this.#entries.map((entry) => this.#refresh(entry))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** Starts a background refresh of every stale manifest (never awaits, never throws). */
  #refreshStale(): void {
    const now = this.#now();
    for (const entry of this.#entries) {
      const ttl = entry.source.ttlMs ?? 300_000;
      if (entry.inflight || now < entry.retryAt) continue;
      if (entry.fetchedAt !== 0 && now - entry.fetchedAt < ttl) continue;
      void this.#refresh(entry);
    }
  }

  #refresh(entry: Entry): Promise<void> {
    if (entry.inflight) return entry.inflight;
    entry.inflight = (async () => {
      try {
        const manifest = await this.#fetchManifest(entry.source);
        entry.extensions = this.#toExtensions(entry.source, manifest);
        entry.fetchedAt = this.#now();
        entry.version += 1;
        entry.retryAt = 0;
      } catch (error) {
        // Keep the last good manifest; try again in 30 s.
        entry.retryAt = this.#now() + 30_000;
        this.#log(
          `authkit: remote account extensions of "${entry.source.clientId}" could not be fetched: ${(error as Error).message}`,
        );
      } finally {
        entry.inflight = null;
      }
    })();
    return entry.inflight;
  }

  async #request(
    source: RemoteAccountExtensionSource,
    init: { subject: string; body?: string; timeoutMs: number },
  ): Promise<unknown> {
    const signing = await this.#deps.signing();
    const token = await signRemoteExtensionToken(signing, {
      audience: source.clientId,
      subject: init.subject,
      ...(init.body !== undefined ? { bodyHash: accountExtensionsBodyHash(init.body) } : {}),
      now: this.#now(),
    });
    const doFetch = this.#deps.fetch ?? fetch;
    const response = await doFetch(baseUrl(source), {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        typeof (payload as any)?.error?.message === 'string'
          ? (payload as any).error.message
          : `HTTP ${response.status}`;
      throw new RemoteAccountExtensionError(message, response.status);
    }
    return payload;
  }

  async #fetchManifest(source: RemoteAccountExtensionSource): Promise<AccountExtensionsManifest> {
    const payload = (await this.#request(source, {
      subject: ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT,
      timeoutMs: source.timeoutMs ?? 5000,
    })) as Partial<AccountExtensionsManifest> | null;
    if (
      !payload ||
      payload.version !== ACCOUNT_EXTENSIONS_WIRE_VERSION ||
      !Array.isArray(payload.extensions)
    ) {
      throw new Error('the manifest is not a version 1 account extensions manifest');
    }
    return payload as AccountExtensionsManifest;
  }

  /** Builds proxy extensions from a manifest; an invalid extension is skipped and logged. */
  #toExtensions(
    source: RemoteAccountExtensionSource,
    manifest: AccountExtensionsManifest,
  ): AccountExtension[] {
    const out: AccountExtension[] = [];
    for (const remote of manifest.extensions as RemoteExtensionManifest[]) {
      const extension: AccountExtension = {
        id: remote?.id,
        contract: Math.min(remote?.contract ?? 1, ACCOUNT_EXTENSION_CONTRACT),
        messages: remote?.messages ?? {},
        scriptOrigins: Array.isArray(remote?.scriptOrigins) ? remote.scriptOrigins : [],
        pages: (Array.isArray(remote?.pages) ? remote.pages : []).map((page) =>
          this.#toPage(source, page),
        ),
      };
      try {
        if (typeof remote?.contract === 'number' && remote.contract > ACCOUNT_EXTENSION_CONTRACT) {
          throw new Error(
            `"${remote.id}" was written against contract ${remote.contract}; this authkit implements ${ACCOUNT_EXTENSION_CONTRACT}.`,
          );
        }
        validateAccountExtension(extension);
        out.push(extension);
      } catch (error) {
        this.#log(
          `authkit: remote account extension from "${source.clientId}" skipped: ${(error as Error).message}`,
        );
      }
    }
    return out;
  }

  #call(source: RemoteAccountExtensionSource, call: RemoteCall, timeoutMs: number) {
    const body = JSON.stringify(call);
    return this.#request(source, { subject: call.account.id, body, timeoutMs });
  }

  #base(source: RemoteAccountExtensionSource, ctx: AccountExtensionContext) {
    const urls: Record<string, string> = {};
    for (const page of this.#pages) {
      if (page.remote === source.clientId) urls[page.page.id] = this.#deps.pathOf(page.segment);
    }
    return {
      account: {
        id: ctx.account.id,
        email: ctx.account.email,
        name: ctx.account.name,
        roles: [...ctx.account.roles],
      },
      activeOrg: ctx.activeOrg,
      tenant: ctx.tenant ?? null,
      impersonatedBy: ctx.impersonatedBy,
      locale: ctx.locale,
      urls,
    };
  }

  /** The visible conditional pages of `source` for this account, once per request. */
  #visibleSet(source: RemoteAccountExtensionSource, ctx: AccountExtensionContext) {
    const key = ctx.account as object;
    let perRequest = this.#visible.get(key);
    if (!perRequest) {
      perRequest = new Map();
      this.#visible.set(key, perRequest);
    }
    let decided = perRequest.get(source.clientId);
    if (!decided) {
      const pageIds = this.#pages
        .filter((page) => page.remote === source.clientId && page.page.visible)
        .map((page) => page.page.id);
      decided = (async () => {
        try {
          const payload = (await this.#call(
            source,
            { ...this.#base(source, ctx), op: 'visible', pageIds },
            source.timeoutMs ?? 5000,
          )) as { visible?: unknown };
          return new Set(
            Array.isArray(payload?.visible)
              ? payload.visible.filter((id): id is string => typeof id === 'string')
              : [],
          );
        } catch (error) {
          // The app cannot answer: keep its pages listed, so each shows the "could not be
          // loaded" notice instead of vanishing (a page body never loads without the app).
          this.#log(
            `authkit: remote account extensions of "${source.clientId}" did not answer visible(): ${(error as Error).message}`,
          );
          return new Set(pageIds);
        }
      })();
      perRequest.set(source.clientId, decided);
    }
    return decided;
  }

  #toPage(source: RemoteAccountExtensionSource, remote: any): AccountPage {
    const pageId = String(remote?.id);
    const actions: Record<string, AccountAction> = {};
    for (const [name, action] of Object.entries((remote?.actions ?? {}) as Record<string, any>)) {
      actions[name] = {
        label: action?.label ?? name,
        tone: action?.tone === 'danger' ? 'danger' : 'default',
        ...(action?.confirm ? { confirm: action.confirm } : {}),
        sudo: action?.sudo === true,
        fields: Array.isArray(action?.fields) ? action.fields : [],
        handle: async (ctx, input) => {
          const payload = (await this.#call(
            source,
            {
              ...this.#base(source, ctx),
              op: 'action',
              pageId,
              action: name,
              query: ctx.query,
              input,
            },
            this.#deps.actionTimeoutMs ?? 15_000,
          )) as { result?: AccountActionResult };
          if (!payload?.result || typeof payload.result.ok !== 'boolean') {
            throw new Error('the app answered the action without a result');
          }
          return payload.result;
        },
      };
    }
    return {
      id: pageId,
      segment: String(remote?.segment),
      title: remote?.title ?? pageId,
      nav: remote?.nav === false ? false : (remote?.nav ?? {}),
      ...(remote?.conditional === true
        ? {
            visible: async (ctx: AccountExtensionContext) =>
              (await this.#visibleSet(source, ctx)).has(pageId),
          }
        : {}),
      load: async (ctx) => {
        const payload = (await this.#call(
          source,
          { ...this.#base(source, ctx), op: 'load', pageId, query: ctx.query },
          source.timeoutMs ?? 5000,
        )) as { view?: AccountPageView };
        if (!payload?.view || !Array.isArray(payload.view.blocks)) {
          throw new Error('the app answered the page without a view');
        }
        return payload.view;
      },
      actions,
    };
  }

  /** Every remote extension currently known (for the message catalogs). */
  extensions(): AccountExtension[] {
    return this.#entries.flatMap((entry) => entry.extensions);
  }

  /**
   * The remote pages to serve now, after host overrides, minus any whose segment collides with a
   * built-in screen, an in-process page or an earlier app (skipped and logged once).
   */
  pages(context: {
    taken: ReadonlySet<string>;
    /** Ids of the in-process extensions. */
    takenIds: ReadonlySet<string>;
    overrides?: Readonly<Record<string, AccountExtensionOverride>>;
  }): readonly RegisteredAccountPage[] {
    this.#refreshStale();
    const key = this.#entries.map((e) => e.version).join(',');
    if (key === this.#pagesKey) return this.#pages;
    const used = new Set(context.taken);
    const usedIds = new Set(context.takenIds);
    const out: RegisteredAccountPage[] = [];
    for (const entry of this.#entries) {
      for (const extension of entry.extensions) {
        const override = context.overrides?.[extension.id];
        if (override === false) continue;
        if (usedIds.has(extension.id)) {
          this.#warnOnce(
            `${entry.source.clientId}:${extension.id}`,
            `authkit: remote account extension "${extension.id}" from "${entry.source.clientId}" is skipped: the id is already used.`,
          );
          continue;
        }
        usedIds.add(extension.id);
        for (const page of extension.pages) {
          const pageOverride = override ? override.pages?.[page.id] : undefined;
          if (pageOverride === false) continue;
          const segment = pageOverride?.segment ?? page.segment;
          if (
            !ACCOUNT_SEGMENT.test(segment) ||
            ACCOUNT_RESERVED_SEGMENTS.has(segment) ||
            used.has(segment)
          ) {
            this.#warnOnce(
              `${entry.source.clientId}:${page.id}:${segment}`,
              `authkit: remote account page "${page.id}" from "${entry.source.clientId}" is skipped: the segment "${segment}" is reserved or already used.`,
            );
            continue;
          }
          used.add(segment);
          const nav = page.nav === false ? undefined : page.nav;
          out.push({
            extensionId: extension.id,
            page,
            segment,
            order: pageOverride?.order ?? nav?.order ?? 100,
            scriptOrigins: extension.scriptOrigins ?? [],
            remote: entry.source.clientId,
          });
        }
      }
    }
    this.#pagesKey = key;
    this.#pages = out;
    return out;
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log(message);
  }
}
