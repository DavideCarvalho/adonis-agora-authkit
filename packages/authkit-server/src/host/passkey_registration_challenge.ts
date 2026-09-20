/**
 * Chave de sessão do desafio WebAuthn PENDENTE de REGISTRO de passkey.
 *
 * Mora num módulo próprio porque a cerimônia agora tem DOIS pares de rotas — o
 * clássico (`/account/mfa/passkeys/{options,verify}`, que responde redirect numa
 * navegação) e o JSON (`/account/api/mfa/passkeys/{options,verify}`, que nunca
 * navega). Os dois precisam ler e escrever o MESMO slot: um `begin` feito por um
 * caminho tem de poder ser finalizado pelo outro, e — mais importante — um
 * desafio só pode existir UMA vez por sessão. Duas constantes com o mesmo valor
 * em arquivos diferentes seriam a mesma coisa até alguém mudar uma delas.
 */
export const PASSKEY_REG_CHALLENGE_KEY = 'authkit_passkey_reg_challenge';
