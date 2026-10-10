import { parseArgs } from 'node:util';
import { callOpenApi, listApis, loadOpenApi } from '../api.js';
import { autoSubmitFormHtml, createBrowserAssertion, serveOneShotPage } from '../browser.js';
import { type CompanyClient, PoppyAgent, type SignInResult } from '../company.js';
import { ConversationClient, newMessageId, poppyProtocol } from '../conversations.js';
import { discover } from '../discovery.js';
import { PoppyError, ResourceAuthError } from '../errors.js';
import { AgentIdentity } from '../identity.js';
import { startIdentityServer, waitForRelayedCallback } from '../identity_server.js';
import { generateEs256Key } from '../keys.js';
import { ask, DEFAULT_MODEL } from '../llm.js';
import { connectMcp } from '../mcp.js';
import { openInBrowser } from '../open_url.js';
import {
  completeDirectSignIn,
  deviceSignIn,
  eligibleSignInTypes,
  mediatedSignIn,
  type SignInType,
  startDirectSignIn,
  submitMediatedCode,
} from '../signin.js';
import { StateStore } from '../store.js';
import type { ConversationEvent, MessageContext, OutgoingMessage } from '../types.js';
import { isLoopbackHost, requireSecureUrl } from '../util.js';
import { Prompter } from './prompt.js';

const HELP = `poppy-agent — reference Personal Agent for the Personal Agent Protocol (Poppy)

  EXPERIMENTAL. Implements spec Draft 0.1 (https://personalagentprotocol.org/docs/spec).
  The spec is still in development; this client tracks it and WILL change, possibly in
  breaking ways, as the spec evolves.

Usage: poppy-agent <command> [args] [options]

Identity (4.1)
  init --base-url <https-url> [--name <client_name>] [--logo-uri <url>] [--rotate-keys]
  identity                              print client metadata + JWKS
  serve-identity [--base-url <url>] [--port <n>] [--host <addr>]
                                        serve agent.json, jwks.json, logo, /oauth/callback
Discovery (3)
  discover <domain>
Sessions & sign-in (4)
  session <domain> [--new] [--scope <s>] [--resource <url>]
  signin <domain> [--method direct|device|mediated] [--scope "<scopes>"] [--no-open]
  status [domain]
  disconnect <domain>                   revoke the Account Token (RFC 7009)
APIs (6)
  apis <domain>                         list APIs (and OpenAPI operations)
  api <domain> <METHOD> <path> [--data <json>] [--api <n>] [--scope <s>]
  mcp tools <domain> [--api <n>]
  mcp call <domain> <tool> [<json-args>] [--api <n>]
Conversations (7)
  chat <domain> [--conversation <id>] [--as agent|human] [--no-stream]
Web browsing (5)
  open <domain> <return_to> [--print]   form-POST a poppy-browser+jwt assertion
LLM mode
  ask <domain> "<task>" [--model <id>] [--max-steps <n>] [--yes]
                                        needs OPENROUTER_API_KEY (default model ${DEFAULT_MODEL})

Global options
  --state <file>      state file (default $POPPY_AGENT_STATE or ~/.config/poppy-agent/state.json), mode 0600
  --profile <name>    local user to act for (default "default"); each gets its own User IDs
  --client-assertion-aud token_endpoint|issuer   aud of private_key_jwt (default token_endpoint)
  --insecure-dev      NON-SPEC: allow http:// URLs (client_id, discovery, endpoints). Local testing only.
                      Also: POPPY_AGENT_INSECURE_DEV=1
`;

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function insecureBanner() {
  const red = (s: string) => (process.stderr.isTTY ? `\x1b[41;97;1m${s}\x1b[0m` : s);
  err(red('!!! --insecure-dev: NON-SPEC MODE !!!'));
  err(red('    http:// is accepted for client_id, poppy.json, issuer, endpoints and redirects.'));
  err(red('    The Poppy spec requires HTTPS everywhere. NEVER use this against a real Company.'));
}

