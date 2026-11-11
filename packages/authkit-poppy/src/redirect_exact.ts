/**
 * Redireciona para `url` EXATAMENTE como montada: o `redirect.forwardQueryString: true` do starter
 * do AdonisJS colaria a query da request atual no fim. Fora de uma Response do AdonisJS (dublês de
 * teste), cai no `redirect(url)` de sempre. (O mesmo do authkit-server.)
 */
export function redirectExact(response: any, url: string): unknown {
  if (typeof response?.getStatus === 'function') {
    return response.redirect().clearQs().toPath(url);
  }
  return response.redirect(url);
}
