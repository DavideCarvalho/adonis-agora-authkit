/**
 * Personal agents — config.
 *
 * Um PERSONAL AGENT é uma plataforma de agente (ChatGPT, Meta AI, um assistente
 * próprio…) que fala com este app EM NOME de um usuário. Ele se identifica com um
 * JWT assinado pela própria chave (publicada num JWKS) — sem segredo
 * compartilhado — e, opcionalmente, recebe do usuário uma DELEGAÇÃO: o usuário
 * loga aqui, aprova scopes definidos pelo app, e o agente passa a agir na conta
 * dele só dentro desses scopes.
 *
 * O núcleo (identidade do agente, device flow, grants, tokens de delegação,
 * recibos) não depende de protocolo; o formato do fio vem do adapter em
 * `protocol` (default: PACT — https://openpactprotocol.org). Ver `protocol.ts`.
 */

import {
  type PersonalAgentExtension,
  type ResolvedPersonalAgentExtension,
  resolvePersonalAgentExtensions,
} from './extension.js';
import {
  BUILTIN_PROTOCOLS,
  type BuiltinProtocolId,
  type PersonalAgentProtocol,
} from './protocol.js';

/** Registro de um personal agent conhecido (PACT §3.1). */
export interface PersonalAgentRegistration {
  /** Valor exato que o agente põe no `iss` do JWT. Também é o `client_id` OAuth dele. */
  issuer: string;
  /** URL HTTPS do JWKS do agente. Estável — a rotação acontece dentro do JWKS. */
  jwksUri: string;
  /** Nome exibido na tela de consentimento. Default: o host do `issuer`. */
  name?: string;
  /** `false` desabilita o agente: as requests dele passam a receber 401. Default: true. */
  enabled?: boolean;
}

/** Resolve um agente pelo `iss`. `null` = desconhecido (401). */
export type PersonalAgentResolver = (
  issuer: string,
) => PersonalAgentRegistration | null | Promise<PersonalAgentRegistration | null>;

export interface PersonalAgentDelegationConfigInput {
  /**
   * URL do endpoint do agente DESTE app que os personal agents chamam (a
   * "interface URL" do Agent Card). Vira o `aud` dos tokens de delegação — um
   * token só vale para ela.
   */
  interfaceUrl: string;
  /**
   * Scopes que o app oferece, `id → descrição`. A descrição aparece VERBATIM na
   * tela de consentimento, então escreva para o usuário final
   * (`{ 'orders:read': 'Ver seus pedidos e o status deles' }`).
   */
  scopes: Record<string, string>;
  /** TTL do token de delegação, em segundos. Default: 3600 (o PACT recomenda ≤ 1h). */
  accessTokenTtl?: number;
  /** Validade do grant (e dos refresh tokens dele), em segundos. Default: 30 dias. */
  grantTtl?: number;
  /** Validade do `device_code`/`user_code`, em segundos. Default: 600. */
  deviceCodeTtl?: number;
  /** Intervalo mínimo de polling do token endpoint, em segundos. Default: 5. */
  pollInterval?: number;
}

export interface PersonalAgentsConfigInput {
  /**
   * Protocolo do fio: um embutido pelo id (`'pact'`) ou um adapter próprio
   * (ver {@link PersonalAgentProtocol}). Default: `'pact'`.
   */
  protocol?: BuiltinProtocolId | PersonalAgentProtocol;
  /**
   * Valor que os personal agents põem no `aud` do JWT deles (PACT). Opaco e
   * atribuído por ESTE app no registro do agente — um valor por app, não
   * derivado de URL. Liga o PACT; obrigatório, a não ser num app que só usa
   * `extensions` (sem `audience`).
   */
  audience?: string;
  /**
   * Agentes aceitos: uma lista estática, ou uma função que resolve pelo `iss`
   * (para quem guarda o registro no banco). Default: nenhum.
   */
  agents?: PersonalAgentRegistration[] | PersonalAgentResolver;
  /**
   * `true` aceita QUALQUER agente cujo `iss` publique um JWKS via OIDC discovery
   * (`{iss}/.well-known/openid-configuration`), além dos registrados. A
   * verificação do JWT continua completa; só a lista de permitidos some.
   * Default: false.
   */
  open?: boolean;
  /** Delegação (PACT §5). Ausente = só identidade (o agente fala, mas não age na conta). */
  delegation?: PersonalAgentDelegationConfigInput;
  /** Prefixo das rotas (`{prefix}/oauth/*`, `{prefix}/consent`). Default: `/agents`. */
  prefix?: string;
  /**
   * Outros protocolos de personal agents, de pacotes à parte, ao lado do PACT
   * (ex.: `poppy()` de `@adonis-agora/authkit-poppy`). Ver {@link PersonalAgentExtension}.
   */
  extensions?: PersonalAgentExtension[];
}

export interface ResolvedPersonalAgentDelegationConfig {
  interfaceUrl: string;
  scopes: Record<string, string>;
  accessTokenTtl: number;
  grantTtl: number;
  deviceCodeTtl: number;
  pollInterval: number;
}

