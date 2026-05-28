import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { execSync } from 'child_process';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { SemanticReleaseContext } from '../../src/lib/types.js';

const execSyncMock = jest.fn<typeof execSync>();

jest.unstable_mockModule('child_process', () => ({
  execSync: execSyncMock,
}));

const { BuildStrategy } = await import('../../src/lib/build-strategy.js');

function makeContext(
  env: Record<string, string | undefined> = {},
): SemanticReleaseContext {
  return {
    cwd: '/work',
    env,
    logger: { log: jest.fn(), error: jest.fn() },
  };
}

function makeStrategy(
  pluginConfig: Partial<OciPluginConfig> = {},
  env: Record<string, string | undefined> = {},
): {
  strategy: InstanceType<typeof BuildStrategy>;
  context: SemanticReleaseContext;
} {
  const context = makeContext(env);
  const config = new OciConfig(pluginConfig as OciPluginConfig, env);
  return { strategy: new BuildStrategy(config, context), context };
}

describe('ImageStrategy', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue('build output\n');
  });

  afterEach(() => {
    execSyncMock.mockReset();
  });

  describe('exec', () => {
    it('should join args into a "docker <args>" command string', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['build', '--quiet']);

      expect(execSyncMock.mock.calls[0][0]).toBe('docker build --quiet');
    });

    it('should use the context cwd, input, and timeout', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['login', '--password-stdin'], {
        input: 'secret',
        timeout: 1234,
      });

      expect(execSyncMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          cwd: '/work',
          input: 'secret',
          timeout: 1234,
        }),
      );
    });

    it('should default the timeout when none is provided', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['version']);

      expect(execSyncMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({ timeout: 600_000 }),
      );
    });

    it('should use inherit stdio when requested', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['push', 'repo:tag'], { stdio: 'inherit' });

      expect(execSyncMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({ stdio: 'inherit' }),
      );
    });

    it('should use piped stdio by default', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.exec(['build']);

      expect(execSyncMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('should return the execSync stdout', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      expect(strategy.exec(['build'])).toBe('build output\n');
    });

    it('should return an empty string when execSync returns non-string output', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execSyncMock.mockReturnValue(Buffer.from('binary'));

      expect(strategy.exec(['build'])).toBe('');
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
      execSyncMock.mockImplementation(() => {
        throw new Error('spawn docker ENOENT');
      });

      expect(() => strategy.verifyDocker()).toThrow(
        expect.objectContaining({ code: 'ENOENT' }),
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

      expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('should be a no-op when no credentials are present', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.login();

      expect(execSyncMock).not.toHaveBeenCalled();
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

      expect(execSyncMock.mock.calls[0][0]).toBe(
        'docker login -u user --password-stdin',
      );
      expect(execSyncMock.mock.calls[0][1]).toEqual(
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

      expect(execSyncMock.mock.calls[0][0]).toBe(
        'docker login ghcr.io -u user --password-stdin',
      );
    });

    it('should use GITHUB_TOKEN as the password fallback', () => {
      const { strategy } = makeStrategy(
        { dockerImage: 'x' },
        { DOCKER_REGISTRY_USER: 'user', GITHUB_TOKEN: 'gh-token' },
      );

      strategy.login();

      expect(execSyncMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({ input: 'gh-token' }),
      );
    });
  });
});
