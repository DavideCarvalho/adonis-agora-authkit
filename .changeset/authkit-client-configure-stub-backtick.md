---
'@adonis-agora/authkit-client': patch
---

`node ace configure @adonis-agora/authkit-client` sempre crashava com `SyntaxError: Unexpected identifier 'resolveRoles'`. O stub publicado (`config/authkit_client.stub`) tinha um comentário com o nome `resolveRoles` entre crases (markdown-style), e o codemod de stubs (`tempura`) compila o conteúdo bruto do stub envolvendo-o numa template literal JS — a crase não-escapada fechava essa literal cedo. Removidas as crases do comentário (não havia motivo funcional para elas ali). Adicionado um teste que compila TODO `.stub` publicado do pacote via `tempura`, para pegar essa classe de regressão automaticamente em vez de só checar a existência do arquivo.
