import type { HttpContext, Router } from '@adonisjs/core/http';
import type { ResolvedServerConfig } from '../../define_config.js';
import { accountHome } from '../account_home.js';
import { accountPath } from '../account_paths.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { validateReturnTo } from '../controllers/account_session_controller.js';
import { translate } from '../i18n.js';
import { markSudo } from '../sudo_mode.js';
import type { SudoContext, SudoMethod, SudoRouteHelpers } from './types.js';

/** Último método usado com sucesso — só ordena a tela, não restringe nada. */
export const LAST_METHOD_SESSION_KEY = 'authkit_sudo_last_method';

/**
 * Monta o `SudoContext` a partir do `HttpContext`.
 *
 * Mora AQUI, e não no controller, porque é o construtor canônico do contexto
 * que `completeSudo`/`fail` recebem e que todo `SudoMethod` usa — é runtime do
 * SPI, não detalhe da tela. Enquanto morava em `controllers/`, o barrel do SPI
 * reexportava de lá só para esconder isso, e o ciclo
 * `runtime → controller → runtime` era o que obrigava `configuredSudoMethods` a
 * viver longe de `isSudoMethodEnabled` — origem do drift entre os dois lados.
 */
export async function sudoContextFrom(ctx: HttpContext): Promise<SudoContext> {
  const service = await (ctx as any).containerResolver.make('authkit.server');
  const cfg = service.config;
  const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
  const account = await cfg.accountStore.findById(accountId);

  // PRECEDÊNCIA do return_to. Num GET a query string é a única fonte real. Num
  // POST o alvo do redirect vem do campo hidden do form: deixar a query string
  // vencer permitiria a um link `?return_to=...` sequestrar o destino de um form
  // que o usuário já preencheu — e seria uma mudança silenciosa de um alvo de
  // redirect em relação ao comportamento histórico (`request.input`, que no
  // Adonis já dá precedência ao corpo). `validateReturnTo` roda nos dois casos.
  const fromBody = ctx.request.input?.('return_to');
  const fromQuery = (ctx.request as any).qs?.()?.return_to;
  const isPost = String((ctx.request as any).method?.() ?? '').toUpperCase() === 'POST';
  const raw = isPost ? (fromBody ?? fromQuery) : (fromQuery ?? fromBody);

  return { ctx, cfg, accountId, account, returnTo: validateReturnTo(raw) };
}

/**
 * Métodos cujas rotas FORAM montadas por `registerAuthHost`, na ordem em que
 * ele as montou. Guarda os OBJETOS, não só os ids, porque esta lista é também
 * a lista efetiva da TELA quando o host não configura `config.sudo.methods` —
 * ver `configuredSudoMethods`.
 */
const mountedSudoMethods: SudoMethod[] = [];

/**
 * A lista montada é a de DEFAULTS da lib (e não uma escrita pelo host)?
 *
 * Só a lista de defaults é derivada do config (`derivedSudoMethods`). Uma lista
 * que o host escreveu vale ao pé da letra — ver o docblock de `setMountedSudoMethods`.
 */
let mountedFromDefaults = false;

/**
 * Registra a lista montada. Chamado UMA vez por `registerAuthHost`, e
 * SUBSTITUI (não acumula): registrar o host de novo é redefinir o que existe,
 * não somar ao que existia.
 *
 * `fromDefaults` distingue "esta é a lista de defaults da LIB" de "esta é a
 * lista que o HOST escreveu" (argumento de `registerAuthHost` ou
 * `config.sudo.methods`). A distinção existe porque a derivação do deadlock
 * (`derivedSudoMethods`) só pode mexer na primeira: mexer na segunda seria
 * mudar, sem pedir, o que um host declarou explicitamente — e a promessa de
 * `sudoMethods` é que ele SUBSTITUI os defaults.
 */
export function setMountedSudoMethods(
  methods: SudoMethod[],
  opts: { fromDefaults?: boolean } = {},
): void {
  mountedSudoMethods.splice(0, mountedSudoMethods.length, ...methods);
  mountedFromDefaults = opts.fromDefaults === true;
}

