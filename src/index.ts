import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import * as actions from '@actions/core';
import SemanticReleaseError from '@semantic-release/error';
import { OciConfig, OciPluginConfig } from './plugin-config.js';

const NAME_EXP = /^(?:@([^/]+)\/)?(.+)$/;
const SHA_REGEX = /(?:writing image\s)?[^@]?(?:sha\d{3}):(?<sha>\w+)/i;

/**
 * Internal state tracked for each built Docker image across the
 * prepare and publish lifecycle hooks.
 */
interface BuildState {
  readonly sha: string;
  readonly sha256: string;
  readonly buildId: string;
  readonly tags: readonly string[];
  readonly repo: string;
  readonly isBuildx: boolean;
}

/**
 * Simplified semantic-release context consumed by the plugin
 * lifecycle hooks. Only the fields used by this plugin are typed.
 */
interface SemanticReleaseContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly logger: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  readonly nextRelease?: {
    readonly version?: string;
    readonly gitTag?: string;
    readonly gitHead?: string;
    readonly channel?: string;
    readonly type?: string;
  };
  readonly lastRelease?: {
    readonly version?: string;
    readonly gitTag?: string;
    readonly gitHead?: string;
  };
  readonly options?: {
    readonly dryRun?: boolean;
  };
}

const buildStates = new Map<string, BuildState>();

/**
 * Replaces `{{variable}}` placeholders in a template string with
 * values from the provided variables map. Unknown variables resolve
 * to the empty string.
 *
 * @param template Template string containing `{{key}}` placeholders.
 * @param vars     Key-value map of replacement values.
 * @returns        The rendered string.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_match: string, key: string): string => {
      const value = vars[key];
      return value !== undefined ? String(value) : '';
    },
  );
}

function parsePkgName(pkgname: string): {
  scope: string | null;
  name: string | null;
} {
  const match = NAME_EXP.exec(pkgname);
  if (!match) return { scope: null, name: null };
  return { scope: match[1] ?? null, name: match[2] ?? null };
}

function readPkg(cwd: string): { name?: string } | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
}

function buildImageRepo(
  registry: string | undefined,
  project: string | undefined,
  name: string,
): string {
  return [registry, project, name].filter(Boolean).join('/');
}

/**
 * Executes Docker CLI commands via `child_process.execSync`. Exported
 * as a mutable object so tests can replace `.exec` without running
 * into ESM module immutability restrictions.
 */
export const commandRunner = {
  exec(
    args: string[],
    options: {
      cwd: string;
      input?: string;
      stdio?: 'inherit' | 'pipe';
    },
    logger: SemanticReleaseContext['logger'],
  ): string {
    const cmd = ['docker', ...args].join(' ');
    logger.log(`Executing: ${cmd}`);
    const result = execSync(cmd, {
      cwd: options.cwd,
      encoding: 'utf8',
      input: options.input,
      stdio: options.stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      timeout: 600000,
    });
    return typeof result === 'string' ? result : '';
  },
};

/**
 * Verifies that the Docker image name is resolvable, the Dockerfile
 * exists, and (when enabled) performs Docker registry login using
 * configured credentials.
 *
 * @param pluginConfig Raw plugin configuration from semantic-release.
 * @param context      Semantic-release context with env and logger.
 */
