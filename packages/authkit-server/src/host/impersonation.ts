import type { ResolvedServerConfig } from '../define_config.js';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/**
 * Parâmetros PRONTOS do RFC 8693 Token Exchange para o admin assumir a identidade
 * de um usuário-alvo. NÃO é um bypass de auth: o exchange real (no
 * `token_endpoint`) exige um access token do PRÓPRIO admin como `subject_token`
 * (que o handler valida ter a role admin) e um client habilitado ao grant
 * token-exchange. O painel só monta os parâmetros + um curl pronto — honesto com
 * o mecanismo que já existe em `provider/token_exchange.ts`.
 */
export interface ImpersonationPanel {
  tokenEndpoint: string;
  grantType: string;
  subjectTokenType: string;
  requestedSubject: string;
  /** Client habilitado ao grant token-exchange usado no exemplo. */
  clientId: string;
  /** Comando curl pronto (subject_token como placeholder a preencher). */
  curl: string;
}

/**
 * Um client candidato a hospedar o token-exchange. Modelado estruturalmente para
 * aceitar tanto os clients ESTÁTICOS do config (`ResolvedServerConfig['clients']`,
 * que trazem o secret) quanto os clients de RUNTIME lidos do adapter pelo
 * `AdminClientsService` (que NÃO trazem o secret — ele não é recuperável).
 */
export interface ImpersonationClientLike {
  clientId: string;
  clientSecret?: string;
  grants?: string[];
  /** Runtime clients reportam confidencialidade sem expor o secret. */
  confidential?: boolean;
}

/** Placeholder do secret quando o client é confidencial mas o secret não é legível. */
const SECRET_PLACEHOLDER = '<CLIENT_SECRET>';

/**
 * Monta o painel de impersonation para o `targetId`. Retorna `null` quando NENHUM
 * client candidato tem o grant token-exchange habilitado (sem ele o fluxo não
 * funciona) — a UI então mostra a instrução de habilitar o grant.
 *
 * ⚠️ `clients` é OBRIGATÓRIO na prática. `cfg.clients` é sempre `[]` num host
 * real: clients são 100% de runtime (console admin / Admin API / `authkit:clients:create`),
 * e o config resolvido nunca os carrega — é o que o `checkClients` do doctor
 * afirma. Passar só o config faria o painel devolver `null` SEMPRE, que foi
 * exatamente o bug: o botão do console nunca teve um client para oferecer.
 * O fallback para `cfg.clients` existe só para hosts que ainda declaram clients
 * estáticos e para os testes que os declaram.
 */
export function buildImpersonationPanel(
  cfg: Pick<ResolvedServerConfig, 'issuer' | 'clients'>,
  targetId: string,
  clients?: readonly ImpersonationClientLike[],
): ImpersonationPanel | null {
  const candidates: readonly ImpersonationClientLike[] =
    clients && clients.length > 0 ? clients : (cfg.clients ?? []);
  const client = candidates.find((c) => (c.grants ?? []).includes(TOKEN_EXCHANGE));
  if (!client) return null;

  const tokenEndpoint = `${cfg.issuer.replace(/\/+$/, '')}/token`;
  // Confidencial = tem secret conhecido, ou o adapter marcou como confidencial.
  // No segundo caso o secret NÃO é recuperável (o adapter guarda o hash/valor
  // opaco e a lib mostra o secret uma única vez na criação), então o curl sai
  // com um placeholder em vez de mentir com uma string vazia.
  const confidential = client.confidential ?? client.clientSecret !== undefined;
  const auth = confidential
    ? `  -u '${client.clientId}:${client.clientSecret ?? SECRET_PLACEHOLDER}' \\\n`
    : `  -d 'client_id=${client.clientId}' \\\n`;

  const curl = `curl -X POST '${tokenEndpoint}' \\\n${auth}  -d 'grant_type=${TOKEN_EXCHANGE}' \\\n  -d 'subject_token=<ADMIN_ACCESS_TOKEN>' \\\n  -d 'subject_token_type=${ACCESS_TOKEN_TYPE}' \\\n  -d 'requested_subject=${targetId}' \\\n  -d 'scope=openid profile email'`;

  return {
    tokenEndpoint,
    grantType: TOKEN_EXCHANGE,
    subjectTokenType: ACCESS_TOKEN_TYPE,
    requestedSubject: targetId,
    clientId: client.clientId,
    curl,
  };
}
