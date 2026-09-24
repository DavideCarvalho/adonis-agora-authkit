/**
 * Regras de metadata de client que dependem do TIPO de aplicação (OIDC
 * Registration §2, `application_type`) — compartilhadas pelo
 * {@link AdminClientsService} (console admin, Admin REST API, CLI, import) e pelo
 * validator Vine de `admin_validators.ts`.
 *
 * Espelham as regras que o próprio oidc-provider aplica ao montar o `Client`
 * (`helpers/client_schema.js#redirectUris`). Checamos ANTES de persistir porque o
 * provider só valida no `Client.find` — um client inválido gravado no adapter
 * vira "client não encontrado" em runtime, sem mensagem útil para quem o criou.
 *
 * `native` segue a RFC 8252 (OAuth 2.0 for Native Apps):
 *   - esquema privado (`com.example.app:/callback`, `myapp://auth`) — §7.1;
 *   - https "claimed" (universal links / app links), nunca em loopback — §7.2;
 *   - loopback `http://127.0.0.1:<qualquer porta>/…` (e `localhost`/`[::1]`) — §7.3.
 *     O provider ignora a porta do loopback na comparação do redirect (§7.3), então
 *     basta registrar `http://127.0.0.1/callback`.
 *   - client PÚBLICO: um segredo embarcado num app instalado não é segredo (§8.5).
 *     PKCE (S256) já é obrigatório para todo client neste issuer.
 */

/** Tipo de aplicação do client. `web` é o default histórico. */
export type ApplicationType = 'web' | 'native';

export const APPLICATION_TYPES = ['web', 'native'] as const;

/** Hosts loopback reconhecidos (mesma lista do oidc-provider). */
const LOOPBACKS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Esquemas NUNCA aceitos como redirect, qualquer que seja o tipo de client. */
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'vbscript:',
  'data:',
  'blob:',
  'file:',
  'about:',
]);

/**
 * Metadata inválida para o tipo de client (ex.: client nativo com secret, redirect
 * `myapp://` num client web). Os controllers traduzem em 422.
 */
export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMetadataError';
  }
}

/**
 * Problema de UMA redirect URI para o tipo de client, ou `null` quando ok.
 *
 * `applicationType` ausente = "ainda não sei" (PATCH que não mandou o tipo): só as
 * regras universais (URI absoluta, sem fragmento, esquema não proibido). A regra
 * por tipo roda depois, no service, com o tipo efetivo do client.
 */
export function redirectUriProblem(uri: string, applicationType?: ApplicationType): string | null {
  const parsed = URL.parse(uri);
  if (!parsed) return 'deve ser uma URI absoluta';
  if (uri.includes('#')) return 'não pode conter fragmento (#)';
  const { protocol, hostname } = parsed;
  if (FORBIDDEN_SCHEMES.has(protocol)) return `não pode usar o esquema ${protocol.slice(0, -1)}`;

  if (applicationType === 'web') {
    if (protocol !== 'http:' && protocol !== 'https:') {
      return 'client web só aceita URIs http/https (use applicationType "native" para apps mobile)';
    }
  } else if (applicationType === 'native') {
    if (protocol === 'http:' && !LOOPBACKS.has(hostname)) {
      return 'client nativo com http só aceita loopback (127.0.0.1, [::1] ou localhost)';
    }
    if (protocol === 'https:' && LOOPBACKS.has(hostname)) {
      return 'client nativo com https "claimed" não pode usar host loopback';
    }
  }
  return null;
}

/** Entrada mínima para {@link assertClientMetadata}. */
export interface ClientMetadataInput {
  applicationType: ApplicationType;
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}

/**
 * Valida a combinação tipo × autenticação × grants × redirects. Lança
 * {@link ClientMetadataError} na primeira violação.
 */
export function assertClientMetadata(input: ClientMetadataInput): void {
  const type = input.applicationType;
  if (type === 'native') {
    if (input.tokenEndpointAuthMethod !== 'none') {
      throw new ClientMetadataError(
        'client nativo precisa ser público (tokenEndpointAuthMethod "none", sem secret) — RFC 8252 §8.5',
      );
    }
    if (input.grantTypes.includes('client_credentials')) {
      throw new ClientMetadataError(
        'client nativo não pode usar client_credentials (não há secret para autenticar)',
      );
    }
  }
  for (const [label, uris] of [
    ['redirectUris', input.redirectUris],
    ['postLogoutRedirectUris', input.postLogoutRedirectUris],
  ] as const) {
    for (const uri of uris) {
      const problem = redirectUriProblem(uri, type);
      if (problem) throw new ClientMetadataError(`${label}: "${uri}" ${problem}`);
    }
  }
}