/** Um método com este id teve rotas montadas? Usado só para avisar de drift. */
export function isSudoMethodMounted(methodId: string): boolean {
  return mountedSudoMethods.some((m) => m?.id === methodId);
}

/**
 * Lista de métodos que o host configurou EXPLICITAMENTE, ou `null` quando ele
 * não configurou nada (ausente ou vazio → "não restringi").
 *
 * Ponto ÚNICO de leitura de `config.sudo.methods`. Existe aqui (e não no
 * controller) porque quem precisa dela são os dois lados — a tela, que decide o
 * que OFERECER, e os handlers dos métodos, que decidem o que ACEITAR — e o
 * controller já importa os métodos built-in, o que tornaria a dependência
 * circular se os métodos importassem de volta o controller.
 */
export function explicitSudoMethods(cfg: ResolvedServerConfig): SudoMethod[] | null {
  const configured = cfg?.sudo?.methods;
  return Array.isArray(configured) && configured.length ? configured : null;
}

/**
 * O host declarou, PELO CONFIG, que este deployment não tem senha usável?
 *
 * `authMethods: { password: false }` é pin de config e é autoritativo — tem
 * prioridade sobre o runtime setting e o console admin mostra o toggle travado.
 * Quem declara isso está dizendo que ninguém entra por senha; contas criadas
 * pelo signup passwordless nem têm senha (a coluna leva um hash aleatório
 * inutilizável, indistinguível de um hash real de dentro do pacote).
 *
 * NÃO usa `passwordless.*`: aquelas flags LIGAM vias alternativas de login sem
 * desligar a senha, então um host com `passwordless.magicLink: true` pode
 * perfeitamente ter usuários que conhecem a própria senha. Só o pin em `false`
 * é uma afirmação sobre o deployment inteiro.
 */
function isPasswordlessHost(cfg: ResolvedServerConfig): boolean {
  return cfg?.authMethods?.password === false;
}

/**
 * O DEFAULT da lib, resolvido contra o config — o conserto do deadlock.
 *
 * `registerAuthHost` monta `[password, passkey, magicLink]` sem saber nada do
 * config (a montagem acontece antes de o config lazy resolver). Aqui o config
 * está resolvido, e é aqui que se decide qual metade vale:
 *
 * - host COM senha → `[password, passkey]`, o histórico byte a byte. O endpoint
 *   do magic link fica montado e inerte: quem quiser oferecê-lo declara
 *   `config.sudo.methods` — e agora isso FUNCIONA, porque a rota existe (era
 *   metade da promessa de 0.46 que ficava faltando).
 * - host que declarou `authMethods: { password: false }` → `[passkey, magicLink]`.
 *   Sai o campo de senha, que nesse deployment é uma opção que não pode dar
 *   certo, e entra o único método que uma conta sem credencial prévia consegue
 *   satisfazer (ver `CREDENTIAL_FREE_SUDO_METHOD_IDS` em `sudo/satisfiability.ts`).
 *
 * SÓ MEXE NA LISTA DE DEFAULTS (`mountedFromDefaults`). Lista escrita pelo host
 * passa intacta — inclusive quando isso o deixa em deadlock, caso em que o aviso
 * de boot (`define_config.ts`) é quem fala. Adivinhar a intenção de uma lista
 * explícita seria pior: é a lista dele, e a promessa documentada é que ela
 * SUBSTITUI os defaults.
 */
export function derivedSudoMethods(cfg: ResolvedServerConfig): SudoMethod[] {
  return mountedSudoMethods.filter((m) => !isDefaultSudoMethodDerivedOut(cfg, m?.id));
}

/**
 * Este id foi DERIVADO PARA FORA da lista de defaults neste host?
 *
 * Ponto único da regra, consultado pelos DOIS lados (a tela, via
 * `configuredSudoMethods`, e os handlers, via `isSudoMethodEnabled`) — é o que
 * torna o drift entre eles estruturalmente impossível também no caso derivado.
 *
 * Nunca responde `true` para uma lista de host, nem para um id que não seja um
 * dos dois built-in do default. Ou seja: só REMOVE, e só remove o que a própria
 * lib pôs lá.
 */
