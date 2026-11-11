import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { BuildStrategy } from '../../src/lib/build-strategy.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { BuildParams, BuildState } from '../../src/lib/types.js';
import type { PrepareContext, VerifyConditionsContext } from 'semantic-release';
import { makeTempDir, removeTempDirs } from '../utils/tmpdir.js';
import { stepContext } from '../utils/context.js';
import { dockerSpy, failure, runnerOf } from '../utils/runner.js';

const execMock = dockerSpy();

async function writeDockerfile(
  dir: string,
  content = 'FROM alpine',
): Promise<void> {
  await fs.promises.writeFile(path.join(dir, 'Dockerfile'), content);
}

function makeStrategy(
  cwd: string,
  pluginConfig: OciPluginConfig = {},
  contextOverrides: Readonly<
    Partial<Record<keyof PrepareContext, unknown>>
  > = {},
): { strategy: BuildStrategy; context: VerifyConditionsContext } {
  const context = stepContext(cwd, {}, contextOverrides);
  const config = new OciConfig(pluginConfig, context.env);
  return {
    strategy: new BuildStrategy(config, context, runnerOf(execMock)),
    context,
  };
}

const baseParams: BuildParams = {
  repo: 'my-app',
  tagTemplates: ['latest', '1-latest', '1.2.3'],
  vars: { version: '1.2.3' },
  buildId: 'abc123def456abc1',
  isDryRun: false,
};

afterEach(removeTempDirs);

