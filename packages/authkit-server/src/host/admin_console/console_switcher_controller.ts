import type { HttpContext } from '@adonisjs/core/http';
import { listVisibleConsoles, searchConsoles } from '../../console_switcher.js';
import { ADMIN_CONSOLE_ID, consoleRegistry } from './admin_console_entry.js';

/**
 * The console switcher endpoints of the admin console (behind the admin console's own guard).
 *
 * GET {prefix}/api/consoles           → the other consoles this viewer may open
 * GET {prefix}/api/consoles/search?q= → hits from every console this viewer may open
 */
export default class ConsoleSwitcherController {
  async index(ctx: HttpContext) {
    const body = await listVisibleConsoles(await consoleRegistry(), ADMIN_CONSOLE_ID, ctx, {
      logger: ctx.logger,
    });
    ctx.response.header('Cache-Control', 'private, no-store');
    return body;
  }

  async search(ctx: HttpContext) {
    const q = ctx.request.input('q', '');
    const body = await searchConsoles(
      await consoleRegistry(),
      ADMIN_CONSOLE_ID,
      ctx,
      typeof q === 'string' ? q : '',
      { logger: ctx.logger },
    );
    ctx.response.header('Cache-Control', 'private, no-store');
    return body;
  }
}
