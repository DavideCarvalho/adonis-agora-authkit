import { randomBytes } from 'node:crypto';
import type { EnumeratedClient, OidcAdapter } from '../adapters/adapter_contract.js';
import type { OidcService } from '../provider/oidc_service.js';

/** Métodos de autenticação no token endpoint suportados pelo formulário admin. */
export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/** Métodos públicos (sem segredo) — espelham os "non-secret" do oidc-provider. */
const PUBLIC_AUTH_METHODS = new Set<TokenEndpointAuthMethod>(['none']);

/** Entrada normalizada de um client gerenciável (vinda do formulário admin). */
export interface ClientInput {
  clientId?: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /**
   * Endpoint de OIDC Back-Channel Logout do RP. Quando definido, o IdP envia um
   * `logout_token` para esta URI ao encerrar a sessão/grant do usuário (RFC 7644).
   */
  backchannelLogoutUri?: string;
  /**
   * Quando `true`, exige que o `logout_token` inclua a claim `sid`. Ignorado quando
   * `backchannelLogoutUri` não está definido.
   */
  backchannelLogoutSessionRequired?: boolean;
}

/** Client persistido, apresentado ao console admin. */
export interface AdminClient {
  clientId: string;
  confidential: boolean;
  grants: string[];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  tokenEndpointAuthMethod: string;
  /** Endpoint de OIDC Back-Channel Logout (opcional). */
  backchannelLogoutUri?: string;
  /** Exige sid no logout_token (opcional). */
  backchannelLogoutSessionRequired?: boolean;
}

/** Resultado de uma criação: o client + o secret em claro (mostrado UMA vez). */
export interface CreatedClient {
  clientId: string;
  /** undefined para public clients (sem secret). */
  clientSecret?: string;
}

