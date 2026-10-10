import { stat } from 'node:fs/promises';
import { test } from '@japa/runner';
import { callOpenApi } from '../src/api.js';
import { autoSubmitFormHtml, createBrowserAssertion, serveOneShotPage } from '../src/browser.js';
import { ConversationClient, newMessageId, type StreamItem } from '../src/conversations.js';
import { ConversationError, ResourceAuthError } from '../src/errors.js';
import { waitForRelayedCallback } from '../src/identity_server.js';
import { ask } from '../src/llm.js';
import { connectMcp } from '../src/mcp.js';
import {
  completeDirectSignIn,
  deviceSignIn,
  eligibleSignInTypes,
  mediatedSignIn,
  startDirectSignIn,
  submitMediatedCode,
} from '../src/signin.js';
import type { World } from './fixtures/setup.js';
import { browse, world } from './fixtures/setup.js';

let w: World;
const noViolations = (assert: { deepEqual: (a: unknown, b: unknown) => void }) =>
  assert.deepEqual(w.fake.violations, []);

async function directSignIn(scope = 'poppy:read poppy:write') {
  const c = await w.agent.company(w.fake.domain);
  const pending = await startDirectSignIn(c, scope);
  const back = await browse(pending.url);
  return { c, result: await completeDirectSignIn(c, pending, back.searchParams), pending };
}

async function collect(
  gen: AsyncGenerator<StreamItem>,
  until: (items: StreamItem[]) => boolean,
  ac: AbortController,
) {
  const items: StreamItem[] = [];
  for await (const item of gen) {
    items.push(item);
    if (until(items)) {
      ac.abort();
      break;
    }
  }
  return items;
}

test.group('sessions (4.1-4.3)', (group) => {
  group.each.teardown(async () => w.cleanup());

  test('starts a signed-out Session with DPoP + nonce retry, and renews it with session_id', async ({
    assert,
  }) => {
    w = await world({ requireNonce: true });
    const c = await w.agent.company(w.fake.domain);
    const t1 = await c.token();
    assert.isFalse(t1.signedIn);
    assert.equal(t1.tokenType, 'DPoP');
    assert.match(c.userId, /^usr_/);
    const t2 = await c.token({ forceRenew: true });
    assert.equal(t2.sessionId, t1.sessionId);
    assert.notEqual(t2.accessToken, t1.accessToken);
    const r = await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { hello: 'world', signed_in: false });
    assert.isTrue(w.fake.log.some((l) => l === 'oauth error use_dpop_nonce'));
    const mode = (await stat(w.store.path)).mode & 0o777;
    assert.equal(mode, 0o600);
    noViolations(assert);
  });

  test('invalid_session starts a new Session', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const t1 = await c.token();
    w.fake.sessions.get(t1.sessionId)!.ended = true;
    const t2 = await c.token({ forceRenew: true });
    assert.notEqual(t2.sessionId, t1.sessionId);
    noViolations(assert);
  });

  test('429 Retry-After is waited out', async ({ assert }) => {
    w = await world({ rateLimitOnce: true });
    const c = await w.agent.company(w.fake.domain);
    const r = await callOpenApi(c, { method: 'GET', path: '/public' });
    assert.equal(r.status, 200);
    assert.isTrue(w.logs.some((l) => l.includes('Retry-After')));
  });
});

