/**
 * Personal-agent protocol extensions — the surface another package uses to plug a personal-agent
 * protocol into the auth host (`personalAgents.extensions` in `config/authkit.ts`).
 *
 * **Stable for all of 1.x.** Everything in this file follows semver: a 1.x release only adds
 * optional members. A protocol package (such as `@adonis-agora/authkit-poppy`) can change as fast
 * as its spec does without forcing a major here.
 *
 * What an extension gets:
 *
 * - its own routes under the auth host, with the account guard and the rate-limit buckets of the
 *   built-in screens ({@link PersonalAgentRouteKit});
 * - a shared grant ledger (`auth_agent_grants` / `auth_agent_refresh_tokens`) scoped to its grant-id
 *   prefix, so the account console ("Connected apps"), the account API, "sign out everywhere", account
 *   deletion and the admin console list and revoke its connections with no extra code
 *   ({@link PersonalAgentGrantLedger});
 * - the admin console's allow/block registry (`auth_agent_registry`), keyed by its protocol id;
 * - its own lib-owned tables, created with AuthKit's (`schema.autoManage`) — {@link AuthkitTable};
 * - access tokens minted by the OIDC provider for MCP resources ({@link PersonalAgentAccessTokens});
 * - message catalogs merged into AuthKit's i18n (host overrides in `i18n.messages` still win).
 *
 * What it gives back: a {@link PersonalAgentProtocolRuntime} — list, revoke and name its
 * connections.
 */
import type { HttpContext } from '@adonisjs/core/http';

/**
 * A lib-owned table: created when missing, new columns added with `ALTER ADD`, never dropped or
 * altered. The builders receive a Knex `TableBuilder`.
 */
/** What {@link AuthkitTable.create} receives next to the table builder. */
export interface AuthkitTableContext {
  /** `name` as AuthKit's tables are addressed: `schema.name` + `.` + `name` when a schema is set. */
  table(name: string): string;
}

export interface AuthkitTable {
  name: string;
  /**
   * Full builder — runs when the table does not exist. A foreign key into another lib-owned
   * table names it through `context.table(name)` (qualified with `schema.name` when set).
   */
  create: (table: any, context: AuthkitTableContext) => void;
  /**
   * One builder per column — runs (`ALTER ADD`) when the table exists but the column does not.
   * No constraints that break on populated tables (unique/FK belong in `create`).
   */
  columns: Record<string, (table: any) => void>;
  /** Indexes ensured by name, also on tables that already existed. `create` must declare them. */
  indexes?: Array<{ name: string; columns: string[] }>;
}

