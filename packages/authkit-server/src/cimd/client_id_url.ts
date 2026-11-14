/**
 * `client_id` que é uma URL (OAuth Client ID Metadata Document, draft-ietf-oauth-client-id-metadata-document):
 * o documento JSON do cliente mora nela.
 */

/** URL `https:` (ou `http:` com `allowHttp`) sem credenciais nem fragmento. */
export function isHttpsUrl(value: unknown, allowHttp = false): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const schemeOk = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
    return schemeOk && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/**
 * `client_id` aceitável como URL de Client ID Metadata Document: `https:`, com um path além de
 * `/`, sem credenciais, fragmento, segmentos `.`/`..` nem caracteres de controle.
 */
export function isClientIdUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('https://') || value.includes('#')) {
    return false;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: recusa caracteres de controle crus
  if (/[\u0000- \u007f\\]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.pathname === '/' || url.pathname === '') return false;
  const rawPath = value
    .slice('https://'.length)
    .replace(/^[^/?]*/, '')
    .split('?')[0];
  return !rawPath.split('/').some((segment) => ['.', '..'].includes(segment.replace(/%2e/gi, '.')));
}

/** O host (com porta) de uma URL, em minúsculas; `null` se não é URL. */
export function urlHost(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/** `host` casa com a lista: igual a uma entrada, ou subdomínio de uma entrada `*.dominio`. */
export function hostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowHosts.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('*.') ? h.endsWith(e.slice(1)) && h.length > e.length - 1 : h === e;
  });
}
