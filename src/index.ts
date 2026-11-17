import crypto from 'node:crypto';
import { setOutput } from '@actions/core';
import SemanticReleaseError from '@semantic-release/error';
import { OciConfig } from './plugin-config.js';
import { parsePkgName, readPkg, buildImageRepo } from './lib/pkg.js';
import { selectStrategy } from './lib/strategy.js';
import type { OciPluginConfig } from './plugin-config.js';
import type {
  PrepareContext,
  PublishContext,
  VerifyConditionsContext,
} from 'semantic-release';
import type { BuildState } from './lib/types.js';

/**
 * Builds in flight between `prepare` and `publish`. A key whose value is
 * `undefined` marks a `prepare` that started and has not produced a build.
 */
const buildStates = new Map<string, BuildState | undefined>();

/**
 * Keys of builds that `publish` has already used, so that a second publish of
 * the same release can be told from a publish that has no build at all.
 */
const published = new Set<string>();

/**
 * The name of a release channel. semantic-release types it as a string but
 * reports the default channel as null at runtime.
 * @param channel - The channel of the release.
 * @returns The channel, or an empty string for the default channel.
 */
function channelName(channel: string | null): string {
  return channel ?? '';
}

/**
 * The key a build is stored under between `prepare` and `publish`. It names
 * the plugin entry (a hash of its whole configuration), the release version,
 * the directory and the repository, so two entries for the same image, two
 * releases, or two directories can never pick up each other's build.
 * @param pluginConfig - Raw plugin configuration of this entry.
 * @param context - Semantic-release context of the step.
 * @param cwd - Directory the release runs in.
 * @param repo - Full image repository path.
 * @returns A key unique to that combination.
 */
function stateKey(
  pluginConfig: OciPluginConfig,
  context: PrepareContext,
  cwd: string,
  repo: string,
): string {
  const entry = crypto
    .createHash('sha256')
    .update(JSON.stringify(pluginConfig))
    .digest('hex');
  return JSON.stringify([cwd, repo, context.nextRelease.version, entry]);
}

/**
 * Resolves the image name and full repository path from config, falling
 * back to the `package.json` name and scope. The image name is
 * `undefined` when neither config nor package.json provides one; the
 * repository path treats a missing name as empty.
 * @param config - Resolved plugin configuration.
 * @param cwd - Directory the release runs in.
 * @returns The resolved image name and repository path.
 */
async function resolveImage(
  config: OciConfig,
  cwd: string,
): Promise<{
  readonly imageName: string | undefined;
  readonly repo: string;
}> {
  const pkg = await readPkg(cwd);
  const parsed = pkg?.name ? parsePkgName(pkg.name) : null;
  const imageName = config.getDockerImage() ?? parsed?.name ?? undefined;
  const project = config.getDockerProject() ?? parsed?.scope ?? undefined;
  const repo = buildImageRepo(
    config.getDockerRegistry(),
    project,
    imageName ?? '',
  );
  return { imageName, repo };
}

/**
 * Verifies that the Docker image name is resolvable, the strategy's
 * required files exist, and (when enabled) performs Docker registry
 * login using configured credentials.
 * @param pluginConfig - Raw plugin configuration from semantic-release.
 * @param context - Semantic-release context with env and logger.
 */
export async function verifyConditions(
  pluginConfig: OciPluginConfig,
  context: VerifyConditionsContext,
): Promise<void> {
  const config = new OciConfig(pluginConfig, context.env);
  const strategy = selectStrategy(config, context);

  await strategy.verifyDocker();

  const { imageName } = await resolveImage(config, strategy.cwd);

  if (!imageName) {
    throw new SemanticReleaseError(
      'Docker image name is required. Set "dockerImage" in plugin config or ensure package.json has a name field.',
      'EINVAL',
    );
  }

  const verifiedTarget = await strategy.verifyTarget();

  await strategy.login();

  context.logger.log(`Verified: image="${imageName}", ${verifiedTarget}`);
}