interface Ctx {
  store: StateStore;
  insecureDev: boolean;
  profile: string;
  values: Record<string, string | boolean | undefined>;
  prompter: Prompter;
}

function loadIdentity(ctx: Ctx): AgentIdentity {
  const id = ctx.store.data.identity;
  if (!id)
    throw new PoppyError(
      'no_identity',
      'no agent identity yet: run `poppy-agent init --base-url <url>`',
    );
  return new AgentIdentity(id, { insecureDev: ctx.insecureDev });
}

function makeAgent(ctx: Ctx): PoppyAgent {
  const aud = ctx.values['client-assertion-aud'];
  return new PoppyAgent({
    store: ctx.store,
    identity: loadIdentity(ctx),
    profile: ctx.profile,
    insecureDev: ctx.insecureDev,
    log: (l) => err(dim(`· ${l}`)),
    tokenClient: { clientAssertionAudience: aud === 'issuer' ? 'issuer' : 'token_endpoint' },
  });
}

async function company(ctx: Ctx, domain: string | undefined): Promise<CompanyClient> {
  if (!domain) throw new PoppyError('usage', 'missing <domain>');
  return makeAgent(ctx).company(domain);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export async function runCli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      state: { type: 'string' },
      profile: { type: 'string' },
      'insecure-dev': { type: 'boolean' },
      'base-url': { type: 'string' },
      name: { type: 'string' },
      'logo-uri': { type: 'string' },
      'rotate-keys': { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      new: { type: 'boolean' },
      scope: { type: 'string' },
      resource: { type: 'string' },
      method: { type: 'string' },
      'no-open': { type: 'boolean' },
      data: { type: 'string' },
      api: { type: 'string' },
      conversation: { type: 'string' },
      as: { type: 'string' },
      'no-stream': { type: 'boolean' },
      print: { type: 'boolean' },
      model: { type: 'string' },
      'max-steps': { type: 'string' },
      yes: { type: 'boolean' },
      'client-assertion-aud': { type: 'string' },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    out(HELP);
    return command || values.help ? 0 : 1;
  }
  const insecureDev =
    values['insecure-dev'] === true || process.env.POPPY_AGENT_INSECURE_DEV === '1';
  if (insecureDev) insecureBanner();
  const ctx: Ctx = {
    store: await StateStore.open(str(values.state)),
    insecureDev,
    profile: str(values.profile) ?? 'default',
    values: values as Ctx['values'],
    prompter: new Prompter(),
  };
  try {
    return await dispatch(ctx, command, args);
  } catch (e) {
    if (e instanceof ResourceAuthError && e.code === 'insufficient_scope') {
      err(
        `error: insufficient_scope — the Company needs "${e.scope ?? '?'}". Run: poppy-agent signin <domain> --scope "${e.scope ?? ''}"`,
      );
    } else if (e instanceof ResourceAuthError && e.code === 'sign_in_required') {
      err('error: sign_in_required — run: poppy-agent signin <domain>');
    } else {
      err(`error: ${(e as Error).message}`);
    }
    return 1;
  } finally {
    ctx.prompter.close();
  }
}

