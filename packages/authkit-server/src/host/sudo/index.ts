import { magicLink } from './methods/magic_link.js';
import { oidcStepUp } from './methods/oidc_step_up.js';
import { passkey } from './methods/passkey.js';
import { password } from './methods/password.js';

/**
 * Métodos de confirmação de identidade (sudo mode), no mesmo padrão de factory
 * usado em `stores.*` e `retrievers.*` das libs irmãs.
 *
 * A lista vai em DOIS lugares, e eles precisam casar:
 *
 * - `config/authkit.ts` → `sudo.methods` decide o que a TELA oferece e o que os
 *   handlers ACEITAM;
 * - `registerAuthHost(router, { sudoMethods })` decide o que tem ROTA montada.
 *
 * São dois porque a montagem de rotas acontece antes de o config (lazy)
 * resolver — mesma razão de `social`/`admin`/`rateLimit`. Divergiram, a tela
 * loga um aviso de flag-drift e o endpoint faltante dá 404.
 *
 * SEM `config.sudo.methods` não há como divergir: a tela cai na própria lista
 * montada por `registerAuthHost`, a mesma que os handlers aceitam.
 *
 * E é essa mesma separação que define o que é DEFAULT. `registerAuthHost` monta
 * `[password, passkey, magicLink]` sem conhecer o config; o config resolvido
 * decide quais deles valem (`derivedSudoMethods`, em `runtime.ts`): host com
 * senha fica com `[password, passkey]` (o histórico), host que declarou
 * `authMethods: { password: false }` fica com `[passkey, magicLink]`. A regra é
 * UMA função, consultada pelos dois lados — montar não é oferecer, e continuar
 * não havendo como divergir.
 *
 * ```ts
 * defineConfig({
 *   sudo: {
 *     methods: [
 *       sudoMethods.oidcStepUp({ url: '/auth/step-up' }),
 *       sudoMethods.magicLink(),
 *       sudoMethods.passkey(),
 *       sudoMethods.password(),
 *     ],
 *   },
 * })
 * ```
 */
export const sudoMethods = { password, passkey, oidcStepUp, magicLink };

export type { SudoMethod, SudoContext, SudoMethodDescriptor, SudoRouteHelpers } from './types.js';

/**
 * Montagem do `SudoContext` a partir do `HttpContext`. Reexportado aqui por
 * simetria com `sudoMethods` e os tipos: quem escreve um método (ou a rota de
 * callback do `oidcStepUp`) precisa dos três.
 */
export { sudoContextFrom } from './runtime.js';
