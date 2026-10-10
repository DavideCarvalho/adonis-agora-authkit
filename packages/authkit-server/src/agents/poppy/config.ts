/**
 * @experimental Draft 0.1 da spec (https://personalagentprotocol.org/docs/spec) — pode mudar de forma
 *   incompatível fora de majors enquanto a spec for draft.
 *
 * Personal Agent Protocol ("Poppy", Draft 0.1 — https://personalagentprotocol.org) — config.
 *
 * Poppy é o segundo protocolo de personal agents ao lado do PACT. O modelo é
 * outro: em vez de um JWT do agente em cada request + um token de delegação, a
 * empresa (este app) roda um authorization server OAuth com SESSÕES — o agente
 * se identifica pelo `client_id` (uma URL HTTPS com o documento de metadata
 * dele), começa uma Session deslogada com uma asserção JWT, e o usuário entra
 * na conta por Direct (código + PKCE), Device (RFC 8628) ou Mediated Sign-In.
 * Os tokens de sessão são opacos e presos a uma chave por DPoP (RFC 9449);
 * Bearer só no MCP.
 *
 * Reaproveita o núcleo de delegação: o Account Token é um grant na tabela de
 * grants de personal agents (`auth_agent_grants`) — lista e revogação no console
 * de conta são as mesmas do PACT — e os scopes aprovados viram os `scopes` do
 * principal (que o `@adonis-agora/agent` mapeia para roles `scope:<id>`).
 */
import type { HttpContext } from '@adonisjs/core/http';

/** Scopes amplos definidos pelo protocolo (§4.4). */
export const POPPY_READ = 'poppy:read';
export const POPPY_WRITE = 'poppy:write';

/** Descrições default dos scopes do protocolo — o que a tela de consentimento mostra. */
export const POPPY_SCOPE_DESCRIPTIONS: Record<string, string> = {
  [POPPY_READ]: 'View your account information, such as orders and bookings',
  [POPPY_WRITE]: 'Make changes on your account, such as exchanging an item or updating a booking',
};

export type PoppySignInType = 'direct' | 'device' | 'mediated';

/** Um campo de credencial do Mediated Sign-In (§4.7). */
export interface PoppyMediatedField {
  /** Chave que o agente manda em `credentials`. */
  name: string;
  /** O que pedir ao usuário. */
  label: string;
  /** Valor que o agente precisa proteger (senha, PIN). */
  secret: boolean;
}

/** Entrada do callback que verifica as credenciais do Mediated Sign-In. */
export interface PoppyMediatedVerifyInput {
  credentials: Record<string, string>;
  /** Scopes pedidos (já validados contra os do tipo mediated). */
  scopes: string[];
  /** `client_id` do personal agent. */
  clientId: string;
  /** User ID que o agente deu ao usuário (opaco). */
  userId: string;
  sessionId: string;
  ctx: HttpContext;
}

/**
 * Resultado do callback de credenciais. Nunca devolva as credenciais.
 *
 * - `complete`: credenciais certas, nada mais a fazer — a Session entra na conta.
 * - `code_required`: o app MANDOU um código de uso único (SMS, e-mail, WhatsApp…)
 *   e o agente precisa submetê-lo. Ou devolve o `code` que mandou (a lib guarda
 *   só o hash e confere), ou deixa sem `code` e implementa `verifyCode` (ex.: um
 *   serviço de OTP que confere do lado dele). `state` é opaco e volta no
 *   `verifyCode`.
 * - `failed`: senha errada, conta bloqueada…
 */
export type PoppyMediatedResult =
  | { status: 'complete'; accountId: string }
  | {
      status: 'code_required';
      accountId: string;
      /** Texto para o usuário: "Text to the phone number ending in 71". */
      sentTo: string;
      code?: string;
      state?: unknown;
    }
  | { status: 'failed' };

/**
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — pode mudar de forma incompatível enquanto a spec for draft.
 */
