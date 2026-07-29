import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Router } from '@adonisjs/core/http';
import { accountPath } from '../../account_paths.js';
import { sendSudoLinkEmail } from '../../default_mailer.js';
import { translate } from '../../i18n.js';
import { isSudoMethodEnabled } from '../runtime.js';
import type { SudoContext, SudoMethod, SudoRouteHelpers } from '../types.js';

/** Token de sudo pendente, guardado na sessão que o pediu. */
export const SUDO_LINK_SESSION_KEY = 'authkit_sudo_link';

/** Mesma janela dos magic links de login. */
export const SUDO_LINK_TTL_MS = 5 * 60 * 1000;

interface PendingLink {
  hash: string;
  expiresAt: number;
  /**
   * Conta que PEDIU o link.
   *
   * A defesa "o pendente morre no logout" é FALSA: o `regenerate()` do
   * `@adonisjs/session` só troca o id do cookie e MIGRA os dados para o id novo.
   * Num navegador compartilhado, A pede o link, faz logout, B loga — o
   * `ACCOUNT_SESSION_KEY` vira B e o pendente de A sobrevive. Sem este campo, A
   * abre o link do próprio e-mail e ganha sudo sobre a conta de B.
   *
   * O token, portanto, vale para UMA conta, não para um navegador.
   */
  accountId: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Emite um token de sudo e guarda o HASH na sessão que pediu.
 *
 * O TOKEN É PRÓPRIO, DE ESCOPO SUDO — nunca o token de login
 * (`issueMagicLinkToken`/`consumeMagicLinkToken` do `AccountStore`). Aquele é
 * credencial de AUTENTICAÇÃO: reusá-lo faria de um link de sudo vazado uma
 * sessão completa.
 *
 * | propriedade | valor | razão |
 * |---|---|---|
 * | geração | `randomBytes(32)` hex | entropia de credencial |
 * | armazenamento | HASH na sessão que pediu | não guarda o segredo em claro |
 * | escopo | só marca sudo | nunca autentica |
 * | validade | 5 min | mesma janela dos magic links de login |
 * | uso | único (apagado no consumo) | replay |
 * | navegador | só o mesmo (vive na sessão) | step-up é reprova de QUEM ESTÁ ALI |
 * | conta | vinculado ao `accountId` emissor | sessão sobrevive à troca de conta |
 *
 * O "só mesmo navegador" é propriedade desejada aqui, diferente do magic link
 * de login, onde é limitação conhecida.
 *
 * Exportada (em vez de membro `__` do método) para ser testável sem furar a
 * API pública do `SudoMethod`.
 */
export function issueSudoLinkToken(c: SudoContext): string {
  const token = randomBytes(32).toString('hex');
  const pending: PendingLink = {
    hash: sha256(token),
    expiresAt: Date.now() + SUDO_LINK_TTL_MS,
    accountId: c.accountId,
  };
  c.ctx.session.put(SUDO_LINK_SESSION_KEY, pending);
  return token;
}

/**
 * Consome o token: single-use, vinculado à conta emissora, expira em 5 min,
 * comparação em tempo constante.
 */
export function verifySudoLinkToken(c: SudoContext, token: string): boolean {
  const pending = c.ctx.session.get(SUDO_LINK_SESSION_KEY) as Partial<PendingLink> | undefined;

  // GUARD DE FORMA, antes de qualquer uso dos campos. A sessão é um saco de
  // JSON: um valor com outra forma (versão antiga do pacote, host que escreveu
  // na chave, store corrompido) tinha duas consequências ruins —
  //   1. `Buffer.from(undefined, 'hex')` → TypeError → 500;
  //   2. `Date.now() > undefined` é `false` → FAIL-OPEN: o token nunca expira.
  // Forma errada é recusa, não exceção e muito menos passe livre.
  if (
    typeof pending?.hash !== 'string' ||
    typeof pending?.expiresAt !== 'number' ||
    typeof pending?.accountId !== 'string'
  ) {
    // Lixo na chave não pode ficar lá bloqueando/confundindo a próxima emissão.
    c.ctx.session.forget(SUDO_LINK_SESSION_KEY);
    return false;
  }

  // Single-use: some na primeira tentativa, certa ou errada.
  c.ctx.session.forget(SUDO_LINK_SESSION_KEY);

  // VINCULAÇÃO À CONTA: quem consome tem de ser quem pediu. A sessão sobrevive
  // à troca de conta (o `regenerate()` do logout MIGRA os dados), então "está
  // pendente nesta sessão" não implica "é desta conta". Ver `PendingLink.accountId`.
  if (pending.accountId !== c.accountId) return false;

  if (Date.now() > pending.expiresAt) return false;

  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(pending.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Origem absoluta desta requisição, ou `null` se o request não a expõe.
 *
 * O link vai por E-MAIL: um caminho relativo (`/account/confirm/...`) não é
 * clicável fora do navegador. É a mesma montagem do `onMagicLink` de login
 * (interaction_controller.ts:706). O `null` é fallback defensivo — se o host
 * usar um request sem `protocol()`/`host()`, cai para o caminho relativo em vez
 * de mandar `undefined://undefined/...`.
 */
function requestOrigin(ctx: any): string | null {
  const protocol = ctx?.request?.protocol?.();
  const host = ctx?.request?.host?.();
  return protocol && host ? `${protocol}://${host}` : null;
}

/**
 * Confirmação por link enviado ao e-mail da conta.
 *
 * O hook `mail.onSudoLink` é DISTINTO de `mail.onMagicLink` justamente para que
 * o host não confunda um link que autentica com um que só concede sudo a quem já
 * está logado — e continua tendo PRIORIDADE quando declarado.
 *
 * SEM O HOOK O MÉTODO SEGUE DISPONÍVEL: o próprio host-kit envia o e-mail pelo
 * mailer default (`sendSudoLinkEmail`), exatamente como já faz com reset de
 * senha, verificação de e-mail e o magic link de login. Antes o método se
 * declarava indisponível sem hook, e num host passwordless isso FECHAVA o
 * deadlock — sem senha, sem passkey e sem hook não sobrava nenhum método
 * satisfazível na tela `/account/confirm`, e o usuário ficava trancado fora de
 * exportar/excluir os próprios dados, do MFA, dos PATs e da troca de e-mail,
 * inclusive fora do cadastro de passkey que destravaria o resto. Exigir um hook
 * escrito à mão para que o único método sem credencial prévia funcione é
 * transformar uma saída de emergência em opt-in.
 *
 * A única exigência que resta é a que não tem substituto: a conta precisa ter
 * e-mail.
 */
export function magicLink(): SudoMethod {
  return {
    id: 'magic-link',

    async isAvailable(c: SudoContext) {
      return Boolean(c.account?.email);
    },

    async describe() {
      return {
        labelKey: 'account.confirm.method.magic_link',
        kind: 'action' as const,
        endpoint: `${accountPath('confirm')}/magic-link`,
      };
    },

    register(router: Router, h: SudoRouteHelpers) {
      router.post(`${accountPath('confirm')}/magic-link`, async (ctx: any) => {
        const c = await h.contextFrom(ctx);

        // ANTES de qualquer coisa: o host desligou este método? A rota é montada
        // incondicionalmente, então só o handler faz `config.sudo.methods` valer.
        // Responde `fail` (o mesmo redirect+flash de um erro comum) em vez de
        // 404 para não vazar a config do host.
        if (!isSudoMethodEnabled(c.cfg, 'magic-link')) return h.fail(c, 'account.confirm.error');

        // `c.account` é nullable (sessão viva de conta apagada → findById null)
        // e sem e-mail não há para onde mandar o link.
        if (!c.account?.email) return h.fail(c, 'account.confirm.error');

        const qs = c.returnTo ? `?return_to=${encodeURIComponent(c.returnTo)}` : '';
        const token = issueSudoLinkToken(c);
        const path = `${accountPath('confirm')}/magic-link/${token}${qs}`;
        const origin = requestOrigin(ctx);
        const sudoUrl = origin ? `${origin}${path}` : path;

        // ENTREGA. Hook do host quando declarado; senão o mailer default do
        // host-kit (mesma precedência de todo e-mail da lib). O que NÃO é
        // opcional é haver uma entrega: um método de sudo que só funciona se o
        // host escrever um hook não serve de saída de emergência para o host
        // passwordless, que é justamente quem depende dele.
        const onSudoLink = c.cfg?.mail?.onSudoLink;
        let delivered = false;
        try {
          if (typeof onSudoLink === 'function') {
            await onSudoLink({ email: c.account.email, sudoUrl });
            delivered = true;
          } else {
            delivered = await sendSudoLinkEmail(ctx, { email: c.account.email, sudoUrl });
          }
        } catch {
          delivered = false;
        }

        if (!delivered) {
          // O envio falhou: apaga o pendente. Não é risco de segurança (o
          // segredo não chegou a lugar nenhum), mas deixá-lo lá invalidaria
          // silenciosamente um token anterior ainda válido do usuário.
          c.ctx.session.forget(SUDO_LINK_SESSION_KEY);
          return h.fail(c, 'account.confirm.error');
        }

        // TRADUZIDO, não a chave crua: o `fail()` do runtime flasha
        // `translate(...)` em `confirmError`, e a tela leria dois formatos
        // diferentes se este aqui mandasse a chave.
        ctx.session.flash(
          'confirmNotice',
          translate(c.cfg.messages, 'account.confirm.magic_link_sent'),
        );
        return ctx.response.redirect(`${accountPath('confirm')}${qs}`);
      });

      router.get(`${accountPath('confirm')}/magic-link/:token`, async (ctx: any) => {
        const c = await h.contextFrom(ctx);

        if (!isSudoMethodEnabled(c.cfg, 'magic-link')) return h.fail(c, 'account.confirm.error');

        // Sem conta resolvida não há a quem conceder sudo. O token vive na
        // sessão, mas quem o consome precisa continuar sendo uma conta viva.
        //
        // NÃO INVERTA ESTA ORDEM. O `!c.account` vem ANTES do
        // `verifySudoLinkToken` de propósito: o `verify` é DESTRUTIVO (queima o
        // pendente na primeira tentativa, certa ou errada), e scanners
        // corporativos de e-mail — Safe Links do Microsoft 365, proxies de
        // antivírus — fazem prefetch da URL SEM o cookie de sessão. Nesse
        // prefetch não há conta resolvida: com esta ordem ele é recusado antes
        // de tocar no pendente, e o link continua válido para o usuário. Trocar
        // as duas linhas faria todo link chegar já consumido.
        if (!c.account) return h.fail(c, 'account.confirm.error');

        const token = ctx.params?.token as string | undefined;
        if (!token || !verifySudoLinkToken(c, token)) return h.fail(c, 'account.confirm.error');

        return h.completeSudo(c, 'magic-link');
      });
    },
  };
}