/**
 * Builds the Docker image via the selected strategy and stores build
 * state in a module-level map for the subsequent publish step.
 * @param pluginConfig - Raw plugin configuration from semantic-release.
 * @param context - Semantic-release context with env and logger.
 */
export async function prepare(
  pluginConfig: OciPluginConfig,
  context: PrepareContext,
): Promise<void> {
  const config = new OciConfig(pluginConfig, context.env);
  const strategy = selectStrategy(config, context);
  const { repo } = await resolveImage(config, strategy.cwd);
  const key = stateKey(pluginConfig, context, strategy.cwd, repo);
  // A build that fails must not leave the previous one to be published.
  // eslint-disable-next-line functional/immutable-data -- the build state is handed from the prepare step to the publish step through module state
  buildStates.set(key, undefined);
  // eslint-disable-next-line functional/immutable-data -- the build state is handed from the prepare step to the publish step through module state
  published.delete(key);
  const isDryRun = context.options.dryRun === true;

  const { nextRelease, logger } = context;
  const [major, minor = '', patch = ''] = nextRelease.version.split('.');
  const variables = {
    version: nextRelease.version,
    major,
    minor,
    patch,
    gitTag: nextRelease.gitTag,
    gitHead: nextRelease.gitHead,
    channel: channelName(nextRelease.channel),
    type: nextRelease.type,
    now: new Date().toISOString(),
  } satisfies Record<string, string | number | undefined>;

  const buildId = crypto.randomBytes(10).toString('hex');

  const { sha256, tags } = await strategy.build({
    repo,
    tagTemplates: config.getDockerTags(),
    vars: variables,
    buildId,
    isDryRun,
  });
  const sha = sha256 ? sha256.slice(0, 12) : buildId;

  // eslint-disable-next-line functional/immutable-data -- the build state is handed from the prepare step to the publish step through module state
  buildStates.set(key, {
    sha,
    sha256,
    buildId,
    tags,
    version: nextRelease.version,
    repo,
    isBuildx: strategy.isBuildx,
  });

  logger.log(`Docker image built: ${repo}:${buildId} (sha: ${sha})`);
}

/**
 * Finalizes publishing of the previously built image (strategy-specific
 * tag/push/cleanup) and sets GitHub Actions outputs.
 * @param pluginConfig - Raw plugin configuration from semantic-release.
 * @param context - Semantic-release context with env and logger.
 */
export async function publish(
  pluginConfig: OciPluginConfig,
  context: PublishContext,
): Promise<void> {
  const config = new OciConfig(pluginConfig, context.env);
  const strategy = selectStrategy(config, context);
  const { repo } = await resolveImage(config, strategy.cwd);
  const key = stateKey(pluginConfig, context, strategy.cwd, repo);

  if (!buildStates.has(key)) {
    if (published.has(key)) {
      context.logger.log(
        'This release was already published. Skipping publish.',
      );
      return;
    }
    throw new SemanticReleaseError(
      'No image was built by prepare for this release and plugin configuration, so there is nothing to publish. The prepare and publish steps must use the same configuration.',
      'ENOBUILD',
    );
  }
  const state = buildStates.get(key);
  if (!state) {
    throw new SemanticReleaseError(
      'The image build for this release did not complete, so there is nothing to publish.',
      'ENOBUILD',
    );
  }

  await strategy.finalizePublish(state);
  // eslint-disable-next-line functional/immutable-data -- the build state is handed from the prepare step to the publish step through module state
  buildStates.delete(key);
  // eslint-disable-next-line functional/immutable-data -- the build state is handed from the prepare step to the publish step through module state
  published.add(key);

  try {
    setOutput('docker_image', state.repo);
    setOutput('docker_image_build_id', state.buildId);
    setOutput('docker_image_sha_short', state.sha);
    setOutput('docker_image_sha_long', state.sha256);
  } catch {
    /* ignored outside GitHub Actions */
  }

  context.logger.log(
    `Published: ${state.repo} (tags: ${state.tags.join(', ')})`,
  );
}

export default { verifyConditions, prepare, publish } as const;
