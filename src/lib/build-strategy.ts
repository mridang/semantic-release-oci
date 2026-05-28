import fs from 'fs';
import path from 'path';
import SemanticReleaseError from '@semantic-release/error';
import { ImageStrategy } from './image-strategy.js';
import type { BuildParams, BuildState } from './types.js';

const SHA_REGEX = /(?:writing image\s)?[^@]?(?:sha\d{3}):(?<sha>\w+)/i;

/**
 * Build strategy that drives `docker build`, or `docker buildx build`
 * when platforms are configured. Tags are applied as `--tag` flags, the
 * image digest is scraped from the build output, and (for non-buildx
 * builds) tagging, pushing, and cleanup happen at publish time.
 */
export class BuildStrategy extends ImageStrategy {
  /**
   * Verifies the configured Dockerfile exists.
   *
   * @returns A log label naming the verified Dockerfile.
   */
  verifyTarget(): string {
    const dockerfile = path.resolve(
      this.context.cwd,
      this.config.getDockerFile(),
    );
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
  build(params: BuildParams): { sha256: string; tags: string[] } {
    const { config, context } = this;
    const { repo, tagTemplates, vars, buildId, isDryRun } = params;
    const tags = this.renderTags(tagTemplates, vars);
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

    for (const [key, value] of Object.entries(config.getDockerArgs())) {
      if (value === true) {
        args.push('--build-arg', key);
      } else {
        args.push(
          '--build-arg',
          `${key}=${this.renderTemplate(String(value), vars)}`,
        );
      }
    }

    const extraFlags = Object.entries(config.getDockerBuildFlags()).flatMap(
      ([key, value]): string[] => {
        const flag = key.startsWith('-')
          ? key
          : `${key.length === 1 ? '-' : '--'}${key.toLowerCase().replace(/_/g, '-')}`;
        if (value === null) return [flag];
        return (Array.isArray(value) ? value : [value]).flatMap((v) => [
          flag,
          v,
        ]);
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

    const stdout = this.exec(args, {
      stdio: 'pipe',
      timeout: config.getDockerTimeout(),
    });

    const sha256 =
      stdout
        .split('\n')
        .reverse()
        .reduce<string | undefined>(
          (found, line) => found ?? SHA_REGEX.exec(line)?.groups?.['sha'],
          undefined,
        ) ?? '';

    return { sha256, tags };
  }

  /**
   * For non-buildx builds, tags and pushes each version tag, then removes
   * the local images when auto-clean is enabled. Buildx builds push
   * during the build step, so this is a no-op for them.
   *
   * @param state The stored build state.
   */
  finalizePublish(state: BuildState): void {
    const { config, context } = this;

    if (!state.isBuildx && config.isPublishEnabled()) {
      for (const tag of state.tags) {
        this.exec(
          ['tag', `${state.repo}:${state.buildId}`, `${state.repo}:${tag}`],
          { timeout: config.getDockerTimeout() },
        );
        this.exec(['push', `${state.repo}:${tag}`], {
          stdio: 'inherit',
          timeout: config.getDockerTimeout(),
        });
      }
    }

    if (config.isAutoCleanEnabled() && !state.isBuildx) {
      try {
        const images = this.exec(['images', state.repo, '-q'], {
          timeout: config.getDockerTimeout(),
        }).trim();
        if (images) {
          this.exec(['rmi', '-f', ...images.split('\n')], {
            timeout: config.getDockerTimeout(),
          });
        }
      } catch {
        context.logger.log('Image cleanup failed. Continuing.');
      }
    }
  }
}
