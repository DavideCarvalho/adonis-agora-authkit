import { test } from '@japa/runner';
import { runCli } from '../src/cli/main.js';
import { type World, world } from './fixtures/setup.js';

async function capture(fn: () => Promise<number>) {
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (out.push(String(s)), true)) as any;
  process.stderr.write = ((s: string) => (out.push(String(s)), true)) as any;
  try {
    const code = await fn();
    return { code, text: out.join('') };
  } finally {
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
}

let w: World;

test.group('cli', (group) => {
  group.each.teardown(async () => w?.cleanup());

  test('--help shows the draft warning', async ({ assert }) => {
    const { code, text } = await capture(() => runCli(['--help']));
    assert.equal(code, 0);
    assert.include(text, 'Draft 0.1');
    assert.include(text, 'https://personalagentprotocol.org/docs/spec');
  });

  test('discover / session / status / api / mcp / disconnect against the fake', async ({
    assert,
  }) => {
    w = await world();
    const base = ['--state', w.store.path, '--insecure-dev'];
    const host = w.fake.origin;

    const d = await capture(() => runCli(['discover', host, ...base]));
    assert.equal(d.code, 0);
    assert.include(d.text, 'NON-SPEC MODE');
    assert.include(d.text, '"poppy_domains"');

    const s = await capture(() => runCli(['session', host, ...base]));
    assert.equal(s.code, 0, s.text);
    assert.include(s.text, '"signed_in": false');

    const a = await capture(() => runCli(['api', host, 'GET', '/public', ...base]));
    assert.equal(a.code, 0, a.text);
    assert.include(a.text, '"hello": "world"');

    const denied = await capture(() => runCli(['api', host, 'GET', '/orders', ...base]));
    assert.equal(denied.code, 1);
    assert.include(denied.text, 'sign_in_required');

    const m = await capture(() => runCli(['mcp', 'tools', host, ...base]));
    assert.equal(m.code, 0, m.text);
    assert.include(m.text, 'search_products');

    const call = await capture(() =>
      runCli(['mcp', 'call', host, 'search_products', '{"query":"boots"}', ...base]),
    );
    assert.equal(call.code, 0, call.text);
    assert.include(call.text, 'insulated boots');

    const st = await capture(() => runCli(['status', ...base]));
    assert.include(st.text, 'account token: no');

    const dc = await capture(() => runCli(['disconnect', host, ...base]));
    assert.equal(dc.code, 0);
    assert.deepEqual(w.fake.violations, []);
  });

  test('http base URL is refused without --insecure-dev', async ({ assert }) => {
    w = await world();
    const r = await capture(() => runCli(['session', w.fake.origin, '--state', w.store.path]));
    assert.equal(r.code, 1);
    assert.include(r.text, '--insecure-dev');
  });
});
