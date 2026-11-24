/**
 * Personal Agent Protocol ("Poppy", versão 1.0 — https://personalagentprotocol.org/docs/1.0/spec) —
 * config.
 *
 * Poppy é o segundo protocolo de personal agents ao lado do PACT. O agente se identifica pelo
 * `client_id` (uma URL HTTPS com o documento de metadata dele) e declara a Session em cada request
 * com o header `Poppy-Session`, um JWT assinado com uma chave delegada. O acesso à conta é OAuth
 * puro e separado: este app roda o authorization server, e o usuário entra por Direct (código +
 * PKCE), Device (RFC 8628) ou pela extensão Mediated Sign-In. Prender os access tokens com DPoP é
 * opcional (RFC 9449).
 *
 * Reaproveita o núcleo de delegação: o refresh token é um grant na tabela de grants de personal
 * agents (`auth_agent_grants`) — lista e revogação no console de conta são as mesmas do PACT — e os
 * scopes aprovados viram os `scopes` do principal (que o `@adonis-agora/agent` mapeia para roles
 * `scope:<id>`).
 */
import type { HttpContext } from '@adonisjs/core/http';

export type PoppySignInType = 'direct' | 'device' | 'mediated';

/** Um campo de credencial do Mediated Sign-In (extensão Mediated Sign-In). */
export interface PoppyMediatedField {
  /** Parâmetro que o agente manda no token endpoint. */
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
  ctx: HttpContext;
}

/**
 * Resultado do callback de credenciais. Nunca devolva as credenciais.
 *
 * - `complete`: credenciais certas, nada mais a fazer — o agente recebe os tokens.
 * - `code_required`: o app MANDOU um código de uso único (SMS, e-mail, WhatsApp…)
 *   e o agente precisa submetê-lo. Ou devolve o `code` que mandou (a lib guarda
 *   só o hash e confere), ou deixa sem `code` e implementa `verifyCode` (ex.: um
 *   serviço de OTP que confere do lado dele). `state` é opaco e volta no
 *   `verifyCode`.
 * - `failed`: senha errada… (`invalid_grant`).
 * - `denied`: a empresa recusa este sign-in (`access_denied`).
 *
 * **Sem enumeração de contas.** Num fluxo só de identificador (e-mail/telefone + código), `failed`
 * para um identificador desconhecido conta ao agente quem tem conta. Devolva então `code_required`
 * com `accountId: null` (e o mesmo `sentTo` que uma conta real teria) e NÃO mande código: a lib
 * responde igual a uma conta real e recusa qualquer código como um código errado (mesmas
 * tentativas, mesmo `invalid_grant` no fim). Faça o mesmo trabalho nos dois caminhos (ex.: enfileire o
 * e-mail em vez de mandar na hora) para o tempo de resposta não denunciar.
 */
export type PoppyMediatedResult =
  | { status: 'complete'; accountId: string }
  | {
      status: 'code_required';
      /** `null` = identificador sem conta elegível: nenhum código vale (ver acima). */
      accountId: string | null;
      /** Texto para o usuário: "Text to the phone number ending in 71". */
      sentTo: string;
      code?: string;
      state?: unknown;
    }
  | { status: 'failed' }
  | { status: 'denied' };

export interface PoppyMediatedConfigInput {
  /** Campos pedidos (extensão Mediated Sign-In). Ex.: `[{ name: 'email', … }, { name: 'password', secret: true, … }]`. */
  fields: PoppyMediatedField[];
  /** Scopes que o Mediated Sign-In pode conceder (`scopes` da extensão). */
  scopes: string[];
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
  }) => Promise<boolean>;
  /** Validade do sign-in pendente de código, em segundos. Default: 600. */
  codeTtl?: number;
  /** Tentativas de código antes de `invalid_grant`. Default: 5. */
  maxCodeAttempts?: number;
}

/** Uma entrada de `agent.protocols` (§3.1, §8.1). */
export interface PoppyAgentProtocolEntry {
  /** `'poppy'` para as conversas deste protocolo (§8). */
  type: string;
  /** URL HTTPS do endpoint de conversas. */
  endpoint: string;
  /**
   * O que o agente deste endpoint ajuda a fazer (§3.1, §8.1) — o personal agent usa para decidir se
   * uma conversa serve à tarefa. Pode dizer que ajuda com qualquer coisa. Obrigatório.
   */
  description: string;
  /** A interface precisa da conta desde o início (§3.2). Default: `session`. */
  access?: 'session' | 'signed_in';
  /**
   * Só aceita tokens emitidos para este `resource` (§4.5). Não sai no `poppy.json`: publique a
   * protected resource metadata do serviço (RFC 9728) com este `resource`.
   */
  resource?: string;
}

/** Hints de um scope (§4.7): a ação de maior consequência que o exige. */
export interface PoppyScopeHint {
  changes: 'none' | 'reversible' | 'irreversible';
  personal_data: boolean;
}

/** Uma entrada de `apis` (§3.1, §7). */
export interface PoppyApiEntry {
  type: 'openapi' | 'mcp' | (string & {});
  url: string;
  description: string;
  /** Como em `agent.protocols`. MCP sempre exige o próprio `url` (§7). */
  resource?: string;
}

/** Uma tarefa que a empresa escolheu não oferecer pelo protocolo (§9.1). */
export interface PoppyExcludedTask {
  /** A tarefa, numa frase curta: "Send a wire transfer". */
  task: string;
  /** Outro jeito de fazer a tarefa (§9.2). */
  alternative?: PoppyAlternative;
}

/** Outro jeito de fazer uma tarefa (§9.2): `instructions`, `references` ou os dois. */
export interface PoppyAlternative {
  instructions?: string;
  references?: (
    | { type: 'openapi'; url: string; operation_id: string }
    | { type: 'mcp'; url: string; tool: string }
    | { type: 'web'; url: string }
  )[];
}