export async function verifyConditions(
  pluginConfig: OciPluginConfig,
  context: SemanticReleaseContext,
): Promise<void> {
  const config = new OciConfig(pluginConfig, context.env);

  try {
    commandRunner.exec(['version'], { cwd: context.cwd }, context.logger);
  } catch {
    throw new SemanticReleaseError(
      'Docker is not installed or not available in PATH. Ensure Docker is installed and accessible.',
      'ENOENT',
    );
  }

  const pkg = readPkg(context.cwd);
  const parsed = pkg?.name ? parsePkgName(pkg.name) : null;
  const imageName = config.getDockerImage() ?? parsed?.name;

  if (!imageName) {
    throw new SemanticReleaseError(
      'Docker image name is required. Set "dockerImage" in plugin config or ensure package.json has a name field.',
      'EINVAL',
    );
  }

  const dockerfile = path.resolve(context.cwd, config.getDockerFile());
  if (!fs.existsSync(dockerfile)) {
    throw new SemanticReleaseError(
      `Dockerfile not found at ${dockerfile}`,
      'ENOENT',
    );
  }

  if (config.isLoginEnabled() && config.hasCredentials()) {
    if (!config.hasCompleteCredentials()) {
      throw new SemanticReleaseError(
        'Docker login requires both DOCKER_REGISTRY_USER and DOCKER_REGISTRY_PASSWORD (or GITHUB_TOKEN) environment variables.',
        'EAUTH',
      );
    }

    const loginArgs = ['login'];
    const registry = config.getDockerRegistry();
    if (registry) loginArgs.push(registry);
    loginArgs.push('-u', config.getRegistryUser()!);
    loginArgs.push('--password-stdin');

    commandRunner.exec(
      loginArgs,
      {
        cwd: context.cwd,
        input: config.getRegistryPassword(),
      },
      context.logger,
    );

    context.logger.log('Docker login successful.');
  }

  context.logger.log(
    `Verified: image="${imageName}", dockerfile="${dockerfile}"`,
  );
}

/**
 * Builds a Docker image using the configured Dockerfile, tags, build
 * arguments, and optional buildx multi-platform support. Stores build
 * state in a module-level map for the subsequent publish step.
 *
 * @param pluginConfig Raw plugin configuration from semantic-release.
 * @param context      Semantic-release context with env and logger.
 */
export async function prepare(
  pluginConfig: OciPluginConfig,
  context: SemanticReleaseContext,
): Promise<void> {
  const config = new OciConfig(pluginConfig, context.env);
  const pkg = readPkg(context.cwd);
  const parsed = pkg?.name ? parsePkgName(pkg.name) : null;
  const imageName = config.getDockerImage() ?? parsed?.name ?? '';
  const project = config.getDockerProject() ?? parsed?.scope ?? undefined;
  const registry = config.getDockerRegistry();
  const repo = buildImageRepo(registry, project, imageName);
  const isDryRun = context.options?.dryRun === true;

  const version = context.nextRelease?.version ?? '';
  const [major = '', minor = '', patch = ''] = version.split('.');
  const vars: Record<string, string | number | undefined> = {
    version,
    major,
    minor,
    patch,
    gitTag: context.nextRelease?.gitTag ?? '',
    gitHead: context.nextRelease?.gitHead ?? '',
    channel: context.nextRelease?.channel ?? '',
    type: context.nextRelease?.type ?? '',
    now: new Date().toISOString(),
  };

  const tags = config
    .getDockerTags()
    .map((t) => renderTemplate(t, vars))
    .filter(Boolean);

  const buildId = crypto.randomBytes(10).toString('hex');
  const isBuildx = config.isBuildxEnabled();

  const args: string[] = [];

  if (isBuildx) {
    args.push('buildx', 'build');
  } else {
    args.push('build');
  }

  const network = config.getDockerNetwork();
  if (network) {
    args.push(`--network=${network}`);
  }

  if (!isBuildx) {
    args.push('--tag', `${repo}:${buildId}`);
  }

  if (!isDryRun) {
    for (const tag of tags) {
      args.push('--tag', `${repo}:${tag}`);
    }
  }

  if (config.isBuildQuiet()) {
    args.push('--quiet');
  }

  if (config.isNoCacheEnabled()) {
    args.push('--no-cache');
  }

  for (const source of config.getDockerBuildCacheFrom()) {
    args.push('--cache-from', source);
  }

  const dockerArgs = config.getDockerArgs();
  for (const [key, value] of Object.entries(dockerArgs)) {
    if (value === true) {
      args.push('--build-arg', key);
    } else {
      args.push('--build-arg', `${key}=${renderTemplate(String(value), vars)}`);
    }
  }

  const extraFlags = Object.entries(config.getDockerBuildFlags()).flatMap(
    ([key, value]): string[] => {
      const flag = key.startsWith('-')
        ? key
        : `${key.length === 1 ? '-' : '--'}${key.toLowerCase().replace(/_/g, '-')}`;
      if (value === null) return [flag];
      return (Array.isArray(value) ? value : [value]).flatMap((v) => [flag, v]);
    },
  );
  args.push(...extraFlags);

  if (isBuildx) {
    args.push('--platform', config.getDockerPlatform().join(','));
    args.push('--pull');
    if (config.isPublishEnabled() && !isDryRun) {
      args.push('--push');
    }
  }

  args.push('-f', path.resolve(context.cwd, config.getDockerFile()));
  args.push(path.resolve(context.cwd, config.getDockerContext()));

  const stdout = commandRunner.exec(
    args,
    { cwd: context.cwd, stdio: 'pipe' },
    context.logger,
  );

  const shaMatch = stdout
    .split('\n')
    .reverse()
    .reduce<string | undefined>(
      (found, line) => found ?? SHA_REGEX.exec(line)?.groups?.['sha'],
      undefined,
    );
  const sha256 = shaMatch ?? '';
  const sha = sha256 ? sha256.substring(0, 12) : buildId;

  buildStates.set(repo, {
    sha,
    sha256,
    buildId,
    tags,
    repo,
    isBuildx,
  });

  context.logger.log(`Docker image built: ${repo}:${buildId} (sha: ${sha})`);
}

