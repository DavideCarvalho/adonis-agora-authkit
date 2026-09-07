// Trava anti-duplo-submit dos forms clássicos (`method="POST"` com
// navegação) — incluída em TODA view do host-kit via
// `partials/submit_lock.edge`. Extraída do `<script>` inline (M12: CSP
// `script-src 'self'` bloqueia script inline sem nonce/hash). Sem nenhuma
// interpolação por request — o texto é idêntico ao que estava inline, só
// mudou de lugar.
//
// Por quê: os endpoints de interaction/conta disparam ações custosas (envio
// de e-mail, cerimônia WebAuthn, verificação de código) e, sem feedback, o
// usuário clica de novo — cada clique vira um POST duplicado e, nas rotas
// throttled, derruba o usuário no 429 por mera impaciência.
//
// Como:
// - Listener DELEGADO no `document` — cobre todo form, inclusive os montados
//   depois (sem precisar marcar forms um a um).
// - A trava é agendada com `setTimeout(0)`: roda DEPOIS do dispatch do
//   `submit`, quando o entry-list do form já foi construído (um botão de
//   submit NOMEADO preserva seu valor no POST) e handlers que chamam
//   `preventDefault` já rodaram (aí `defaultPrevented` evita travar à toa —
//   sem navegação, sem botão morto).
// - Validação nativa que barra o submit nem dispara o evento — a trava nunca
//   liga num form inválido.
// - `form.submit()` (JS puro, ex.: auto-submit de passkey) NÃO dispara
//   `submit` — esses forms seguem destravados de propósito.
// - Não há "destravar": a resposta (redirect ou re-render de erro) chega como
//   documento NOVO e a página remonta.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  setTimeout(() => {
    if (event.defaultPrevented) return;
    form
      .querySelectorAll('button[type="submit"], button:not([type]), input[type="submit"]')
      .forEach((el) => {
        el.disabled = true;
      });
    form.setAttribute('aria-busy', 'true');
  }, 0);
});
