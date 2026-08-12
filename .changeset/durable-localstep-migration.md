---
"@adonis-agora/authkit-server": minor
---

durable: workflows LGPD (export/deleção de conta) migram para `ctx.localStep` — piso do peer `@adonis-agora/durable` sobe para `^0.22.0`

Os dois workflows duráveis (`defineAccountExportWorkflow`, `defineAccountDeletionWorkflow`)
usavam `ctx.step('nome', async () => { ... })` para rodar cada etapa do cascade
IN-PROCESS — coleta/persistência do export, snapshot/revoke/delete do cascade de
deleção. Isso funcionava no `@adonis-agora/durable@0.2.0` (o peer com que o
authkit foi construído), mas o engine mudou o contrato: `ctx.step` virou o
ÚNICO primitivo de dispatch remoto — sempre roteia por `callRemote` para um
handler registrado por nome — e o corpo passado deixou de ser executado; ele é
tratado como o `input` da chamada. Bumpar o peer para `^0.22.0` sem migrar o
authkit deixava os dois workflows presos em `suspended` para sempre (nenhum
worker jamais registrado sob os nomes `collect`/`audit`/`snapshot`/etc.) — 5
testes do pacote pegavam exatamente isso.

A correção real não é reescrever os steps como handlers remotos: o engine
mantém, à parte, `ctx.localStep(nome, fn, opts)` — o sucessor direto do
`ctx.step` local pré-0.8.0, checkpointado e substituído no replay sem nunca
sair do processo. Os dois workflows trocam `ctx.step` por `ctx.localStep` em
todos os 15 call sites (mesmos nomes de etapa, mesma ordem, mesmos efeitos
colaterais — só a chamada mudou), e a interface estrutural `DurableStepCtx`
(que evita acoplar o build ao peer opcional) segue o mesmo rename.

Minor: em 0.x é o bump que sinaliza quebra, e forçar 1.0.0 daria um sinal de
estabilidade que o pacote não está declarando. O `peerDependencies` sobe junto
(`^0.2.0` → `^0.22.0`) — `ctx.localStep` não existe no engine antigo, então a
combinação NOVO authkit + peer velho não resolve (o range de peer já barra
isso). Quem usa o modo durável (`accountLifecycle.durable`) precisa subir
`@adonis-agora/durable` para `^0.22.0` neste mesmo deploy.
