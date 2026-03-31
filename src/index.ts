import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import * as actions from '@actions/core';
import SemanticReleaseError from '@semantic-release/error';
import { OciConfig, OciPluginConfig } from './plugin-config.js';

const NAME_EXP = /^(?:@([^/]+)\/)?(.+)$/;
const SHA_REGEX = /(?:writing image\s)?[^@]?(?:sha\d{3}):(?<sha>\w+)/i;

interface BuildState {
  sha: string;
  sha256: string;
  buildId: string;
  tags: string[];
  repo: string;
  isBuildx: boolean;
}

interface SemanticReleaseContext {
  cwd: string;
  env: Record<string, string | undefined>;
  logger: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  nextRelease?: {
    version?: string;
    gitTag?: string;
    gitHead?: string;
    channel?: string;
    type?: string;
  };
  lastRelease?: {
    version?: string;
    gitTag?: string;
    gitHead?: string;
  };
  options?: {
    dryRun?: boolean;
  };
}

const buildStates = new Map<string, BuildState>();

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

function buildTemplateVars(
  context: SemanticReleaseContext,
): Record<string, string | number | undefined> {
  const version = context.nextRelease?.version ?? '';
  const parts = version.split('.');
  return {
    version,
    major: parts[0] ?? '',
    minor: parts[1] ?? '',
    patch: parts[2] ?? '',
    gitTag: context.nextRelease?.gitTag ?? '',
    gitHead: context.nextRelease?.gitHead ?? '',
    channel: context.nextRelease?.channel ?? '',
    type: context.nextRelease?.type ?? '',
    now: new Date().toISOString(),
  };
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
  const parts: string[] = [];
  if (registry) parts.push(registry);
  if (project) parts.push(project);
  parts.push(name);
  return parts.join('/');
}

function normalizeFlag(key: string): string {
  if (key.startsWith('-')) return key;
  const normalized = key.toLowerCase().replace(/_/g, '-');
  return key.length === 1 ? `-${normalized}` : `--${normalized}`;
}

function buildFlagsArray(
  flags: Record<string, string | string[] | null>,
): string[] {
  const output: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    const flag = normalizeFlag(key);
    if (value === null) {
      output.push(flag);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      output.push(flag, v);
    }
  }
  return output;
}

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

export async function verifyConditions(
  pluginConfig: OciPluginConfig,
  context: SemanticReleaseContext,
): Promise<void> {
  const config = new OciConfig(
    pluginConfig,
    context.env as Record<string, string | undefined>,
  );
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

export async function prepare(
  pluginConfig: OciPluginConfig,
  context: SemanticReleaseContext,
): Promise<void> {
  const config = new OciConfig(
    pluginConfig,
    context.env as Record<string, string | undefined>,
  );
  const pkg = readPkg(context.cwd);
  const parsed = pkg?.name ? parsePkgName(pkg.name) : null;
  const imageName = config.getDockerImage() ?? parsed?.name ?? '';
  const project = config.getDockerProject() ?? parsed?.scope ?? undefined;
  const registry = config.getDockerRegistry();
  const repo = buildImageRepo(registry, project, imageName);
  const vars = buildTemplateVars(context);
  const isDryRun = context.options?.dryRun === true;

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

  args.push(`--network=${config.getDockerNetwork()}`);

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

  const extraFlags = buildFlagsArray(config.getDockerBuildFlags());
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

  let stdout = '';
  try {
    stdout = commandRunner.exec(
      args,
      { cwd: context.cwd, stdio: 'pipe' },
      context.logger,
    );
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      stdout = String((err as { stdout: unknown }).stdout ?? '');
    }
    throw err;
  }

  let sha = buildId;
  let sha256 = '';
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = SHA_REGEX.exec(lines[i]);
    if (match?.groups?.['sha']) {
      sha256 = match.groups['sha'];
      sha = sha256.substring(0, 12);
      break;
    }
  }

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

export async function publish(
  pluginConfig: OciPluginConfig,
  context: SemanticReleaseContext,
): Promise<void> {
  const config = new OciConfig(
    pluginConfig,
    context.env as Record<string, string | undefined>,
  );
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
    /* not running in GitHub Actions */
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
