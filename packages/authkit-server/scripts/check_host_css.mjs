/**
 * Trava o drift do CSS das views do host.
 *
 * `src/host/views/partials/styles.edge` é gerado por `build_host_css.mjs` e
 * COMMITADO (ver o cabeçalho de lá para o porquê). O risco dessa escolha é
 * silencioso e simétrico ao do bundle do WebAuthn: quem edita uma view e usa
 * uma classe nova — ou remove a última ocorrência de uma classe — não regenera
 * o partial, e a tela vai para produção com estilo faltando (ou o pacote
 * carrega utilitários mortos para sempre). Um bump do Tailwind tem o mesmo
 * efeito: o CSS servido continua sendo o da versão anterior.
 *
 * Este check regenera o partial a partir das views e do Tailwind instalados e
 * falha se o resultado divergir do que está commitado. Roda no CI
 * (`.github/workflows/ci.yml`) e localmente via
 * `pnpm --filter @adonis-agora/authkit-server check:host-css`.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const relativePath = 'src/host/views/partials/styles.edge';

// 1. Regenera o partial a partir das views + do @tailwindcss/cli instalado.
const build = spawnSync(process.execPath, ['scripts/build_host_css.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) {
  console.error('\nFalha ao gerar o CSS do host — veja o erro acima.');
  process.exit(build.status ?? 1);
}

// 2. Compara com o que está commitado. `HEAD` (e não o índice) porque o que
//    importa é o arquivo que vai ser publicado, esteja ou não já staged.
const diff = spawnSync('git', ['diff', '--exit-code', 'HEAD', '--', relativePath], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (diff.status === 0) {
  console.log(`\nOK: ${relativePath} está em dia com as views e o Tailwind instalado.`);
  process.exit(0);
}

console.error(
  `\nCSS do host defasado: ${relativePath} não corresponde às views atuais.\n\n` +
    'O arquivo é um artefato commitado de propósito, então mudar uma classe numa\n' +
    'view (ou bumpar o Tailwind) NÃO o regenera sozinho — sem este check, a tela\n' +
    'iria para produção com estilo faltando, em silêncio.\n\n' +
    'Para resolver, rode e commite o resultado:\n' +
    '  pnpm --filter @adonis-agora/authkit-server build:host-css\n' +
    `  git add packages/authkit-server/${relativePath}\n`,
);
process.exit(1);
