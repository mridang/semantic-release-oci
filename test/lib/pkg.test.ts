import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parsePkgName, readPkg, buildImageRepo } from '../../src/lib/pkg.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-release-oci-'));
}

describe('parsePkgName', () => {
  it('should split a scoped package name into scope and name', () => {
    expect(parsePkgName('@myorg/my-app')).toEqual({
      scope: 'myorg',
      name: 'my-app',
    });
  });

  it('should return a null scope for an unscoped name', () => {
    expect(parsePkgName('my-app')).toEqual({ scope: null, name: 'my-app' });
  });

  it('should return null fields for an empty name', () => {
    expect(parsePkgName('')).toEqual({ scope: null, name: null });
  });
});

describe('readPkg', () => {
  it('should read and parse package.json from the directory', () => {
    const tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-app' }),
    );

    expect(readPkg(tmpDir)).toEqual({ name: 'my-app' });

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('should return null when package.json is absent', () => {
    const tmpDir = makeTempDir();

    expect(readPkg(tmpDir)).toBeNull();

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('should return null when package.json is malformed', () => {
    const tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ not valid json');

    expect(readPkg(tmpDir)).toBeNull();

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('buildImageRepo', () => {
  it('should join registry, project, and name', () => {
    expect(buildImageRepo('ghcr.io', 'myorg', 'my-app')).toBe(
      'ghcr.io/myorg/my-app',
    );
  });

  it('should skip undefined segments', () => {
    expect(buildImageRepo(undefined, undefined, 'my-app')).toBe('my-app');
  });

  it('should skip an undefined project but keep the registry', () => {
    expect(buildImageRepo('ghcr.io', undefined, 'my-app')).toBe(
      'ghcr.io/my-app',
    );
  });
});
