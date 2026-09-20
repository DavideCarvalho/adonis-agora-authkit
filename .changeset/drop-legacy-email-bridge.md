---
'@adonis-agora/authkit-server': minor
---

feat(authkit-server)!: a ponte de compatibilidade de e-mail sai; entra a migração `authkit:users:normalize-emails`

**PASSO OBRIGATÓRIO DE UPGRADE.** Quem tem contas criadas antes da 0.69 precisa rodar
`node ace authkit:users:normalize-emails --apply` ao subir esta versão. Sem isso, **toda
conta gravada com o endereço mutilado (ou com maiúsculas) fica inalcançável** — e, por o
login ser à prova de enumeração, sem nenhuma mensagem de erro para o dono dela.

**O que saiu.** A ponte `login.legacyEmailFallback` (0.70), que no login tentava o endereço
exatamente como digitado e a normalização legada do validator.js quando a forma normalizada
não achava conta. Saíram com ela: a opção de config, `legacyNormalizeEmailIdentifier`,
`resolveEmailIdentifier`, os tipos `EmailIdentifierLookup` e `ResolvedEmailIdentifier`, a
segunda chave de sessão do login (`authkit_login_email_lookup`) e o `options.legacyFallback`
de `importUsers`. Um `login: { legacyEmailFallback: ... }` no config vira uma chave
desconhecida (ignorada) — apague-a. Fica **uma** normalização, `normalizeEmailIdentifier`
(`trim` + `toLowerCase`), e a busca direta por ela.

**O que entrou.** `authkit:users:normalize-emails`: varre as contas, calcula a forma
normalizada e, por padrão, **só relata** — quantas mudariam, quais, e as **colisões** (duas
contas que colapsam no mesmo endereço). Com `--apply` grava, **recusando-se a tocar em
qualquer conta envolvida numa colisão** e listando-as para decisão humana: a migração nunca
funde contas nem escolhe vencedor. Sai com código != 0 quando sobram colisões. A escrita
usa a capacidade nova `AccountEmailRewriteCapability` (`rewriteAccountEmail`, presente no
store Lucid; probe por `supportsAccountEmailRewrite`) — que não manda e-mail, não pede
confirmação e **não mexe em `email_verified_at`**, porque a caixa postal é a mesma, só a
grafia gravada muda. Store sem a capacidade: o relatório funciona e o `--apply` recusa.

**Por quê.** A ponte eram ~120 linhas de compatibilidade, uma opção de config, uma segunda
chave de sessão e uma chamada em cada ponto que resolve e-mail (login, cadastro, social,
admin, import) para um problema que se resolve UMA vez, no banco. E ela cobrava caro no pior
lugar: buscas extras a cada e-mail desconhecido no login, que é o caminho de ataque.

**Anti-enumeração intacta** — na verdade, mais apertada: o passo de identificador agora não
consulta o account store nenhuma vez (a ponte consultava), então não há nem diferença de
tempo entre "achei" e "não achei". A tela continua mostrando o que a pessoa digitou e o
passo 1 continua respondendo o mesmo redirect incondicional.
