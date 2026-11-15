import { type Keyring, open, type SealedStatus, seal, sealedStatus } from '../crypto-kit/index.js';
import type { PersistedKeystore } from './keystore.js';

/** Subconjunto do serviço de encryption do AdonisJS (APP_KEY). */
export interface EncryptionLike {
  encrypt(value: string): string;
  decrypt<T = string>(value: string): T | null;
}

/**
 * Envelope versionado persistido no cofre. `enc`: `none` (JSON em claro), `agora` (selado com o
 * crypto kit) ou `aes` (versões anteriores: a encryption do app, ainda lida).
 */
interface Envelope {
  v: 2;
  enc: 'none' | 'aes' | 'agora';
  data: string;
}

/**
 * Serializa/desserializa o keystore com envelope versionado. `encrypt: true` sela com o
 * `keyring` (crypto kit, propósito `authkit:keystore`). `decode` aceita `none`, `agora` e o
 * `aes` de versões anteriores (aberto pelo leitor legado do keyring). Falha → THROW (nunca
 * regenerar).
 */
export class KeystoreCodec {
  constructor(private opts: { encrypt: boolean; keyring?: Keyring | undefined }) {}

  async encode(store: PersistedKeystore): Promise<string> {
    const json = JSON.stringify(store);
    if (this.opts.encrypt) {
      if (!this.opts.keyring) {
        throw new Error(
          'AuthKit keystore: encryption pedida mas serviço de encryption indisponível.',
        );
      }
      const env: Envelope = { v: 2, enc: 'agora', data: await seal(this.opts.keyring, json) };
      return JSON.stringify(env);
    }
    const env: Envelope = { v: 2, enc: 'none', data: json };
    return JSON.stringify(env);
  }

  #envelope(blob: string): Envelope {
    const parsed = JSON.parse(blob);
    if (
      parsed?.v === 2 &&
      typeof parsed.data === 'string' &&
      ['none', 'aes', 'agora'].includes(parsed.enc)
    ) {
      return parsed as Envelope;
    }
    throw new Error('AuthKit keystore: formato de blob irreconhecível.');
  }

  async decode(blob: string): Promise<PersistedKeystore> {
    const env = this.#envelope(blob);
    if (env.enc === 'none') return JSON.parse(env.data);
    if (!this.opts.keyring) {
      throw new Error('AuthKit keystore: blob encriptado mas serviço de encryption indisponível.');
    }
    let json: string;
    try {
      json = await open(this.opts.keyring, env.data);
    } catch {
      throw new Error(
        'AuthKit keystore: decrypt falhou — APP_KEY mudou? Restaure a APP_KEY anterior ' +
          'ou regenere com `authkit:key rotate`.',
      );
    }
    return JSON.parse(json);
  }

  /** Como o blob está selado (sem devolver o conteúdo); `plain` quando não é encriptado. */
  async status(blob: string): Promise<SealedStatus | 'plain'> {
    const env = this.#envelope(blob);
    if (env.enc === 'none') return 'plain';
    if (!this.opts.keyring) return 'unreadable';
    return sealedStatus(this.opts.keyring, env.data);
  }

  /** O blob selado de novo com a chave atual, ou `null` quando já está (sem `force`). */
  async reseal(blob: string, force = false): Promise<string | null> {
    const status = await this.status(blob);
    if (status === 'plain' || status === 'unreadable') return null;
    if (status === 'active' && !force) return null;
    return this.encode(await this.decode(blob));
  }
}
