import type { WhatsappCodeInput, WhatsappCodeSender } from '../whatsapp_code_sender.js';
import { postJson, recipientPhone, requireString } from './http.js';

export interface WhatsmiauCodeSenderOptions {
  apiKey: string;
  instanceName: string;
  /** Includes the API version path. Defaults to Whatsmiau Cloud's /v2 endpoint. */
  baseUrl?: string;
}

/** Whatsmiau Cloud v2 / Evolution-compatible free-form text transport. */
export class WhatsmiauCodeSender implements WhatsappCodeSender {
  private readonly apiKey: string;
  private readonly endpoint: URL;

  constructor(options: WhatsmiauCodeSenderOptions) {
    requireString(options.apiKey, 'apiKey');
    if (
      typeof options.instanceName !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(options.instanceName)
    ) {
      throw new Error('Invalid WhatsApp sender instanceName');
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl ?? 'https://api.whatsmiau.dev/v2');
    } catch {
      throw new Error('Invalid WhatsApp sender baseUrl');
    }
    if (
      !['http:', 'https:'].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new Error('Invalid WhatsApp sender baseUrl');
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/message/sendText/${options.instanceName}`;
    this.endpoint = baseUrl;
    this.apiKey = options.apiKey;
  }

  async sendCode(input: WhatsappCodeInput): Promise<void> {
    await postJson(
      'Whatsmiau',
      this.endpoint,
      { apikey: this.apiKey },
      {
        number: recipientPhone(input.phone),
        text: input.text ?? input.code,
      },
    );
  }
}
