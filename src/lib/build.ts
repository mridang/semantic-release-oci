import type { DockerRun } from './docker-run.js';
import { Image } from './image.js';

/**
 * Matches the line of `docker build` output that names the image digest.
 */
const SHA_REGEX = /(?:writing image\s)?[^@]?(?:sha\d{3}):(?<sha>\w+)/i;

/**
 * A build argument: `value` is undefined for the form that takes the value
 * from the environment.
 */
interface BuildArg {
  /** The name of the build argument. */
  readonly key: string;
  /** The value, or undefined to take it from the environment. */
  readonly value: string | undefined;
}

/**
 * Everything `docker build` and `docker buildx build` need, decided by the
 * strategy.
 */
export interface BuildOptions {
  /** Use `docker buildx build`. */
  readonly buildx: boolean;
  /** Network to build in, when one is configured. */
  readonly network: string | undefined;
  /** Reference of the build's own image, for plain builds. */
  readonly buildTag: string | undefined;
  /** References to tag the image with while building. */
  readonly tags: readonly string[];
  /** Suppress the build output (`--quiet`). */
  readonly quiet: boolean;
  /** Ignore the build cache (`--no-cache`). */
  readonly noCache: boolean;
  /** Cache sources (`--cache-from`). */
  readonly cacheFrom: readonly string[];
  /** Build arguments (`--build-arg`). */
  readonly buildArgs: readonly BuildArg[];
  /** Extra user-supplied flags, by name. */
  readonly flags: Readonly<Record<string, string | string[] | null>>;
  /** Platforms of a buildx build. */
  readonly platforms: readonly string[];
  /** Push while building (buildx only). */
  readonly push: boolean;
  /** Path of the Dockerfile. */
  readonly dockerfile: string;
  /** Path of the build context. */
  readonly context: string;
}

/**
 * The name of a user-supplied flag: kept as it is when it starts with a dash,
 * otherwise `--kebab-case` (a single letter becomes `-x`).
 * @param key - The name from the configuration.
 * @returns The flag.
 */
function flagName(key: string): string {
  if (key.startsWith('-')) {
    return key;
  }
  const dashes = key.length === 1 ? '-' : '--';
  return `${dashes}${key.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * The arguments for user-supplied build flags. A `null` value emits the flag
 * alone and a list emits the flag once per value.
 * @param flags - Flag names mapped to a value, a list of values, or null.
 * @returns The arguments.
 */
function flagArgs(
  flags: Readonly<Record<string, string | string[] | null>>,
): readonly string[] {
  return Object.entries(flags).flatMap(([key, value]): string[] => {
    const flag = flagName(key);
    if (value === null) {
      return [flag];
    }
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((v) => [flag, v]);
  });
}

/**
 * The arguments that select platforms and pushing, for a buildx build.
 * @param options - What to build and how.
 * @returns The arguments, none for a plain build.
 */
function platformArgs(options: BuildOptions): readonly string[] {
  if (!options.buildx) {
    return [];
  }
  const push = options.push ? ['--push'] : [];
  return ['--platform', options.platforms.join(','), '--pull', ...push];
}

/**
 * The arguments of a build.
 * @param options - What to build and how.
 * @returns The arguments after `docker`.
 */
function buildArgsOf(options: BuildOptions): readonly string[] {
  const buildArgs = options.buildArgs.flatMap(({ key, value }) => {
    if (value === undefined) {
      return ['--build-arg', key];
    }
    return ['--build-arg', `${key}=${value}`];
  });
  return [
    ...(options.buildx ? ['buildx', 'build'] : ['build']),
    ...(options.network ? [`--network=${options.network}`] : []),
    ...(options.buildTag ? ['--tag', options.buildTag] : []),
    ...options.tags.flatMap((tag) => ['--tag', tag]),
    ...(options.quiet ? ['--quiet'] : []),
    ...(options.noCache ? ['--no-cache'] : []),
    ...options.cacheFrom.flatMap((source) => ['--cache-from', source]),
    ...buildArgs,
    ...flagArgs(options.flags),
    ...platformArgs(options),
    '-f',
    options.dockerfile,
    options.context,
  ];
}

/**
 * An image that has been built: it has an id, a digest and tags can be added
 * to it. Plain builds leave it as a local image; buildx builds push while
 * building.
 */
export class Build {
  /**
   * @param docker - Runs docker commands.
   * @param repository - Image repository path.
   * @param id - Id the build was tagged with.
   * @param digest - Digest hex of the image, or an empty string when it
   * cannot be determined.
   */
  constructor(
    private readonly docker: DockerRun,
    readonly repository: string,
    readonly id: string,
    readonly digest: string,
  ) {}

  /**
   * Builds an image.
   * @param docker - Runs docker commands.
   * @param repository - Image repository path.
   * @param id - Id the build is tagged with.
   * @param options - What to build and how.
   * @returns The built image, with the digest scraped from the output.
   */
  static async run(
    docker: DockerRun,
    repository: string,
    id: string,
    options: BuildOptions,
  ): Promise<Build> {
    const output = await docker(buildArgsOf(options));
    const digest = output
      .split('\n')
      .reduce<string>(
        (found, line) => SHA_REGEX.exec(line)?.groups?.['sha'] ?? found,
        '',
      );
    return new Build(docker, repository, id, digest);
  }

  /**
   * Adds a tag to the built image.
   * @param tag - The new tag.
   * @returns The image under that tag.
   */
  async tag(tag: string): Promise<Image> {
    await this.docker([
      'tag',
      `${this.repository}:${this.id}`,
      `${this.repository}:${tag}`,
    ]);
    return new Image(this.docker, this.repository, tag);
  }

  /**
   * Force-removes the local images of the repository.
   */
  async remove(): Promise<void> {
    const output = await this.docker(['images', this.repository, '-q']);
    const ids = output.trim();
    if (ids === '') {
      return;
    }
    await this.docker(['rmi', '-f', ...ids.split('\n')]);
  }
}
