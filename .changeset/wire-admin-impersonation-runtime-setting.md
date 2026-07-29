---
"@adonis-agora/authkit-server": minor
---

A setting de runtime `admin_impersonation` passa a ter leitor — governa o painel do console

`resolveEffectiveAdminImpersonation` existia, a key `admin_impersonation` podia
ser escrita pelo console/Admin API/CLI, travada pelo `defineConfig` e validada —
e **nenhum caminho de produção a lia**. Os únicos referenciadores eram testes e o
CLI de settings. Ou seja: o admin mexia num interruptor que não fazia nada.

`src/host/admin_console/console_impersonation_controller.ts` agora consulta a
setting. As duas camadas são propositalmente assimétricas:

1. `config.admin.impersonation` decide se a CAPACIDADE existe. É decisão de boot:
   é ela que registra (ou não) o grant RFC 8693 no provider OIDC. Uma setting de
   runtime não desregistra rota que nunca foi registrada.
2. `admin_impersonation` decide se o CONSOLE OFERECE o painel. Decisão de
   runtime, mudável sem redeploy.

**A setting só APERTA, nunca AFROUXA.** Duas barreiras independentes: o gate de
config é checado ANTES dela (`impersonation: false` → 404 mesmo com a setting em
`true`), e declarar `admin.impersonation` no `defineConfig` TRAVA a key, fazendo
`getSetting` devolver null e o resolver cair no valor do config. Config > runtime,
a mesma precedência do resto da lib.

**Consequência da atualização:** em instalações que NÃO declaram
`admin.impersonation` no `defineConfig` (a capacidade fica ligada por
back-compat) e que já têm `admin_impersonation: { enabled: false }` gravado em
`auth_settings`, o painel do console passa a responder 404 — antes o valor era
ignorado. O grant RFC 8693 em si não muda: quem chama o token endpoint direto
segue funcionando. Sem a tabela `auth_settings`, nada muda (fail-safe → config).
