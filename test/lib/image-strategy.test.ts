import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { execFileSync } from 'node:child_process';
import type { setSecret } from '@actions/core';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { VerifyConditionsContext } from 'semantic-release';
import { stepContext } from '../utils/context.js';

const execFileSyncMock = jest.fn<typeof execFileSync>();
const setSecretMock = jest.fn<typeof setSecret>();

jest.unstable_mockModule('@actions/core', () => ({
  setSecret: setSecretMock,
}));

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const { BuildStrategy } = await import('../../src/lib/build-strategy.js');

function makeStrategy(
  pluginConfig: OciPluginConfig = {},
  env: Record<string, string> = {},
): {
  strategy: InstanceType<typeof BuildStrategy>;
  context: VerifyConditionsContext;
} {
  const context = stepContext('/work', env);
  const config = new OciConfig(pluginConfig, env);
  return { strategy: new BuildStrategy(config, context), context };
}

describe('ImageStrategy', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    setSecretMock.mockReset();
    execFileSyncMock.mockReturnValue('build output\n');
  });

  afterEach(() => {
    execFileSyncMock.mockReset();
    setSecretMock.mockReset();
  });

  describe('exec', () => {
    it('should run docker with the args as an argv array, not a shell string', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['build', '--quiet']);

      expect(execFileSyncMock.mock.calls[0][0]).toBe('docker');
      expect(execFileSyncMock.mock.calls[0][1]).toEqual(['build', '--quiet']);
    });

    it('should keep shell metacharacters in one argument', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      const arg = 'MSG=hello world; touch /tmp/pwned $(id) `id` *';

      strategy.exec(['build', '--build-arg', arg]);

      expect(execFileSyncMock.mock.calls[0][1]).toEqual([
        'build',
        '--build-arg',
        arg,
      ]);
      expect(execFileSyncMock.mock.calls[0][2]).not.toHaveProperty('shell');
    });

    it('should use the context cwd, input, and timeout', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['login', '--password-stdin'], {
        input: 'secret',
        timeout: 1234,
      });

      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          cwd: '/work',
          input: 'secret',
          timeout: 1234,
        }),
      );
    });

    it('should run in the process cwd when the context has none', () => {
      const context = stepContext('/work', {}, { cwd: undefined });
      const strategy = new BuildStrategy(new OciConfig({}, {}), context);

      strategy.exec(['version']);

      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({ cwd: process.cwd() }),
      );
    });

    it('should default the timeout when none is provided', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['version']);

      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({ timeout: 600_000 }),
      );
    });

    it('should allow far more output than the default 1 MiB buffer', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['build']);

      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({ maxBuffer: 256 * 1024 * 1024 }),
      );
    });

    it('should use inherit stdio when requested', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['push', 'repo:tag'], { stdio: 'inherit' });

      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({ stdio: 'inherit' }),
      );
    });

    it('should use piped stdio by default', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['build']);

      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('should return the stdout', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      expect(strategy.exec(['build'])).toBe('build output\n');
    });

    it('should return an empty string when docker returns non-string output', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockReturnValue(Buffer.from('binary'));

      expect(strategy.exec(['build'])).toBe('');
    });

    it('should mask build-arg values in the logged command, keeping the argv intact', () => {
      const { strategy, context } = makeStrategy({ dockerImage: 'x' });

      strategy.exec([
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

      expect(context.logger.log).toHaveBeenCalledWith(
        'Executing: docker build --build-arg TOKEN=*** --build-arg FLAG --set *.args.TOKEN=*** --set image.tags=repo:1',
      );
      expect(execFileSyncMock.mock.calls[0][1]).toContain('TOKEN=s3cr3t');
    });

    it('should mask a value that contains = and .args. from the first =', () => {
      const { strategy, context } = makeStrategy({ dockerImage: 'x' });

      strategy.exec([
        'buildx',
        'bake',
        '--set',
        '*.args.TOKEN=abc.args.k=tail',
      ]);

      expect(context.logger.log).toHaveBeenCalledWith(
        'Executing: docker buildx bake --set *.args.TOKEN=***',
      );
    });

    it('should mask the joined --build-arg= and --set= forms', () => {
      const { strategy, context } = makeStrategy({ dockerImage: 'x' });

      strategy.exec([
        'build',
        '--build-arg=TOKEN=JOINEDSECRET',
        '--set=*.args.TOKEN=SETSECRET',
      ]);

      expect(context.logger.log).toHaveBeenCalledWith(
        'Executing: docker build --build-arg=TOKEN=*** --set=*.args.TOKEN=***',
      );
    });

    it('should mask credentials inside cache specs, flags and the login user', () => {
      const { strategy, context } = makeStrategy({ dockerImage: 'x' });

      strategy.exec([
        'build',
        '--cache-from',
        'type=s3,bucket=b,secret_access_key=S3SECRET',
        '--cache-to',
        `type=registry,ref=user:REGPASS${'@'}ghcr.io/x/y`,
        '--auth-token',
        'FLAGSECRET',
        '--password=JOINEDFLAGSECRET',
      ]);
      strategy.exec(['login', '-u', 'token-as-user', '--password-stdin']);

      expect(context.logger.log).toHaveBeenNthCalledWith(
        1,
        'Executing: docker build --cache-from type=s3,bucket=b,secret_access_key=*** --cache-to type=registry,ref=user:***@ghcr.io/x/y --auth-token *** --password=***',
      );
      expect(context.logger.log).toHaveBeenNthCalledWith(
        2,
        'Executing: docker login -u *** --password-stdin',
      );
    });

    it('should register every secret with the Actions log masker', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['build', '--build-arg', 'TOKEN=s3cr3t']);

      expect(setSecretMock).toHaveBeenCalledWith('s3cr3t');
    });

    it('should not scrub values shorter than three characters by value', () => {
      const { strategy, context } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['build', '--build-arg', 'N=1', '--tag', 'repo:1']);

      expect(context.logger.log).toHaveBeenCalledWith(
        'Executing: docker build --build-arg N=*** --tag repo:1',
      );
      expect(setSecretMock).not.toHaveBeenCalled();
    });

    it('should scrub a secret that docker echoes on stderr', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('Command failed: docker build'), {
          status: 1,
          stderr: '#6 [2/2] RUN echo "using s3cr3t" && false',
        });
      });

      expect(() =>
        strategy.exec(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).toThrow(
        'Command failed: docker build --build-arg TOKEN=***\n#6 [2/2] RUN echo "using ***" && false',
      );
    });

    it('should keep the status, signal and code on the rebuilt error', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('Command failed: with s3cr3t'), {
          status: 3,
          signal: 'SIGTERM',
          stderr: 'denied',
        });
      });

      expect(() =>
        strategy.exec(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).toThrow(
        expect.objectContaining({
          status: 3,
          signal: 'SIGTERM',
          message: 'Command failed: docker build --build-arg TOKEN=***\ndenied',
        }),
      );
    });

    it('should report a failure to run by its code, never by its message', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockImplementation(() => {
        throw Object.assign(
          new TypeError('The argument must be a string. Received TOKEN=s3cr3t'),
          { code: 'ERR_INVALID_ARG_VALUE' },
        );
      });

      expect(() =>
        strategy.exec(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).toThrow(
        expect.objectContaining({
          code: 'ERR_INVALID_ARG_VALUE',
          message:
            'Command failed: docker build --build-arg TOKEN=***\nERR_INVALID_ARG_VALUE',
        }),
      );
    });

    it.each([
      ['an error without stderr or code', new Error('Command failed: s3cr3t')],
      ['an error with a different wording', new Error('boom s3cr3t')],
    ])('should report only the command for %s', (_name, thrown) => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockImplementation(() => {
        throw thrown;
      });

      expect(() =>
        strategy.exec(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).toThrow(/^Command failed: docker build --build-arg TOKEN=\*\*\*$/);
    });

    it('should scrub a thrown non-error', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockImplementation(() => {
        throw 'plain s3cr3t';
      });

      expect(() =>
        strategy.exec(['build', '--build-arg', 'TOKEN=s3cr3t']),
      ).toThrow(
        'Command failed: docker build --build-arg TOKEN=***\nplain ***',
      );
    });

    it('should reject a NUL byte before logging or running anything', () => {
      const { strategy, context } = makeStrategy({ dockerImage: 'x' });

      expect(() =>
        strategy.exec(['build', '--build-arg', 'TOKEN=s3\0cr3t']),
      ).toThrow('Docker argument 2 contains a NUL byte.');
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(context.logger.log).not.toHaveBeenCalled();
    });

    it('should pass values literally: no $VAR, ~ or shell quotes are interpreted', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      const args = [
        'build',
        '--secret',
        'id=npm,src=$HOME/.npmrc',
        '--build-arg',
        'DIR=~/work',
        '--build-arg',
        'MSG="hello world"',
      ];

      strategy.exec(args);

      expect(execFileSyncMock.mock.calls[0][1]).toEqual(args);
    });

    it('should log the executed command', () => {
      const { strategy, context } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['version']);

      expect(context.logger.log).toHaveBeenCalledWith(
        'Executing: docker version',
      );
    });
  });

  describe('verifyDocker', () => {
    it('should resolve when docker is available', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      expect(() => strategy.verifyDocker()).not.toThrow();
    });

    it('should throw ENOENT when docker is unavailable', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('spawnSync docker ENOENT'), {
          code: 'ENOENT',
        });
      });

      expect(() => strategy.verifyDocker()).toThrow(
        'Docker is not installed or not available in PATH. Ensure Docker is installed and accessible.',
      );
    });

    it('should rethrow any other failure with its detail', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: 'Cannot connect to the Docker daemon',
        });
      });

      expect(() => strategy.verifyDocker()).toThrow(
        'Command failed: docker version\nCannot connect to the Docker daemon',
      );
    });
  });

  describe('login', () => {
    it('should be a no-op when login is disabled', () => {
      const { strategy } = makeStrategy(
        { dockerLogin: false },
        { DOCKER_REGISTRY_USER: 'user', DOCKER_REGISTRY_PASSWORD: 'pass' },
      );

      strategy.login();

      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('should be a no-op when no credentials are present', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.login();

      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('should throw EAUTH when only GITHUB_TOKEN is present', () => {
      const { strategy } = makeStrategy(
        { dockerImage: 'x' },
        { GITHUB_TOKEN: 'gh-token' },
      );

      expect(() => strategy.login()).toThrow(
        expect.objectContaining({ code: 'EAUTH' }),
      );
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('should throw EAUTH when only a username is provided', () => {
      const { strategy } = makeStrategy(
        { dockerImage: 'x' },
        { DOCKER_REGISTRY_USER: 'user' },
      );

      expect(() => strategy.login()).toThrow(
        expect.objectContaining({ code: 'EAUTH' }),
      );
    });

    it('should run docker login with the password on stdin', () => {
      const { strategy, context } = makeStrategy(
        { dockerImage: 'x' },
        { DOCKER_REGISTRY_USER: 'user', DOCKER_REGISTRY_PASSWORD: 'pass' },
      );

      strategy.login();

      expect(execFileSyncMock.mock.calls[0][1]).toEqual([
        'login',
        '-u',
        'user',
        '--password-stdin',
      ]);
      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({ input: 'pass' }),
      );
      expect(context.logger.log).toHaveBeenCalledWith(
        'Docker login successful.',
      );
    });

    it('should include the registry host when configured', () => {
      const { strategy } = makeStrategy(
        { dockerImage: 'x', dockerRegistry: 'ghcr.io' },
        { DOCKER_REGISTRY_USER: 'user', DOCKER_REGISTRY_PASSWORD: 'pass' },
      );

      strategy.login();

      expect(execFileSyncMock.mock.calls[0][1]).toEqual([
        'login',
        'ghcr.io',
        '-u',
        'user',
        '--password-stdin',
      ]);
    });

    it('should use GITHUB_TOKEN as the password fallback', () => {
      const { strategy } = makeStrategy(
        { dockerImage: 'x' },
        { DOCKER_REGISTRY_USER: 'user', GITHUB_TOKEN: 'gh-token' },
      );

      strategy.login();

      expect(execFileSyncMock.mock.calls[0][2]).toEqual(
        expect.objectContaining({ input: 'gh-token' }),
      );
    });
  });
});
