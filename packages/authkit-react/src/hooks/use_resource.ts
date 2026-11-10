/**
 * Faz uma requisição JSON com credenciais e header CSRF opcional.
 * Lança `Error` em status não-2xx. SSR-safe (só roda quando chamado).
 */
export async function jsonRequest<T>(
  url: string,
  init: RequestInit & { csrfToken?: string } = {},
): Promise<T> {
  const { csrfToken, headers, ...rest } = init;
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-TOKEN': csrfToken } : {}),
      ...headers,
    },
    ...rest,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.message === 'string') message = body.message;
    } catch {
      /* corpo não-JSON; mantém a mensagem padrão */
    }
    throw new Error(message);
  }
  // 204/empty
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
