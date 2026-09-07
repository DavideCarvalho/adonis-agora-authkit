// Botão "entrar com passkey" — compartilhado por login.edge (passwordless
// antes da senha) e mfa-challenge.edge (2º fator). Extraído do
// `<script type="module">` inline (M12: CSP `script-src 'self'` bloqueia
// script inline sem nonce/hash). A URL de options vem de `data-options-url`
// no form `#passkey-form` (atributo HTML, escapado pelo Edge) em vez de
// `{{ uid }}` cru interpolado dentro do JS.
//
// O bloco "trustDevice" só existe em mfa-challenge.edge (checkbox "confiar
// neste dispositivo" + hidden `#passkey-trust`); em login.edge os dois
// seletores dão `null` e o bloco vira no-op — por isso um único arquivo serve
// as duas views sem branch de view.
import { startAuthentication } from '/authkit/assets/webauthn.js';

const form = document.getElementById('passkey-form');
const btn = document.getElementById('passkey-button');
const errEl = document.getElementById('passkey-error');

if (form && btn) {
  const csrf = form.querySelector('input[name="_csrf"]')?.value ?? '';

  btn.addEventListener('click', async () => {
    errEl?.classList.add('hidden');
    btn.disabled = true;
    try {
      const res = await fetch(form.dataset.optionsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('options');
      const optionsJSON = await res.json();
      const assertion = await startAuthentication({ optionsJSON });
      document.getElementById('passkey-response').value = JSON.stringify(assertion);

      // Só em mfa-challenge.edge: propaga a escolha de "confiar neste dispositivo".
      const trustChk = document.querySelector('input[name="trustDevice"][type="checkbox"]');
      const trustHidden = document.getElementById('passkey-trust');
      if (trustHidden) trustHidden.value = trustChk?.checked ? 'on' : '';

      form.submit();
    } catch (_e) {
      errEl?.classList.remove('hidden');
      btn.disabled = false;
    }
  });
}
