import fs from 'fs';
import os from 'os';
import path from 'path';
import SemanticReleaseError from '@semantic-release/error';
import { ImageStrategy } from './image-strategy.js';
import type { BuildParams } from './types.js';

/**
 * Reads the digest of the built image from a `docker buildx bake`
 * metadata file. Looks up the configured image target, falling back to
 * the first target that recorded a `containerimage.digest`. The
 * `sha256:` prefix is stripped to match the digest shape used elsewhere.
 *
 * @param metadataPath Path to the bake metadata JSON file.
 * @param imageTarget  Target whose digest is preferred, or `"*"`.
 * @returns The image digest hex, or an empty string when unavailable.
 */
export function parseBakeDigest(
  metadataPath: string,
  imageTarget: string,
): string {
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    return '';
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    const digestKey = 'containerimage.digest';
    const entry =
      imageTarget !== '*' && meta[imageTarget]
        ? meta[imageTarget]
        : Object.values(meta).find((t) => typeof t?.[digestKey] === 'string');
    const digest = entry?.[digestKey];
    return typeof digest === 'string' ? digest.replace(/^sha256:/, '') : '';
  } catch {
    return '';
  }
}

/**
 * Build strategy that drives `docker buildx bake`. A single bake group
 * or target can produce several outputs from one shared build. Version
 * tags are injected into the configured image target via `--set`, the
 * digest is read from a bake metadata file, and push behaviour is owned
 * by each target's `output` in the bake file (so publish is a no-op).
 */
export class BakeStrategy extends ImageStrategy {
  /**
   * Verifies a `group` or `target` is configured and the bake file
   * exists.
   *
   * @returns A log label naming the verified bake file.
   */
  verifyTarget(): string {
    const bake = this.config.getDockerBake()!;
    if (!bake.group && !bake.target) {
      throw new SemanticReleaseError(
        'dockerBake requires either "group" or "target" to be set.',
        'EINVAL',
      );
    }
    const bakeFile = path.resolve(this.context.cwd, bake.file);
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
   *
   * @param params Resolved per-build inputs.
   * @returns      The captured digest hex and the rendered tags.
   */
  build(params: BuildParams): { sha256: string; tags: string[] } {
    const { config, context } = this;
    const { repo, tagTemplates, vars, buildId, isDryRun } = params;
    const tags = this.renderTags(tagTemplates, vars);
    const bake = config.getDockerBake()!;
    const metadataFile = path.join(os.tmpdir(), `oci-bake-${buildId}.json`);

    const dockerArgs = Object.entries(config.getDockerArgs());
    const selector = bake.target ?? bake.group;

    dockerArgs
      .filter(([, value]) => value === true)
      .forEach(([key]) =>
        context.logger.log(
          `Build arg "${key}" without a value is not supported in bake mode; declare it in the bake file.`,
        ),
      );

    const tagOverride =
      tags.length > 0
        ? [
            '--set',
            `${bake.imageTarget}.tags=${tags
              .map((tag) => `${repo}:${tag}`)
              .join(',')}`,
          ]
        : [];

    const args: readonly string[] = [
      'buildx',
      'bake',
      '--file',
      path.resolve(context.cwd, bake.file),
      '--metadata-file',
      metadataFile,
      ...(isDryRun ? ['--set', '*.output=type=cacheonly'] : tagOverride),
      ...dockerArgs
        .filter(([, value]) => value !== true)
        .flatMap(([key, value]) => [
          '--set',
          `*.args.${key}=${this.renderTemplate(String(value), vars)}`,
        ]),
      ...(selector ? [selector] : []),
    ];

    try {
      this.exec(args, {
        stdio: 'pipe',
        timeout: config.getDockerTimeout(),
      });
      const sha256 = parseBakeDigest(metadataFile, bake.imageTarget);
      return { sha256, tags };
    } finally {
      fs.rmSync(metadataFile, { force: true });
    }
  }

  /**
   * Bake pushes during the build via each target's `output`, so there is
   * nothing to tag, push, or clean up at publish time.
   */
  finalizePublish(): void {}
}
