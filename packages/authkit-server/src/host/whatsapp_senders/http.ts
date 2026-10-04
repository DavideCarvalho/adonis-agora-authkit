/** Never include configuration values in validation errors. */
export function requireString(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`Invalid WhatsApp sender ${field}`);
  }
}

export function recipientPhone(phone: string): string {
  if (typeof phone !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(phone)) {
    throw new Error('Invalid WhatsApp recipient phone');
  }
  return phone.replace(/^\+/, '');
}

/** Response bodies and fetch causes can contain credentials and OTPs: discard both. */
export async function postJson(
  provider: string,
  url: URL,
  headers: Record<string, string>,
  body: unknown,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw new Error(`WhatsApp code delivery failed (${provider})`);
  }
  // Do not parse or log the body, even when a provider echoes the submitted code.
  void response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw new Error(`WhatsApp code delivery failed (${provider}, HTTP ${response.status})`);
  }
}
