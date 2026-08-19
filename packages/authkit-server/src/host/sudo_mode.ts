/**
 * Sudo mode (confirm_password + grace period).
 *
 * Após confirmar a identidade (senha ou passkey), o helper `requireSudo` registra
 * o timestamp na sessão Adonis. Dentro da janela de graça (`graceMinutes`) a
 * confirmação é aceita; fora dela, o usuário é redirecionado para `/account/confirm`.
 *
 * Setting `sudo_mode`:
 *   - `enabled`:      habilita/desabilita o sudo mode. Default: true.
 *   - `graceMinutes`: janela de graça em minutos. Default: 15.
 *
 * Chaves de sessão: `authkit_sudo_at` (timestamp ms) + `authkit_sudo_account`
 * (a conta que confirmou). As duas juntas são a marca — ver
 * `SUDO_ACCOUNT_SESSION_KEY`.
 */

import type { HttpContext } from '@adonisjs/core/http';
import { accountPath } from './account_paths.js';
import { ACCOUNT_SESSION_KEY } from './account_session_key.js';
import type { SettingsCapability } from './runtime_settings.js';
import { SETTING_KEYS } from './runtime_toggles.js';

// ---------------------------------------------------------------------------
// Setting shape + resolver
// ---------------------------------------------------------------------------

export interface SudoModeSetting {
  enabled?: boolean;
  graceMinutes?: number;
}

export interface ResolvedSudoModeSetting {
  enabled: boolean;
  graceMinutes: number;
}

export const SUDO_MODE_DEFAULTS: ResolvedSudoModeSetting = {
  enabled: true,
  graceMinutes: 15,
};

/**
 * Resolve a setting `sudo_mode` em runtime (fail-safe).
 *
 * FAIL-SAFE, e de propósito: setting ausente, malformada ou store indisponível
 * caem em `SUDO_MODE_DEFAULTS` em vez de lançar. A pergunta que esta função
 * responde é de DISPONIBILIDADE — "o toggle de sudo mode está ligado, e com que
 * janela de graça?" —, não de identidade. Um erro aqui não é sinal de credencial
 * suspeita; é o store de settings fora do ar.
 *
 * Note que o default é `enabled: true`: o fail-safe não desliga o sudo mode, ele
 * mantém a política default LIGADA. Quem decide o que fazer com uma sessão sem
 * sudo continua sendo `isSudoActive` (fail-CLOSED). Ver o docblock de
 * `requireSudo` para a assimetria completa entre as duas posturas — ela é
 * escolha, não descuido.
 */
export async function resolveEffectiveSudoMode(
  settings: SettingsCapability,
): Promise<ResolvedSudoModeSetting> {
  try {
    const raw = await settings.getSetting(SETTING_KEYS.SUDO_MODE);
    if (raw === null || raw === undefined) return SUDO_MODE_DEFAULTS;
    if (typeof raw !== 'object' || Array.isArray(raw)) return SUDO_MODE_DEFAULTS;
    const s = raw as SudoModeSetting;
    return {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : SUDO_MODE_DEFAULTS.enabled,
      graceMinutes:
        typeof s.graceMinutes === 'number' && s.graceMinutes >= 0
          ? Math.floor(s.graceMinutes)
          : SUDO_MODE_DEFAULTS.graceMinutes,
    };
  } catch {
    return SUDO_MODE_DEFAULTS;
  }
}

// ---------------------------------------------------------------------------
// Session key + helpers
// ---------------------------------------------------------------------------

/** Chave da sessão Adonis que registra quando o sudo foi confirmado. */
export const SUDO_SESSION_KEY = 'authkit_sudo_at';

