import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { Bake, parseBakeDigest, type BakeOptions } from '../../src/lib/bake.js';
import { makeTempDir, removeTempDirs } from '../utils/tmpdir.js';
import { dockerSpy } from '../utils/runner.js';
import { runnerOf } from '../utils/runner.js';
import { dockerRun } from '../../src/lib/docker-run.js';

afterEach(removeTempDirs);

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
  });

  it.each([
    ['a target that is not an object', { image: 'text' }],
    ['a target without a digest', { image: { other: 'x' } }],
    [
      'a digest that is not a string',
      { image: { 'containerimage.digest': 7 } },
    ],
  ])('should return empty string for %s', (_name, metadata) => {
    const tmpDir = makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    fs.writeFileSync(file, JSON.stringify(metadata));

    expect(parseBakeDigest(file, '*')).toBe('');
    expect(parseBakeDigest(file, 'image')).toBe('');
  });

  it('should not treat an inherited property as the preferred target', () => {
    const tmpDir = makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ image: { 'containerimage.digest': 'sha256:abc123' } }),
    );

    expect(parseBakeDigest(file, 'constructor')).toBe('abc123');
  });

  it('should return empty string when the metadata file is missing', () => {
    expect(parseBakeDigest('/nonexistent/meta.json', '*')).toBe('');
  });

  it('should return empty string when the metadata is not an object', () => {
    const tmpDir = makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    fs.writeFileSync(file, '["sha256:abc"]');

    expect(parseBakeDigest(file, '*')).toBe('');
  });

  it('should return empty string on malformed metadata', () => {
    const tmpDir = makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    fs.writeFileSync(file, 'not json');

    expect(parseBakeDigest(file, '*')).toBe('');
  });
});

const spy = dockerSpy();

const BAKE: BakeOptions = {
  file: '/work/docker-bake.hcl',
  metadataFile: '/tmp/meta.json',
  imageTarget: 'image',
  tags: [],
  dryRun: false,
  buildArgs: [],
  selector: 'release',
};

/**
 * A bake whose docker commands go to the spy.
 */
function bakeOf(options: Partial<BakeOptions>): Bake {
  const docker = dockerRun({
    cwd: '/work',
    env: {},
    timeoutMs: 1000,
    logger: { log: () => undefined },
    run: runnerOf(spy),
  });
  return new Bake(docker, { ...BAKE, ...options });
}

beforeEach(() => {
  spy.mockReset();
  spy.mockReturnValue('');
});

describe('Bake', () => {
  it('injects the tags, build args and selector', () => {
    bakeOf({
      tags: ['app:1', 'app:latest'],
      buildArgs: [{ key: 'VERSION', value: '1' }],
    }).run();

    expect(spy.mock.calls[0][0]).toEqual([
      'buildx',
      'bake',
      '--file',
      '/work/docker-bake.hcl',
      '--metadata-file',
      '/tmp/meta.json',
      '--set',
      'image.tags=app:1',
      '--set',
      'image.tags=app:latest',
      '--set',
      '*.args.VERSION=1',
      'release',
    ]);
  });

  it('builds without pushing on a dry run and without a selector', () => {
    bakeOf({ dryRun: true, tags: ['app:1'], selector: undefined }).run();

    expect(spy.mock.calls[0][0]).toEqual([
      'buildx',
      'bake',
      '--file',
      '/work/docker-bake.hcl',
      '--metadata-file',
      '/tmp/meta.json',
      '--set',
      '*.output=type=cacheonly',
    ]);
  });

  it('returns the digest bake recorded and removes the metadata file', () => {
    const file = path.join(makeTempDir(), 'meta.json');
    spy.mockImplementation(() => {
      fs.writeFileSync(
        file,
        JSON.stringify({ image: { 'containerimage.digest': 'sha256:abc123' } }),
      );
      return '';
    });

    const baked = bakeOf({ metadataFile: file }).run();

    expect(baked.digest).toBe('abc123');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes the metadata file when the bake fails', () => {
    const file = path.join(makeTempDir(), 'meta.json');
    fs.writeFileSync(file, '{}');
    spy.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => bakeOf({ metadataFile: file }).run()).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});
