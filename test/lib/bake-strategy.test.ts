import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { BakeStrategy } from '../../src/lib/bake-strategy.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { BuildParams } from '../../src/lib/types.js';
import type { PrepareContext, VerifyConditionsContext } from 'semantic-release';
import { makeTempDir, removeTempDirs } from '../utils/tmpdir.js';
import { stepContext } from '../utils/context.js';
import { dockerSpy, failure, runnerOf } from '../utils/runner.js';

const execMock = dockerSpy();

async function writeBakeFile(dir: string): Promise<string> {
  const file = path.join(dir, 'docker-bake.hcl');
  await fs.promises.writeFile(file, 'group "release" {}');
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
  return {
    strategy: new BakeStrategy(config, context, bake, runnerOf(execMock)),
    context,
  };
}

const baseParams: BuildParams = {
  repo: 'my-app',
  tagTemplates: ['1.2.3'],
  vars: { version: '1.2.3' },
  buildId: 'abc123def456abc1',
  isDryRun: false,
};

afterEach(removeTempDirs);

describe('BakeStrategy', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockReturnValue('');
  });

  describe('verifyTarget', () => {
    it('should return a label for a valid bake file', async () => {
      const tmpDir = makeTempDir();
      const file = await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      expect(strategy.verifyTarget()).toBe(`bakeFile="${file}"`);
    });

    it('should throw EINVAL when neither group nor target is set', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerBake: {} });

      expect(() => strategy.verifyTarget()).toThrow(
        expect.objectContaining({ code: 'EINVAL' }),
      );
    });

    it('should throw ENOENT when the bake file does not exist', async () => {
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
    it('should drive buildx bake with file, metadata-file, and selector', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args[0]).toBe('buildx');
      expect(args[1]).toBe('bake');
      expect(args).toContain('--file');
      expect(args).toContain('--metadata-file');
      const tagSet = args.find((a) => a.startsWith('image.tags='));
      expect(tagSet).toContain('my-app:1.2.3');
      expect(args.at(-1)).toBe('release');
    });

    it('should emit one --set tags override per tag', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      await strategy.build({
        ...baseParams,
        tagTemplates: ['latest', '1.2.3'],
      });

      const args = execMock.mock.calls[0][0];
      const tagSets = args.filter((a) => a.startsWith('image.tags='));
      expect(tagSets).toEqual([
        'image.tags=my-app:latest',
        'image.tags=my-app:1.2.3',
      ]);
    });

    it('should scope tags to the wildcard target by default', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      const tagSet = args.find((a) => a.startsWith('*.tags='));
      expect(tagSet).toContain('my-app:1.2.3');
    });

    it('should use cacheonly output and no tags in dry-run mode', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', imageTarget: 'image' },
      });

      await strategy.build({ ...baseParams, isDryRun: true });

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('*.output=type=cacheonly');
      expect(args.some((a) => a.startsWith('image.tags='))).toBe(false);
    });

    it('should forward dockerArgs as bake --set args', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
        dockerArgs: { VERSION: '{{version}}' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('*.args.VERSION=1.2.3');
    });

    it('should skip boolean dockerArgs', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
        dockerArgs: { FROM_ENV: true },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args.some((a) => a.includes('FROM_ENV'))).toBe(false);
    });

    it('should prefer target over group as the selector', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release', target: 'image' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args.at(-1)).toBe('image');
    });

    it('should capture the digest from the metadata file', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      execMock.mockImplementation((args: readonly string[]): string => {
        const idx = args.indexOf('--metadata-file');
        // eslint-disable-next-line n/no-sync -- test helper: the docker spy must write its metadata synchronously
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

      const { sha256, tags } = await strategy.build(baseParams);

      expect(sha256).toBe('abc123');
      expect(tags).toEqual(['1.2.3']);
    });

    it('should remove the metadata file after the build', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      let metadataPath = '';
      execMock.mockImplementation((args: readonly string[]): string => {
        const idx = args.indexOf('--metadata-file');
        metadataPath = args[idx + 1];
        // eslint-disable-next-line n/no-sync -- test helper: the docker spy must write its metadata synchronously
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

      await strategy.build(baseParams);

      expect(metadataPath).not.toBe('');
      await expect(fs.promises.access(metadataPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('should remove the metadata file even when the build fails', async () => {
      const tmpDir = makeTempDir();
      await writeBakeFile(tmpDir);
      let metadataPath = '';
      execMock.mockImplementation((args: readonly string[]): string => {
        const idx = args.indexOf('--metadata-file');
        metadataPath = args[idx + 1];
        // eslint-disable-next-line n/no-sync -- test helper: the docker spy must write its metadata synchronously
        fs.writeFileSync(metadataPath, '{}');
        throw failure('build failed');
      });
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      await expect(strategy.build(baseParams)).rejects.toThrow('build failed');
      expect(metadataPath).not.toBe('');
      await expect(fs.promises.access(metadataPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('finalizePublish', () => {
    it('should be a no-op', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerBake: { group: 'release' },
      });

      await strategy.finalizePublish();

      expect(execMock).not.toHaveBeenCalled();
    });
  });
});
