import type { Redis } from 'ioredis';
import type { EnumeratedArtifact, OidcAdapter, OidcPayload } from './adapter_contract.js';

const grantable = new Set([
  'AccessToken',
  'AuthorizationCode',
  'RefreshToken',
  'DeviceCode',
  'BackchannelAuthenticationRequest',
]);

export class RedisAdapter implements OidcAdapter {
  constructor(
    private name: string,
    private redis: Redis,
    private prefix: string,
  ) {}

  #key(id: string) {
    return `${this.prefix}:${this.name}:${id}`;
  }
  #grantKey(grantId: string) {
    return `${this.prefix}:grant:${grantId}`;
  }
  #userCodeKey(userCode: string) {
    return `${this.prefix}:userCode:${userCode}`;
  }
  #uidKey(uid: string) {
    return `${this.prefix}:uid:${uid}`;
  }

  async upsert(id: string, payload: OidcPayload, expiresIn: number): Promise<void> {
    const key = this.#key(id);
    const multi = this.redis.multi();
    multi.set(key, JSON.stringify(payload));

    if (grantable.has(this.name) && payload.grantId) {
      const gk = this.#grantKey(payload.grantId);
      multi.rpush(gk, key);
      if (expiresIn) multi.expire(gk, expiresIn);
    }
    if (payload.userCode) {
      const uck = this.#userCodeKey(payload.userCode);
      multi.set(uck, id);
      if (expiresIn) multi.expire(uck, expiresIn);
    }
    if (this.name === 'Session' && payload.uid) {
      const uk = this.#uidKey(payload.uid);
      multi.set(uk, id);
      if (expiresIn) multi.expire(uk, expiresIn);
    }
    if (expiresIn) multi.expire(key, expiresIn);
    await multi.exec();
  }

  async renewSession(id: string, expiresIn: number): Promise<boolean> {
    if (this.name !== 'Session' || !Number.isSafeInteger(expiresIn) || expiresIn < 1) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await this.redis.get(this.#key(id));
      if (!raw) return false;
      const payload = JSON.parse(raw);
      const now = Math.floor(Date.now() / 1000);
      if (payload.transient || typeof payload.exp !== 'number' || payload.exp <= now) return false;
      const updated = JSON.stringify({ ...payload, exp: now + expiresIn });
      const result = await this.redis.eval(
        `
        local raw = redis.call('GET', KEYS[1])
        if not raw then return 0 end
        if raw ~= ARGV[1] then return 2 end
        redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
        if ARGV[4] ~= '' then redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3]) end
        return 1
      `,
        2,
        this.#key(id),
        payload.uid ? this.#uidKey(payload.uid) : this.#key(id),
        raw,
        updated,
        expiresIn,
        payload.uid ? id : '',
      );
      if (result !== 2) return result === 1;
    }
    // Another request may have renewed while we were comparing the payload.
    const current = await this.find(id);
    return Boolean(
      current &&
        !current.transient &&
        typeof current.exp === 'number' &&
        current.exp > Date.now() / 1000,
    );
  }

  async find(id: string): Promise<OidcPayload | undefined> {
    const data = await this.redis.get(this.#key(id));
    if (!data) return undefined;
    return JSON.parse(data) as OidcPayload;
  }

  async findByUid(uid: string): Promise<OidcPayload | undefined> {
    const id = await this.redis.get(this.#uidKey(uid));
    if (!id) return undefined;
    return this.find(id);
  }

  async findByUserCode(userCode: string): Promise<OidcPayload | undefined> {
    const id = await this.redis.get(this.#userCodeKey(userCode));
    if (!id) return undefined;
    return this.find(id);
  }

  async consume(id: string): Promise<void> {
    const found = await this.find(id);
    if (!found) return;
    found.consumed = Math.floor(Date.now() / 1000);
    const ttl = await this.redis.ttl(this.#key(id));
    if (ttl > 0) await this.redis.set(this.#key(id), JSON.stringify(found), 'EX', ttl);
    else await this.redis.set(this.#key(id), JSON.stringify(found));
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(this.#key(id));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const gk = this.#grantKey(grantId);
    const keys = await this.redis.lrange(gk, 0, -1);
    const multi = this.redis.multi();
    for (const k of keys) multi.del(k);
    multi.del(gk);
    await multi.exec();
  }

  /**
   * Enumeração genérica dos artefatos do model deste adapter via SCAN sobre o
   * prefixo de chave do model (`<prefix>:<name>:*`). É limpo porque cada artefato
   * é uma chave única já namespaceada por `prefix` + `name`; SCAN é não-bloqueante
   * (cursor) ao contrário de KEYS. Usado pelo console admin (`Client`, `Session`,
   * `Grant`, tokens).
   */
  async list(): Promise<EnumeratedArtifact[]> {
    const prefix = `${this.prefix}:${this.name}:`;
    const result: EnumeratedArtifact[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (!data) continue;
        result.push({
          id: key.slice(prefix.length),
          payload: JSON.parse(data) as Record<string, unknown>,
        });
      }
    } while (cursor !== '0');
    result.sort((a, b) => a.id.localeCompare(b.id));
    return result;
  }
}
