import { AUTHKIT_METRICS, type AuthkitMetricName } from './metrics.js';

/** Recorder de métricas: counters e histograms nomeados. */
export interface MetricsRecorder {
  increment(name: AuthkitMetricName, attributes?: Record<string, string | number>): void;
  record(
    name: AuthkitMetricName,
    value: number,
    attributes?: Record<string, string | number>,
  ): void;
  /** snapshot agregado em memória (para rota JSON / dashboard) */
  snapshot(): MetricsSnapshot;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; min: number; max: number }>;
  updatedAt: number;
}

/** Agregador em memória reaproveitável por qualquer recorder. */
export class InMemorySnapshot {
  #counters: Record<string, number> = {};
  #histograms: Record<string, { count: number; sum: number; min: number; max: number }> = {};
  #updatedAt = 0;

  bump(name: string, by = 1) {
    this.#counters[name] = (this.#counters[name] ?? 0) + by;
    this.#updatedAt = Date.now();
  }

  observe(name: string, value: number) {
    const h = this.#histograms[name] ?? { count: 0, sum: 0, min: value, max: value };
    h.count += 1;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
    this.#histograms[name] = h;
    this.#updatedAt = Date.now();
  }

  read(): MetricsSnapshot {
    return {
      counters: { ...this.#counters },
      histograms: { ...this.#histograms },
      updatedAt: this.#updatedAt,
    };
  }
}

/** No-op: usado quando observability está desligada. */
export class NoopRecorder implements MetricsRecorder {
  increment(): void {}
  record(): void {}
  snapshot(): MetricsSnapshot {
    return { counters: {}, histograms: {}, updatedAt: 0 };
  }
}

export type { AuthkitMetricName };
export { AUTHKIT_METRICS };
