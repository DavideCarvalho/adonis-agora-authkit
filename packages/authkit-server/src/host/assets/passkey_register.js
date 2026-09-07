// Registro de passkey (account/mfa.edge, "adicionar chave de acesso").
// Extraído do `<script type="module">` inline (M12: CSP `script-src 'self'`
// bloqueia script inline sem nonce/hash). csrf/URLs vêm de atributos
// `data-*` no botão `#passkey-add` (Edge escapa atributos HTML — ao contrário
// de dentro de um `<script>`, onde entidades não são decodificadas) em vez de
// interpolados como string literal dentro do JS.
import { startRegistration } from '/authkit/assets/webauthn.js';

const btn = document.getElementById('passkey-add');
const errEl = document.getElementById('passkey-error');

btn?.addEventListener('click', async () => {
  const csrf = btn.dataset.csrf ?? '';
  const optionsUrl = btn.dataset.optionsUrl;
  const verifyUrl = btn.dataset.verifyUrl;

  errEl?.classList.add('hidden');
  btn.disabled = true;
  try {
    // 1) Opções de registro (challenge guardado na sessão server-side).
    const optsRes = await fetch(optionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({}),
    });
    if (!optsRes.ok) throw new Error('options');
    const optionsJSON = await optsRes.json();
    // 2) Cerimônia de registro no authenticator.
    const attResp = await startRegistration({ optionsJSON });
    // 3) Verifica/persiste no servidor.
    const verifyRes = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ response: attResp }),
    });
    if (!verifyRes.ok) throw new Error('verify');
    // 4) Recarrega para mostrar a nova passkey.
    window.location.reload();
  } catch (_e) {
    errEl?.classList.remove('hidden');
    btn.disabled = false;
  }
});
