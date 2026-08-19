export interface ClientBrand {
  /** Client id (OIDC) que iniciou o fluxo — chave estável pra escolher tema/tela por produto. */
  clientId?: string;
  appName: string;
  accent: string;
  accentSoft: string;
  tagline: string;
  company?: string;
  audienceLabel?: string;
}

export interface BrandingConfig {
  company: string;
  clients: Record<string, Omit<ClientBrand, 'company' | 'audienceLabel'>>;
  default: Omit<ClientBrand, 'company' | 'audienceLabel'>;
  firstParty: string[];
  audienceLabels?: Record<string, string>;
}

export function isFirstParty(cfg: BrandingConfig, clientId: string | undefined): boolean {
  return !!clientId && cfg.firstParty.includes(clientId);
}

/**
 * O client é FIRST-PARTY, ou seja, recebe as claims de autorização
 * (`<globalRolesClaim>`, `org_id`, `org_slug`, `org_role`)?
 *
 * `allowlist` ausente (o host não declarou `firstPartyClients` nem
 * `branding.firstParty`) → TODO client registrado é first-party. É o default
 * de propósito: a claim já está amarrada ao escopo `roles`, então o client
 * precisa ter sido registrado por um admin e pedir `scope=roles`; tratar
 * "sem allowlist" como "ninguém" apagava as roles de todo RP num host que
 * simplesmente não personalizou o tema.
 *
 * `allowlist` declarada (inclusive VAZIA) → vale ao pé da letra. Uma lista
 * vazia é uma declaração deliberada de "nenhum client recebe roles", e não a
 * mesma coisa que não declarar nada.
 *
 * Sem `clientId` (fluxos sem client no contexto) → nunca first-party: não há a
 * quem atribuir a decisão, e fail-closed é a resposta certa.
 */
export function isFirstPartyClient(
  allowlist: readonly string[] | undefined,
  clientId: string | undefined,
): boolean {
  if (!clientId) return false;
  if (allowlist === undefined) return true;
  return allowlist.includes(clientId);
}

export function brandFor(
  cfg: BrandingConfig,
  clientId: string | undefined,
  audience?: string,
): ClientBrand {
  const base = (clientId && cfg.clients[clientId]) || cfg.default;
  const label = audience ? cfg.audienceLabels?.[audience] : undefined;
  return { ...base, clientId, company: cfg.company, ...(label ? { audienceLabel: label } : {}) };
}