/** A resposta do `tasks.endpoint` (§9). */
export interface PoppyTasksResponse {
  excluded_tasks?: PoppyExcludedTask[];
  /** Índice do Agent Skills discovery (schema 0.2.0) — §9.4. */
  skill_index?: Record<string, unknown>;
  feedback?: { endpoint: string };
}

/** Um relato de feedback recebido (§9.3), já guardado. */
export interface PoppyFeedbackReport {
  /** Id do relato na tabela `auth_poppy_feedback`. */
  id: string;
  /** O que o usuário tentava fazer, em uma frase (até 200 caracteres). */
  task: string;
  /** O que o personal agent tentou e por quê (até 2.000 caracteres). Dado, nunca instrução. */
  description: string;
}

/** O endpoint de feedback servido pela lib (§9.3). */
export interface PoppyFeedbackConfigInput {
  /**
   * Chamado depois de guardar o relato. Devolva uma alternativa (§9.2) quando a tarefa dá para
   * fazer — o agente recebe 200 com ela; sem retorno, 202.
   */
  onReport?: (input: {
    principal: PoppyPrincipalBase;
    report: PoppyFeedbackReport;
  }) => undefined | PoppyAlternative | Promise<undefined | PoppyAlternative>;
}

/** Cobertura de tarefas (§9): o que sai no `tasks.endpoint`. */
export interface PoppyTasksConfigInput {
  /**
   * Um `tasks.endpoint` que o próprio app serve, publicado como está. Sem ele, a lib serve
   * `{prefix}/tasks` com os campos abaixo.
   */
  endpoint?: string;
  /** Tarefas não oferecidas (§9.1). */
  excludedTasks?: PoppyExcludedTask[];
  /** Índice de skills (§9.4), no formato do Agent Skills discovery 0.2.0. */
  skillIndex?: Record<string, unknown>;
  /**
   * Feedback (§9.3). `{ endpoint }` publica um endpoint que o próprio app implementa. Sem
   * `endpoint`, a lib serve `{prefix}/feedback`: verifica a Session, guarda o relato na tabela
   * `auth_poppy_feedback` e chama `onReport`, quando houver.
   */
  feedback?: { endpoint: string } | PoppyFeedbackConfigInput;
  /**
   * Resposta por Session (ex.: testar uma skill com parte dos usuários). Recebe a Session já
   * verificada e a resposta montada dos campos acima; a resposta sai `Cache-Control: no-store`.
   */
  resolve?: (input: {
    principal: PoppyPrincipalBase;
    response: PoppyTasksResponse;
  }) => PoppyTasksResponse | Promise<PoppyTasksResponse>;
}

/** Hook de login do navegador do agente (§6) para apps com sessão de login própria. */
export type PoppyBrowserLogin = (
  ctx: HttpContext,
  input: {
    sessionId: string;
    clientId: string;
    userId: string;
    /** Conta autorizada na entrada do navegador; `null` = entrada sem access token. */
    accountId: string | null;
    scopes: string[];
  },
) => Promise<void>;

/**
 * Onde o protocolo guarda os `jti` já vistos (client assertions, Session JWTs,
 * provas DPoP) até expirarem. `claim` devolve `true` na
 * primeira vez que vê a chave e `false` num replay.
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
   * `true` = só agentes registrados (`registered`) são aceitos; os demais levam
   * `invalid_client` ou `invalid_session` (§4.1). Default: false — qualquer `client_id` com um
   * documento de metadata válido.
   */
  requireRegistration?: boolean;
  /** `client_id`s registrados fora de banda (lista ou função, para quem guarda no banco). */
  registered?: string[] | ((clientId: string) => boolean | Promise<boolean>);
  /** `client_id`s bloqueados (revogados por mau uso). */
  blocked?: string[] | ((clientId: string) => boolean | Promise<boolean>);
}