/**
 * Conta que CONFIRMOU o sudo registrado em `SUDO_SESSION_KEY`.
 *
 * Por que existe: o timestamp sozinho é uma marca de "alguém confirmou a
 * identidade nesta sessão há pouco" — sem dizer QUEM. E a sessão sobrevive à
 * troca de conta: o `regenerate()` só troca o id do cookie e MIGRA os dados
 * (é o invariante descrito no M6 de `account_session_controller.ts`). Sem esta
 * vinculação, todo caminho que troca a conta da sessão TRANSFERE o sudo junto:
 *
 *   - impersonation: um admin que confirmou sudo sobre a PRÓPRIA conta passava
 *     a ter sudo sobre a conta personificada (`startImpersonation`); e o sudo
 *     obtido ENQUANTO personificava voltava a valer sobre a conta do admin
 *     (`stopImpersonation`);
 *   - navegador compartilhado: A confirma sudo, faz logout, B loga, e B herda
 *     a graça de A (hoje mascarado porque `login()` chama `markSudo` logo em
 *     seguida — acidente, não desenho).
 *
 * A garantia vira ESTRUTURAL em vez de depender de alguém lembrar de limpar a
 * marca em toda transição futura: qualquer troca de conta, inclusive as que
 * ainda não existem, invalida o sudo sem tocar em código novo.
 *
 * Chave SEPARADA de propósito (mesma decisão de
 * `CONFIRM_PASSKEY_CHALLENGE_ACCOUNT_KEY`): o valor de `SUDO_SESSION_KEY` é um
 * número e isso é contratual — está pinado em
 * `tests/host/account_confirm_controller.spec.ts` com `assert.isNumber`. Então
 * a vinculação é ADITIVA, em vez de mudar a forma do valor pinado para
 * `{ at, accountId }`. Bônus: as assinaturas públicas de `markSudo` /
 * `isSudoActive` (exportadas em `index.ts`) ficam intactas.
 */
export const SUDO_ACCOUNT_SESSION_KEY = 'authkit_sudo_account';

/**
 * Registra o timestamp de confirmação de sudo na sessão (NOW), VINCULADO à
 * conta atual da sessão. Chamar após o usuário confirmar sua identidade.
 *
 * Sem conta na sessão não há a quem vincular: grava o timestamp (contrato
 * pinado) e APAGA qualquer vinculação anterior, para que a marca não fique
 * herdando o dono antigo. O resultado é uma marca órfã, que `isSudoActive`
 * recusa (fail-closed).
 *
 * @deprecated Para conceder sudo, use `completeSudo(sudoContextFrom(ctx), id)`.
 * `markSudo` grava a marca e nada mais: não registra o audit `sudo.confirmed`,
 * não lembra o método usado e não redireciona para o `return_to`. Um host que a
 * chame direto — o caminho natural no callback de `oidcStepUp`, antes de
 * `completeSudo` ser público — concede privilégio sem deixar rastro nenhum.
 * Continua exportada porque o login primário do próprio pacote a usa (ver o
 * CHANGELOG desta versão) e porque removê-la seria breaking; o uso legítimo
 * restante é ler/limpar a marca em fluxos que não são confirmação de
 * identidade.
 */
export function markSudo(ctx: HttpContext): void {
  const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
  ctx.session.put(SUDO_SESSION_KEY, Date.now());
  if (accountId) ctx.session.put(SUDO_ACCOUNT_SESSION_KEY, accountId);
  else ctx.session.forget(SUDO_ACCOUNT_SESSION_KEY);
}

/**
 * Verifica se o sudo está ativo: dentro da janela de graça E confirmado PELA
 * CONTA que está logada agora.
 *
 * FAIL-CLOSED na vinculação (mesma postura do challenge de passkey): marca sem
 * `accountId`, ou com um `accountId` que não bate com a conta atual da sessão,
 * é recusada. Isso inclui sessões que já estavam vivas antes deste deploy — elas
 * perdem o sudo e reconfirmam, que é o lado seguro do trade-off.
 *
 * Esta postura é o OPOSTO do fail-safe de `requireSudo`, e as duas estão certas:
 * aqui a pergunta é "esta marca é minha?" (identidade), lá é "o toggle está
 * ligado?" (disponibilidade). O docblock de `requireSudo` desenvolve a distinção.
 *
 * @returns `true` se o sudo está ativo (dentro da graça); `false` caso contrário.
 */
export function isSudoActive(ctx: HttpContext, graceMinutes: number): boolean {
  const sudoAt = ctx.session.get(SUDO_SESSION_KEY) as number | undefined;
  if (!sudoAt) return false;

  // A vinculação é checada ANTES da graça: uma marca de outra conta não é
  // "sudo expirado", é sudo que nunca valeu aqui.
  const sudoAccountId = ctx.session.get(SUDO_ACCOUNT_SESSION_KEY) as string | undefined;
  if (!sudoAccountId) return false;
  const currentAccountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
  if (!currentAccountId || sudoAccountId !== currentAccountId) return false;

  const graceMs = graceMinutes * 60 * 1000;
  return Date.now() - sudoAt <= graceMs;
}

