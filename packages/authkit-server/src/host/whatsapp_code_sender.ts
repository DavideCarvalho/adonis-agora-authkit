import type { HttpContext } from '@adonisjs/core/http';

/** Provider-neutral delivery input. Only the host generates and verifies the OTP. */
export interface WhatsappCodeInput {
  phone: string;
  code: string;
  locale: string;
  expiresInSeconds: number;
  /** Optional host-localized copy for transports that send free-form messages. */
  text?: string;
}

/** Implement this interface to support any WhatsApp provider. Reject on failed delivery. */
export interface WhatsappCodeSender {
  sendCode(input: WhatsappCodeInput): Promise<void>;
}

/** A configured instance, or an injectable class resolved by the request container. */
export type WhatsappCodeSenderConstructor = new (...args: never[]) => WhatsappCodeSender;

export type WhatsappCodeSenderBinding = WhatsappCodeSender | WhatsappCodeSenderConstructor;

export async function resolveWhatsappCodeSender(
  resolver: Pick<HttpContext['containerResolver'], 'make'>,
  binding: WhatsappCodeSenderBinding,
): Promise<WhatsappCodeSender> {
  const sender = typeof binding === 'function' ? await resolver.make(binding) : binding;
  if (!sender || typeof sender.sendCode !== 'function') {
    throw new Error('Invalid WhatsApp code sender: expected sendCode(input)');
  }
  return sender;
}

export {
  MetaWhatsappCodeSender,
  type MetaWhatsappCodeSenderOptions,
} from './whatsapp_senders/meta_whatsapp_code_sender.js';
export {
  WhatsmiauCodeSender,
  type WhatsmiauCodeSenderOptions,
} from './whatsapp_senders/whatsmiau_code_sender.js';