function isDefaultSudoMethodDerivedOut(cfg: ResolvedServerConfig, methodId?: string): boolean {
  if (!mountedFromDefaults) return false;
  // Host passwordless: cai a senha (não há senha usável neste deployment).
  // Host com senha: cai o magic link (posture histórica preservada — o default
  // não passa a oferecer um step-up por e-mail a quem nunca pediu).
  return isPasswordlessHost(cfg) ? methodId === 'password' : methodId === 'magic-link';
}

/**
 * O método `methodId` está habilitado para ESTE host?
 *
 * Toda rota registrada por um `SudoMethod` DEVE começar por aqui. Sem essa
 * checagem, `config.sudo.methods` só esconderia o método da tela: o endpoint
 * continuaria vivo e concedendo sudo — uma config que aparenta restringir e não
 * restringe é pior que nenhuma config.
 *
 * Sem configuração explícita nada foi restringido: vale o que tem rota montada,
 * MENOS o que a derivação do default tirou (ver `isDefaultSudoMethodDerivedOut`).
 * Continua não sendo a lista de defaults a fonte de verdade do que está montado —
 * tratá-la como tal derrubaria um método customizado do host —, e a derivação só
 * remove ids que a própria lib pôs na lista.
 */
export function isSudoMethodEnabled(cfg: ResolvedServerConfig, methodId: string): boolean {
  const explicit = explicitSudoMethods(cfg);
  if (explicit === null) return !isDefaultSudoMethodDerivedOut(cfg, methodId);
  return explicit.some((m) => m?.id === methodId);
}

/**
 * Lista efetiva de métodos da TELA — o irmão de `isSudoMethodEnabled`, e por
 * isso mora coladinho nele.
 *
 * Sem config explícita cai na lista MONTADA, exatamente a mesma resposta que
 * `isSudoMethodEnabled` dá do lado dos handlers ("vale o que tem rota"). Antes
 * caía numa lista de defaults hardcoded, e os dois lados divergiam de verdade:
 * um host que fizesse só
 *
 * ```ts
 * registerAuthHost(router, { sudoMethods: [sudoMethods.magicLink()] })
 * ```
 *
 * montava só magic-link, mas a tela oferecia password + passkey (ambos 404) e
 * NÃO oferecia magic-link, que funcionava. Caindo na lista montada, o drift
 * fica estruturalmente impossível no caso sem config: é literalmente a mesma
 * lista. O aviso de flag-drift do controller passa a valer só para o caso que
 * sobra — config explícita divergindo do que foi montado.
 *
 * "A lista montada" é a lista montada DERIVADA (`derivedSudoMethods`), e os
 * handlers aplicam a MESMA derivação pela mesma função — o drift continua
 * impossível. A derivação existe porque a montagem não conhece o config: ela é
 * quem tira o campo de senha de um host que declarou não ter senha, e quem
 * mantém o default histórico intacto para quem tem.
 */
export function configuredSudoMethods(cfg: ResolvedServerConfig): SudoMethod[] {
  return explicitSudoMethods(cfg) ?? derivedSudoMethods(cfg);
}

/**
 * Verbos HTTP com a forma `(pattern, handler, ...)` — o handler é o SEGUNDO
 * argumento.
 *
 * `route` NÃO entra aqui: sua assinatura é `(pattern, methods, handler)`, com o
 * handler no TERCEIRO argumento, e por isso tem tratamento próprio no Proxy.
 * Deixá-lo de fora da barreira seria um bypass silencioso — `router.route()`
 * registra rota igual a qualquer verbo.
 */
const ROUTER_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'any'] as const;

/**
 * Atalhos do `Router` que registram rotas SEM receber um handler-função: eles
 * expandem um CONTROLLER em N rotas por convenção. Não há função para embrulhar
 * — a barreira não tem por onde entrar —, então são recusados no boot.
 *
 * Ver `assertWrappableHandler` para o porquê de recusar em vez de deixar passar.
 */
