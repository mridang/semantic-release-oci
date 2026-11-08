import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  assertDockerAvailable,
  dockerRun,
  type DockerRun,
} from '../../src/lib/docker-run.js';
import { dockerSpy, failure, runnerOf } from '../utils/runner.js';

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

beforeEach(() => {
  spy.mockReset();
  spy.mockReturnValue('');
});

describe('dockerRun', () => {
  describe('running docker', () => {
    it('runs docker with the args as an argv array and returns stdout', () => {
      const { docker } = setup();
      spy.mockReturnValue('out\n');

      expect(docker(['build', 'a b; c'])).toBe('out\n');
      expect(spy.mock.calls[0][0]).toEqual(['build', 'a b; c']);
    });

    it('passes the directory, environment, input and timeout to the runner', () => {
      const { docker } = setup({ A: 'b' }, 1234);

      docker(['login'], 'pass');

      expect(spy.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          cwd: '/work',
          env: { GITHUB_ACTIONS: 'false', A: 'b' },
          input: 'pass',
          timeout: 1234,
        }),
      );
    });

    it('logs the executed command', () => {
      const { docker, log } = setup();

      docker(['version']);

      expect(log).toHaveBeenCalledWith('Executing: docker version');
    });

    it('rejects a NUL byte before logging or running anything', () => {
      const { docker, log } = setup();

      expect(() => docker(['build', '--build-arg', 'TOKEN=s3\0cr3t'])).toThrow(
        'Docker argument 2 contains a NUL byte.',
      );
      expect(spy).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('hiding secrets in the logged command', () => {
    it('masks build-arg values by position, keeping the argv intact', () => {
      const { docker, log } = setup();

      docker([
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
        'Executing: docker build --build-arg TOKEN=*** --build-arg FLAG --set *.args.TOKEN=*** --set image.tags=repo:1',
      );
      expect(spy.mock.calls[0][0]).toContain('TOKEN=s3cr3t');
    });

    it('masks a value that contains = and .args. from the first =', () => {
      const { docker, log } = setup();

      docker(['buildx', 'bake', '--set', '*.args.TOKEN=abc.args.k=tail']);

      expect(log).toHaveBeenCalledWith(
        'Executing: docker buildx bake --set *.args.TOKEN=***',
      );
    });

    it('masks the joined --build-arg= and --set= forms', () => {
      const { docker, log } = setup();

      docker([
        'build',
        '--build-arg=TOKEN=JOINEDSECRET',
        '--set=*.args.TOKEN=SETSECRET',
      ]);

      expect(log).toHaveBeenCalledWith(
        'Executing: docker build --build-arg=TOKEN=*** --set=*.args.TOKEN=***',
      );
    });

    it('masks credentials inside cache specs and flags, and the login user', () => {
      const { docker, log } = setup();

      docker([
        'build',
        '--cache-from',
        'type=s3,bucket=b,secret_access_key=S3SECRET',
        '--cache-to',
        `type=registry,ref=user:REGPASS${'@'}ghcr.io/x/y`,
        '--auth-token',
        'FLAGSECRET',
        '--password=JOINEDFLAGSECRET',
      ]);
      docker(['login', '-u', 'token-as-user', '--password-stdin']);

      expect(log).toHaveBeenNthCalledWith(
        1,
        'Executing: docker build --cache-from type=s3,bucket=b,secret_access_key=[redacted] --cache-to type=registry,ref=user:[redacted]@ghcr.io/x/y --auth-token [redacted] --password=[redacted]',
      );
      expect(log).toHaveBeenNthCalledWith(
        2,
        'Executing: docker login -u *** --password-stdin',
      );
    });

    it('keeps tags, versions, labels and digests readable', () => {
      const { docker, log } = setup();

      docker([
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

    it('checks a very long cache spec in linear time', () => {
      const { docker } = setup();
      const started = performance.now();

      docker([
        'build',
        '--cache-from',
        `type=registry,ref=${'a'.repeat(200_000)}`,
      ]);

      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  describe('Actions log masker', () => {
    it('registers secrets with it on GitHub Actions', () => {
      const { docker } = setup({ GITHUB_ACTIONS: 'true' });
      const write = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      docker(['build', '--build-arg', 'TOKEN=s3cr3t']);

      const written = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      write.mockRestore();
      expect(written).toContain('::add-mask::s3cr3t');
    });

    it('never writes a secret to stdout anywhere else', () => {
      const { docker } = setup();
      const write = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);

      docker(['build', '--build-arg', 'TOKEN=s3cr3t']);

      const written = write.mock.calls.map(([chunk]) => String(chunk)).join('');
      write.mockRestore();
      expect(written).not.toContain('s3cr3t');
      expect(written).not.toContain('::add-mask::');
    });
  });

  describe('hiding secrets in errors', () => {
    it('scrubs a secret that docker echoes on stderr', () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw failure('#6 [2/2] RUN echo "using s3cr3t" && false');
      });

      expect(() => docker(['build', '--build-arg', 'TOKEN=s3cr3t'])).toThrow(
        'Command failed: docker build --build-arg TOKEN=***\n#6 [2/2] RUN echo "using [redacted]" && false',
      );
    });

    it('scrubs a build arg that docker takes from the environment', () => {
      const { docker } = setup({ NPM_TOKEN: 'REALSECRET9999' });
      spy.mockImplementation(() => {
        throw failure('#5 RUN echo "using REALSECRET9999" && false');
      });

      expect(() => docker(['build', '--build-arg', 'NPM_TOKEN'])).toThrow(
        /using \[redacted\]" && false$/,
      );
    });

    it('does not take an unrelated build arg for a secret', () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw failure('exporting sha256:abcdef0123 as 1.2.3');
      });

      expect(() =>
        docker([
          'build',
          '--build-arg',
          'VERSION=1.2.3',
          '--build-arg',
          'A=abcdef',
        ]),
      ).toThrow(/\nexporting sha256:abcdef0123 as 1\.2\.3$/);
    });

    it('scrubs each line of a multi-line secret, and its base64 and URL-encoded forms', () => {
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

      expect(() =>
        docker(['build', '--build-arg', `PRIVATE_KEY=${pem}`]),
      ).toThrow(
        /\n#6 0\.1 \[redacted\]\n#6 0\.1 \[redacted\]\n#6 0\.2 \[redacted\]\n#6 0\.3 \[redacted\]$/,
      );
    });

    it('fails with an EDOCKER error that keeps the status, signal and cause', () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw Object.assign(new Error('Command failed: with s3cr3t'), {
          status: 3,
          signal: 'SIGTERM',
          stderr: 'denied',
        });
      });

      expect(() => docker(['push', 'app:1'])).toThrow(
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

    it('keeps both the code and the stderr of a command that timed out', () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw Object.assign(new Error('spawnSync docker ETIMEDOUT'), {
          code: 'ETIMEDOUT',
          stderr: '#4 [1/2] RUN sleep 9999 using s3cr3t',
        });
      });

      expect(() => docker(['build', '--build-arg', 'TOKEN=s3cr3t'])).toThrow(
        expect.objectContaining({
          code: 'EDOCKER',
          errno: 'ETIMEDOUT',
          message: expect.stringMatching(
            /\nETIMEDOUT\n#4 \[1\/2\] RUN sleep 9999 using \[redacted\]$/,
          ),
        }),
      );
    });

    it('reports a failure to run by its code, never by its message', () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw Object.assign(
          new TypeError('The argument must be a string. Received s3cr3t'),
          { code: 'ERR_INVALID_ARG_VALUE' },
        );
      });

      expect(() => docker(['push', 'app:1'])).toThrow(
        expect.objectContaining({
          errno: 'ERR_INVALID_ARG_VALUE',
          message: 'Command failed: docker push app:1\nERR_INVALID_ARG_VALUE',
        }),
      );
    });

    it.each([
      ['an error without stderr or code', new Error('Command failed: s3cr3t')],
      ['an error with a different wording', new Error('boom s3cr3t')],
    ])('reports only the command for %s', (_name, thrown) => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw thrown;
      });

      expect(() => docker(['build', '--build-arg', 'TOKEN=s3cr3t'])).toThrow(
        /^Command failed: docker build --build-arg TOKEN=\*\*\*$/,
      );
    });

    it('scrubs a thrown non-error', () => {
      const { docker } = setup();
      spy.mockImplementation(() => {
        throw 'plain s3cr3t';
      });

      expect(() => docker(['build', '--build-arg', 'TOKEN=s3cr3t'])).toThrow(
        /\nplain \[redacted\]$/,
      );
    });
  });
});

describe('assertDockerAvailable', () => {
  it('passes when docker answers', () => {
    const { docker } = setup();

    expect(() => assertDockerAvailable(docker)).not.toThrow();
  });

  it('maps a missing binary to ENOENT', () => {
    const { docker } = setup();
    spy.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync docker ENOENT'), {
        code: 'ENOENT',
      });
    });

    expect(() => assertDockerAvailable(docker)).toThrow(
      expect.objectContaining({
        code: 'ENOENT',
        message:
          'Docker is not installed or not available in PATH. Ensure Docker is installed and accessible.',
      }),
    );
  });

  it('rethrows any other failure with its detail', () => {
    const { docker } = setup();
    spy.mockImplementation(() => {
      throw failure('Cannot connect to the Docker daemon');
    });

    expect(() => assertDockerAvailable(docker)).toThrow(
      'Command failed: docker version\nCannot connect to the Docker daemon',
    );
  });
});