export interface PoppyConfigInput {
  /** Nome exibido e domínio (`organization` do poppy.json). */
  organization: {
    name: string;
    /** Domínio da empresa (sem esquema). O poppy.json só é servido nele; `www.` redireciona. */
    domain: string;
    /** Outros domínios da mesma empresa (um por país…) — também vão para `protected_resources`. */
    aliases?: string[];
  };
  /** Prefixo das rotas e path do issuer. Default: `/poppy`. */
  prefix?: string;
  /**
   * Scopes do app (`auth.scopes`), `id → descrição`. O protocolo não define nenhum (§4.7).
   * Default: os de `personalAgents.delegation.scopes` (PACT), quando houver — um catálogo só para os
   * dois protocolos.
   */
  scopes?: Record<string, string>;
  /** Hints de cada scope (`auth.scope_hints`, §4.7). */
  scopeHints?: Record<string, PoppyScopeHint>;
  /** Tipos de sign-in. `false` desliga; um array restringe os scopes do tipo. */
  signIn?: {
    /** Default: todos os scopes. */
    direct?: boolean | { scopes?: string[] };
    /** Default: todos os scopes. */
    device?: boolean | { scopes?: string[] };
    /** Desligado por default: o app precisa conferir as credenciais. */
    mediated?: PoppyMediatedConfigInput;
    /**
     * Um sign-in que nomeia `resource` vale só para esses resources (§4.5, RFC 8707 §2.2): o
     * default token só sai se ele nomeou `https://{organization.domain}`. Sem `resource`, o sign-in
     * continua cobrindo tudo. Default: false (o `resource` do início é ignorado).
     */
    limitToResource?: boolean;
  };
  /** Company Agent (§8) — o endpoint de conversas é implementado pelo `@adonis-agora/agent`. */
  agent?: { protocols: PoppyAgentProtocolEntry[] };
  /** APIs do app que aceitam o header da Session (§7). */
  apis?: PoppyApiEntry[];
  /** Cobertura de tarefas (§9): tarefas excluídas, skills e feedback, no `tasks.endpoint`. */
  tasks?: PoppyTasksConfigInput;
  /**
   * Site (§6). Default: liga o `browser_session_endpoint`. `false` não publica `web`. `login`
   * substitui o login default (sessão de conta do authkit + `adonisAuth.guard`). `redirectTo` é
   * a página do site para onde o navegador vai depois de entrar (path). Default: `/`.
   *
   * - `disabled: true` pede aos personal agents que não naveguem o site num navegador
   *   (`web.disabled`); desliga o `browser_session_endpoint`. Liste `agent` ou `apis`.
   * - `unscoped` (`web.unscoped`): o site não aplica os scopes do cookie, então
   *   `poppy:browser-sign-in` dá todo o acesso da conta no site. Default: `true` — o login default
   *   entra na conta inteira. Passe `false` só com um `login` que aplica os scopes.
   */
  web?:
    | false
    | {
        browserSession?: boolean;
        disabled?: boolean;
        unscoped?: boolean;
        login?: PoppyBrowserLogin;
        redirectTo?: string;
      };
  /**
   * Extensões suportadas (§3.3), publicadas como estão: uma entrada por versão.
   * Ex.: `{ 'example.com/gift-wrap': [{ version: '1', endpoint: 'https://…' }] }`.
   */
  extensions?: Record<string, ({ version: string } & Record<string, unknown>)[]>;
  /**
   * Pushed Authorization Requests (RFC 9126, §4.2) no Direct Sign-In. Default: oferecido.
   * `{ required: true }` exige (`require_pushed_authorization_requests`). `false` não oferece.
   */
  par?: boolean | { required?: boolean };
  /** Registro/allowlist/blocklist de agentes. */
  clients?: PoppyClientsConfigInput;
  /**
   * SÓ DESENVOLVIMENTO/TESTE — NÃO conforme à spec. Aceita `client_id` (e o
   * `jwks_uri`/`redirect_uris` do agente) em `http://` e busca o documento sem a
   * proteção de SSRF (loopback e rede privada liberados), para testar com um
   * agente local (`poppy-agent --insecure-dev`). Lança no boot com
   * `NODE_ENV=production`. Default: false.
   */
  allowInsecureClientIds?: boolean;
  /** Vida do access token, em segundos. Default: 3600. */
  accessTokenTtl?: number;
  /** Vida do refresh token, em segundos. Default: 30 dias. */
  refreshTokenTtl?: number;
  /** Uma Session sem uso por este tempo termina (`invalid_session`). Default: 30 dias. */
  sessionTtl?: number;
  /** Vida do código de autorização (Direct), em segundos. Default: 60. */
  authorizationCodeTtl?: number;
  /** Validade do `device_code`, em segundos. Default: 600. */
  deviceCodeTtl?: number;
  /** Intervalo mínimo de polling do device flow, em segundos. Default: 5. */
  pollInterval?: number;
  /**
   * Vida máxima das client assertions (`exp - iat`), em segundos. Default: 300. Nunca menos que 300:
   * a spec proíbe recusar uma assertion de até 5 minutos (§4.1).
   */
  assertionMaxLifetime?: number;
  /** Session JWT (§5.3). */
  sessionJwt?: {
    /** Janela de aceitação do `iat`, em segundos. Default: 60. */
    maxAge?: number;
    /**
     * Recusa (`invalid_session`) uma chave delegada que já assinou por outro User ID enquanto a
     * delegação dela vale (§5.2): limita uma chave vazada a um usuário. Default: true.
     */
    oneUserPerKey?: boolean;
  };
  /** DPoP (§4.5): prender os access tokens é escolha da empresa. */
  dpop?: {
    /** Recusa pedidos de token sem prova: nenhum access token sai Bearer (MCP à parte). Default: false. */
    required?: boolean;
    /** Exige `nonce` emitido pelo servidor nas provas (RFC 9449 §8). Default: false. */
    requireNonce?: boolean;
    /** Janela de aceitação do `iat` da prova, em segundos. Default: 60. */
    maxAge?: number;
    /** Algoritmos aceitos na prova. Default: `['ES256']`. */
    algorithms?: string[];
    /**
     * Prende o refresh token à chave DPoP do sign-in (§4.4): um refresh sem prova ou com outra
     * chave leva `invalid_grant`. Só vale para sign-ins feitos com prova. Default: true.
     */
    bindRefreshTokens?: boolean;
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
   * de Mediated Sign-In/hora por (agente, identificador).
   */
  rateLimit?: false | { sessionsPerMinute?: number; mediatedPerHour?: number } | PoppyLimiter;
  /**
   * Mapeia o principal verificado para o `actor` do app (ex.: o Actor do Agora
   * com roles `scope:<id>`). Quando definido, `verifyPoppyRequest` e o slot
   * global devolvem `actor`.
   */
  toActor?: (principal: PoppyPrincipalBase) => unknown | Promise<unknown>;
  /**
   * Versões do protocolo servidas (§3.4), `'major.minor' → opções`. Default: só `'1.0'`, a que este
   * pacote implementa — ela sempre entra. Cada outra versão vira um documento no mesmo host
   * (`{prefix}/versions/{versão}.json`), listado em `supported_versions`; `document` ajusta o que
   * ela publica. `deprecated` manda `Deprecation` (RFC 9745) e `Sunset` (RFC 8594) nas respostas a
   * requests nela.
   */
  versions?: Record<string, PoppyVersionInput>;
  /** A versão do `/.well-known/poppy.json` (§3.4). Default: a mais nova servida. */
  preferredVersion?: string;
  /** Extensão Operations, versão 3. Desligada por default. */
  operations?: boolean | PoppyOperationsConfigInput;
  /**
   * Extensão Browser Control, versão 1: o site marca passos do usuário com
   * `data-poppy-user-step`. Exige o `browser_session_endpoint`. Default: false.
   */
  browserControl?: boolean;
  /** Extensão Links, versão 1: mensagens da empresa com links. Default: false. */
  links?: boolean;
  /** Extensão Disclosures, versão 1: avisos destacados nas mensagens. Default: false. */
  disclosures?: boolean;
  /**
   * Offer the `agora:dev` scope: a personal agent the person grants it to may use the app's Agora
   * developer tools over MCP (`@adonis-agora/agent`, `/mcp/agora`). It is never ticked for the
   * person on the consent screen and Mediated Sign-In can never grant it. Default: offered when the
   * app serves those dev tools (the `'agora.devTools'` binding exists). `false` never offers it.
   */
  devTools?: boolean;
}

/** Uma versão do protocolo servida (§3.4). */
export interface PoppyVersionInput {
  /**
   * Ajusta o documento desta versão: recebe o da 1.0 (com `protocol_version` já trocado, sem
   * `supported_versions`) e devolve o desta versão. Não troque `organization.domain` nem o issuer.
   */
  document?: (doc: Record<string, unknown>) => Record<string, unknown>;
  /**
   * A versão vai deixar de ser servida: as respostas a requests nela levam `Deprecation` (desde
   * `at`), `Sunset` (quando houver) e um `Link` `rel="deprecation"` (quando houver).
   */
  deprecated?: { at: Date; sunset?: Date; link?: string };
}

/** Uma aprovação recebida (Operations 3, §6). */
export interface PoppyApproval {
  operation_id: string;
  revision: string;
  /** `user` (o usuário aprovou) ou `agent` (o agente aprovou por instrução do usuário). */
  approver: 'user' | 'agent';
  /** Unix seconds. */
  approved_at?: number;
  /** Só com `user`: `tap`, `typed`, `voice`… */
  input_type?: string;
  /** Id do registro do personal agent para esta aprovação. */
  reference?: string;
}

/** A recusa de uma aprovação (Operations 3, §6), devolvida pelo `decide`. */
export interface PoppyDecline {
  /** Por quê, curto, para o usuário. Nada que a Session não pudesse ver. */
  reason?: string;
  /** Outro jeito de fazer (§9.2). */
  alternative?: PoppyAlternative;
}

export interface PoppyOperationsConfigInput {
  /**
   * Operações no site (§4 "Websites"): publica `endpoint` (`{prefix}/operations`), onde o agente
   * busca e aprova as operações que o site devolveu. Exige o `browser_session_endpoint`. Default:
   * ligado quando o site tem browser join.
   */
  website?: boolean;
  /**
   * Chamado com uma aprovação que passou nas checagens, antes de executar: devolva um
   * {@link PoppyDecline} para recusá-la (`approval_declined`), ou nada para seguir.
   */
  decide?: (input: {
    principal: PoppyPrincipalBase;
    operation: { operationId: string; revision: string; terms: Record<string, unknown> };
    approval: PoppyApproval;
  }) => undefined | PoppyDecline | Promise<undefined | PoppyDecline>;
  /** Validade default de uma revisão, em segundos. Default: 900 (15 min, o mínimo dos guias). */
  expiresIn?: number;
}

/**
 * O que uma request verificada autoriza — sem o `actor`.
 */
export interface PoppyPrincipalBase {
  /** User ID que o personal agent deu ao usuário NESTE app (opaco, estável). */
  userId: string;
  /** Agent ID opcional (§5.1): qual dos agentes do usuário é esta Session. */
  agentId: string | null;
  /** Conta deste app quando a request traz access token; `null` deslogada. */
  accountId: string | null;
  /** `client_id` do personal agent (URL do documento de metadata). */
  clientId: string;
  /** Scopes do access token. Vazio deslogado. */
  scopes: string[];
  /** A Session, única por `client_id` + `sid` + User ID (§5.3). */
  sessionId: string;
  /** A versão do protocolo que a request declarou em `Poppy-Version` (`'1.0'`, `'1.1'`…). */
  protocolVersion: string;
  /**
   * A versão servida (§3.4) com que a request é atendida: a de `versions` compatível com
   * `protocolVersion` — a igual, senão a mais nova que não passa dela.
   */
  documentVersion: string;
  /**
   * As extensões que a request declarou em `Poppy-Extensions` e que este app lista, `nome → versão`
   * (§3.3, §3.4).
   */
  extensions: Record<string, string>;
  signedIn: boolean;
  /** `resource` para o qual o token foi emitido (RFC 8707), ou `null`. */
  resource: string | null;
  /** Esquema do access token; `null` deslogado. */
  tokenType: 'DPoP' | 'Bearer' | null;
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
  /** Os scopes oferecidos, `id → descrição`. */
  scopes: Record<string, string>;
  scopeHints: Record<string, PoppyScopeHint>;
  signIn: {
    direct: { scopes: string[] } | null;
    device: { scopes: string[] } | null;
    mediated: ResolvedPoppyMediatedConfig | null;
    limitToResource: boolean;
  };
  agent: { protocols: PoppyAgentProtocolEntry[] } | null;
  apis: PoppyApiEntry[];
  /** `null` = sem `tasks` no poppy.json. */
  tasks: {
    /** Endpoint do próprio app; `null` = a lib serve `{prefix}/tasks`. */
    endpoint: string | null;
    response: PoppyTasksResponse;
    resolve?: PoppyTasksConfigInput['resolve'];
    /** O endpoint de feedback da lib (`{prefix}/feedback`); `null` = nenhum ou do app. */
    feedback: PoppyFeedbackConfigInput | null;
  } | null;
  web: {
    browserSession: boolean;
    disabled: boolean;
    unscoped: boolean;
    login?: PoppyBrowserLogin;
    redirectTo: string;
  } | null;
  extensions: Record<string, ({ version: string } & Record<string, unknown>)[]>;
  /** Versões servidas (§3.4), com `'1.0'` sempre. */
  versions: Record<string, PoppyVersionInput>;
  preferredVersion: string;
  /** Operations 3; `null` = desligada. */
  operations: {
    website: boolean;
    decide?: PoppyOperationsConfigInput['decide'];
    expiresIn: number;
  } | null;
  browserControl: boolean;
  links: boolean;
  disclosures: boolean;
  /** `null` = sem PAR. */
  par: { required: boolean } | null;
  clients: {
    requireRegistration: boolean;
    isRegistered: (clientId: string) => Promise<boolean>;
    isBlocked: (clientId: string) => Promise<boolean>;
    /** As listas do config quando são arrays (o console mostra); `null` = função do host. */
    registeredList: string[] | null;
    blockedList: string[] | null;
  };
  /** Dev/teste: `client_id` http e busca sem guarda de SSRF (ver o input). */
  allowInsecureClientIds: boolean;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  sessionTtl: number;
  authorizationCodeTtl: number;
  deviceCodeTtl: number;
  pollInterval: number;
  assertionMaxLifetime: number;
  sessionJwt: { maxAge: number; oneUserPerKey: boolean };
  dpop: {
    required: boolean;
    requireNonce: boolean;
    maxAge: number;
    algorithms: string[];
    bindRefreshTokens: boolean;
  };
  replay: 'database' | 'memory' | { redis: string } | PoppyReplayStore;
  rateLimit: false | { sessionsPerMinute: number; mediatedPerHour: number } | PoppyLimiter;
  toActor?: PoppyConfigInput['toActor'];
  /** `agora:dev` offered: `true`/`false` as configured, `null` = when the app serves dev tools. */
  devTools: boolean | null;
}

/** Parâmetros que um campo do Mediated Sign-In não pode usar (extensão, §2). */
const RESERVED_FIELDS = new Set([
  'grant_type',
  'scope',
  'resource',
  'client_id',
  'client_secret',
  'client_assertion',
  'client_assertion_type',
  'sign_in_id',
  'one_time_code',
]);
const SCOPE_ID = /^[\x21\x23-\x5B\x5D-\x7E]+$/; // RFC 6749 §3.3 scope-token
const DOMAIN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function fail(message: string): never {
  throw new Error(`authkit-poppy: poppy().${message}`);
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

function listOf(value: string[] | ((clientId: string) => unknown) | undefined): string[] | null {
  if (typeof value === 'function') return null;
  return [...new Set(value ?? [])];
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
  // Domínios comparados só ignorando caixa, sem nenhuma outra normalização (§3.1).
  const domains = [org.domain, ...(org.aliases ?? [])].map((d) =>
    (d ?? '').toLowerCase().replace(/\.$/, ''),
  );
  for (const d of domains) {
    if (!DOMAIN.test(d)) fail(`organization — domínio inválido "${d}" (só o host, sem esquema).`);
  }

  const scopes = { ...(input.scopes ?? fallbackScopes ?? {}) };
  for (const id of Object.keys(scopes)) {
    if (!SCOPE_ID.test(id)) fail(`scopes — id inválido "${id}" (sem espaços/aspas).`);
  }
  const all = Object.keys(scopes);
  const scopeHints = { ...(input.scopeHints ?? {}) };
  for (const [id, hint] of Object.entries(scopeHints)) {
    if (!['none', 'reversible', 'irreversible'].includes(hint?.changes)) {
      fail(`scopeHints.${id}.changes precisa ser none, reversible ou irreversible.`);
    }
    if (typeof hint.personal_data !== 'boolean') {
      fail(`scopeHints.${id}.personal_data é obrigatório (boolean).`);
    }
  }

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
      if (RESERVED_FIELDS.has(f.name)) {
        fail(`signIn.mediated.fields — "${f.name}" é um parâmetro reservado.`);
      }
      if (names.has(f.name)) fail(`signIn.mediated.fields — campo duplicado "${f.name}".`);
      names.add(f.name);
    }
    if (typeof m.verify !== 'function') fail('signIn.mediated.verify é obrigatório.');
    if (!Array.isArray(m.scopes)) fail('signIn.mediated.scopes é obrigatório.');
    if (m.scopes.includes(AGORA_DEV_SCOPE)) {
      fail(
        `signIn.mediated.scopes — "${AGORA_DEV_SCOPE}" needs the consent screen; Mediated Sign-In cannot grant it.`,
      );
    }
    const mediatedScopes = typeScopes({ scopes: m.scopes }, all, 'mediated')!.scopes;
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
    fail('nenhum scope: declare `scopes` ou desligue signIn.direct e signIn.device.');
  }
  const legacy = input as unknown as Record<string, unknown>;
  if (legacy.feedback !== undefined || legacy.excludedTasks !== undefined) {
    fail('feedback e excludedTasks foram para `tasks` (tasks.feedback, tasks.excludedTasks).');
  }
  const offersSignIn =
    signInInput.direct !== false || signInInput.device !== false || !!signInInput.mediated;

