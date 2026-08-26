---
'@adonis-agora/authkit-server': patch
---

O splash de logout (RP-initiated logout) auto-submetia o form de confirmação com um `<script>` **inline**. Hosts com CSP restritivo (`script-src 'self'` + nonce/hash, sem `'unsafe-inline'`) bloqueiam script inline sem nonce — o POST `/session/end/confirm` nunca rodava e a tela "Saindo / Encerrando sua sessão…" ficava presa para sempre: a sessão SSO nunca era encerrada.

Agora o script de auto-confirmação é servido como asset same-origin em `/authkit/assets/logout.js` (permitido por `'self'`, sem depender de nonce/hash), seguindo o padrão já usado pelo bundle WebAuthn em `/authkit/assets/webauthn.js`. O host precisa registrar a nova rota — `registerAuthHost` faz isso automaticamente; apps que atualizarem a lib ganham a rota sem mudança de código.
