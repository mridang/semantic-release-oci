import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseBakeDigest } from '../src/lib/bake-strategy.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-release-oci-'));
}

describe('parseBakeDigest', () => {
  it('should return the named target digest without the sha256 prefix', () => {
    const tmpDir = makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        image: { 'containerimage.digest': 'sha256:abc123' },
        binaries: {},
      }),
    );

    expect(parseBakeDigest(file, 'image')).toBe('abc123');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('should fall back to the first target with a digest for wildcard', () => {
    const tmpDir = makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        binaries: {},
        image: { 'containerimage.digest': 'sha256:def456' },
      }),
    );

    expect(parseBakeDigest(file, '*')).toBe('def456');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('should return empty string when the metadata file is missing', () => {
    expect(parseBakeDigest('/nonexistent/meta.json', '*')).toBe('');
  });

  it('should return empty string on malformed metadata', () => {
    const tmpDir = makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    fs.writeFileSync(file, 'not json');

    expect(parseBakeDigest(file, '*')).toBe('');

    fs.rmSync(tmpDir, { recursive: true });
  });
});
