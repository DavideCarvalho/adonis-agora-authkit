// Verificação WebAuthn genérica de account/confirm.edge — UM script para
// TODOS os blocos `kind: 'webauthn'` da tela (o import do
// @simplewebauthn/browser é caro e repeti-lo por método não traria nada).
// Extraído do `<script type="module">` inline (M12: CSP `script-src 'self'`
// bloqueia script inline sem nonce/hash). Já não interpolava nada por request
// (endpoint sai do `action` do form, csrf do hidden, mensagem de
// `data-message`) — só precisou sair do `<script>` inline para o asset.
import { startAuthentication } from '/authkit/assets/webauthn.js';

for (const block of document.querySelectorAll('[data-authkit-webauthn]')) {
  const form = block.querySelector('[data-webauthn-form]');
  const field = block.querySelector('[data-webauthn-response]');
  const errorBox = block.querySelector('[data-webauthn-error]');

  block.querySelector('[data-webauthn-start]')?.addEventListener('click', async () => {
    try {
      // Endpoint de options DERIVADO do descritor, não hardcoded.
      const optionsResponse = await fetch(form.getAttribute('action') + '/options', {
        method: 'POST',
        headers: { 'x-csrf-token': form.querySelector('input[name="_csrf"]').value },
      });
      if (!optionsResponse.ok) throw new Error('authkit: options recusadas');

      const optionsJSON = await optionsResponse.json();
      const assertion = await startAuthentication({ optionsJSON });
      // O handler lê `request.input('response')` como STRING e faz
      // JSON.parse — daí o stringify aqui.
      field.value = JSON.stringify(assertion);
      form.submit();
    } catch (error) {
      // Falha no handshake (usuário cancelou, options recusadas, sem
      // autenticador). Sem esta mensagem o botão simplesmente não faz
      // nada e o usuário não tem como saber que deve tentar outro método.
      console.error(error);
      errorBox.textContent = errorBox.getAttribute('data-message');
      errorBox.classList.remove('hidden');
    }
  });
}
