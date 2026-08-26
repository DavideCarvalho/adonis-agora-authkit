import { type AuthMessages, translate } from '../host/i18n.js';

/**
 * Sources de RP-initiated logout (end_session).
 *
 * Por padrão o oidc-provider renderiza uma página em INGLÊS e sem estilo
 * ("Do you want to sign-out from …?") com dois botões. Como o usuário já
 * clicou em "Sair" no app, a confirmação é fricção pura: sobrescrevemos
 * `logoutSource` por um splash de marca que AUTO-CONFIRMA (injeta o campo
 * `logout=yes` e submete via JS), com fallback `<noscript>` acessível.
 *
 * Como `device_sources`, recebem o KOA ctx (sem acesso ao renderer do host),
 * então emitem HTML auto-contido e i18n-izado.
 */

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Papel quente neutro + tinta — alinhado ao espírito "Manuscrito Vivo" sem
// depender da marca de um client específico (o end_session é cross-client).
const STYLE = `
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#faf6ee;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#2f1a47}
  .card{max-width:360px;width:100%;text-align:center}
  .spinner{width:30px;height:30px;margin:0 auto 20px;border:2.5px solid rgba(47,26,71,.15);border-top-color:#f17e42;border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  h1{font-family:Georgia,'Times New Roman',serif;font-size:1.5rem;font-weight:500;letter-spacing:-.01em;margin:0 0 8px}
  p{font-size:.95rem;line-height:1.5;color:#6e5d85;margin:0}
  button{margin-top:20px;height:44px;padding:0 22px;font-size:.95rem;font-weight:600;color:#2f1a47;background:#f17e42;border:0;border-radius:10px;cursor:pointer}
  @media (prefers-reduced-motion:reduce){.spinner{animation:none}}
  @media (prefers-color-scheme:dark){body{background:#1d112e;color:#f3ecdf}p{color:rgba(243,236,223,.65)}}
`;

function page(title: string, inner: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="card">${inner}</div></body></html>`;
}

export function createLogoutSources(messages: AuthMessages) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(messages, key, params);

  return {
    /**
     * Splash de saída que auto-confirma. `form` já contém o <form> com o xsrf
     * e a action de confirmação; injetamos o campo `logout` e submetemos.
     */
    async logoutSource(ctx: any, form: string) {
      // Injeta o campo de confirmação dentro do form fornecido pela lib.
      const confirmedForm = form.replace(
        /<\/form>/,
        '<input type="hidden" name="logout" value="yes"/></form>',
      );
      // Auto-submit via asset SAME-ORIGIN (`/authkit/assets/logout.js`), NÃO
      // script inline: hosts com CSP `script-src 'self'` (+ nonce/hash, sem
      // 'unsafe-inline') bloqueiam inline e o logout ficava preso em "Saindo /
      // Encerrando sua sessão…" para sempre (o POST de confirm nunca rodava).
      // `<script src>` same-origin é permitido por `'self'` sem nonce/hash.
      ctx.body = page(
        t('logout.title'),
        `<div class="spinner" aria-hidden="true"></div><h1>${esc(t('logout.title'))}</h1><p>${esc(t('logout.body'))}</p>${confirmedForm}<noscript><button type="submit" form="op.logoutForm">${esc(t('logout.fallback'))}</button></noscript><script src="/authkit/assets/logout.js"></script>`,
      );
    },

    /**
     * Mostrada apenas quando NÃO há `post_logout_redirect_uri` (senão o provider
     * redireciona o browser direto pro RP). Tela de marca em vez do default.
     */
    async postLogoutSuccessSource(ctx: any) {
      ctx.body = page(
        t('logout.success.title'),
        `<h1>${esc(t('logout.success.title'))}</h1>` + `<p>${esc(t('logout.success.body'))}</p>`,
      );
    },
  };
}
