/**
 * usePasskeyAutofill — WebAuthn conditional mediation (autofill) hook.
 *
 * Permite que telas de login customizadas dos hosts (que não usam o login.edge
 * built-in) ativem o autofill de passkey no campo de e-mail, disparando o fluxo
 * de authenticação discoverable assim que o usuário selecionar uma sugestão do
 * browser.
 *
 * Fail-safe total:
 *   - SSR-safe: não executa fora do browser.
 *   - Browser sem suporte ao WebAuthn / conditional mediation → silêncio.
 *   - Qualquer erro/abort → silêncio (login normal segue).
 *   - AbortController: aborta automaticamente no unmount do componente.
 *
 * Uso:
 * ```tsx
 * usePasskeyAutofill({
 *   optionsUrl: '/auth/interaction/:uid/passkey/options',
 *   verifyUrl: '/auth/interaction/:uid/passkey/verify',
 *   onSuccess: (assertion) => { ... }, // navega / submete form
 * })
 * ```
 *
 * O hook é exportado do pacote principal `@adonis-agora/authkit-react`.
 */

import { useEffect, useRef } from 'react';
import { loadStartAuthentication, type StartAuthenticationFn } from '../passkey/authenticate.js';

export interface UsePasskeyAutofillOptions {
  /**
   * URL para obter as options de autenticação (POST).
   * Deve ser o endpoint `passkey/options` do interaction controller,
   * configurado para retornar options discoverable (allowCredentials vazio).
   */
  optionsUrl: string;
  /**
   * URL para verificar a assertion de autenticação (POST, form).
   * O hook passa a assertion serializada em JSON.
   */
  verifyUrl: string;
  /**
   * Callback chamado em caso de sucesso com a assertion bruta.
   * O host decide como submeter (ex.: form submit, fetch, navigate).
   * @param assertion - JSON.stringify da PublicKeyCredential assertion.
   */
  onSuccess: (assertion: string) => void;
  /**
   * CSRF token a enviar nos headers (X-CSRF-TOKEN) quando opcional.
   * Quando ausente, o fetch não inclui o header.
   */
  csrfToken?: string;
  /**
   * Se false, o hook NÃO roda mesmo com suporte disponível.
   * Default: true. Útil quando a setting passkeyAutofill está off.
   */
  enabled?: boolean;
}

/**
 * Hook SSR-safe para WebAuthn conditional mediation (passkey autofill).
 *
 * Monta a cerimônia de autenticação discoverable no carregamento do componente
 * e a aborta automaticamente no unmount. O browser apresenta as passkeys
 * disponíveis diretamente no campo que tem `autocomplete="username webauthn"`.
 */
export function usePasskeyAutofill(options: UsePasskeyAutofillOptions): void {
  const { optionsUrl, verifyUrl, onSuccess, csrfToken, enabled = true } = options;
  const abortRef = useRef<AbortController | null>(null);

  // verifyUrl não é lido no efeito (a verificação é feita pelo host dentro de
  // onSuccess), mas segue listado na dependency array por ser parte da
  // options públicas do hook — biome-ignore em vez de remover, pra não voltar
  // a ficar unused no destructure acima.
  // biome-ignore lint/correctness/useExhaustiveDependencies: verifyUrl não é lido no efeito, ver comentário acima
  useEffect(() => {
    if (!enabled) return;
    // SSR guard
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    if (!window.PublicKeyCredential) return;

    let cancelled = false;
    const ac = new AbortController();
    abortRef.current = ac;

    const run = async () => {
      try {
        // 1. Detecta suporte a conditional mediation.
        const supported =
          typeof (PublicKeyCredential as any).isConditionalMediationAvailable === 'function'
            ? await (PublicKeyCredential as any).isConditionalMediationAvailable()
            : false;
        if (!supported || cancelled) return;

        // 2. Carrega startAuthentication de forma lazy (peer opcional do app).
        //    Compartilhado com o login explícito via passkey/authenticate.
        let startAuthentication: StartAuthenticationFn;
        try {
          startAuthentication = await loadStartAuthentication();
        } catch {
          return; // Sem biblioteca = sem autofill.
        }
        if (cancelled) return;

        // 3. Obtém as options discoverable do servidor.
        const headers: Record<string, string> = {
          'content-type': 'application/json',
        };
        if (csrfToken) headers['x-csrf-token'] = csrfToken;

        const optRes = await fetch(optionsUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
          signal: ac.signal,
        });
        if (!optRes.ok || cancelled) return;
        const optionsJSON = await optRes.json();
        // Remove flag interna (_discoverable) antes de passar ao browser.
        optionsJSON._discoverable = undefined;
        if (cancelled) return;

        // 4. Inicia conditional mediation — o browser bloqueia aqui até o usuário
        //    selecionar uma passkey (ou o AbortController ser disparado).
        const assertion = await startAuthentication(
          {
            optionsJSON,
            useBrowserAutofill: true,
            verifyBrowserAutofillInput: true,
          },
          ac.signal,
        );
        if (cancelled) return;

        // 5. Sucesso: entrega a assertion serializada ao callback do host.
        onSuccess(JSON.stringify(assertion));
      } catch {
        // Fail-safe: abort, suporte ausente, erro de rede ou qualquer outra falha
        // → silêncio. O login normal (senha/passkey manual) continua disponível.
      }
    };

    void run();

    return () => {
      cancelled = true;
      ac.abort();
      abortRef.current = null;
    };
  }, [enabled, optionsUrl, verifyUrl, onSuccess, csrfToken]);
}
