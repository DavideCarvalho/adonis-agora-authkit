/**
 * Redireciona para `url` EXATAMENTE como a lib a montou.
 *
 * O starter do AdonisJS liga `redirect.forwardQueryString: true` no `config/app.ts`: todo
 * `response.redirect(url)` passa a colar a query da request ATUAL no fim — e numa URL que já tem a
 * dela, sai um destino quebrado (`/login?return_to=%2Fx%3Fa%3D1?a=1`). O argumento
 * `forwardQueryString = false` do `redirect()` não desliga o que veio do config; só o
 * `clearQs()` do builder desliga. Toda URL que a lib monta já carrega a query que precisa.
 *
 * Fora de uma Response do AdonisJS (dublês de teste), cai no `redirect(url)` de sempre.
 */
export function redirectExact(response: any, url: string): unknown {
  if (typeof response?.getStatus === 'function') {
    return response.redirect().clearQs().toPath(url);
  }
  return response.redirect(url);
}
