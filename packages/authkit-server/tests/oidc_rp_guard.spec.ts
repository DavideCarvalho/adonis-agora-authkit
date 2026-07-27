import { test } from '@japa/runner'
import { OidcRpGuard } from '../src/host/oidc_rp_guard.js'
import { ACCOUNT_SESSION_KEY } from '../src/host/middleware/account_auth.js'

type FakeUser = { id: string; email: string }

function makeUserProvider(users: Map<string, FakeUser>) {
  return {
    async createUserForGuard(user: FakeUser) {
      return { getId: () => user.id, getOriginal: () => user }
    },
    async findById(identifier: string | number | bigint) {
      const user = users.get(String(identifier))
      if (!user) return null
      return { getId: () => user.id, getOriginal: () => user }
    },
  } as any
}

function makeCtx(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial }
  const emitted: Array<{ event: string; data: unknown }> = []
  const ctx = {
    session: {
      get: (k: string) => store[k],
      put: (k: string, v: unknown) => {
        store[k] = v
      },
      forget: (k: string) => {
        delete store[k]
      },
    },
  } as any
  const emitter = {
    emit: (event: string, data: unknown) => {
      emitted.push({ event, data })
    },
  } as any
  return { ctx, store, emitter, emitted }
}

function makeGuard(
  users: Map<string, FakeUser>,
  sessionData: Record<string, unknown> = {},
  sessionKey?: string
) {
  const { ctx, store, emitter, emitted } = makeCtx(sessionData)
  const provider = makeUserProvider(users)
  const guard = new OidcRpGuard(
    'web',
    ctx,
    sessionKey ?? ACCOUNT_SESSION_KEY,
    emitter,
    provider
  )
  return { guard, ctx, store, emitted }
}

test.group('OidcRpGuard — authenticate', () => {
  test('autentica quando a sessão tem um user id válido', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'u1' })

    const user = await guard.authenticate()
    assert.equal(user.email, 'a@b.com')
    assert.isTrue(guard.isAuthenticated)
    assert.isTrue(guard.authenticationAttempted)
  })

  test('falha quando não há user id na sessão', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard } = makeGuard(users, {})

    await assert.rejects(() => guard.authenticate(), 'Unauthorized')
    assert.isFalse(guard.isAuthenticated)
    assert.isTrue(guard.authenticationAttempted)
  })

  test('falha e limpa a sessão quando o user não existe no provider', async ({ assert }) => {
    const users = new Map<string, FakeUser>()
    const { guard, store } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'ghost' })

    await assert.rejects(() => guard.authenticate(), 'Unauthorized')
    assert.isUndefined(store[ACCOUNT_SESSION_KEY])
  })

  test('segunda chamada retorna o cache sem re-query', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'u1' })

    const first = await guard.authenticate()
    users.delete('u1')
    const second = await guard.authenticate()
    assert.strictEqual(first, second)
  })

  test('emite authentication_succeeded no sucesso', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard, emitted } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'u1' })

    await guard.authenticate()
    assert.deepEqual(
      emitted.map((e) => e.event),
      ['oidc_rp:authentication_succeeded']
    )
  })

  test('emite authentication_failed quando não há sessão', async ({ assert }) => {
    const users = new Map<string, FakeUser>()
    const { guard, emitted } = makeGuard(users, {})

    await assert.rejects(() => guard.authenticate())
    assert.deepEqual(
      emitted.map((e) => e.event),
      ['oidc_rp:authentication_failed']
    )
  })
})

test.group('OidcRpGuard — check', () => {
  test('retorna true quando autenticado', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'u1' })

    assert.isTrue(await guard.check())
  })

  test('retorna false quando não autenticado', async ({ assert }) => {
    const users = new Map<string, FakeUser>()
    const { guard } = makeGuard(users, {})

    assert.isFalse(await guard.check())
  })
})

test.group('OidcRpGuard — login', () => {
  test('grava o user id na sessão e seta estado', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard, store } = makeGuard(users, {})
    const user = { id: 'u1', email: 'a@b.com' }

    await guard.login(user)
    assert.equal(store[ACCOUNT_SESSION_KEY], 'u1')
    assert.isTrue(guard.isAuthenticated)
    assert.strictEqual(guard.user, user)
  })

  test('emite login_succeeded', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard, emitted } = makeGuard(users, {})

    await guard.login({ id: 'u1', email: 'a@b.com' })
    assert.deepEqual(
      emitted.map((e) => e.event),
      ['oidc_rp:login_succeeded']
    )
  })

  test('respeita sessionKey customizado', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard, store } = makeGuard(users, {}, 'custom_key')

    await guard.login({ id: 'u1', email: 'a@b.com' })
    assert.equal(store['custom_key'], 'u1')
    assert.isUndefined(store[ACCOUNT_SESSION_KEY])
  })
})

test.group('OidcRpGuard — logout', () => {
  test('limpa a sessão e reseta estado', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard, store } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'u1' })

    await guard.authenticate()
    assert.isTrue(guard.isAuthenticated)

    await guard.logout()
    assert.isUndefined(store[ACCOUNT_SESSION_KEY])
    assert.isFalse(guard.isAuthenticated)
    assert.isTrue(guard.isLoggedOut)
    assert.isUndefined(guard.user)
  })

  test('emite logged_out', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard, emitted } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'u1' })

    await guard.authenticate()
    await guard.logout()
    assert.include(
      emitted.map((e) => e.event),
      'oidc_rp:logged_out'
    )
  })
})

test.group('OidcRpGuard — getUserOrFail', () => {
  test('retorna o user quando autenticado', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard } = makeGuard(users, { [ACCOUNT_SESSION_KEY]: 'u1' })

    await guard.authenticate()
    assert.equal(guard.getUserOrFail().email, 'a@b.com')
  })

  test('lança quando não autenticado', async ({ assert }) => {
    const users = new Map<string, FakeUser>()
    const { guard } = makeGuard(users, {})

    assert.throws(() => guard.getUserOrFail(), 'Cannot access user')
  })
})

test.group('OidcRpGuard — authenticateAsClient', () => {
  test('retorna session com o user id', async ({ assert }) => {
    const users = new Map([['u1', { id: 'u1', email: 'a@b.com' }]])
    const { guard } = makeGuard(users, {})

    const response = await guard.authenticateAsClient({ id: 'u1', email: 'a@b.com' })
    assert.deepEqual(response, { session: { [ACCOUNT_SESSION_KEY]: 'u1' } })
  })
})
