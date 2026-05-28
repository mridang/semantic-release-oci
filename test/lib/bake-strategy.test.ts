import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BakeStrategy, parseBakeDigest } from '../../src/lib/bake-strategy.js';
import { commandRunner } from '../../src/lib/command-runner.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type {
  BuildParams,
  SemanticReleaseContext,
} from '../../src/lib/types.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-release-oci-'));
}

function writeBakeFile(dir: string): string {
  const file = path.join(dir, 'docker-bake.hcl');
  fs.writeFileSync(file, 'group "release" {}');
  return file;
}

function makeContext(
  cwd: string,
  overrides: Partial<SemanticReleaseContext> = {},
): SemanticReleaseContext {
  return {
    cwd,
    env: {},
    logger: { log: jest.fn(), error: jest.fn() },
    nextRelease: { version: '1.2.3' },
    options: { dryRun: false },
    ...overrides,
  };
}

function makeStrategy(
  cwd: string,
  pluginConfig: Partial<OciPluginConfig> = {},
  contextOverrides: Partial<SemanticReleaseContext> = {},
): { strategy: BakeStrategy; context: SemanticReleaseContext } {
  const context = makeContext(cwd, contextOverrides);
  const config = new OciConfig(pluginConfig as OciPluginConfig, context.env);
  return { strategy: new BakeStrategy(config, context), context };
}

const baseParams: BuildParams = {
  repo: 'my-app',
  tags: ['1.2.3'],
  vars: { version: '1.2.3' },
  buildId: 'abc123def456abc1',
  isDryRun: false,
};

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

describe('BakeStrategy', () => {
  let originalExec: typeof commandRunner.exec;
  let execMock: jest.Mock<typeof commandRunner.exec>;

  beforeEach(() => {
    originalExec = commandRunner.exec;
    execMock = jest.fn<typeof commandRunner.exec>().mockReturnValue('');
    commandRunner.exec = execMock;
  });

  afterEach(() => {
    commandRunner.exec = originalExec;
  });

  describe('verifyTarget', () => {
    it('should return a label for a valid bake file', () => {
      const tmpDir = makeTempDir();
      const file = writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      expect(strategy.verifyTarget()).toBe(`bakeFile="${file}"`);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should throw EINVAL when neither group nor target is set', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerBake: {} });

      expect(() => strategy.verifyTarget()).toThrow(
        expect.objectContaining({ code: 'EINVAL' }),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should throw ENOENT when the bake file does not exist', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      expect(() => strategy.verifyTarget()).toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );

      fs.rmSync(tmpDir, { recursive: true });
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

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[0]).toBe('buildx');
      expect(args[1]).toBe('bake');
      expect(args).toContain('--file');
      expect(args).toContain('--metadata-file');
      const tagSet = args.find((a) => a.startsWith('image.tags='));
      expect(tagSet).toContain('my-app:1.2.3');
      expect(args[args.length - 1]).toBe('release');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should join multiple tags into a single --set override', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      strategy.build({ ...baseParams, tags: ['latest', '1.2.3'] });

      const args = execMock.mock.calls[0][0] as string[];
      const tagSets = args.filter((a) => a.startsWith('image.tags='));
      expect(tagSets).toHaveLength(1);
      expect(tagSets[0]).toBe('image.tags=my-app:latest,my-app:1.2.3');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should scope tags to the wildcard target by default', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      const tagSet = args.find((a) => a.startsWith('*.tags='));
      expect(tagSet).toContain('my-app:1.2.3');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use cacheonly output and no tags in dry-run mode', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      strategy.build({ ...baseParams, isDryRun: true });

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('*.output=type=cacheonly');
      expect(args.some((a) => a.startsWith('image.tags='))).toBe(false);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should forward dockerArgs as bake --set args', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
        dockerArgs: { VERSION: '{{version}}' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('*.args.VERSION=1.2.3');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip boolean dockerArgs', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
        dockerArgs: { FROM_ENV: true },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args.some((a) => a.includes('FROM_ENV'))).toBe(false);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should prefer target over group as the selector', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', target: 'image' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[args.length - 1]).toBe('image');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should capture the digest from the metadata file', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      execMock.mockImplementation((args: string[]): string => {
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

      const { sha256 } = strategy.build(baseParams);

      expect(sha256).toBe('abc123');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should remove the metadata file after the build', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      let metadataPath = '';
      execMock.mockImplementation((args: string[]): string => {
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

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should remove the metadata file even when the build fails', () => {
      const tmpDir = makeTempDir();
      writeBakeFile(tmpDir);
      let metadataPath = '';
      execMock.mockImplementation((args: string[]): string => {
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

      fs.rmSync(tmpDir, { recursive: true });
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

      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
