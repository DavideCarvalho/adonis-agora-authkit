---
'@adonis-agora/authkit-react': minor
---

feat(authkit-react): client e hooks para as escritas de conta (orgs + segundo fator)

Lado React do espelho JSON de `/account/api/*`, para telas do próprio host.

- `client.account.orgs` ganha `create`, `activate`, `deactivate`, `leave`, `invite`,
  `revokeInvitation`, `updateMemberRole`, `removeMember` e `acceptInvitation`.
- `client.account.mfa` vira uma FUNÇÃO COM PROPRIEDADES: `mfa()` continua sendo a leitura do
  status (assinatura preservada) e as escritas penduram nela — `mfa.enroll()`,
  `mfa.confirm(code)`, `mfa.disable()`, `mfa.regenerateRecoveryCodes()` e
  `mfa.passkeys.{options,verify}`.
- Hooks novos: `useAccount{Create,Activate,Deactivate,Leave}OrgMutationOptions`,
  `useAccount{InviteOrgMember,RevokeOrgInvitation,AcceptOrgInvitation,UpdateOrgMemberRole,RemoveOrgMember}MutationOptions`,
  `use{Enroll,Confirm,Disable}TotpMutationOptions`,
  `useRegenerateRecoveryCodesMutationOptions` e `useRegisterPasskeyMutationOptions`. O
  prefixo `useAccount…` nos de org evita colidir com os homônimos da superfície ADMIN, que
  agem sobre qualquer org.
- `registerPasskeyJson(client, deps?)`: a cerimônia de registro de passkey inteira por
  fetch (options → `startRegistration` → verify), o par headless do `usePasskeyRegistration`
  (que é por form de página inteira e não muda). Sem React, para quem não usa TanStack.
- `authkitKeys.account.mutations.*`: as chaves das novas mutations, com prefixos `orgs()` e
  `mfa()` para `useIsMutating`.
- `AccountMfaStatus.recovery` ganha `remaining` e `regenerable`.