async function dispatch(ctx: Ctx, command: string, args: string[]): Promise<number> {
  const v = ctx.values;
  switch (command) {
    case 'init':
      return cmdInit(ctx);
    case 'identity': {
      const id = loadIdentity(ctx);
      out(JSON.stringify({ metadata: id.metadata(), jwks: id.jwks() }, null, 2));
      return 0;
    }
    case 'serve-identity':
      return cmdServeIdentity(ctx);
    case 'discover': {
      if (!args[0]) throw new PoppyError('usage', 'discover <domain>');
      const d = await discover(args[0], { insecureDev: ctx.insecureDev });
      out(JSON.stringify({ domain: d.domain, poppy: d.document, metadata: d.metadata }, null, 2));
      return 0;
    }
    case 'session': {
      const c = await company(ctx, args[0]);
      if (v.new) await c.newSession();
      const t = await c.token({ scope: str(v.scope), resource: str(v.resource) });
      out(
        JSON.stringify(
          {
            user_id: c.userId,
            session_id: t.sessionId,
            signed_in: t.signedIn,
            scope: t.scope,
            token_type: t.tokenType,
            expires_at: new Date(t.expiresAt).toISOString(),
            account_token: c.accountToken
              ? { scope: c.accountToken.scope, via: c.accountToken.via }
              : null,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    case 'signin': {
      const c = await company(ctx, args[0]);
      const r = await signIn(ctx, c, str(v.method) as SignInType | undefined, str(v.scope));
      return r ? 0 : 1;
    }
    case 'status':
      return cmdStatus(ctx, args[0]);
    case 'disconnect': {
      const c = await company(ctx, args[0]);
      const revoked = await c.signOut();
      out(
        revoked
          ? 'Account Token revoked; Sessions continue signed out.'
          : 'No Account Token for this Company.',
      );
      return 0;
    }
    case 'apis': {
      const c = await company(ctx, args[0]);
      for (const a of listApis(c)) {
        out(
          `${bold(`[${a.type}]`)} ${a.url}${a.resource ? ` (resource ${a.resource})` : ''} — ${a.description ?? ''}`,
        );
        if (a.type === 'openapi') {
          try {
            const doc = await loadOpenApi(c, a);
            for (const [path, ops] of Object.entries(doc.paths ?? {})) {
              for (const [m, op] of Object.entries(ops ?? {})) {
                if (!/^(get|post|put|patch|delete)$/i.test(m)) continue;
                out(
                  `    ${m.toUpperCase().padEnd(6)} ${path}${op?.summary ? dim(`  ${op.summary}`) : ''}`,
                );
              }
            }
          } catch (e) {
            out(dim(`    (could not load: ${(e as Error).message})`));
          }
        }
      }
      return 0;
    }
    case 'api': {
      const [domain, method, path] = args;
      if (!domain || !method || !path)
        throw new PoppyError('usage', 'api <domain> <METHOD> <path> [--data json]');
      const c = await company(ctx, domain);
      const r = await callOpenApi(c, {
        method,
        path,
        body: str(v.data) !== undefined ? JSON.parse(str(v.data)!) : undefined,
        apiIndex: v.api ? Number(v.api) : undefined,
        scope: str(v.scope),
      });
      err(dim(`HTTP ${r.status}`));
      out(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2));
      return r.status < 400 ? 0 : 1;
    }
    case 'mcp':
      return cmdMcp(ctx, args);
    case 'chat':
      return cmdChat(ctx, args[0]);
    case 'open':
      return cmdOpen(ctx, args[0], args[1]);
    case 'ask':
      return cmdAsk(ctx, args[0], args.slice(1).join(' '));
    default:
      err(`unknown command: ${command}\n`);
      out(HELP);
      return 1;
  }
}

/* --------------------------------------------------------------------------- identity */

async function cmdInit(ctx: Ctx): Promise<number> {
  const v = ctx.values;
  const existing = ctx.store.data.identity;
  const baseUrl = str(v['base-url']) ?? existing?.baseUrl;
  if (!baseUrl) throw new PoppyError('usage', 'init --base-url <https-url>');
  requireSecureUrl(baseUrl, 'base URL', { insecureDev: ctx.insecureDev });
  const keys =
    !existing || v['rotate-keys']
      ? [await generateEs256Key(), ...(existing?.keys ?? []).slice(0, 1)]
      : existing.keys;
  ctx.store.data.identity = {
    baseUrl,
    clientName: str(v.name) ?? existing?.clientName ?? 'Poppy Reference Agent',
    logoUri: str(v['logo-uri']) ?? existing?.logoUri,
    keys,
  };
  await ctx.store.save();
  const id = loadIdentity(ctx);
  out(`client_id: ${id.clientId}`);
  out(`jwks_uri:  ${id.jwksUri}`);
  out(`redirect:  ${id.redirectUri}`);
  out(`state:     ${ctx.store.path} (0600)`);
  return 0;
}

async function cmdServeIdentity(ctx: Ctx): Promise<number> {
  const v = ctx.values;
  if (str(v['base-url']) || !ctx.store.data.identity) {
    const code = await cmdInit(ctx);
    if (code) return code;
  }
  const identity = loadIdentity(ctx);
  const base = new URL(identity.baseUrl);
  const local = isLoopbackHost(base.hostname);
  const port = v.port ? Number(v.port) : local && base.port ? Number(base.port) : 7777;
  const host = str(v.host) ?? (local && base.hostname === 'localhost' ? 'localhost' : '127.0.0.1');
  const srv = await startIdentityServer(identity, {
    host,
    port,
    relayDir: ctx.store.dir,
    log: (l) => err(dim(l)),
  });
  out(`Serving the agent identity on ${srv.url}`);
  out(`  client_id    ${identity.clientId}`);
  out(`  jwks_uri     ${identity.jwksUri}`);
  out(`  redirect_uri ${identity.redirectUri}`);
  if (!local)
    out(`Expose ${srv.url} at ${identity.baseUrl} (e.g. cloudflared / tailscale funnel).`);
  out('Ctrl-C to stop.');
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await srv.close();
  return 0;
}

/* --------------------------------------------------------------------------- sign-in */

function defaultScope(c: CompanyClient, method: SignInType): string {
  const offered = c.document.auth?.[method]?.scopes ?? [];
  const broad = offered.filter((s) => s === 'poppy:read' || s === 'poppy:write');
  return (broad.length ? broad : offered).join(' ');
}

async function signIn(
  ctx: Ctx,
  c: CompanyClient,
  method?: SignInType,
  scope?: string,
): Promise<SignInResult | undefined> {
  const eligible = scope
    ? eligibleSignInTypes(c, scope)
    : (['direct', 'device', 'mediated'] as const).filter((t) => c.document.auth?.[t]);
  const chosen = method ?? eligible[0];
  if (!chosen) {
    err(
      scope
        ? `No sign-in type offered by this Company can grant "${scope}".`
        : 'This Company offers no sign-in.',
    );
    return undefined;
  }
  const wanted = scope ?? defaultScope(c, chosen);
  out(`Signing in with ${bold(chosen)} sign-in, scope "${wanted}"`);
  let result: SignInResult | undefined;
  if (chosen === 'direct') result = await directFlow(ctx, c, wanted);
  else if (chosen === 'device') {
    result = await deviceSignIn(c, wanted, {
      display: (i) => {
        out(
          `Open ${bold(i.verificationUriComplete ?? i.verificationUri)} and enter the code ${bold(i.userCode)}`,
        );
        out(dim(`(expires in ${i.expiresIn}s; waiting…)`));
      },
      onPoll: (s, n) => s === 'slow_down' && err(dim(`slow_down: polling every ${n}s`)),
    });
  } else result = await mediatedFlow(ctx, c, wanted);
  if (result) {
    out(`Signed in. Granted scope: "${result.grantedScope}" (session ${result.sessionId})`);
    if (result.missingScopes.length)
      out(`Note: the User did not grant ${result.missingScopes.join(', ')}`);
  }
  return result;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function directFlow(ctx: Ctx, c: CompanyClient, scope: string): Promise<SignInResult> {
  const identity = c.agent.identity;
  const pending = await startDirectSignIn(c, scope);
  const ac = new AbortController();
  const waits: Promise<URLSearchParams>[] = [
    waitForRelayedCallback(ctx.store.dir, pending.state, { signal: ac.signal }),
  ];
  let inproc: Awaited<ReturnType<typeof startIdentityServer>> | undefined;
  if (!(await reachable(identity.clientId))) {
    const base = new URL(identity.baseUrl);
    if (isLoopbackHost(base.hostname)) {
      let resolveCb!: (p: URLSearchParams) => void;
      waits.push(new Promise((r) => (resolveCb = r)));
      inproc = await startIdentityServer(identity, {
        host: base.hostname === 'localhost' ? 'localhost' : base.hostname,
        port: Number(base.port || 80),
        onCallback: (p) => p.get('state') === pending.state && resolveCb(p),
      });
      err(dim(`serving the agent identity in-process at ${identity.baseUrl}`));
    } else {
      err(
        `warning: ${identity.clientId} is not reachable. Run \`poppy-agent serve-identity\` behind your tunnel.`,
      );
    }
  }
  out(`Open this URL to sign in:\n  ${pending.url}`);
  if (!ctx.values['no-open']) openInBrowser(pending.url);
  if (ctx.prompter.interactive) {
    waits.push(
      ctx.prompter
        .ask('(waiting for the redirect… or paste the full redirect URL here)\n', ac.signal)
        .then((line) => new URL(line.trim()).searchParams),
    );
  }
  try {
    const params = await Promise.race(waits);
    return await completeDirectSignIn(c, pending, params);
  } finally {
    ac.abort();
    for (const w of waits) w.catch(() => {});
    await inproc?.close();
  }
}

async function mediatedFlow(
  ctx: Ctx,
  c: CompanyClient,
  scope: string,
): Promise<SignInResult | undefined> {
  const mediated = c.document.auth!.mediated!;
  const credentials: Record<string, string> = {};
  for (const f of mediated.fields) {
    credentials[f.name] = f.secret
      ? await ctx.prompter.askSecret(`${f.label}: `)
      : await ctx.prompter.ask(`${f.label}: `);
  }
  let outcome = await mediatedSignIn(c, scope, credentials);
  for (const k of Object.keys(credentials)) credentials[k] = '';
  while (outcome.status === 'code_required') {
    const code = await ctx.prompter.ask(
      `One-time code${outcome.sentTo ? ` (${outcome.sentTo})` : ''}${outcome.expiresAt ? `, before ${outcome.expiresAt}` : ''}: `,
    );
    outcome = await submitMediatedCode(c, scope, outcome.signInId, code.trim());
  }
  if (outcome.status === 'complete') return outcome.result;
  err(`Mediated Sign-In ${outcome.status}.`);
  return undefined;
}

/* --------------------------------------------------------------------------- status */

async function cmdStatus(ctx: Ctx, domain?: string): Promise<number> {
  const companies = ctx.store.profile(ctx.profile).companies;
  const id = ctx.store.data.identity;
  out(
    `identity: ${id ? `${id.baseUrl}/agent.json` : '(none: run init)'}   profile: ${ctx.profile}`,
  );
  for (const s of Object.values(companies)) {
    if (domain && !s.domains.includes(domain.toLowerCase().replace(/^www\./, ''))) continue;
    const t = s.tokens.dpop;
    out(`${bold(s.issuer)}  (${s.domains.join(', ')})`);
    out(
      `  user_id ${s.userId}   session ${s.sessionId ?? '-'}   ${t ? `signed_in=${t.signedIn} scope="${t.scope}" expires ${new Date(t.expiresAt).toISOString()}` : ''}`,
    );
    out(
      `  account token: ${s.accountToken ? `yes (scope "${s.accountToken.scope}", via ${s.accountToken.via})` : 'no'}`,
    );
    const convs = Object.entries(s.conversations).filter(([, c]) => !c.closed);
    if (convs.length) out(`  open conversations: ${convs.map(([k]) => k).join(', ')}`);
  }
  return 0;
}

/* --------------------------------------------------------------------------- mcp */

async function cmdMcp(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, domain, tool, json] = args;
  if ((sub !== 'tools' && sub !== 'call') || !domain || (sub === 'call' && !tool)) {
    throw new PoppyError('usage', 'mcp tools <domain> | mcp call <domain> <tool> [json]');
  }
  const c = await company(ctx, domain);
  const conn = await connectMcp(c, ctx.values.api ? Number(ctx.values.api) : undefined);
  try {
    if (sub === 'tools') {
      const { tools } = await conn.client.listTools();
      for (const t of tools) {
        out(
          `${bold(t.name)}${t.annotations?.readOnlyHint ? dim(' (read-only)') : ''} — ${t.description ?? ''}`,
        );
        out(dim(`    input: ${JSON.stringify(t.inputSchema)}`));
      }
      return 0;
    }
    const r = await conn.client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} });
    out(JSON.stringify(r, null, 2));
    return r.isError ? 1 : 0;
  } finally {
    await conn.close();
  }
}

