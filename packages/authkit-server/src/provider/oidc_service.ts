import { timingSafeEqual } from 'node:crypto';
import { type ClientConfig, type MetricsRecorder, NoopRecorder } from '@adonis-agora/authkit-core';
import Koa from 'koa';
import mount from 'koa-mount';
import type { ResolvedServerConfig } from '../define_config.js';
import { readActiveOrgFromKoaCtx } from '../host/active_org_cookie.js';
import { isFirstParty } from '../host/branding.js';
import { type ManagedKeyInfo, listKeyInfos, signingKeyAgeDays } from '../keys/keystore.js';
import type { KeystoreManager } from '../keys/keystore_manager.js';
import { wireProviderEvents } from '../observability/wire_provider_events.js';
import { type SessionTtlHolder, type TokenTtlHolder, buildProvider } from './build_provider.js';
import { type InteractionActions, createInteractionActions } from './interaction_actions.js';
import { registerTokenExchange } from './token_exchange.js';

export class OidcService {
  #provider!: ReturnType<typeof buildProvider>;
  #callback!: (req: any, res: any) => void;
  #interactions!: InteractionActions;
  #appKey: string;

  get provider(): ReturnType<typeof buildProvider> {
    return this.#provider;
  }
  get callback(): (req: any, res: any) => void {
    return this.#callback;
  }
  get interactions(): InteractionActions {
    return this.#interactions;
  }

