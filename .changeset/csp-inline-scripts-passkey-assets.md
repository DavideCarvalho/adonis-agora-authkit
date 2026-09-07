---
'@adonis-agora/authkit-server': patch
---

`login.edge`, `mfa-challenge.edge`, `account/confirm.edge`, `account/mfa.edge` e `partials/submit_lock.edge` embutiam `<script>`/`<script type="module">` **inline** (autofill/botão de passkey, verificação WebAuthn do `/account/confirm`, anti-duplo-submit). Hosts com CSP restritivo (`script-src 'self'`, sem `'unsafe-inline'`, sem nonce/hash — a postura recomendada num IdP) bloqueiam esses scripts silenciosamente: os botões de passkey não fazem nada e a trava anti-duplo-submit não liga, sem erro visível.

Os cinco scripts agora são servidos como assets same-origin em `/authkit/assets/{passkey_autofill,passkey_button,passkey_register,webauthn_confirm,submit_lock}.js` (permitidos por `'self'`, sem depender de nonce/hash), seguindo o padrão já usado pelo splash de logout (`/authkit/assets/logout.js`, `0.61.3`) e pelo bundle WebAuthn (`/authkit/assets/webauthn.js`). Valores por-request (URLs de options/verify, csrf) passam a ir em atributos `data-*` HTML-escapados pelo Edge, em vez de interpolados dentro do `<script>`. `registerAuthHost` registra as novas rotas automaticamente — hosts que atualizarem a lib ganham os assets sem mudança de código.
