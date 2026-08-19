---
"@adonis-agora/authkit-server": minor
"@adonis-agora/authkit-client": minor
"@adonis-agora/authkit-core": minor
---

Multi-tenancy: `orgId` de primeira classe no evento, `orgId`/`orgSlug`/`orgRole` na `Identity`, e o middleware `requireOrg`

Três buracos no caminho de multi-tenancy por organização, achados ao seguir o
fluxo inteiro (org criada → claim → contexto → RBAC escopado):

**1. O barramento de diagnostics não dizia QUAL org.** `redactAuditEventForDiagnostics`
dropa `metadata` inteiro por LGPD (é campo livre e carrega PII — o e-mail do
convidado, por exemplo). Só que o `orgId` dos eventos de organização vivia
justamente ali. Resultado: um assinante de `agora:authkit:organization.created`
— o provisioning do `@adonis-agora/authz`, entre outros — recebia o tipo do
evento e nada mais, o que torna o hook inútil na prática. Além disso o
`organization.created` self-service auditava só `{ slug }`, sem id nenhum.

`orgId` agora é campo de primeira classe do `AuditEvent`, preenchido nos 15
call-sites de eventos de organização (`organization.deactivated` não tem org, é
a limpeza), preservado na projeção de diagnostics junto dos demais ids opacos
(`accountId`/`actorId`/`clientId`) e incluído no corpo do webhook. A redação de
PII continua intacta: `email`, `ip` e `metadata` seguem fora do barramento.

**2. A `Identity` não expunha a org.** O tenant ativo só existia em
`identity.raw.org_id`, sem tipo, e cada app reescrevia a derivação. Agora
`identity.orgId`, `identity.orgSlug` e `identity.orgRole` são campos da
`Identity`, preenchidos por `buildIdentityFromClaims` (portanto nos três
resolvers: jwt, pat e opaque). A tabela de claims aceitas — que já existia
duplicada dentro da ponte de contexto — virou `ORG_ID_CLAIMS` +
`deriveOrgId`/`deriveOrgSlug`/`deriveOrgRole` no `authkit-core`, e a ponte
passou a consumi-la. Os aliases de IdPs de terceiros (`tid`,
`organization_id`, `tenant_id`, `active_organization_id`) continuam valendo,
agora num lugar só.

**3. Não havia como exigir org ativa.** `RequireOrgMiddleware`
(`@adonis-agora/authkit-client/require_org_middleware`) barra request
autenticada mas sem tenant. Isso importa porque "logado" e "dentro de um
tenant" são coisas distintas: sem a barreira, a request chega no controller com
tenant indefinido e a checagem escopada do authz cai no escopo GLOBAL — o pior
lugar para se cair por acidente. Fail-closed, com `mode: 'api'` (403
`no_active_organization` em vez de redirect) e `oneOf` para restringir a um
conjunto conhecido de orgs.
