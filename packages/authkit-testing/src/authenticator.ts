import type { Identity } from '@adonis-agora/authkit-core';
import { createTestIdentity } from './identity.js';

/**
 * Superfície pública do `Authenticator` do client (o que `ctx.auth` expõe).
 * Reproduzida aqui para não acoplar o pacote de testing ao client em runtime.
 */
export interface FakeAuthenticatorLike {
  getIdentity(): Promise<Identity | null>;
  readonly identity: Identity | null;
  authenticate(): Promise<Identity>;
  check(): Promise<boolean>;
  hasGlobalRole(role: string): boolean;
  getUser(): Promise<unknown>;
  getUserOrFail(): Promise<unknown>;
  toSharedProps(): Promise<{ user: unknown; globalRoles: string[] } | null>;
}

export interface FakeAuthenticatorOptions {
  /** identidade resolvida; default = {@link createTestIdentity}. Passe `null` para simular anônimo. */
  identity?: Identity | null;
  /** usuário de domínio retornado por `getUser()`. */
  user?: unknown;
}

/**
 * Cria um objeto que satisfaz a superfície do `Authenticator` do client para
 * injetar em `ctx.auth` em testes de controller — sem resolver tokens de verdade.
 */
export function fakeAuthenticator(options: FakeAuthenticatorOptions = {}): FakeAuthenticatorLike {
  const identity: Identity | null =
    options.identity === undefined ? createTestIdentity() : options.identity;
  const user = 'user' in options ? options.user : identity;

  return {
    async getIdentity() {
      return identity;
    },
    get identity() {
      return identity;
    },
    async authenticate() {
      if (!identity) throw new Error('Not authenticated');
      return identity;
    },
    async check() {
      return identity !== null;
    },
    hasGlobalRole(role: string) {
      return identity?.globalRoles.includes(role) ?? false;
    },
    async getUser() {
      if (!identity) return null;
      return user;
    },
    async getUserOrFail() {
      if (!identity || user === null || user === undefined) {
        throw new Error('Not authenticated: no user for the current session');
      }
      return user;
    },
    async toSharedProps() {
      if (!identity) return null;
      return { user: user ?? null, globalRoles: identity.globalRoles ?? [] };
    },
  };
}
