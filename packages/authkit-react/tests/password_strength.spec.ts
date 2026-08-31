import { test } from '@japa/runner';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PasswordStrengthMeter } from '../src/components/password_strength_meter.js';
import {
  heuristicScorer,
  type PasswordScorer,
  usePasswordStrength,
} from '../src/hooks/use_password_strength.js';

test.group('heuristicScorer', () => {
  test('senha vazia → score 0', ({ assert }) => {
    assert.equal(heuristicScorer('').score, 0);
  });

  test('senha curta e simples → score baixo', ({ assert }) => {
    const r = heuristicScorer('abc');
    assert.isAtMost(r.score, 1);
  });

  test('senha longa e variada → score alto', ({ assert }) => {
    const r = heuristicScorer('Sup3rL0ng&Str0ngPass!');
    assert.isAtLeast(r.score, 4);
  });

  test('score sempre no intervalo 0..4', ({ assert }) => {
    for (const pw of ['', 'a', 'abcdefgh', 'Abcdefgh1', 'Abcdefgh1!ZZZZZZZZ']) {
      const r = heuristicScorer(pw);
      assert.isAtLeast(r.score, 0);
      assert.isAtMost(r.score, 4);
    }
  });

  test('feedback sugere classes ausentes', ({ assert }) => {
    const r = heuristicScorer('alllowercase');
    assert.isArray(r.feedback);
    assert.isTrue(r.feedback!.some((f) => /uppercase/i.test(f)));
    assert.isTrue(r.feedback!.some((f) => /number/i.test(f)));
  });
});

test.group('usePasswordStrength (via render)', () => {
  // Componente de teste que expõe o resultado do hook como texto.
  function Probe(props: { password: string; scorer?: PasswordScorer }) {
    const { score } = usePasswordStrength(props.password, { scorer: props.scorer });
    return createElement('span', null, `score=${score}`);
  }

  test('usa a heurística embutida por default', ({ assert }) => {
    const html = renderToStaticMarkup(createElement(Probe, { password: 'Sup3rL0ng&Str0ngPass!' }));
    assert.match(html, /score=4/);
  });

  test('usa o scorer customizado quando fornecido', ({ assert }) => {
    const scorer: PasswordScorer = () => ({ score: 2, feedback: ['from custom scorer'] });
    const html = renderToStaticMarkup(createElement(Probe, { password: 'anything', scorer }));
    assert.match(html, /score=2/);
  });
});

test.group('PasswordStrengthMeter', () => {
  test('renderiza a barra com role=meter e aria-valuenow', ({ assert }) => {
    const html = renderToStaticMarkup(
      createElement(PasswordStrengthMeter, { password: 'Sup3rL0ng&Str0ngPass!' }),
    );
    assert.match(html, /role="meter"/);
    assert.match(html, /aria-valuenow="4"/);
    assert.match(html, /data-score="4"/);
  });

  test('mostra o rótulo de força', ({ assert }) => {
    const html = renderToStaticMarkup(
      createElement(PasswordStrengthMeter, { password: 'Sup3rL0ng&Str0ngPass!' }),
    );
    assert.match(html, /Strong/);
  });

  test('rótulos i18n via prop labels', ({ assert }) => {
    const html = renderToStaticMarkup(
      createElement(PasswordStrengthMeter, {
        password: '',
        labels: ['Muito fraca', 'Fraca', 'Razoável', 'Boa', 'Forte'],
      }),
    );
    assert.match(html, /Muito fraca/);
  });

  test('showFeedback=false omite as dicas', ({ assert }) => {
    const withFb = renderToStaticMarkup(
      createElement(PasswordStrengthMeter, { password: 'alllowercase' }),
    );
    const withoutFb = renderToStaticMarkup(
      createElement(PasswordStrengthMeter, { password: 'alllowercase', showFeedback: false }),
    );
    assert.match(withFb, /authkit-strength__feedback/);
    assert.notMatch(withoutFb, /authkit-strength__feedback/);
  });

  test('scorer customizado afeta o medidor', ({ assert }) => {
    const scorer: PasswordScorer = () => ({ score: 1 });
    const html = renderToStaticMarkup(
      createElement(PasswordStrengthMeter, { password: 'anything', scorer }),
    );
    assert.match(html, /aria-valuenow="1"/);
  });
});
