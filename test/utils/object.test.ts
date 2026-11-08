import { describe, expect, it } from '@jest/globals';
import {
  booleanAt,
  isRecord,
  numberAt,
  stringAt,
} from '../../src/utils/object.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it.each([null, undefined, [], [1], 'x', 1, true])('rejects %s', (value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe('stringAt, booleanAt and numberAt', () => {
  const record = { s: 'x', b: false, n: 0, other: null };

  it('read a property of the right type', () => {
    expect(stringAt(record, 's')).toBe('x');
    expect(booleanAt(record, 'b')).toBe(false);
    expect(numberAt(record, 'n')).toBe(0);
  });

  it('give undefined for a missing property or the wrong type', () => {
    expect(stringAt(record, 'n')).toBeUndefined();
    expect(booleanAt(record, 's')).toBeUndefined();
    expect(numberAt(record, 'other')).toBeUndefined();
    expect(stringAt(record, 'missing')).toBeUndefined();
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'ignore the inherited member %s',
    (key) => {
      expect(stringAt({}, key)).toBeUndefined();
      expect(booleanAt({}, key)).toBeUndefined();
      expect(numberAt({}, key)).toBeUndefined();
    },
  );

  it('read an own property that shadows an inherited one', () => {
    expect(stringAt({ constructor: 'own' }, 'constructor')).toBe('own');
  });
});
