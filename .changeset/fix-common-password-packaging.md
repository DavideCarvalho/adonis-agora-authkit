---
"@adonis-agora/authkit-server": patch
---

Corrige a checagem de senhas comuns (common-password block), que era um no-op em toda release publicada

A checagem offline de senhas comuns (`isCommonPassword`, usada por
`assertAcceptable` no signup, na criação de usuário via admin, no reset e na
troca forçada/self-service de senha) nunca funcionou em nenhum pacote
publicado: o build copiava `common_passwords.txt` para `build/password/`,
mas `tsc` emite o módulo que lê o arquivo para `build/src/password/` — um
diretório diferente. `dirname(import.meta.url)` dentro do módulo compilado
nunca encontrava o `.txt`, e o fail-safe (correto e necessário — um asset
ausente não deve quebrar login) silenciosamente virava um `Set` vazio. Em
todo host publicado, `password`, `123456` e o restante do top-10000 eram
aceitos, a menos que o HIBP estivesse configurado *e* acessível — e o HIBP
também é fail-open.

Correção: o build agora copia o `.txt` para o diretório correto
(`build/src/password/`), e `loadCommonPasswords` passou a resolver o
arquivo por uma lista de candidatos (caminho-irmão primeiro, depois o
layout antigo, depois `src/`), para sobreviver a uma futura mudança de
`rootDir`/`outDir` sem quebrar de novo silenciosamente. O fail-safe
(`Set` vazio quando o arquivo não é encontrado em nenhum candidato)
continua intacto.

Consequência para quem já usa a lib: senhas fracas que antes eram aceitas
(por exemplo `password`, `123456`, `qwerty`) passam a ser rejeitadas em
**novas** escritas de senha (signup, reset, troca de senha). Hashes já
armazenados não são tocados — nenhum usuário existente é bloqueado por
essa mudança.