test.group('sign-in (4.4-4.9)', (group) => {
  group.each.teardown(async () => w.cleanup());

  test('Direct Sign-In: PKCE, state, iss, session_id; then signed-in API calls', async ({
    assert,
  }) => {
    w = await world();
    const { c, result } = await directSignIn();
    assert.equal(result.grantedScope, 'poppy:read poppy:write');
    assert.isTrue((await c.token()).signedIn);
    assert.equal(w.callbacks.length, 1);
    const r = await callOpenApi(c, { method: 'GET', path: '/orders' });
    assert.equal(r.status, 200);
    noViolations(assert);
  });

  test('Direct Sign-In callback relay through the state dir', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const pending = await startDirectSignIn(c, 'poppy:read');
    const waiting = waitForRelayedCallback(w.dir, pending.state, { pollMs: 20 });
    await browse(pending.url);
    const params = await waiting;
    await completeDirectSignIn(c, pending, params);
    assert.isTrue((await c.token()).signedIn);
  });

  test('Direct Sign-In rejects a wrong iss, a wrong state, and access_denied', async ({
    assert,
  }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const pending = await startDirectSignIn(c, 'poppy:read');
    const back = await browse(pending.url);
    const swapped = new URLSearchParams(back.searchParams);
    swapped.set('iss', 'https://other.example');
    await assert.rejects(() => completeDirectSignIn(c, pending, swapped), /iss/);
    const badState = new URLSearchParams(back.searchParams);
    badState.set('state', 'x'.repeat(22));
    await assert.rejects(() => completeDirectSignIn(c, pending, badState), /state/);
    const denied = await browse(`${pending.url}&login_hint=deny`);
    await assert.rejects(
      () => completeDirectSignIn(c, pending, denied.searchParams),
      /access_denied/,
    );
  });

  test('scopes are checked against the sign-in type', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    assert.deepEqual(eligibleSignInTypes(c, 'poppy:read'), ['direct', 'device', 'mediated']);
    assert.deepEqual(eligibleSignInTypes(c, 'addresses'), ['direct']);
    await assert.rejects(() => mediatedSignIn(c, 'poppy:write', {}), /can't grant/);
  });

  test('Device Sign-In polls through authorization_pending and slow_down', async ({ assert }) => {
    w = await world({ devicePendingPolls: 2 });
    const c = await w.agent.company(w.fake.domain);
    const sleeps: number[] = [];
    const polls: string[] = [];
    let shown = '';
    const r = await deviceSignIn(c, 'poppy:read', {
      display: (i) => (shown = i.userCode),
      sleep: async (ms) => void sleeps.push(ms),
      onPoll: (s) => polls.push(s),
    });
    assert.equal(shown, 'WDJB-MJHT');
    assert.deepEqual(polls, ['authorization_pending', 'authorization_pending', 'slow_down']);
    assert.deepEqual(sleeps, [1000, 1000, 1000, 6000]);
    assert.equal(r.grantedScope, 'poppy:read');
    noViolations(assert);
  });

  test('Mediated Sign-In with a one-time code', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const failed = await mediatedSignIn(c, 'poppy:read', {
      email: 'dana@example.com',
      password: 'wrong',
    });
    assert.equal(failed.status, 'failed');
    const first = await mediatedSignIn(c, 'poppy:read', {
      email: 'dana@example.com',
      password: 'hunter2',
    });
    assert.equal(first.status, 'code_required');
    if (first.status !== 'code_required') return;
    assert.equal(first.sentTo, 'Text to the phone number ending in 71');
    const wrong = await submitMediatedCode(c, 'poppy:read', first.signInId, '000000');
    assert.equal(wrong.status, 'code_required');
    const done = await submitMediatedCode(c, 'poppy:read', first.signInId, '123456');
    assert.equal(done.status, 'complete');
    assert.isTrue((await c.token()).signedIn);
    assert.notInclude(JSON.stringify(w.logs), 'hunter2');
    noViolations(assert);
  });

  test('Account Token starts later Sessions signed in, rotation is honoured, narrower scope works', async ({
    assert,
  }) => {
    w = await world({ rotateAccountToken: true });
    const { c } = await directSignIn();
    const first = c.state.accountToken!.refreshToken;
    await c.newSession();
    const t = await c.token();
    assert.isTrue(t.signedIn);
    assert.notEqual(c.state.accountToken!.refreshToken, first);
    const narrow = await c.token({ scope: 'poppy:read' });
    assert.equal(narrow.scope, 'poppy:read');
    noViolations(assert);
  });

  test('sign_in_required → retried with the Account Token; insufficient_scope surfaces the scope', async ({
    assert,
  }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    await assert.rejects(
      () => callOpenApi(c, { method: 'POST', path: '/addresses', body: {} }),
      /sign_in_required/,
    );
    await directSignIn('poppy:read');
    try {
      await callOpenApi(c, { method: 'POST', path: '/addresses', body: {} });
      assert.fail('expected insufficient_scope');
    } catch (e) {
      assert.instanceOf(e, ResourceAuthError);
      assert.equal((e as ResourceAuthError).scope, 'addresses');
    }
  });

  test('disconnect revokes the Account Token and Sessions continue signed out', async ({
    assert,
  }) => {
    w = await world();
    const { c } = await directSignIn();
    const sid = c.state.sessionId;
    assert.isTrue(await c.signOut());
    const t = await c.token();
    assert.isFalse(t.signedIn);
    assert.equal(t.sessionId, sid);
    noViolations(assert);
  });

  test('a revoked Account Token (invalid_grant) means continuing signed out', async ({
    assert,
  }) => {
    w = await world();
    const { c } = await directSignIn();
    for (const at of w.fake.accountTokens.values()) at.revoked = true;
    await c.newSession();
    const t = await c.token();
    assert.isFalse(t.signedIn);
    assert.isUndefined(c.state.accountToken);
  });

  test('replacing the Account Token revokes the old one', async ({ assert }) => {
    w = await world();
    await directSignIn('poppy:read');
    const old = [...w.fake.accountTokens.values()][0];
    const { c } = await directSignIn('poppy:read poppy:write');
    assert.isTrue(old.revoked);
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/orders' })).status, 200);
    // The Company signed the Session out behind our back: the Account Token signs it back in.
    w.fake.sessions.get(c.state.sessionId!)!.account = undefined;
    assert.equal((await callOpenApi(c, { method: 'GET', path: '/orders' })).status, 200);
  });
});

