export interface TokenSet {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms do access token
  /**
   * Nonce opaco que amarra ESTE token set à credencial de impersonação parqueada
   * em `${sessionKey}_impersonator`. Escrito só por `impersonate()`; preservado
   * pelo `maybeRefresh`; conferido pelo `stopImpersonating()`. Qualquer outra
   * escrita no slot da sessão (login novo, logout+login) nasce sem ele — que é
   * exatamente o sinal de que a sessão deixou de ser aquela p/ a qual a
   * credencial foi guardada. Não é segredo de autenticação: é um vínculo.
   */
  impersonationBinding?: string;
}