  for (const entry of input.agent?.protocols ?? []) {
    if (!entry.type) fail('agent.protocols[].type é obrigatório.');
    absoluteUrl(entry.endpoint, 'agent.protocols[].endpoint');
    if (typeof entry.description !== 'string' || !entry.description.trim()) {
      fail('agent.protocols[].description é obrigatório (o que o agente ajuda a fazer).');
    }
    if (entry.access === 'signed_in' && !offersSignIn) {
      fail('agent.protocols[].access signed_in exige um tipo de sign-in.');
    }
    if (entry.resource) absoluteUrl(entry.resource, 'agent.protocols[].resource');
    if (entry.access && entry.access !== 'session' && entry.access !== 'signed_in') {
      fail('agent.protocols[].access precisa ser session ou signed_in.');
    }
  }
  for (const api of input.apis ?? []) {
    if (!api.type) fail('apis[].type é obrigatório.');
    absoluteUrl(api.url, 'apis[].url');
    if (api.resource) absoluteUrl(api.resource, 'apis[].resource');
    if (typeof api.description !== 'string') fail('apis[].description é obrigatório.');
  }
  const tasks = resolveTasks(input.tasks, input.apis ?? []);
  const redirectTo = input.web ? (input.web.redirectTo ?? '/') : '/';
  if (!redirectTo.startsWith('/') || redirectTo.startsWith('//')) {
    fail('web.redirectTo precisa ser um path do site.');
  }
  let web: ResolvedPoppyConfig['web'] = null;
  if (input.web !== false) {
    const disabled = input.web?.disabled === true;
    if (disabled && input.web?.browserSession === true) {
      fail(
        'web.disabled não combina com web.browserSession: não liste o browser_session_endpoint.',
      );
    }
    const browserSession = !disabled && input.web?.browserSession !== false;
    if (input.web?.unscoped === true && !browserSession) {
      fail('web.unscoped exige o browser_session_endpoint (web.browserSession).');
    }
    web = {
      browserSession,
      disabled,
      unscoped: browserSession && input.web?.unscoped !== false,
      login: input.web?.login,
      redirectTo,
    };
  }
  const extensions: ResolvedPoppyConfig['extensions'] = {};
  const flagged: Record<string, boolean> = {
    [OPERATIONS_EXTENSION]: !!input.operations,
    [BROWSER_CONTROL_EXTENSION]: input.browserControl === true,
    [LINKS_EXTENSION]: input.links === true,
    [DISCLOSURES_EXTENSION]: input.disclosures === true,
  };
  for (const [name, entries] of Object.entries(input.extensions ?? {})) {
    if (name === MEDIATED_SIGN_IN_EXTENSION) {
      fail(`extensions.${name} é publicada por signIn.mediated.`);
    }
    if (flagged[name]) {
      fail(`extensions.${name} é publicada pela opção do próprio poppy() — não liste as duas.`);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      fail(`extensions.${name} precisa ser uma lista, uma entrada por versão (§3.3).`);
    }
    for (const entry of entries) {
      if (typeof entry?.version !== 'string' || !entry.version) {
        fail(`extensions.${name}[].version é obrigatório (string).`);
      }
    }
    extensions[name] = entries.map((e) => ({ ...e }));
  }