test.group('APIs (6)', (group) => {
  group.each.teardown(async () => w.cleanup());

  test('MCP over streamable HTTP with a Bearer token issued for its url', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const mcp = await connectMcp(c);
    const { tools } = await mcp.client.listTools();
    assert.includeMembers(
      tools.map((t) => t.name),
      ['whoami', 'search_products', 'place_order'],
    );
    const r = await mcp.client.callTool({ name: 'whoami', arguments: {} });
    assert.include(JSON.stringify(r.content), 'signed_in');
    await mcp.close();
    const bearer = Object.values(c.state.tokens).find((t) => t.tokenType === 'Bearer');
    assert.equal(bearer?.resource, w.fake.mcpUrl);
    assert.equal(bearer?.sessionId, c.state.sessionId);
    noViolations(assert);
  });

  test('refuses to send the token to a foreign origin', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    await assert.rejects(
      () => callOpenApi(c, { method: 'GET', path: 'https://evil.example/steal' }),
      /refusing/,
    );
  });
});

test.group('conversations (7)', (group) => {
  group.each.teardown(async () => w.cleanup());

  test('SSE: deltas, final message, state events, Last-Event-ID resume', async ({ assert }) => {
    w = await world({ dropStreamAfterFirstMessage: true });
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const start = await conv.start({
      id: newMessageId(),
      sender: 'agent',
      text: 'hello',
      context: { locale: 'en-US', time_zone: 'America/Los_Angeles', user_available: true },
    });
    assert.match(start.conversation_id, /^cnv_/);
    const ac = new AbortController();
    const firstReply = (items: StreamItem[]) =>
      items.filter(
        (i) =>
          i.kind === 'event' && i.event.type === 'message' && i.event.message?.role === 'company',
      ).length >= 2;
    const pending = collect(
      conv.follow(start.conversation_id, { signal: ac.signal }),
      firstReply,
      ac,
    );
    await new Promise((r) => setTimeout(r, 100));
    await conv.send(start.conversation_id, {
      id: newMessageId(),
      sender: 'agent',
      text: 'second',
      data: { n: 2 },
    });
    const items = await pending;
    const kinds = items.map((i) => i.kind);
    assert.include(kinds, 'reconnected');
    const messages = items.flatMap((i) =>
      i.kind === 'event' && i.event.type === 'message' ? [i.event] : [],
    );
    assert.equal(
      messages.filter((m) => m.message?.role === 'company')[0].message?.text,
      'You said: hello',
    );
    assert.isTrue(items.some((i) => i.kind === 'event' && i.event.type === 'state'));
    const ids = items.flatMap((i) => (i.kind === 'event' ? [i.event.id] : []));
    assert.equal(new Set(ids).size, ids.length, 'no event handled twice');
    assert.isAbove(w.fake.lastEventIdHeaders.length, 0);
    noViolations(assert);
  });

  test('long-poll reads, idempotent retries, message_id_conflict, handoff, close', async ({
    assert,
  }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const m = { id: newMessageId(), sender: 'agent' as const, text: 'hi' };
    const a = await conv.start(m);
    const b = await conv.start(m);
    assert.equal(b.conversation_id, a.conversation_id);
    await assert.rejects(() => conv.start({ ...m, text: 'different' }), /message_id_conflict/);
    const { events, state } = await conv.collect(a.conversation_id);
    assert.equal(state.status, 'idle');
    assert.isTrue(events.some((e) => e.message?.text === 'You said: hi'));
    const h = await conv.handoff(a.conversation_id);
    assert.equal(h.status, 'queued');
    await new Promise((r) => setTimeout(r, 80));
    const after = await conv.collect(a.conversation_id);
    assert.equal(after.state.responder, 'human');
    const closed = await conv.close(a.conversation_id);
    assert.equal(closed.status, 'closed');
    try {
      await conv.send(a.conversation_id, { id: newMessageId(), sender: 'agent', text: 'more' });
      assert.fail('expected conversation_closed');
    } catch (e) {
      assert.instanceOf(e, ConversationError);
      assert.equal((e as ConversationError).code, 'conversation_closed');
    }
    noViolations(assert);
  });

  test('authorization event, sign in, continue the same conversation', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id: id } = await conv.start({
      id: newMessageId(),
      sender: 'agent',
      text: 'show my orders',
    });
    const first = await conv.collect(id);
    const auth = first.events.find((e) => e.type === 'authorization');
    assert.equal(auth?.error, 'sign_in_required');
    await directSignIn('poppy:read');
    await conv.send(id, { id: newMessageId(), sender: 'agent', text: 'orders please' });
    const second = await conv.collect(id);
    const reply = second.events.find((e) => e.type === 'message' && e.message?.role === 'company');
    assert.deepEqual(reply?.message?.data, { orders: [{ id: 'ord_1042', item: 'jacket' }] });
    noViolations(assert);
  });

  test('user_requested → Direct Conversation with parent, direct_opened/closed', async ({
    assert,
  }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const conv = new ConversationClient(c);
    const { conversation_id: parent } = await conv.start({
      id: newMessageId(),
      sender: 'agent',
      text: 'need a specialist',
    });
    const r = await conv.collect(parent);
    assert.isTrue(r.events.some((e) => e.type === 'user_requested'));
    const direct = await conv.start(
      { id: newMessageId(), sender: 'human', text: 'Hi, it is me' },
      { parentConversationId: parent },
    );
    await assert.rejects(
      () => conv.send(parent, { id: newMessageId(), sender: 'agent', text: 'x' }),
      /direct_conversation_open/,
    );
    await conv.close(direct.conversation_id);
    const after = await conv.collect(parent);
    const types = after.events.map((e) => e.type);
    assert.includeMembers(types, ['direct_opened', 'direct_closed']);
    noViolations(assert);
  });
});

