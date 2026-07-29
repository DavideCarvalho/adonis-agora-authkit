---
"@adonis-agora/authkit-server": patch
---

`oidcRpGuard`: requisição não autenticada virava **500** em vez de 401/redirect, e `check()` reportava queda de banco como "não logado"

Três defeitos no `oidcRpGuard`, todos presentes desde a **0.54.0** — a versão que
introduziu o guard. Se você plugou `oidcRpGuard()` em `config/auth.ts`, os três
te afetam.

## 1. Um visitante não autenticado recebia 500, não 401

O guard lançava `new RuntimeException('Unauthorized', { cause: 'E_UNAUTHORIZED_ACCESS' })`
— uma exceção **genérica** carregando uma STRING em `cause`. Nada no framework
casa com essa string: o `E_UNAUTHORIZED_ACCESS` de verdade é uma CLASSE, com
`static status = 401`, um campo `redirectTo` e renderers html/json/jsonapi. O
`RuntimeException` não tem nada disso.

**Sintoma:** por trás de `middleware.auth()`, uma visita sem sessão a qualquer
rota protegida caía no handler de erro genérico do host e respondia **500**, com
stack trace em vez da página de login. Em ambiente de dev isso aparece como
"Unauthorized" numa tela de erro 500; em produção, como um 500 seco.

**Correção:** os dois pontos de falha de `authenticate()` (sem `account_user_id`
na sessão; sessão válida mas usuário inexistente no provider) agora lançam o
`E_UNAUTHORIZED_ACCESS` real do `@adonisjs/auth` — status 401, tratado pelo
exception handler exatamente como o dos guards nativos. O `getUserOrFail()`
também passa a lançar essa classe depois de uma tentativa de autenticação (a
mensagem continua a mesma).

**Follow-up conhecido — o redirect para o login ainda não acontece.** Os
renderers do `E_UNAUTHORIZED_ACCESS` são indexados por `guardDriverName`, e só a
entrada `session` faz `redirect().withIntendedUrl().toPath(error.redirectTo)`.
Como o `driverName` deste guard é `oidc_rp`, o `handle()` cai no fallback e
responde um **401 seco** (correto, mas sem redirect). Expor um `redirectTo` na
config do guard seria inerte enquanto o renderer não for endereçado — fica como
mudança separada. O ganho desta versão é 500 → 401.

## 2. `check()` engolia TUDO, inclusive falha de infraestrutura

Era `try { await this.authenticate() } catch { return false }`. Uma queda do
Postgres dentro de `provider.findById` retornava `false` — indistinguível de
"não está logado".

**Sintoma:** durante uma indisponibilidade do banco, **todo mundo aparecia
deslogado**, sem nenhum erro nos logs vindo desse caminho. O incidente parecia
um bug de sessão.

**Correção:** igual ao `SessionGuard` nativo do `@adonisjs/auth` — engole
**apenas** `E_UNAUTHORIZED_ACCESS` e relança o resto. `check()` continua
retornando `false` para "sem sessão"; erro de infraestrutura agora propaga.

## 3. `@adonisjs/auth` estava virando peer obrigatório na prática

`src/host/oidc_rp_guard.ts` tinha um import **estático** de `@adonisjs/auth`
(para `symbols`), e esse módulo é reexportado pelo `index.ts` do pacote. Ou seja:
`import '@adonis-agora/authkit-server'` quebrava com `ERR_MODULE_NOT_FOUND` em
qualquer host que não tivesse instalado `@adonisjs/auth` — que é um peer
**opcional**. (O smoke de empacotamento do monorepo não pegava porque o pacote
está instalado como devDep aqui.)

**Correção:** todo import de `@adonisjs/auth` neste módulo passou a ser
type-only; o único acesso de runtime é um `await import('@adonisjs/auth')` dentro
do resolver de `oidcRpGuard()` — que só roda quando o host resolve o
`config/auth.ts`, ou seja, quando ele já escolheu usar `@adonisjs/auth`. Se o
pacote não estiver instalado, o erro agora é uma mensagem explicando o que
instalar, no boot, em vez de um crash de import.
