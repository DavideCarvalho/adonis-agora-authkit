export type UiPreset = 'headless' | 'edge' | 'react';

const VALID: UiPreset[] = ['headless', 'edge', 'react'];

export function resolveUiPreset(value: string | undefined): UiPreset {
  if (value === undefined) return 'edge';
  if (!VALID.includes(value as UiPreset)) {
    throw new Error(`authkit: --ui inválido "${value}". Use: ${VALID.join(' | ')}`);
  }
  return value as UiPreset;
}

/**
 * Arquivos (relativos ao stubsRoot) que o preset publica.
 *
 * As páginas React são TSX puro, SEM frontmatter `{{{ exports() }}}`: o
 * `configure` as publica via `ui/react/page.stub` + `contentsFromFile` (ver
 * `uiStubDestination`). Elas não podem passar pelo template engine dos stubs —
 * crases e `${...}` de template literal quebram a compilação (bug #194) —, e
 * como são `.tsx` o formatter reescrevia o frontmatter para `{ exports() }`,
 * que o gerador nem reconhece.
 */
export function uiStubPaths(preset: UiPreset): string[] {
  switch (preset) {
    case 'headless':
      return [];
    case 'edge':
      /**
       * Views são donas-da-lib (disco `authkit::`); nada a scaffoldar.
       *
       * Quem quer customizar usa `node ace authkit:eject --views`, que copia as
       * views REAIS de `src/host/views` — com i18n, CSRF, passkey e o CSS já
       * compilado em `partials/styles.edge`, sem nenhuma requisição externa.
       *
       * Houve stubs Edge de login/consent aqui, mas nenhum caminho de código os
       * publicava (este `case` sempre devolveu `[]`). Como código morto que
       * mesmo assim ia no pacote, ficaram para trás do resto: carregavam o
       * Tailwind Play CDN muito depois de as views da lib terem migrado para o
       * CSS compilado. Foram removidos em vez de ressuscitados — o scaffold era
       * uma duplicata inferior das views da lib (sem `_csrf`, inclusive).
       */
      return [];
    case 'react':
      return [
        'ui/react/components/auth_shell.tsx',
        'ui/react/pages/login.tsx',
        'ui/react/pages/consent.tsx',
        'ui/react/pages/signup.tsx',
        'ui/react/pages/forgot.tsx',
        'ui/react/pages/reset.tsx',
        'ui/react/pages/verify-email.tsx',
        'ui/react/pages/mfa-challenge.tsx',
        'ui/react/pages/account/login.tsx',
        'ui/react/pages/account/tokens.tsx',
        'ui/react/pages/account/mfa.tsx',
      ];
  }
}

/**
 * Destino, relativo à raiz do app, de um arquivo de `uiStubPaths('react')`:
 * `ui/react/components/*` vai para `inertia/components/*` e `ui/react/pages/*`
 * para `inertia/pages/authkit/*` (o `prefix` do `inertiaRenderer`).
 */
export function uiStubDestination(path: string): string {
  if (path.startsWith('ui/react/components/')) {
    return `inertia/components/${path.slice('ui/react/components/'.length)}`;
  }
  if (path.startsWith('ui/react/pages/')) {
    return `inertia/pages/authkit/${path.slice('ui/react/pages/'.length)}`;
  }
  throw new Error(`authkit: stub de UI sem destino conhecido: ${path}`);
}
