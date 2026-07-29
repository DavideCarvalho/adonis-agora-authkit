import { createHash, randomBytes } from 'node:crypto';
import type { DateTime } from 'luxon';

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

// ─────────────────────────────────────────────────────────────────────────
// Variante EXPIRÁVEL (plan 009): `emailVerificationToken` (verificação de
// cadastro, sem prefixo) e `ec:` (troca de e-mail) embutem uma deadline
// (`exp`, epoch ms) dentro do PRÓPRIO token — não numa coluna separada.
//
// Por quê: esta lib não é dona da tabela `users` (ver header de
// `src/schema/ensure.ts`), então não pode adicionar uma coluna
// `emailVerificationExpiresAt` como o reset de senha tem. A alternativa óbvia
// — embutir o `exp` no valor que o cliente devolve — parecia insegura antes de
// 007: um valor sob controle do cliente poderia ter o `exp` adulterado.
//
// 007 fechou essa brecha ao fazer o LOOKUP reconstruir o valor de DB a partir
// do token bruto recebido e buscar por IGUALDADE (em vez de ler a linha
// primeiro e comparar depois). Isso vale integralmente aqui: o `exp` fica em
// CLARO dentro do valor gravado (`prefix<exp>:sha256(<random>)`), mas ele faz
// parte da STRING inteira que é comparada por igualdade na query. Se o
// cliente reescrever o `exp` no token que devolve, a reconstrução
// (`prefix<expAdulterado>:sha256(<random>)`) produz uma string DIFERENTE da
// que está gravada — a query não encontra NENHUMA linha, e o token é
// simplesmente rejeitado.
//
// Ou seja: o MATCH em si (achar a linha) já prova que o `exp` que acabou de
// ser lido é exatamente o mesmo que foi gerado no `issue*` — nenhuma
// assinatura/HMAC separada é necessária. É só DEPOIS desse match que o `exp`
// pode ser avaliado contra o relógio com confiança. NÃO SIMPLIFIQUE isso lendo
// o `exp` do token ANTES do match, nem tratando um `exp` ausente/inválido como
// "sem prazo" — as duas coisas reabririam a adulteração que este desenho
// fecha (ver testes de mutação no plano 009).
//
// Este raciocínio SÓ é válido enquanto o token continuar hasheado em repouso
// (a parte `random` do valor). Se algum dia alguém reverter o hashing, o `exp`
// embutido volta a ficar sob controle total do cliente.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Gera um token expirável `<prefix><exp>:<random>` e devolve tanto o BRUTO
 * (vai pro e-mail/URL) quanto o valor de DB (`<prefix><exp>:sha256(<random>)`).
 *
 * `prefix` pode incluir estrutura própria (ex.: `ec:<b64email>:` na troca de
 * e-mail) — é só um prefixo literal, igual em `generateHashedToken`. `expiresAt`
 * é a deadline; é serializada como epoch ms (`toMillis()`) dentro do próprio
 * token — ver o comentário do bloco acima para a análise de segurança.
 */
export function generateExpiringHashedToken(
  prefix: string,
  expiresAt: DateTime,
): { raw: string; dbValue: string } {
  const exp = expiresAt.toMillis();
  const random = randomBytes(24).toString('hex');
  return {
    raw: `${prefix}${exp}:${random}`,
    dbValue: `${prefix}${exp}:${sha256Hex(random)}`,
  };
}

/**
 * Separa `<exp>:<random>` de um token BRUTO `<prefix><exp>:<random>` (depois de
 * remover o `prefix`). `null` se não há `:` após o prefixo (token mal formado —
 * nem `exp` nem `random` são extraíveis).
 */
function splitExpiringRaw(prefix: string, raw: string): { expPart: string; random: string } | null {
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const sepIdx = rest.indexOf(':');
  if (sepIdx === -1) return null;
  return { expPart: rest.slice(0, sepIdx), random: rest.slice(sepIdx + 1) };
}

/**
 * Reconstrói o valor de DB (`<prefix><exp>:sha256(<random>)`) a partir de um
 * token BRUTO recebido, para lookup por igualdade — mesmo padrão de
 * `rawToDbToken`, mas preservando o segmento `<exp>` em claro (ele faz parte
 * da string comparada; não é hasheado). Usa o `exp` EXATAMENTE como veio no
 * token recebido (mesmo que adulterado/ilegível) — é a comparação por
 * igualdade no banco que decide se ele é válido, não este helper.
 *
 * Se o token não tiver o separador esperado, devolve um valor que não pode
 * bater com nada gerado por `generateExpiringHashedToken` (fail-closed: a
 * query simplesmente não encontra linha).
 */
export function rawToExpiringDbToken(prefix: string, raw: string): string {
  const parts = splitExpiringRaw(prefix, raw);
  if (!parts) {
    const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    return `${prefix}${sha256Hex(rest)}`;
  }
  return `${prefix}${parts.expPart}:${sha256Hex(parts.random)}`;
}

/**
 * Extrai o `exp` (epoch ms) de um token BRUTO recebido, sem consultar o banco.
 *
 * ⚠️ O valor devolvido só deve ser CONSULTADO pelo chamador depois que a busca
 * por `rawToExpiringDbToken` já tiver encontrado uma linha — é esse match que
 * prova que este `exp` é o mesmo que foi gravado no `issue*`, não um valor que
 * o cliente inventou. Ler o `exp` antes do match (ou usá-lo quando a busca não
 * achou linha nenhuma) não prova nada.
 *
 * Devolve `null` quando o segmento `exp` está ausente (sem separador) OU não é
 * uma sequência de dígitos — o chamador DEVE tratar `null` como EXPIRADO
 * (fail-closed), nunca como "sem prazo". Isso cobre tanto tokens adulterados
 * quanto tokens gravados por uma versão anterior desta lib (sem `exp`
 * nenhum).
 */
export function parseExpiringTokenExp(prefix: string, raw: string): number | null {
  const parts = splitExpiringRaw(prefix, raw);
  if (!parts) return null;
  return /^\d+$/.test(parts.expPart) ? Number(parts.expPart) : null;
}
