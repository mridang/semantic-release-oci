import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import type { BakeSettings, OciConfig } from '../plugin-config.js';
import type { Runner } from '../utils/exec.js';
import { Bake } from './bake.js';
import { ImageStrategy } from './image-strategy.js';
import type { BuildParams, BuildResult } from './types.js';

/**
 * Build strategy that drives `docker buildx bake`. A single bake group
 * or target can produce several outputs from one shared build. Each
 * version tag is injected into the configured image target via its own
 * repeated `--set <target>.tags=` flag (buildx treats a comma-joined
 * value as one invalid tag), the digest is read from a bake metadata
 * file, and push behaviour is owned by each target's `output` in the
 * bake file (so publish is a no-op).
 */
export class BakeStrategy extends ImageStrategy {
  /**
   * Bake always pushes during the build, through each target's `output`.
   */
  readonly isBuildx = true;

  /**
   * @param config - Resolved plugin configuration.
   * @param context - Semantic-release context with cwd, env, and logger.
   * @param bake - The resolved `dockerBake` settings.
   * @param run - Runs the docker binary; only tests pass one.
   */
  constructor(
    config: OciConfig,
    context: VerifyConditionsContext,
    private readonly bake: BakeSettings,
    run?: Runner,
  ) {
    super(config, context, run);
  }

  /**
   * Verifies a `group` or `target` is configured and the bake file
   * exists.
   * @returns A log label naming the verified bake file.
   */
  verifyTarget(): string {
    const { bake, cwd } = this;
    if (!bake.group && !bake.target) {
      throw new SemanticReleaseError(
        'dockerBake requires either "group" or "target" to be set.',
        'EINVAL',
      );
    }
    const bakeFile = path.resolve(cwd, bake.file);
    if (!fs.existsSync(bakeFile)) {
      throw new SemanticReleaseError(
        `Bake file not found at ${bakeFile}`,
        'ENOENT',
      );
    }
    return `bakeFile="${bakeFile}"`;
  }

  /**
   * Runs `docker buildx bake`, injecting version tags and build args via
   * `--set`, and reads the resulting digest from a metadata file that is
   * always cleaned up afterwards.
   * @param params - Resolved per-build inputs.
   * @returns The captured digest hex and the rendered tags.
   */
  async build(params: BuildParams): Promise<BuildResult> {
    const { config, context, bake, cwd, docker } = this;
    const { repo, tagTemplates, vars, buildId, isDryRun } = params;
    const tags = this.renderTags(tagTemplates, vars);
    const metadataFile = path.join(os.tmpdir(), `oci-bake-${buildId}.json`);

    const dockerArgs = Object.entries(config.getDockerArgs());

    dockerArgs
      .filter(([, value]) => value === true)
      .forEach(([key]) =>
        context.logger.log(
          `Build arg "${key}" without a value is not supported in bake mode; declare it in the bake file.`,
        ),
      );

    const baked = await new Bake(docker, {
      file: path.resolve(cwd, bake.file),
      metadataFile,
      imageTarget: bake.imageTarget,
      tags: tags.map((tag) => `${repo}:${tag}`),
      dryRun: isDryRun,
      buildArgs: dockerArgs.flatMap(([key, value]) =>
        value === true
          ? []
          : [{ key, value: this.renderTemplate(String(value), vars) }],
      ),
      selector: bake.target ?? bake.group,
    }).run();

    return { sha256: baked.digest, tags };
  }

  /**
   * Bake pushes during the build via each target's `output`, so there is
   * nothing to tag, push, or clean up at publish time.
   */
  async finalizePublish(): Promise<void> {}
}
