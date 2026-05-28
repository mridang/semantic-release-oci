import crypto from 'crypto';
import * as actions from '@actions/core';
import SemanticReleaseError from '@semantic-release/error';
import { OciConfig, OciPluginConfig } from './plugin-config.js';
import { parsePkgName, readPkg, buildImageRepo } from './lib/pkg.js';
import { selectStrategy } from './lib/strategy.js';
import type { BuildState, SemanticReleaseContext } from './lib/types.js';

const buildStates = new Map<string, BuildState>();

/**
 * Verifies that the Docker image name is resolvable, the strategy's
 * required files exist, and (when enabled) performs Docker registry
 * login using configured credentials.
 *
 * @param pluginConfig Raw plugin configuration from semantic-release.
 * @param context      Semantic-release context with env and logger.
 */
export async function verifyConditions(
  pluginConfig: OciPluginConfig,
  context: SemanticReleaseContext,
): Promise<void> {
  const config = new OciConfig(pluginConfig, context.env);
  const strategy = selectStrategy(config, context);

  strategy.verifyDocker();

  const pkg = readPkg(context.cwd);
  const parsed = pkg?.name ? parsePkgName(pkg.name) : null;
  const imageName = config.getDockerImage() ?? parsed?.name;

  if (!imageName) {
    throw new SemanticReleaseError(
      'Docker image name is required. Set "dockerImage" in plugin config or ensure package.json has a name field.',
      'EINVAL',
    );
  }

  const verifiedTarget = strategy.verifyTarget();

  strategy.login();

  context.logger.log(`Verified: image="${imageName}", ${verifiedTarget}`);
}

/**
 * Builds the Docker image via the selected strategy and stores build
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

  const buildId = crypto.randomBytes(10).toString('hex');
  const isBuildx = config.isBakeEnabled() || config.isBuildxEnabled();

  const { sha256, tags } = selectStrategy(config, context).build({
    repo,
    tagTemplates: config.getDockerTags(),
    vars,
    buildId,
    isDryRun,
  });
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
 * Finalizes publishing of the previously built image (strategy-specific
 * tag/push/cleanup) and sets GitHub Actions outputs.
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

  selectStrategy(config, context).finalizePublish(state);

  try {
    actions.setOutput('docker_image', state.repo);
    actions.setOutput('docker_image_build_id', state.buildId);
    actions.setOutput('docker_image_sha_short', state.sha);
    actions.setOutput('docker_image_sha_long', state.sha256);
  } catch {
    /* ignored outside GitHub Actions */
  }

  context.logger.log(
    `Published: ${state.repo} (tags: ${state.tags.join(', ')})`,
  );
}

export default { verifyConditions, prepare, publish };
