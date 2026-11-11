/**
 * The page a browser gets when `admin.authorize` denies the admin console
 * (403), or asks for a sign-in it cannot do itself (401). Self-contained: no
 * script and no external asset, so any CSP renders it.
 */
export function consoleDeniedPage(status: 401 | 403): string {
  const title = status === 401 ? 'Sign in required' : 'Access denied';
  const body =
    status === 401
      ? 'This console needs credentials this request did not carry.'
      : 'You do not have access to this console.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f9fafb;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
.box{max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#4b5563;font-size:14px;line-height:1.6;margin:0}
.code{font-size:12px;color:#9ca3af;margin-bottom:8px}</style>
</head><body><main class="box"><p class="code">${status}</p><h1>${title}</h1><p>${body}</p></main></body></html>`;
}
