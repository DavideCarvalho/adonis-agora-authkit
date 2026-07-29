---
"@adonis-agora/authkit-server": minor
---

Constrói os links emailados (reset de senha, magic link, desbloqueio OTP, convites de organização, verificação/troca de e-mail, avisos de segurança) a partir do `issuer` configurado, não mais do header `Host` da request — fecha um vetor de password-reset/magic-link poisoning

**Segurança.** Dezesseis pontos em nove arquivos montavam a origem do link
emailado concatenando `ctx.request.protocol()` + `ctx.request.host()`.
`Request.host()` reflete o header `Host` (ou `X-Forwarded-Host` sob proxy
confiável) — ambos client-supplied. Um atacante capaz de alcançar o servidor
diretamente (comum quando o load balancer na frente não fixa `Host`) podia
submeter um pedido de reset de senha ou magic link para o e-mail de uma
vítima com um `Host` forjado à sua escolha. A vítima recebia um e-mail
genuíno do sistema real cujo link apontava para infraestrutura controlada
pelo atacante — um token de autenticação ou de reset válido de uso único
entregue de bandeja. Isso cobre reset de senha, magic link, desbloqueio OTP e
convites de organização.

**Correção.** Novo helper `authkitOrigin(cfg)`
(`src/host/origin.ts`) deriva a origem canônica de `new URL(cfg.issuer).origin`
— a mesma origem que a lib já usa para o `rpId`/`origin` do WebAuthn. Os 16
sites foram classificados um a um (redirects em voo e usos de
`request.ip()`/`request.header()` para audit/geo ficaram de fora — não
constroem links emailados) e os 11 que estavam em controllers passaram a usar
o helper diretamente; os 5 que estavam em `default_mailer.ts`
(`sendNewLoginEmail`, `sendNewDeviceLoginEmail`, `sendEmailChangeNoticeEmail`,
`sendEmailChangedCompletedEmail`, `sendSecurityNoticeEmail`) passaram a
receber `cfg: ResolvedServerConfig` como parâmetro adicional (breaking a nível
de API interna — hosts que chamam esses exports diretamente, fora dos fluxos
padrão da lib, precisam passar `cfg`).

**Comportamento para deployments multi-hostname.** Hosts que servem o MESMO
issuer sob múltiplos hostnames públicos legítimos vão ver os links emailados
normalizarem para o hostname do issuer, em vez de seguir o `Host` da request
como antes. Para esse caso, foi adicionado o escape hatch opcional
`mail.origin` em `config/authkit.ts`: quando presente, sobrepõe o issuer como
origem dos links emailados.

**Prova por mutação:** reverter isoladamente a conversão do reset de senha e
a do magic link (uma de cada vez) faz os testes de "forged Host" correspondentes
falharem; com a conversão restaurada, ambos passam — ver
`tests/host/issuer_based_email_links.spec.ts`.

**Relacionado e deliberadamente não corrigido aqui** (ver
`plans/004-issuer-based-email-links.md`): `src/provider/build_provider.ts:273`
define `provider.proxy = true` incondicionalmente, tornando
`X-Forwarded-Proto`/`X-Forwarded-Host`/`X-Forwarded-For` autoritativos para os
endpoints OIDC independente do `trustProxy` do host — mesma família de
problema, correção separada. Tokens de reset/magic-link em texto plano na
tabela de contas e tokens de verificação/troca de e-mail sem expiração
também são achados relacionados, não fechados nesta mudança.
