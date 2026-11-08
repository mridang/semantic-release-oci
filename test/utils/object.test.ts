import { describe, expect, it } from '@jest/globals';
import { isRecord, numberAt, stringAt } from '../../src/utils/object.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it.each([null, undefined, [], [1], 'x', 1, true])('rejects %s', (value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe('stringAt', () => {
  const record = { s: 'x', n: 0, other: null };

  it('reads a string property', () => {
    expect(stringAt(record, 's')).toBe('x');
  });

  it('gives undefined for a missing property or the wrong type', () => {
    expect(stringAt(record, 'n')).toBeUndefined();
    expect(stringAt(record, 'other')).toBeUndefined();
    expect(stringAt(record, 'missing')).toBeUndefined();
  });
});

describe('numberAt', () => {
  it('reads a number property', () => {
    expect(numberAt({ n: 0 }, 'n')).toBe(0);
  });

  it('gives undefined for a missing property or the wrong type', () => {
    expect(numberAt({ n: '1', z: null }, 'n')).toBeUndefined();
    expect(numberAt({ z: null }, 'z')).toBeUndefined();
    expect(numberAt({}, 'n')).toBeUndefined();
  });
});