/* --------------------------------------------------------------------------- open */

async function cmdOpen(ctx: Ctx, domain?: string, returnTo?: string): Promise<number> {
  if (!domain || !returnTo) throw new PoppyError('usage', 'open <domain> <return_to>');
  const c = await company(ctx, domain);
  const { endpoint, assertion } = await createBrowserAssertion(c, returnTo);
  const page = await serveOneShotPage(autoSubmitFormHtml(endpoint, assertion));
  err(
    dim(
      "Spec 5: browser assertions MUST be posted only from a browser the Personal Agent controls, never from the User's own browser. Use a dedicated/automation browser profile.",
    ),
  );
  out(`Load this page (once, within 60s) in the agent-controlled browser:\n  ${page.url}`);
  out(
    dim(
      `It form-POSTs the assertion to ${endpoint}, which sets the Session cookie and 303s to return_to.`,
    ),
  );
  if (!ctx.values.print) openInBrowser(page.url);
  await Promise.race([page.served, new Promise((r) => setTimeout(r, 60_000))]);
  page.close();
  return 0;
}

/* --------------------------------------------------------------------------- ask */

async function cmdAsk(ctx: Ctx, domain: string | undefined, task: string): Promise<number> {
  if (!domain || !task) throw new PoppyError('usage', 'ask <domain> "<task>"');
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new PoppyError('usage', 'set OPENROUTER_API_KEY');
  const c = await company(ctx, domain);
  const r = await ask(c, task, {
    apiKey,
    model: str(ctx.values.model) ?? process.env.POPPY_AGENT_MODEL ?? DEFAULT_MODEL,
    maxSteps: ctx.values['max-steps'] ? Number(ctx.values['max-steps']) : 8,
    baseUrl: process.env.POPPY_AGENT_LLM_URL,
    allowWrites: ctx.values.yes === true,
    confirm: (q) => ctx.prompter.confirm(q),
    log: (l) => out(l),
    context: localContext(),
  });
  out();
  out(bold('Answer:'));
  out(r.answer ?? '(no answer)');
  return r.answer === undefined ? 1 : 0;
}

