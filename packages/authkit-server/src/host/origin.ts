import type { ResolvedServerConfig } from '../define_config.js';

/**
 * The canonical public origin for links we EMAIL (password reset, magic link,
 * OTP unlock, org invitations, email verification/change, security notices).
 *
 * Never derive these from `request.host()` / `request.protocol()` (which reads
 * `X-Forwarded-Proto` under a trusting proxy config): both are client-supplied.
 * An attacker who can reach the server directly (common when the app sits
 * behind a load balancer that does not pin `Host`) can submit a password-reset
 * or magic-link request for a victim's address with a `Host` of their choosing,
 * and the victim's genuine email ends up pointing at attacker-controlled
 * infrastructure. This is classic password-reset poisoning.
 *
 * Defaults to the origin (`scheme://host[:port]`, no trailing slash, mount
 * path stripped) of the resolved `issuer` — the one canonical origin this
 * library already has. Hosts that legitimately serve the same issuer under
 * multiple public hostnames (and therefore want emailed links to follow the
 * request instead of normalizing to a single hostname) can opt out via the
 * `mail.origin` config escape hatch.
 */
export function authkitOrigin(cfg: ResolvedServerConfig): string {
  return cfg.mail?.origin ?? new URL(cfg.issuer).origin;
}
