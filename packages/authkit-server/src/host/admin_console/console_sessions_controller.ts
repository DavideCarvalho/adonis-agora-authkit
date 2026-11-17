import '../augmentations.js';
import { decodeCursor, encodeCursor, InvalidColumnFilterError } from '@adonis-agora/filter';
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { apiError, grantDto, sessionDto } from '../admin_api/dto.js';
import { type AdminSession, AdminSessionsService } from '../admin_sessions_service.js';
import { sessionAccountValidator } from '../admin_validators.js';
import {
  pageRows,
  readCursor,
  readListFilter,
  readSearch,
  readSort,
  SessionListFilter,
  searchRows,
  sortRows,
  withListQuery,
} from '../list_api.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { enrichSessionsWithContext } from '../session_context.js';
import { requireSudo } from '../sudo_mode.js';

/**
 * Gate de sudo (M9): revogar TODAS as sessões/grants de uma conta é
 * destrutivo (derruba todo device logado, inclusive o próprio, se o alvo for
 * o admin) — exige reconfirmação recente de identidade. Mesmo padrão de
 * `console_users_controller.ts` (JSON 403 em vez do redirect que
 * `requireSudo` monta para telas HTML).
 */
async function gateSudo(ctx: HttpContext): Promise<unknown | null> {
  const settings = await resolveRuntimeSettings(ctx);
  const result = await requireSudo(ctx, settings);
  if (result === true) return null;
  return ctx.response
    .status(403)
    .send(apiError('sudo_required', 'Identity confirmation required.'));
}

/**
 * Endpoints JSON de sessões/grants do console admin React.
 *
 * GET    {prefix}/api/sessions?filter[accountId]=&search=&sort=&page=&size= → página de sessões ativas
 * POST   {prefix}/api/sessions/revoke-all      → revoga todas as sessões de ?accountId=
 * GET    {prefix}/api/users/:id/sessions       → lista sessões + grants de um usuário específico
 * POST   {prefix}/api/users/:id/revoke-sessions → revoga todas as sessões de um usuário específico
 */
export default class ConsoleSessionsController {
  /**
   * Helper privado: lista sessões + grants de uma conta específica.
   * Retorna o shape UserSessionsResult: { supported, truncated, sessions, grants }.
   */
  private async listForAccount(ctx: HttpContext, accountId: string) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const adminSvc = new AdminSessionsService(service);

    if (!adminSvc.canList) {
      return { supported: false, sessions: [], grants: [] };
    }