/**
 * Tags and pushes the previously built Docker image to the configured
 * registry. Sets GitHub Actions outputs and optionally removes local
 * images after a successful push.
 *
 * @param pluginConfig Raw plugin configuration from semantic-release.
 * @param context      Semantic-release context with env and logger.
 */
export async function publish(
  pluginConfig: OciPluginConfig,
  context: SemanticReleaseContext,
): Promise<void> {
  const config = new OciConfig(pluginConfig, context.env);
  const pkg = readPkg(context.cwd);
  const parsed = pkg?.name ? parsePkgName(pkg.name) : null;
  const imageName = config.getDockerImage() ?? parsed?.name ?? '';
  const project = config.getDockerProject() ?? parsed?.scope ?? undefined;
  const registry = config.getDockerRegistry();
  const repo = buildImageRepo(registry, project, imageName);
  const state = buildStates.get(repo);

  if (!state) {
    context.logger.log('No build state found. Skipping publish.');
    return;
  }

  if (!state.isBuildx && config.isPublishEnabled()) {
    for (const tag of state.tags) {
      commandRunner.exec(
        ['tag', `${state.repo}:${state.buildId}`, `${state.repo}:${tag}`],
        { cwd: context.cwd },
        context.logger,
      );
      commandRunner.exec(
        ['push', `${state.repo}:${tag}`],
        { cwd: context.cwd, stdio: 'inherit' },
        context.logger,
      );
    }
  }

  try {
    actions.setOutput('docker_image', state.repo);
    actions.setOutput('docker_image_build_id', state.buildId);
    actions.setOutput('docker_image_sha_short', state.sha);
    actions.setOutput('docker_image_sha_long', state.sha256);
  } catch {
    /* ignored outside GitHub Actions */
  }

  if (config.isAutoCleanEnabled() && !state.isBuildx) {
    try {
      const images = commandRunner
        .exec(
          ['images', state.repo, '-q'],
          { cwd: context.cwd },
          context.logger,
        )
        .trim();
      if (images) {
        commandRunner.exec(
          ['rmi', '-f', ...images.split('\n')],
          { cwd: context.cwd },
          context.logger,
        );
      }
    } catch {
      context.logger.log('Image cleanup failed. Continuing.');
    }
  }

  context.logger.log(
    `Published: ${state.repo} (tags: ${state.tags.join(', ')})`,
  );
}

export default { verifyConditions, prepare, publish };
