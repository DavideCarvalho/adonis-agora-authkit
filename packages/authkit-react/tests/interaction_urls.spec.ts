/**
 * Testes dos builders de URL de interaction (tier 3) e dos exports dos componentes
 * de formulário (InteractionForm, MagicLinkButton, OAuthButton). Os builders têm
 * cobertura comportamental (prove-by-mutation); os componentes usam createElement
 * e não rodam em Node, então valem export/shape (como os demais specs React).
 */

import { test } from '@japa/runner';
import { InteractionForm, type InteractionFormProps } from '../src/components/interaction_form.js';
import { MagicLinkButton, type MagicLinkButtonProps } from '../src/components/magic_link_button.js';
import { OAuthButton } from '../src/components/oauth_button.js';
import {
  type InteractionPostStep,
  OTP_CODE_FIELD,
  interactionUrls,
  oauthRedirectUrl,
} from '../src/interaction/urls.js';
import { buttonClass } from '../src/utils.js';

test.group('interactionUrls (tier 3)', () => {
  test('builds every endpoint under the default base path', ({ assert }) => {
    const u = interactionUrls('abc');
    assert.equal(u.identifier, '/auth/interaction/abc/identifier');
    assert.equal(u.login, '/auth/interaction/abc/login');
    assert.equal(u.magic, '/auth/interaction/abc/magic');
    assert.equal(u.signup, '/auth/interaction/abc/signup');
    assert.equal(u.switch, '/auth/interaction/abc/switch');
    assert.equal(u.passkeyOptions, '/auth/interaction/abc/passkey/options');
    assert.equal(u.passkeyVerify, '/auth/interaction/abc/passkey/verify');
    assert.equal(u.otpVerify, '/auth/interaction/abc/otp-verify');
  });

  test('otpVerify follows the uid and custom base path', ({ assert }) => {
    assert.equal(interactionUrls('uid-9').otpVerify, '/auth/interaction/uid-9/otp-verify');
    assert.equal(interactionUrls('abc', '/session/flow').otpVerify, '/session/flow/abc/otp-verify');
  });

  test('OTP_CODE_FIELD is the field the server reads (code)', ({ assert }) => {
    // Pino do contrato com o `otpVerify` do authkit-server
    // (`ctx.request.input('code')`): mudou aqui, tem que mudar lá — e vice-versa.
    assert.equal(OTP_CODE_FIELD, 'code');
  });

  test('honors a custom base path', ({ assert }) => {
    const u = interactionUrls('xyz', '/session/flow');
    assert.equal(u.magic, '/session/flow/xyz/magic');
    assert.equal(u.passkeyOptions, '/session/flow/xyz/passkey/options');
  });

  test('the uid is interpolated into the path', ({ assert }) => {
    assert.equal(interactionUrls('uid-1').login, '/auth/interaction/uid-1/login');
    assert.equal(interactionUrls('uid-2').login, '/auth/interaction/uid-2/login');
  });
});

test.group('oauthRedirectUrl (tier 3)', () => {
  test('builds the provider redirect URL', ({ assert }) => {
    assert.equal(oauthRedirectUrl('google', 'abc'), '/auth/google/redirect/abc');
    assert.equal(oauthRedirectUrl('github', 'abc'), '/auth/github/redirect/abc');
  });

  test('honors a custom base path', ({ assert }) => {
    assert.equal(oauthRedirectUrl('google', 'abc', '/sso'), '/sso/google/redirect/abc');
  });
});

test.group('buttonClass helper', () => {
  test('composes base + variant + extra, dropping empties', ({ assert }) => {
    assert.equal(
      buttonClass('authkit-button--ghost', 'x'),
      'authkit-button authkit-button--ghost x',
    );
    assert.equal(buttonClass('authkit-button--primary'), 'authkit-button authkit-button--primary');
    assert.equal(buttonClass(), 'authkit-button');
    assert.equal(buttonClass(null, 'only-extra'), 'authkit-button only-extra');
  });
});

test.group('InteractionForm / MagicLinkButton / OAuthButton — exports e types', () => {
  test('components are exported as functions', ({ assert }) => {
    assert.isFunction(InteractionForm);
    assert.isFunction(MagicLinkButton);
    assert.isFunction(OAuthButton);
  });

  test('InteractionFormProps.step is a POST interaction step', ({ assert }) => {
    const step: InteractionPostStep = 'magic';
    const props: InteractionFormProps = { uid: 'u', step, csrfToken: 't' };
    assert.equal(props.step, 'magic');
    assert.equal(props.uid, 'u');
    assert.equal(props.csrfToken, 't');
  });

  test('InteractionPostStep accepts otpVerify (form POST step)', ({ assert }) => {
    const step: InteractionPostStep = 'otpVerify';
    const props: InteractionFormProps = { uid: 'u', step, csrfToken: 't' };
    assert.equal(props.step, 'otpVerify');
  });

  test('MagicLinkButtonProps accepts the choose-first channel', ({ assert }) => {
    const props: MagicLinkButtonProps = {
      uid: 'u',
      csrfToken: 't',
      channel: 'code',
      pendingChildren: 'Enviando…',
    };
    assert.equal(props.channel, 'code');
  });
});
