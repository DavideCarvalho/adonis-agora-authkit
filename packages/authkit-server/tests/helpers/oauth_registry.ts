/**
 * The OAuth resource registry is a process-wide slot (`Symbol.for('@adonis-agora/oauth:resources')`)
 * shared by every spec file. Groups that depend on what is registered start each test with an
 * empty registry and give the previous one back at the end.
 */
const REGISTRY = Symbol.for('@adonis-agora/oauth:resources');

export function isolatedOAuthRegistry(group: {
  setup: (fn: () => () => void) => void;
  each: { setup: (fn: () => void) => void };
}) {
  group.setup(() => {
    const saved = (globalThis as Record<symbol, unknown>)[REGISTRY];
    return () => {
      (globalThis as Record<symbol, unknown>)[REGISTRY] = saved;
    };
  });
  group.each.setup(() => {
    (globalThis as Record<symbol, unknown>)[REGISTRY] = [];
  });
}
