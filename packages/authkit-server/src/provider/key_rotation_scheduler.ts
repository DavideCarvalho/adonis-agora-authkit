/**
 * Housekeeping da lib: rotação de chave JWKS age-based. A cada intervalo, se a
 * setting `key_rotation` está enabled e a chave corrente passou de `maxAgeDays`,
 * adquire um lock single-flight (só UMA instância rotaciona) e chama `rotateKeys`,
 * que aplica ao vivo. Re-checa a idade DENTRO do lock para não rotacionar duas
 * vezes quando outra instância acabou de rotacionar. Fail-safe; `unref` no timer.
 * Toda a lógica é pura+injetada (testável sem app).
 */
export interface KeyRotationSchedulerOptions {
  policy: () => Promise<{ enabled: boolean; maxAgeDays: number; keep: number }>;
  ageDays: () => Promise<number | null>;
  rotateKeys: (keep: number) => Promise<void>;
  withLock: (fn: () => Promise<void>) => Promise<void>;
  intervalMs: number;
  onError?: (err: unknown) => void;
}

export class KeyRotationScheduler {
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(private opts: KeyRotationSchedulerOptions) {}

  async tick(): Promise<void> {
    try {
      const policy = await this.opts.policy();
      if (!policy.enabled) return;
      const age = await this.opts.ageDays();
      if (age === null || age < policy.maxAgeDays) return;
      await this.opts.withLock(async () => {
        // re-check dentro do lock: outra instância pode ter rotacionado.
        const age2 = await this.opts.ageDays();
        if (age2 === null || age2 < policy.maxAgeDays) return;
        await this.opts.rotateKeys(policy.keep);
      });
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    if (typeof (this.#timer as any).unref === 'function') (this.#timer as any).unref();
  }
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}

/**
 * O agendador roda nesta instância? Só com keystore gerenciável (managed + store) e nunca com
 * `jwks.readOnly` — lá quem rotaciona é a instância que escreve o keystore; esta só recarrega
 * pelo poll.
 */
export async function keyRotationSchedulerApplies(
  svc: {
    rotateKeys?: unknown;
    keystoreAgeDays?: () => Promise<number | null>;
    keystoreReadOnly?: boolean;
  } | null,
): Promise<boolean> {
  if (!svc || typeof svc.rotateKeys !== 'function' || typeof svc.keystoreAgeDays !== 'function') {
    return false;
  }
  if (svc.keystoreReadOnly === true) return false;
  return (await svc.keystoreAgeDays().catch(() => null)) !== null;
}
