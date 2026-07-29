import { createHash, randomBytes } from 'node:crypto';

/**
 * Hashing dos tokens armazenados nas colunas `passwordResetToken` /
 * `emailVerificationToken` (reset de senha, magic link, magic link com OTP).
 *
 * Mesmo padrão de `host/otp_lockout.ts` (`generateOtpUnlockToken` /
 * `rawToDbOtpUnlockToken`): hasheia SÓ a parte aleatória do token — o prefixo
 * (`ml:`, `ml2:`, etc., ou nenhum, no caso do reset) fica em texto claro no
 * valor gravado, porque os guards de discriminação de fluxo (ex.:
 * `consumePasswordResetToken` recusando `ml:`/`ml2:`; `consumeMagicLinkToken`
 * recusando o que não é `ml:`) leem esse prefixo direto do valor armazenado —
 * hashear a string inteira (prefixo incluso) tornaria essa leitura impossível.
 *
 * Motivo de existir como módulo próprio (em vez de reusar `otp_lockout.ts`):
 * aquele arquivo já está correto e é o EXEMPLAR, não o alvo — mantê-lo intocado
 * evita qualquer risco de regressão nele por este changeset.
 */

/** sha256 hex de uma string. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Gera um token `prefix + <64 hex aleatórios>` e devolve tanto o valor BRUTO
 * (vai para o e-mail/URL) quanto o valor a persistir no DB
 * (`prefix + sha256(<parte aleatória>)`).
 *
 * `prefix` pode ser vazio (caso do reset de senha, que não tem prefixo).
 */
export function generateHashedToken(prefix = ''): { raw: string; dbValue: string } {
  const random = randomBytes(32).toString('hex');
  return { raw: `${prefix}${random}`, dbValue: `${prefix}${sha256Hex(random)}` };
}

/**
 * Converte um token BRUTO recebido (com o `prefix` esperado) no valor de DB
 * correspondente (`prefix + sha256(<parte aleatória>)`), para lookup por
 * igualdade. Não valida o prefixo — o chamador já deve ter confirmado
 * `raw.startsWith(prefix)` antes de chegar aqui (guards de discriminação).
 */
export function rawToDbToken(prefix: string, raw: string): string {
  const random = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return `${prefix}${sha256Hex(random)}`;
}
