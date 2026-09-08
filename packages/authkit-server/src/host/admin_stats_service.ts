import type { ResolvedServerConfig } from '../define_config.js';
import { ADMIN_LIST_MAX_SIZE, LIST_FIRST_PAGE } from '../pagination.js';

/** Um ponto de série diária (dia ISO `YYYY-MM-DD` + contagem). */
export interface DailyPoint {
  /** Data no formato `YYYY-MM-DD` (UTC). */
  date: string;
  count: number;
}

/** Métricas-resumo do IdP para o dashboard do console admin. */
export interface AdminStats {
  /** Total de contas (do accountStore). */
  totalUsers: number;
  /** Sessões ativas (Session enumeradas no adapter); null quando o adapter não enumera. */
  activeSessions: number | null;
  /** Monthly Active Users: contas únicas com login.success nos últimos 30 dias. */
  mau: number;
  /** Sign-ins por dia (login.success) nos últimos 30 dias. */
  signInsPerDay: DailyPoint[];
  /** Sign-ups por dia (signup) nos últimos 30 dias. */
  signUpsPerDay: DailyPoint[];
  /** Total de sign-ins na janela de 30 dias. */
  signInsTotal: number;
  /** Total de sign-ups na janela de 30 dias. */
  signUpsTotal: number;
  /** Indica se o audit suporta consulta (`list`). Quando false, as séries vêm vazias. */
  auditSupported: boolean;
  /** Quantos dias a janela cobre (30). */
  windowDays: number;
}

/** Janela de agregação (dias). */
const WINDOW_DAYS = 30;
/**
 * Teto de eventos lidos do audit por tipo na agregação em memória. O sink default
 * (Lucid) não tem agregação SQL exposta, então listamos as N linhas mais recentes e
 * agregamos aqui. 10000 cobre ~333 logins/dia por 30 dias com folga.
 */
const MAX_EVENTS = 10000;

/**
 * Agrega métricas do IdP para o dashboard. CAPABILITY-PROBED: a fonte das séries é
 * o audit store via `list` — quando ausente, as séries/MAU degradam para vazio/0 e
 * `auditSupported=false` (a UI mostra "consulta não suportada"). As sessões ativas
 * vêm da enumeração do adapter OIDC (null quando o adapter não enumera).
 *
 * LIMITAÇÃO: a agregação é em memória sobre as {@link MAX_EVENTS} linhas mais
 * recentes de cada tipo (o `AuditSink` não expõe agregação por dia/distinct). Em
 * volumes muito altos a janela pode não cobrir os 30 dias inteiros; documentado e
 * suficiente para um dashboard. Um sink customizado pode implementar agregação
 * nativa e expor um `stats()` próprio no futuro.
 */
export async function computeAdminStats(
  cfg: Pick<ResolvedServerConfig, 'audit' | 'accountStore'>,
  sessionsService: { canList: boolean; countActiveSessions(): Promise<number> },
): Promise<AdminStats> {
  const totalUsers = (await cfg.accountStore.listAccounts({ page: LIST_FIRST_PAGE, size: 1 }))
    .total;
  const activeSessions = sessionsService.canList
    ? await sessionsService.countActiveSessions()
    : null;

  const auditSupported = typeof cfg.audit?.list === 'function';
  if (!auditSupported) {
    return {
      totalUsers,
      activeSessions,
      mau: 0,
      signInsPerDay: emptySeries(),
      signUpsPerDay: emptySeries(),
      signInsTotal: 0,
      signUpsTotal: 0,
      auditSupported: false,
      windowDays: WINDOW_DAYS,
    };
  }

  const windowStartMs = startOfWindowMs();

  const signIns = await loadEventsInWindow(cfg.audit!, 'login.success', windowStartMs);
  const signUps = await loadEventsInWindow(cfg.audit!, 'signup', windowStartMs);

  // MAU: contas únicas com algum login.success na janela.
  const mauSet = new Set<string>();
  for (const e of signIns) {
    if (e.accountId) mauSet.add(e.accountId);
  }

  return {
    totalUsers,
    activeSessions,
    mau: mauSet.size,
    signInsPerDay: bucketByDay(signIns),
    signUpsPerDay: bucketByDay(signUps),
    signInsTotal: signIns.length,
    signUpsTotal: signUps.length,
    auditSupported: true,
    windowDays: WINDOW_DAYS,
  };
}

interface WindowEvent {
  accountId: string | null;
  tsMs: number;
}

/**
 * Carrega (paginando) os eventos de um tipo dentro da janela, com teto de
 * {@link MAX_EVENTS}. Para assim que a página vier mais antiga que a janela (o sink
 * lista desc por createdAt) ou ao atingir o teto.
 */
async function loadEventsInWindow(
  audit: NonNullable<ResolvedServerConfig['audit']>,
  type: string,
  windowStartMs: number,
): Promise<WindowEvent[]> {
  const out: WindowEvent[] = [];
  const size = ADMIN_LIST_MAX_SIZE;
  let page = LIST_FIRST_PAGE;
  while (out.length < MAX_EVENTS) {
    const result = await audit.list!({ type, page, size });
    if (result.data.length === 0) break;
    let allBelowWindow = true;
    for (const e of result.data) {
      const tsMs = toMs(e.createdAt);
      if (tsMs === null) continue;
      if (tsMs >= windowStartMs) {
        allBelowWindow = false;
        out.push({ accountId: e.accountId ?? null, tsMs });
        if (out.length >= MAX_EVENTS) break;
      }
    }
    // Página inteira anterior à janela → não há mais nada relevante (ordem desc).
    if (allBelowWindow) break;
    if (result.data.length < size) break;
    page += 1;
  }
  return out;
}

/** Agrupa eventos por dia (UTC `YYYY-MM-DD`), preenchendo TODOS os dias da janela com 0. */
function bucketByDay(events: WindowEvent[]): DailyPoint[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const day = dayKey(e.tsMs);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return seriesDays().map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

/** Série de 30 dias vazia (todos os dias com 0), p/ o degrade sem audit. */
function emptySeries(): DailyPoint[] {
  return seriesDays().map((date) => ({ date, count: 0 }));
}

/** Os WINDOW_DAYS dias da janela (do mais antigo ao hoje), `YYYY-MM-DD` UTC. */
function seriesDays(): string[] {
  const days: string[] = [];
  const todayMs = Date.now();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    days.push(dayKey(todayMs - i * 86400000));
  }
  return days;
}

function startOfWindowMs(): number {
  // Início (00:00 UTC) do primeiro dia da janela.
  const firstDay = seriesDays()[0];
  return Date.parse(`${firstDay}T00:00:00.000Z`);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function toMs(createdAt: Date | string | null): number | null {
  if (!createdAt) return null;
  const ms = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(ms) ? ms : null;
}
