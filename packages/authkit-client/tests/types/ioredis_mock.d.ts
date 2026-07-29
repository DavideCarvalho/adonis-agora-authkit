/**
 * Shim de tipos para `ioredis-mock`, usado só pelos dois specs e2e.
 *
 * POR QUE EXISTE — e por que NÃO é "falta instalar o @types".
 * `@types/ioredis-mock@8.2.7` está instalado. Só que ele entrou como *peer
 * dependency do próprio `ioredis-mock`*, e portanto mora dentro do diretório
 * isolado do pnpm:
 *
 *   node_modules/.pnpm/ioredis-mock@8.13.1_@types+ioredis-mock@8.2.7_.../node_modules/@types/ioredis-mock
 *
 * O TypeScript resolve `@types/*` subindo por `node_modules/@types` a partir do
 * arquivo que importa. Aqui isso visita `packages/authkit-client/node_modules/@types`
 * (que só tem `node`) e depois a raiz do worktree (que não tem `node_modules/@types`
 * nenhum). O caminho do store do pnpm nunca entra nessa busca — então as
 * declarações existem em disco e são inalcançáveis, e o `import RedisMock from
 * 'ioredis-mock'` cai em TS7016.
 *
 * O CONSERTO DE VERDADE é declarar `@types/ioredis-mock` como devDependency
 * DIRETA de quem importa (`authkit-client` e `authkit-server`, que sozinho tem
 * ~40 erros da mesma classe). Isso é mudança de install/lockfile, deliberadamente
 * fora do escopo deste plano.
 *
 * Enquanto isso, este shim declara só o que os specs usam: `new RedisMock()`. Ele
 * NÃO reproduz a superfície do ioredis — nem `ioredis` é resolvível a partir
 * daqui — e é estreito de propósito: qualquer uso além do construtor vai falhar e
 * forçar a decisão acima em vez de silenciar mais um caso.
 */
declare module 'ioredis-mock' {
  const RedisMock: new (options?: { data?: Record<string, unknown> }) => Record<string, unknown>;
  export default RedisMock;
}
