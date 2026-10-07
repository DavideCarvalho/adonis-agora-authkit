import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { type JWTPayload, jwtVerify } from 'jose';
import type { PersonalAgentIdentity } from './agent_identity.js';
import { bearerToken } from './agent_identity.js';
import { formatScope, parseScope, type ResolvedPersonalAgentDelegationConfig } from './config.js';
import type { DelegationStore, GrantRow } from './delegation_store.js';
import type { AgentSigner } from './signer.js';

export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const REFRESH_TOKEN_GRANT_TYPE = 'refresh_token';

/** Sem vogais: o código não forma palavras (RFC 8628 §6.1). */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** Erro OAuth (RFC 6749 §5.2 / RFC 8628 §3.5) — vira `{ error, error_description }`. */
export class AgentOAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'authorization_pending'
      | 'slow_down'
      | 'access_denied'
      | 'expired_token'
      | 'unsupported_grant_type',
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DelegationTokenResponse {
  token_type: 'Bearer';
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

/** Um pedido aguardando o usuário na tela de consentimento. */
export interface PendingDelegationRequest {
  userCode: string;
  /** `iss` do agente que pediu. */
  clientId: string;
  scopes: { id: string; description: string }[];
  expiresAt: Date;
}

/** O que um token de delegação válido autoriza (PACT §5.5). */
export interface DelegationContext {
  /** Conta NESTE app em nome da qual o agente age (`sub` do token). */
  accountId: string;
  scopes: string[];
  grantId: string;
  /** `iss` do agente. */
  clientId: string;
}

export interface DelegationGrantSummary {
  id: string;
  clientId: string;
  scopes: { id: string; description: string }[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/** Recibo de uma ação feita sob delegação (PACT §5.6). */
export interface DelegationReceipt {
  jws: string;
  claims: {
    grantId: string;
    user: string;
    pa: string;
    brand: string;
    scopesUsed: string[];
    actions: { tool: string; argsHash?: string }[];
    ts: string;
  };
}

export interface PersonalAgentDelegationDeps {
  cfg: ResolvedPersonalAgentDelegationConfig;
  store: DelegationStore;
  signer: AgentSigner;
  /** `issuer` do authorization server de delegação e URL da tela de consentimento. */
  urls: { issuer: string; consent: string };
  /**
   * A conta ainda pode agir? (existe e não está desabilitada). Checado em cada
   * uso do grant: apagar ou suspender a conta corta a delegação na hora.
   * Default: sempre ativa.
   */
  isAccountActive?: (accountId: string) => Promise<boolean>;
  now?: () => Date;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function newUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Aceita o código como o usuário digitar: minúsculas, sem hífen, com espaços. */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== 8) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/**
 * Delegação de personal agents: RFC 8628 (device code) em que o cliente OAuth é
 * o agente — autenticado pelo JWT dele, não por client secret — e o login é o
 * login deste app. O usuário aprova scopes definidos pelo app; o agente recebe
 * um token assinado pelo keystore do IdP, com vida curta e refresh rotativo,
 * revogável a qualquer momento no console de conta.
 *
 * Um grant por (conta, agente, usuário do agente): aprovar de novo — o step-up
 * de um scope que faltava — SOMA scopes ao grant existente em vez de criar outro.
 */
export class PersonalAgentDelegation {
  #cfg: ResolvedPersonalAgentDelegationConfig;
  #store: DelegationStore;
  #signer: AgentSigner;
  #urls: { issuer: string; consent: string };
  #isAccountActive: (accountId: string) => Promise<boolean>;
  #now: () => Date;

  constructor(deps: PersonalAgentDelegationDeps) {
    this.#cfg = deps.cfg;
    this.#store = deps.store;
    this.#signer = deps.signer;
    this.#urls = deps.urls;
    this.#isAccountActive = deps.isAccountActive ?? (async () => true);
    this.#now = deps.now ?? (() => new Date());
  }

  get scopes(): Record<string, string> {
    return this.#cfg.scopes;
  }

  get interfaceUrl(): string {
    return this.#cfg.interfaceUrl;
  }

  // ─── endpoints do agente ──────────────────────────────────────────────────

  /** `POST device_authorization` (PACT §5.3). */
  async requestDevice(
    agent: PersonalAgentIdentity,
    scopeParam: unknown,
  ): Promise<DeviceAuthorizationResponse> {
    const scopes = typeof scopeParam === 'string' ? parseScope(scopeParam) : [];
    if (scopes.length === 0 || scopes.some((id) => !(id in this.#cfg.scopes))) {
      throw new AgentOAuthError('invalid_scope', 'Request scope ids listed on the Agent Card');
    }

    const now = this.#now();
    await this.#store.deleteDevicesExpiredBefore(now);

    const deviceCode = randomToken('dc_');
    const expiresAt = new Date(now.getTime() + this.#cfg.deviceCodeTtl * 1000);
    let userCode = newUserCode();
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#store.insertDevice({
          id: randomUUID(),
          deviceCodeHash: sha256(deviceCode),
          userCode,
          clientId: agent.issuer,
          agentSub: agent.sub,
          requestedScope: formatScope(scopes),
          status: 'pending',
          intervalSeconds: this.#cfg.pollInterval,
          expiresAt,
          createdAt: now,
        });
        break;
      } catch (error) {
        // Colisão de `user_code` (índice único) — 20^8 combinações, raríssimo.
        if (attempt >= 2) throw error;
        userCode = newUserCode();
      }
    }

    const complete = new URL(this.#urls.consent);
    complete.searchParams.set('user_code', userCode);
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: this.#urls.consent,
      verification_uri_complete: complete.toString(),
      expires_in: this.#cfg.deviceCodeTtl,
      interval: this.#cfg.pollInterval,
    };
  }

  /** `POST token` com `grant_type=device_code` (RFC 8628 §3.4/§3.5). */
  async exchangeDeviceCode(
    agent: PersonalAgentIdentity,
    deviceCode: unknown,
  ): Promise<DelegationTokenResponse> {
    if (typeof deviceCode !== 'string' || !deviceCode) {
      throw new AgentOAuthError('invalid_request', 'device_code is required');
    }
    const row = await this.#store.findDeviceByCodeHash(sha256(deviceCode));
    // De outro agente (ou de outro usuário do agente) = desconhecido.
    if (!row || row.clientId !== agent.issuer || row.agentSub !== agent.sub) {
      throw new AgentOAuthError('invalid_grant', 'Unknown device_code');
    }
    const now = this.#now();
    if (row.status === 'denied')
      throw new AgentOAuthError('access_denied', 'The user denied access');
    if (row.status === 'consumed')
      throw new AgentOAuthError('invalid_grant', 'device_code was used');
    if (row.expiresAt <= now) throw new AgentOAuthError('expired_token', 'The device code expired');

    // `approved` sem grant = a aprovação ainda está gravando o grant.
    if (row.status === 'pending' || !row.grantId) {
      const tooSoon =
        row.lastPolledAt !== null &&
        now.getTime() - row.lastPolledAt.getTime() < row.intervalSeconds * 1000;
      await this.#store.markPolled(row.id, now);
      throw tooSoon
        ? new AgentOAuthError('slow_down', 'Poll less often')
        : new AgentOAuthError('authorization_pending', 'Waiting for the user');
    }

    const grant = await this.#store.findGrant(row.grantId);
    if (!grant || !(await this.#grantUsable(grant, agent, now))) {
      throw new AgentOAuthError('invalid_grant', 'The grant is no longer valid');
    }
    // Assina ANTES de consumir: uma falha de assinatura não pode queimar o código.
    const accessToken = await this.#signAccessToken(grant, now);
    if (!(await this.#store.transitionDevice(row.id, 'approved', { status: 'consumed' }))) {
      throw new AgentOAuthError('invalid_grant', 'device_code was used');
    }
    return this.#tokenResponse(grant, accessToken, now);
  }

  /** `POST token` com `grant_type=refresh_token`. Rotativo: o refresh usado morre. */
  async refresh(
    agent: PersonalAgentIdentity,
    refreshToken: unknown,
  ): Promise<DelegationTokenResponse> {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new AgentOAuthError('invalid_request', 'refresh_token is required');
    }
    const invalid = new AgentOAuthError('invalid_grant', 'Unknown or expired refresh_token');
    const now = this.#now();
    const hash = sha256(refreshToken);
    const row = await this.#store.findRefreshToken(hash);
    if (!row || row.expiresAt <= now) throw invalid;

    const grant = await this.#store.findGrant(row.grantId);
    // Valida o chamador ANTES de gastar o token: um terceiro não queima o refresh alheio.
    if (!grant || !(await this.#grantUsable(grant, agent, now))) throw invalid;

    // Reuso de um refresh já gasto = vazou. Revoga o grant inteiro (RFC 9700 §4.14).
    if (row.usedAt !== null || !(await this.#store.useRefreshToken(hash, now))) {
      await this.#store.revokeGrantById(grant.id, now);
      throw invalid;
    }
    const accessToken = await this.#signAccessToken(grant, now);
    return this.#tokenResponse(grant, accessToken, now);
  }

  // ─── tela de consentimento ────────────────────────────────────────────────

  /** O pedido por trás de um `user_code`, se ainda está aguardando. */
  async pendingRequest(userCodeInput: unknown): Promise<PendingDelegationRequest | null> {
    const userCode = normalizeUserCode(userCodeInput);
    if (!userCode) return null;
    const row = await this.#store.findDeviceByUserCode(userCode);
    if (!row || row.status !== 'pending' || row.expiresAt <= this.#now()) return null;
    return {
      userCode: row.userCode,
      clientId: row.clientId,
      scopes: this.#describe(parseScope(row.requestedScope)),
      expiresAt: row.expiresAt,
    };
  }

  /**
   * O usuário aprovou `scopes` (só o que estava no pedido conta). `null` = nada
   * foi aprovado: nenhum scope do pedido marcado, ou o pedido não está mais
   * pendente — o chamador decide se nega.
   */
  async approve(input: {
    userCode: string;
    accountId: string;
    scopes: string[];
  }): Promise<{ grantId: string; scopes: string[] } | null> {
    const userCode = normalizeUserCode(input.userCode);
    const row = userCode ? await this.#store.findDeviceByUserCode(userCode) : null;
    const now = this.#now();
    if (!row || row.status !== 'pending' || row.expiresAt <= now) return null;

    const requested = parseScope(row.requestedScope);
    const granted = requested.filter((id) => input.scopes.includes(id));
    if (granted.length === 0) return null;

    // Reivindica o pedido ANTES de mexer em grant: de duas aprovações
    // concorrentes do mesmo código, só uma passa daqui.
    const claimed = await this.#store.transitionDevice(row.id, 'pending', {
      status: 'approved',
      accountId: input.accountId,
    });
    if (!claimed) return null;

    const expiresAt = new Date(now.getTime() + this.#cfg.grantTtl * 1000);
    const existing = (await this.#store.findGrantsFor(input.accountId, row.clientId, row.agentSub))
      .filter((g) => g.expiresAt > now)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

    let result: { grantId: string; scopes: string[] } | null = null;
    if (existing) {
      const scope = formatScope(new Set([...parseScope(existing.scope), ...granted]));
      // Só soma num grant que continua vivo — revogado no meio do caminho, cria outro.
      if (await this.#store.updateGrant(existing.id, { scope, expiresAt, updatedAt: now })) {
        result = { grantId: existing.id, scopes: parseScope(scope) };
      }
    }
    if (!result) {
      const grantId = `agrant_${randomUUID()}`;
      await this.#store.insertGrant({
        id: grantId,
        accountId: input.accountId,
        clientId: row.clientId,
        agentSub: row.agentSub,
        scope: formatScope(granted),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      result = await this.#converge(input.accountId, row.clientId, row.agentSub, now);
    }
    // Só agora o polling do agente enxerga a aprovação (antes disso: pending).
    await this.#store.setDeviceGrant(row.id, result.grantId);
    return result;
  }

  async deny(input: { userCode: string; accountId: string }): Promise<boolean> {
    const userCode = normalizeUserCode(input.userCode);
    const row = userCode ? await this.#store.findDeviceByUserCode(userCode) : null;
    if (!row || row.status !== 'pending') return false;
    return this.#store.transitionDevice(row.id, 'pending', {
      status: 'denied',
      accountId: input.accountId,
    });
  }

  // ─── console de conta ─────────────────────────────────────────────────────

  async listGrants(accountId: string): Promise<DelegationGrantSummary[]> {
    const now = this.#now();
    return (await this.#store.listGrants(accountId))
      .filter((g) => g.expiresAt > now)
      .map((g) => ({
        id: g.id,
        clientId: g.clientId,
        scopes: this.#describe(parseScope(g.scope)),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        expiresAt: g.expiresAt,
      }));
  }

  /** Revoga na hora: tokens já emitidos param de valer na próxima request. */
  revokeGrant(accountId: string, grantId: string): Promise<boolean> {
    return this.#store.revokeGrant(accountId, grantId, this.#now());
  }

  /** Revoga TODAS as delegações da conta. Devolve quantas estavam vivas. */
  revokeAllGrants(accountId: string): Promise<number> {
    return this.#store.revokeAllGrants(accountId, this.#now());
  }

  // ─── resource server ──────────────────────────────────────────────────────

  /**
   * Valida o header `X-A2A-User-Delegation: Bearer <token>` de uma request que
   * JÁ passou pela verificação do JWT do agente (PACT §5.5). `null` = inválido
   * (o chamador responde 401 `invalid_token`).
   */
  async verify(
    agent: PersonalAgentIdentity,
    header: string | null | undefined,
  ): Promise<DelegationContext | null> {
    const token = bearerToken(header);
    if (!token) return null;
    const now = this.#now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#signer.keySet(), {
        algorithms: this.#signer.algorithms,
        issuer: this.#urls.issuer,
        audience: this.#cfg.interfaceUrl,
        currentDate: now,
        requiredClaims: ['sub', 'exp', 'client_id', 'scope', 'grant_id'],
      }));
    } catch {
      return null;
    }
    if (payload.client_id !== agent.issuer || typeof payload.grant_id !== 'string') return null;

    // Revogação: o grant precisa continuar vivo, e ser DESTE usuário do agente —
    // o token não pode ser reaproveitado na conversa de outro usuário dele.
    const grant = await this.#store.findGrant(payload.grant_id);
    if (
      !grant ||
      grant.accountId !== payload.sub ||
      !(await this.#grantUsable(grant, agent, now))
    ) {
      return null;
    }
    return {
      accountId: grant.accountId,
      scopes: parseScope(payload.scope as string),
      grantId: grant.id,
      clientId: agent.issuer,
    };
  }

  /** Recibo assinado de uma resposta servida sob delegação (PACT §5.6). */
  async receipt(
    delegation: DelegationContext,
    input: { scopesUsed: string[]; actions?: { tool: string; argsHash?: string }[] },
  ): Promise<DelegationReceipt> {
    const claims: DelegationReceipt['claims'] = {
      grantId: delegation.grantId,
      user: delegation.accountId,
      pa: delegation.clientId,
      brand: this.#cfg.interfaceUrl,
      scopesUsed: input.scopesUsed,
      actions: input.actions ?? [],
      ts: this.#now().toISOString(),
    };
    return { jws: await this.#signer.signJson(claims), claims };
  }

  // ─── internos ─────────────────────────────────────────────────────────────

  /**
   * Duas aprovações simultâneas (dois códigos, mesma conta/agente/usuário) podem
   * ambas não achar grant e ambas inserir. Depois do insert, todo mundo elege o
   * MESMO sobrevivente — o mais antigo, desempate pelo id — soma os scopes nele
   * e revoga o resto. As duas chamadas convergem para o mesmo grant.
   */
  async #converge(
    accountId: string,
    clientId: string,
    agentSub: string,
    now: Date,
  ): Promise<{ grantId: string; scopes: string[] }> {
    const live = (await this.#store.findGrantsFor(accountId, clientId, agentSub))
      .filter((g) => g.expiresAt > now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const [survivor, ...extras] = live;
    if (!survivor) throw new AgentOAuthError('invalid_grant', 'The grant vanished');
    if (extras.length === 0) return { grantId: survivor.id, scopes: parseScope(survivor.scope) };

    const scope = formatScope(new Set(live.flatMap((g) => parseScope(g.scope))));
    const expiresAt = new Date(Math.max(...live.map((g) => g.expiresAt.getTime())));
    await this.#store.updateGrant(survivor.id, { scope, expiresAt, updatedAt: now });
    for (const extra of extras) await this.#store.revokeGrantById(extra.id, now);
    return { grantId: survivor.id, scopes: parseScope(scope) };
  }

  async #grantUsable(grant: GrantRow, agent: PersonalAgentIdentity, now: Date): Promise<boolean> {
    return (
      grant.revokedAt === null &&
      grant.expiresAt > now &&
      grant.clientId === agent.issuer &&
      grant.agentSub === agent.sub &&
      (await this.#isAccountActive(grant.accountId))
    );
  }

  #signAccessToken(grant: GrantRow, now: Date): Promise<string> {
    return this.#signer.signJwt(
      {
        iss: this.#urls.issuer,
        aud: this.#cfg.interfaceUrl,
        sub: grant.accountId,
        client_id: grant.clientId,
        scope: grant.scope,
        grant_id: grant.id,
        jti: randomUUID(),
      },
      { issuedAt: now, expiresIn: this.#cfg.accessTokenTtl },
    );
  }

  async #tokenResponse(
    grant: GrantRow,
    accessToken: string,
    now: Date,
  ): Promise<DelegationTokenResponse> {
    const refreshToken = randomToken('rt_');
    await this.#store.insertRefreshToken({
      tokenHash: sha256(refreshToken),
      grantId: grant.id,
      expiresAt: grant.expiresAt,
      createdAt: now,
    });
    return {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: this.#cfg.accessTokenTtl,
      scope: grant.scope,
    };
  }

  #describe(ids: string[]): { id: string; description: string }[] {
    return ids.map((id) => ({ id, description: this.#cfg.scopes[id] ?? id }));
  }
}