/** A row of the shared grant ledger (`auth_agent_grants`). */
export interface PersonalAgentGrant {
  /** Starts with the extension's `grantIdPrefix`. */
  id: string;
  accountId: string;
  /** The agent's identifier in its protocol (a PACT `iss`, a Poppy `client_id`…). */
  clientId: string;
  /** The agent's own user id, when the protocol has one. `''` otherwise. */
  agentSub: string;
  /** Space-separated scopes. */
  scope: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A refresh token of the ledger — only its hash is stored. */
export interface PersonalAgentRefreshToken {
  grantId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * The shared grant ledger, scoped to one extension: every read and write only sees grants whose id
 * starts with the extension's `grantIdPrefix`. Grants written here show up in the account and admin
 * consoles and are revoked by "sign out everywhere", password reset and account deletion.
 */
export interface PersonalAgentGrantLedger {
  /** Throws when `grant.id` does not start with the extension's prefix. */
  insertGrant(grant: Omit<PersonalAgentGrant, 'revokedAt'>): Promise<void>;
  /** `null` when missing or not this extension's. */
  findGrant(id: string): Promise<PersonalAgentGrant | null>;
  /** Unrevoked grants of the account (expired ones included), newest first. */
  listGrants(accountId: string): Promise<PersonalAgentGrant[]>;
  /** Ids of the agent's unrevoked grants, across accounts. */
  unrevokedGrantIdsOfClient(clientId: string): Promise<string[]>;
  /** Revokes the grant (no-op when already revoked or not this extension's). */
  revokeGrantById(id: string, at: Date): Promise<void>;
  insertRefreshToken(token: {
    tokenHash: string;
    grantId: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<void>;
  /** `null` when unknown. The caller checks the grant through {@link findGrant}. */
  findRefreshToken(tokenHash: string): Promise<PersonalAgentRefreshToken | null>;
}

/**
 * Access tokens of the OIDC provider for MCP resources — the same tokens AuthKit's MCP integration
 * (automatic MCP client login: `mcpClients` in `defineConfig`, resources announced through
 * `Symbol.for('@adonis-agora/oauth:resources')`) already accepts.
 */
export interface PersonalAgentAccessTokens {
  /** MCP client login is on (automatic: an MCP resource is registered and nothing turned it off). */
  readonly mcpEnabled: boolean;
  /** `url` is a registered MCP resource of this app. */
  isMcpResource(url: string): boolean;
  /**
   * Mints an access token bound to `resource`, under a provider grant with `grantId` (created when
   * missing). `grantType` becomes the token's `gty`. `null` when the provider is not available.
   */
  mint(input: {
    grantId: string;
    accountId: string;
    clientId: string;
    scope: string;
    resource: string;
    /** Seconds. */
    expiresIn: number;
    /** When the extension's grant expires — the provider grant lives as long. */
    grantExpiresAt: Date;
    grantType: string;
  }): Promise<string | null>;
  /** Revokes the provider grant and its access tokens. */
  revokeGrant(grantId: string): Promise<void>;
}

/** What the host hands to {@link PersonalAgentExtensionDefinition.setup}. */
export interface PersonalAgentHost {
  /** The extension's protocol id. */
  readonly protocol: string;
  /** The OIDC issuer (`defineConfig({ issuer })`). Derive public URLs from its origin. */
  readonly issuer: string;
  /** The Lucid connection AuthKit's tables live on (`schema.connection`). */
  db(): any;
  /**
   * `name` as every statement must write it: `schema.name` + `.` + `name` when the app puts
   * AuthKit's tables in a database schema (knex quotes each part), else `name`. Name every
   * lib-owned table through it — the shared ledger tables and the extension's own.
   */
  table(name: string): string;
  readonly grants: PersonalAgentGrantLedger;
  /** The admin console's verdict on an agent of this protocol. `null` = not listed. */
  registryStatus(identifier: string): Promise<'allowed' | 'blocked' | null>;
  /** A stable per-app secret for `label` (HMAC of the app key). Same on every instance. */
  deriveSecret(label: string): Buffer;
  /** The account exists and is not disabled. */
  isAccountActive(accountId: string): Promise<boolean>;
  /** Resolves a container binding (`'redis'`…). Throws outside an app. */
  make(binding: string): Promise<any>;
  readonly accessTokens: PersonalAgentAccessTokens;
  /** The clock (tests inject one). */
  now(): Date;
}

/** One connection of an account, as the account console and API show it. */
export interface PersonalAgentGrantSummary {
  id: string;
  clientId: string;
  scopes: Array<{ id: string; description: string }>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/** What the admin console shows about an extension. */
export interface PersonalAgentConsoleSummary {
  /** Only listed agents may connect. */
  requireRegistration: boolean;
  /** The config's allow/block list is a function, which the console cannot list. */
  hostResolver: boolean;
  /** Agent identifiers may be `http://` URLs (development only). */
  allowHttpIdentifiers: boolean;
  /** Agents the config lists, by identifier. */
  configured: { allowed: readonly string[]; blocked: readonly string[] };
  /** Label of the identifier field (`'Client ID (metadata URL)'`). */
  identifierLabel: string;
  /** Example identifier for the field. */
  identifierPlaceholder?: string;
}

/** The running protocol, built once per app by {@link PersonalAgentExtensionDefinition.setup}. */
export interface PersonalAgentProtocolRuntime {
  /** Live connections of the account (account console and `GET /account/api/agents`). */
  listAccountGrants(accountId: string): Promise<PersonalAgentGrantSummary[]>;
  /** Revokes one connection OF THE ACCOUNT. `false` = not found, not the account's, or revoked. */
  revokeAccountGrant(accountId: string, grantId: string): Promise<boolean>;
  /** Revokes every connection of the account. Returns how many were live. */
  revokeAllAccountGrants(accountId: string): Promise<number>;
  /** Revokes a connection of any account (admin console). The host checked that it is live. */
  revokeGrant(grantId: string): Promise<void>;
  /** Disconnects an agent from every account (admin console block). Returns how many were live. */
  disconnectAgent(identifier: string): Promise<number>;
  /** The agent's display name. */
  displayName(identifier: string): Promise<string>;
  consoleSummary(): PersonalAgentConsoleSummary;
}

/** Route helpers for {@link PersonalAgentExtensionDefinition.routes}. */
export interface PersonalAgentRouteKit {
  /**
   * The account-session guard of the consent screens: a signed-out visitor goes to the login and
   * comes back, idle sessions end, and a personal agent's own browser gets 403.
   */
  accountGuard: (ctx: HttpContext, next: () => Promise<void>) => Promise<unknown>;
  /** Rate-limit buckets of the built-in screens (no-op when `rateLimit` is off). */
  throttle: {
    /** Per IP, the login bucket — pages that write something without authentication. */
    login<R>(route: R): R;
    /** Per IP, the one-time-code bucket — screens that take a typed code. */
    otp<R>(route: R): R;
  };
}

/** What {@link PersonalAgentExtension.resolve} receives. */
export interface PersonalAgentExtensionContext {
  /** The OIDC issuer. */
  issuer: string;
  /** `personalAgents.delegation.scopes`, when PACT delegation is configured. */
  delegationScopes: Readonly<Record<string, string>> | null;
}

/** A resolved extension. */
export interface PersonalAgentExtensionDefinition<
  R extends PersonalAgentProtocolRuntime = PersonalAgentProtocolRuntime,
> {
  /** Name shown in the admin console (`'Poppy'`). */
  label: string;
  /**
   * Prefix of the ids of the grants it writes to the ledger (`'pgrant_'`). Ends with `_`, unique
   * among extensions, never `agrant_` (PACT).
   */
  grantIdPrefix: string;
  /**
   * Path prefix of its routes (`'/poppy'`). Must not sit under the OIDC `mountPath` nor under
   * `personalAgents.prefix`.
   */
  prefix: string;
  /** Exact paths `authkitCsrfExceptions` exempts (server-to-server or cross-site POSTs). */
  csrfExemptPaths?: readonly string[];
  /** Lib-owned tables, ensured with AuthKit's own. */
  tables?: readonly AuthkitTable[];
  /** `locale → key → text`, merged under AuthKit's catalogs (host overrides win). */
  messages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * The session belongs to a personal agent's browser: the account and admin consoles answer 403
   * to it. Synchronous — reads the session only.
   */
  isAgentBrowser?(ctx: HttpContext): boolean;
  /** Runs once when the provider boots, after the config resolved. */
  boot?(): void | Promise<void>;
  /** Registers its routes on the app router (from `registerAuthHost`). */
  routes?(router: any, kit: PersonalAgentRouteKit): void;
  /** Builds the runtime — once per app, on first use. */
  setup(host: PersonalAgentHost): Promise<R>;
}

/**
 * A personal-agent protocol packaged for `personalAgents.extensions`.
 *
 * ```ts
 * // config/authkit.ts
 * import { poppy } from '@adonis-agora/authkit-poppy'
 * personalAgents: { extensions: [poppy({ organization: { name: 'Shop', domain: 'shop.example' } })] }
 * ```
 */
export interface PersonalAgentExtension<
  R extends PersonalAgentProtocolRuntime = PersonalAgentProtocolRuntime,
> {
  /** Protocol id: 2–16 characters of `a-z`, `0-9`, `-`. Never `pact`. */
  readonly id: string;
  /** Validates the extension's own config and resolves it. Runs when `defineConfig` resolves. */
  resolve(context: PersonalAgentExtensionContext): PersonalAgentExtensionDefinition<R>;
}

/** A resolved extension, with its id. */
export type ResolvedPersonalAgentExtension = PersonalAgentExtensionDefinition & {
  readonly id: string;
};

const EXTENSION_ID = /^[a-z0-9-]{2,16}$/;
const GRANT_PREFIX = /^[a-z0-9]+_$/;

function normalizePrefix(prefix: string, id: string): string {
  const trimmed = (prefix ?? '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') {
    throw new Error(`authkit: personalAgents.extensions "${id}" — prefix is required.`);
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Resolves and validates `personalAgents.extensions`. */
export function resolvePersonalAgentExtensions(
  input: readonly PersonalAgentExtension[] | undefined,
  context: PersonalAgentExtensionContext,
): ResolvedPersonalAgentExtension[] {
  const out: ResolvedPersonalAgentExtension[] = [];
  for (const extension of input ?? []) {
    const id = extension?.id;
    if (typeof id !== 'string' || !EXTENSION_ID.test(id) || id === 'pact') {
      throw new Error(
        `authkit: personalAgents.extensions — invalid id "${String(id)}" (2–16 of a-z, 0-9, -; not "pact").`,
      );
    }
    if (out.some((e) => e.id === id)) {
      throw new Error(`authkit: personalAgents.extensions — "${id}" is listed twice.`);
    }
    const definition = extension.resolve(context);
    if (!GRANT_PREFIX.test(definition.grantIdPrefix) || definition.grantIdPrefix === 'agrant_') {
      throw new Error(
        `authkit: personalAgents.extensions "${id}" — invalid grantIdPrefix "${definition.grantIdPrefix}".`,
      );
    }
    if (out.some((e) => e.grantIdPrefix === definition.grantIdPrefix)) {
      throw new Error(
        `authkit: personalAgents.extensions "${id}" — grantIdPrefix "${definition.grantIdPrefix}" is already taken.`,
      );
    }
    const prefix = normalizePrefix(definition.prefix, id);
    for (const other of out) {
      if (
        other.prefix === prefix ||
        other.prefix.startsWith(`${prefix}/`) ||
        prefix.startsWith(`${other.prefix}/`)
      ) {
        throw new Error(
          `authkit: personalAgents.extensions "${id}" — prefix "${prefix}" overlaps "${other.id}" ("${other.prefix}").`,
        );
      }
    }
    // A plain object literal: its own members are the definition.
    out.push({ ...definition, id, prefix });
  }
  return out;
}