export interface PoppyMediatedConfigInput {
  /** Campos pedidos (§4.7). Ex.: `[{ name: 'email', … }, { name: 'password', secret: true, … }]`. */
  fields: PoppyMediatedField[];
  /** Scopes que o Mediated Sign-In pode conceder. Default: `['poppy:read']`. */
  scopes?: string[];
  /** Confere as credenciais (e, se for o caso, manda o código). */
  verify: (input: PoppyMediatedVerifyInput) => Promise<PoppyMediatedResult>;
  /**
   * Confere um código quando `verify` devolveu `code_required` SEM `code`.
   * `true` = código certo.
   */
  verifyCode?: (input: {
    code: string;
    accountId: string;
    state: unknown;
    clientId: string;
    userId: string;
  }) => Promise<boolean>;
  /** Validade do sign-in pendente de código, em segundos. Default: 600. */
  codeTtl?: number;
  /** Tentativas de código antes de `failed`. Default: 5. */
  maxCodeAttempts?: number;
}

/** Uma entrada de `agent.protocols` (§3.1, §7.1). */
export interface PoppyAgentProtocolEntry {
  /** `'poppy'` para as conversas deste protocolo (§7). */
  type: string;
  /** URL HTTPS do endpoint de conversas. */
  endpoint: string;
  /** Exige tokens emitidos para este `resource` (§4.3). */
  resource?: string;
}

/** Uma entrada de `apis` (§3.1, §6). */
export interface PoppyApiEntry {
  type: 'openapi' | 'mcp' | (string & {});
  url: string;
  description: string;
  /** Exige tokens emitidos para este `resource` (§4.3). MCP sempre exige o próprio `url`. */
  resource?: string;
}

/** Hook de login do navegador do agente (§5) para apps com sessão de login própria. */
export type PoppyBrowserLogin = (
  ctx: HttpContext,
  input: {
    sessionId: string;
    clientId: string;
    userId: string;
    /** Conta da Session quando ela está logada; `null` = Session deslogada. */
    accountId: string | null;
    scopes: string[];
  },
) => Promise<void>;

/**
 * Onde o protocolo guarda os `jti` já vistos (asserções, client assertions,
 * provas DPoP, asserções de navegador) até expirarem. `claim` devolve `true` na
 * primeira vez que vê a chave e `false` num replay.
 *
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
 *   de forma incompatível fora de majors enquanto ela for draft.
 */
export interface PoppyReplayStore {
  claim(key: string, expiresAt: Date): Promise<boolean>;
}

/** Limitador de taxa: `null` = passa; número = segundos até tentar de novo (429). */
export type PoppyLimiter = (input: {
  action: 'session' | 'mediated';
  key: string;
}) => Promise<number | null>;

export interface PoppyClientsConfigInput {
  /**
   * `true` = só agentes registrados (`registered`) iniciam Sessions; os demais
   * levam `invalid_client` (§4.1). Default: false — qualquer `client_id` com um
   * documento de metadata válido.
   */
  requireRegistration?: boolean;
  /** `client_id`s registrados fora de banda (lista ou função, para quem guarda no banco). */
  registered?: string[] | ((clientId: string) => boolean | Promise<boolean>);
  /** `client_id`s bloqueados (revogados por mau uso). */
  blocked?: string[] | ((clientId: string) => boolean | Promise<boolean>);
}

/**
 * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — pode mudar de forma incompatível enquanto a spec for draft.
 */
