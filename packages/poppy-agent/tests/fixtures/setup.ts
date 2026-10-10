import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoppyAgent } from '../../src/company.js';
import { AgentIdentity } from '../../src/identity.js';
import { startIdentityServer } from '../../src/identity_server.js';
import { generateEs256Key } from '../../src/keys.js';
import { StateStore } from '../../src/store.js';
import { FakeCompany, type FakeOptions } from './fake_company.js';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export interface World {
  fake: FakeCompany;
  agent: PoppyAgent;
  identity: AgentIdentity;
  store: StateStore;
  dir: string;
  callbacks: URLSearchParams[];
  logs: string[];
  cleanup: () => Promise<void>;
}

/** A fake Company + a Personal Agent whose identity is served in-process (--insecure-dev). */
export async function world(opts: FakeOptions = {}): Promise<World> {
  const fake = await new FakeCompany(opts).start();
  const dir = await mkdtemp(join(tmpdir(), 'poppy-agent-'));
  const store = await StateStore.open(join(dir, 'state.json'));
  const port = await freePort();
  const identity = new AgentIdentity(
    {
      baseUrl: `http://127.0.0.1:${port}`,
      clientName: 'Test Agent',
      keys: [await generateEs256Key()],
    },
    { insecureDev: true },
  );
  store.data.identity = {
    baseUrl: identity.baseUrl,
    clientName: identity.clientName,
    keys: identity.keys,
  };
  await store.save();
  const callbacks: URLSearchParams[] = [];
  const idServer = await startIdentityServer(identity, {
    port,
    relayDir: dir,
    onCallback: (p) => callbacks.push(p),
  });
  const logs: string[] = [];
  const agent = new PoppyAgent({ store, identity, insecureDev: true, log: (l) => logs.push(l) });
  return {
    fake,
    agent,
    identity,
    store,
    dir,
    callbacks,
    logs,
    cleanup: async () => {
      await idServer.close();
      await fake.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Plays the User's browser for Direct Sign-In: follows the Company redirect to our callback. */
export async function browse(url: string): Promise<URL> {
  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`no redirect from ${url}: ${res.status}`);
  const back = new URL(location);
  await fetch(back);
  return back;
}
