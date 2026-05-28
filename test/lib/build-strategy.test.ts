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
import { BuildStrategy } from '../../src/lib/build-strategy.js';
import { commandRunner } from '../../src/lib/command-runner.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type {
  BuildParams,
  BuildState,
  SemanticReleaseContext,
} from '../../src/lib/types.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-release-oci-'));
}

function writeDockerfile(dir: string, content = 'FROM alpine'): void {
  fs.writeFileSync(path.join(dir, 'Dockerfile'), content);
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
): { strategy: BuildStrategy; context: SemanticReleaseContext } {
  const context = makeContext(cwd, contextOverrides);
  const config = new OciConfig(pluginConfig as OciPluginConfig, context.env);
  return { strategy: new BuildStrategy(config, context), context };
}

const baseParams: BuildParams = {
  repo: 'my-app',
  tags: ['latest', '1-latest', '1.2.3'],
  vars: { version: '1.2.3' },
  buildId: 'abc123def456abc1',
  isDryRun: false,
};

describe('BuildStrategy', () => {
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
    it('should return a label for an existing Dockerfile', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      expect(strategy.verifyTarget()).toBe(
        `dockerfile="${path.resolve(tmpDir, 'Dockerfile')}"`,
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should throw ENOENT when the Dockerfile does not exist', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      expect(() => strategy.verifyTarget()).toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should resolve a custom Dockerfile path', () => {
      const tmpDir = makeTempDir();
      fs.mkdirSync(path.join(tmpDir, 'build'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'build', 'Dockerfile'), 'FROM alpine');
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerFile: 'build/Dockerfile',
      });

      expect(strategy.verifyTarget()).toBe(
        `dockerfile="${path.resolve(tmpDir, 'build/Dockerfile')}"`,
      );

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('build', () => {
    it('should build a standard docker image with default tags', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123def456\n');
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[0]).toBe('build');
      expect(args).toContain('--quiet');
      expect(args.some((a) => a === 'my-app:latest')).toBe(true);
      expect(args.some((a) => a === 'my-app:1-latest')).toBe(true);
      expect(args.some((a) => a === 'my-app:1.2.3')).toBe(true);
      expect(args.some((a) => a.startsWith('--network'))).toBe(false);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should tag with the buildId for non-buildx builds', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain(`my-app:${baseParams.buildId}`);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use buildx when dockerPlatform is set', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64', 'linux/arm64'],
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[0]).toBe('buildx');
      expect(args[1]).toBe('build');
      expect(args).toContain('--platform');
      expect(args).toContain('linux/amd64,linux/arm64');
      expect(args).toContain('--pull');
      expect(args).toContain('--push');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should not include --push in buildx dry-run mode', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      strategy.build({ ...baseParams, isDryRun: true });

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).not.toContain('--push');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should omit --push in buildx mode when dockerPublish is false', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
        dockerPublish: false,
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[0]).toBe('buildx');
      expect(args).not.toContain('--push');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should not tag with buildId in buildx mode', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      const tagArgs = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tagArgs.every((t) => !t.match(/:[a-f0-9]{16,}$/))).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should include --pull in buildx mode', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--pull');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip version tags in dry-run mode', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      strategy.build({
        ...baseParams,
        tags: ['1.2.3', 'latest'],
        isDryRun: true,
      });

      const args = execMock.mock.calls[0][0] as string[];
      const tagArgs = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tagArgs.length).toBe(1);
      expect(tagArgs[0]).not.toContain('1.2.3');
      expect(tagArgs[0]).not.toContain('latest');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass build args with template rendering', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerArgs: { VERSION: '{{version}}', STATIC: 'hello' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('VERSION=1.2.3');
      expect(args).toContain('STATIC=hello');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass boolean build args without value', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerArgs: { GITHUB_TOKEN: true },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      const buildArgIdx = args.indexOf('GITHUB_TOKEN');
      expect(buildArgIdx).toBeGreaterThan(-1);
      expect(args[buildArgIdx - 1]).toBe('--build-arg');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should include --no-cache when configured', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerNoCache: true,
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--no-cache');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should include --cache-from flags in build command', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildCacheFrom: ['type=local,src=/tmp/cache'],
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--cache-from');
      expect(args).toContain('type=local,src=/tmp/cache');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass extra build flags', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { target: 'production', pull: null },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--target');
      expect(args).toContain('production');
      expect(args).toContain('--pull');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass provenance flag via dockerBuildFlags', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
        dockerBuildFlags: { provenance: 'false' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--provenance');
      expect(args).toContain('false');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use single dash for single-char build flag keys', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { t: 'production' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('-t');
      expect(args).toContain('production');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should repeat flags for array build flag values', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { label: ['foo=bar', 'baz=qux'] },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      const labelIndices = args.reduce<number[]>(
        (acc, a, i) => (a === '--label' ? [...acc, i] : acc),
        [],
      );
      expect(labelIndices.length).toBe(2);
      expect(args[labelIndices[0] + 1]).toBe('foo=bar');
      expect(args[labelIndices[1] + 1]).toBe('baz=qux');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass through flag keys that already start with a dash', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { '-t': 'mytag' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      const idx = args.indexOf('-t');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('mytag');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should normalize underscore flag keys to kebab-case', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildFlags: { cache_from: 'type=inline' },
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--cache-from');
      expect(args).toContain('type=inline');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should forward dockerTimeout to exec options', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerTimeout: 1_800_000,
      });

      strategy.build(baseParams);

      expect(execMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeout: 1_800_000 }),
        expect.anything(),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should omit --quiet when dockerBuildQuiet is false', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerBuildQuiet: false,
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).not.toContain('--quiet');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use a custom Dockerfile path in build command', () => {
      const tmpDir = makeTempDir();
      fs.mkdirSync(path.join(tmpDir, 'build'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'build', 'Dockerfile'), 'FROM alpine');
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerFile: 'build/Dockerfile',
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain(path.resolve(tmpDir, 'build/Dockerfile'));

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use a custom context path in build command', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerContext: 'app',
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain(path.resolve(tmpDir, 'app'));

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use a custom network in build command', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerNetwork: 'host',
      });

      strategy.build(baseParams);

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--network=host');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should produce no version tags when tags is empty', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      strategy.build({ ...baseParams, tags: [] });

      const args = execMock.mock.calls[0][0] as string[];
      const tagArgs = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tagArgs.length).toBe(1);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should build with an empty image name', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const { strategy } = makeStrategy(tmpDir, {});

      strategy.build({ ...baseParams, repo: '', tags: ['latest'] });

      const args = execMock.mock.calls[0][0] as string[];
      expect(args.some((a) => a === ':latest')).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should extract the SHA from build output', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue(
        'Step 1/1 : FROM alpine\nwriting image sha256:abcdef1234567890abcdef1234567890\n',
      );
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      const { sha256 } = strategy.build(baseParams);

      expect(sha256).toBe('abcdef1234567890abcdef1234567890');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return an empty SHA when no digest is in build output', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('Step 1/1 : FROM alpine\n');
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      const { sha256 } = strategy.build(baseParams);

      expect(sha256).toBe('');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should propagate build errors', () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockImplementation(() => {
        throw new Error('build failed');
      });
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });

      expect(() => strategy.build(baseParams)).toThrow('build failed');

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('finalizePublish', () => {
    function makeState(overrides: Partial<BuildState> = {}): BuildState {
      return {
        sha: 'abc123def456',
        sha256: 'abc123',
        buildId: 'buildid01',
        tags: ['latest', '1-latest', '1.2.3'],
        repo: 'my-app',
        isBuildx: false,
        ...overrides,
      };
    }

    it('should tag and push each tag for non-buildx builds', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });

      strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.filter((a) => a[0] === 'tag').length).toBe(3);
      expect(allArgs.filter((a) => a[0] === 'push').length).toBe(3);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should be a no-op for buildx builds', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPlatform: ['linux/amd64'],
      });

      strategy.finalizePublish(makeState({ isBuildx: true }));

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.filter((a) => a[0] === 'tag').length).toBe(0);
      expect(allArgs.filter((a) => a[0] === 'push').length).toBe(0);
      expect(allArgs.filter((a) => a[0] === 'rmi').length).toBe(0);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should remove images when dockerAutoClean is true', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });
      execMock.mockImplementation((args: string[]) => {
        if (args[0] === 'images') return 'img1\nimg2\n';
        return '';
      });

      strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip rmi when no images are found during cleanup', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, { dockerImage: 'my-app' });
      execMock.mockImplementation((args: string[]) => {
        if (args[0] === 'images') return '   \n';
        return '';
      });

      strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(false);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should continue gracefully when image cleanup fails', () => {
      const tmpDir = makeTempDir();
      const { strategy, context } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
      });
      execMock.mockImplementation((args: string[]) => {
        if (args[0] === 'images') return 'img1\n';
        if (args[0] === 'rmi') throw new Error('permission denied');
        return '';
      });

      expect(() => strategy.finalizePublish(makeState())).not.toThrow();
      expect(context.logger.log).toHaveBeenCalledWith(
        'Image cleanup failed. Continuing.',
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip cleanup when dockerAutoClean is false', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerAutoClean: false,
      });

      strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(false);
      expect(allArgs.some((a) => a[0] === 'images')).toBe(false);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip push when dockerPublish is false', () => {
      const tmpDir = makeTempDir();
      const { strategy } = makeStrategy(tmpDir, {
        dockerImage: 'my-app',
        dockerPublish: false,
      });
      execMock.mockImplementation((args: string[]) => {
        if (args[0] === 'images') return 'img1\n';
        return '';
      });

      strategy.finalizePublish(makeState());

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.filter((a) => a[0] === 'push').length).toBe(0);

      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
