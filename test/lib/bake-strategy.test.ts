import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { BakeStrategy, parseBakeDigest } from '../../src/lib/bake-strategy.js';
import { ImageStrategy } from '../../src/lib/image-strategy.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { BuildParams } from '../../src/lib/types.js';
import type { PrepareContext, VerifyConditionsContext } from 'semantic-release';
import { makeTempDir, removeTempDirs } from '../utils/tmpdir.js';
import { stepContext } from '../utils/context.js';

function writeBakeFile(dir: string): string {
  const file = path.join(dir, 'docker-bake.hcl');
  fs.writeFileSync(file, 'group "release" {}');
  return file;
}

function makeStrategy(
  cwd: string,
  pluginConfig: OciPluginConfig = {},
  contextOverrides: Readonly<
    Partial<Record<keyof PrepareContext, unknown>>
  > = {},
): { strategy: BakeStrategy; context: VerifyConditionsContext } {
  const context = stepContext(cwd, {}, contextOverrides);
  const config = new OciConfig(
    { dockerBake: {}, ...pluginConfig },
    context.env,
  );
  const bake = config.getDockerBake();
  if (!bake) {
    throw new Error('dockerBake must be configured for the bake strategy');
  }
  return { strategy: new BakeStrategy(config, context, bake), context };
}

const baseParams: BuildParams = {
  repo: 'my-app',
  tagTemplates: ['1.2.3'],
  vars: { version: '1.2.3' },
  buildId: 'abc123def456abc1',
  isDryRun: false,
};

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

describe('BakeStrategy', () => {
  let execMock: jest.SpiedFunction<typeof ImageStrategy.prototype.exec>;

  beforeEach(() => {
    execMock = jest.spyOn(ImageStrategy.prototype, 'exec').mockReturnValue('');
  });

  afterEach(() => {
    execMock.mockRestore();
  });

  describe('verifyTarget', () => {
    it('should return a label for a valid bake file', () => {
      const tmpDir = makeTempDir();
      const file = writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      expect(strategy.verifyTarget()).toBe(`bakeFile="${file}"`);
    });

    it('should throw EINVAL when neither group nor target is set', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerBake: {} });

      expect(() => strategy.verifyTarget()).toThrow(
        expect.objectContaining({ code: 'EINVAL' }),
      );
    });

    it('should throw ENOENT when the bake file does not exist', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      expect(() => strategy.verifyTarget()).toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );
    });
  });

  describe('build', () => {
    it('should drive buildx bake with file, metadata-file, and selector', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args[0]).toBe('buildx');
      expect(args[1]).toBe('bake');
      expect(args).toContain('--file');
      expect(args).toContain('--metadata-file');
      const tagSet = args.find((a) => a.startsWith('image.tags='));
      expect(tagSet).toContain('my-app:1.2.3');
      expect(args[args.length - 1]).toBe('release');
    });

    it('should emit one --set tags override per tag', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      strategy.build({ ...baseParams, tagTemplates: ['latest', '1.2.3'] });

      const args = execMock.mock.calls[0][0];
      const tagSets = args.filter((a) => a.startsWith('image.tags='));
      expect(tagSets).toEqual([
        'image.tags=my-app:latest',
        'image.tags=my-app:1.2.3',
      ]);
    });

    it('should scope tags to the wildcard target by default', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      const tagSet = args.find((a) => a.startsWith('*.tags='));
      expect(tagSet).toContain('my-app:1.2.3');
    });

    it('should use cacheonly output and no tags in dry-run mode', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      strategy.build({ ...baseParams, isDryRun: true });

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('*.output=type=cacheonly');
      expect(args.some((a) => a.startsWith('image.tags='))).toBe(false);
    });

    it('should forward dockerArgs as bake --set args', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
        dockerArgs: { VERSION: '{{version}}' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('*.args.VERSION=1.2.3');
    });

    it('should skip boolean dockerArgs', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
        dockerArgs: { FROM_ENV: true },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args.some((a) => a.includes('FROM_ENV'))).toBe(false);
    });

    it('should prefer target over group as the selector', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', target: 'image' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args[args.length - 1]).toBe('image');
    });

    it('should capture the digest from the metadata file', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      execMock.mockImplementation((args: readonly string[]): string => {
        const idx = args.indexOf('--metadata-file');
        fs.writeFileSync(
          args[idx + 1],
          JSON.stringify({
            image: { 'containerimage.digest': 'sha256:abc123' },
          }),
        );
        return '';
      });
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      const { sha256, tags } = strategy.build(baseParams);

      expect(sha256).toBe('abc123');
      expect(tags).toEqual(['1.2.3']);
    });

    it('should remove the metadata file after the build', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      let metadataPath = '';
      execMock.mockImplementation((args: readonly string[]): string => {
        const idx = args.indexOf('--metadata-file');
        metadataPath = args[idx + 1];
        fs.writeFileSync(
          metadataPath,
          JSON.stringify({
            image: { 'containerimage.digest': 'sha256:abc123' },
          }),
        );
        return '';
      });
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      strategy.build(baseParams);

      expect(metadataPath).not.toBe('');
      expect(fs.existsSync(metadataPath)).toBe(false);
    });

    it('should remove the metadata file even when the build fails', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      let metadataPath = '';
      execMock.mockImplementation((args: readonly string[]): string => {
        const idx = args.indexOf('--metadata-file');
        metadataPath = args[idx + 1];
        fs.writeFileSync(metadataPath, '{}');
        throw new Error('build failed');
      });
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      expect(() => strategy.build(baseParams)).toThrow('build failed');
      expect(metadataPath).not.toBe('');
      expect(fs.existsSync(metadataPath)).toBe(false);
    });
  });

  describe('finalizePublish', () => {
    it('should be a no-op', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      strategy.finalizePublish();

      expect(execMock).not.toHaveBeenCalled();
    });
  });
});
