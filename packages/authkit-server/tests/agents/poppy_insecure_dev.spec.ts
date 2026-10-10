import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from '@japa/runner';
import { resolvePersonalAgentsConfig } from '../../src/agents/config.js';
import { PoppyClientRegistry } from '../../src/agents/poppy/client_registry.js';
import { PoppyError } from '../../src/agents/poppy/errors.js';
import { agentKeys } from './poppy_helpers.js';

const org = { name: 'Shop', domain: 'shop.example' };

async function rejects(fn: () => Promise<unknown>): Promise<PoppyError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PoppyError) return error;
    throw error;
  }
  throw new Error('expected a PoppyError');
}

/** Um agente local em `http://127.0.0.1:<porta>` (o `poppy-agent --insecure-dev`). */
async function localAgent() {
  const keys = await agentKeys();
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body =
      req.url === '/agent.json'
        ? {
            client_id: `${base}/agent.json`,
            client_name: 'Local Agent',
            jwks_uri: `${base}/jwks.json`,
            redirect_uris: [`${base}/oauth/callback`],
            token_endpoint_auth_method: 'private_key_jwt',
          }
        : req.url === '/jwks.json'
          ? { keys: [keys.jwk] }
          : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, clientId: `${base}/agent.json`, close: () => server.close() };
}

test.group('poppy — allowInsecureClientIds (só dev/teste)', (group) => {
  let nodeEnv: string | undefined;
  group.each.setup(() => {
    nodeEnv = process.env.NODE_ENV;
  });
  group.each.teardown(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  test('default: client_id http em loopback → invalid_client', async ({ assert }) => {
    const agent = await localAgent();
    const cfg = resolvePersonalAgentsConfig({ poppy: { organization: org } })!.poppy!;
    assert.isFalse(cfg.allowInsecureClientIds);
    const err = await rejects(() => new PoppyClientRegistry(cfg).resolve(agent.clientId));
    assert.equal(err.code, 'invalid_client');
    agent.close();
  });

  test('ligado: resolve um agente local em http (metadata + jwks), sem guarda de SSRF', async ({
    assert,
  }) => {
    process.env.NODE_ENV = 'development';
    const agent = await localAgent();
    const cfg = resolvePersonalAgentsConfig({
      poppy: { organization: org, allowInsecureClientIds: true },
    })!.poppy!;
    const client = await new PoppyClientRegistry(cfg).resolve(agent.clientId);
    assert.equal(client.clientId, agent.clientId);
    assert.equal(client.name, 'Local Agent');
    assert.deepEqual(client.redirectUris, [`${agent.base}/oauth/callback`]);
    agent.close();
  });

  test('NODE_ENV=production recusa a config', ({ assert }) => {
    process.env.NODE_ENV = 'production';
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          poppy: { organization: org, allowInsecureClientIds: true },
        }),
      /allowInsecureClientIds/,
    );
  });
});
