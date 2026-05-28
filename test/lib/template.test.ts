import { describe, it, expect } from '@jest/globals';
import { renderTemplate } from '../../src/lib/template.js';

describe('renderTemplate', () => {
  it('should replace simple variables', () => {
    expect(renderTemplate('{{version}}', { version: '1.2.3' })).toBe('1.2.3');
  });

  it('should replace multiple variables', () => {
    expect(
      renderTemplate('{{major}}.{{minor}}', { major: '1', minor: '2' }),
    ).toBe('1.2');
  });

  it('should replace unknown variables with empty string', () => {
    expect(renderTemplate('{{unknown}}', {})).toBe('');
  });

  it('should pass through strings without templates', () => {
    expect(renderTemplate('latest', {})).toBe('latest');
  });

  it('should render numeric values as strings', () => {
    expect(renderTemplate('v{{major}}', { major: 1 })).toBe('v1');
  });
});