export interface PoppyConfigInput {
  /** Nome exibido e domínio (`organization` do poppy.json). */
  organization: {
    name: string;
    /** Domínio da empresa (sem esquema). O poppy.json só é servido nele (ignorando `www.`). */
    domain: string;
    /** Outros domínios da mesma empresa (um por país…) — também vão para `poppy_domains`. */
    aliases?: string[];
  };
  /** Prefixo das rotas e path do issuer. Default: `/poppy`. */
  prefix?: string;
  /**
   * Scopes próprios do app (`custom_scopes`), `id → descrição para o usuário`.
   * Default: os de `personalAgents.delegation.scopes`, quando houver — um
   * catálogo só para os dois protocolos. Não podem começar com `poppy:`.
   */
  scopes?: Record<string, string>;
  /** Oferece os scopes amplos `poppy:read`/`poppy:write`. Default: true. */
  broadScopes?: boolean;
  /** Descrições próprias para `poppy:read`/`poppy:write` na tela de consentimento. */
  broadScopeDescriptions?: Partial<Record<'poppy:read' | 'poppy:write', string>>;
  /** Tipos de sign-in. `false` desliga; um array restringe os scopes do tipo. */
  signIn?: {
    /** Default: todos os scopes. */
    direct?: boolean | { scopes?: string[] };
    /** Default: todos os scopes. */
    device?: boolean | { scopes?: string[] };
    /** Desligado por default: o app precisa conferir as credenciais. */
    mediated?: PoppyMediatedConfigInput;
  };
  /** Company Agent (§7) — o endpoint de conversas é implementado pelo `@adonis-agora/agent`. */
  agent?: { protocols: PoppyAgentProtocolEntry[] };
  /** APIs do app que aceitam Session Tokens (§6). */
  apis?: PoppyApiEntry[];
  /**
   * Site (§5). Default: liga o `browser_session_endpoint`. `false` desliga. `login`
   * substitui o login default (sessão de conta do authkit + `adonisAuth.guard`).
   */
  web?: false | { browserSession?: boolean; login?: PoppyBrowserLogin };
  /** Extensões suportadas (§3.3), publicadas como estão. */
  extensions?: Record<string, { version: string } & Record<string, unknown>>;
  /** Registro/allowlist/blocklist de agentes. */
  clients?: PoppyClientsConfigInput;
  /** Vida do Session Token, em segundos. Default: 3600 (a spec pede horas, não dias). */
  sessionTokenTtl?: number;
  /** Vida do Account Token (`refresh_token_expires_in`), em segundos. Default: 30 dias. */
  accountTokenTtl?: number;
  /** Uma Session sem uso por este tempo termina (`invalid_session`). Default: 30 dias. */
  sessionTtl?: number;
  /** Vida do código de autorização (Direct), em segundos. Default: 60. */
  authorizationCodeTtl?: number;
  /** Validade do `device_code`, em segundos. Default: 600. */
  deviceCodeTtl?: number;
  /** Intervalo mínimo de polling do device flow, em segundos. Default: 5. */
  pollInterval?: number;
  /** Vida máxima das asserções do agente (`exp - iat`), em segundos. Default: 300. */
  assertionMaxLifetime?: number;
  /** DPoP (§4.3). */
  dpop?: {
    /** Exige `nonce` emitido pelo servidor nas provas (RFC 9449 §8). Default: false. */
    requireNonce?: boolean;
    /** Janela de aceitação do `iat` da prova, em segundos. Default: 60. */
    maxAge?: number;
    /** Algoritmos aceitos na prova. Default: `['ES256']`. */
    algorithms?: string[];
  };
  /**
   * Onde guardar os `jti` vistos. Default: `'database'` (tabela lib-owned
   * `auth_poppy_jtis` — vale entre instâncias). `'memory'` só serve com uma
   * instância. `{ redis: 'main' }` usa uma conexão do `@adonisjs/redis`.
   */
  replay?: 'database' | 'memory' | { redis: string } | PoppyReplayStore;
  /**
   * Limites por `client_id` (in-memory, por processo) ou um limitador próprio.
   * `false` desliga. Default: 120 Sessions novas/min por agente; 10 tentativas
   * de Mediated Sign-In/hora por (agente, usuário).
   */
  rateLimit?: false | { sessionsPerMinute?: number; mediatedPerHour?: number } | PoppyLimiter;
  /**
   * Mapeia o principal verificado para o `actor` do app (ex.: o Actor do Agora
   * com roles `scope:<id>`). Quando definido, `verifyPoppyRequest` e o slot
   * global devolvem `actor`.
   */
  toActor?: (principal: PoppyPrincipalBase) => unknown | Promise<unknown>;
}

