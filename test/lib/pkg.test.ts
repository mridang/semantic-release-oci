import { describe, it, expect, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDirs } from '../utils/tmpdir.js';
import { parsePkgName, readPkg, buildImageRepo } from '../../src/lib/pkg.js';

afterEach(removeTempDirs);

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
  it('should read and parse package.json from the directory', async () => {
    const tmpDir = makeTempDir();
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'my-app' }),
    );

    expect(readPkg(tmpDir)).toEqual({ name: 'my-app' });
  });

  it('should return null when package.json is absent', () => {
    const tmpDir = makeTempDir();

    expect(readPkg(tmpDir)).toBeNull();
  });

  it('should return null when package.json is not an object', async () => {
    const tmpDir = makeTempDir();
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      '"just a string"',
    );

    expect(readPkg(tmpDir)).toBeNull();
  });

  it('should ignore a name that is not a string', async () => {
    const tmpDir = makeTempDir();
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      '{ "name": 7 }',
    );

    expect(readPkg(tmpDir)?.name).toBeUndefined();
  });

  it('should return null when package.json is malformed', async () => {
    const tmpDir = makeTempDir();
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      '{ not valid json',
    );

    expect(readPkg(tmpDir)).toBeNull();
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
