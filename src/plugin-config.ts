import type { Config } from 'semantic-release';

export interface OciPluginConfig extends Config {
  dockerFile?: string;
  dockerRegistry?: string;
  dockerImage?: string;
  dockerProject?: string;
  dockerTags?: string | string[];
  dockerArgs?: Record<string, string | boolean>;
  dockerBuildFlags?: Record<string, string | string[] | null>;
  dockerPlatform?: string | string[];
  dockerPublish?: boolean;
  dockerLogin?: boolean;
  dockerContext?: string;
  dockerNetwork?: string;
  dockerAutoClean?: boolean;
  dockerBuildQuiet?: boolean;
  dockerNoCache?: boolean;
  dockerBuildCacheFrom?: string | string[];
}

export class OciConfig {
  private readonly config: OciPluginConfig;
  private readonly env: Record<string, string | undefined>;

  constructor(
    config: OciPluginConfig,
    env: Record<string, string | undefined>,
  ) {
    this.config = config;
    this.env = env;
  }

  getDockerFile(): string {
    return this.config.dockerFile ?? 'Dockerfile';
  }

  getDockerRegistry(): string | undefined {
    return this.config.dockerRegistry ?? undefined;
  }

  getDockerImage(): string | undefined {
    return this.config.dockerImage ?? undefined;
  }

  getDockerProject(): string | undefined {
    return this.config.dockerProject ?? undefined;
  }

  getDockerTags(): string[] {
    const tags = this.config.dockerTags ?? [
      'latest',
      '{{major}}-latest',
      '{{version}}',
    ];
    if (typeof tags === 'string') {
      return tags.split(/\s*,\s*/);
    }
    return tags;
  }

  getDockerArgs(): Record<string, string | boolean> {
    return this.config.dockerArgs ?? {};
  }

  getDockerBuildFlags(): Record<string, string | string[] | null> {
    return this.config.dockerBuildFlags ?? {};
  }

  getDockerPlatform(): string[] {
    const platform = this.config.dockerPlatform ?? [];
    if (typeof platform === 'string') {
      return platform.split(/\s*,\s*/);
    }
    return platform;
  }

  isPublishEnabled(): boolean {
    return this.config.dockerPublish !== false;
  }

  isLoginEnabled(): boolean {
    return this.config.dockerLogin !== false;
  }

  getDockerContext(): string {
    return this.config.dockerContext ?? '.';
  }

  getDockerNetwork(): string {
    return this.config.dockerNetwork ?? 'default';
  }

  isAutoCleanEnabled(): boolean {
    return this.config.dockerAutoClean !== false;
  }

  isBuildQuiet(): boolean {
    return this.config.dockerBuildQuiet !== false;
  }

  isNoCacheEnabled(): boolean {
    return this.config.dockerNoCache === true;
  }

  getDockerBuildCacheFrom(): string[] {
    const cacheFrom = this.config.dockerBuildCacheFrom;
    if (!cacheFrom) return [];
    if (typeof cacheFrom === 'string') {
      return cacheFrom.split(/\s*,\s*/);
    }
    return cacheFrom;
  }

  isBuildxEnabled(): boolean {
    return this.getDockerPlatform().length > 0;
  }

  getRegistryUser(): string | undefined {
    return this.env.DOCKER_REGISTRY_USER;
  }

  getRegistryPassword(): string | undefined {
    return this.env.DOCKER_REGISTRY_PASSWORD ?? this.env.GITHUB_TOKEN;
  }

  hasCredentials(): boolean {
    return (
      this.getRegistryUser() !== undefined ||
      this.getRegistryPassword() !== undefined
    );
  }

  hasCompleteCredentials(): boolean {
    return (
      this.getRegistryUser() !== undefined &&
      this.getRegistryPassword() !== undefined
    );
  }
}
