import { test } from '@japa/runner';
import { pickModelAdapterClass } from '../src/adapters/factory.js';

/**
 * Split de adapters por modelo (`session.adapter`): modelos de vida curta
 * (sessão e o que orbita ela) vão pro adapter da sessão; o resto (Client em
 * particular — sem ele nem a tela de login abre) fica no adapter default.
 *
 * `pickModelAdapterClass` é pura (sem boot de app): recebe as duas classes
 * resolvidas e devolve a certa pro nome do modelo.
 */
class DefaultAdapter {
  constructor(public readonly model: string) {}
}
class SessionAdapter {
  constructor(public readonly model: string) {}
}

test.group('session adapter split — pickModelAdapterClass', () => {
  test('Session vai pro adapter da sessão', ({ assert }) => {
    assert.equal(
      pickModelAdapterClass('Session', DefaultAdapter as any, SessionAdapter as any),
      SessionAdapter,
    );
  });

  test('órbita da sessão (Grant, tokens, codes, Interaction) vai pro adapter da sessão', ({
    assert,
  }) => {
    for (const model of [
      'Grant',
      'AccessToken',
      'RefreshToken',
      'AuthorizationCode',
      'Interaction',
      'DeviceCode',
      'PushedAuthorizationRequest',
      'BackchannelAuthenticationRequest',
    ]) {
      assert.equal(
        pickModelAdapterClass(model, DefaultAdapter as any, SessionAdapter as any),
        SessionAdapter,
        `${model} deveria ir pro adapter da sessão`,
      );
    }
  });

  test('Client e o resto ficam no adapter default', ({ assert }) => {
    for (const model of ['Client', 'InitialAccessToken', 'RegistrationAccessToken']) {
      assert.equal(
        pickModelAdapterClass(model, DefaultAdapter as any, SessionAdapter as any),
        DefaultAdapter,
        `${model} deveria ficar no adapter default`,
      );
    }
  });

  test('sem session.adapter configurado tudo usa o default (back-compat)', ({ assert }) => {
    for (const model of ['Session', 'Client', 'Grant', 'AccessToken']) {
      assert.equal(
        pickModelAdapterClass(model, DefaultAdapter as any, DefaultAdapter as any),
        DefaultAdapter,
      );
    }
  });
});
