/**
 * Cerimônia de REGISTRO de passkey em JSON — a variante headless do
 * `runPasskeyRegistration` (que é por form clássico).
 *
 * A diferença é o transporte, e ela é estrutural: o endpoint clássico
 * (`/account/mfa/passkeys/verify`) responde 302 numa navegação, então lá o
 * attestation vai num POST de PÁGINA INTEIRA. Uma tela do próprio host não pode
 * fazer isso — o browser não pode navegar entre a chamada de
 * `startRegistration()` e o envio do resultado, sob pena de perder a promise da
 * cerimônia. Por isso os endpoints JSON (`/account/api/mfa/passkeys/*`), que
 * respondem sempre JSON, inclusive na recusa de sudo.
 *
 * Vive fora do módulo de queries porque não tem nada de React: quem usa outro
 * gerenciador de estado (ou nenhum) chama esta função direto com um
 * `AuthkitClient`.
 */

import type { AuthkitClient } from '../client/client.js';
import { loadStartRegistration, type StartRegistrationFn } from './authenticate.js';

/** Deps injetáveis (só para teste) — chamadores normais omitem. */
export interface RegisterPasskeyJsonDeps {
  loadStartRegistration?: () => Promise<StartRegistrationFn>;
}

/**
 * Roda a cerimônia inteira: options → `startRegistration()` → verify.
 *
 * `@simplewebauthn/browser` é peer OPCIONAL: sem ele, o loader lança com a
 * instrução de instalação (nunca cai num CDN — ver `authenticate.ts`).
 *
 * O `verify` exige SUDO: sem confirmação de identidade recente, o servidor
 * responde `403 { error: { code: 'sudo_required' } }`, que o client transforma
 * num `AuthkitClientError` com `code === 'sudo_required'`. A tela do host lê
 * esse código para mandar o usuário reconfirmar.
 */
export async function registerPasskeyJson(
  client: AuthkitClient,
  deps: RegisterPasskeyJsonDeps = {},
): Promise<{ ok: boolean }> {
  const loadFn = deps.loadStartRegistration ?? loadStartRegistration;

  const optionsJSON = await client.account.mfa.passkeys.options();
  const startRegistration = await loadFn();
  const attestation = await startRegistration({ optionsJSON });
  return client.account.mfa.passkeys.verify(attestation);
}
