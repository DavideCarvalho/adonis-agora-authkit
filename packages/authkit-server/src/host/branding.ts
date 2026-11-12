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

/**
 * O que o host declara em `defineConfig({ branding })`. `default` e `firstParty` são
 * opcionais: sem `default` a marca de quem não tem client conhecido vem da `company`
 * (ver {@link resolveDefaultBrand}); sem `firstParty`, nenhum client pula o consent.
 */
export type BrandingConfigInput = Omit<BrandingConfig, 'default' | 'firstParty'> &
  Partial<Pick<BrandingConfig, 'default' | 'firstParty'>>;

/**
 * Default `BrandingConfig` usado quando o host não declara `branding` no
 * `defineConfig`. `branding` é tipado opcional e todo doc (getting-started,
 * quickstart, reference) trata como tema puro, dispensável — mas o
 * interaction controller (e alguns outros módulos do host-kit) lê
 * `cfg.branding.clients`/`cfg.branding.default` incondicionalmente para
 * montar a tela de login/consent/signup. Sem este default, o primeiro hit em
 * QUALQUER tela built-in num host sem `branding` estourava
 * `TypeError: Cannot read properties of undefined (reading 'clients')`.
 * Ver `resolveBranding`, chamado em `define_config.ts`.
 */
const DEFAULT_BRANDING: BrandingConfig = {
  company: 'AuthKit',
  clients: {},
  default: {
    appName: 'AuthKit',
    accent: '#4f46e5',
    accentSoft: '#e0e7ff',
    tagline: '',
  },
  firstParty: [],
};

/**
 * Resolve a config de branding: quando o host não declara `branding`, cai no
 * {@link DEFAULT_BRANDING} acima (tema neutro, sem clients customizados) em
 * vez de deixar `cfg.branding` como `undefined` — o que fazia a MENOR config
 * documentada (sem branding) quebrar a primeira tela de login/consent/signup.
 */
export function resolveBranding(input: BrandingConfigInput | undefined): BrandingConfig {
  if (!input) return DEFAULT_BRANDING;
  // Hosts declaram na prática só `company` + `clients` (sem `default`, às vezes sem
  // `firstParty`). Sem normalizar, `brandFor` devolvia uma marca SEM `appName`/`accent`
  // para todo fluxo sem client conhecido (console de conta, recuperação, throttle) — as
  // telas caíam no fallback genérico enquanto os e-mails já usavam a `company` — e
  // `isFirstParty` estourava em `firstParty.includes`.
  return {
    ...input,
    clients: input.clients ?? {},
    default: resolveDefaultBrand(input),
    firstParty: input.firstParty ?? [],
  };
}

/**
 * A marca default de um host — o ÚNICO lugar que decide o nome/cor de quem não tem
 * client conhecido (telas sem client, e-mails). Precedência do nome:
 * `branding.default.appName` → `branding.company` → `'AuthKit'`; as cores caem no
 * tema neutro. Tolera `branding` parcial/ausente (configs crus, fixtures).
 */
export function resolveDefaultBrand(
  branding: Partial<BrandingConfigInput> | undefined,
): BrandingConfig['default'] {
  const declared = branding?.default as Partial<BrandingConfig['default']> | undefined;
  const neutral = DEFAULT_BRANDING.default;
  return {
    ...declared,
    appName: declared?.appName || branding?.company || neutral.appName,
    accent: declared?.accent || neutral.accent,
    accentSoft: declared?.accentSoft || declared?.accent || neutral.accentSoft,
    tagline: declared?.tagline ?? neutral.tagline,
  };
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
