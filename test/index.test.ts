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
import { dockerSpy, failure } from './utils/runner.js';
import { makeTempDir, removeTempDirs } from './utils/tmpdir.js';
import { stepContext } from './utils/context.js';
import type { Runner } from '../src/utils/exec.js';

const execMock = dockerSpy();
const runMock = jest.fn<Runner>();

const actualExec = await import('../src/utils/exec.js');

jest.unstable_mockModule('../src/utils/exec.js', () => ({
  ...actualExec,
  run: runMock,
}));

const { verifyConditions, prepare, publish } = await import('../src/index.js');

function writePackageJson(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
}

function writeDockerfile(dir: string, content = 'FROM alpine'): void {
  fs.writeFileSync(path.join(dir, 'Dockerfile'), content);
}

afterEach(removeTempDirs);

describe('semantic-release-oci', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockReturnValue('');
    runMock.mockReset();
    runMock.mockImplementation((_file, args, options) =>
      execMock(args, options),
    );
  });

  describe('verifyConditions', () => {
    it('should throw ENOENT when docker is not available', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockImplementation(() => {
        throw Object.assign(new Error('spawn docker ENOENT'), {
          code: 'ENOENT',
        });
      });

      await expect(verifyConditions({}, stepContext(tmpDir))).rejects.toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );
    });

    it('should throw EINVAL when no image name can be determined', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);

      await expect(verifyConditions({}, stepContext(tmpDir))).rejects.toThrow(
        expect.objectContaining({ code: 'EINVAL' }),
      );
    });

    it('should throw ENOENT when Dockerfile does not exist', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');

      await expect(verifyConditions({}, stepContext(tmpDir))).rejects.toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
      );
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
          { dockerBake: { group: 'release' } },
          stepContext(tmpDir),
        ),
      ).resolves.toBeUndefined();
    });

    it('should succeed without credentials when login is disabled', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions({ dockerLogin: false }, stepContext(tmpDir)),
      ).resolves.toBeUndefined();

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock.mock.calls[0][0]).toEqual(['version']);
    });

    it('should skip login when credentials are present but login is disabled', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions(
          { dockerLogin: false },
          stepContext(tmpDir, {
            DOCKER_REGISTRY_USER: 'user',
            DOCKER_REGISTRY_PASSWORD: 'pass',
          }),
        ),
      ).resolves.toBeUndefined();

      expect(execMock).toHaveBeenCalledTimes(1);
      expect(execMock.mock.calls[0][0]).toEqual(['version']);
    });

    it('should use dockerImage from config over package.json', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions({ dockerImage: 'custom-image' }, stepContext(tmpDir)),
      ).resolves.toBeUndefined();
    });

    it('should fall back to package.json name when dockerImage is not set', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'fallback-app');
      writeDockerfile(tmpDir);

      await expect(
        verifyConditions({}, stepContext(tmpDir)),
      ).resolves.toBeUndefined();
    });

    it('should log a verification summary on success', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      const context = stepContext(tmpDir);

      await verifyConditions({}, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Verified: image="my-app", dockerfile=/),
      );
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
      const context = stepContext(tmpDir);

      await prepare({ dockerImage: 'my-app' }, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringContaining('sha: abcdef123456'),
      );
    });

    it('should render the default channel, reported as null, as empty', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = stepContext(
        tmpDir,
        {},
        {
          nextRelease: {
            version: '1.2.3',
            gitTag: 'v1.2.3',
            gitHead: 'abc1234',
            channel: null,
            type: 'minor',
          },
        },
      );

      await prepare(
        { dockerImage: 'my-app', dockerTags: ['{{channel}}x'] },
        context,
      );

      expect(execMock.mock.calls[0][0]).toContain('my-app:x');
    });

    it('should render missing version parts as empty', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = stepContext(
        tmpDir,
        {},
        {
          nextRelease: {
            version: '4',
            gitTag: 'v4',
            gitHead: 'abc1234',
            channel: 'next',
            type: 'major',
          },
        },
      );

      await prepare(
        {
          dockerImage: 'my-app',
          dockerTags: ['{{major}}-{{minor}}-{{patch}}'],
        },
        context,
      );

      expect(execMock.mock.calls[0][0]).toContain('my-app:4--');
    });

    it('should resolve paths from the process cwd when the context has none', async () => {
      const context = stepContext('/unused', {}, { cwd: undefined });

      await prepare({ dockerImage: 'my-app' }, context);

      expect(execMock.mock.calls[0][0]).toContain(
        path.resolve(process.cwd(), 'Dockerfile'),
      );
    });

    it('should fall back to the buildId when no sha is in build output', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('Step 1/1 : FROM alpine\n');
      const context = stepContext(tmpDir);

      await prepare({ dockerImage: 'my-app' }, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/sha: [a-f0-9]{20}/),
      );
    });

    it('should resolve image name and project from a scoped package.json', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, '@myorg/my-app');
      writeDockerfile(tmpDir);
      const context = stepContext(tmpDir);

      await prepare({}, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Docker image built: myorg\/my-app:/),
      );
    });

    it('should fall back to an empty image name with no config or package.json', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = stepContext(tmpDir);

      await prepare({ dockerTags: ['latest'] }, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Docker image built: :/),
      );
    });

    it('should propagate build errors', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockImplementation(() => {
        throw failure('build failed');
      });

      await expect(
        prepare({ dockerImage: 'my-app' }, stepContext(tmpDir)),
      ).rejects.toThrow('build failed');
    });
  });

  describe('publish', () => {
    it.each([null, false])(
      'should tag and push as a plain build when dockerBake is %j',
      async (dockerBake) => {
        const tmpDir = makeTempDir();
        writeDockerfile(tmpDir);
        const config = JSON.parse(
          JSON.stringify({
            dockerImage: 'no-bake',
            dockerTags: ['1.2.3'],
            dockerBake,
          }),
        );
        const context = stepContext(tmpDir);

        await prepare(config, context);
        await publish(config, context);

        const commands = execMock.mock.calls.map(([args]) => args[0]);
        expect(commands).toEqual(['build', 'tag', 'push', 'images']);
      },
    );

    it('should consume the build state so a second publish is skipped', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = stepContext(tmpDir);
      await prepare({ dockerImage: 'consumed' }, context);
      await publish({ dockerImage: 'consumed' }, context);
      execMock.mockClear();

      await publish({ dockerImage: 'consumed' }, context);

      expect(execMock).not.toHaveBeenCalled();
      expect(context.logger.log).toHaveBeenLastCalledWith(
        'This release was already published. Skipping publish.',
      );
    });

    it('should keep two plugin entries for one image in one directory apart', async () => {
      const dir = makeTempDir();
      writeDockerfile(dir);
      fs.writeFileSync(path.join(dir, 'Dockerfile.alpine'), 'FROM alpine');
      const first = { dockerImage: 'twin', dockerTags: ['A{{version}}'] };
      const second = {
        dockerImage: 'twin',
        dockerFile: 'Dockerfile.alpine',
        dockerTags: ['B{{version}}'],
      };
      const context = stepContext(dir);
      await prepare(first, context);
      await prepare(second, context);
      execMock.mockClear();

      await publish(first, context);
      await publish(second, context);

      const pushed = execMock.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === 'push')
        .map((args) => args[1]);
      expect(pushed).toEqual(['twin:A1.2.3', 'twin:B1.2.3']);
    });

    it('should not publish a build of another release version', async () => {
      const dir = makeTempDir();
      writeDockerfile(dir);
      const config = { dockerImage: 'versions' };
      await prepare(config, stepContext(dir));
      execMock.mockClear();

      await expect(
        publish(
          config,
          stepContext(
            dir,
            {},
            {
              nextRelease: {
                version: '1.2.4',
                gitTag: 'v1.2.4',
                gitHead: 'abc1234',
                channel: '',
                type: 'patch',
              },
            },
          ),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'ENOBUILD' }));

      expect(execMock).not.toHaveBeenCalled();
    });

    it('should refuse to publish when the prepare of this release failed', async () => {
      const dir = makeTempDir();
      writeDockerfile(dir);
      const config = { dockerImage: 'stale' };
      const context = stepContext(dir);
      await prepare(config, context);
      execMock.mockImplementation(() => {
        throw failure('build failed');
      });
      await expect(prepare(config, context)).rejects.toThrow('build failed');
      execMock.mockReturnValue('');
      execMock.mockClear();

      await expect(publish(config, context)).rejects.toThrow(
        expect.objectContaining({ code: 'ENOBUILD' }),
      );

      expect(execMock).not.toHaveBeenCalled();
    });

    it('should publish after a prepare that was retried successfully', async () => {
      const dir = makeTempDir();
      writeDockerfile(dir);
      const config = { dockerImage: 'retried', dockerTags: ['1.2.3'] };
      const context = stepContext(dir);
      execMock.mockImplementationOnce(() => {
        throw failure('build failed');
      });
      await expect(prepare(config, context)).rejects.toThrow('build failed');
      await prepare(config, context);
      execMock.mockClear();

      await publish(config, context);

      expect(execMock.mock.calls.map(([args]) => args[0])).toContain('push');
    });

    it('should keep the build when publishing fails so that it can be retried', async () => {
      const dir = makeTempDir();
      writeDockerfile(dir);
      const config = { dockerImage: 'flaky', dockerTags: ['1.2.3'] };
      const context = stepContext(dir);
      await prepare(config, context);
      execMock.mockImplementationOnce(() => {
        throw failure('registry unavailable');
      });
      await expect(publish(config, context)).rejects.toThrow(
        'registry unavailable',
      );
      execMock.mockClear();

      await publish(config, context);

      expect(execMock.mock.calls.map(([args]) => args[0])).toContain('push');
    });

    it('should keep builds of the same repository from different directories apart', async () => {
      const first = makeTempDir();
      const second = makeTempDir();
      writeDockerfile(first);
      writeDockerfile(second);
      const config = { dockerImage: 'shared', dockerTags: ['1.2.3'] };
      await prepare(config, stepContext(first));
      await prepare(config, stepContext(second));
      const [firstTag] = execMock.mock.calls
        .filter(([args]) => args[0] === 'build')
        .map(([args]) => args[args.indexOf('--tag') + 1]);
      execMock.mockClear();

      await publish(config, stepContext(first));

      expect(execMock.mock.calls[0][0]).toEqual([
        'tag',
        firstTag,
        'shared:1.2.3',
      ]);
    });

    it('should fail when no image was built for this release and entry', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = stepContext(tmpDir);

      await expect(
        publish({ dockerImage: 'no-build-state' }, context),
      ).rejects.toThrow(expect.objectContaining({ code: 'ENOBUILD' }));

      expect(execMock).not.toHaveBeenCalled();
    });

    it('should fail when prepare and publish use different configuration', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      const context = stepContext(tmpDir);
      await prepare({ dockerImage: 'mismatch' }, context);
      execMock.mockClear();

      await expect(
        publish({ dockerImage: 'mismatch', dockerTags: ['other'] }, context),
      ).rejects.toThrow(expect.objectContaining({ code: 'ENOBUILD' }));

      expect(execMock).not.toHaveBeenCalled();
    });

    it('should delegate finalization to the strategy for standard builds', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = stepContext(tmpDir);
      await prepare({}, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish({}, context);

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.filter((a) => a[0] === 'tag').length).toBe(3);
      expect(allArgs.filter((a) => a[0] === 'push').length).toBe(3);
    });

    it('should publish with a fallback empty image name', async () => {
      const tmpDir = makeTempDir();
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = stepContext(tmpDir);
      const cfg = {
        dockerTags: ['latest'],
        dockerAutoClean: false,
      };
      await prepare(cfg, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish(cfg, context);

      const allArgs = execMock.mock.calls.map((c) => c[0]);
      expect(allArgs.filter((a) => a[0] === 'push').length).toBe(1);
    });

    it('should resolve the repo from a scoped package.json on publish', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, '@myorg/my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = stepContext(tmpDir);
      await prepare({ dockerAutoClean: false }, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish({ dockerAutoClean: false }, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Published: myorg\/my-app \(tags: /),
      );
    });

    it('should log a published summary on success', async () => {
      const tmpDir = makeTempDir();
      writePackageJson(tmpDir, 'my-app');
      writeDockerfile(tmpDir);
      execMock.mockReturnValue('writing image sha256:abc123\n');

      const context = stepContext(tmpDir);
      await prepare({ dockerImage: 'my-app', dockerAutoClean: false }, context);

      execMock.mockClear();
      execMock.mockReturnValue('');

      await publish({ dockerImage: 'my-app', dockerAutoClean: false }, context);

      expect(context.logger.log).toHaveBeenCalledWith(
        expect.stringMatching(/^Published: my-app \(tags: /),
      );
    });
  });
});
