---
'@adonis-agora/authkit-server': patch
---

Ações destrutivas do console admin (delete user, disable, reset-password, revoke-sessions, rotate da chave de assinatura managed) não exigiam sudo/reautenticação recente — só a sessão de admin já autenticada. Um admin com a sessão sequestrada (XSS, cookie roubado, aba esquecida logada) podia executá-las direto, sem reconfirmar a própria identidade.

`ConsoleUsersController` (`disable`, `resetPassword`, `destroy`), `ConsoleSessionsController` (`revokeAll`, `userRevokeSessions`) e `ConsoleKeysController` (`rotate`) agora exigem sudo recente via `requireSudo` — a mesma infraestrutura (`/account/confirm`) já usada pelo self-service da própria conta. Sem sudo confirmado, a API JSON responde `403 sudo_required` em vez de seguir a ação (mesmo padrão do `account/api` self-service). `enable()` (reverter um disable) continua sem gate — reabilitar uma conta não é destrutivo.

A REST Admin API (Bearer, server-to-server) fica de fora deste fix: sudo é um conceito de sessão de browser (confirmação de identidade recente do usuário), sem equivalente natural para uma API key — inventar um mecanismo novo ali é decisão em aberto, não wiring da infra existente.
