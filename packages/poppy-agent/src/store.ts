import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StoredKey } from './keys.js';

export interface TokenRecord {
  accessToken: string;
  tokenType: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
  sessionId: string;
  signedIn: boolean;
  /** RFC 8707 resource this token was issued for, if any. */
  resource?: string;
}

export interface AccountTokenRecord {
  /** The Account Token (an OAuth refresh token). A secret: never logged or shown (4.8). */
  refreshToken: string;
  scope: string;
  obtainedAt: number;
  /** Epoch ms, from `refresh_token_expires_in` when the Company sets one. */
  expiresAt?: number;
  /** Which sign-in type produced it. */
  via: 'direct' | 'device' | 'mediated';
}

export interface ConversationRecord {
  endpoint: string;
  /** Last event handled (a cursor / Last-Event-ID). */
  cursor?: string;
  parentConversationId?: string;
  createdAt: number;
  closed?: boolean;
}

/** Everything the agent remembers about one User at one Company (keyed by issuer, 3.2). */
export interface CompanyState {
  issuer: string;
  domains: string[];
  /** Opaque, random, per-Company User ID (4.2). Never derived from personal information. */
  userId: string;
  /** DPoP key for this User at this Company (4.3). Never published. */
  dpopKey: StoredKey;
  accountToken?: AccountTokenRecord;
  /** Session Tokens by key: `dpop` (default) or `dpop|scope|resource` / `bearer|resource`. */
  tokens: Record<string, TokenRecord>;
  /** The current Session's ID. Not a credential (4.2). */
  sessionId?: string;
  conversations: Record<string, ConversationRecord>;
}

export interface IdentityState {
  baseUrl: string;
  clientName: string;
  logoUri?: string;
  keys: StoredKey[];
}

export interface StateFile {
  version: 1;
  identity?: IdentityState;
  /** Local users ("profiles") of this agent, each with their Companies. */
  profiles: Record<string, { companies: Record<string, CompanyState> }>;
}

export function defaultStatePath(): string {
  if (process.env.POPPY_AGENT_STATE) return process.env.POPPY_AGENT_STATE;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'poppy-agent', 'state.json');
}

/**
 * The local state file. It holds private keys and Account Tokens, so it is written with mode
 * 0600 (directory 0700) and atomically (temp file + rename).
 */
export class StateStore {
  private constructor(
    readonly path: string,
    public data: StateFile,
  ) {}

  static async open(path = defaultStatePath()): Promise<StateStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let data: StateFile = { version: 1, profiles: {} };
    try {
      const raw = await readFile(path, 'utf8');
      data = JSON.parse(raw) as StateFile;
      const st = await stat(path);
      if ((st.mode & 0o077) !== 0) await chmod(path, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    data.profiles ??= {};
    return new StateStore(path, data);
  }

  /** Directory next to the state file, used for the Direct Sign-In callback relay. */
  get dir(): string {
    return dirname(this.path);
  }

  profile(name: string) {
    this.data.profiles[name] ??= { companies: {} };
    return this.data.profiles[name];
  }

  #saving: Promise<void> = Promise.resolve();

  /**
   * Writes the state atomically (tmp file + rename). Saves are serialized: a conversation stream
   * and the prompt can save at the same time, and two writes sharing one tmp file made the second
   * `rename` fail with ENOENT.
   */
  save(): Promise<void> {
    const run = this.#saving.then(() => this.#write());
    this.#saving = run.catch(() => {});
    return run;
  }

  async #write(): Promise<void> {
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }
}