/** O que um Session Token válido autoriza — sem o `actor`. *
/** O que um Session Token válido autoriza — sem o `actor`. * @experimental Poppy (Personal Agent Protocol) Draft 0.1 — acompanha a spec em desenvolvimento e PODE MUDAR
/** O que um Session Token válido autoriza — sem o `actor`. *   de forma incompatível fora de majors enquanto ela for draft.
/** O que um Session Token válido autoriza — sem o `actor`. */
export interface PoppyPrincipalBase {
  /** User ID que o personal agent deu ao usuário NESTE app (opaco, estável). */
  userId: string;
  /** Conta deste app quando a Session está logada; `null` deslogada. */
  accountId: string | null;
  /** `client_id` do personal agent (URL do documento de metadata). */
  clientId: string;
  /** Scopes do token (`poppy:read`, `poppy:write`, próprios). Vazio deslogado. */
  scopes: string[];
  sessionId: string;
  signedIn: boolean;
  /** `resource` para o qual o token foi emitido (RFC 8707), ou `null`. */
  resource: string | null;
  tokenType: 'DPoP' | 'Bearer';
}

export interface ResolvedPoppyMediatedConfig {
  fields: PoppyMediatedField[];
  scopes: string[];
  verify: PoppyMediatedConfigInput['verify'];
  verifyCode?: PoppyMediatedConfigInput['verifyCode'];
  codeTtl: number;
  maxCodeAttempts: number;
}

export interface ResolvedPoppyConfig {
  organization: { name: string; domain: string; aliases: string[] };
  prefix: string;
  /** Todos os scopes oferecidos, `id → descrição`. */
  scopes: Record<string, string>;
  /** Só os próprios do app (o `custom_scopes`). */
  customScopes: Record<string, string>;
  signIn: {
    direct: { scopes: string[] } | null;
    device: { scopes: string[] } | null;
    mediated: ResolvedPoppyMediatedConfig | null;
  };
  agent: { protocols: PoppyAgentProtocolEntry[] } | null;
  apis: PoppyApiEntry[];
  web: { browserSession: boolean; login?: PoppyBrowserLogin } | null;
  extensions: Record<string, { version: string } & Record<string, unknown>>;
  clients: {
    requireRegistration: boolean;
    isRegistered: (clientId: string) => Promise<boolean>;
    isBlocked: (clientId: string) => Promise<boolean>;
  };
  sessionTokenTtl: number;
  accountTokenTtl: number;
  sessionTtl: number;
  authorizationCodeTtl: number;
  deviceCodeTtl: number;
  pollInterval: number;
  assertionMaxLifetime: number;
  dpop: { requireNonce: boolean; maxAge: number; algorithms: string[] };
  replay: 'database' | 'memory' | { redis: string } | PoppyReplayStore;
  rateLimit: false | { sessionsPerMinute: number; mediatedPerHour: number } | PoppyLimiter;
  toActor?: PoppyConfigInput['toActor'];
}

const SCOPE_ID = /^[\x21\x23-\x5B\x5D-\x7E]+$/; // RFC 6749 §3.3 scope-token
const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function fail(message: string): never {
  throw new Error(`authkit: personalAgents.poppy.${message}`);
}

function positive(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) fail(`${what} precisa ser > 0.`);
  return Math.floor(value);
}

