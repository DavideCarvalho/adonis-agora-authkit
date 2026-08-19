import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { PatRecord } from '../../pat/pat_store.js';
import { accountPath } from '../account_paths.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { requireSudo } from '../sudo_mode.js';

export default class AccountTokensController {
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    // PAT é capacidade opcional: sem `patStore` configurado, a tela não existe
    // (404 limpo em vez de "Cannot read properties of undefined"). Tratado como
    // orgs — a rota pode estar montada num host que não cabeou o store.
    if (!cfg.patStore) return ctx.response.notFound();

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const tokens = await cfg.patStore.listForAccount(userId);
    const createdToken = ctx.session.flashMessages.get('createdToken') as string | undefined;
    return render(ctx, 'account/tokens', {
      csrfToken: ctx.request.csrfToken,
      createdToken: createdToken ?? null,
      tokens: tokens.map((t: PatRecord) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        audience: t.audience,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
      })),
    });
  }

  async store(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    // Sem `patStore`: 404 limpo (ver `index`).
    if (!cfg.patStore) return ctx.response.notFound();

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    // Sudo mode gate.
    const sudoSettingsPat = await resolveRuntimeSettings(ctx);
    const sudoResultPat = await requireSudo(ctx, sudoSettingsPat);
    if (sudoResultPat !== true) return sudoResultPat;

    const { name } = ctx.request.only(['name']);
    const { token, pat } = await cfg.patStore.issue({ accountId: userId, name: name || 'Token' });
    ctx.session.flash('createdToken', token);
    await cfg.audit?.record({
      type: 'pat.issued',
      accountId: userId,
      ip: ctx.request.ip?.() ?? null,
      metadata: { patId: pat.id, name: pat.name },
    });
    return ctx.response.redirect(accountPath('tokens'));
  }

  async destroy(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    // Sem `patStore`: 404 limpo (ver `index`).
    if (!cfg.patStore) return ctx.response.notFound();

    const userId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    // Sudo mode gate.
    const sudoSettingsPatRev = await resolveRuntimeSettings(ctx);
    const sudoResultPatRev = await requireSudo(ctx, sudoSettingsPatRev);
    if (sudoResultPatRev !== true) return sudoResultPatRev;

    const patId = ctx.request.param('id');
    const revoked = await cfg.patStore.revoke(userId, patId);
    if (revoked) {
      await cfg.audit?.record({
        type: 'pat.revoked',
        accountId: userId,
        ip: ctx.request.ip?.() ?? null,
        metadata: { patId },
      });
    }
    return ctx.response.redirect(accountPath('tokens'));
  }
}
