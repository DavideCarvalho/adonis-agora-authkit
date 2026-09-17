import { createHash, createHmac } from 'node:crypto';
import { test } from '@japa/runner';
import { ACTIVE_ORG_COOKIE, readActiveOrgFromKoaCtx } from '../../src/host/active_org_cookie.js';

const APP_KEY = 'a'.repeat(32);
const ORG = { orgId: 'org-1', orgSlug: 'acme', orgRole: 'owner' };

/** Assina igual ao AdonisJS (`MessageVerifier` do @boringnode/encryption). */
function signCookie(value: string, purpose: string, appKey = APP_KEY): string {
  const payload = Buffer.from(JSON.stringify({ message: value, purpose }), 'utf8').toString(
    'base64url',
  );
  const key = createHash('sha256').update(appKey).digest();
  const hash = createHmac('sha256', key).update(payload).digest('base64url');
  return `s:${payload}.${hash}`;
}

/** Um contexto Koa mínimo — é o que o oidc-provider passa pro `loadExistingGrant`. */
function koaCtx(cookieValue: string | null) {
  return {
    cookies: {
      get: (name: string, _opts?: unknown) => (name === ACTIVE_ORG_COOKIE ? cookieValue : null),
    },
  };
}

const encoded = `${ORG.orgId}\t${ORG.orgSlug}\t${ORG.orgRole}`;

test.group('active org cookie (contexto Koa)', () => {
  test('cookie assinado pelo Adonis é verificado e devolve a org', ({ assert }) => {
    const signed = signCookie(encoded, ACTIVE_ORG_COOKIE);
    assert.deepEqual(readActiveOrgFromKoaCtx(koaCtx(signed), { appKey: APP_KEY }), ORG);
  });

  test('cookie assinado URL-encoded (a forma que o browser envia) é lido', ({ assert }) => {
    // O jar Koa NÃO URL-decoda: o valor chega como está no header, e o browser
    // reenvia o cookie exatamente como o host o escreveu (`s%3A…`).
    const signed = signCookie(encoded, ACTIVE_ORG_COOKIE);
    const asSentByBrowser = encodeURIComponent(signed);
    assert.include(asSentByBrowser, 's%3A', 'a forma do browser precisa ter o prefixo encodado');
    assert.deepEqual(readActiveOrgFromKoaCtx(koaCtx(asSentByBrowser), { appKey: APP_KEY }), ORG);
  });

  test('sem appKey um cookie assinado é recusado (não dá para verificar)', ({ assert }) => {
    const signed = signCookie(encoded, ACTIVE_ORG_COOKIE);
    assert.isNull(readActiveOrgFromKoaCtx(koaCtx(signed)));
  });

  test('assinatura adulterada é recusada', ({ assert }) => {
    const signed = signCookie(encoded, ACTIVE_ORG_COOKIE);
    const tampered = `${signed.slice(0, -4)}AAAA`;
    assert.isNull(readActiveOrgFromKoaCtx(koaCtx(tampered), { appKey: APP_KEY }));
  });

  test('payload adulterado (trocar de org) é recusado', ({ assert }) => {
    const signed = signCookie(encoded, ACTIVE_ORG_COOKIE);
    const forgedPayload = signCookie(`org-outra\tslug\ttowner`, ACTIVE_ORG_COOKIE).split('.')[0];
    const forged = `${forgedPayload}.${signed.split('.')[1]}`;
    assert.isNull(readActiveOrgFromKoaCtx(koaCtx(forged), { appKey: APP_KEY }));
  });

  test('assinado com outra chave é recusado', ({ assert }) => {
    const signed = signCookie(encoded, ACTIVE_ORG_COOKIE, 'b'.repeat(32));
    assert.isNull(readActiveOrgFromKoaCtx(koaCtx(signed), { appKey: APP_KEY }));
  });

  test('purpose diferente é recusado (cookie não pode migrar de papel)', ({ assert }) => {
    const signed = signCookie(encoded, 'outro-cookie');
    assert.isNull(readActiveOrgFromKoaCtx(koaCtx(signed), { appKey: APP_KEY }));
  });

  test('valor cru (host que não assina) continua funcionando', ({ assert }) => {
    assert.deepEqual(readActiveOrgFromKoaCtx(koaCtx(encoded), { appKey: APP_KEY }), ORG);
  });

  test('valor cru URL-encoded continua funcionando', ({ assert }) => {
    const urlEncoded = encodeURIComponent(encoded);
    assert.deepEqual(readActiveOrgFromKoaCtx(koaCtx(urlEncoded), { appKey: APP_KEY }), ORG);
  });

  test('cookie ausente devolve null', ({ assert }) => {
    assert.isNull(readActiveOrgFromKoaCtx(koaCtx(null), { appKey: APP_KEY }));
  });
});
