import { describe, expect, it } from '@jest/globals';
import { messageOf } from '../../src/utils/error.js';

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
