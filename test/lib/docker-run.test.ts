import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  assertDockerAvailable,
  dockerRun,
  type DockerRun,
} from '../../src/lib/docker-run.js';
import fs from 'node:fs';
import path from 'node:path';
import { dockerSpy, failure, runnerOf } from '../utils/runner.js';
import { makeTempDir, removeTempDirs } from '../utils/tmpdir.js';

const spy = dockerSpy();

/**
 * A docker runner on top of the spy, and the logger it writes to.
 */
function setup(
  env: Readonly<Record<string, string>> = {},
  timeoutMs = 600_000,
): { docker: DockerRun; log: jest.Mock } {
  const log = jest.fn();
  return {
    docker: dockerRun({
      cwd: '/work',
      env: { GITHUB_ACTIONS: 'false', ...env },
      timeoutMs,
      logger: { log },
      run: runnerOf(spy),
    }),
    log,
  };
}

afterEach(removeTempDirs);

beforeEach(() => {
  spy.mockReset();
  spy.mockReturnValue('');
});

describe('dockerRun', () => {
  describe('running docker', () => {
    it('runs docker with the args as an argv array and returns stdout', async () => {
      const { docker } = setup();
      spy.mockReturnValue('out\n');

      expect(await docker(['build', 'a b; c'])).toBe('out\n');
      expect(spy.mock.calls[0][0]).toEqual(['build', 'a b; c']);
    });

    it('passes the directory, environment, input and timeout to the runner', async () => {
      const { docker } = setup({ A: 'b' }, 1234);

      await docker(['login'], 'pass');

      expect(spy.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          cwd: '/work',
          env: { GITHUB_ACTIONS: 'false', A: 'b' },
          input: 'pass',
          timeout: 1234,
        }),
      );
    });

    it('logs the executed command', async () => {
      const { docker, log } = setup();

      await docker(['version']);

      expect(log).toHaveBeenCalledWith('Executing: docker version');
    });

    it('rejects a NUL byte before logging or running anything', async () => {
      const { docker, log } = setup();

      await expect(
        docker(['build', '--build-arg', 'TOKEN=s3\0cr3t']),
      ).rejects.toThrow('Docker argument 2 contains a NUL byte.');
      expect(spy).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('hiding secrets in the logged command', () => {
    it('masks build-arg values by position, keeping the argv intact', async () => {
      const { docker, log } = setup();

      await docker([
        'build',
        '--build-arg',
        'TOKEN=s3cr3t',
        '--build-arg',
        'FLAG',
        '--set',
        '*.args.TOKEN=s3cr3t',
        '--set',
        'image.tags=repo:1',
      ]);

      expect(log).toHaveBeenCalledWith(
        'Executing: docker build --build-arg TOKEN=[redacted] --build-arg FLAG --set *.args.TOKEN=[redacted] --set image.tags=repo:1',
      );
      expect(spy.mock.calls[0][0]).toContain('TOKEN=s3cr3t');
    });

    it('masks a value that contains = and .args. from the first =', async () => {
      const { docker, log } = setup();

      await docker(['buildx', 'bake', '--set', '*.args.TOKEN=abc.args.k=tail']);

      expect(log).toHaveBeenCalledWith(
        'Executing: docker buildx bake --set *.args.TOKEN=[redacted]',
      );
    });

    it('masks the joined --build-arg= and --set= forms', async () => {
      const { docker, log } = setup();

      await docker([
        'build',
        '--build-arg=TOKEN=JOINEDSECRET',
        '--set=*.args.TOKEN=SETSECRET',
      ]);

      expect(log).toHaveBeenCalledWith(
        'Executing: docker build --build-arg=TOKEN=[redacted] --set=*.args.TOKEN=[redacted]',
      );
    });

    it('masks credentials inside cache specs and flags, and the login user', async () => {
      const { docker, log } = setup();

      await docker([
        'build',
        '--cache-from',
        'type=s3,bucket=b,secret_access_key=S3SECRET',
        '--cache-to',
        `type=registry,ref=user:REGPASS${'@'}ghcr.io/x/y`,
        '--auth-token',
        'FLAGSECRET',
        '--password=JOINEDFLAGSECRET',
      ]);
      await docker(['login', '-u', 'token-as-user', '--password-stdin']);

      expect(log).toHaveBeenNthCalledWith(
        1,
        'Executing: docker build --cache-from type=s3,bucket=b,secret_access_key=[redacted] --cache-to type=registry,ref=user:[redacted]@ghcr.io/x/y --auth-token [redacted] --password=[redacted]',
      );
      expect(log).toHaveBeenNthCalledWith(
        2,
        'Executing: docker login -u [redacted] --password-stdin',
      );
    });

    it('keeps tags, versions, labels and digests readable', async () => {
      const { docker, log } = setup();

      await docker([
        'build',
        '--tag',
        'ghcr.io/org/app:1.2.3',
        '--cache-from',
        'type=registry,ref=ghcr.io/o/a:latest@sha256:abcdef0123',
        '--label',
        'authors=Bob Smith',
        '--secret',
        'id=npm,src=.npmrc',
      ]);

      expect(log).toHaveBeenCalledWith(
        'Executing: docker build --tag ghcr.io/org/app:1.2.3 --cache-from type=registry,ref=ghcr.io/o/a:latest@sha256:abcdef0123 --label authors=Bob Smith --secret id=npm,src=.npmrc',
      );
    });

    it('checks a very long cache spec in linear time', async () => {
      const { docker } = setup();
      const started = performance.now();

      await docker([
        'build',
        '--cache-from',
        `type=registry,ref=${'a'.repeat(200_000)}`,
      ]);

      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  describe('Actions log masker', () => {
    it('registers secrets with it on GitHub Actions', async () => {
      const { docker } = setup({ GITHUB_ACTIONS: 'true' });
      const write = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      await docker(['build', '--build-arg', 'TOKEN=s3cr3t']);

      const written = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      write.mockRestore();
      expect(written).toContain('::add-mask::s3cr3t');
    });

    it('never writes a secret to stdout anywhere else', async () => {
      const { docker } = setup();
      const write = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      await docker(['build', '--build-arg', 'TOKEN=s3cr3t']);

      const written = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      write.mockRestore();
      expect(written).not.toContain('s3cr3t');
      expect(written).not.toContain('::add-mask::');
    });
  });

  describe('hiding secrets in errors', () => {
    it('scrubs a secret that docker echoes on stderr', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw failure('#6 [2/2] RUN echo "using s3cr3t" && false');
      });

      await expect(
        docker(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).rejects.toThrow(
        'Command failed: docker build --build-arg TOKEN=[redacted]\n#6 [2/2] RUN echo "using [redacted]" && false',
      );
    });

    it('scrubs what a --secret mount reads from the environment or a file', async () => {
      const log = jest.fn();
      const docker = dockerRun({
        cwd: '/work',
        env: { GITHUB_ACTIONS: 'false', MYSECRET: 'MountSecretVal777' },
        timeoutMs: 1000,
        logger: { log },
        run: runnerOf(spy),
        readFile: (file) =>
          file === 'tok.txt' ? 'FileSecretVal888\n' : undefined,
      });
      spy.mockImplementation(() => {
        throw failure('secretmount=MountSecretVal777 file=FileSecretVal888');
      });

      await expect(
        docker([
          'build',
          '--secret',
          'id=a,env=MYSECRET',
          '--secret=id=b,src=tok.txt',
        ]),
      ).rejects.toThrow(/\nsecretmount=\[redacted\] file=\[redacted\]$/);
    });

    it('reads --secret files relative to the working directory by default', async () => {
      const dir = makeTempDir();
      fs.writeFileSync(path.join(dir, 'tok.txt'), 'FileSecretVal888');
      const docker = dockerRun({
        cwd: dir,
        env: { GITHUB_ACTIONS: 'false' },
        timeoutMs: 1000,
        logger: { log: jest.fn() },
        run: runnerOf(spy),
      });
      spy.mockImplementation(() => {
        throw failure('file=FileSecretVal888');
      });

      await expect(
        docker(['build', '--secret', 'id=b,src=tok.txt']),
      ).rejects.toThrow(/file=\[redacted\]$/);
      await expect(
        docker(['build', '--secret', 'id=b,src=missing']),
      ).rejects.toThrow(/file=FileSecretVal888$/);
    });

    it('scrubs the text sent on stdin', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw failure('unauthorized: bad password registry-password');
      });

      await expect(
        docker(['login', '-u', 'user'], 'registry-password'),
      ).rejects.toThrow(/\nunauthorized: bad password \[redacted\]$/);
    });

    it('scrubs a literal build arg whatever its name, but not public ones', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw failure('pat=PatValueABCDEF12 ver=22.1.0');
      });

      await expect(
        docker([
          'build',
          '--build-arg',
          'GH_PAT=PatValueABCDEF12',
          '--build-arg',
          'NODE_VERSION=22.1.0',
        ]),
      ).rejects.toThrow(/\npat=\[redacted\] ver=22\.1\.0$/);
    });

    it('scrubs a short value only when its name says it is a credential', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw failure('tok=ab12 other=cd34');
      });

      await expect(
        docker([
          'build',
          '--build-arg',
          'NPM_TOKEN=ab12',
          '--build-arg',
          'OTHER=cd34',
        ]),
      ).rejects.toThrow(/\ntok=\[redacted\] other=cd34$/);
    });

    it('scrubs a build arg that docker takes from the environment', async () => {
      const { docker } = setup({ NPM_TOKEN: 'REALSECRET9999' });
      spy.mockImplementation(() => {
        throw failure('#5 RUN echo "using REALSECRET9999" && false');
      });

      await expect(
        docker(['build', '--build-arg', 'NPM_TOKEN']),
      ).rejects.toThrow(/using \[redacted\]" && false$/);
    });

    it('keeps public release variables and common words readable', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw failure('exporting sha256:abcdef0123 as 1.2.3');
      });

      await expect(
        docker([
          'build',
          '--build-arg',
          'VERSION=1.2.3',
          '--build-arg',
          'NODE_VERSION=22.1.0',
          '--build-arg',
          'DEBUG=production',
        ]),
      ).rejects.toThrow(/\nexporting sha256:abcdef0123 as 1\.2\.3$/);
    });

    it('scrubs each line of a multi-line secret, and its base64 and URL-encoded forms', async () => {
      const { docker } = setup();
      const pem = 'LINEONESECRET\nLINE TWO SECRET';
      spy.mockImplementation(() => {
        throw failure(
          [
            '#6 0.1 LINEONESECRET',
            '#6 0.1 LINE TWO SECRET',
            `#6 0.2 ${Buffer.from(pem).toString('base64')}`,
            `#6 0.3 ${encodeURIComponent(pem)}`,
          ].join('\n'),
        );
      });

      await expect(
        docker(['build', '--build-arg', `PRIVATE_KEY=${pem}`]),
      ).rejects.toThrow(
        /\n#6 0\.1 \[redacted\]\n#6 0\.1 \[redacted\]\n#6 0\.2 \[redacted\]\n#6 0\.3 \[redacted\]$/,
      );
    });

    it('fails with an EDOCKER error that keeps the status, signal and cause', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw Object.assign(new Error('Command failed: with s3cr3t'), {
          status: 3,
          signal: 'SIGTERM',
          stderr: 'denied',
        });
      });

      await expect(docker(['push', 'app:1'])).rejects.toThrow(
        expect.objectContaining({
          name: 'SemanticReleaseError',
          code: 'EDOCKER',
          status: 3,
          signal: 'SIGTERM',
          message:
            'Command failed: docker push app:1\nkilled by SIGTERM\ndenied',
        }),
      );
    });

    it('keeps both the code and the stderr of a command that timed out', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), {
          code: 'ETIMEDOUT',
          stderr: '#4 [1/2] RUN sleep 9999 using s3cr3t',
        });
      });

      await expect(
        docker(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).rejects.toThrow(
        expect.objectContaining({
          code: 'EDOCKER',
          errno: 'ETIMEDOUT',
          message: expect.stringMatching(
            /\nETIMEDOUT\n#4 \[1\/2\] RUN sleep 9999 using \[redacted\]$/,
          ),
        }),
      );
    });

    it('reports a failure to run by its code, never by its message', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw Object.assign(
          new TypeError('The argument must be a string. Received s3cr3t'),
          { code: 'ERR_INVALID_ARG_VALUE' },
        );
      });

      await expect(docker(['push', 'app:1'])).rejects.toThrow(
        expect.objectContaining({
          errno: 'ERR_INVALID_ARG_VALUE',
          message: 'Command failed: docker push app:1\nERR_INVALID_ARG_VALUE',
        }),
      );
    });

    it.each([
      ['an error without stderr or code', new Error('Command failed: s3cr3t')],
      ['an error with a different wording', new Error('boom s3cr3t')],
    ])('reports only the command for %s', async (_name, thrown) => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw thrown;
      });

      await expect(
        docker(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).rejects.toThrow(
        /^Command failed: docker build --build-arg TOKEN=\[redacted\]$/,
      );
    });

    it('scrubs a thrown non-error', async () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw 'plain s3cr3t';
      });

      await expect(
        docker(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).rejects.toThrow(/\nplain \[redacted\]$/);
    });
  });
});

describe('assertDockerAvailable', () => {
  it('passes when docker answers', async () => {
    const { docker } = setup();

    await expect(assertDockerAvailable(docker)).resolves.not.toThrow();
  });

  it('maps a missing binary to ENOENT', async () => {
    const { docker } = setup();
    spy.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync docker ENOENT'), {
        code: 'ENOENT',
      });
    });

    await expect(assertDockerAvailable(docker)).rejects.toThrow(
      expect.objectContaining({
        code: 'ENOENT',
        message:
          'Docker is not installed or not available in PATH. Ensure Docker is installed and accessible.',
      }),
    );
  });

  it('rethrows any other failure with its detail', async () => {
    const { docker } = setup();
    spy.mockImplementation(() => {
      throw failure('Cannot connect to the Docker daemon');
    });

    await expect(assertDockerAvailable(docker)).rejects.toThrow(
      'Command failed: docker version\nCannot connect to the Docker daemon',
    );
  });
});
