/**
 * Textos do Poppy somados ao i18n do authkit (`messages` da extension). O host troca qualquer um
 * em `i18n.messages` do `config/authkit.ts`, como os do próprio authkit.
 */
export const POPPY_MESSAGES = {
  en: {
    // Código do Mediated Sign-In pronto (`poppyEmailCodeSignIn`): um personal agent pede para
    // entrar na conta.
    'mail.poppy_sign_in.subject': 'Your code to connect {agent}',
    'mail.poppy_sign_in.heading': 'Connect {agent} to your account',
    'mail.poppy_sign_in.intro':
      '{agent} asked to sign in to your account. If that was you, give it the code below. It expires in {minutes} minutes and works once.',
    'mail.poppy_sign_in.code_label': 'Your code:',
    'mail.poppy_sign_in.fallback':
      'If you did not ask for this, ignore this email — nobody gets in without the code. Never share it with anyone else.',
  },
  'pt-BR': {
    'mail.poppy_sign_in.subject': 'Seu código para conectar {agent}',
    'mail.poppy_sign_in.heading': 'Conecte {agent} à sua conta',
    'mail.poppy_sign_in.intro':
      '{agent} pediu para entrar na sua conta. Se foi você, informe o código abaixo. Ele expira em {minutes} minutos e serve uma única vez.',
    'mail.poppy_sign_in.code_label': 'Seu código:',
    'mail.poppy_sign_in.fallback':
      'Se não foi você, ignore este e-mail — ninguém entra sem o código. Nunca o compartilhe com outra pessoa.',
  },
} as const;
