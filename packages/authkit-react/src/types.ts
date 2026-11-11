/**
 * Usuário serializado que o host AdonisJS compartilha com o frontend.
 *
 * Espelha a saída de `resolveUser`/`identityToUser` do backend
 * (`@adonis-agora/authkit-client`), que por sua vez deriva da `Identity`
 * (claims OIDC validadas) do `@adonis-agora/authkit-core`:
 *
 * - `id`            ← `Identity.userId` (claim `sub`)
 * - `email`         ← `Identity.email`
 * - `name`          ← `Identity.profile?.name`
 * - `avatarUrl`     ← `Identity.profile?.avatarUrl`
 * - `globalRoles`   ← `Identity.globalRoles` (papéis globais do IdP)
 *
 * É a fronteira de tipos entre backend e frontend: o host é livre para
 * adicionar campos extras de domínio (por isso o index signature).
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  /** papéis globais, vindos do IdP via claim de roles */
  globalRoles: string[];
  /** escape hatch: o host pode anexar campos extras de domínio */
  [key: string]: unknown;
}

/**
 * Contrato da shared-prop do Inertia exposta pelo host.
 *
 * O host AdonisJS deve compartilhar este objeto (ex.: via `inertia.share()`),
 * usando `authkit.getUser()`/identidade do `@adonis-agora/authkit-client`:
 *
 * ```ts
 * inertia.share({
 *   authkit: {
 *     user: await authkit.getUser(),
 *     globalRoles: authkit.identity?.globalRoles ?? [],
 *   },
 * })
 * ```
 */
export interface AuthSharedProps {
  authkit: {
    user: AuthUser | null;
    globalRoles: string[];
  };
  /** o Inertia `PageProps` exige index signature; o host pode ter outras props */
  [key: string]: unknown;
}

/**
 * Estado de autenticação retornado por `useAuth()`.
 */
export interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  globalRoles: string[];
  hasGlobalRole(role: string): boolean;
  hasAnyGlobalRole(roles: string[]): boolean;
  hasAllGlobalRoles(roles: string[]): boolean;
}
