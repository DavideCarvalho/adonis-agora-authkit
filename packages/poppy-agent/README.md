# @adonis-agora/poppy-agent

> [!WARNING]
> **Experimental.** This package implements the [Personal Agent Protocol (Poppy)](https://personalagentprotocol.org/docs/spec)
> **Draft 0.1**. The spec is still in development and can change in ways that aren't backward compatible.
> This client tracks it and **will change, possibly in breaking ways, as the spec evolves**.
> Implemented spec version: **Draft 0.1** (`protocol_version` major `0`).

A reference **Personal Agent** (the client side of Poppy), as a library and a CLI (`poppy-agent`).
There is no public Poppy agent yet; this one exists to test Company (server) implementations end
to end. It is written strictly against the spec, not against any particular server.

## What it implements

| Spec | Implemented |
| --- | --- |
| 3 Discovery | `/.well-known/poppy.json` over HTTPS, HTTPS-only redirects, `organization.domain` must match the requested host (ignoring `www.`), major `protocol_version` check, unknown fields/extensions/API types/protocol types ignored, RFC 8414 metadata (path-aware URL), exact `issuer` match, `poppy_domains` must list the domain, required endpoints, `Cache-Control: max-age` caching |
| 4.1 Agent identity | ES256 key pair, Client ID Metadata Document (`client_id` = its own URL, `jwks_uri` and `redirect_uris` on the same origin), `private_key_jwt` client assertions (RFC 7523) with fresh 128-bit `jti`, `serve-identity` HTTP server |
| 4.2 Sessions | JWT bearer grant (`iss`=client_id, `sub`=User ID, `aud`=token endpoint as a string, 60s `exp`, 128-bit `jti`), renewal with `session_id`, `invalid_session` → new Session, random opaque per-Company User IDs (`usr_…`, never derived from PII) |
| 4.3 Session Tokens | DPoP (RFC 9449) on every token/API/conversation request: `typ dpop+jwt`, ES256, public `jwk`, `jti`, `htm`, `htu` (no query/fragment), `iat`, `ath`, `DPoP-Nonce` + `use_dpop_nonce` retry with fresh assertions; one DPoP key per User per Company; Bearer only for MCP with `resource` = the MCP `url`; `scope`/`resource` narrowing; token downgrade (`Bearer` when a proof was sent) rejected; 429 `Retry-After` honoured |
| 4.4 Signing in | scopes checked against each sign-in type; granted vs requested scope reported; replaced Account Tokens revoked |
| 4.5 Direct | authorization code + PKCE S256 + `state`, RFC 9207 `iss` exact check, `session_id` on the exchange; callback via `serve-identity` (relayed through the state dir) or an in-process listener for `http://localhost` identities, or paste the redirect URL |
| 4.6 Device | RFC 8628 polling with `interval`, `authorization_pending`, `slow_down` (+5s), `access_denied`/`expired_token` stop |
| 4.7 Mediated | prompts for `auth.mediated.fields` (secret ones hidden, never logged), credentials only to `auth.mediated.endpoint`, `code_required` → `POST {endpoint}/{sign_in_id}` with only the code, `failed`/`expired` |
| 4.8 Account Tokens | stored per Company (issuer) + local profile in a 0600 state file; later Sessions start signed in; rotation honoured; `invalid_grant` → continue signed out; `sign_in_required` → retry with the Account Token |
| 4.9 Sign-out | `disconnect` → RFC 7009 with `token_type_hint=refresh_token`; Sessions continue signed out |
| 5 Web browsing | `poppy-browser+jwt` assertion (`aud`=endpoint, `session_id`, `return_to` on the Company domain, `exp` ≤ `iat`+60) delivered as an auto-submitting form POST from a one-shot local page (never in a URL) |
| 6 APIs | `openapi`: generic calls with DPoP, base URL from `servers[0]`, tokens never sent to a foreign origin, `WWW-Authenticate` errors mapped; `mcp`: MCP TypeScript SDK client over Streamable HTTP with a Bearer Session Token for that server, re-minted on `invalid_token` |
| 7 Conversations | start/send with agent-chosen idempotent message IDs (safe retries), `context` (`locale`, `time_zone`, `user_available`), `data` parts, events by long-poll or SSE with `Last-Event-ID` resume and de-duplication, `text-delta` shown provisionally and replaced by the final message (dropped on reconnect), `cursor_expired` restart, `authorization` events → sign in and continue, `user_requested` → Direct Conversation with `parent_conversation_id` (`sender: human`), handoff, close, unknown event types skipped |
| LLM mode | `ask`: tiny autonomous agent via OpenRouter tool calling (conversation + MCP tools), `--max-steps` cap, MCP tools without `readOnlyHint` need consent (`--yes` or a prompt), tokens never enter model context |

Not implemented: extensions (none are advertised; unknown ones are ignored), Personal Agent-side
OpenAPI schema validation.

## CLI

```sh
pnpm --filter @adonis-agora/poppy-agent build
alias poppy-agent="node $(pwd)/packages/poppy-agent/build/src/bin/poppy-agent.js"
poppy-agent --help
```

State lives in `~/.config/poppy-agent/state.json` (or `--state` / `$POPPY_AGENT_STATE`), mode 0600:
the agent's private keys, per-Company User IDs, DPoP keys, Account Tokens, Session Tokens and
conversation cursors. `--profile <name>` acts for another local user (different User IDs).

### Identity: `client_id` must be HTTPS

The spec requires `client_id` to be an HTTPS URL the Company can fetch. Two ways:

**A tunnel (spec-compliant).**

```sh
cloudflared tunnel --url http://127.0.0.1:7777          # prints https://<random>.trycloudflare.com
# or: tailscale funnel 7777
poppy-agent init --base-url https://<random>.trycloudflare.com --name "My Test Agent"
poppy-agent serve-identity --port 7777
```

`serve-identity` serves `/agent.json`, `/jwks.json`, `/logo.svg` and `/oauth/callback` (Direct
Sign-In redirects land there and are relayed to the `signin` process through the state dir).

**`--insecure-dev` (NOT spec-compliant, local only).** With `--insecure-dev` (or
`POPPY_AGENT_INSECURE_DEV=1`) the agent accepts `http://` everywhere the spec demands HTTPS:
its own `client_id`, `poppy.json`, the issuer, endpoints and redirects. Every run prints a loud
banner. The Company must be configured to accept an `http://localhost` `client_id` too. Never use
it against a real Company.

```sh
poppy-agent init --base-url http://localhost:7777 --insecure-dev
poppy-agent serve-identity --insecure-dev        # or let `signin` serve it in-process
```

### Commands

```sh
poppy-agent discover example.com
poppy-agent session example.com [--new] [--scope poppy:read] [--resource <url>]
poppy-agent signin example.com --method direct|device|mediated --scope "poppy:read poppy:write"
poppy-agent status
poppy-agent apis example.com
poppy-agent api example.com GET /orders
poppy-agent api example.com POST /addresses --data '{"line1":"…"}'
poppy-agent mcp tools example.com
poppy-agent mcp call example.com search_products '{"query":"jacket"}'
poppy-agent chat example.com          # /help inside for /data /context /as /handoff /signin /direct /decline /leave /close
poppy-agent open example.com https://example.com/orders [--print]
poppy-agent disconnect example.com
OPENROUTER_API_KEY=… poppy-agent ask example.com "Is the insulated jacket available in M?" [--model …] [--max-steps 8] [--yes]
```

In `chat`, what you type is sent with `sender: "agent"` by default (you act as the agent's brain).
`/as human` marks messages as the User's own words (7.8); in a Direct Conversation they are always
`human`. `open` warns that browser assertions must only be posted from a browser the agent controls
(section 5); use a dedicated or automation browser profile, or `--print` and load the page there.

## Testing against a local Agora app (MeuProntoo / Lastro)

Once the server side lands (`@adonis-agora/authkit-server` Poppy support on `feat/poppy-protocol`
and the conversation endpoint in `@adonis-agora/agent` on `feat/poppy-conversations`):

1. **Run the app** with Poppy enabled, e.g. `http://localhost:3333`. Check
   `curl http://localhost:3333/.well-known/poppy.json` and the issuer's
   `/.well-known/oauth-authorization-server` (it must list the app's domain in `poppy_domains`).
2. **Let the dev server accept an http `client_id`** (its dev-only setting for Client ID Metadata
   Documents over http/localhost), or use a tunnel for the agent identity and keep the app on
   HTTPS (e.g. its own tunnel) to stay spec-compliant.
3. **Create and serve the agent identity**:
   ```sh
   poppy-agent init --base-url http://localhost:7777 --name "Poppy Dev Agent" --insecure-dev
   poppy-agent serve-identity --insecure-dev &
   ```
   If the app requires registration/allowlisting of `client_id`s, register
   `http://localhost:7777/agent.json`.
4. **Discover and start a Session**:
   ```sh
   poppy-agent discover localhost:3333 --insecure-dev
   poppy-agent session localhost:3333 --insecure-dev         # signed out, DPoP-bound
   ```
5. **Sign in** with whatever the app offers:
   ```sh
   poppy-agent signin localhost:3333 --method direct --insecure-dev    # browser, PKCE, iss check
   poppy-agent signin localhost:3333 --method device --insecure-dev
   poppy-agent signin localhost:3333 --method mediated --insecure-dev
   ```
6. **Use it**: `apis`, `api …`, `mcp tools …`, `chat localhost:3333 --insecure-dev`
   (try asking for account data to trigger an `authorization` event, `/signin`, and continue),
   `open localhost:3333 http://localhost:3333/ --insecure-dev`, `ask …`.
7. **Sign out**: `poppy-agent disconnect localhost:3333 --insecure-dev`, then `session` again shows
   `signed_in: false` on the same `session_id`.

Watch stderr for tracing: retries (DPoP nonce, Retry-After, new Sessions) are logged.

## Library

```ts
import { AgentIdentity, ConversationClient, PoppyAgent, StateStore, newMessageId } from '@adonis-agora/poppy-agent';

const store = await StateStore.open();
const agent = new PoppyAgent({ store, identity: new AgentIdentity(store.data.identity!) });
const company = await agent.company('example.com');
const conv = new ConversationClient(company);
const { conversation_id } = await conv.start({ id: newMessageId(), sender: 'agent', text: 'Hi' });
for await (const item of conv.follow(conversation_id, { untilSettled: true })) console.log(item);
```

## Tests

`pnpm --filter @adonis-agora/poppy-agent test` runs unit tests plus end-to-end tests against an
in-process **fake Poppy Company** (`tests/fixtures/fake_company.ts`): `poppy.json`, RFC 8414
metadata, a token endpoint verifying `private_key_jwt`, JWT bearer assertions and DPoP (nonce,
`ath`, `jti` replay, key binding), authorization/device/mediated sign-in, revocation, an OpenAPI
API, a conversation endpoint with JSON long-poll and SSE (deltas, dropped streams), a browser
session endpoint and an MCP server. Each check a Company MUST perform is recorded as a violation
when the client breaks it, so the fake doubles as a conformance check of the client.

To try the CLI by hand against the fake:

```sh
cd packages/poppy-agent
node --import=@poppinss/ts-exec tests/fixtures/serve_fake.ts 7790 &
poppy-agent init --base-url http://127.0.0.1:7788 --insecure-dev
poppy-agent serve-identity --insecure-dev &
poppy-agent chat 127.0.0.1:7790 --insecure-dev
```

Mediated credentials for the fake: `dana@example.com` / `hunter2`, code `123456`.