// eslint-disable-next-line sonarjs/max-lines-per-function -- splitting this describe would re-indent every test in it
describe('BuildStrategy', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockReturnValue('');
  });

  describe('verifyTarget', () => {
    it('should return a label for an existing Dockerfile', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      expect(await strategy.verifyTarget()).toBe(
        `dockerfile="${path.resolve(tmpDir, 'Dockerfile')}"`,
      );
    });

    it('should throw ENOENT when the Dockerfile does not exist', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      await expect(strategy.verifyTarget()).rejects.toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );
    });

    it('should resolve a custom Dockerfile path', async () => {
      const tmpDir = makeTempDir();
      await fs.promises.mkdir(path.join(tmpDir, 'build'), { recursive: true });
      await fs.promises.writeFile(
        path.join(tmpDir, 'build', 'Dockerfile'),
        'FROM alpine',
      );
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerFile: 'build/Dockerfile',
      });

      expect(await strategy.verifyTarget()).toBe(
        `dockerfile="${path.resolve(tmpDir, 'build/Dockerfile')}"`,
      );
    });
  });

  // eslint-disable-next-line sonarjs/max-lines-per-function -- splitting this describe would re-indent every test in it
  describe('build', () => {
    it('should build a standard docker image with default tags', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123def456\n');
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args[0]).toBe('build');
      expect(args).toContain('--quiet');
      expect(args.includes('my-app:latest')).toBe(true);
      expect(args.includes('my-app:1-latest')).toBe(true);
      expect(args.includes('my-app:1.2.3')).toBe(true);
      expect(args.some((a) => a.startsWith('--network'))).toBe(false);
    });

    it('should tag with the buildId for non-buildx builds', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain(`my-app:${baseParams.buildId}`);
    });

    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      'should render the inherited name {{%s}} as an unknown variable',
      async (name) => {
        const tmpDir = makeTempDir();
        await writeDockerfile(tmpDir);
        const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

        const { tags } = await strategy.build({
          ...baseParams,
          tagTemplates: [`{{${name}}}`, `v{{${name}}}1`],
        });

        expect(tags).toEqual(['v1']);
      },
    );

    it('should drop repeated tags', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      const { tags } = await strategy.build({
        ...baseParams,
        tagTemplates: ['latest', '{{version}}', '1.2.3', 'latest'],
      });

      expect(tags).toEqual(['latest', '1.2.3']);
    });

    it('should use buildx when dockerPlatform is set', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64', 'linux/arm64'],
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args[0]).toBe('buildx');
      expect(args[1]).toBe('build');
      expect(args).toContain('--platform');
      expect(args).toContain('linux/amd64,linux/arm64');
      expect(args).toContain('--pull');
      expect(args).toContain('--push');
    });

    it('should not include --push in buildx dry-run mode', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      await strategy.build({ ...baseParams, isDryRun: true });

      const args = execMock.mock.calls[0][0];
      expect(args).not.toContain('--push');
    });

    it('should omit --push in buildx mode when dockerPublish is false', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
        dockerPublish: false,
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args[0]).toBe('buildx');
      expect(args).not.toContain('--push');
    });

    it('should not tag with buildId in buildx mode', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      const tagArgs = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tagArgs.every((t) => !/:[a-f0-9]{16,}$/.test(t))).toBe(true);
    });

    it('should include --pull in buildx mode', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('--pull');
    });

    it('should skip version tags in dry-run mode', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      await strategy.build({
        ...baseParams,
        tagTemplates: ['1.2.3', 'latest'],
        isDryRun: true,
      });

      const args = execMock.mock.calls[0][0];
      const tagArgs = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tagArgs).toHaveLength(1);
      expect(tagArgs[0]).not.toContain('1.2.3');
      expect(tagArgs[0]).not.toContain('latest');
    });

    it('should pass build args with template rendering', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerArgs: { VERSION: '{{version}}', STATIC: 'hello' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('VERSION=1.2.3');
      expect(args).toContain('STATIC=hello');
    });

    it('should pass boolean build args without value', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerArgs: { GITHUB_TOKEN: true },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      const buildArgIdx = args.indexOf('GITHUB_TOKEN');
      expect(buildArgIdx).toBeGreaterThan(-1);
      expect(args[buildArgIdx - 1]).toBe('--build-arg');
    });

    it('should include --no-cache when configured', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerNoCache: true,
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('--no-cache');
    });

    it('should include --cache-from flags in build command', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildCacheFrom: ['type=local,src=/tmp/cache'],
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('--cache-from');
      expect(args).toContain('type=local,src=/tmp/cache');
    });

    it('should pass extra build flags', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { target: 'production', pull: null },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('--target');
      expect(args).toContain('production');
      expect(args).toContain('--pull');
    });

    it('should pass provenance flag via dockerBuildFlags', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
        dockerBuildFlags: { provenance: 'false' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('--provenance');
      expect(args).toContain('false');
    });

    it('should use single dash for single-char build flag keys', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { t: 'production' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('-t');
      expect(args).toContain('production');
    });

    it('should repeat flags for array build flag values', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { label: ['foo=bar', 'baz=qux'] },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      const labelIndices = args.reduce<number[]>(
        (acc, a, i) => (a === '--label' ? [...acc, i] : acc),
        [],
      );
      expect(labelIndices).toHaveLength(2);
      expect(args[labelIndices[0] + 1]).toBe('foo=bar');
      expect(args[labelIndices[1] + 1]).toBe('baz=qux');
    });

    it('should pass through flag keys that already start with a dash', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { '-t': 'mytag' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      const idx = args.indexOf('-t');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('mytag');
    });

    it('should normalize underscore flag keys to kebab-case', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { cache_from: 'type=inline' },
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('--cache-from');
      expect(args).toContain('type=inline');
    });

    it('should forward dockerTimeout to exec options', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerTimeout: 1_800_000,
      });

      await strategy.build(baseParams);

      expect(execMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeout: 1_800_000 }),
      );
    });

    it('should omit --quiet when dockerBuildQuiet is false', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildQuiet: false,
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).not.toContain('--quiet');
    });

    it('should use a custom Dockerfile path in build command', async () => {
      const tmpDir = makeTempDir();
      await fs.promises.mkdir(path.join(tmpDir, 'build'), { recursive: true });
      await fs.promises.writeFile(
        path.join(tmpDir, 'build', 'Dockerfile'),
        'FROM alpine',
      );
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerFile: 'build/Dockerfile',
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain(path.resolve(tmpDir, 'build/Dockerfile'));
    });

    it('should use a custom context path in build command', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      await fs.promises.mkdir(path.join(tmpDir, 'app'), { recursive: true });
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerContext: 'app',
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain(path.resolve(tmpDir, 'app'));
    });

    it('should use a custom network in build command', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerNetwork: 'host',
      });

      await strategy.build(baseParams);

      const args = execMock.mock.calls[0][0];
      expect(args).toContain('--network=host');
    });

    it('should produce no version tags when tags is empty', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      await strategy.build({ ...baseParams, tagTemplates: [] });

      const args = execMock.mock.calls[0][0];
      const tagArgs = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tagArgs).toHaveLength(1);
    });

    it('should build with an empty image name', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {});

      await strategy.build({
        ...baseParams,
        repo: '',
        tagTemplates: ['latest'],
      });

      const args = execMock.mock.calls[0][0];
      expect(args.includes(':latest')).toBe(true);
    });

    it('should extract the SHA from build output', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      execMock.mockReturnValue(
        'Step 1/1 : FROM alpine\nwriting image sha256:abcdef1234567890abcdef1234567890\n',
      );
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      const { sha256, tags } = await strategy.build(baseParams);

      expect(sha256).toBe('abcdef1234567890abcdef1234567890');
      expect(tags).toEqual(['latest', '1-latest', '1.2.3']);
    });

    it('should return an empty SHA when no digest is in build output', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      execMock.mockReturnValue('Step 1/1 : FROM alpine\n');
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      const { sha256 } = await strategy.build(baseParams);

      expect(sha256).toBe('');
    });

    it('should propagate build errors', async () => {
      const tmpDir = makeTempDir();
      await writeDockerfile(tmpDir);
      execMock.mockImplementation(() => {
        throw failure('build failed');
      });
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      await expect(strategy.build(baseParams)).rejects.toThrow('build failed');
    });
  });

  describe('finalizePublish', () => {
    function makeState(overrides: Partial<BuildState> = {}): BuildState {
      return {
        sha: 'abc123def456',
        sha256: 'abc123',
        buildId: 'buildid01',
        tags: ['latest', '1-latest', '1.2.3'],
        version: '1.2.3',
        repo: 'my-app',
        isBuildx: false,
        ...overrides,
      };
    }

    it('should tag and push each tag for non-buildx builds', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });

      await strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.filter((a) => a[0] === 'tag')).toHaveLength(3);
      expect(allArgs.filter((a) => a[0] === 'push')).toHaveLength(3);
    });

    it('should push the version tag before the floating tags', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });

      await strategy.finalizePublish(makeState());

      const pushed = execMock.mock.calls
        .map((c) => c[0])
        .filter((a) => a[0] === 'push')
        .map((a) => a[1]);
      expect(pushed).toEqual([
        'my-app:1.2.3',
        'my-app:latest',
        'my-app:1-latest',
      ]);
    });

    it('should leave the floating tags unpushed when the version push fails', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });
      execMock.mockImplementation((args) => {
        if (args[0] === 'push') {
          throw failure('denied');
        }
        return '';
      });

      await expect(strategy.finalizePublish(makeState())).rejects.toThrow(
        'denied',
      );

      const pushes = execMock.mock.calls.filter((c) => c[0][0] === 'push');
      expect(pushes.map((c) => c[0][1])).toEqual(['my-app:1.2.3']);
    });

    it('should keep the order of the tags when there is no version', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });

      await strategy.finalizePublish(makeState({ version: '' }));

      const pushed = execMock.mock.calls
        .map((c) => c[0])
        .filter((a) => a[0] === 'push')
        .map((a) => a[1]);
      expect(pushed).toEqual([
        'my-app:latest',
        'my-app:1-latest',
        'my-app:1.2.3',
      ]);
    });

    it('should push a tag without the version after the version tags, in order', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });

      await strategy.finalizePublish(
        makeState({ tags: ['latest', 'sha-abc1234', 'v1.2.3', '1.2.3-rc'] }),
      );

      const pushed = execMock.mock.calls
        .map((c) => c[0])
        .filter((a) => a[0] === 'push')
        .map((a) => a[1]);
      expect(pushed).toEqual([
        'my-app:v1.2.3',
        'my-app:1.2.3-rc',
        'my-app:latest',
        'my-app:sha-abc1234',
      ]);
    });

    it('should log what a push wrote', async () => {
      const tmpDir = makeTempDir();
      const { strategy, context } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });
      execMock.mockImplementation((args) =>
        args[0] === 'push' ? 'The push refers to repository [my-app]\n' : '',
      );

      await strategy.finalizePublish(makeState({ tags: ['1.2.3'] }));

      expect(context.logger.log).toHaveBeenCalledWith(
        'The push refers to repository [my-app]',
      );
    });

    it('should be a no-op for buildx builds', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      await strategy.finalizePublish(makeState({ isBuildx: true }));

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.filter((a) => a[0] === 'tag')).toHaveLength(0);
      expect(allArgs.filter((a) => a[0] === 'push')).toHaveLength(0);
      expect(allArgs.filter((a) => a[0] === 'rmi')).toHaveLength(0);
    });

    it('should remove images when dockerAutoClean is true', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });
      execMock.mockImplementation((args: readonly string[]) => {
        if (args[0] === 'images') return 'img1\nimg2\n';
        return '';
      });

      await strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(true);
    });

    it('should skip rmi when no images are found during cleanup', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });
      execMock.mockImplementation((args: readonly string[]) => {
        if (args[0] === 'images') return '   \n';
        return '';
      });

      await strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(false);
    });

    it('should continue gracefully when image cleanup fails', async () => {
      const tmpDir = makeTempDir();
      const { strategy, context } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
      });
      execMock.mockImplementation((args: readonly string[]) => {
        if (args[0] === 'images') return 'img1\n';
        if (args[0] === 'rmi') throw new Error('permission denied');
        return '';
      });

      await expect(
        strategy.finalizePublish(makeState()),
      ).resolves.not.toThrow();
      expect(context.logger.log).toHaveBeenCalledWith(
        'Image cleanup failed. Continuing.',
      );
    });

    it('should skip cleanup when dockerAutoClean is false', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });

      await strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(false);
      expect(allArgs.some((a) => a[0] === 'images')).toBe(false);
    });

    it('should skip push when dockerPublish is false', async () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPublish: false,
      });
      execMock.mockImplementation((args: readonly string[]) => {
        if (args[0] === 'images') return 'img1\n';
        return '';
      });

      await strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.filter((a) => a[0] === 'push')).toHaveLength(0);
    });
  });
});