export interface ResolvedPersonalAgentsConfig {
  /** PACT ligado (`audience` configurado). */
  pact: boolean;
  protocol: PersonalAgentProtocol;
  /** `''` quando o PACT está desligado. */
  audience: string;
  resolveAgent: PersonalAgentResolver;
  /** A lista `agents` do config quando é um array (o console mostra); `null` = resolver do host. */
  staticAgents: PersonalAgentRegistration[] | null;
  open: boolean;
  delegation?: ResolvedPersonalAgentDelegationConfig;
  prefix: string;
  /** `extensions` resolvidas, na ordem do config. */
  extensions: ResolvedPersonalAgentExtension[];
}

const SCOPE_ID = /^[\x21\x23-\x5B\x5D-\x7E]+$/; // RFC 6749 §3.3 scope-token

function assertUrl(value: string, what: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(
      `authkit: personalAgents.${what} precisa ser uma URL absoluta (recebeu "${value}").`,
    );
  }
}

function positive(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`authkit: personalAgents.delegation.${what} precisa ser > 0.`);
  }
  return Math.floor(value);
}

export function normalizePersonalAgentsPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '/agents').trim().replace(/\/+$/, '');
  if (!trimmed) return '/agents';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function resolvePersonalAgentsConfig(
  input: PersonalAgentsConfigInput | undefined,
  issuer = '',
): ResolvedPersonalAgentsConfig | undefined {
  if (!input) return undefined;
  // 0.x → 1.0: o Poppy virou o pacote `@adonis-agora/authkit-poppy`.
  if ('poppy' in input) {
    throw new Error(
      'authkit: `personalAgents.poppy` saiu do authkit-server — instale `@adonis-agora/authkit-poppy` e use `personalAgents.extensions: [poppy({ ... })]`.',
    );
  }
  const pact = !!input.audience?.trim();
  if (!pact && !input.extensions?.length) {
    throw new Error(
      'authkit: personalAgents.audience é obrigatório (o `aud` dos JWTs dos agentes PACT) — ou configure só `personalAgents.extensions`.',
    );
  }
  if (!pact && input.delegation) {
    throw new Error(
      'authkit: personalAgents.delegation é do PACT e exige `personalAgents.audience`.',
    );
  }

  let resolveAgent: PersonalAgentResolver;
  let staticAgents: PersonalAgentRegistration[] | null = null;
  if (typeof input.agents === 'function') {
    resolveAgent = input.agents;
  } else {
    staticAgents = [...(input.agents ?? [])];
    const byIssuer = new Map<string, PersonalAgentRegistration>();
    for (const agent of input.agents ?? []) {
      assertUrl(agent.issuer, `agents[].issuer`);
      assertUrl(agent.jwksUri, `agents[].jwksUri`);
      byIssuer.set(agent.issuer, agent);
    }
    resolveAgent = (issuer) => byIssuer.get(issuer) ?? null;
  }

  let delegation: ResolvedPersonalAgentDelegationConfig | undefined;
  if (input.delegation) {
    const d = input.delegation;
    assertUrl(d.interfaceUrl, 'delegation.interfaceUrl');
    const ids = Object.keys(d.scopes ?? {});
    if (ids.length === 0) {
      throw new Error('authkit: personalAgents.delegation.scopes precisa de pelo menos um scope.');
    }
    for (const id of ids) {
      if (!SCOPE_ID.test(id)) {
        throw new Error(
          `authkit: personalAgents.delegation.scopes — id inválido "${id}" (sem espaços/aspas).`,
        );
      }
    }
    delegation = {
      interfaceUrl: d.interfaceUrl,
      scopes: { ...d.scopes },
      accessTokenTtl: positive(d.accessTokenTtl, 3600, 'accessTokenTtl'),
      grantTtl: positive(d.grantTtl, 30 * 24 * 3600, 'grantTtl'),
      deviceCodeTtl: positive(d.deviceCodeTtl, 600, 'deviceCodeTtl'),
      pollInterval: positive(d.pollInterval, 5, 'pollInterval'),
    };
  }

  const protocol =
    typeof input.protocol === 'object'
      ? input.protocol
      : BUILTIN_PROTOCOLS[input.protocol ?? 'pact'];
  if (!protocol) {
    throw new Error(
      `authkit: personalAgents.protocol "${String(input.protocol)}" desconhecido (embutidos: ${Object.keys(BUILTIN_PROTOCOLS).join(', ')}).`,
    );
  }

  const prefix = normalizePersonalAgentsPrefix(input.prefix);
  const extensions = resolvePersonalAgentExtensions(input.extensions, {
    issuer,
    delegationScopes: input.delegation?.scopes ? { ...input.delegation.scopes } : null,
  });
  for (const extension of extensions) {
    if (pact && (extension.prefix === prefix || extension.prefix.startsWith(`${prefix}/`))) {
      throw new Error(
        `authkit: o prefixo "${extension.prefix}" de personalAgents.extensions "${extension.id}" não pode ficar debaixo de personalAgents.prefix ("${prefix}").`,
      );
    }
  }

  return {
    pact,
    protocol,
    audience: pact ? input.audience! : '',
    resolveAgent,
    staticAgents,
    open: input.open === true,
    delegation,
    prefix,
    extensions,
  };
}

/** `"a b  c"` → `['a','b','c']` sem duplicatas, na ordem. */
export function parseScope(value: string | null | undefined): string[] {
  return [...new Set((value ?? '').split(' ').filter(Boolean))];
}

export function formatScope(scopes: Iterable<string>): string {
  return [...scopes].join(' ');
}
