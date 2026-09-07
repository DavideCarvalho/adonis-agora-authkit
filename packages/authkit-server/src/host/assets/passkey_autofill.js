// Passkey autofill (conditional mediation) do login.edge — extraído do
// `<script type="module">` inline (M12: CSP `script-src 'self'` bloqueia
// script inline sem nonce/hash). A URL de options vem de `data-options-url`
// no form (renderizada pelo Edge como atributo HTML, não interpolada dentro
// do JS) em vez de `{{ uid }}` cru no meio do fetch.
(async () => {
  try {
    // SSR-safe: só roda no browser.
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

    const form = document.getElementById('autofill-passkey-form');
    if (!form || !window.PublicKeyCredential) return;

    // Detecta suporte a conditional mediation.
    const supported = await PublicKeyCredential.isConditionalMediationAvailable?.();
    if (!supported) return;

    const { startAuthentication } = await import('/authkit/assets/webauthn.js');
    const csrf = form.querySelector('input[name="_csrf"]')?.value ?? '';
    const optRes = await fetch(form.dataset.optionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({}),
    });
    if (!optRes.ok) return;
    const optionsJSON = await optRes.json();
    // Remove flag interna antes de passar ao browser.
    delete optionsJSON._discoverable;

    // AbortController: cancela ao navegar/desmontar.
    const ac = new AbortController();
    window.addEventListener('beforeunload', () => ac.abort(), { once: true });

    const assertion = await startAuthentication(
      {
        optionsJSON,
        useBrowserAutofill: true,
        verifyBrowserAutofillInput: true,
      },
      ac.signal,
    );

    document.getElementById('autofill-passkey-response').value = JSON.stringify(assertion);
    form.submit();
  } catch {
    // Fail-safe: abort, suporte ausente ou qualquer erro = login normal.
  }
})();