  // `poppy:browser-sign-in` (§4.7, §6): quem lista o browser_session_endpoint e oferece sign-in
  // precisa suportá-lo. No site que não aplica os scopes, ele dá a conta inteira — e diz isso.
  if (web?.browserSession && offersSignIn && !(BROWSER_SIGN_IN_SCOPE in scopes)) {
    scopes[BROWSER_SIGN_IN_SCOPE] = web.unscoped
      ? BROWSER_SIGN_IN_UNSCOPED_DESCRIPTION
      : BROWSER_SIGN_IN_SCOPED_DESCRIPTION;
    if (web.unscoped && !(BROWSER_SIGN_IN_SCOPE in scopeHints)) {
      scopeHints[BROWSER_SIGN_IN_SCOPE] = { changes: 'irreversible', personal_data: true };
    }
  }
  const catalog = Object.keys(scopes);
  const withBrowserScope = (type: { scopes: string[] } | null) =>
    type && BROWSER_SIGN_IN_SCOPE in scopes && !type.scopes.includes(BROWSER_SIGN_IN_SCOPE)
      ? { scopes: [...type.scopes, BROWSER_SIGN_IN_SCOPE] }
      : type;

  const browserJoin = web?.browserSession === true;
  let operations: ResolvedPoppyConfig['operations'] = null;
  if (input.operations) {
    const o = input.operations === true ? {} : input.operations;
    if (o.website === true && !browserJoin) {
      fail('operations.website exige o browser_session_endpoint (web.browserSession).');
    }
    if (o.decide !== undefined && typeof o.decide !== 'function') {
      fail('operations.decide precisa ser uma função.');
    }
    operations = {
      website: o.website ?? browserJoin,
      decide: o.decide,
      expiresIn: positive(o.expiresIn, 900, 'operations.expiresIn'),
    };
  }
  if (input.browserControl === true && !browserJoin) {
    fail('browserControl exige o browser_session_endpoint (web.browserSession).');
  }
  const { versions, preferredVersion } = resolveVersions(input.versions, input.preferredVersion);