const ROUTER_CONTROLLER_SHORTCUTS = ['resource', 'shallowResource'] as const;

/**
 * Envelopa o router entregue a `method.register` para que TODO handler que ele
 * registrar seja barrado quando `config.sudo.methods` não incluir o método.
 *
 * POR QUE NO PONTO DE REGISTRO, e não dentro de cada handler: a barreira é a
 * diferença entre uma config que restringe e uma que só esconde a opção da tela
 * enquanto o endpoint segue concedendo sudo (falha Critical). Deixá-la a cargo
 * de quem escreve o método significa que o PRIMEIRO método que esquecer a
 * chamada reabre a falha — e nada detecta. Aqui a garantia é estrutural: o
 * método não tem como registrar uma rota desguardada, porque não é ele quem
 * segura o router.
 *
 * Os built-in CONTINUAM checando por dentro, e isso não é redundância inútil:
 * cada um recusa na forma que o seu endpoint exige (o `passkey/options` é XHR e
 * devolve JSON 404; um 302 para HTML quebraria o cliente). Este envelope é o
 * piso genérico — recusa com `fail`, o mesmo redirect+flash de um erro comum,
 * que não distingue "método desligado" de "credencial errada" e portanto não
 * vaza a config do host.
 *
 * O QUE NÃO CABE NA BARREIRA É RECUSADO, não tolerado: um handler que não seja
 * função (tupla `[Controller, 'metodo']`) e os atalhos `resource()`/
 * `shallowResource()` lançam no ponto de registro. Ver
 * `ROUTER_CONTROLLER_SHORTCUTS` e o `assertWrappableHandler` abaixo.
 * (`on()` continua passando: ele registra redirect/render estático, sem handler
 * que possa alcançar `completeSudo`.)
 *
 * CUSTO: resolve o config do container antes do handler. Não usa
 * `contextFrom` no caminho feliz de propósito — aquilo faz `findById`, e pagar
 * uma leitura de conta a mais em toda rota de sudo para uma checagem que só lê
 * a config seria desperdício. O contexto completo só é montado para recusar.
 */
