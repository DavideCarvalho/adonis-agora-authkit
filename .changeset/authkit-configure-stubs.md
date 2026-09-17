---
'@adonis-agora/authkit-server': patch
---

Conserta o `node ace configure`, que quebrava em **todos** os presets, e o `config/authkit.ts` ejetado pelo preset React, que vinha com a API de identidade antiga.

O `configure` gerava os arquivos com `codemods.makeUsingStub`, e o gerador de stubs compila o `.stub` como template delimitado por crase. Qualquer crase **dentro** do stub fecha o template mais cedo e o texto seguinte passa a ser parseado como JavaScript — daí os `SyntaxError` que apareciam com o nome de um identificador qualquer do comentário (`Unexpected identifier 'views'` no stub do React, `Unexpected identifier 'id'` no do model, `Invalid or unexpected token` no da migration). Só `stubs/config/authkit.stub` compilava, e é justamente o único sem crase: era ele que fazia o `--ui=edge` avançar até o stub da migration antes de estourar.

Isso derrubava o caminho documentado de instalação (`pnpm add` → `node ace configure --ui=...`) para todo consumidor, que passava a ter que reconstruir os arquivos ejetados à mão a partir de `stubs/`.

As crases saíram dos comentários dos três stubs afetados. Junto, o `stubs/config/authkit_react.stub` deixou de declarar `findAccount`/`verifyCredentials`: essas chaves não existem no `AuthServerConfigInput` (que aceita `accountStore`) e a lib as deriva do store — o preset React ejetava um config sem `accountStore`, ou seja, sem verificação de credenciais e sem o resto do store (MFA, capabilities). Agora usa o mesmo `accountStore: lucidAccountStore(AuthUser)` do stub sem preset.

A lacuna que deixou isso passar foi de teste: nenhum spec chamava o `makeUsingStub`. O e2e da migration lê o stub direto e remove o frontmatter `{{{ ... }}}`, então o stub nunca era compilado como template. Entra `tests/stubs_compile.spec.ts`, que compila todos os `.stub` do build pelo mesmo mecanismo e falha listando os que quebram — com um caso separado para a crase, que é a causa raiz.