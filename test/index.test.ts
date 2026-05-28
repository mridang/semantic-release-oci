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
import { verifyConditions, prepare, publish } from '../src/index.js';
import { ImageStrategy } from '../src/lib/image-strategy.js';
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
  let execMock: jest.SpiedFunction<typeof ImageStrategy.prototype.exec>;

  beforeEach(() => {
    execMock = jest.spyOn(ImageStrategy.prototype, 'exec').mockReturnValue('');
  });

  afterEach(() => {
    execMock.mockRestore();
  });

  describe('verifyConditions', () => {
    it('should throw ENOENT when docker is not available', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockImplementation(() => {
        throw new Error('spawn docker ENOENT');
      });

      await expect(
        verifyConditions({} as OciPluginConfig, makeContext(tmpDir)),
      ).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));

      fs.rmSync(tmpDir, { recursive: true });
    });

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

    it('should verify the bake file instead of the Dockerfile in bake mode', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      fs.writeFileSync(
        path.join(tmpDir, 'docker-bake.hcl'),
        'group "release" {}',
      );

      await expect(
        verifyConditions(
          { dockerBake: { group: 'release' } } as OciPluginConfig,
          makeContext(tmpDir),
        ),
      ).resolves.toBeUndefined();

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

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock.mock.calls[0][0]).toEqual(['version']);

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

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock.mock.calls[0][0]).toEqual(['version']);

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

    it('should fall back to package.json name when dockerImage is not set', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'fallback-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions({} as OciPluginConfig, makeContext(tmpDir)),
      ).resolves.toBeUndefined();

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should log a verification summary on success', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      const context = makeContext(tmpDir);

      await verifyConditions({} as OciPluginConfig, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Verified: image="my-app", dockerfile=/),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('prepare', () => {
    it('should store build state and log the built image with a scraped sha', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue(
        'writing image sha256:abcdef1234567890abcdef1234567890\n',
      );
      const context = makeContext(tmpDir);

      await prepare({ dockerImage: 'my-app' } as OciPluginConfig, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('sha: abcdef123456'),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should fall back to the buildId when no sha is in build output', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('Step 1/1 : FROM alpine\n');
      const context = makeContext(tmpDir);

      await prepare({ dockerImage: 'my-app' } as OciPluginConfig, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/sha: [a-f0-9]{20}/),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should resolve image name and project from a scoped package.json', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, '@myorg/my-app');
      writeDockerfile(tmpDir);
      const context = makeContext(tmpDir);

      await prepare({} as OciPluginConfig, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Docker image built: myorg\/my-app:/),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should fall back to an empty image name with no config or package.json', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = makeContext(tmpDir);

      await prepare({ dockerTags: ['latest'] } as OciPluginConfig, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Docker image built: :/),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should handle missing nextRelease gracefully', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('');

      await expect(
        prepare(
          { dockerImage: 'my-app', dockerTags: ['latest'] } as OciPluginConfig,
          makeContext(tmpDir, {}, { nextRelease: undefined }),
        ),
      ).resolves.toBeUndefined();

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should propagate build errors', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockImplementation(() => {
        throw new Error('build failed');
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

    it('should delegate finalization to the strategy for standard builds', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      await prepare({} as OciPluginConfig, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish({} as OciPluginConfig, context);

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.filter((a) => a[0] === 'tag').length).toBe(3);
      expect(allArgs.filter((a) => a[0] === 'push').length).toBe(3);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should publish with a fallback empty image name', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      const cfg = {
        dockerTags: ['latest'],
        dockerAutoClean: false,
      } as OciPluginConfig;
      await prepare(cfg, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish(cfg, context);

      const allArgs = execMock.mock.calls.map((c) => c[0] as string[]);
      expect(allArgs.filter((a) => a[0] === 'push').length).toBe(1);

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should resolve the repo from a scoped package.json on publish', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, '@myorg/my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = makeContext(tmpDir);
      await prepare({ dockerAutoClean: false } as OciPluginConfig, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish({ dockerAutoClean: false } as OciPluginConfig, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Published: myorg\/my-app \(tags: /),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should log a published summary on success', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
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

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Published: my-app \(tags: /),
      );

      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
