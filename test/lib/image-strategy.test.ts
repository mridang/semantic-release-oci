import { describe, it, expect, beforeEach } from '@jest/globals';
import { BuildStrategy } from '../../src/lib/build-strategy.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { VerifyConditionsContext } from 'semantic-release';
import { stepContext } from '../utils/context.js';
import { dockerSpy, runnerOf } from '../utils/runner.js';

const execMock = dockerSpy();

function makeStrategy(
  pluginConfig: OciPluginConfig = {},
  env: Record<string, string> = {},
): {
  strategy: BuildStrategy;
  context: VerifyConditionsContext;
} {
  const context = stepContext('/work', env);
  const config = new OciConfig(pluginConfig, env);
  return {
    strategy: new BuildStrategy(config, context, runnerOf(execMock)),
    context,
  };
}

describe('ImageStrategy', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockReturnValue('');
  });

  describe('verifyDocker', () => {
    it('should resolve when docker is available', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      expect(() => strategy.verifyDocker()).not.toThrow();
    });

    it('should throw ENOENT when docker is unavailable', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });
      execMock.mockImplementation(() => {
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
      execMock.mockImplementation(() => {
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

      expect(execMock).not.toHaveBeenCalled();
    });

    it('should be a no-op when no credentials are present', () => {
      const { strategy } = makeStrategy({ dockerImage: 'x' });

      strategy.login();

      expect(execMock).not.toHaveBeenCalled();
    });

    it('should throw EAUTH when only GITHUB_TOKEN is present', () => {
      const { strategy } = makeStrategy(
        { dockerImage: 'x' },
        { GITHUB_TOKEN: 'gh-token' },
      );

      expect(() => strategy.login()).toThrow(
        expect.objectContaining({ code: 'EAUTH' }),
      );
      expect(execMock).not.toHaveBeenCalled();
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

      expect(execMock.mock.calls[0][0]).toEqual([
        'login',
        '-u',
        'user',
        '--password-stdin',
      ]);
      expect(execMock.mock.calls[0][1]).toEqual(
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

      expect(execMock.mock.calls[0][0]).toEqual([
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

      expect(execMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({ input: 'gh-token' }),
      );
    });
  });
});
