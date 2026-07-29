/**
 * Builders das URLs de interaction do AuthKit — a camada de funções (tier mais
 * baixo) do login. Os apps não devem concatenar `'/auth/interaction/' + uid + '/...'`
 * à mão: se o prefixo de rota do authkit-server mudar, a string mágica quebra
 * silenciosamente. Uma fonte única, tipada, resolve isso.
 */

/** Endpoints do fluxo de interaction para um `uid`. */
export interface InteractionUrls {
  /** POST — envia o identificador (e-mail) e avança pro passo de credenciais. */
  identifier: string;
  /** POST — login por senha. */
  login: string;
  /** POST — dispara o envio do magic link. */
  magic: string;
  /** GET — tela de criação de conta. */
  signup: string;
  /** GET — troca de conta (volta pro passo de identificador). */
  switch: string;
  /** POST — options da cerimônia de passkey. */
  passkeyOptions: string;
  /** POST — verificação (página inteira) da cerimônia de passkey. */
  passkeyVerify: string;
  /**
   * POST — verificação do código OTP de 6 dígitos (`login.otp`, rota montada
   * pelo authkit-server 0.50+ em `/auth/interaction/:uid/otp-verify`). Ficou
   * fora do helper até a 0.18 — hosts que usavam OTP montavam a string à mão
   * (exatamente o acoplamento que este builder existe pra evitar).
   */
  otpVerify: string;
}

/**
 * Monta as URLs de interaction para um `uid`. `basePath` default `/auth/interaction`
 * cobre o mount padrão do authkit-server; passe outro se o app montou em prefixo
 * diferente.
 */
export function interactionUrls(uid: string, basePath = '/auth/interaction'): InteractionUrls {
  const base = `${basePath}/${uid}`;
  return {
    identifier: `${base}/identifier`,
    login: `${base}/login`,
    magic: `${base}/magic`,
    signup: `${base}/signup`,
    switch: `${base}/switch`,
    passkeyOptions: `${base}/passkey/options`,
    passkeyVerify: `${base}/passkey/verify`,
    otpVerify: `${base}/otp-verify`,
  };
}

/** Passos de interaction que são POST de formulário (consumidos por `InteractionForm`). */
export type InteractionPostStep = 'identifier' | 'login' | 'magic' | 'otpVerify';

/**
 * Nome do campo do form clássico do código OTP de 6 dígitos
 * (`<input name="code">`) — o `otpVerify` do authkit-server lê
 * `ctx.request.input('code')`. Exportado para que a TELA e o teste E2E do host
 * importem da MESMA fonte: um typo no nome do campo quebra os dois juntos em
 * vez de o teste divergir silenciosamente do que a tela envia.
 */
export const OTP_CODE_FIELD = 'code';

/**
 * URL de redirect de um provedor OAuth (ex.: `oauthRedirectUrl('google', uid)` →
 * `/auth/google/redirect/{uid}`). `basePath` default `/auth`.
 */
export function oauthRedirectUrl(provider: string, uid: string, basePath = '/auth'): string {
  return `${basePath}/${provider}/redirect/${uid}`;
}
