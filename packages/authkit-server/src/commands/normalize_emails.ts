import type { AccountStore } from '../accounts/account_store.js';
import { supportsAccountEmailRewrite } from '../accounts/account_store.js';
import { normalizeEmailIdentifier } from '../host/email_identifier.js';
import { ADMIN_LIST_DEFAULT_SIZE } from '../pagination.js';

/** Uma conta cujo endereço gravado difere da forma normalizada. */
export interface EmailNormalizationChange {
  accountId: string;
  /** Endereço como está gravado hoje. */
  from: string;
  /** Forma normalizada (`trim` + `toLowerCase`) — o que o login busca. */
  to: string;
  /** `true` quando o `--apply` gravou; `false` no relatório e quando a escrita falhou. */
  applied: boolean;
  /** Motivo da escrita não ter acontecido (só com `--apply`). */
  error?: string;
}

/**
 * Duas ou mais contas que colapsam no MESMO endereço normalizado — por exemplo
 * `Davi@Acme.com` e `davi@acme.com`. A migração NÃO escolhe vencedor e NÃO funde
 * contas: lista as envolvidas e não toca em nenhuma delas.
 */
export interface EmailNormalizationCollision {
  /** A forma normalizada em que as contas colidem. */
  email: string;
  /** As contas envolvidas, com o endereço que cada uma tem gravado hoje. */
  accounts: { accountId: string; email: string }[];
}

export interface NormalizeEmailsReport {
  /** Contas varridas. */
  scanned: number;
  /** Contas que já estão na forma normalizada (não são tocadas). */
  alreadyNormalized: number;
  /** As que mudariam (ou mudaram, com `--apply`), fora de colisão. */
  changes: EmailNormalizationChange[];
  /** Quantas foram efetivamente gravadas (0 sem `--apply`). */
  applied: number;
  /** Colisões encontradas — decisão humana. */
  collisions: EmailNormalizationCollision[];
  /** Contas que a colisão impediu de mexer (soma das contas de `collisions`). */
  skippedByCollision: number;
  /**
   * Contas cujo endereço gravado NÃO normaliza para nada (coluna nula, vazia ou
   * só espaços). Não entram em `alreadyNormalized`: gravar string vazia como
   * identidade seria pior que deixar como está, e um operador que lê "já
   * normalizada" não pode achar que estas linhas estão bem.
   */
  unusable: { accountId: string; email: string }[];
}

/** Comparação por code unit — mesma ordem em qualquer máquina, sem depender do ICU. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Migração dos endereços GRAVADOS para a forma normalizada da identidade
 * (`normalizeEmailIdentifier`: `trim` + `toLowerCase`).
 *
 * POR QUE ELA EXISTE: até a v0.68 o cadastro gravava o endereço mutilado pelo
 * `.normalizeEmail()` do VineJS (no gmail, sem pontos e sem `+tag`), e import,
 * convite e provider social gravavam a grafia crua, com maiúsculas. O login
 * busca UMA forma só — a normalizada. Uma conta gravada em qualquer outra grafia
 * fica INALCANÇÁVEL, e, por o login ser à prova de enumeração, sem nenhuma
 * mensagem de erro. Esta migração é o que reencontra essas contas.
 *
 * Em modo RELATÓRIO (default) não escreve nada: varre, calcula e devolve o que
 * mudaria. Com `apply`, grava — RECUSANDO-SE a tocar em qualquer conta envolvida
 * numa colisão (duas contas que colapsam no mesmo endereço). Nunca funde contas,
 * nunca escolhe vencedor: as colididas saem listadas para decisão humana.
 *
 * A varredura acontece INTEIRA antes de qualquer escrita, de propósito: a
 * listagem é ordenada por e-mail, e reescrever endereços no meio da paginação
 * moveria linhas entre páginas — contas seriam puladas sem nenhum sinal.
 *
 * Lógica PURA quanto a CLI (recebe o store, devolve o relatório) — testável sem
 * ace e sem banco.
 */
