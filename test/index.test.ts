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
import {
  verifyConditions,
  prepare,
  publish,
  commandRunner,
  renderTemplate,
} from '../src/index.js';
import type { OciPluginConfig } from '../src/plugin-config.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-release-oci-'));
}

function writePackageJson(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
}

function writeDockerfile(dir: string, content = 'FROM alpine'): void {
  fs.writeFileSync(path.join(dir, 'Dockerfile'), content);
}

function makeContext(
  cwd: string,
  env: Record<string, string> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    cwd,
    env,
    logger: {
      log: jest.fn(),
      error: jest.fn(),
    },
    nextRelease: {
      version: '1.2.3',
      gitTag: 'v1.2.3',
      gitHead: 'abc1234',
      channel: undefined,
      type: 'minor',
    },
    options: {
      dryRun: false,
    },
    ...overrides,
  };
}

describe('semantic-release-oci', () => {
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

  describe('renderTemplate', () => {
    it('should replace simple variables', () => {
      expect(renderTemplate('{{version}}', { version: '1.2.3' })).toBe('1.2.3');
    });

    it('should replace multiple variables', () => {
      expect(
        renderTemplate('{{major}}.{{minor}}', { major: '1', minor: '2' }),
      ).toBe('1.2');
    });

    it('should replace unknown variables with empty string', () => {
      expect(renderTemplate('{{unknown}}', {})).toBe('');
    });

    it('should pass through strings without templates', () => {
      expect(renderTemplate('latest', {})).toBe('latest');
    });
  });

  describe('verifyConditions', () => {
    it('should throw EINVAL when no image name can be determined', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions({} as OciPluginConfig, makeContext(tmpDir)),
      ).rejects.toThrow(expect.objectContaining({ code: 'EINVAL' }));

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should throw ENOENT when Dockerfile does not exist', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');

      await expect(
        verifyConditions({} as OciPluginConfig, makeContext(tmpDir)),
      ).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should throw EAUTH when only username is provided', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions(
          {} as OciPluginConfig,
          makeContext(tmpDir, { DOCKER_REGISTRY_USER: 'user' }),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'EAUTH' }));

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should succeed with valid credentials', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions(
          {} as OciPluginConfig,
          makeContext(tmpDir, {
            DOCKER_REGISTRY_USER: 'user',
            DOCKER_REGISTRY_PASSWORD: 'pass',
          }),
        ),
      ).resolves.toBeUndefined();

      expect(execMock).toHaveBeenCalledWith(
        expect.arrayContaining(['login', '-u', 'user', '--password-stdin']),
        expect.objectContaining({ input: 'pass' }),
        expect.anything(),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should succeed without credentials when login is disabled', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions(
          { dockerLogin: false } as OciPluginConfig,
          makeContext(tmpDir),
        ),
      ).resolves.toBeUndefined();

      expect(execMock).not.toHaveBeenCalled();

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip login when credentials are present but login is disabled', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions(
          { dockerLogin: false } as OciPluginConfig,
          makeContext(tmpDir, {
            DOCKER_REGISTRY_USER: 'user',
            DOCKER_REGISTRY_PASSWORD: 'pass',
          }),
        ),
      ).resolves.toBeUndefined();

      expect(execMock).not.toHaveBeenCalled();

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use GITHUB_TOKEN as password fallback', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions(
          {} as OciPluginConfig,
          makeContext(tmpDir, {
            DOCKER_REGISTRY_USER: 'user',
            GITHUB_TOKEN: 'gh-token',
          }),
        ),
      ).resolves.toBeUndefined();

      expect(execMock).toHaveBeenCalledWith(
        expect.arrayContaining(['login']),
        expect.objectContaining({ input: 'gh-token' }),
        expect.anything(),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use dockerImage from config over package.json', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions(
          { dockerImage: 'custom-image' } as OciPluginConfig,
          makeContext(tmpDir),
        ),
      ).resolves.toBeUndefined();

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should login to a custom registry', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await verifyConditions(
        { dockerRegistry: 'ghcr.io' } as OciPluginConfig,
        makeContext(tmpDir, {
          DOCKER_REGISTRY_USER: 'user',
          DOCKER_REGISTRY_PASSWORD: 'pass',
        }),
      );

      expect(execMock).toHaveBeenCalledWith(
        expect.arrayContaining(['login', 'ghcr.io']),
        expect.anything(),
        expect.anything(),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('prepare', () => {
    it('should build a standard docker image with default tags', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123def456\n');

      await prepare(
        { dockerImage: 'my-app' } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[0]).toBe('build');
      expect(args).toContain('--quiet');
      expect(args.some((a) => a === 'my-app:latest')).toBe(true);
      expect(args.some((a) => a === 'my-app:1-latest')).toBe(true);
      expect(args.some((a) => a === 'my-app:1.2.3')).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should build with a custom registry and project', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerRegistry: 'ghcr.io',
          dockerProject: 'myorg',
        } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args.some((a) => a.includes('ghcr.io/myorg/my-app'))).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should resolve image name and project from scoped package.json', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, '@myorg/my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare({} as OciPluginConfig, makeContext(tmpDir));

      const args = execMock.mock.calls[0][0] as string[];
      expect(args.some((a) => a.includes('myorg/my-app'))).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should use buildx when dockerPlatform is set', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerPlatform: ['linux/amd64', 'linux/arm64'],
        } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[0]).toBe('buildx');
      expect(args[1]).toBe('build');
      expect(args).toContain('--platform');
      expect(args).toContain('linux/amd64,linux/arm64');
      expect(args).toContain('--push');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should not include --push in buildx dry-run mode', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerPlatform: ['linux/amd64'],
        } as OciPluginConfig,
        makeContext(tmpDir, {}, { options: { dryRun: true } }),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).not.toContain('--push');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should omit --push in buildx mode when dockerPublish is false', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerPlatform: ['linux/amd64'],
          dockerPublish: false,
        } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args[0]).toBe('buildx');
      expect(args).not.toContain('--push');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip version tags in dry-run mode for standard builds', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerTags: ['{{version}}', 'latest'],
        } as OciPluginConfig,
        makeContext(tmpDir, {}, { options: { dryRun: true } }),
      );

      const args = execMock.mock.calls[0][0] as string[];
      const tagArgs = args.filter((_a, i) => args[i - 1] === '--tag');
      expect(tagArgs.length).toBe(1);
      expect(tagArgs[0]).not.toContain('1.2.3');
      expect(tagArgs[0]).not.toContain('latest');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass build args with template rendering', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerArgs: { VERSION: '{{version}}', STATIC: 'hello' },
        } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('VERSION=1.2.3');
      expect(args).toContain('STATIC=hello');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass boolean build args without value', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerArgs: { GITHUB_TOKEN: true },
        } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      const buildArgIdx = args.indexOf('GITHUB_TOKEN');
      expect(buildArgIdx).toBeGreaterThan(-1);
      expect(args[buildArgIdx - 1]).toBe('--build-arg');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should include --no-cache when configured', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        { dockerImage: 'my-app', dockerNoCache: true } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--no-cache');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should include --cache-from flags in build command', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerBuildCacheFrom: ['type=local,src=/tmp/cache'],
        } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--cache-from');
      expect(args).toContain('type=local,src=/tmp/cache');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should pass extra build flags', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await prepare(
        {
          dockerImage: 'my-app',
          dockerBuildFlags: { target: 'production', pull: null },
        } as OciPluginConfig,
        makeContext(tmpDir),
      );

      const args = execMock.mock.calls[0][0] as string[];
      expect(args).toContain('--target');
      expect(args).toContain('production');
      expect(args).toContain('--pull');

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should extract SHA from build output', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue(
        'Step 1/1 : FROM alpine\nwriting image sha256:abcdef1234567890abcdef1234567890\n',
      );
      const context = makeContext(tmpDir);

      await prepare({ dockerImage: 'my-app' } as OciPluginConfig, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('sha: abcdef123456'),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should rethrow build errors and preserve stdout from the error', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const buildError = new Error('build failed');
      (buildError as unknown as Record<string, unknown>).stdout =
        'partial output sha256:abc123';
      execMock.mockImplementation(() => {
        throw buildError;
      });

      await expect(
        prepare(
          { dockerImage: 'my-app' } as OciPluginConfig,
          makeContext(tmpDir),
        ),
      ).rejects.toThrow('build failed');

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('publish', () => {
    it('should tag and push each tag for standard builds', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      await prepare({ dockerImage: 'my-app' } as OciPluginConfig, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish({ dockerImage: 'my-app' } as OciPluginConfig, context);

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      const tagCalls = allArgs.filter((a) => a[0] === 'tag');
      const pushCalls = allArgs.filter((a) => a[0] === 'push');

      expect(tagCalls.length).toBe(3);
      expect(pushCalls.length).toBe(3);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip push for buildx builds', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      const context = makeContext(tmpDir);
      await prepare(
        {
          dockerImage: 'my-app',
          dockerPlatform: ['linux/amd64'],
        } as OciPluginConfig,
        context,
      );

      execMock.mockClear();

      await publish(
        {
          dockerImage: 'my-app',
          dockerPlatform: ['linux/amd64'],
        } as OciPluginConfig,
        context,
      );

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      const tagCalls = allArgs.filter((a) => a[0] === 'tag');
      const pushCalls = allArgs.filter((a) => a[0] === 'push');

      expect(tagCalls.length).toBe(0);
      expect(pushCalls.length).toBe(0);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip publish when no build state exists', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = makeContext(tmpDir);

      await publish(
        { dockerImage: 'no-build-state' } as OciPluginConfig,
        context,
      );

      expect(execMock).not.toHaveBeenCalled();
      expect(context.logger.log).toHaveBeenCalledWith(
        'No build state found. Skipping publish.',
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should clean up images when dockerAutoClean is true', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      await prepare({ dockerImage: 'my-app' } as OciPluginConfig, context);

      execMock.mockImplementation((args: string[]) => {
        if (args[0] === 'images') return 'img1\nimg2\n';
        return '';
      });

      await publish({ dockerImage: 'my-app' } as OciPluginConfig, context);

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(true);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should continue gracefully when image cleanup fails', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      await prepare({ dockerImage: 'my-app' } as OciPluginConfig, context);

      execMock.mockImplementation((args: string[]) => {
        if (args[0] === 'images') return 'img1\n';
        if (args[0] === 'rmi') throw new Error('permission denied');
        return '';
      });

      await expect(
        publish({ dockerImage: 'my-app' } as OciPluginConfig, context),
      ).resolves.toBeUndefined();

      expect(context.logger.log).toHaveBeenCalledWith(
        'Image cleanup failed. Continuing.',
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip cleanup when dockerAutoClean is false', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      await prepare(
        { dockerImage: 'my-app', dockerAutoClean: false } as OciPluginConfig,
        context,
      );

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish(
        { dockerImage: 'my-app', dockerAutoClean: false } as OciPluginConfig,
        context,
      );

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.some((a) => a[0] === 'rmi')).toBe(false);
      expect(allArgs.some((a) => a[0] === 'images')).toBe(false);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should skip push when dockerPublish is false', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      await prepare(
        { dockerImage: 'my-app', dockerPublish: false } as OciPluginConfig,
        context,
      );

      execMock.mockClear();
      execMock.mockImplementation((args: string[]) => {
        if (args[0] === 'images') return 'img1\n';
        return '';
      });

      await publish(
        { dockerImage: 'my-app', dockerPublish: false } as OciPluginConfig,
        context,
      );

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      const pushCalls = allArgs.filter((a) => a[0] === 'push');
      expect(pushCalls.length).toBe(0);

      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
