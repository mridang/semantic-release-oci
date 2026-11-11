import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bake, parseBakeDigest, type BakeOptions } from '../../src/lib/bake.js';
import { makeTempDir, removeTempDirs } from '../utils/tmpdir.js';
import { dockerSpy, runnerOf } from '../utils/runner.js';
import { dockerRun } from '../../src/lib/docker-run.js';

afterEach(removeTempDirs);

const METADATA = path.join(os.tmpdir(), 'meta.json');

describe('parseBakeDigest', () => {
  it('should return the named target digest without the sha256 prefix', async () => {
    const tmpDir = await makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    await fs.promises.writeFile(
      file,
      JSON.stringify({
        image: { 'containerimage.digest': 'sha256:abc123' },
        binaries: {},
      }),
    );

    expect(await parseBakeDigest(file, 'image')).toBe('abc123');
  });

  it('should fall back to the first target with a digest for wildcard', async () => {
    const tmpDir = await makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    await fs.promises.writeFile(
      file,
      JSON.stringify({
        binaries: {},
        image: { 'containerimage.digest': 'sha256:def456' },
      }),
    );

    expect(await parseBakeDigest(file, '*')).toBe('def456');
  });

  it.each([
    ['a target that is not an object', { image: 'text' }],
    ['a target without a digest', { image: { other: 'x' } }],
    [
      'a digest that is not a string',
      { image: { 'containerimage.digest': 7 } },
    ],
  ])('should return empty string for %s', async (_name, metadata) => {
    const tmpDir = await makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    await fs.promises.writeFile(file, JSON.stringify(metadata));

    expect(await parseBakeDigest(file, '*')).toBe('');
    expect(await parseBakeDigest(file, 'image')).toBe('');
  });

  it('should not treat an inherited property as the preferred target', async () => {
    const tmpDir = await makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    await fs.promises.writeFile(
      file,
      JSON.stringify({ image: { 'containerimage.digest': 'sha256:abc123' } }),
    );

    expect(await parseBakeDigest(file, 'constructor')).toBe('abc123');
  });

  it('should return empty string when the metadata file is missing', async () => {
    expect(await parseBakeDigest('/nonexistent/meta.json', '*')).toBe('');
  });

  it('should return empty string when the metadata is not an object', async () => {
    const tmpDir = await makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    await fs.promises.writeFile(file, '["sha256:abc"]');

    expect(await parseBakeDigest(file, '*')).toBe('');
  });

  it('should return empty string on malformed metadata', async () => {
    const tmpDir = await makeTempDir();
    const file = path.join(tmpDir, 'meta.json');
    await fs.promises.writeFile(file, 'not json');

    expect(await parseBakeDigest(file, '*')).toBe('');
  });
});

const spy = dockerSpy();

const BAKE: BakeOptions = {
  file: '/work/docker-bake.hcl',
  metadataFile: METADATA,
  imageTarget: 'image',
  selector: '',
  tags: [],
  dryRun: false,
  buildArgs: [],
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
  it('injects the tags, build args and selector', async () => {
    await bakeOf({
      tags: ['app:1', 'app:latest'],
      buildArgs: [{ key: 'VERSION', value: '1' }],
      selector: 'release',
    }).run();

    expect(spy.mock.calls[0][0]).toEqual([
      'buildx',
      'bake',
      '--file',
      '/work/docker-bake.hcl',
      '--metadata-file',
      METADATA,
      '--set',
      'image.tags=app:1',
      '--set',
      'image.tags=app:latest',
      '--set',
      '*.args.VERSION=1',
      'release',
    ]);
  });

  it('builds without pushing on a dry run and without a selector', async () => {
    await bakeOf({ dryRun: true, tags: ['app:1'] }).run();

    expect(spy.mock.calls[0][0]).toEqual([
      'buildx',
      'bake',
      '--file',
      '/work/docker-bake.hcl',
      '--metadata-file',
      METADATA,
      '--set',
      '*.output=type=cacheonly',
    ]);
  });

  it('returns the digest bake recorded and removes the metadata file', async () => {
    const file = path.join(await makeTempDir(), 'meta.json');
    spy.mockImplementation(async () => {
      await fs.promises.writeFile(
        file,
        JSON.stringify({ image: { 'containerimage.digest': 'sha256:abc123' } }),
      );
      return '';
    });

    const baked = await bakeOf({ metadataFile: file }).run();

    expect(baked.digest).toBe('abc123');
    await expect(fs.promises.access(file)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes the metadata file when the bake fails', async () => {
    const file = path.join(await makeTempDir(), 'meta.json');
    await fs.promises.writeFile(file, '{}');
    spy.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(bakeOf({ metadataFile: file }).run()).rejects.toThrow();
    await expect(fs.promises.access(file)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
