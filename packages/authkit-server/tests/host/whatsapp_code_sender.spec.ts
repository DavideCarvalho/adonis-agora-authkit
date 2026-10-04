import 'reflect-metadata';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Container, inject } from '@adonisjs/core/container';
import { test } from '@japa/runner';
import {
  resolveWhatsappCodeSender,
  type WhatsappCodeInput,
  type WhatsappCodeSender,
} from '../../src/host/whatsapp_code_sender.js';
import { MetaWhatsappCodeSender } from '../../src/host/whatsapp_senders/meta_whatsapp_code_sender.js';
import { WhatsmiauCodeSender } from '../../src/host/whatsapp_senders/whatsmiau_code_sender.js';

const input: WhatsappCodeInput = {
  phone: '+5511999998888',
  code: '123456',
  locale: 'pt-BR',
  expiresInSeconds: 300,
};
const metaOptions = {
  accessToken: 'secret-access-token',
  phoneNumberId: '123456789',
  apiVersion: 'v23.0',
  templateName: 'login_code',
};

test.group('WhatsApp code senders', (group) => {
  const originalFetch = globalThis.fetch;
  group.each.teardown(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns provider instances without resolving or replacing them', async ({ assert }) => {
    const sender: WhatsappCodeSender = { async sendCode() {} };
    const container = new Container();
    assert.strictEqual(await resolveWhatsappCodeSender(container.createResolver(), sender), sender);
  });

  test('constructs provider classes with dependencies through the Adonis container', async ({
    assert,
  }) => {
    const received: WhatsappCodeInput[] = [];
    class Delivery {
      async send(value: WhatsappCodeInput) {
        received.push(value);
      }
    }
    class Sender implements WhatsappCodeSender {
      constructor(private delivery: Delivery) {}
      async sendCode(value: WhatsappCodeInput) {
        await this.delivery.send(value);
      }
    }
    Reflect.defineMetadata('design:paramtypes', [Delivery], Sender);
    inject()(Sender);
    const sender = await resolveWhatsappCodeSender(new Container().createResolver(), Sender);
    await sender.sendCode(input);
    assert.deepEqual(received, [input]);
  });

  test('rejects malformed bindings with a configuration error', async ({ assert }) => {
    const invalid = {} as WhatsappCodeSender;
    await assert.rejects(
      () => resolveWhatsappCodeSender(new Container().createResolver(), invalid),
      /sendCode/,
    );
  });

  test('sends Whatsmiau text using the Cloud v2 endpoint and API key', async ({ assert }) => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://api.whatsmiau.dev/v2/message/sendText/Marketing01');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('apikey'), 'secret-key');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        number: '5511999998888',
        text: 'Your code is 123456',
      });
      assert.equal(init?.redirect, 'error');
      assert.instanceOf(init?.signal, AbortSignal);
      return new Response('{}', { status: 201 });
    };
    await new WhatsmiauCodeSender({ apiKey: 'secret-key', instanceName: 'Marketing01' }).sendCode({
      ...input,
      text: 'Your code is 123456',
    });
    assert.equal(calls, 1);
  });

  test('allows custom HTTP base URLs and falls back to the raw code', async ({ assert }) => {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:9090/v2/message/sendText/local');
      assert.deepEqual(JSON.parse(String(init?.body)), { number: '5511999998888', text: '123456' });
      return new Response(null, { status: 204 });
    };
    await new WhatsmiauCodeSender({
      apiKey: 'key',
      instanceName: 'local',
      baseUrl: 'http://127.0.0.1:9090/v2/',
    }).sendCode(input);
  });

  test('delivers to an HTTP fixture and refuses credential forwarding through redirects', async ({
    assert,
    cleanup,
  }) => {
    const requests: Array<{ url?: string; key?: string; body: string }> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      requests.push({ url: request.url, key: String(request.headers.apikey), body });
      if (request.url?.includes('/redirect')) {
        response.writeHead(302, { Location: '/stolen' });
        response.end();
      } else {
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;
    await new WhatsmiauCodeSender({
      baseUrl,
      apiKey: 'fixture-key',
      instanceName: 'local',
    }).sendCode(input);
    assert.deepEqual(requests[0], {
      url: '/v2/message/sendText/local',
      key: 'fixture-key',
      body: JSON.stringify({ number: '5511999998888', text: '123456' }),
    });
    await assert.rejects(
      () =>
        new WhatsmiauCodeSender({
          baseUrl,
          apiKey: 'fixture-key',
          instanceName: 'redirect',
        }).sendCode(input),
      /delivery failed/,
    );
    assert.lengthOf(requests, 2);
    assert.isFalse(requests.some((request) => request.url === '/stolen'));
  });

  test('sends an official Meta authentication template with body and URL button codes', async ({
    assert,
  }) => {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://graph.facebook.com/v23.0/123456789/messages');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-access-token');
      assert.equal(init?.redirect, 'error');
      assert.instanceOf(init?.signal, AbortSignal);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '5511999998888',
        type: 'template',
        template: {
          name: 'login_code',
          language: { code: 'pt_BR' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: '123456' }],
            },
          ],
        },
      });
      return new Response('{}', { status: 200 });
    };
    await new MetaWhatsappCodeSender(metaOptions).sendCode({
      ...input,
      text: 'Ignored for templates',
    });
  });

  test('maps AuthKit locales and honors an explicitly configured Meta language', async ({
    assert,
  }) => {
    const languages: string[] = [];
    globalThis.fetch = async (_url, init) => {
      languages.push(JSON.parse(String(init?.body)).template.language.code);
      return new Response('{}');
    };
    for (const locale of ['en', 'es']) {
      await new MetaWhatsappCodeSender(metaOptions).sendCode({ ...input, locale });
    }
    await new MetaWhatsappCodeSender({ ...metaOptions, languageCode: 'pt_PT' }).sendCode(input);
    assert.deepEqual(languages, ['en_US', 'es', 'pt_PT']);
  });

  test('rejects unsafe or malformed provider configuration before any delivery', ({ assert }) => {
    for (const baseUrl of [
      'file:///secret',
      'https://user:secret@host/v2',
      'https://host/v2?key=secret',
      'https://host/v2#fragment',
      'invalid',
    ]) {
      assert.throws(
        () => new WhatsmiauCodeSender({ apiKey: 'key', instanceName: 'test', baseUrl }),
        /baseUrl/,
      );
    }
    for (const instanceName of ['', '..', '../escape', 'a?key=value', 'a%2Fescape']) {
      assert.throws(() => new WhatsmiauCodeSender({ apiKey: 'key', instanceName }), /instanceName/);
    }
    assert.throws(
      () => new WhatsmiauCodeSender({ apiKey: 'key\r\nInjected: value', instanceName: 'test' }),
      /apiKey/,
    );
    for (const apiVersion of ['', 'latest', 'v23.0/../me', 'v23.0?secret=key']) {
      assert.throws(() => new MetaWhatsappCodeSender({ ...metaOptions, apiVersion }), /apiVersion/);
    }
    assert.throws(
      () => new MetaWhatsappCodeSender({ ...metaOptions, phoneNumberId: '../me' }),
      /phoneNumberId/,
    );
    assert.throws(
      () => new MetaWhatsappCodeSender({ ...metaOptions, templateName: '' }),
      /templateName/,
    );
  });

  test('rejects malformed phones before contacting either provider', async ({ assert }) => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}');
    };
    for (const sender of [
      new WhatsmiauCodeSender({ apiKey: 'key', instanceName: 'test' }),
      new MetaWhatsappCodeSender(metaOptions),
    ]) {
      for (const phone of ['', '+123 abc', '5511@s.whatsapp.net']) {
        await assert.rejects(() => sender.sendCode({ ...input, phone }), /phone/);
      }
    }
    assert.isFalse(called);
  });

  test('rejects unsuccessful delivery without exposing response bodies, credentials or codes', async ({
    assert,
  }) => {
    globalThis.fetch = async () =>
      new Response('secret-key secret-access-token 123456', { status: 401 });
    for (const sender of [
      new WhatsmiauCodeSender({ apiKey: 'secret-key', instanceName: 'test' }),
      new MetaWhatsappCodeSender(metaOptions),
    ]) {
      try {
        await sender.sendCode(input);
        assert.fail('delivery should fail');
      } catch (error) {
        assert.instanceOf(error, Error);
        assert.match(String(error), /401/);
        assert.notMatch(String(error), /secret-key|secret-access-token|123456/);
        assert.notProperty(error, 'cause');
      }
    }
  });

  test('sanitizes network, timeout and redirect failures', async ({ assert }) => {
    globalThis.fetch = async () => {
      throw new Error('secret-key secret-access-token 123456');
    };
    for (const sender of [
      new WhatsmiauCodeSender({ apiKey: 'secret-key', instanceName: 'test' }),
      new MetaWhatsappCodeSender(metaOptions),
    ]) {
      await assert.rejects(
        () => sender.sendCode(input),
        /^WhatsApp code delivery failed \((Whatsmiau|Meta)\)$/,
      );
    }
  });
});
