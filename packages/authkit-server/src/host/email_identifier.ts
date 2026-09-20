import type { AuthAccount } from '../accounts/account_store.js';

/**
 * Normalização ÚNICA e CONSERVADORA do e-mail usado como identidade da conta.
 *
 * Faz `trim()` + `toLowerCase()` e MAIS NADA. O endereço que a pessoa digitou é a
 * identidade dela: a lib NÃO decide que `a.b@gmail.com` e `ab@gmail.com` são a
 * mesma pessoa, nem descarta o sub-endereço (`+tag`) que ela escolheu usar.
 *
 * POR QUE ISTO EXISTE: até a v0.68 o cadastro validava o e-mail com
 * `.normalizeEmail()` do VineJS (os defaults do validator.js), que para o gmail
 * REMOVE os pontos e o `+tag` do local part. A conta nascia com um endereço
 * DIFERENTE do digitado (`davi.carvalho96@gmail.com` → `davicarvalho96@gmail.com`)
 * enquanto o passo de identificador do login não normalizava NADA e buscava por
 * igualdade exata — resultado: quem tinha ponto ou `+tag` no gmail ficava
 * trancado do lado de fora, e, por o login ser à prova de enumeração, sem
 * nenhuma mensagem de erro. Uma normalização só, usada nos DOIS lados, fecha a
 * assimetria.
 *
 * Use em TODO ponto que grava ou busca a identidade: cadastro (com e sem senha),
 * "esqueci a senha", troca de e-mail, criação por admin, convite de organização,
 * import de usuários, cadastro social e o passo de identificador do login.
 */
