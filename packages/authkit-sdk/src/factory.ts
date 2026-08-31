import type { EmbeddedOptions } from './embedded_driver.js';
import { createEmbeddedAuthkit } from './embedded_driver.js';
import type { RemoteOptions } from './remote_driver.js';
import { createRemoteAuthkit } from './remote_driver.js';
import type { Authkit } from './types.js';

export type CreateAuthkitOptions =
  | ({ mode: 'remote' } & RemoteOptions)
  | ({ mode: 'embedded' } & EmbeddedOptions);

/**
 * Creates an AuthKit backend SDK over the Admin API. Pick a driver via `mode`:
 *
 *  - `remote`: HTTP against `<baseUrl>/api/authkit/v1` with a Bearer API key.
 *  - `embedded`: in-process, resolving the server services from the AdonisJS
 *    container — use when the IdP runs in the SAME app.
 *
 * Always returns a Promise (the embedded driver lazy-imports the server kit).
 */
export function createAuthkit(options: CreateAuthkitOptions): Promise<Authkit> {
  if (options.mode === 'embedded') {
    return createEmbeddedAuthkit(options);
  }
  return Promise.resolve(createRemoteAuthkit(options));
}
