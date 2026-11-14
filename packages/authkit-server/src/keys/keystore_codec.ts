import type { PersistedKeystore } from './keystore.js';

/** Subconjunto do serviço de encryption do AdonisJS (APP_KEY). */
export interface EncryptionLike {
  encrypt(value: string): string;
  decrypt<T = string>(value: string): T | null;
}

/** Envelope versionado persistido no cofre. */
interface Envelope {
  v: 2;
  enc: 'none' | 'aes';
  data: string;
}

/**
 * Serializa/desserializa o keystore com envelope versionado. `encrypt: true`
 * exige um `enc` (EncryptionLike). `decode` aceita: `enc:'none'` e `enc:'aes'`.
 * Decrypt falho → THROW (decisão: nunca regenerar).
 */
export class KeystoreCodec {
  constructor(private opts: { encrypt: boolean; enc?: EncryptionLike }) {}

  async encode(store: PersistedKeystore): Promise<string> {
    const json = JSON.stringify(store);
    if (this.opts.encrypt) {
      if (!this.opts.enc) {
        throw new Error(
          'AuthKit keystore: encryption pedida mas serviço de encryption indisponível.',
        );
      }
      const env: Envelope = { v: 2, enc: 'aes', data: this.opts.enc.encrypt(json) };
      return JSON.stringify(env);
    }
    const env: Envelope = { v: 2, enc: 'none', data: json };
    return JSON.stringify(env);
  }

  async decode(blob: string): Promise<PersistedKeystore> {
    const parsed = JSON.parse(blob);
    if (parsed?.v === 2 && typeof parsed.data === 'string') {
      if (parsed.enc === 'none') return JSON.parse(parsed.data);
      if (parsed.enc === 'aes') {
        if (!this.opts.enc) {
          throw new Error(
            'AuthKit keystore: blob encriptado mas serviço de encryption indisponível.',
          );
        }
        const json = this.opts.enc.decrypt<string>(parsed.data);
        if (json == null) {
          throw new Error(
            'AuthKit keystore: decrypt falhou — APP_KEY mudou? Restaure a APP_KEY anterior ' +
              'ou regenere com `authkit:key rotate`.',
          );
        }
        return JSON.parse(json);
      }
    }
    throw new Error('AuthKit keystore: formato de blob irreconhecível.');
  }
}
