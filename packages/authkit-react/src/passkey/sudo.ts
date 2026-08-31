/**
 * O "dance" de passkey por FORM CLÁSSICO — a cerimônia WebAuthn seguida do submit
 * de página inteira que os fluxos de sudo (e de registro de passkey) do authkit
 * exigem.
 *
 * Por que form clássico e não fetch? Os endpoints de sudo/passkey respondem 302
 * (redirect de navegação), que um `fetch` não segue como navegação. Então: pega as
 * options (`x-csrf-token`), roda `startAuthentication`/`startRegistration`, e
 * submete o resultado no campo `response` de um `<form>` real — com `_csrf` e
 * `return_to` quando fornecidos.
 *
 * Estas funções são a camada testável (deps injetáveis: fetch, loaders e
 * `document`); os hooks `usePasskeyAssertion`/`usePasskeyRegistration` só embrulham
 * elas com estado de `running`/`error`.
 */

import {
  authenticatePasskey,
  type PasskeyCeremonyDeps,
  type PasskeyRegistrationDeps,
  registerPasskey,
} from './authenticate.js';
import { type SubmitClassicFormDeps, submitClassicForm } from './classic_form.js';

/** Options comuns às duas cerimônias de sudo/passkey por form clássico. */
export interface RunPasskeyFlowOptions {
  /** Endpoint de options (POST) — `${...}/options`. */
  optionsUrl: string;
  /** Endpoint de verificação (POST de página inteira). O `response` vai no form. */
  actionUrl: string;
  /** CSRF token: header `x-csrf-token` no options e campo `_csrf` no form. */
  csrfToken?: string;
  /** Quando fornecido, vai como campo `return_to` do form (destino pós-redirect). */
  returnTo?: string | null;
}

/** Deps injetáveis (só para teste) do fluxo de assertion. */
export type RunPasskeyAssertionDeps = PasskeyCeremonyDeps & SubmitClassicFormDeps;
/** Deps injetáveis (só para teste) do fluxo de registro. */
export type RunPasskeyRegistrationDeps = PasskeyRegistrationDeps & SubmitClassicFormDeps;

/**
 * Monta os campos do form clássico: `response` (o attestation/assertion serializado)
 * sempre; `_csrf` e `return_to` só quando fornecidos. É aqui que mora a regra
 * "inclui `return_to` quando existe, omite quando não".
 */
function flowFields(
  response: string,
  csrfToken: string | undefined,
  returnTo: string | null | undefined,
): Record<string, string> {
  const fields: Record<string, string> = { response };
  if (csrfToken) fields._csrf = csrfToken;
  if (returnTo) fields.return_to = returnTo;
  return fields;
}

/**
 * Roda a cerimônia de ASSERTION (confirmar identidade por passkey) e submete o
 * resultado por form clássico. Se o passo de options falhar, LANÇA antes de tocar
 * no DOM — nenhuma navegação acontece (o chamador reporta o erro).
 */
export async function runPasskeyAssertion(
  options: RunPasskeyFlowOptions,
  deps: RunPasskeyAssertionDeps = {},
): Promise<void> {
  const { optionsUrl, actionUrl, csrfToken, returnTo } = options;
  const assertion = await authenticatePasskey(
    { optionsUrl, csrfToken },
    { fetch: deps.fetch, loadStartAuthentication: deps.loadStartAuthentication },
  );
  submitClassicForm(
    { action: actionUrl, fields: flowFields(assertion, csrfToken, returnTo) },
    { document: deps.document },
  );
}

/**
 * Roda a cerimônia de REGISTRO de passkey e submete o resultado por form clássico.
 * Mesma mecânica do {@link runPasskeyAssertion}, com `startRegistration`.
 */
export async function runPasskeyRegistration(
  options: RunPasskeyFlowOptions,
  deps: RunPasskeyRegistrationDeps = {},
): Promise<void> {
  const { optionsUrl, actionUrl, csrfToken, returnTo } = options;
  const attestation = await registerPasskey(
    { optionsUrl, csrfToken },
    { fetch: deps.fetch, loadStartRegistration: deps.loadStartRegistration },
  );
  submitClassicForm(
    { action: actionUrl, fields: flowFields(attestation, csrfToken, returnTo) },
    { document: deps.document },
  );
}
