import type { ApplicationService } from '@adonisjs/core/types';
import { DEV_TOOLS_BINDING, type DevToolsHub } from './contract.js';
import { authkitDevToolsAuthorize } from './gate.js';
import { authkitDevTools } from './tools.js';

/**
 * Registers authkit's developer tools into the Agora dev MCP hub (`'agora.devTools'`, bound by
 * `@adonis-agora/agent`'s `mcp_provider`). No-op when the hub is not bound, speaks another contract
 * version, or the admin console is off. Returns whether it registered.
 */
export async function registerAuthkitDevTools(
  app: Pick<ApplicationService, 'container'>,
  config: { admin?: { enabled?: boolean } | null },
): Promise<boolean> {
  if (!config.admin?.enabled) return false;
  const container = app.container as unknown as {
    hasBinding(binding: string): boolean;
    make(binding: string): Promise<unknown>;
  };
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return false;
  const hub = (await container.make(DEV_TOOLS_BINDING)) as DevToolsHub | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register({
    lib: 'authkit',
    title: 'Identity (authkit admin)',
    authorize: authkitDevToolsAuthorize(),
    tools: authkitDevTools({ resolve: () => container.make('authkit.server') }),
  });
  return true;
}
