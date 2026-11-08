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
});
