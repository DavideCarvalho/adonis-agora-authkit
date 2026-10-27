/** DTO seguro do PAT — sem o hash do token. */
export interface PatRecord {
  id: string;
  name: string;
  scopes: string[];
  audience: string | null;
  createdAt: string;
  /** Last successful lookup, at a one-minute resolution (`lucidPatStore` writes it at most once a minute). */
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface IssuePatInput {
  accountId: string;
  name: string;
  scopes?: string[];
  audience?: string | null;
  expiresInDays?: number | null;
}

export interface PatStore {
  issue(input: IssuePatInput): Promise<{ token: string; pat: PatRecord }>;
  listForAccount(accountId: string): Promise<PatRecord[]>;
  revoke(accountId: string, id: string): Promise<boolean>;
  findActiveByToken(token: string): Promise<{
    accountId: string;
    scopes: string[];
    audience: string | null;
    exp: number | null;
  } | null>;
}
