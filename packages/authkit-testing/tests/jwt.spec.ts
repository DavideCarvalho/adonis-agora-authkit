import type { Identity } from '@adonis-agora/authkit-client';
import { resolvers } from '@adonis-agora/authkit-client';
import { test } from '@japa/runner';
import { generateTestKeyPair, mintTestIdToken, serveJwks } from '../index.js';

/**
 * `resolvers.jwt().resolver()` é declarado como `SessionResolver`, que só expõe
 * `resolve(ctx: HttpContext)`. Quem valida o token cru é o `JwtResolver`
 * concreto, via `resolveToken(token)` — método público, mas a classe não é
 * exportada no entry do authkit-client, então o teste tem que alcançá-lo
 * estruturalmente. O cast é duplo porque as duas formas não se sobrepõem.
 *
 * A assinatura aqui é a real do `JwtResolver.resolveToken`, com `Identity` em
 * vez de `any`, para as asserções de `userId`/`email`/`globalRoles` abaixo
 * serem de fato checadas.
 */
type TokenResolver = { resolveToken(token: string): Promise<Identity | null> };

test.group('mintTestIdToken + JwtResolver', () => {
  test('um token emitido valida pelo JwtResolver real via JWKS local', async ({ assert }) => {
    const issuer = 'https://idp.test';
    const clientId = 'app-1';
    const key = await generateTestKeyPair('kid-test-1');

    const { token, jwks } = await mintTestIdToken({
      issuer,
      clientId,
      key,
      claims: { sub: 'user-42', email: 'jane@test.dev', roles: ['ADMIN'] },
    });

    const served = await serveJwks(jwks);
    try {
      const factory = resolvers.jwt({ jwksUri: served.jwksUri });
      const resolver = await factory.resolver({
        issuer,
        clientId,
        sessionKey: 'authkit',
        globalRolesClaim: 'roles',
      });

      const identity = await (resolver as unknown as TokenResolver).resolveToken(token);
      assert.isNotNull(identity);
      assert.equal(identity!.userId, 'user-42');
      assert.equal(identity!.email, 'jane@test.dev');
      assert.deepEqual(identity!.globalRoles, ['ADMIN']);
    } finally {
      await served.close();
    }
  });

  test('um token assinado por outra chave NÃO valida', async ({ assert }) => {
    const issuer = 'https://idp.test';
    const clientId = 'app-1';

    // emite com uma chave, mas serve o JWKS de OUTRA chave
    const { token } = await mintTestIdToken({ issuer, clientId });
    const other = await mintTestIdToken({ issuer, clientId });

    const served = await serveJwks(other.jwks);
    try {
      const factory = resolvers.jwt({ jwksUri: served.jwksUri });
      const resolver = await factory.resolver({
        issuer,
        clientId,
        sessionKey: 'authkit',
        globalRolesClaim: 'roles',
      });
      const identity = await (resolver as unknown as TokenResolver).resolveToken(token);
      assert.isNull(identity);
    } finally {
      await served.close();
    }
  });
});