    const account = await cfg.accountStore.findById(accountId);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));

    const rawSessions = await adminSvc.listSessions(accountId);
    const enriched = await enrichSessionsWithContext(cfg, accountId, rawSessions);
    const grants = await adminSvc.listGrants(accountId);

    return {
      supported: true,
      truncated: false,
      sessions: enriched.map(sessionDto),
      grants: grants.map(grantDto),
    };
  }

  /**
   * GET {prefix}/api/sessions — active sessions, one page:
   * `?filter[accountId]=&search=&sort=-loginTs|email&page=&size=` →
   * `{ data, meta, supported, truncated, grants }`. `search` matches the email or the IP;
   * `grants` lists the account's grants when `filter[accountId]` is set (`[]` otherwise).
   */
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const adminSvc = new AdminSessionsService(service);
    const qs = ctx.request.qs();

    return withListQuery(ctx, async () => {
      const filter = await readListFilter(qs, SessionListFilter);
      const sort = readSort(qs, { sortable: ['loginTs', 'email'], default: '-loginTs' });

      if (!adminSvc.canList) {
        return { ...pageRows([], qs), supported: false, truncated: false, grants: [] };
      }

      const accountId = filter.first('accountId');
      if (!accountId && wantsCursor(qs)) {
        return this.#cursorPage(adminSvc, qs, readSearch(qs), sort[0]);
      }
      let sessions: AdminSession[];
      let grants: ReturnType<typeof grantDto>[] = [];
      let truncated = false;
      if (accountId) {
        const account = await cfg.accountStore.findById(accountId);
        if (!account) {
          return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));
        }
        sessions = (
          await enrichSessionsWithContext(cfg, accountId, await adminSvc.listSessions(accountId))
        ).map((s) => ({ ...s, email: s.email ?? account.email }));
        grants = (await adminSvc.listGrants(accountId)).map(grantDto);
      } else {
        const all = await adminSvc.listAllSessions();
        sessions = all.sessions;
        truncated = all.truncated;
      }

      const found = searchRows(sessions, readSearch(qs), [(s) => s.email, (s) => s.ip]);
      const sorted = sortRows(found, sort, {
        loginTs: (s) => s.loginTs ?? null,
        email: (s) => s.email ?? null,
      });
      const page = pageRows(sorted, qs);
      return { ...page, data: page.data.map(sessionDto), supported: true, truncated, grants };
    });
  }

  /**
   * The global listing by cursor (`first`, `after`): `{ data, meta: { nextCursor, … }, supported,
   * truncated: false, grants: [] }`. Most recent activity first, read one page at a time from a
   * database adapter (`listRecent`), with no total. A search, an email sort or an adapter that
   * cannot page (Redis) walks the bounded in-memory listing instead, by position.
   */
  async #cursorPage(
    adminSvc: AdminSessionsService,
    qs: Record<string, unknown>,
    search: string,
    sort: { field: string; direction: 'asc' | 'desc' } | undefined,
  ) {
    const { after, before, size } = readCursor(qs);
    if (before !== undefined) {
      throw new InvalidColumnFilterError('Sessions page forward only: use after and first.');
    }
    let cursor: unknown[] | undefined;
    if (after !== undefined) {
      const decoded = decodeCursor(after);
      if (decoded === null) throw new InvalidColumnFilterError('Invalid cursor.');
      cursor = decoded;
    }
    const byRecency =
      !search && (sort === undefined || (sort.field === 'loginTs' && sort.direction === 'desc'));
    if (byRecency && adminSvc.canListRecent) {
      const position =
        cursor === undefined
          ? undefined
          : cursor[0] === 'r' && typeof cursor[1] === 'number' && typeof cursor[2] === 'string'
            ? { expiresAt: cursor[1], id: cursor[2] }
            : null;
      if (position === null) throw new InvalidColumnFilterError('Invalid cursor.');
      const page = await adminSvc.listRecentSessions({
        limit: size,
        ...(position ? { after: position } : {}),
      });
      return {
        data: page.sessions.map(sessionDto),
        meta: {
          nextCursor: page.next ? encodeCursor(['r', page.next.expiresAt, page.next.id]) : null,
          prevCursor: null,
          hasNext: page.next !== null,
          hasPrev: position !== undefined,
        },
        supported: true,
        truncated: false,
        grants: [],
      };
    }
    // The bounded fallback: the capped listing, searched and sorted in memory, walked by position.
    const offset =
      cursor === undefined
        ? 0
        : cursor[0] === 'o' && Number.isSafeInteger(cursor[1]) && (cursor[1] as number) >= 0
          ? (cursor[1] as number)
          : null;
    if (offset === null) throw new InvalidColumnFilterError('Invalid cursor.');
    const all = await adminSvc.listAllSessions();
    const found = searchRows(all.sessions, search, [(s) => s.email, (s) => s.ip]);
    const sorted = sortRows(found, sort ? [sort] : [], {
      loginTs: (s) => s.loginTs ?? null,
      email: (s) => s.email ?? null,
    });
    const end = offset + size;
    const hasNext = sorted.length > end;
    return {
      data: sorted.slice(offset, end).map(sessionDto),
      meta: {
        nextCursor: hasNext ? encodeCursor(['o', end]) : null,
        prevCursor: null,
        hasNext,
        hasPrev: offset > 0,
      },
      supported: true,
      truncated: all.truncated,
      grants: [],
    };
  }

  /** GET {prefix}/api/users/:id/sessions */
  async userSessions(ctx: HttpContext) {
    const accountId = (ctx.params.id as string).trim();
    if (!accountId) {
      return ctx.response.badRequest(apiError('invalid_request', 'O parâmetro id é obrigatório.'));
    }
    return this.listForAccount(ctx, accountId);
  }

  /** POST {prefix}/api/users/:id/revoke-sessions */
  async userRevokeSessions(ctx: HttpContext) {
    const denied = await gateSudo(ctx);
    if (denied) return denied;

    const accountId = (ctx.params.id as string).trim();
    if (!accountId) {
      return ctx.response.badRequest(apiError('invalid_request', 'O parâmetro id é obrigatório.'));
    }
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

    const sessions = new AdminSessionsService(service);
    const result = await sessions.revokeAll(accountId);

    await cfg.audit?.record({
      type: 'session.revoked_all',
      accountId,
      actorId,
      ip,
      metadata: {
        sessions: result.sessions,
        grants: result.grants,
        accessTokens: result.accessTokens,
        refreshTokens: result.refreshTokens,
        source: 'admin-console',
      },
    });

    return { ok: true, ...result };
  }

  /** POST {prefix}/api/sessions/revoke-all?accountId= */
  async revokeAll(ctx: HttpContext) {
    const denied = await gateSudo(ctx);
    if (denied) return denied;

    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

    // accountId pode vir por query/body OU route param — Vine valida o valor já
    // coalescido (validate() aceita qualquer dado, não só request.all()).
    const { accountId } = await sessionAccountValidator.validate({
      accountId:
        (ctx.request.input('accountId') as string | undefined) ??
        (ctx.request.param('accountId') as string | undefined),
    });

    const sessions = new AdminSessionsService(service);
    const result = await sessions.revokeAll(accountId);

    await cfg.audit?.record({
      type: 'session.revoked_all',
      accountId,
      actorId,
      ip,
      metadata: {
        sessions: result.sessions,
        grants: result.grants,
        accessTokens: result.accessTokens,
        refreshTokens: result.refreshTokens,
        source: 'admin-console',
      },
    });

    return { ok: true, ...result };
  }
}

/** Does the request page by cursor (`first`, `after`, `last`, `before`) rather than `page`? */
function wantsCursor(qs: Record<string, unknown>): boolean {
  return ['first', 'after', 'last', 'before'].some(
    (name) => qs[name] !== undefined && qs[name] !== '',
  );
}