  const assertionMaxLifetime = positive(input.assertionMaxLifetime, 300, 'assertionMaxLifetime');
  if (assertionMaxLifetime < 300) {
    fail('assertionMaxLifetime precisa ser >= 300: a spec proíbe recusar assertions de até 5 min.');
  }

  const dpopAlgs = input.dpop?.algorithms ?? ['ES256'];
  if (dpopAlgs.length === 0 || dpopAlgs.some((a) => a === 'none' || a.startsWith('HS'))) {
    fail('dpop.algorithms precisa de algoritmos assimétricos.');
  }

  const allowInsecureClientIds = input.allowInsecureClientIds === true;
  if (allowInsecureClientIds && process.env.NODE_ENV === 'production') {
    fail(
      'allowInsecureClientIds é só para desenvolvimento/teste e não pode ser ligado com NODE_ENV=production.',
    );
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

  const resolved: ResolvedPoppyConfig = {
    organization: { name: org.name, domain: domains[0], aliases: domains.slice(1) },
    prefix: normalizePoppyPrefix(input.prefix),
    scopes,
    scopeHints,
    signIn: {
      direct: withBrowserScope(typeScopes(signInInput.direct, catalog, 'direct')),
      device: withBrowserScope(typeScopes(signInInput.device, catalog, 'device')),
      mediated,
      limitToResource: signInInput.limitToResource === true,
    },
    agent: input.agent?.protocols?.length ? { protocols: [...input.agent.protocols] } : null,
    apis: [...(input.apis ?? [])],
    tasks,
    web,
    extensions,
    versions,
    preferredVersion,
    operations,
    browserControl: input.browserControl === true,
    links: input.links === true,
    disclosures: input.disclosures === true,
    par:
      input.par === false || signInInput.direct === false
        ? null
        : { required: typeof input.par === 'object' && input.par.required === true },
    clients: {
      requireRegistration: input.clients?.requireRegistration === true,
      isRegistered: membership(input.clients?.registered),
      isBlocked: membership(input.clients?.blocked),
      registeredList: listOf(input.clients?.registered),
      blockedList: listOf(input.clients?.blocked),
    },
    allowInsecureClientIds,
    accessTokenTtl: positive(input.accessTokenTtl, 3600, 'accessTokenTtl'),
    refreshTokenTtl: positive(input.refreshTokenTtl, 30 * 24 * 3600, 'refreshTokenTtl'),
    sessionTtl: positive(input.sessionTtl, 30 * 24 * 3600, 'sessionTtl'),
    authorizationCodeTtl: positive(input.authorizationCodeTtl, 60, 'authorizationCodeTtl'),
    deviceCodeTtl: positive(input.deviceCodeTtl, 600, 'deviceCodeTtl'),
    pollInterval: positive(input.pollInterval, 5, 'pollInterval'),
    assertionMaxLifetime,
    sessionJwt: {
      maxAge: positive(input.sessionJwt?.maxAge, 60, 'sessionJwt.maxAge'),
      oneUserPerKey: input.sessionJwt?.oneUserPerKey !== false,
    },
    dpop: {
      required: input.dpop?.required === true,
      requireNonce: input.dpop?.requireNonce === true,
      maxAge: positive(input.dpop?.maxAge, 60, 'dpop.maxAge'),
      algorithms: [...dpopAlgs],
      bindRefreshTokens: input.dpop?.bindRefreshTokens !== false,
    },
    replay: input.replay ?? 'database',
    rateLimit,
    toActor: input.toActor,
    devTools: null,
  };
  resolved.devTools = input.devTools ?? null;
  return input.devTools === true ? withAgoraDevScope(resolved, input) : resolved;
}

/** O único scope que o protocolo define: o navegador do agente entra logado no site (§6). */
export const BROWSER_SIGN_IN_SCOPE = 'poppy:browser-sign-in';
/** A descrição quando o site aplica os scopes do cookie. */
export const BROWSER_SIGN_IN_SCOPED_DESCRIPTION =
  'Use the website signed in, with the other access you approve';
/** A descrição quando o site dá a conta inteira (`web.unscoped`, §6). */
export const BROWSER_SIGN_IN_UNSCOPED_DESCRIPTION =
  'Browse the website, and see and do anything your account can do there';
/** O nome da extensão Mediated Sign-In em `extensions`. */
export const MEDIATED_SIGN_IN_EXTENSION = 'mediated-sign-in';
/** Extensão Operations (versão 3). */
export const OPERATIONS_EXTENSION = 'operations';
export const OPERATIONS_VERSION = '3';
/** Extensão Browser Control (versão 1). */
export const BROWSER_CONTROL_EXTENSION = 'browser-control';
/** Extensões Links e Disclosures (versão 1). */
export const LINKS_EXTENSION = 'links';
export const DISCLOSURES_EXTENSION = 'disclosures';
/** A versão do protocolo que este pacote implementa (§3.4). */
export const POPPY_BASE_VERSION = '1.0';
const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

function resolveVersions(
  input: Record<string, PoppyVersionInput> | undefined,
  preferred: string | undefined,
): { versions: Record<string, PoppyVersionInput>; preferredVersion: string } {
  const versions: Record<string, PoppyVersionInput> = { [POPPY_BASE_VERSION]: {} };
  for (const [version, options] of Object.entries(input ?? {})) {
    if (!VERSION.test(version)) fail(`versions — "${version}" precisa ser major.minor.`);
    if (options?.document !== undefined && typeof options.document !== 'function') {
      fail(`versions.${version}.document precisa ser uma função.`);
    }
    if (version === POPPY_BASE_VERSION && options?.document) {
      fail(`versions.${POPPY_BASE_VERSION}.document — o documento da 1.0 é o poppy.json da lib.`);
    }
    const dep = options?.deprecated;
    if (dep !== undefined) {
      if (!(dep?.at instanceof Date) || Number.isNaN(dep.at.getTime())) {
        fail(`versions.${version}.deprecated.at precisa ser uma Date.`);
      }
      if (dep.sunset !== undefined && !(dep.sunset instanceof Date)) {
        fail(`versions.${version}.deprecated.sunset precisa ser uma Date.`);
      }
      if (dep.link !== undefined) absoluteUrl(dep.link, `versions.${version}.deprecated.link`);
    }
    versions[version] = { ...(options ?? {}) };
  }
  const newest = Object.keys(versions).sort(compareVersions).at(-1)!;
  const preferredVersion = preferred ?? newest;
  if (!(preferredVersion in versions)) {
    fail(`preferredVersion "${preferredVersion}" não está em versions.`);
  }
  return { versions, preferredVersion };
}

/** Ordena `major.minor` numericamente. */
export function compareVersions(a: string, b: string): number {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}

const SKILL_DIGEST = /^sha256:[0-9a-f]{64}$/;

function resolveTasks(
  input: PoppyTasksConfigInput | undefined,
  apis: PoppyApiEntry[],
): ResolvedPoppyConfig['tasks'] {
  if (!input) return null;
  if (input.endpoint !== undefined) {
    absoluteUrl(input.endpoint, 'tasks.endpoint');
    if (input.excludedTasks || input.skillIndex || input.feedback || input.resolve) {
      fail('tasks.endpoint é um endpoint do app: os demais campos de tasks ficam nele.');
    }
    return { endpoint: input.endpoint, response: {}, feedback: null };
  }
  const response: PoppyTasksResponse = {};
  if (input.excludedTasks) {
    for (const item of input.excludedTasks) {
      if (typeof item?.task !== 'string' || !item.task.trim()) {
        fail('tasks.excludedTasks[].task é obrigatório.');
      }
      if (item.alternative) validateAlternative(item.alternative, apis);
    }
    response.excluded_tasks = input.excludedTasks.map((t) => ({ ...t }));
  }
  if (input.skillIndex) {
    const index = input.skillIndex;
    if (typeof index.$schema !== 'string' || !Array.isArray(index.skills)) {
      fail('tasks.skillIndex precisa de $schema e skills (Agent Skills discovery 0.2.0).');
    }
    for (const skill of index.skills as Record<string, unknown>[]) {
      for (const field of ['name', 'description', 'type', 'url']) {
        if (typeof skill?.[field] !== 'string' || !skill[field]) {
          fail(`tasks.skillIndex.skills[].${field} é obrigatório.`);
        }
      }
      if (typeof skill.digest !== 'string' || !SKILL_DIGEST.test(skill.digest)) {
        fail('tasks.skillIndex.skills[].digest precisa ser sha256: + 64 hex minúsculos.');
      }
    }
    response.skill_index = index;
  }
  let feedback: PoppyFeedbackConfigInput | null = null;
  if (input.feedback) {
    if ('endpoint' in input.feedback && input.feedback.endpoint !== undefined) {
      absoluteUrl(input.feedback.endpoint, 'tasks.feedback.endpoint');
      if ((input.feedback as PoppyFeedbackConfigInput).onReport !== undefined) {
        fail('tasks.feedback.onReport é do endpoint da lib: sem `endpoint`.');
      }
      response.feedback = { endpoint: input.feedback.endpoint };
    } else {
      feedback = input.feedback as PoppyFeedbackConfigInput;
      if (feedback.onReport !== undefined && typeof feedback.onReport !== 'function') {
        fail('tasks.feedback.onReport precisa ser uma função.');
      }
    }
  }
  if (input.resolve !== undefined && typeof input.resolve !== 'function') {
    fail('tasks.resolve precisa ser uma função.');
  }
  return { endpoint: null, response, resolve: input.resolve, feedback };
}

function validateAlternative(alternative: PoppyAlternative, apis: PoppyApiEntry[]): void {
  const refs = alternative.references ?? [];
  if (!alternative.instructions && refs.length === 0) {
    fail('tasks.excludedTasks[].alternative precisa de instructions ou references (§9.2).');
  }
  for (const ref of refs) {
    absoluteUrl(ref.url, 'tasks alternative references[].url');
    if (ref.type === 'openapi' || ref.type === 'mcp') {
      if (!apis.some((a) => a.type === ref.type && a.url === ref.url)) {
        fail(`references[] ${ref.type} precisa apontar uma entrada de apis (${ref.url}).`);
      }
    }
  }
}

/** The scope that lets a personal agent use the app's Agora developer tools over MCP. */
export const AGORA_DEV_SCOPE = 'agora:dev';

/** The catalog description of {@link AGORA_DEV_SCOPE} (the consent screen shows a translated text). */
export const AGORA_DEV_SCOPE_DESCRIPTION =
  "Use this app's developer tools: read its accounts, sessions, workflows and logs over MCP";

/** The message key the consent screen shows for {@link AGORA_DEV_SCOPE}. */
export const AGORA_DEV_SCOPE_MESSAGE = 'poppy.scope.agora_dev';

/**
 * `cfg` with {@link AGORA_DEV_SCOPE} offered: in the catalog, and in the Direct and Device sign-in
 * lists that were left to their default (every scope). Never in Mediated Sign-In.
 */
export function withAgoraDevScope(
  cfg: ResolvedPoppyConfig,
  input: Pick<PoppyConfigInput, 'signIn'>,
): ResolvedPoppyConfig {
  const add = (
    current: { scopes: string[] } | null,
    configured: boolean | { scopes?: string[] } | undefined,
  ) => {
    if (current === null) return null;
    const explicit = typeof configured === 'object' && Array.isArray(configured.scopes);
    if (explicit || current.scopes.includes(AGORA_DEV_SCOPE)) return current;
    return { scopes: [...current.scopes, AGORA_DEV_SCOPE] };
  };
  return {
    ...cfg,
    devTools: true,
    scopes: {
      ...cfg.scopes,
      [AGORA_DEV_SCOPE]: cfg.scopes[AGORA_DEV_SCOPE] ?? AGORA_DEV_SCOPE_DESCRIPTION,
    },
    scopeHints: {
      ...cfg.scopeHints,
      [AGORA_DEV_SCOPE]: cfg.scopeHints[AGORA_DEV_SCOPE] ?? {
        changes: 'irreversible',
        personal_data: true,
      },
    },
    signIn: {
      ...cfg.signIn,
      direct: add(cfg.signIn.direct, input.signIn?.direct),
      device: add(cfg.signIn.device, input.signIn?.device),
    },
  };
}
