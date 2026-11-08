import { describe, expect, it } from '@jest/globals';
import { codeOf, messageOf } from '../../src/utils/error.js';

describe('messageOf', () => {
  it('reads the message of an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it.each([
    ['text', 'text'],
    [7, '7'],
    [undefined, 'undefined'],
  ])('stringifies the non-error %s', (value, expected) => {
    expect(messageOf(value)).toBe(expected);
  });
});

describe('codeOf', () => {
  it('reads the code of an error', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(
      'ENOENT',
    );
  });

  it.each([new Error('x'), 'ENOENT', null, { code: 5 }])(
    'gives undefined for %s',
    (value) => {
      expect(codeOf(value)).toBeUndefined();
    },
  );
});
