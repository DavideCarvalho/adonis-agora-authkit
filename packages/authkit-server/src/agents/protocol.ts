import type { DelegationReceipt } from './delegation_service.js';

/**
 * Adapter de PROTOCOLO dos personal agents. O núcleo (identidade do agente por
 * JWT/JWKS, device flow, grants, tokens de delegação, recibos) é o mesmo em
 * qualquer protocolo; o que muda é o "fio": regras do JWT do agente, nome do
 * header de delegação, challenge do 401, bloco de descoberta, formato do
 * step-up e do recibo.
 *
 * Embutido hoje: `'pact'` (https://openpactprotocol.org, v1.0). Um protocolo da
 * MESMA família (JWT do agente + token de delegação) entra como mais um objeto
 * desta interface, passado direto em `personalAgents.protocol`.
 *
 * O Personal Agent Protocol ("Poppy", Sierra/Meta) tem outro modelo — um
 * authorization server OAuth com Sessions e tokens DPoP — e por isso não é um
 * adapter daqui: liga-se em `personalAgents.poppy` (ver `poppy/`), ao lado do
 * PACT, reaproveitando o núcleo de grants.
 */
export interface PersonalAgentProtocol {
  /** Identificador estável (`'pact'`). */
  readonly id: string;
  /** Regras do JWT com que o agente se identifica. */
  readonly identity: {
    /** Algoritmos aceitos; os demais são rejeitados antes de buscar chave. */
    algorithms: string[];
    /** Vida máxima (`exp - iat`), em segundos. */
    maxLifetimeSeconds: number;
    /** Tolerância de relógio, em segundos. */
    clockSkewSeconds: number;
  };
  /** Header (minúsculo) que carrega o token de delegação junto do JWT do agente. */
  readonly delegationHeader: string;
  /** Valor do `WWW-Authenticate` nos 401. `invalid_token` = delegação inválida. */
  challenge(error?: 'invalid_token'): string;
  /** Bloco de segurança que o app publica na descoberta (Agent Card, no PACT). */
  discovery(input: {
    deviceAuthorizationUrl: string;
    tokenUrl: string;
    metadataUrl: string;
    /** `null` = delegação desligada (só identidade). */
    scopes: Record<string, string> | null;
  }): Record<string, unknown>;
  /** Metadata da resposta que pede mais scopes ao usuário (step-up). */
  stepUp(input: {
    missingScopes: string[];
    verificationUriComplete: string;
  }): Record<string, unknown>;
  /** Metadata que carrega o recibo de uma resposta servida sob delegação. */
  receipt(receipt: DelegationReceipt): Record<string, unknown>;
}

export interface PactOptions {
  /**
   * Nome do esquema de identidade no Agent Card. Default `'platformJwt'`, o da implementação de
   * referência e da suíte de conformidade do PACT — o texto da spec diz `'paJwt'`. Os clientes
   * escolhem o esquema pelo tipo, não pelo nome, então os dois interoperam.
   */
  identitySchemeName?: string;
}

/** PACT 1.0 — §3.2 (JWT do agente), §2.1/§5.1 (Agent Card), §5.5 (step-up), §5.6 (recibo). */
export function pact(options: PactOptions = {}): PersonalAgentProtocol {
  const identity = options.identitySchemeName ?? 'platformJwt';
  return {
    id: 'pact',
    identity: { algorithms: ['ES256', 'RS256'], maxLifetimeSeconds: 300, clockSkewSeconds: 30 },
    delegationHeader: 'x-a2a-user-delegation',

    challenge(error) {
      return error ? `Bearer realm="a2a", error="${error}"` : 'Bearer realm="a2a"';
    },

    discovery({ deviceAuthorizationUrl, tokenUrl, metadataUrl, scopes }) {
      const identityScheme = { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } };
      const identityOnly = { schemes: { [identity]: { list: [] } } };
      if (!scopes) {
        return {
          securitySchemes: { [identity]: identityScheme },
          securityRequirements: [identityOnly],
        };
      }
      return {
        securitySchemes: {
          [identity]: identityScheme,
          userDelegation: {
            oauth2SecurityScheme: {
              flows: { deviceCode: { deviceAuthorizationUrl, tokenUrl, scopes: { ...scopes } } },
              oauth2MetadataUrl: metadataUrl,
            },
          },
        },
        // A entrada só-identidade FICA (§5.1): o agente sempre pode falar sem delegação.
        securityRequirements: [
          identityOnly,
          { schemes: { [identity]: { list: [] }, userDelegation: { list: [] } } },
        ],
      };
    },

    stepUp({ missingScopes, verificationUriComplete }) {
      return {
        'pact.missingScopes': missingScopes,
        'pact.verificationUriComplete': verificationUriComplete,
      };
    },

    receipt(receipt) {
      return { 'pact.receipt': { jws: receipt.jws, claims: receipt.claims } };
    },
  };
}

/** O adapter PACT com os defaults da spec. */
export const pactProtocol: PersonalAgentProtocol = pact();

/** Protocolos embutidos, pelo id aceito em `personalAgents.protocol`. */
export const BUILTIN_PROTOCOLS = { pact: pactProtocol } as const;
export type BuiltinProtocolId = keyof typeof BUILTIN_PROTOCOLS;
