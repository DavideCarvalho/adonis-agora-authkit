/**
 * "Último método usado" no login (o selo "Last used" do Cloudflare/Vercel).
 *
 * O authkit-server grava num cookie DESTE dispositivo o método com que o login
 * foi feito e entrega na prop `lastUsedLoginMethod` de todo render da tela
 * `login` (Edge e Inertia). O cookie é httpOnly: a tela não lê nada no browser,
 * só usa a prop. Ausente = sem selo (primeiro acesso, feature desligada com
 * `login.lastUsedMethod: false`, ou valor inválido).
 */

/**
 * Método de login primário. `social:<provider>` e `custom:<id>` carregam o id
 * para destacar o botão certo entre vários.
 */
export type LastLoginMethod =
  | 'password'
  | 'magic_link'
  | 'otp'
  | 'passkey'
  | `social:${string}`
  | `custom:${string}`;

/**
 * `true` se `lastUsed` (a prop `lastUsedLoginMethod`) é um dos `methods`. Aceita
 * vários para o caso de um botão cobrir mais de um método — ex.: o botão de
 * e-mail de um seletor que manda link e código: `['magic_link', 'otp']`.
 */
export function isLastUsedLoginMethod(
  lastUsed: string | null | undefined,
  methods: LastLoginMethod | readonly LastLoginMethod[],
): boolean {
  if (!lastUsed) return false;
  return (typeof methods === 'string' ? [methods] : methods).includes(lastUsed as LastLoginMethod);
}
