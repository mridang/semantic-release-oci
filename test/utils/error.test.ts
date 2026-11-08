import { describe, expect, it } from '@jest/globals';
import {
  codeOf,
  messageOf,
  signalOf,
  statusOf,
} from '../../src/utils/error.js';

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

  it('describes an error with an empty message by its code', () => {
    expect(
      messageOf(Object.assign(new Error(''), { code: 'ECONNREFUSED' })),
    ).toBe('ECONNREFUSED');
  });

  it('describes an error with an empty message by its first inner error', () => {
    const error = Object.assign(new Error(''), {
      errors: [new Error('inner')],
    });

    expect(messageOf(error)).toBe('inner');
  });

  it('describes an error with nothing else to say by its name', () => {
    expect(messageOf(new TypeError(''))).toBe('TypeError');
    expect(messageOf({ message: '' })).toBe('Error');
  });
});

describe('codeOf, statusOf and signalOf', () => {
  const failure = Object.assign(new Error('x'), {
    code: 'ENOENT',
    status: 2,
    signal: 'SIGTERM',
  });

  it('read the fields of a failed child process', () => {
    expect(codeOf(failure)).toBe('ENOENT');
    expect(statusOf(failure)).toBe(2);
    expect(signalOf(failure)).toBe('SIGTERM');
  });

  it.each([
    new Error('x'),
    'ENOENT',
    null,
    { code: 5, status: '1', signal: 2 },
  ])('give undefined for %s', (value) => {
    expect(codeOf(value)).toBeUndefined();
    expect(statusOf(value)).toBeUndefined();
    expect(signalOf(value)).toBeUndefined();
  });
});
