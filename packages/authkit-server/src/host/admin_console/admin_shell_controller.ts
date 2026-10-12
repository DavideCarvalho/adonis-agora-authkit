import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { HttpContext } from '@adonisjs/core/http';
import { accountPath } from '../account_paths.js';
import { resolveAccountRoles } from '../account_roles.js';
import { getAdminPrefix } from '../admin_prefix.js';

// ─── Shell HTML cache ─────────────────────────────────────────────────────────

/**
 * Points to the Vite-built index.html inside build/host/ui-dist/.
 * Falls back to the old placeholder in src/host/ui/admin.html when the dist
 * is absent (dev environment without a prior build).
 */
const UI_DIST_URL = new URL('../../host/ui-dist/index.html', import.meta.url);
const UI_FALLBACK_URL = new URL('../ui/admin.html', import.meta.url);

/** Cached raw shell HTML (loaded once per process). */
let _shellHtml: string | null = null;
let _shellSource: 'dist' | 'fallback' | null = null;

async function loadShell(): Promise<{ html: string; source: 'dist' | 'fallback' }> {
  if (_shellHtml !== null && _shellSource !== null) {
    return { html: _shellHtml, source: _shellSource };
  }

  // Try the built dist first.
  try {
    _shellHtml = await readFile(UI_DIST_URL, 'utf-8');
    _shellSource = 'dist';
    return { html: _shellHtml, source: 'dist' };
  } catch {
    // Fall through to legacy placeholder.
  }

  // Try legacy placeholder.
  try {
    _shellHtml = await readFile(UI_FALLBACK_URL, 'utf-8');
    _shellSource = 'fallback';
    return { html: _shellHtml, source: 'fallback' };
  } catch {
    // Return a minimal error shell.
    const err = `<!doctype html><html><head><title>AuthKit Admin — Build Required</title>
<style>body{font-family:system-ui;background:#07070d;color:#e9e9f4;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:480px;text-align:center;padding:32px}h1{font-size:18px;margin-bottom:12px;color:#625fff}
p{color:#9292ac;font-size:13px;line-height:1.6}code{background:#12121f;border:1px solid rgba(151,151,196,.15);padding:2px 8px;border-radius:4px;font-family:monospace}</style>
</head><body><div class="box">
<h1>AuthKit Admin — Build Required</h1>
<p>The React SPA has not been built yet. Run:<br><code>pnpm --filter @adonis-agora/authkit-server build</code><br>
then restart the server.</p>
</div></body></html>`;
    _shellHtml = err;
    _shellSource = 'fallback';
    return { html: err, source: 'fallback' };
  }
}

// ─── Config injection ─────────────────────────────────────────────────────────

/**
 * Injects `window.__AUTHKIT__` into the HTML shell right after `<body>`.
 * Also rewrites `/__AUTHKIT_BASE__/` → actual adminBase so all asset URLs
 * produced by Vite (base: '/__AUTHKIT_BASE__/') resolve correctly at runtime.
 */
function prepareShell(html: string, config: Record<string, unknown>): string {
  const adminBase = config.adminBase as string;

  // 1. Rewrite the Vite placeholder base in ALL occurrences (src/href attributes).
  //    Vite puts `/__AUTHKIT_BASE__/assets/foo.js` so we rewrite `/__AUTHKIT_BASE__/`
  //    to `${adminBase}/` so asset URLs become `${adminBase}/assets/foo.js`.
  const rewritten = html.replaceAll('/__AUTHKIT_BASE__/', `${adminBase}/`);

  // 2. Inject config script right after <body>.
  const script = `<script>window.__AUTHKIT__=${JSON.stringify(config)};</script>`;
  const bodyIdx = rewritten.indexOf('<body');
  if (bodyIdx === -1) return script + rewritten;
  const closeIdx = rewritten.indexOf('>', bodyIdx);
  if (closeIdx === -1) return script + rewritten;
  return rewritten.slice(0, closeIdx + 1) + script + rewritten.slice(closeIdx + 1);
}

// ─── MIME types for static assets ────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * Controla o serving do console admin React (Missão B).
 *
 * `serve`       — serve o shell HTML (SPA) para TODAS as rotas de página do console.
 * `serveAsset`  — serve arquivos estáticos do build (JS/CSS/fonts/images) com cache.
 *
 * O shell HTML é o index.html produzido pelo Vite build em `build/host/ui-dist/`.
 * O servidor injeta `window.__AUTHKIT__` e reescreve o placeholder de base dinâmica
 * `/__AUTHKIT_BASE__/` → `${adminBase}/assets/` para que todos os imports de assets
 * Vite resolvam corretamente independente do prefixo admin configurado.
 *
 * Se o dist não existir (ambiente de dev sem build prévia), serve o placeholder HTML
 * legado de `src/host/ui/admin.html` com uma mensagem de instrução.
 */
export default class AdminShellController {
  /**
   * GET {prefix}   — serve o shell HTML da SPA.
   * GET {prefix}/* — idem (qualquer rota de página é tratada pela SPA via hash-routing).
   */
  async serve(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    // Resolve currentUser da sessão ativa.
    const { ACCOUNT_SESSION_KEY } = await import('../middleware/account_auth.js');
    const accountId = ctx.session?.get(ACCOUNT_SESSION_KEY) as string | undefined;
    let currentUser: { id: string; email: string; roles: string[] } | null = null;
    if (accountId) {
      const account = await cfg.accountStore.findById(accountId);
      if (account) {
        currentUser = {
          id: account.id,
          email: account.email,
          roles: await resolveAccountRoles(cfg, account),
        };
      }
    }

    const adminBase = getAdminPrefix();
    const authkitConfig = {
      adminBase,
      csrfToken: (ctx.request as any).csrfToken ?? null,
      locale: (cfg as any).locale ?? 'en',
      messages: cfg.messages ?? {},
      currentUser,
      endpoints: {
        api: `${adminBase}/api`,
        // Confirmação de identidade (sudo) das ações destrutivas.
        confirm: accountPath('confirm'),
      },
      features: {
        // A página de personal agents só aparece com `personalAgents` no config.
        personalAgents: !!cfg.personalAgents,
      },
    };

    const { html: rawHtml } = await loadShell();
    const html = prepareShell(rawHtml, authkitConfig);
    ctx.response.type('text/html').send(html);
  }

  /**
   * GET {prefix}/assets/:file(*) — serve assets estáticos do Vite build.
   * Os assets do Vite têm hash no nome → cache agressivo (1 ano).
   */
  async serveAsset(ctx: HttpContext) {
    // AdonisJS wildcard route `*` → params['*'] is an array of path segments.
    const wildcardParams = (ctx.request.params() as Record<string, unknown>)['*'];
    const file = Array.isArray(wildcardParams)
      ? wildcardParams.join('/')
      : String(wildcardParams ?? '');
    if (!file || file.includes('..') || file.includes('\0')) {
      return ctx.response.notFound();
    }

    const assetUrl = new URL(`../../host/ui-dist/assets/${file}`, import.meta.url);
    try {
      const content = await readFile(assetUrl);
      const ext = extname(file).toLowerCase();
      const mime = MIME[ext] ?? 'application/octet-stream';
      ctx.response
        .type(mime)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(content);
    } catch {
      ctx.response.notFound();
    }
  }
}