export function guardSudoRoutes(
  router: Router,
  methodId: string,
  h: SudoRouteHelpers,
  /**
   * Aplica o throttle do host a CADA rota que o método registrar (no-op quando
   * o rate-limit está desligado). É `registerAuthHost` quem passa isto, porque
   * é lá que os throttles existem — e é aqui que a rota nasce.
   *
   * O throttle que chega aqui é o do bucket de SUDO, não o de login. Mesmos
   * limites, contagem separada: login mede um anônimo adivinhando credenciais,
   * sudo mede um usuário JÁ autenticado reprovando a própria identidade.
   * Compartilhando o bucket, quem erra a senha no `/account/confirm` gastava o
   * orçamento de login do próprio IP — e um ataque de credencial no login
   * trancava a confirmação de quem está legitimamente logado atrás do mesmo
   * NAT. Ver `ResolvedRateLimitConfig.sudo`.
   *
   * Fica no wrapper, e não no contrato de `SudoRouteHelpers`, porque throttle
   * não é decisão do método: um método que pudesse pedir throttle poderia
   * também NÃO pedir, e o `POST` que emite o magic link de sudo — que dispara
   * um e-mail por chamada — voltaria a ficar sem nenhum. Aqui a cobertura é da
   * mesma natureza da barreira de `config.sudo.methods`: estrutural, sem
   * depender de quem escreve o método lembrar de nada.
   */
  applyThrottle?: (route: unknown) => void,
): Router {
  const wrap =
    (handler: (ctx: HttpContext) => unknown) =>
    async (ctx: HttpContext): Promise<unknown> => {
      const service = await (ctx as any).containerResolver.make('authkit.server');
      if (isSudoMethodEnabled(service.config, methodId)) return handler(ctx);

      const c = await h.contextFrom(ctx);
      return h.fail(c, 'account.confirm.error');
    };

  /**
   * A barreira só sabe embrulhar handler-FUNÇÃO. Qualquer outra forma
   * (`[Controller, 'method']`, string `'Controller.method'`) registra uma rota
   * que `config.sudo.methods` não desabilita e que alcança o `completeSudo`
   * público — um bypass silencioso, no exato ponto onde a barreira devia ser
   * estrutural.
   *
   * Por isso LANÇA, em vez de deixar passar. Antes o argumento era "nenhum
   * built-in registra assim" — mas isso é propriedade dos built-in, não da
   * barreira, e o público-alvo do SPI é justamente quem não é built-in.
   *
   * É boot-time e é alto: o host descobre no primeiro `node ace serve`, não em
   * produção com uma rota de sudo desguardada. A saída é registrar um wrapper
   * de uma linha (`(ctx) => new Ctrl().metodo(ctx)`), que passa pela barreira.
   */
  const assertWrappableHandler = (verb: string, pattern: string, handler: unknown) => {
    if (typeof handler === 'function') return handler as (ctx: HttpContext) => unknown;

    throw new Error(
      `authkit: o método de sudo "${methodId}" registrou "${verb} ${pattern}" com um handler que não é função (${handler === undefined ? 'undefined' : typeof handler}). Métodos de sudo precisam registrar handler-função para receber a barreira de \`config.sudo.methods\` — uma tupla \`[Controller, 'metodo']\` registraria uma rota que a config não desabilita e que alcança \`completeSudo\`. Envolva o controller numa função: \`router.post(pattern, (ctx) => new Controller().metodo(ctx))\`.`,
    );
  };

  const wrapIfFn = (verb: string, pattern: string, handler: unknown) =>
    wrap(assertWrappableHandler(verb, pattern, handler));

  return new Proxy(router, {
    // `receiver` é DELIBERADAMENTE `target`, não o Proxy: o `Router` do Adonis é
    // uma classe com campos privados (`#app`, `#globalMatchers`, `#pushToRoutes`),
    // e ler/chamar um membro com `this` apontando para o Proxy lança
    // `TypeError: Cannot read private member #app`.
    get(target, prop) {
      const original = Reflect.get(target, prop, target);
      if (typeof original !== 'function') return original;

      // Throttle na rota recém-criada. O `Route` real é preservado e devolvido,
      // então `.as()`/`.use()` seguem encadeando do lado de fora.
      const throttled = (route: unknown) => {
        applyThrottle?.(route);
        return route;
      };

      // `route(pattern, methods, handler)` — handler no TERCEIRO argumento.
      if (prop === 'route') {
        return (pattern: string, methods: unknown, handler: unknown, ...rest: unknown[]) =>
          throttled(
            original.call(target, pattern, methods, wrapIfFn('route', pattern, handler), ...rest),
          );
      }

      if (ROUTER_VERBS.includes(prop as (typeof ROUTER_VERBS)[number])) {
        return (pattern: string, handler: unknown, ...rest: unknown[]) =>
          throttled(
            original.call(
              target,
              pattern,
              wrapIfFn(String(prop).toUpperCase(), pattern, handler),
              ...rest,
            ),
          );
      }

      // `resource()`/`shallowResource()` expandem um controller em N rotas por
      // convenção: não passa handler-função por lugar nenhum, e a barreira não
      // teria o que embrulhar. Recusa no boot pela mesma razão da tupla — deixar
      // passar seria registrar rotas de sudo que `config.sudo.methods` não
      // desabilita.
      if (
        ROUTER_CONTROLLER_SHORTCUTS.includes(prop as (typeof ROUTER_CONTROLLER_SHORTCUTS)[number])
      ) {
        return (pattern: string) => {
          throw new Error(
            `authkit: o método de sudo "${methodId}" chamou router.${String(prop)}("${pattern}"), que registra rotas a partir de um controller e portanto não pode receber a barreira de \`config.sudo.methods\`. Registre as rotas do método uma a uma, com handler-função.`,
          );
        };
      }

      // Todo o RESTO da API do `Router` (`group`, `on`, `where`, `use`, ...)
      // segue funcionando, ligado ao router real. Sem o
      // `bind`, um `router.group(() => ...)` — uso perfeitamente legítimo do
      // tipo `Router` que `SudoMethod.register` declara receber — rodaria com
      // `this === Proxy` e explodiria no boot da aplicação.
      //
      // `original.call(target, ...)` nos verbos e o `bind` aqui preservam o
      // RETORNO real (`Route`/`RouteGroup`), então `.as()`/`.use()`/
      // `.middleware()`/`.prefix()` continuam encadeando normalmente.
      return original.bind(target);
    },
  });
}

