---
'@adonis-agora/authkit-server': patch
---

Migra o CSS das views do host (login/consent/signup/account/*) do Tailwind 3 para o Tailwind 4 e regenera o `partials/styles.edge` commitado.

O `tailwindcss` estava travado em `3.4.19` neste pacote enquanto todo o resto do repo já tinha subido: o v4 tirou o binário `tailwindcss` do pacote principal (agora é `@tailwindcss/cli`) e derrubou a flag `-c <config>` que o `scripts/build_host_css.mjs` usava para apontar um config JS gerado em tempo de build. A configuração agora é CSS-first, num arquivo commitado (`src/host/host.css`): `@import "tailwindcss" source(none)` + `@source "./views/**/*.edge"` é o equivalente exato do `content` do config v3. O `source(none)` é o que impede a detecção automática de varrer o pacote inteiro (e arrastar para o CSS server-rendered os utilitários do SPA React em `ui/`).

Duas classes renomeadas no v4 foram traduzidas nas views, porque no v4 elas mudaram de significado em vez de sumir — trocariam o visual em silêncio:

- `shadow-sm` → `shadow-xs` (16 ocorrências). No v4 `shadow-sm` passou a valer o que o v3 chamava de `shadow`, ou seja, os cards de `account/*` e `otp-unlock` ganhariam uma sombra maior.
- `outline-none` → `outline-hidden` (20 ocorrências). No v4 `outline-none` virou `outline-style: none`; `outline-hidden` é que mantém o outline transparente do v3, inclusive o fallback de `forced-colors`.

O Preflight do v4 também deixou de aplicar `cursor: pointer` em `button`/`[role=button]`. Como todas as telas do host são formulários, isso é restaurado numa `@layer base` do `host.css` em vez de classe por classe nas views.

Renderizando as 18 views que incluem o partial lado a lado com a versão anterior, a geometria é idêntica (236 elementos, zero diferença de posição/tamanho). O que muda de fato é o que o v4 muda por padrão: a paleta passa a ser declarada em `oklch` (cinzas com desvio ≤ 3/255 em sRGB; acentos saturados como `red-600` e `green-700` ficam mais vivos), a stack de fonte sans default do v4.3 não é mais a do v3, `::placeholder` passa a ser `currentColor` a 50% em vez de `gray-400` fixo, `hover:*` agora só vale sob `@media (hover: hover)`, e `input`/`select`/`textarea` ganham fundo transparente no Preflight (sem efeito aqui: todo input das views está sobre um card `bg-white`).

O `@source` também passou a excluir o próprio `partials/styles.edge`. Ele mora dentro de `views/`, então o extrator vinha lendo os seletores do CSS gerado como se fossem classes em uso e o build se auto-alimentava: ~50 utilitários que nenhuma view referencia estavam presos no arquivo commitado se perpetuando a cada regeneração.
