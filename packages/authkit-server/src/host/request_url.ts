/**
 * Path + query string da request atual, para montar um `return_to`.
 *
 * `request.url(true)` é a API do AdonisJS que inclui a query. O código antigo lia
 * `request.parsedUrl.search`, que o AdonisJS 7 não tem mais (o `parsedUrl` virou
 * `{ pathname, query }`) — todo redirect para o login perdia a query em silêncio,
 * e o usuário voltava para a página sem os parâmetros (um `user_code`, uma
 * paginação). O `search` fica como fallback para hosts/dublês que ainda o expõem.
 */
export function requestPathWithQuery(request: any): string {
  const withQuery: string = request?.url?.(true) ?? '';
  if (withQuery.includes('?')) return withQuery;
  const parsed = request?.parsedUrl;
  const legacy: string = parsed?.search ?? (parsed?.query ? `?${parsed.query}` : '');
  return `${withQuery}${legacy}`;
}