/* --------------------------------------------------------------------------- chat */

function localContext(): MessageContext {
  const ro = Intl.DateTimeFormat().resolvedOptions();
  return { locale: ro.locale, time_zone: ro.timeZone };
}

const CHAT_HELP = `Type a message to send it. Commands:
  /data <json>          send a message with a data part
  /context k=v ...      send a context-only update (user_available=true|false, locale=…, time_zone=…)
  /as agent|human       who wrote what you type (default agent; human = the User's own words, 7.8)
  /handoff              ask for a person at the Company (7.9)
  /signin [method] [scope]  sign in (e.g. after an authorization event)
  /direct [text]        open a Direct Conversation (7.10); you then talk as the User
  /decline              decline the Company's request to talk to the User
  /leave                close the Direct Conversation
  /status               show status/responder
  /close                close the conversation (7.12)
  /quit                 leave (the conversation stays open)`;

async function cmdChat(ctx: Ctx, domain?: string): Promise<number> {
  const c = await company(ctx, domain);
  if (!poppyProtocol(c))
    throw new PoppyError(
      'no_conversation_protocol',
      'Company lists no `poppy` conversation protocol',
    );
  const conv = new ConversationClient(c);
  const stream = !ctx.values['no-stream'];
  let sender: 'agent' | 'human' = ctx.values.as === 'human' ? 'human' : 'agent';
  let mainId = str(ctx.values.conversation);
  let directId: string | undefined;
  let pendingAuth: ConversationEvent | undefined;
  let pendingUserRequest: ConversationEvent | undefined;
  let status = '';
  const followers = new Map<string, AbortController>();
  const provisional = new Map<string, string>();
  const rl = ctx.prompter.interface;

  const print = (line: string) => {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
    out(line);
    if (process.stdout.isTTY) rl.prompt(true);
  };
  const showProvisional = (id: string) => {
    if (!process.stdout.isTTY) return;
    const text = (provisional.get(id) ?? '').split('\n').pop() ?? '';
    process.stdout.write(
      `\r\x1b[2K${dim(`… ${text.slice(-((process.stdout.columns || 80) - 4))}`)}`,
    );
  };

  const render = (convId: string, ev: ConversationEvent) => {
    const tag = directId && convId !== directId ? dim('[parent] ') : '';
    switch (ev.type) {
      case 'message': {
        const m = ev.message!;
        provisional.delete(m.id);
        if (m.role === 'user') return; // our own message, echoed back
        let line = `${tag}${bold(`company[${m.sender}]`)}: ${m.text ?? ''}`;
        if (m.data) line += `\n${dim(JSON.stringify(m.data, null, 2))}`;
        print(line);
        return;
      }
      case 'state':
        status = `${ev.status}/${ev.responder}`;
        print(dim(`${tag}[${status}]`));
        return;
      case 'authorization':
        pendingAuth = ev;
        print(
          `${tag}${bold('Authorization needed')}: ${ev.error}${ev.scope ? ` (scope "${ev.scope}")` : ''}. Type /signin to sign in, then keep chatting.`,
        );
        return;
      case 'user_requested':
        pendingUserRequest = ev;
        print(
          `${tag}${bold('The Company asks to talk with you directly')}: ${ev.reason ?? ''}\n  /direct to accept, /decline to decline.`,
        );
        return;
      case 'direct_opened':
        print(dim(`${tag}[direct conversation ${ev.conversation_id} opened]`));
        return;
      case 'direct_closed':
        print(dim(`${tag}[direct conversation ${ev.conversation_id} closed]`));
        if (directId === ev.conversation_id) directId = undefined;
        return;
      default:
        return; // MUST skip unknown event types (7.5)
    }
  };

  const follow = (convId: string) => {
    if (followers.has(convId)) return;
    const ac = new AbortController();
    followers.set(convId, ac);
    (async () => {
      try {
        for await (const item of conv.follow(convId, { signal: ac.signal, stream })) {
          if (item.kind === 'delta') {
            provisional.set(
              item.delta.message_id,
              (provisional.get(item.delta.message_id) ?? '') + item.delta.text,
            );
            showProvisional(item.delta.message_id);
          } else if (item.kind === 'reconnected') {
            provisional.clear(); // 7.6: drop pieces of messages not received in full
          } else if (item.kind === 'history_gap') {
            print(
              dim('[part of this conversation is no longer available; reading from the start]'),
            );
          } else render(convId, item.event);
        }
      } catch (e) {
        if (!ac.signal.aborted)
          print(`! event stream for ${convId} stopped: ${(e as Error).message}`);
      } finally {
        followers.delete(convId);
      }
    })();
  };

  const send = async (msg: Omit<OutgoingMessage, 'id'>) => {
    const message: OutgoingMessage = { id: newMessageId(), ...msg };
    const target = directId ?? mainId;
    if (!target) {
      message.context = { ...localContext(), user_available: true, ...message.context };
      const r = await conv.start(message);
      mainId = r.conversation_id;
      print(dim(`[conversation ${mainId} — ${r.status}/${r.responder}]`));
      follow(mainId);
    } else {
      const r = await conv.send(target, message);
      if (r?.status) status = `${r.status}/${r.responder}`;
    }
  };

  out(`Chatting with ${bold(c.document.organization.name)} as ${sender}. /help for commands.`);
  if (mainId) follow(mainId);
  rl.setPrompt('> ');
  for (;;) {
    let line: string;
    try {
      line = (await rl.question(directId ? 'you (direct)> ' : '> ')).trim();
    } catch {
      break;
    }
    if (!line) continue;
    try {
      if (!line.startsWith('/')) {
        await send({ sender: directId ? 'human' : sender, text: line });
        continue;
      }
      const [cmd, ...rest] = line.split(' ');
      const restText = rest.join(' ').trim();
      if (cmd === '/quit' || cmd === '/exit') break;
      if (cmd === '/help') out(CHAT_HELP);
      else if (cmd === '/as') {
        sender = restText === 'human' ? 'human' : 'agent';
        out(dim(`now sending as ${sender}`));
      } else if (cmd === '/data') {
        await send({ sender: directId ? 'human' : sender, data: JSON.parse(restText) });
      } else if (cmd === '/context') {
        const context: MessageContext = {};
        for (const kv of rest) {
          const [k, val] = kv.split('=');
          if (!k) continue;
          context[k] = val === 'true' ? true : val === 'false' ? false : val;
        }
        await send({ sender: 'agent', context });
      } else if (cmd === '/status') {
        if (!mainId) out('no conversation yet');
        else {
          const page = await conv.read(directId ?? mainId, {
            cursor: c.state.conversations[directId ?? mainId]?.cursor || undefined,
          });
          out(`${directId ?? mainId}: ${page.status}/${page.responder}`);
        }
      } else if (cmd === '/handoff') {
        if (!mainId) out('no conversation yet');
        else {
          const r = await conv.handoff(mainId);
          out(dim(`[${r.status}/${r.responder}]`));
        }
      } else if (cmd === '/signin') {
        const [method, ...scopeParts] = rest;
        const scope = scopeParts.join(' ') || pendingAuth?.scope || undefined;
        const m =
          method === 'direct' || method === 'device' || method === 'mediated' ? method : undefined;
        const r = await signIn(
          ctx,
          c,
          m,
          m ? scope : [method, ...scopeParts].filter(Boolean).join(' ') || scope,
        );
        if (r) {
          pendingAuth = undefined;
          out(dim('Continue the conversation; the new Session Token is used from now on.'));
        }
      } else if (cmd === '/direct') {
        if (!mainId) out('no conversation yet');
        else {
          const message: OutgoingMessage = {
            id: newMessageId(),
            sender: 'human',
            text: restText || 'Hi, I am here.',
            context: { user_available: true },
          };
          const r = await conv.start(message, { parentConversationId: mainId });
          directId = r.conversation_id;
          pendingUserRequest = undefined;
          print(dim(`[direct conversation ${directId} — you are now talking as the User]`));
          follow(directId);
        }
      } else if (cmd === '/decline') {
        if (!mainId) out('no conversation yet');
        else {
          await conv.send(mainId, {
            id: newMessageId(),
            sender: 'agent',
            text: pendingUserRequest
              ? 'The user declined to talk directly right now.'
              : 'The user is not available.',
            context: { user_available: false },
          });
          pendingUserRequest = undefined;
        }
      } else if (cmd === '/leave') {
        if (!directId) out('not in a direct conversation');
        else {
          const id = directId;
          await conv.close(id);
          followers.get(id)?.abort();
          directId = undefined;
          out(dim(`[direct conversation ${id} closed]`));
        }
      } else if (cmd === '/close') {
        if (!mainId) break;
        const r = await conv.close(mainId);
        out(dim(`[${r.status}/${r.responder}]`));
        break;
      } else out(`unknown command ${cmd}; /help`);
    } catch (e) {
      out(`! ${(e as Error).message}`);
    }
  }
  for (const ac of followers.values()) ac.abort();
  return 0;
}