/**
 * ÚNICO ponto do pacote que concede sudo. Nenhum `SudoMethod` chama
 * `markSudo` diretamente: o método decide se verificou, o runtime concede,
 * audita e redireciona.
 */
export async function completeSudo(c: SudoContext, methodId: string): Promise<unknown> {
  // SEGUNDA barreira estrutural, irmã de `guardSudoRoutes`: aquela cobre
  // "o método está habilitado?", esta cobre "a conta existe?".
  //
  // `sudoContextFrom` deixa `account: null` quando `findById` não acha nada —
  // sessão viva de conta apagada ou anonimizada. Cada built-in já checa por
  // dentro, mas depender disso é a mesma falha que `guardSudoRoutes` existe
  // para eliminar do outro lado: o PRIMEIRO método desatento que fizer
  // `contextFrom` → `completeSudo` concederia sudo sobre uma conta que não
  // existe mais, e nada detectaria. A garantia tem de estar aqui, no único
  // ponto de concessão.
  // Falsy, não `=== null`: um contexto montado à mão que simplesmente omita
  // `account` não pode escapar da barreira por um detalhe de forma.
  if (!c.account) return fail(c, 'account.confirm.error');

  markSudo(c.ctx);
  c.ctx.session.put(LAST_METHOD_SESSION_KEY, methodId);

  await c.cfg.audit?.record({
    type: 'sudo.confirmed',
    accountId: c.accountId,
    ip: c.ctx.request.ip?.() ?? null,
    metadata: { method: methodId },
  });

  return c.ctx.response.redirect(c.returnTo ?? accountHome(c.cfg));
}

/**
 * Falha de confirmação: flash + volta pro /account/confirm preservando o
 * destino. Substitui a coreografia que estava duplicada cinco vezes no
 * controller.
 */
export async function fail(c: SudoContext, messageKey: string): Promise<unknown> {
  c.ctx.session.flash('confirmError', translate(c.cfg.messages, messageKey));
  const qs = c.returnTo ? `?return_to=${encodeURIComponent(c.returnTo)}` : '';
  return c.ctx.response.redirect(`${accountPath('confirm')}${qs}`);
}

/**
 * Filtra os métodos disponíveis para esta conta e promove o último usado.
 *
 * `isAvailable` que lança NÃO derruba a tela: um método quebrado não pode
 * trancar o usuário fora dos outros — mesmo espírito do FAIL-SAFE de
 * `requireSudo`.
 */
export async function resolveAvailableMethods(
  c: SudoContext,
  methods: SudoMethod[],
): Promise<SudoMethod[]> {
  const checked = await Promise.all(
    methods.map(async (m) => {
      try {
        return (await m.isAvailable(c)) ? m : null;
      } catch (error) {
        // Fail-safe: um `isAvailable` quebrado não pode trancar o usuário fora
        // dos outros métodos — mas precisa deixar rastro, senão um typo vira
        // um método que some da tela em produção sem ninguém saber por quê.
        // `?.` defensivo: em teste, `fakeSudoContext` pode não ter logger.
        c.ctx.logger?.warn(
          { method: m.id, err: error },
          `authkit: isAvailable() do método de sudo "${m.id}" lançou — método omitido da lista`,
        );
        return null;
      }
    }),
  );

  const available = checked.filter((m): m is SudoMethod => m !== null);
  const last = c.ctx.session.get(LAST_METHOD_SESSION_KEY) as string | undefined;
  if (!last) return available;

  const preferred = available.filter((m) => m.id === last);
  return preferred.length ? [...preferred, ...available.filter((m) => m.id !== last)] : available;
}
