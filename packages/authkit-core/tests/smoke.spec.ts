import { test } from '@japa/runner';
import { AUTHKIT_METRICS, InMemorySnapshot, NoopRecorder } from '../index.js';

test.group('authkit-core public entry', () => {
  test('exporta AUTHKIT_METRICS com os nomes canônicos', ({ assert }) => {
    assert.isObject(AUTHKIT_METRICS);
    assert.equal(AUTHKIT_METRICS.loginSuccess, 'authkit.login.success');
    assert.equal(AUTHKIT_METRICS.tokenIssued, 'authkit.token.issued');
  });

  test('InMemorySnapshot agrega counters e histograms', ({ assert }) => {
    const snapshot = new InMemorySnapshot();
    snapshot.bump(AUTHKIT_METRICS.loginSuccess);
    snapshot.bump(AUTHKIT_METRICS.loginSuccess);
    snapshot.observe(AUTHKIT_METRICS.resolveDuration, 12);

    const read = snapshot.read();
    assert.equal(read.counters[AUTHKIT_METRICS.loginSuccess], 2);
    assert.equal(read.histograms[AUTHKIT_METRICS.resolveDuration].count, 1);
    assert.equal(read.histograms[AUTHKIT_METRICS.resolveDuration].sum, 12);
  });

  test('NoopRecorder nunca lança e devolve snapshot vazio', ({ assert }) => {
    const recorder = new NoopRecorder();
    recorder.increment(AUTHKIT_METRICS.loginFailure);
    recorder.record(AUTHKIT_METRICS.resolveDuration, 5);

    const snapshot = recorder.snapshot();
    assert.deepEqual(snapshot.counters, {});
    assert.deepEqual(snapshot.histograms, {});
  });
});
