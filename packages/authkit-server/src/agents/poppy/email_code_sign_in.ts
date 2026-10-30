/**
 * @experimental Poppy (Personal Agent Protocol) Draft 0.3 — pode mudar de forma incompatível enquanto a spec for draft.
 *
 * Mediated Sign-In pronto (extensão `mediated-sign-in`): o agente pede o e-mail da conta, o authkit manda
 * um código de 6 dígitos para ele e o agente devolve o código. Usa as contas
 * (`accountStore`) e o e-mail (hook `mail.onPoppySignInCode` ou o mailer default)
 * do próprio authkit — o app só liga:
 *
 * ```ts
 * personalAgents: {
 *   poppy: { signIn: { mediated: poppyEmailCodeSignIn({ scopes: ['orders:read'] }) } },
 * }
 * ```
 *
 * Sem enumeração de contas: e-mail sem conta, conta desativada, conta recusada
 * por `eligible` ou e-mail acima do limite recebem a MESMA resposta, sem código
 * (`accountId: null`) — a lib recusa qualquer código como errado. O envio não é
 * esperado, então o tempo de resposta também não denuncia.
 */
import { randomInt } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import { type AuthAccount, supportsAccountStatus } from '../../accounts/account_store.js';
import { sendPoppySignInCodeEmail } from '../../host/default_mailer.js';
import { personalAgentsFor } from '../runtime.js';
import type { PoppyMediatedConfigInput, PoppyMediatedResult } from './config.js';

export interface PoppyEmailCodeSignInOptions {
  /** Scopes que este sign-in pode conceder. */
  scopes: string[];
  /** Validade do código, em segundos. Default: 600. */
  codeTtl?: number;
  /** Tentativas de código antes de `invalid_grant`. Default: 5. */
  maxCodeAttempts?: number;
  /**
   * Quem pode entrar por aqui (ex.: só pacientes, não profissionais). `false` = recebe a
   * resposta de conta inexistente. Default: toda conta ativa.
   */
  eligible?: (account: AuthAccount) => boolean | Promise<boolean>;
  /**
   * Códigos por e-mail por hora, nesta instância — impede um agente de lotar a caixa de
   * alguém. Acima disso a resposta é a mesma, sem e-mail. Default: 5.
   */
  maxPerHour?: number;
  /** Rótulo do campo que o agente mostra ao usuário. Default: `'Email address'`. */
  label?: string;
  /** Texto de `sentTo` a partir do e-mail mascarado. Default: `` `Email to ${masked}` ``. */
  sentTo?: (masked: string) => string;
}

/** `ana.souza@gmail.com` → `a***@gmail.com`: o bastante para a pessoa reconhecer. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const user = at > 0 ? email.slice(0, at) : '';
  const domain = at > 0 ? email.slice(at + 1) : '';
  if (!user || !domain) return '***';
  return `${user[0]}***@${domain}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUR_MS = 3600 * 1000;
const MAX_TRACKED = 10_000;

export function poppyEmailCodeSignIn(
  options: PoppyEmailCodeSignInOptions,
): PoppyMediatedConfigInput {
  const positive = (value: number | undefined, fallback: number, what: string) => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`authkit: poppyEmailCodeSignIn ${what} precisa ser um número >= 1.`);
    }
    return Math.floor(value);
  };
  const codeTtl = positive(options.codeTtl, 600, 'codeTtl');
  const maxPerHour = positive(options.maxPerHour, 5, 'maxPerHour');
  const maxCodeAttempts = positive(options.maxCodeAttempts, 5, 'maxCodeAttempts');
  const sentToText = options.sentTo ?? ((masked: string) => `Email to ${masked}`);
  const sends = new Map<string, number[]>();

  /** `true` = ainda cabe um envio para este e-mail na última hora (e conta este). */
  const claim = (email: string): boolean => {
    const now = Date.now();
    const recent = (sends.get(email) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= maxPerHour) {
      sends.set(email, recent);
      return false;
    }
    recent.push(now);
    sends.delete(email);
    sends.set(email, recent);
    if (sends.size > MAX_TRACKED) sends.delete(sends.keys().next().value as string);
    return true;
  };

  const eligibleAccount = async (ctx: HttpContext, email: string) => {
    const service = await ctx.containerResolver.make('authkit.server');
    const store = service.config.accountStore;
    const account = await store.findByEmail(email);
    if (!account) return null;
    if (supportsAccountStatus(store) && (await store.isDisabled(account.id))) return null;
    if (options.eligible) {
      // Um `eligible` que lança vira "não elegível": um 500 só para algumas contas as denunciaria.
      try {
        if (!(await options.eligible(account))) return null;
      } catch (error) {
        ctx.logger.error({ err: error }, 'authkit: poppyEmailCodeSignIn eligible lançou');
        return null;
      }
    }
    return account;
  };

  return {
    fields: [{ name: 'email', label: options.label ?? 'Email address', secret: false }],
    scopes: options.scopes,
    codeTtl,
    maxCodeAttempts,
    async verify({ credentials, clientId, ctx }): Promise<PoppyMediatedResult> {
      const email = (credentials.email ?? '').trim().toLowerCase();
      if (!EMAIL.test(email)) return { status: 'failed' };
      const sentTo = sentToText(maskEmail(email));
      const decoy: PoppyMediatedResult = { status: 'code_required', accountId: null, sentTo };

      // O limite conta para qualquer e-mail — com ou sem conta, a resposta não muda.
      if (!claim(email)) return decoy;
      const account = await eligibleAccount(ctx, email);
      if (!account) return decoy;

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      // Sem `await`: o caminho com conta não pode demorar mais que o sem conta.
      void deliver(ctx, { email, code, clientId, expiresInMinutes: Math.ceil(codeTtl / 60) });
      return { status: 'code_required', accountId: account.id, sentTo, code };
    },
  };
}

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

async function deliver(
  ctx: HttpContext,
  data: { email: string; code: string; clientId: string; expiresInMinutes: number },
): Promise<void> {
  try {
    const runtime = await personalAgentsFor(ctx);
    const agentName = runtime?.poppy
      ? await runtime.poppy.registry.displayName(data.clientId)
      : hostOf(data.clientId);
    const service = await ctx.containerResolver.make('authkit.server');
    const hook = service.config.mail?.onPoppySignInCode;
    const input = {
      email: data.email,
      code: data.code,
      agentName,
      expiresInMinutes: data.expiresInMinutes,
    };
    if (hook) await hook(input);
    else await sendPoppySignInCodeEmail(ctx, input);
  } catch (error) {
    ctx.logger.error({ err: error }, 'authkit: o código do Poppy Mediated Sign-In não saiu');
  }
}
