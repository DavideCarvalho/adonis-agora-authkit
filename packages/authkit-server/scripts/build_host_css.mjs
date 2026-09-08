/**
 * Gera o CSS estático das views do host (login/account/admin) com o
 * Tailwind CLI e embute num partial Edge (`partials/styles.edge`).
 *
 * Substitui o Tailwind Play CDN (<script src="https://cdn.tailwindcss.com">),
 * que gerava o CSS em runtime no browser e causava FOUC (flash de página
 * sem estilo) em todas as telas server-rendered.
 *
 * O partial gerado é commitado: muda apenas quando as classes usadas nas
 * views mudam, e assim o pacote funciona tanto a partir de `src/` (dev)
 * quanto de `build/` (publicado) sem passo extra.
 *
 * Tailwind 4: o CLI saiu do pacote `tailwindcss` para `@tailwindcss/cli` e a
 * flag `-c <config>` não existe mais — a configuração é CSS-first, então o
 * `content` do config v3 virou o `@source` de `src/host/host.css`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'authkit-css-'));

const input = join(root, 'src/host/host.css');
const output = join(tmp, 'host.css');

execFileSync('npx', ['@tailwindcss/cli', '-i', input, '-o', output, '--minify'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});

const css = readFileSync(output, 'utf-8');
rmSync(tmp, { recursive: true, force: true });

/**
 * Edge interpreta `{{ … }}`; CSS minificado nunca deve conter `{{`,
 * mas se algum dia contiver, é melhor quebrar o build do que publicar
 * um partial corrompido.
 */
if (css.includes('{{')) {
  throw new Error('Generated CSS contains "{{" — would break the Edge partial');
}

const partialDir = join(root, 'src/host/views/partials');
mkdirSync(partialDir, { recursive: true });
writeFileSync(
  join(partialDir, 'styles.edge'),
  `{{-- Gerado por scripts/build_host_css.mjs — não editar à mão. --}}\n<style>${css}</style>\n`,
);

console.log(`host css: ${(css.length / 1024).toFixed(1)} KB → src/host/views/partials/styles.edge`);
