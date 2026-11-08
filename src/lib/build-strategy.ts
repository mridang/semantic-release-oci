import fs from 'node:fs';
import path from 'node:path';
import SemanticReleaseError from '@semantic-release/error';
import { Build } from './build.js';
import { ImageStrategy } from './image-strategy.js';
import type { BuildParams, BuildResult, BuildState } from './types.js';

/**
 * Build strategy that drives `docker build`, or `docker buildx build`
 * when platforms are configured. Tags are applied as `--tag` flags, the
 * image digest is scraped from the build output, and (for non-buildx
 * builds) tagging, pushing, and cleanup happen at publish time.
 */
export class BuildStrategy extends ImageStrategy {
  /**
   * Buildx is used when platforms are configured.
   */
  get isBuildx(): boolean {
    return this.config.isBuildxEnabled();
  }

  /**
   * Verifies the configured Dockerfile exists.
   *
   * @returns A log label naming the verified Dockerfile.
   */
  verifyTarget(): string {
    const dockerfile = path.resolve(this.cwd, this.config.getDockerFile());
    if (!fs.existsSync(dockerfile)) {
      throw new SemanticReleaseError(
        `Dockerfile not found at ${dockerfile}`,
        'ENOENT',
      );
    }
    return `dockerfile="${dockerfile}"`;
  }

  /**
   * Builds the image and scrapes the digest from the build output.
   *
   * @param params Resolved per-build inputs.
   * @returns      The captured digest hex and the rendered tags.
   */
  async build(params: BuildParams): Promise<BuildResult> {
    const { config, cwd } = this;
    const { repo, tagTemplates, vars, buildId, isDryRun } = params;
    const tags = this.renderTags(tagTemplates, vars);
    const { isBuildx } = this;

    const built = await Build.run(this.docker, repo, buildId, {
      buildx: isBuildx,
      network: config.getDockerNetwork(),
      buildTag: isBuildx ? undefined : `${repo}:${buildId}`,
      tags: isDryRun ? [] : tags.map((tag) => `${repo}:${tag}`),
      quiet: config.isBuildQuiet(),
      noCache: config.isNoCacheEnabled(),
      cacheFrom: config.getDockerBuildCacheFrom(),
      buildArgs: Object.entries(config.getDockerArgs()).map(([key, value]) => ({
        key,
        value:
          value === true ? undefined : this.renderTemplate(String(value), vars),
      })),
      flags: config.getDockerBuildFlags(),
      platforms: config.getDockerPlatform(),
      push: config.isPublishEnabled() && !isDryRun,
      dockerfile: path.resolve(cwd, config.getDockerFile()),
      context: path.resolve(cwd, config.getDockerContext()),
    });

    return { sha256: built.digest, tags };
  }

  /**
   * The tags with the ones that contain the release version first.
   *
   * @param state The stored build state.
   * @returns The tags in push order.
   */
  private versionTagsFirst(state: BuildState): readonly string[] {
    const hasVersion = (tag: string): number =>
      Number(tag.includes(state.version));
    return state.tags.toSorted((a, b) => hasVersion(b) - hasVersion(a));
  }

  /**
   * For non-buildx builds, tags and pushes each tag, then removes the local
   * images when auto-clean is enabled. Buildx builds push during the build
   * step, so this is a no-op for them. Tags that contain the release version
   * are pushed first and floating ones such as `latest` after them, so a
   * failed push can never leave a floating tag on a release that has no
   * version tag in the registry; the order of the rest is kept.
   *
   * @param state The stored build state.
   */
  async finalizePublish(state: BuildState): Promise<void> {
    const { config, context } = this;
    const built = new Build(
      this.docker,
      state.repo,
      state.buildId,
      state.sha256,
    );

    if (!state.isBuildx && config.isPublishEnabled()) {
      for (const tag of this.versionTagsFirst(state)) {
        const image = await built.tag(tag);
        const { output } = await image.push();
        if (output) {
          context.logger.log(output);
        }
      }
    }

    if (config.isAutoCleanEnabled() && !state.isBuildx) {
      try {
        await built.remove();
      } catch {
        context.logger.log('Image cleanup failed. Continuing.');
      }
    }
  }
}
