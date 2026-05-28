import type { Config } from 'semantic-release';

/**
 * Raw plugin configuration as provided by the user in their
 * semantic-release config file. All fields are optional and fall
 * back to sensible defaults when omitted.
 */
export interface OciPluginConfig extends Config {
  readonly dockerFile?: string;
  readonly dockerRegistry?: string;
  readonly dockerImage?: string;
  readonly dockerProject?: string;
  readonly dockerTags?: string | string[];
  readonly dockerArgs?: Record<string, string | boolean>;
  readonly dockerBuildFlags?: Record<string, string | string[] | null>;
  readonly dockerPlatform?: string | string[];
  readonly dockerPublish?: boolean;
  readonly dockerLogin?: boolean;
  readonly dockerContext?: string;
  readonly dockerNetwork?: string;
  readonly dockerAutoClean?: boolean;
  readonly dockerBuildQuiet?: boolean;
  readonly dockerNoCache?: boolean;
  readonly dockerBuildCacheFrom?: string | string[];
  readonly dockerTimeout?: number;
  readonly dockerBake?: {
    readonly file?: string;
    readonly group?: string;
    readonly target?: string;
    readonly imageTarget?: string;
  };
}

/**
 * OciConfig wraps the raw plugin config and environment variables,
 * exposing derived values and safe defaults. It centralizes option
 * reading so the plugin code stays small and consistent.
 */
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

  /**
   * Path to the Dockerfile relative to the project root.
   *
   * @returns Dockerfile path, defaulting to `"Dockerfile"`.
   */
  getDockerFile(): string {
    return this.config.dockerFile ?? 'Dockerfile';
  }

  /**
   * Docker registry hostname such as `ghcr.io` or `docker.io`.
   *
   * @returns Registry string or `undefined`.
   */
  getDockerRegistry(): string | undefined {
    return this.config.dockerRegistry;
  }

  /**
   * Docker image name without registry or project prefix.
   *
   * @returns Image name or `undefined`.
   */
  getDockerImage(): string | undefined {
    return this.config.dockerImage;
  }

  /**
   * Project or organization segment inserted between registry and
   * image name in the full repository path.
   *
   * @returns Project name or `undefined`.
   */
  getDockerProject(): string | undefined {
    return this.config.dockerProject;
  }

  /**
   * Tag templates applied to the built image. Supports `{{variable}}`
   * placeholders resolved at build time.
   *
   * @returns Array of tag template strings.
   */
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

  /**
   * Build arguments passed via `--build-arg`. String values support
   * template rendering; boolean `true` passes the key without a value.
   *
   * @returns Key-value map of build arguments.
   */
  getDockerArgs(): Record<string, string | boolean> {
    return this.config.dockerArgs ?? {};
  }

  /**
   * Extra flags forwarded directly to `docker build`. Keys are
   * normalized to `--kebab-case`. A `null` value emits the flag
   * without an argument.
   *
   * @returns Key-value map of build flags.
   */
  getDockerBuildFlags(): Record<string, string | string[] | null> {
    return this.config.dockerBuildFlags ?? {};
  }

  /**
   * Target platforms for multi-architecture builds via `docker buildx`.
   *
   * @returns Array of platform strings such as `"linux/amd64"`.
   */
  getDockerPlatform(): string[] {
    const platform = this.config.dockerPlatform ?? [];
    if (typeof platform === 'string') {
      return platform.split(/\s*,\s*/);
    }
    return platform;
  }

  /**
   * Whether the image should be pushed to the registry during publish.
   *
   * @returns `true` unless explicitly disabled.
   */
  isPublishEnabled(): boolean {
    return this.config.dockerPublish !== false;
  }

  /**
   * Whether Docker registry login should be attempted when credentials
   * are present.
   *
   * @returns `true` unless explicitly disabled.
   */
  isLoginEnabled(): boolean {
    return this.config.dockerLogin !== false;
  }

  /**
   * Build context directory relative to the project root.
   *
   * @returns Context path, defaulting to `"."`.
   */
  getDockerContext(): string {
    return this.config.dockerContext ?? '.';
  }

  /**
   * Docker network used during the build. When not configured, no
   * `--network` flag is passed, which allows both Docker and Podman
   * to use their own default networking.
   *
   * @returns Network name or `undefined`.
   */
  getDockerNetwork(): string | undefined {
    return this.config.dockerNetwork;
  }

  /**
   * Whether local images should be removed after a successful push.
   *
   * @returns `true` unless explicitly disabled.
   */
  isAutoCleanEnabled(): boolean {
    return this.config.dockerAutoClean !== false;
  }

  /**
   * Whether `--quiet` is passed to `docker build` to suppress output.
   *
   * @returns `true` unless explicitly disabled.
   */
  isBuildQuiet(): boolean {
    return this.config.dockerBuildQuiet !== false;
  }

  /**
   * Whether `--no-cache` is passed to `docker build`.
   *
   * @returns `true` only when explicitly enabled.
   */
  isNoCacheEnabled(): boolean {
    return this.config.dockerNoCache === true;
  }

  /**
   * Cache sources passed via `--cache-from` to `docker build`.
   *
   * @returns Array of cache source strings.
   */
  getDockerBuildCacheFrom(): string[] {
    const cacheFrom = this.config.dockerBuildCacheFrom;
    if (!cacheFrom) return [];
    if (typeof cacheFrom === 'string') {
      return cacheFrom.split(/\s*,\s*/);
    }
    return cacheFrom;
  }

  /**
   * Timeout in milliseconds for each Docker CLI invocation.
   *
   * @returns Configured timeout, defaulting to 600 000 ms (10 minutes).
   */
  getDockerTimeout(): number {
    return this.config.dockerTimeout ?? 600_000;
  }

  /**
   * Whether `docker buildx build` should be used instead of plain
   * `docker build`. Enabled automatically when platforms are specified.
   *
   * @returns `true` when at least one platform is configured.
   */
  isBuildxEnabled(): boolean {
    return this.getDockerPlatform().length > 0;
  }

  /**
   * Docker Bake settings. When present, the build step drives
   * `docker buildx bake` instead of `docker buildx build`, so a single
   * bake group can produce several outputs (for example a pushed image
   * and host-exported binaries) from one shared build. The bake file
   * path defaults to `docker-bake.hcl`, and the tag-injection target
   * defaults to the configured `target`, or `*` (all targets) when only
   * a `group` is given.
   *
   * @returns Normalized bake settings, or `undefined` when not set.
   */
  getDockerBake():
    | {
        readonly file: string;
        readonly group: string | undefined;
        readonly target: string | undefined;
        readonly imageTarget: string;
      }
    | undefined {
    const bake = this.config.dockerBake;
    if (!bake) {
      return undefined;
    }
    return {
      file: bake.file ?? 'docker-bake.hcl',
      group: bake.group,
      target: bake.target,
      imageTarget: bake.imageTarget ?? bake.target ?? '*',
    };
  }

  /**
   * Whether Docker Bake mode is enabled via the `dockerBake` option.
   *
   * @returns `true` when bake settings are present.
   */
  isBakeEnabled(): boolean {
    return this.config.dockerBake !== undefined;
  }

  /**
   * Registry username from the `DOCKER_REGISTRY_USER` env variable.
   *
   * @returns Username or `undefined`.
   */
  getRegistryUser(): string | undefined {
    return this.env.DOCKER_REGISTRY_USER;
  }

  /**
   * Registry password from `DOCKER_REGISTRY_PASSWORD`, falling back
   * to `GITHUB_TOKEN` when the password variable is not set.
   *
   * @returns Password or `undefined`.
   */
  getRegistryPassword(): string | undefined {
    return this.env.DOCKER_REGISTRY_PASSWORD ?? this.env.GITHUB_TOKEN;
  }

  /**
   * Whether any credential variable (user or password) is present.
   *
   * @returns `true` when at least one credential is set.
   */
  hasCredentials(): boolean {
    return (
      this.getRegistryUser() !== undefined ||
      this.getRegistryPassword() !== undefined
    );
  }

  /**
   * Whether both username and password are present, forming a
   * complete credential pair suitable for `docker login`.
   *
   * @returns `true` when both are set.
   */
  hasCompleteCredentials(): boolean {
    return (
      this.getRegistryUser() !== undefined &&
      this.getRegistryPassword() !== undefined
    );
  }
}
