/**
 * "Este host consegue satisfazer o próprio sudo?" — a pergunta que ninguém
 * fazia, e cuja resposta "não" trancava o usuário fora de exportar/excluir os
 * próprios dados.
 *
 * MÓDULO FOLHA DE PROPÓSITO: importa só TIPOS. `define_config.ts` precisa
 * chamar o aviso de boot daqui, e `sudo/runtime.ts` precisa da mesma lista de
 * ids — importar `runtime.ts` de dentro do `define_config` fecharia um ciclo
 * (`runtime` → controllers → ... → `define_config`) cuja ordem de avaliação é
 * exatamente o tipo de coisa que quebra em produção e não em teste.
 */

import type { SudoMethod } from './types.js';

/**
 * Métodos built-in que uma conta SEM senha e SEM passkey consegue satisfazer —
 * os únicos que quebram o deadlock do host passwordless.
 *
 * `oidc-step-up` não exige nada previamente cadastrado (é o `prompt=login` do
 * próprio protocolo); `magic-link` exige apenas que a conta tenha e-mail, e a
 * ENTREGA tem fallback para o mailer default do host-kit, então nem hook é
 * obrigatório. Os outros dois built-in — `password` e `passkey` — exigem, por
 * definição, uma credencial que o usuário teria de ter cadastrado ANTES, e é
 * essa a pré-condição que um host passwordless não satisfaz.
 */
export const CREDENTIAL_FREE_SUDO_METHOD_IDS: readonly string[] = ['oidc-step-up', 'magic-link'];

/**
 * Ids dos métodos que ESTE pacote implementa.
 *
 * Serve para o aviso abaixo se CALAR diante de um método customizado: de um
 * método do SPI o pacote não tem como saber se ele exige credencial prévia, e um
 * aviso de boot que grita para uma configuração correta é um aviso que o host
 * aprende a ignorar — justamente o que não pode acontecer com este.
 */
const BUILTIN_SUDO_METHOD_IDS: readonly string[] = [
  'password',
  'passkey',
  'oidc-step-up',
  'magic-link',
];

/**
 * Avisa, NO BOOT, quando a configuração de sudo deste host não tem um único
 * método que uma conta sem senha possa satisfazer.
 *
 * QUANDO DISPARA (as quatro condições, todas necessárias):
 *
 * 1. O host declarou `sudo.methods` EXPLICITAMENTE. Sem declaração vale o
 *    default derivado, que já resolve o caso passwordless — não há o que avisar.
 * 2. O deployment tem contas sem senha usável: `authMethods.password === false`
 *    (ninguém entra por senha) ou `passwordless.signup === true` (o cadastro
 *    público cria contas com um hash aleatório inutilizável).
 * 3. Nenhum dos métodos declarados é credential-free.
 * 4. TODOS os métodos declarados são built-in deste pacote — ou seja, o pacote
 *    consegue de fato PROVAR que a lista exige credencial prévia.
 *
 * WARN, NÃO THROW. Recusar o boot seria transformar um upgrade de patch/minor
 * numa aplicação que não sobe, em produção, por uma condição que é
 * DEGRADAÇÃO — a tela de confirmação fica sem opções, o que já falha fechado — e
 * não uma brecha. Pior: a remediação nem sempre é uma linha de config
 * (`oidcStepUp` exige uma rota e um callback no host), então o app ficaria fora
 * do ar até alguém escrever código. E a detecção é, por construção, incompleta
 * (item 4): um throw baseado numa heurística derruba host correto. O irmão
 * `adonis-agent` recusa montar quando a superfície PROVADAMENTE não funciona;
 * aqui não há prova — há forte suspeita, e o lugar disso é um aviso alto.
 *
 * @returns a mensagem emitida, ou `null` quando não havia nada a avisar (para
 * teste; o efeito de verdade é o `console.warn`).
 */
export function warnUnsatisfiableSudoConfig(input: {
  /** `config.sudo.methods` — a lista que o host declarou, se declarou. */
  methods?: SudoMethod[];
  /** `authMethods.password` pinado em `false`? */
  passwordPinnedOff: boolean;
  /** `passwordless.signup` ligado? */
  passwordlessSignup: boolean;
  /** Injeção para teste. Default: `console.warn`. */
  warn?: (message: string) => void;
}): string | null {
  const declared = Array.isArray(input.methods) ? input.methods : [];
  if (!declared.length) return null;
  if (!input.passwordPinnedOff && !input.passwordlessSignup) return null;

  const ids = declared.map((m) => m?.id).filter((id): id is string => typeof id === 'string');
  if (ids.length !== declared.length) return null; // lista malformada: não é este o aviso
  if (ids.some((id) => CREDENTIAL_FREE_SUDO_METHOD_IDS.includes(id))) return null;
  if (!ids.every((id) => BUILTIN_SUDO_METHOD_IDS.includes(id))) return null;

  const trigger = input.passwordPinnedOff
    ? 'authMethods: { password: false }'
    : 'passwordless: { signup: true }';

  const message = [
    `authkit: sudo mode SEM SAÍDA para contas sem senha. Este host declarou \`${trigger}\`, então existem contas sem senha usável — mas \`sudo.methods\` só lista [${ids.join(', ')}], e todos exigem uma credencial cadastrada ANTES.`,
    'Consequência: essas contas ficam trancadas fora de TODA operação sob `requireSudo` — exportar/excluir dados (LGPD), MFA, Personal Access Tokens, troca de e-mail — inclusive fora do cadastro de passkey, que é o que destravaria o resto.',
    'Saída: acrescente `sudoMethods.oidcStepUp({ url: "/auth/step-up" })` (reautenticação no seu IdP) ou `sudoMethods.magicLink()` (link de confirmação por e-mail, enviado pelo mailer do app quando não há hook `mail.onSudoLink`) à lista de `sudo.methods`.',
  ].join(' ');

  (input.warn ?? console.warn)(message);
  return message;
}
