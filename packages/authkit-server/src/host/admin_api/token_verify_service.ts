import type { ResolvedServerConfig } from '../../define_config.js';
import { resolveAccountRoles } from '../account_roles.js';

/** Resultado de introspecção genérica (PAT ou opaque access token). */
export type VerifyResult =
  | { active: false }
  | {
      active: true;
      /** 'pat' (Personal Access Token) ou 'access_token' (opaque AT do provider). */
      tokenType: 'pat' | 'access_token';
      sub: string;
      email?: string | null;
      name?: string | null;
      roles?: string[];
      scopes?: string[];
      audience?: string | string[] | null;
      clientId?: string | null;
      exp?: number | null;
    };

/**
 * Introspecção genérica de token usada pela Admin REST API (`POST /tokens/verify`).
 * Roteia por prefixo: tokens `pat_...` vão pelo {@link PatStore} (mesma rota do
 * `/authkit/pat/introspect`); os demais são tratados como opaque access tokens e
 * resolvidos pelo `AccessToken.find` do oidc-provider. Sempre best-effort: token
 * desconhecido/expirado → `{ active: false }`.
 */
export class TokenVerifyService {
  constructor(
    private cfg: ResolvedServerConfig,
    /** Provider do oidc-provider (service.provider) — para opaque AT. */
    private provider: any,
  ) {}

  async verify(token: string): Promise<VerifyResult> {
    if (!token || typeof token !== 'string') return { active: false };

    if (token.startsWith('pat_')) return this.#verifyPat(token);
    return this.#verifyAccessToken(token);
  }

  async #verifyPat(token: string): Promise<VerifyResult> {
    if (!this.cfg.patStore) return { active: false };
    const meta = await this.cfg.patStore.findActiveByToken(token);
    if (!meta) return { active: false };
    const account = await this.cfg.accountStore.findById(meta.accountId);
    if (!account) return { active: false };
    return {
      active: true,
      tokenType: 'pat',
      sub: account.id,
      email: account.email,
      name: account.name ?? null,
      roles: await resolveAccountRoles(this.cfg, account),
      scopes: meta.scopes,
      audience: meta.audience,
      exp: meta.exp,
    };
  }

  async #verifyAccessToken(token: string): Promise<VerifyResult> {
    let at: any;
    try {
      at = await this.provider?.AccessToken?.find(token);
    } catch {
      return { active: false };
    }
    if (!at) return { active: false };
    // O oidc-provider expira artefatos sozinho; isExpired/exp como guarda extra.
    if (typeof at.isExpired === 'boolean' && at.isExpired) return { active: false };

    const sub = (at.accountId as string) ?? '';
    const account = sub ? await this.cfg.accountStore.findById(sub) : null;
    const scopes = typeof at.scope === 'string' ? at.scope.split(' ').filter(Boolean) : [];
    return {
      active: true,
      tokenType: 'access_token',
      sub,
      email: account?.email ?? null,
      name: account?.name ?? null,
      roles: account
        ? await resolveAccountRoles(this.cfg, account, {
            clientId: (at.clientId as string | undefined) ?? undefined,
          })
        : [],
      scopes,
      audience: (at.aud as string | string[] | undefined) ?? null,
      clientId: (at.clientId as string | undefined) ?? null,
      exp: typeof at.exp === 'number' ? at.exp : null,
    };
  }
}