/** Gera um identificador opaco no estilo do oidc-provider (~43 chars base64url). */
function randomId(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Serviço de CRUD de clients OIDC persistidos no adapter (model `Client`),
 * usado pelo console admin. Encapsula:
 *   - a montagem do payload NA FORMA EXATA que o oidc-provider espera (snake_case,
 *     igual ao que o registro dinâmico — RFC 7591 — grava);
 *   - a invalidação do cache de clients dinâmicos do provider após cada escrita
 *     (ver {@link OidcService.evictDynamicClientCache});
 *   - a enumeração via a capacidade opcional `list` do adapter.
 */
export class AdminClientsService {
  #adapter: OidcAdapter;

  constructor(private oidc: OidcService) {
    // `Client` NÃO é session-scoped: fica sempre no `AdapterClass` (default),
    // os mesmos artefatos que o oidc-provider persiste — mesmo com `session:`
    // configurado, clients continuam no backend durável.
    this.#adapter = new (oidc.config.AdapterClass as any)('Client') as OidcAdapter;
  }

  /** Indica se o adapter suporta enumeração (capacidade opcional). */
  get canList(): boolean {
    return typeof this.#adapter.list === 'function';
  }

  /** Lista os clients persistidos (vazio quando o adapter não enumera; cheque canList). */
  async list(): Promise<AdminClient[]> {
    if (this.#adapter.list) {
      const rows = await this.#adapter.list();
      return rows.map((r) => this.#present({ clientId: r.id, payload: r.payload }));
    }
    return [];
  }

  /** Lê um client persistido pelo client_id (undefined quando não existe). */
  async find(clientId: string): Promise<AdminClient | undefined> {
    const payload = await this.#adapter.find(clientId);
    if (!payload) return undefined;
    return this.#present({ clientId, payload: payload as Record<string, unknown> });
  }

  /**
   * Cria um client. Gera client_id quando não informado; gera client_secret
   * para clients confidenciais (auth method != 'none'). Retorna o secret em
   * claro UMA vez (não é recuperável depois — o payload guarda o mesmo valor).
   */
  async create(input: ClientInput): Promise<CreatedClient> {
    const clientId = (input.clientId ?? '').trim() || randomId();
    const confidential = !PUBLIC_AUTH_METHODS.has(input.tokenEndpointAuthMethod);
    const clientSecret = confidential ? randomId() : undefined;
    const payload = this.#buildPayload(clientId, input, clientSecret);
    // expiresIn 0 => sem TTL (clients são permanentes, como no registro dinâmico).
    await this.#adapter.upsert(clientId, payload, 0);
    await this.oidc.evictDynamicClientCache();
    return { clientId, clientSecret };
  }

  /**
   * Cria um client PRESERVANDO um `clientSecret` fornecido externamente (em vez de
   * gerar um aleatório). Útil para migração de clients estáticos do config, onde o
   * secret original deve ser preservado para não quebrar apps já configurados.
   *
   * Para clients públicos (auth method `none`), `providedSecret` é ignorado.
   * Lança se o `clientId` já existir no adapter — chame `find` antes.
   */
  async createWithSecret(
    input: ClientInput,
    providedSecret: string | undefined,
  ): Promise<CreatedClient> {
    const clientId = (input.clientId ?? '').trim() || randomId();
    const confidential = !PUBLIC_AUTH_METHODS.has(input.tokenEndpointAuthMethod);
    const clientSecret = confidential ? (providedSecret ?? randomId()) : undefined;
    const payload = this.#buildPayload(clientId, input, clientSecret);
    await this.#adapter.upsert(clientId, payload, 0);
    await this.oidc.evictDynamicClientCache();
    return { clientId, clientSecret };
  }

  /**
   * Atualiza metadata editável (redirect/post-logout URIs, grants, auth method)
   * PRESERVANDO o client_secret existente. Lança se o client não existe.
   */
  async update(clientId: string, input: Partial<ClientInput>): Promise<void> {
    const existing = await this.#adapter.find(clientId);
    if (!existing) throw new Error(`client ${clientId} não encontrado`);
    const previousSecret = existing.client_secret as string | undefined;

    // MERGE (PATCH de verdade): campos não enviados (undefined) preservam o valor
    // atual do client. Sem isto, um update parcial reseta tudo que não veio no body
    // (ex.: não mandar tokenEndpointAuthMethod virava confidential; não mandar
    // grantTypes derrubava token-exchange).
    const merged: ClientInput = {
      clientId,
      redirectUris: input.redirectUris ?? (existing.redirect_uris as string[]) ?? [],
      postLogoutRedirectUris:
        input.postLogoutRedirectUris ?? (existing.post_logout_redirect_uris as string[]) ?? [],
      grantTypes: input.grantTypes ?? (existing.grant_types as string[]) ?? [],
      tokenEndpointAuthMethod:
        input.tokenEndpointAuthMethod ??
        (existing.token_endpoint_auth_method as TokenEndpointAuthMethod) ??
        'client_secret_basic',
      backchannelLogoutUri:
        input.backchannelLogoutUri ?? (existing.backchannel_logout_uri as string | undefined),
      backchannelLogoutSessionRequired:
        input.backchannelLogoutSessionRequired ??
        (existing.backchannel_logout_session_required as boolean | undefined),
    };

    const confidential = !PUBLIC_AUTH_METHODS.has(merged.tokenEndpointAuthMethod);
    // Mantém o secret atual se continua confidencial; se virou public, remove-o.
    const clientSecret = confidential ? (previousSecret ?? randomId()) : undefined;
    const payload = this.#buildPayload(clientId, merged, clientSecret);
    await this.#adapter.upsert(clientId, payload, 0);
    await this.oidc.evictDynamicClientCache();
  }

  /**
   * Regenera o client_secret de um client confidencial, preservando o resto da
   * metadata. Retorna o novo secret em claro (mostrado UMA vez). Lança se o
   * client não existe ou é public (auth method 'none').
   */
  async regenerateSecret(clientId: string): Promise<string> {
    const existing = await this.#adapter.find(clientId);
    if (!existing) throw new Error(`client ${clientId} não encontrado`);
    const authMethod = (existing.token_endpoint_auth_method as string) ?? 'client_secret_basic';
    if (PUBLIC_AUTH_METHODS.has(authMethod as TokenEndpointAuthMethod)) {
      throw new Error(`client ${clientId} é public — não possui secret`);
    }
    const clientSecret = randomId();
    const payload = { ...existing, client_secret: clientSecret };
    await this.#adapter.upsert(clientId, payload, 0);
    await this.oidc.evictDynamicClientCache();
    return clientSecret;
  }

  /** Remove um client persistido e invalida o cache. */
  async delete(clientId: string): Promise<void> {
    await this.#adapter.destroy(clientId);
    await this.oidc.evictDynamicClientCache();
  }

  /**
   * Monta o payload na forma snake_case que o oidc-provider espera/persiste —
   * verificada contra o que o registro dinâmico (RFC 7591) grava. As chaves de
   * metadata não enviadas (subject_type, id_token_signed_response_alg, etc.) são
   * preenchidas pelo Schema do provider ao construir o Client em `find`.
   */
  #buildPayload(
    clientId: string,
    input: ClientInput,
    clientSecret: string | undefined,
  ): Record<string, any> {
    const grantTypes = input.grantTypes.length
      ? input.grantTypes
      : ['authorization_code', 'refresh_token'];
    // response_types: 'code' quando o fluxo de authorization_code está presente.
    const responseTypes = grantTypes.includes('authorization_code') ? ['code'] : [];
    const payload: Record<string, any> = {
      client_id: clientId,
      redirect_uris: input.redirectUris,
      post_logout_redirect_uris: input.postLogoutRedirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: input.tokenEndpointAuthMethod,
    };
    if (clientSecret) payload.client_secret = clientSecret;
    if (input.backchannelLogoutUri) {
      payload.backchannel_logout_uri = input.backchannelLogoutUri;
      if (input.backchannelLogoutSessionRequired !== undefined) {
        payload.backchannel_logout_session_required = input.backchannelLogoutSessionRequired;
      }
    }
    return payload;
  }

  /** Projeta um payload persistido para a forma exibida no console admin. */
  #present(row: EnumeratedClient): AdminClient {
    const p = row.payload;
    const authMethod = (p.token_endpoint_auth_method as string) ?? 'client_secret_basic';
    const result: AdminClient = {
      clientId: row.clientId,
      confidential: !!p.client_secret,
      grants: (p.grant_types as string[]) ?? ['authorization_code', 'refresh_token'],
      redirectUris: (p.redirect_uris as string[]) ?? [],
      postLogoutRedirectUris: (p.post_logout_redirect_uris as string[]) ?? [],
      tokenEndpointAuthMethod: authMethod,
    };
    if (p.backchannel_logout_uri) {
      result.backchannelLogoutUri = p.backchannel_logout_uri as string;
      result.backchannelLogoutSessionRequired =
        (p.backchannel_logout_session_required as boolean | undefined) ?? false;
    }
    return result;
  }
}
