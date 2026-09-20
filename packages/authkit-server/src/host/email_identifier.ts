/**
 * Normalização ÚNICA e CONSERVADORA do e-mail usado como identidade da conta.
 *
 * Faz `trim()` + `toLowerCase()` e MAIS NADA. O endereço que a pessoa digitou é a
 * identidade dela: a lib NÃO decide que `a.b@gmail.com` e `ab@gmail.com` são a
 * mesma pessoa, nem descarta o sub-endereço (`+tag`) que ela escolheu usar.
 *
 * POR QUE ISTO EXISTE: até a v0.68 o cadastro validava o e-mail com
 * `.normalizeEmail()` do VineJS (os defaults do validator.js), que para o gmail
 * REMOVE os pontos e o `+tag` do local part. A conta nascia com um endereço
 * DIFERENTE do digitado (`davi.carvalho96@gmail.com` → `davicarvalho96@gmail.com`)
 * enquanto o passo de identificador do login não normalizava NADA e buscava por
 * igualdade exata — resultado: quem tinha ponto ou `+tag` no gmail ficava
 * trancado do lado de fora, e, por o login ser à prova de enumeração, sem
 * nenhuma mensagem de erro. Uma normalização só, usada nos DOIS lados, fecha a
 * assimetria.
 *
 * Use em TODO ponto que grava ou busca a identidade: cadastro (com e sem senha),
 * "esqueci a senha", troca de e-mail, criação por admin, convite de organização,
 * import de usuários, cadastro social e o passo de identificador do login.
 *
 * As contas GRAVADAS antes disto (com o endereço mutilado, ou com maiúsculas
 * vindas de import/convite/provider social) ficam inalcançáveis pelo login, que
 * busca a forma normalizada. Elas pedem MIGRAÇÃO do endereço gravado — é o que o
 * comando `authkit:users:normalize-emails` faz (ver `commands/normalize_emails.ts`).
 * A lib não tenta adivinhar grafias no caminho do login: cada tentativa extra é
 * uma query a mais por e-mail desconhecido, que é justamente o caminho de ataque.
 */
export function normalizeEmailIdentifier(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}