  /** Pathname do issuer sem barra final (ex.: `/oidc`). Vazio quando montado na raiz. */
  readonly mountPath: string;
  readonly recorder: MetricsRecorder;
  /** Holder mutável dos TTLs de sessão OIDC (lido sincronamente pelo oidc-provider). */
  readonly sessionTtlHolder: SessionTtlHolder;
  /** Holder mutável dos TTLs de access/id/refresh tokens (lido sincronamente pelo oidc-provider). */
  readonly tokenTtlHolder: TokenTtlHolder;
  #clients: ClientConfig[];
  #config: ResolvedServerConfig;
  /** Closures de acesso ao cofre de chaves (injetadas pelo provider para hot-reload). */
  #deps: {
    /** Relê o keystore do cofre e devolve o JWKS (sem `iat`). Ausente → reloadKeys é no-op. */
    jwksLoader?: () => Promise<{ keys: Record<string, any>[] }>;
    /** Token barato de mudança do cofre (kid/etag/mtime) p/ o poll. */
    keystoreHead?: () => Promise<string | null>;
    /** Fábrica do KeystoreManager (necessária para rotateKeys e keystoreAgeDays). */
    keystoreManager?: () => Promise<KeystoreManager>;
  };
  /** Mutex de serialização de reloadKeys: encadeia execuções para nunca sobrepor builds. */
  #reloadChain: Promise<void> = Promise.resolve();
  /** Mutex de serialização de rotateKeys: evita que duas rotações concorrentes se sobreponham. */
  #rotateChain: Promise<unknown> = Promise.resolve();

  get config(): ResolvedServerConfig {
    return this.#config;
  }

  /** @internal Loader de JWKS do cofre (usado por reloadKeys). */
  get jwksLoader(): (() => Promise<{ keys: Record<string, any>[] }>) | undefined {
    return this.#deps.jwksLoader;
  }

  /** @internal Token barato de mudança do cofre (usado pelo poll de reload). */
  get keystoreHead(): (() => Promise<string | null>) | undefined {
    return this.#deps.keystoreHead;
  }

  constructor(
    config: ResolvedServerConfig,
    appKey: string,
    recorder: MetricsRecorder = new NoopRecorder(),
    deps: {
      /** Relê o keystore do cofre e devolve o JWKS (sem `iat`). Ausente → reloadKeys é no-op. */
      jwksLoader?: () => Promise<{ keys: Record<string, any>[] }>;
      /** Token barato de mudança do cofre (kid/etag/mtime) p/ o poll. */
      keystoreHead?: () => Promise<string | null>;
      /** Fábrica do KeystoreManager (necessária para rotateKeys e keystoreAgeDays). */
      keystoreManager?: () => Promise<KeystoreManager>;
    } = {},
  ) {
    this.#config = config;
    this.#clients = config.clients ?? [];
    this.#appKey = appKey;
    this.recorder = recorder;
    this.#deps = deps;
    // Inicializa o holder de TTL com os valores do config estático.
    // Será atualizado em runtime quando a setting `session_policy` for salva/apagada.
    const configSessionSec = config.ttl.session;
    this.sessionTtlHolder = {
      rememberSec: Math.max(1, configSessionSec),
      transientSec: Math.max(1, configSessionSec),
    };
    // Inicializa o holder de TTL de tokens com os valores do config estático.
    // Será atualizado em runtime quando a setting `token_ttl` for salva/apagada.
    this.tokenTtlHolder = {
      accessTokenSec: Math.max(1, config.ttl.accessToken),
      idTokenSec: Math.max(1, config.ttl.idToken),
      refreshTokenSec: Math.max(1, config.ttl.refreshToken),
    };
    // mountPath é estável (o issuer nunca muda): deriva diretamente de config.issuer
    // para que #buildAndWire possa ser chamado sem precisar reconstituir o mountPath.
    this.mountPath = new URL(config.issuer).pathname.replace(/\/+$/, '');
    this.#buildAndWire(config.jwks);
  }

  #buildAndWire(jwks: { keys: Record<string, any>[] }): void {
    const config = this.#config;
    const provider = buildProvider(
      { ...config, jwks },
      {
        appKey: this.#appKey,
        findAccount: async (ctx, sub) => {
          const user = await config.findAccount(sub);
          if (!user) return undefined;

          // Lê a org ativa do cookie de sessão (se organizations estiver disponível).
          const activeOrg = readActiveOrgFromKoaCtx(ctx);

          // GATE de least-privilege: roles globais e claims de org só são emitidas para
          // clients FIRST-PARTY (`branding.firstParty`). Capturamos o clientId aqui (fora
          // do closure `claims()`, pois o `ctx` da request vive neste escopo). Um client
          // third-party NUNCA recebe roles/org — mesmo solicitando `scope=roles`.
          const clientId: string | undefined = ctx?.oidc?.client?.clientId;
          const firstParty = config.branding ? isFirstParty(config.branding, clientId) : false;

          return {
            accountId: user.id,
            claims: async (_use: string, _scope: string) => {
              const base: Record<string, unknown> = {
                sub: user.id,
                email: user.email,
                email_verified: true,
                name: user.name,
                picture: user.avatarUrl,
              };
              // roles/org_* são dados de autorização interna: só para first-party.
              if (firstParty) {
                base[config.globalRolesClaim] = config.resolveTokenRoles
                  ? await config.resolveTokenRoles(user, { clientId, activeOrg })
                  : (user.globalRoles ?? []);
                // Emite claims de org somente quando há uma org ativa na sessão.
                if (activeOrg) {
                  base.org_id = activeOrg.orgId;
                  base.org_slug = activeOrg.orgSlug;
                  base.org_role = activeOrg.orgRole;
                }
              }
              return base;
            },
          };
        },
      },
      this.sessionTtlHolder,
      this.tokenTtlHolder,
    );
    wireProviderEvents(provider, this.recorder);

    registerTokenExchange(provider, {
      findAccount: config.findAccount,
      globalRolesClaim: config.globalRolesClaim,
      resolveTokenRoles: config.resolveTokenRoles,
      // Resource indicators (RFC 8707) suportados: o `audience` default + cada
      // resource declarado. Usado para validar `audience`/`resource` no pedido de
      // token-exchange — alvos fora desta lista são rejeitados (invalid_target).
      supportedResources: [
        config.accessTokens.audience,
        ...Object.keys(config.accessTokens.resources),
      ],
      // LOAD-BEARING: sem isto o gate de status do alvo dentro de
      // `token_exchange.ts` degrada para "allowed" (o campo é opcional, para não
      // quebrar hosts com stores mínimos) e um admin consegue impersonar uma
      // conta que acabou de desabilitar, recebendo tokens plenamente funcionais.
      accountStore: config.accountStore,
      audit: config.audit,
    });

    // Quando o issuer tem um path (ex.: http://host/oidc), o provider precisa ser
    // MONTADO sob esse path via koa-mount. Isso faz o oidc-provider gerar URLs de
    // discovery e redirects de resume/interaction CORRETAMENTE prefixados (ex.:
    // /oidc/auth, /oidc/jwks). Apenas remover o prefixo de req.url (abordagem antiga)
    // fazia o provider se enxergar na raiz e anunciar URLs sem o /oidc.
    // Para issuer na raiz, o mountPath é vazio e usamos o callback Node direto.
    let callback: (req: any, res: any) => void;
    if (this.mountPath && this.mountPath !== '/') {
      const koa = new Koa();
      // O app externo PRECISA herdar as Keygrip keys do provider. Sob koa-mount as
      // requisições do provider rodam no contexto do app EXTERNO, então `ctx.cookies`
      // usa as keys deste app. Sem isso, os cookies (_interaction, _session) seriam
      // assinados/lidos de forma inconsistente entre o fluxo via mount (authorize) e as
      // chamadas diretas `interactionDetails`/`interactionFinished` (que usam o contexto
      // do provider), quebrando o "interaction session id cookie not found".
      koa.keys = (provider as any).keys;
      koa.proxy = (provider as any).proxy;
      koa.use(mount(this.mountPath, provider as any));
      callback = koa.callback();
    } else {
      callback = provider.callback();
    }

    const interactions = createInteractionActions(provider, {
      verifyCredentials: config.verifyCredentials,
    });

    // Atribuição atômica no final: um throw antes deste ponto não corrompe o estado.
    this.#provider = provider;
    this.#callback = callback;
    this.#interactions = interactions;
  }

  /**
   * Recarrega as chaves de assinatura AO VIVO: relê o keystore do cofre e reconstrói
   * o provider com o JWKS novo, trocando a instância atomicamente (#buildAndWire faz
   * build-em-locais → assign no fim). No-op quando não há `jwksLoader` (source:'jwks'
   * inline ou managed sem store).
   *
   * Serializado por mutex (#reloadChain): chamadas concorrentes são enfileiradas em
   * vez de executar em paralelo, evitando builds sobrepostos.
   */
  async reloadKeys(): Promise<void> {
    const run = async () => {
      const loader = this.#deps.jwksLoader;
      if (!loader) return;
      const jwks = await loader();
      this.#buildAndWire(jwks);
    };
    this.#reloadChain = this.#reloadChain.then(run, run);
    return this.#reloadChain;
  }

  /** Idade (dias) da chave de assinatura corrente, ou null (sem keystore gerenciável). */
  async keystoreAgeDays(): Promise<number | null> {
    const build = this.#deps.keystoreManager;
    if (!build) return null;
    const m = await build();
    return signingKeyAgeDays(await m.read());
  }

  /** Lista as chaves managed (kid/alg/idade/ativa), ou [] se não há keystore gerenciável. */
  async listManagedKeys(): Promise<ManagedKeyInfo[]> {
    const build = this.#deps.keystoreManager;
    if (!build) return [];
    const m = await build();
    return listKeyInfos(await m.read());
  }

  /**
   * Rotaciona a chave de assinatura e aplica ao vivo (rotate → reloadKeys → audit
   * keys.rotated). Lança quando não há keystore gerenciável. Usado pelo scheduler e
   * pelo endpoint admin "rotacionar agora".
   *
   * Serializado por mutex (#rotateChain): chamadas concorrentes são enfileiradas para
   * que duas rotações nunca se sobreponham em processo (evita perda silenciosa de escrita).
   * Cada caller recebe o resultado da SUA própria rotação.
   */
  async rotateKeys(
    keep: number,
    retire = false,
  ): Promise<{ newKid: string; retiredKids: string[]; keptKids: string[] }> {
    const run = async () => {
      const build = this.#deps.keystoreManager;
      if (!build) throw new Error('AuthKit: rotação indisponível (jwks não é managed+store).');
      const m = await build();
      const { newKid, retiredKids, store } = await m.rotate(keep, retire);
      await this.reloadKeys();
      const keptKids = store.keys.map((k) => k.kid as string);
      await this.#config.audit
        ?.record({ type: 'keys.rotated', metadata: { newKid, retiredKids, keptKids, retire } })
        .catch(() => {});
      return { newKid, retiredKids, keptKids };
    };
    // serializa: encadeia após a rotação em voo; cada caller recebe o resultado da SUA rotação
    const result = this.#rotateChain.then(run, run) as Promise<{
      newKid: string;
      retiredKids: string[];
      keptKids: string[];
    }>;
    this.#rotateChain = result.catch(() => {}); // a cadeia segue mesmo se uma rotação falhar
    return result;
  }

  /**
   * Invalida o cache de clients DINÂMICOS do oidc-provider (a `dynamicClients`
   * QuickLRU em `instance(provider)`). DEVE ser chamado após qualquer escrita
   * (create/update/delete) no model `Client` via adapter, pelo console admin.
   *
   * NOTA sobre o porquê: o oidc-provider v9 cacheia clients carregados do adapter
   * numa LRU CUJA CHAVE É O HASH (sha256) DO PAYLOAD persistido — não o client_id.
   * Por isso uma alteração de metadata já é "auto-invalidante": `Client.find` relê o
   * adapter, hasheia o payload NOVO, dá cache-miss e reconstrói o client. Mesmo assim
   * limpamos a LRU explicitamente para (a) tornar o efeito imediato e determinístico
   * (sem depender de pressão de LRU para expulsar a entrada antiga, agora inalcançável)
   * e (b) liberar a entrada órfã na hora. É o caminho de invalidação suportado: a LRU
   * é um detalhe interno acessível via o helper `weak_cache` do próprio provider.
   */
  async evictDynamicClientCache(): Promise<void> {
    try {
      const wc: any = await import('oidc-provider/lib/helpers/weak_cache.js');
      const get = wc.default ?? wc.get;
      const int = get(this.provider);
      int?.dynamicClients?.clear?.();
    } catch {
      // Estrutura interna mudou numa versão futura do oidc-provider: a invalidação por
      // hash-de-conteúdo (acima) continua garantindo correção; só perdemos a expulsão
      // imediata da entrada órfã. Best-effort — não propaga erro pro caminho da request.
    }
  }

  /** Verifica client_id + client_secret contra os clients da config (p/ endpoints custom como introspecção de PAT). */
  verifyClientCredentials(clientId: string, clientSecret: string): boolean {
    const client = this.#clients.find((c) => c.clientId === clientId);
    if (!client || !client.clientSecret) return false;
    const a = Buffer.from(client.clientSecret);
    const b = Buffer.from(clientSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
