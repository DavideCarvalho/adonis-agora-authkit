---
"@adonis-agora/authkit-server": minor
---

Host passwordless deixa de ficar TRANCADO fora de toda operação sob sudo — o default finalmente mudou

**Se o seu `config/authkit.ts` tem `authMethods: { password: false }` ou
`passwordless: { signup: true }` e a sua chamada a `registerAuthHost` NÃO passa
`sudoMethods`, você tem este bug agora, em produção, em TODA versão anterior a
esta.** São dez segundos de conferência e vale a pena fazê-la antes de continuar
lendo.

## O que estava quebrado

Sudo mode (`requireSudo`) só aceitava **senha** ou **passkey** por padrão. As duas
exigem uma credencial cadastrada ANTES. Num host passwordless não existe nenhuma:

- quem entrou por magic link ou OIDC não tem senha — e o signup passwordless
  ainda grava um hash aleatório inutilizável na coluna, então a tela mostrava um
  campo de senha que ninguém no mundo conseguia preencher;
- quem nunca cadastrou passkey não tem passkey;
- **e cadastrar passkey exige sudo.**

Resultado: essas contas ficavam permanentemente fora de **exportar os próprios
dados (LGPD), excluir a conta, ligar MFA, criar/revogar Personal Access Tokens e
trocar o e-mail** — inclusive fora do cadastro de passkey, que é o único caminho
que destravaria o resto. Deadlock fechado, e era o comportamento DEFAULT.

O `0.46.0` publicou o SPI `SudoMethod` exatamente para resolver isto, e o
changelog dele descreve o deadlock nestes termos. Mas **o default não mudou**: o
`oidcStepUp` e o `magicLink` existiam e ninguém os ligava. Quem soubesse
configurar ficava bem; quem herdasse os defaults continuava bricado. Publicar uma
capacidade não é publicar um conserto — atualizar para 0.46/0.47 não corrigia
nada. Esta versão é a que corrige.

## O que mudou por padrão

1. **`registerAuthHost` passa a montar as rotas de `magicLink()`** junto com as de
   `password()`/`passkey()`. `oidcStepUp` não pode entrar nos defaults (exige uma
   URL do host), então o magic link de sudo é o único método sem credencial
   prévia que a lib consegue montar sozinha.

2. **Montar não é oferecer.** O que a tela `/account/confirm` oferece — e o que os
   handlers aceitam, pela mesma função, para que os dois lados não possam
   divergir — passa a ser derivado do config resolvido:

   | seu config | métodos de sudo por padrão |
   |---|---|
   | senha ligada (a maioria) | `[password, passkey]` — **idêntico a antes** |
   | `authMethods: { password: false }` | `[passkey, magicLink]` |

   Um host com senha **não** passa a oferecer step-up por e-mail a quem nunca
   pediu; o endpoint do magic link fica montado e inerte. Um host que declarou
   não ter senha para de mostrar o campo de senha (naquele deployment ele é uma
   opção que não pode dar certo) e ganha um método que a conta consegue
   satisfazer.

3. **`sudoMethods.magicLink()` não depende mais do hook `mail.onSudoLink`.** Sem o
   hook, o próprio host-kit envia o e-mail pelo mailer default do app
   (`@adonisjs/mail`), com o seu branding e i18n — a mesma postura de todo outro
   e-mail da lib (reset de senha, verificação, magic link de login). Antes a
   ausência do hook tornava o método INDISPONÍVEL, e era isso que fazia o
   conserto do deadlock depender de alguém ter escrito um hook à mão. O hook
   continua tendo prioridade quando declarado. Novas chaves de i18n:
   `mail.sudo_link.*` (`en` e `pt-BR`), sobrescrevíveis como qualquer outra.

4. **Aviso alto no boot** (`console.warn`, não erro — nada deixa de subir) quando
   o seu `sudo.methods` declarado não tem um único método satisfazível por conta
   sem senha. Ele nomeia a config que disparou e as duas saídas. Só dispara com
   `sudo.methods` DECLARADO, com deployment passwordless, e quando todos os
   métodos da lista são built-in deste pacote — diante de um método customizado
   ele se cala, porque não tem como saber se aquele exige credencial prévia.

## O que NÃO mudou

- **Host com senha e sem `sudoMethods`: nada muda na experiência.** A tela segue
  oferecendo exatamente `password` + `passkey`, na mesma ordem.
- **Se você passa `sudoMethods` (ou declara `sudo.methods`), você não é afetado —
  e continua tendo de resolver isto por conta própria.** A lista é sua, ela
  SUBSTITUI os defaults, e a derivação acima **não a toca em nenhuma direção**.
  Se o seu host é passwordless e a sua lista é `[password(), passkey()]`, os seus
  usuários seguem trancados: acrescente `sudoMethods.oidcStepUp({ url:
  '/auth/step-up' })` (reautenticação no seu IdP, com o callback chamando
  `completeSudo`) ou `sudoMethods.magicLink()`. É esse o caso que o aviso do item
  4 grita no boot.
- Nenhuma assinatura pública mudou; nenhuma rota existente mudou de path.
- O token do magic link de sudo continua sendo **outro** token, de escopo sudo:
  `randomBytes(32)`, hasheado na sessão que o pediu, uso único, 5 minutos,
  vinculado à conta emissora, e nunca autentica ninguém. Nada é compartilhado com
  o token de login — só a infraestrutura de ENTREGA do e-mail.

## Limite conhecido

O aviso do item 4 só vê a lista que passou pelo **config**. Um host que declare
`sudoMethods` apenas no argumento de `registerAuthHost(router, { … })` não é
coberto: o registro de rotas acontece antes de o config lazy resolver, e
`authMethods` vive no config. É o caso de quem escreveu a lista à mão — não o de
quem herdou os defaults, que é quem o aviso existe para pegar.
