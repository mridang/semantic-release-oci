import { describe, expect, it } from '@jest/globals';
import { toList } from '../../src/utils/list.js';

describe('toList', () => {
  it.each([
    ['a,b', ['a', 'b']],
    ['a , b ,, c', ['a', 'b', 'c']],
    ['', []],
    [
      ['a', 'b'],
      ['a', 'b'],
    ],
  ])('turns %j into %j', (value, expected) => {
    expect(toList(value)).toEqual(expected);
  });

  it('returns a copy of a list rather than the caller array', () => {
    const input = ['a'];

    expect(toList(input)).not.toBe(input);
  });

  describe('against the pattern it replaced', () => {
    // Built from strings on purpose: this is the slow pattern the code used to hold.
    const oldPattern = new RegExp(
      [String.raw`\s*`, ',', String.raw`\s*`].join(''),
    );
    const reference = (value: string): string[] =>
      value.split(oldPattern).filter(Boolean);
    const pieces = ['a', 'bc', ',', ' ', '  ', '\t', '\n', '\u00A0', 'é'];

    it('gives the same list for any string', () => {
      let seed = 4242;
      const below = (limit: number): number => {
        seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
        return seed % limit;
      };
      for (let round = 0; round < 20_000; round++) {
        const input = Array.from(
          { length: below(12) },
          () => pieces[below(pieces.length)],
        ).join('');
        expect([input, toList(input)]).toEqual([input, reference(input)]);
      }
    });

    it('keeps the whitespace at the two ends of the string', () => {
      expect(toList(' a , b ')).toEqual([' a', 'b ']);
    });

    it('handles a very long run of whitespace in linear time', () => {
      const input = `a${' '.repeat(200_000)}x`;
      const started = performance.now();

      expect(toList(input)).toEqual([input]);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });
});