/**
 * Guard de sudo mode. Verifica se a confirmação de identidade está ativa e
 * dentro da janela de graça. Se estiver, retorna `true`. Se não, redireciona
 * para `/account/confirm?return_to=<path atual>` e retorna a resposta.
 *
 * Uso:
 * ```ts
 * const result = await requireSudo(ctx, settings)
 * if (result !== true) return result
 * ```
 *
 * FAIL-SAFE: qualquer erro ao resolver a setting → retorna `true` (deixa
 * passar). Quando `sudo_mode.enabled = false`, sempre retorna `true`.
 *
 * ---
 *
 * POR QUE ESTE FAIL-SAFE CONVIVE COM O FAIL-CLOSED DAS VINCULAÇÕES.
 *
 * Lendo este arquivo (e os vizinhos) aparecem duas posturas OPOSTAS diante de
 * uma situação anômala, e isso é deliberado — não é um dos dois lados por
 * consertar. Quem "harmonizar" as duas quebra alguma coisa:
 *
 *   - FAIL-CLOSED nas vinculações à conta: a marca de sudo
 *     (`SUDO_ACCOUNT_SESSION_KEY` em `isSudoActive`), o challenge de passkey do
 *     confirm e o token pendente do magic link de sudo. Todas recusam quando a
 *     vinculação falta ou não bate.
 *   - FAIL-SAFE aqui, ao resolver a setting `sudo_mode`.
 *
 * A diferença não é de rigor, é de PERGUNTA:
 *
 *   - As vinculações perguntam **"esta credencial é minha?"**. É IDENTIDADE. Uma
 *     resposta duvidosa é indistinguível de uma resposta negativa — uma marca
 *     sem dono pode ser a marca de outra conta que sobreviveu à troca de sessão.
 *     Deixar passar concede privilégio a quem talvez não o tenha, e o custo do
 *     erro é escalação. Identidade duvidosa é recusada; o usuário reconfirma,
 *     que é barato.
 *   - Este fail-safe pergunta **"o toggle de sudo mode está ligado?"**. É
 *     DISPONIBILIDADE, uma questão de configuração, e a resposta não diz nada
 *     sobre quem é o usuário. Quem chega aqui já passou pelo `accountGuard`:
 *     tem sessão de conta viva e autenticada.
 *
 * Inverter ESTE lado para fail-closed transformaria uma indisponibilidade do
 * store de settings (BD fora do ar, timeout, migração em curso) num lockout
 * TOTAL: todo mundo, simultaneamente, trancado fora da própria área de conta —
 * inclusive fora dos caminhos de recuperação. E o ataque que isso evitaria
 * exige que o atacante já tenha uma sessão autenticada da vítima E consiga
 * derrubar o store de settings no mesmo instante. Trocar uma falha rara e
 * condicionada por uma indisponibilidade certa e generalizada é o pior dos dois
 * negócios.
 *
 * O fail-safe também é ESTREITO: ele só decide se a BARREIRA roda. Ele não
 * concede sudo, não fabrica marca nenhuma e não mexe em vinculação. Se a setting
 * resolve normalmente, a decisão volta inteira para `isSudoActive` — e lá a
 * postura é fail-closed de novo.
 */
export async function requireSudo(
  ctx: HttpContext,
  settings: SettingsCapability | null,
): Promise<true | unknown> {
  try {
    const cfg = settings ? await resolveEffectiveSudoMode(settings) : SUDO_MODE_DEFAULTS;
    if (!cfg.enabled) return true;
    if (isSudoActive(ctx, cfg.graceMinutes)) return true;
  } catch {
    // FAIL-SAFE: erro ao resolver a setting → deixa passar. Disponibilidade, não
    // identidade — ver o docblock acima para o porquê de isto NÃO contradizer o
    // fail-closed de `isSudoActive`.
    return true;
  }

  // Fora da graça: redireciona para confirmação.
  const rawUrl = ctx.request.url?.() ?? '';
  const qs = (ctx.request as any).parsedUrl?.search ?? '';
  const dest = qs ? `${rawUrl}${qs}` : rawUrl;
  const returnTo =
    dest && dest !== '/' && !dest.startsWith(accountPath('confirm'))
      ? `?return_to=${encodeURIComponent(dest)}`
      : '';
  return ctx.response.redirect(`${accountPath('confirm')}${returnTo}`);
}