export async function normalizeAccountEmails(
  store: AccountStore,
  options: { apply?: boolean; pageSize?: number } = {},
): Promise<NormalizeEmailsReport> {
  const pageSize = options.pageSize ?? ADMIN_LIST_DEFAULT_SIZE;
  const report: NormalizeEmailsReport = {
    scanned: 0,
    alreadyNormalized: 0,
    changes: [],
    applied: 0,
    collisions: [],
    skippedByCollision: 0,
    unusable: [],
  };

  // 1) Varredura completa. Guarda só id + e-mail (strings), agrupados pela forma
  //    normalizada — é o agrupamento que revela as colisões.
  const buckets = new Map<string, { accountId: string; email: string }[]>();
  for (let page = 1; ; page++) {
    const { data, total } = await store.listAccounts({ page, size: pageSize });
    if (!data.length) break;
    for (const account of data) {
      report.scanned++;
      const normalized = normalizeEmailIdentifier(account.email);
      const bucket = buckets.get(normalized);
      if (bucket) bucket.push({ accountId: account.id, email: account.email });
      else buckets.set(normalized, [{ accountId: account.id, email: account.email }]);
    }
    if (report.scanned >= total) break;
  }

  // 2) Classificação: colisão, mudança ou já normalizada.
  const pending: EmailNormalizationChange[] = [];
  for (const [normalized, accounts] of buckets) {
    // `normalized` vazio (coluna nula/vazia/só espaços) não é migrável. Sai
    // LISTADO, não somado às "já normalizadas": o relatório não pode dar
    // atestado de saúde para a linha que ele deliberadamente deixou para trás.
    // ANTES da checagem de colisão: duas linhas em branco caem no mesmo balde
    // `""` e sairiam como "colisão no endereço ''", que não descreve nada.
    if (!normalized) {
      report.unusable.push(...accounts);
      continue;
    }
    if (accounts.length > 1) {
      // Duas contas distintas no mesmo endereço normalizado. NENHUMA é tocada —
      // nem a que já está normalizada, porque a decisão (fundir? renomear? qual
      // delas é a pessoa?) é humana e envolve as duas.
      report.collisions.push({ email: normalized, accounts });
      report.skippedByCollision += accounts.length;
      continue;
    }
    const [account] = accounts;
    if (account.email === normalized) {
      report.alreadyNormalized++;
      continue;
    }
    pending.push({
      accountId: account.accountId,
      from: account.email,
      to: normalized,
      applied: false,
    });
  }
  // Ordem estável (por endereço gravado) para o relatório ser diffável entre
  // runs. Comparação por code unit, NÃO `localeCompare`: a ordem desta depende
  // do ICU da máquina, e aí "diffável" valeria só dentro de um host.
  pending.sort((a, b) => byCodeUnit(a.from, b.from));
  report.collisions.sort((a, b) => byCodeUnit(a.email, b.email));
  // `unusable` tambem: sem isto a lista sairia na ordem da varredura, que e a
  // ordem do store — a mesma garantia nao valeria para ela.
  report.unusable.sort((a, b) => byCodeUnit(a.accountId, b.accountId));
  report.changes = pending;

  if (!options.apply) return report;

  // 3) Escrita. Capacidade probada: um store sem ela não tem como regravar o
  //    endereço, e inventar um caminho por fora do store não é da lib.
  if (!supportsAccountEmailRewrite(store)) {
    throw new Error(
      'accountStore não implementa rewriteAccountEmail: a migração não tem como gravar (relatório segue funcionando).',
    );
  }
  for (const change of pending) {
    try {
      const ok = await store.rewriteAccountEmail(change.accountId, change.to);
      if (ok) {
        change.applied = true;
        report.applied++;
      } else {
        // O store recusou: conta sumiu ou o endereço passou a ser de OUTRA conta
        // entre a varredura e a escrita (colisão que nasceu no meio do caminho).
        change.error = 'o store recusou a regravação (conta inexistente ou endereço já tomado)';
      }
    } catch (error) {
      change.error = (error as Error).message;
    }
  }

  return report;
}
