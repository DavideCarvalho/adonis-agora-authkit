---
"@adonis-agora/authkit-server": minor
---

Novo `realAccountId(ctx)` — o id do humano real, para checagens de permissão que impersonation não pode enganar

**Se o seu app tem um role check, leia isto.** Durante uma impersonation ativa,
`getAccountId(ctx)` devolve a conta **PERSONIFICADA**, não o admin que a
personificou. Isso é correto para "como qual conta este request está agindo?" —
e é a entrada **ERRADA** para "esta pessoa pode fazer isto?". Um gate escrito
como `hasRole(getAccountId(ctx), 'admin')` erra nos dois sentidos: entrega os
privilégios do admin a quem está sendo personificado (quando o alvo é admin) e
tira do admin real o próprio acesso (quando não é).

**O padrão que isto substitui.** Auditando um app real encontramos a mesma
expressão copiada à mão em quatro gates de autorização de produção — o
`governanceAuthorize` do agent, o gate do dashboard durable, o middleware de
`/admin` e o listener que concede role:

```ts
const realId = impersonationState(ctx).impersonatorId ?? getAccountId(ctx)
```

Um dos quatro carregava um comentário avisando que inverter a ordem do `??`
removeria a proteção. Expressão de segurança cuja correção depende da ordem dos
operandos, copiada em quatro arquivos, é uma API da lib que ainda não tinha
nome. Agora tem:

```ts
import { realAccountId } from '@adonis-agora/authkit-server'

const id = realAccountId(ctx)
if (!id || !(await authz.hasRole(id, 'admin'))) throw new Error('forbidden')
```

```
impersonation ativa  → o id do impersonator (o admin real)
sem impersonation    → o id da conta logada
sem sessão           → null
```

**Qual dos dois usar.**

| Pergunta | Helper |
| --- | --- |
| "esta pessoa pode fazer isto?" (role, permissão, aprovação, auditoria de quem agiu) | `realAccountId(ctx)` |
| "como qual conta este request está agindo?" (queries com escopo no alvo, UI, banner de impersonation) | `getAccountId(ctx)` |

**`getAccountId` não mudou** — nada no seu app quebra com esta versão. Isto é
uma adição: o comportamento efetivo/aparente dele é contrato do qual a UI, o
banner e as queries com escopo no alvo dependem. A migração é sua: troque
`getAccountId` por `realAccountId` nas decisões de autorização, e só nelas.
