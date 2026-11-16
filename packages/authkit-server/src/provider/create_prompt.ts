/**
 * `prompt=create` — OpenID Connect "Initiating User Registration via OpenID Connect 1.0".
 *
 * oidc-provider only accepts the prompt values of its interaction policy (anything else is
 * `invalid_request: unsupported prompt value requested`), so `create` is registered there as a
 * requestable prompt with no checks of its own: it never opens an interaction by itself. When
 * the user has to sign in, the login interaction opens on the sign-up screen
 * (`interaction_controller.show`); with an IdP session already there, the request goes on as a
 * normal login — the same as the `audience=signup` hint.
 */
import * as oidc from 'oidc-provider';

const { Prompt, base } = (oidc as any).interactionPolicy;

/** The interaction policy: oidc-provider's default plus `prompt=create`. */
export function interactionPolicyWithCreate(): unknown[] {
  const policy = base();
  const create = new Prompt({ name: 'create', requestable: true });
  create.checks.clear();
  policy.add(create);
  return policy;
}

/** The `prompt_values_supported` of discovery for an interaction policy. */
export function promptValuesSupported(policy: unknown[]): string[] {
  return [
    'none',
    ...(policy as Array<{ name: string; requestable: boolean }>)
      .filter((p) => p.requestable)
      .map((p) => p.name),
  ];
}

/** Whether an authorization request (its `prompt` parameter) asked for `prompt=create`. */
export function requestsCreate(params: { prompt?: unknown }): boolean {
  return typeof params.prompt === 'string' && params.prompt.split(' ').includes('create');
}