export function normalizeEmailIdentifier(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

// ─── Ponte de compatibilidade com a normalização LEGADA ─────────────────────

/** Domínios do gmail (pontos e sub-endereço eram removidos do local part). */
const GMAIL_DOMAINS = ['gmail.com', 'googlemail.com'];

/** Domínios do iCloud (sub-endereço `+tag` removido). */
const ICLOUD_DOMAINS = ['icloud.com', 'me.com'];

/** Domínios do Outlook.com/Hotmail/Live (sub-endereço `+tag` removido). */
const OUTLOOK_DOMAINS = [
  'hotmail.at',
  'hotmail.be',
  'hotmail.ca',
  'hotmail.cl',
  'hotmail.co.il',
  'hotmail.co.nz',
  'hotmail.co.th',
  'hotmail.co.uk',
  'hotmail.com',
  'hotmail.com.ar',
  'hotmail.com.au',
  'hotmail.com.br',
  'hotmail.com.gr',
  'hotmail.com.mx',
  'hotmail.com.pe',
  'hotmail.com.tr',
  'hotmail.com.vn',
  'hotmail.cz',
  'hotmail.de',
  'hotmail.dk',
  'hotmail.es',
  'hotmail.fr',
  'hotmail.hu',
  'hotmail.id',
  'hotmail.ie',
  'hotmail.in',
  'hotmail.it',
  'hotmail.jp',
  'hotmail.kr',
  'hotmail.lv',
  'hotmail.my',
  'hotmail.ph',
  'hotmail.pt',
  'hotmail.sa',
  'hotmail.sg',
  'hotmail.sk',
  'live.be',
  'live.co.uk',
  'live.com',
  'live.com.ar',
  'live.com.mx',
  'live.de',
  'live.es',
  'live.eu',
  'live.fr',
  'live.it',
  'live.nl',
  'msn.com',
  'outlook.at',
  'outlook.be',
  'outlook.cl',
  'outlook.co.il',
  'outlook.co.nz',
  'outlook.co.th',
  'outlook.com',
  'outlook.com.ar',
  'outlook.com.au',
  'outlook.com.br',
  'outlook.com.gr',
  'outlook.com.pe',
  'outlook.com.tr',
  'outlook.com.vn',
  'outlook.cz',
  'outlook.de',
  'outlook.dk',
  'outlook.es',
  'outlook.fr',
  'outlook.hu',
  'outlook.id',
  'outlook.ie',
  'outlook.in',
  'outlook.it',
  'outlook.jp',
  'outlook.kr',
  'outlook.lv',
  'outlook.my',
  'outlook.ph',
  'outlook.pt',
  'outlook.sa',
  'outlook.sg',
  'outlook.sk',
  'passport.com',
];

/** Domínios do Yahoo (sub-endereço `-tag` removido). */
const YAHOO_DOMAINS = [
  'rocketmail.com',
  'yahoo.ca',
  'yahoo.co.uk',
  'yahoo.com',
  'yahoo.de',
  'yahoo.fr',
  'yahoo.in',
  'yahoo.it',
  'ymail.com',
];

/** Domínios do Yandex (todos colapsavam em `yandex.ru`). */
const YANDEX_DOMAINS = ['yandex.ru', 'yandex.ua', 'yandex.kz', 'yandex.com', 'yandex.by', 'ya.ru'];

/** Remove pontos SOLTOS do local part (pontos consecutivos ficam — regra do validator.js). */
function stripSingleDots(local: string): string {
  return local.replace(/\.+/g, (match) => (match.length > 1 ? match : ''));
}

/**
 * Réplica da normalização LEGADA — `normalizeEmail()` do validator.js com os
 * defaults, que é o que o `.normalizeEmail()` do VineJS aplicava no cadastro até
 * a v0.68. Existe SÓ para reencontrar as contas que nasceram com o endereço
 * mutilado; nada novo deve ser gravado com ela.
 *
 * É uma PONTE TEMPORÁRIA: quando as contas antigas tiverem sido migradas para o
 * endereço real (ou o suficiente delas), esta função, a opção
 * `login.legacyEmailFallback` e {@link resolveEmailIdentifier} podem sair.
 *
 * Retorna `null` para entradas que o validator.js também recusaria (local part
 * vazio depois do colapso) ou que não são um endereço com `@`.
 */
export function legacyNormalizeEmailIdentifier(raw: string | null | undefined): string | null {
  const email = normalizeEmailIdentifier(raw);
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;

  let local = email.slice(0, at);
  let domain = email.slice(at + 1);

  if (GMAIL_DOMAINS.includes(domain)) {
    local = local.split('+')[0];
    local = stripSingleDots(local);
    domain = 'gmail.com';
  } else if (ICLOUD_DOMAINS.includes(domain) || OUTLOOK_DOMAINS.includes(domain)) {
    local = local.split('+')[0];
  } else if (YAHOO_DOMAINS.includes(domain)) {
    const parts = local.split('-');
    local = parts.length > 1 ? parts.slice(0, -1).join('-') : parts[0];
  } else if (YANDEX_DOMAINS.includes(domain)) {
    domain = 'yandex.ru';
  }

  if (!local.length) return null;
  return `${local}@${domain}`;
}

// ─── Resolução da conta a partir do que foi digitado ────────────────────────

/** Só o que {@link resolveEmailIdentifier} precisa do account store. */
export interface EmailIdentifierLookup {
  findByEmail(email: string): Promise<AuthAccount | null>;
}

export interface ResolvedEmailIdentifier {
  /** O que a pessoa digitou, normalizado. É o que a tela SEMPRE mostra. */
  email: string;
  /**
   * E-mail sob o qual a conta está GRAVADA — o que deve ir para o store em
   * qualquer busca/emissão de token. Igual a {@link email} quando a conta foi
   * achada direto (ou quando não foi achada nenhuma).
   */
  lookupEmail: string;
  /** A conta, quando alguma foi encontrada. */
  account: AuthAccount | null;
  /** `true` quando a conta só foi alcançada pela ponte legada. */
  viaLegacyFallback: boolean;
}

/**
 * Resolve o e-mail digitado na conta correspondente.
 *
 * 1. Busca pela forma normalizada NOVA (trim + lowercase) — o caminho de sempre,
 *    uma única query por igualdade (indexada).
 * 2. Não achando, e com a ponte ligada (`login.legacyEmailFallback`, default
 *    `true`), tenta as formas de compatibilidade:
 *    - o endereço EXATAMENTE como digitado (só com `trim`), para as contas que
 *      foram gravadas com maiúsculas antes desta normalização existir (import,
 *      convite, criação por admin, provider social);
 *    - a {@link legacyNormalizeEmailIdentifier normalização legada}, para as
 *      contas que nasceram com o endereço mutilado.
 *    O resultado só é aceito quando as formas de compatibilidade apontam para
 *    EXATAMENTE UMA conta. Duas contas distintas (ex.: `Davi.C@Gmail.com` criada
 *    pelo social E `davic@gmail.com` criada pelo cadastro legado) são um empate:
 *    a lib não adivinha qual é a pessoa e trata como "não achei".
 *
 * À PROVA DE ENUMERAÇÃO: nunca lança, nunca sinaliza nada para fora — quem chama
 * segue com `account: null` exatamente como seguia antes. As buscas extras só
 * acontecem quando as formas de compatibilidade DIFEREM da normalizada (e-mail
 * digitado em minúsculas e sem ponto/tag → uma query só, como hoje).
 */
export async function resolveEmailIdentifier(
  store: EmailIdentifierLookup,
  raw: string | null | undefined,
  options: { legacyFallback?: boolean } = {},
): Promise<ResolvedEmailIdentifier> {
  const email = normalizeEmailIdentifier(raw);
  const miss: ResolvedEmailIdentifier = {
    email,
    lookupEmail: email,
    account: null,
    viaLegacyFallback: false,
  };
  if (!email) return miss;

  const direct = await store.findByEmail(email);
  if (direct) return { email, lookupEmail: email, account: direct, viaLegacyFallback: false };

  if (options.legacyFallback === false) return miss;

  const typed = (raw ?? '').trim();
  const legacy = legacyNormalizeEmailIdentifier(email);
  const candidates = [typed, legacy].filter(
    (candidate): candidate is string => !!candidate && candidate !== email,
  );

  const byId = new Map<string, AuthAccount>();
  for (const candidate of new Set(candidates)) {
    const found = await store.findByEmail(candidate);
    if (found) byId.set(found.id, found);
  }
  if (byId.size !== 1) return miss;

  const account = [...byId.values()][0];
  return { email, lookupEmail: account.email, account, viaLegacyFallback: true };
}