test.group('web browsing (5)', (group) => {
  group.each.teardown(async () => w.cleanup());

  test('poppy-browser+jwt form POST (body, not URL) joins the Session', async ({ assert }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    await assert.rejects(() => createBrowserAssertion(c, 'https://evil.example/'), /return_to/);
    const { endpoint, assertion, sessionId } = await createBrowserAssertion(
      c,
      `${w.fake.origin}/orders`,
    );
    const html = autoSubmitFormHtml(endpoint, assertion);
    assert.include(html, 'method="post"');
    assert.notInclude(endpoint, assertion);
    const page = await serveOneShotPage(html);
    assert.notInclude(page.url, assertion);
    const served = await (await fetch(page.url)).text();
    assert.equal(served, html);
    assert.equal((await fetch(page.url)).status, 404, 'one-shot');
    page.close();
    // Play the controlled browser: submit the form.
    const res = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ assertion }).toString(),
    });
    assert.equal(res.status, 303);
    assert.include(res.headers.get('set-cookie') ?? '', 'HttpOnly');
    assert.deepEqual(w.fake.browserJoins, [{ sessionId, returnTo: `${w.fake.origin}/orders` }]);
    noViolations(assert);
  });
});

test.group('LLM mode', (group) => {
  group.each.teardown(async () => w.cleanup());

  test('ask: scripted model talks to the company and uses MCP; writes need consent', async ({
    assert,
  }) => {
    w = await world();
    const c = await w.agent.company(w.fake.domain);
    const script = [
      {
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'mcp_search_products', arguments: '{"query":"jacket"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: '2',
            type: 'function',
            function: { name: 'mcp_place_order', arguments: '{"sku":"x"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: '3',
            type: 'function',
            function: { name: 'talk_to_company', arguments: '{"text":"Is it warm?"}' },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: '4',
            type: 'function',
            function: { name: 'finish', arguments: '{"answer":"Yes, size M for $70."}' },
          },
        ],
      },
    ];
    const requests: any[] = [];
    const transcript: string[] = [];
    const r = await ask(c, 'find a warm jacket', {
      apiKey: 'test',
      baseUrl: 'http://llm.invalid/chat',
      fetch: async (_u, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const msg = script.shift()!;
        return new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, ...msg } }] }),
        );
      },
      log: (l) => transcript.push(l),
    });
    assert.equal(r.answer, 'Yes, size M for $70.');
    assert.equal(r.steps, 4);
    const toolMsgs = requests[3].messages
      .filter((m: any) => m.role === 'tool')
      .map((m: any) => m.content);
    assert.include(toolMsgs[0], 'insulated jacket');
    assert.include(toolMsgs[1], 'refused');
    assert.include(toolMsgs[2], 'You said: Is it warm?');
    const all = JSON.stringify(requests);
    for (const t of Object.values(c.state.tokens)) assert.notInclude(all, t.accessToken);
    assert.isTrue(w.fake.conversations.get(r.conversationId!)?.status === 'closed');
    noViolations(assert);
  });
});