function absoluteUrl(value: string, what: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${what} precisa ser uma URL absoluta (recebeu "${value}").`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(`${what} precisa ser http(s) (recebeu "${value}").`);
  }
}

/** `www.example.com` → `example.com`, minúsculo. */
export function stripWww(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

export function normalizePoppyPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '/poppy').trim().replace(/\/+$/, '');
  if (!trimmed) return '/poppy';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function membership(
  value: string[] | ((clientId: string) => boolean | Promise<boolean>) | undefined,
): (clientId: string) => Promise<boolean> {
  if (typeof value === 'function') return async (id) => (await value(id)) === true;
  const set = new Set(value ?? []);
  return async (id) => set.has(id);
}

function typeScopes(
  input: boolean | { scopes?: string[] } | undefined,
  all: string[],
  what: string,
): { scopes: string[] } | null {
  if (input === false) return null;
  const scopes = typeof input === 'object' && input.scopes ? [...new Set(input.scopes)] : all;
  for (const id of scopes) {
    if (!all.includes(id)) fail(`signIn.${what}.scopes — scope desconhecido "${id}".`);
  }
  if (scopes.length === 0) fail(`signIn.${what}.scopes precisa de pelo menos um scope.`);
  return { scopes };
}

export function resolvePoppyConfig(
  input: PoppyConfigInput | undefined,
  fallbackScopes: Record<string, string> | undefined,
): ResolvedPoppyConfig | undefined {
  if (!input) return undefined;

  const org = input.organization;
  if (!org?.name?.trim()) fail('organization.name é obrigatório.');
  const domains = [org.domain, ...(org.aliases ?? [])].map((d) => stripWww(d ?? ''));
  for (const d of domains) {
    if (!DOMAIN.test(d)) fail(`organization — domínio inválido "${d}" (só o host, sem esquema).`);
  }

  const customScopes = { ...(input.scopes ?? fallbackScopes ?? {}) };
  for (const id of Object.keys(customScopes)) {
    if (!SCOPE_ID.test(id)) fail(`scopes — id inválido "${id}" (sem espaços/aspas).`);
    if (id.startsWith('poppy:')) {
      fail(`scopes — "${id}": nomes com "poppy:" são reservados ao protocolo (§4.4).`);
    }
  }
  const broad = input.broadScopes !== false;
  const scopes: Record<string, string> = {
    ...(broad
      ? {
          [POPPY_READ]:
            input.broadScopeDescriptions?.[POPPY_READ] ?? POPPY_SCOPE_DESCRIPTIONS[POPPY_READ],
          [POPPY_WRITE]:
            input.broadScopeDescriptions?.[POPPY_WRITE] ?? POPPY_SCOPE_DESCRIPTIONS[POPPY_WRITE],
        }
      : {}),
    ...customScopes,
  };
  const all = Object.keys(scopes);

  const signInInput = input.signIn ?? {};
  let mediated: ResolvedPoppyMediatedConfig | null = null;
  if (signInInput.mediated) {
    const m = signInInput.mediated;
    if (!Array.isArray(m.fields) || m.fields.length === 0) {
      fail('signIn.mediated.fields precisa de pelo menos um campo.');
    }
    const names = new Set<string>();
    for (const f of m.fields) {
      if (!f?.name || !f.label || typeof f.secret !== 'boolean') {
        fail('signIn.mediated.fields — cada campo precisa de name, label e secret.');
      }
      if (names.has(f.name)) fail(`signIn.mediated.fields — campo duplicado "${f.name}".`);
      names.add(f.name);
    }
    if (typeof m.verify !== 'function') fail('signIn.mediated.verify é obrigatório.');
    const mediatedScopes = typeScopes(
      { scopes: m.scopes ?? (broad ? [POPPY_READ] : all) },
      all,
      'mediated',
    )!.scopes;
    mediated = {
      fields: m.fields.map((f) => ({ name: f.name, label: f.label, secret: f.secret })),
      scopes: mediatedScopes,
      verify: m.verify,
      verifyCode: m.verifyCode,
      codeTtl: positive(m.codeTtl, 600, 'signIn.mediated.codeTtl'),
      maxCodeAttempts: positive(m.maxCodeAttempts, 5, 'signIn.mediated.maxCodeAttempts'),
    };
  }
  if (all.length === 0 && (signInInput.direct !== false || signInInput.device !== false)) {
    fail('nenhum scope: com broadScopes: false, declare `scopes`.');
  }

  for (const entry of input.agent?.protocols ?? []) {
    if (!entry.type) fail('agent.protocols[].type é obrigatório.');
    absoluteUrl(entry.endpoint, 'agent.protocols[].endpoint');
    if (entry.resource) absoluteUrl(entry.resource, 'agent.protocols[].resource');
  }
  for (const api of input.apis ?? []) {
    if (!api.type) fail('apis[].type é obrigatório.');
    absoluteUrl(api.url, 'apis[].url');
    if (api.resource) absoluteUrl(api.resource, 'apis[].resource');
    if (typeof api.description !== 'string') fail('apis[].description é obrigatório.');
  }
  for (const name of Object.keys(input.extensions ?? {})) {
    if (typeof input.extensions![name]?.version !== 'string') {
      fail(`extensions.${name}.version é obrigatório (string).`);
    }
  }

  const dpopAlgs = input.dpop?.algorithms ?? ['ES256'];
  if (dpopAlgs.length === 0 || dpopAlgs.some((a) => a === 'none' || a.startsWith('HS'))) {
    fail('dpop.algorithms precisa de algoritmos assimétricos.');
  }

  let rateLimit: ResolvedPoppyConfig['rateLimit'];
  if (input.rateLimit === false) rateLimit = false;
  else if (typeof input.rateLimit === 'function') rateLimit = input.rateLimit;
  else {
    rateLimit = {
      sessionsPerMinute: positive(
        input.rateLimit?.sessionsPerMinute,
        120,
        'rateLimit.sessionsPerMinute',
      ),
      mediatedPerHour: positive(input.rateLimit?.mediatedPerHour, 10, 'rateLimit.mediatedPerHour'),
    };
  }

  return {
    organization: { name: org.name, domain: domains[0], aliases: domains.slice(1) },
    prefix: normalizePoppyPrefix(input.prefix),
    scopes,
    customScopes,
    signIn: {
      direct: typeScopes(signInInput.direct, all, 'direct'),
      device: typeScopes(signInInput.device, all, 'device'),
      mediated,
    },
    agent: input.agent?.protocols?.length ? { protocols: [...input.agent.protocols] } : null,
    apis: [...(input.apis ?? [])],
    web:
      input.web === false
        ? null
        : { browserSession: input.web?.browserSession !== false, login: input.web?.login },
    extensions: { ...(input.extensions ?? {}) },
    clients: {
      requireRegistration: input.clients?.requireRegistration === true,
      isRegistered: membership(input.clients?.registered),
      isBlocked: membership(input.clients?.blocked),
    },
    sessionTokenTtl: positive(input.sessionTokenTtl, 3600, 'sessionTokenTtl'),
    accountTokenTtl: positive(input.accountTokenTtl, 30 * 24 * 3600, 'accountTokenTtl'),
    sessionTtl: positive(input.sessionTtl, 30 * 24 * 3600, 'sessionTtl'),
    authorizationCodeTtl: positive(input.authorizationCodeTtl, 60, 'authorizationCodeTtl'),
    deviceCodeTtl: positive(input.deviceCodeTtl, 600, 'deviceCodeTtl'),
    pollInterval: positive(input.pollInterval, 5, 'pollInterval'),
    assertionMaxLifetime: positive(input.assertionMaxLifetime, 300, 'assertionMaxLifetime'),
    dpop: {
      requireNonce: input.dpop?.requireNonce === true,
      maxAge: positive(input.dpop?.maxAge, 60, 'dpop.maxAge'),
      algorithms: [...dpopAlgs],
    },
    replay: input.replay ?? 'database',
    rateLimit,
    toActor: input.toActor,
  };
}
