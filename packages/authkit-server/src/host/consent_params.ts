import type { ConsentRequestParams } from './screen_props.js';

/** Optional standard parameters of an authorization request, typed as strings. */
const CONSENT_STRING_PARAMS = [
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'prompt',
  'nonce',
  'code_challenge',
  'code_challenge_method',
] as const;

/**
 * The interaction's request parameters for the consent screen: `client_id` and the
 * standard string parameters are guaranteed strings (or absent); everything else is
 * passed through untouched.
 */
export function consentRequestParams(
  raw: Record<string, unknown> | undefined,
): ConsentRequestParams {
  const params: ConsentRequestParams = { ...raw, client_id: String(raw?.client_id ?? '') };
  for (const key of CONSENT_STRING_PARAMS) {
    const value = raw?.[key];
    if (typeof value === 'string') params[key] = value;
    else delete params[key];
  }
  return params;
}
