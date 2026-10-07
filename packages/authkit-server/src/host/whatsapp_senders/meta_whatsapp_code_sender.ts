import type { WhatsappCodeInput, WhatsappCodeSender } from '../whatsapp_code_sender.js';
import { postJson, recipientPhone, requireString } from './http.js';

export interface MetaWhatsappCodeSenderOptions {
  accessToken: string;
  phoneNumberId: string;
  /** Explicit supported Graph API version, for example v23.0. */
  apiVersion: string;
  /** An approved authentication template with an OTP URL button. */
  templateName: string;
  /** Overrides the host locale when the template uses a different language. */
  languageCode?: string;
}

const LANGUAGE_CODES: Record<string, string> = { 'pt-BR': 'pt_BR', en: 'en_US', es: 'es' };

/** Meta Cloud API authentication template transport (copy-code / OTP URL button). */
export class MetaWhatsappCodeSender implements WhatsappCodeSender {
  private readonly accessToken: string;
  private readonly endpoint: URL;
  private readonly templateName: string;
  private readonly languageCode?: string;

  constructor(options: MetaWhatsappCodeSenderOptions) {
    requireString(options.accessToken, 'accessToken');
    if (typeof options.apiVersion !== 'string' || !/^v\d+\.\d+$/.test(options.apiVersion)) {
      throw new Error('Invalid WhatsApp sender apiVersion');
    }
    if (typeof options.phoneNumberId !== 'string' || !/^\d+$/.test(options.phoneNumberId)) {
      throw new Error('Invalid WhatsApp sender phoneNumberId');
    }
    if (typeof options.templateName !== 'string' || !/^[a-z0-9_]+$/.test(options.templateName)) {
      throw new Error('Invalid WhatsApp sender templateName');
    }
    if (options.languageCode !== undefined) {
      requireString(options.languageCode, 'languageCode');
    }
    this.endpoint = new URL(
      `https://graph.facebook.com/${options.apiVersion}/${options.phoneNumberId}/messages`,
    );
    this.accessToken = options.accessToken;
    this.templateName = options.templateName;
    this.languageCode = options.languageCode;
  }

  async sendCode(input: WhatsappCodeInput): Promise<void> {
    await postJson(
      'Meta',
      this.endpoint,
      { Authorization: `Bearer ${this.accessToken}` },
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhone(input.phone),
        type: 'template',
        template: {
          name: this.templateName,
          language: {
            code:
              this.languageCode ?? LANGUAGE_CODES[input.locale] ?? input.locale.replace(/-/g, '_'),
          },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: input.code }] },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: input.code }],
            },
          ],
        },
      },
    );
  }
}
