import { test } from '@japa/runner';
import { lucidMirror } from '../src/lucid_mirror.js';

/** In-memory stand-in for a Lucid model: rows keyed by id, every call recorded. */
function fakeModel(rows: Record<string, Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const Model = {
    async findBy(key: string, value: unknown) {
      calls.push(`findBy:${key}=${value}`);
      const row = rows[String(value)];
      return row ? { ...row } : null;
    },
    async updateOrCreate(search: Record<string, unknown>, payload: Record<string, unknown>) {
      calls.push('updateOrCreate');
      const id = String(search.id);
      rows[id] = { ...rows[id], ...payload };
      return { ...rows[id] };
    },
  };
  return { Model, calls, rows };
}

const identity = { userId: 'u1', email: 'a@b.com', globalRoles: ['ADMIN'] } as any;

test.group('lucidMirror', () => {
  test('first sight of a user creates the row', async ({ assert }) => {
    const { Model, calls, rows } = fakeModel();
    const user: any = await lucidMirror(Model)(identity);
    assert.deepEqual(calls, ['findBy:id=u1', 'updateOrCreate']);
    assert.deepEqual(rows.u1, { id: 'u1', email: 'a@b.com' });
    assert.equal(user.email, 'a@b.com');
  });

  test('an up-to-date row is read without updateOrCreate', async ({ assert }) => {
    const { Model, calls } = fakeModel({ u1: { id: 'u1', email: 'a@b.com', name: 'x' } });
    const resolve = lucidMirror(Model);
    for (let i = 0; i < 5; i++) {
      const user: any = await resolve(identity);
      assert.equal(user.email, 'a@b.com');
    }
    assert.notInclude(calls, 'updateOrCreate');
  });

  test('a changed claim is written through updateOrCreate', async ({ assert }) => {
    const { Model, calls, rows } = fakeModel({ u1: { id: 'u1', email: 'old@b.com' } });
    const user: any = await lucidMirror(Model)(identity);
    assert.include(calls, 'updateOrCreate');
    assert.equal(rows.u1.email, 'a@b.com');
    assert.equal(user.email, 'a@b.com');
  });

  test('synced object values always go through updateOrCreate', async ({ assert }) => {
    const { Model, calls } = fakeModel({ u1: { id: 'u1', meta: { a: 1 } } });
    await lucidMirror(Model, { sync: () => ({ meta: { a: 1 } }) })(identity);
    assert.include(calls, 'updateOrCreate');
  });

  test('a model without findBy keeps using updateOrCreate', async ({ assert }) => {
    const { Model, calls } = fakeModel({ u1: { id: 'u1', email: 'a@b.com' } });
    const { findBy: _findBy, ...withoutFindBy } = Model;
    await lucidMirror(withoutFindBy)(identity);
    assert.deepEqual(calls, ['updateOrCreate']);
  });

  test('preload and injectGlobalRoles apply to the row read by findBy', async ({ assert }) => {
    const loaded: string[] = [];
    const Model = {
      async findBy() {
        return { id: 'u1', email: 'a@b.com', load: async (r: string) => loaded.push(r) };
      },
      async updateOrCreate(): Promise<any> {
        throw new Error('not expected');
      },
    };
    const user: any = await lucidMirror(Model, { preload: ['roles'], injectGlobalRoles: true })(
      identity,
    );
    assert.deepEqual(loaded, ['roles']);
    assert.deepEqual(user.globalRoles, ['ADMIN']);
  });
});
