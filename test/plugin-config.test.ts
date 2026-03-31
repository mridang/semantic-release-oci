import { describe, it, expect } from '@jest/globals';
import { OciConfig, OciPluginConfig } from '../src/plugin-config.js';

function makeConfig(
  overrides: Partial<OciPluginConfig> = {},
  env: Record<string, string | undefined> = {},
): OciConfig {
  return new OciConfig(overrides as OciPluginConfig, env);
}

describe('OciConfig', () => {
  describe('defaults', () => {
    it('should return default values when no config is provided', () => {
      const config = makeConfig();
      expect(config.getDockerFile()).toBe('Dockerfile');
      expect(config.getDockerRegistry()).toBeUndefined();
      expect(config.getDockerImage()).toBeUndefined();
      expect(config.getDockerProject()).toBeUndefined();
      expect(config.getDockerTags()).toEqual([
        'latest',
        '{{major}}-latest',
        '{{version}}',
      ]);
      expect(config.getDockerArgs()).toEqual({});
      expect(config.getDockerBuildFlags()).toEqual({});
      expect(config.getDockerPlatform()).toEqual([]);
      expect(config.isPublishEnabled()).toBe(true);
      expect(config.isLoginEnabled()).toBe(true);
      expect(config.getDockerContext()).toBe('.');
      expect(config.getDockerNetwork()).toBeUndefined();
      expect(config.isAutoCleanEnabled()).toBe(true);
      expect(config.isBuildQuiet()).toBe(true);
      expect(config.isNoCacheEnabled()).toBe(false);
      expect(config.getDockerBuildCacheFrom()).toEqual([]);
      expect(config.isBuildxEnabled()).toBe(false);
    });
  });

  describe('overrides', () => {
    it('should use provided values over defaults', () => {
      const config = makeConfig({
        dockerFile: 'custom.Dockerfile',
        dockerRegistry: 'ghcr.io',
        dockerImage: 'my-app',
        dockerProject: 'my-org',
        dockerTags: ['v{{version}}', 'stable'],
        dockerPublish: false,
        dockerLogin: false,
        dockerContext: 'build',
        dockerNetwork: 'host',
        dockerAutoClean: false,
        dockerBuildQuiet: false,
        dockerNoCache: true,
      });
      expect(config.getDockerFile()).toBe('custom.Dockerfile');
      expect(config.getDockerRegistry()).toBe('ghcr.io');
      expect(config.getDockerImage()).toBe('my-app');
      expect(config.getDockerProject()).toBe('my-org');
      expect(config.getDockerTags()).toEqual(['v{{version}}', 'stable']);
      expect(config.isPublishEnabled()).toBe(false);
      expect(config.isLoginEnabled()).toBe(false);
      expect(config.getDockerContext()).toBe('build');
      expect(config.getDockerNetwork()).toBe('host');
      expect(config.isAutoCleanEnabled()).toBe(false);
      expect(config.isBuildQuiet()).toBe(false);
      expect(config.isNoCacheEnabled()).toBe(true);
    });
  });

  describe('tags parsing', () => {
    it('should split comma-separated string tags', () => {
      const config = makeConfig({ dockerTags: 'latest,v{{version}},stable' });
      expect(config.getDockerTags()).toEqual([
        'latest',
        'v{{version}}',
        'stable',
      ]);
    });

    it('should handle array tags as-is', () => {
      const config = makeConfig({ dockerTags: ['a', 'b'] });
      expect(config.getDockerTags()).toEqual(['a', 'b']);
    });
  });

  describe('platform parsing', () => {
    it('should split comma-separated platform string', () => {
      const config = makeConfig({
        dockerPlatform: 'linux/amd64,linux/arm64',
      });
      expect(config.getDockerPlatform()).toEqual([
        'linux/amd64',
        'linux/arm64',
      ]);
      expect(config.isBuildxEnabled()).toBe(true);
    });

    it('should handle array platforms', () => {
      const config = makeConfig({
        dockerPlatform: ['linux/amd64'],
      });
      expect(config.getDockerPlatform()).toEqual(['linux/amd64']);
      expect(config.isBuildxEnabled()).toBe(true);
    });

    it('should treat empty platform as buildx disabled', () => {
      const config = makeConfig({ dockerPlatform: [] });
      expect(config.isBuildxEnabled()).toBe(false);
    });
  });

  describe('cache-from parsing', () => {
    it('should split comma-separated cache-from string', () => {
      const config = makeConfig({
        dockerBuildCacheFrom: 'type=local,src=/tmp,type=registry,ref=foo',
      });
      expect(config.getDockerBuildCacheFrom()).toEqual([
        'type=local',
        'src=/tmp',
        'type=registry',
        'ref=foo',
      ]);
    });

    it('should handle array cache-from', () => {
      const config = makeConfig({
        dockerBuildCacheFrom: ['type=local,src=/tmp'],
      });
      expect(config.getDockerBuildCacheFrom()).toEqual(['type=local,src=/tmp']);
    });
  });

  describe('credentials', () => {
    it('should detect credentials from env', () => {
      const config = makeConfig(
        {},
        {
          DOCKER_REGISTRY_USER: 'user',
          DOCKER_REGISTRY_PASSWORD: 'pass',
        },
      );
      expect(config.hasCredentials()).toBe(true);
      expect(config.hasCompleteCredentials()).toBe(true);
      expect(config.getRegistryUser()).toBe('user');
      expect(config.getRegistryPassword()).toBe('pass');
    });

    it('should fall back to GITHUB_TOKEN for password', () => {
      const config = makeConfig(
        {},
        {
          DOCKER_REGISTRY_USER: 'user',
          GITHUB_TOKEN: 'gh-token',
        },
      );
      expect(config.hasCompleteCredentials()).toBe(true);
      expect(config.getRegistryPassword()).toBe('gh-token');
    });

    it('should detect partial credentials', () => {
      const config = makeConfig(
        {},
        {
          DOCKER_REGISTRY_USER: 'user',
        },
      );
      expect(config.hasCredentials()).toBe(true);
      expect(config.hasCompleteCredentials()).toBe(false);
    });

    it('should detect no credentials', () => {
      const config = makeConfig({}, {});
      expect(config.hasCredentials()).toBe(false);
      expect(config.hasCompleteCredentials()).toBe(false);
    });
  });
});
