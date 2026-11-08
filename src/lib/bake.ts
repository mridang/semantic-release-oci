import fs from 'node:fs';
import { isRecord, stringAt } from '../utils/object.js';
import type { DockerRun } from './docker-run.js';

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
    const meta: unknown = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!isRecord(meta)) {
      return '';
    }
    const digestOf = (target: unknown): string | undefined =>
      isRecord(target) ? stringAt(target, 'containerimage.digest') : undefined;
    const preferred =
      imageTarget !== '*' && Object.hasOwn(meta, imageTarget)
        ? meta[imageTarget]
        : undefined;
    const entry =
      preferred ||
      Object.values(meta).find((target) => digestOf(target) !== undefined);
    return digestOf(entry)?.replace(/^sha256:/, '') ?? '';
  } catch {
    return '';
  }
}

/**
 * A build argument for a bake target.
 */
interface BakeArg {
  /** The name of the build argument. */
  readonly key: string;
  /** Its value. */
  readonly value: string;
}

/**
 * Everything `docker buildx bake` needs, decided by the strategy.
 */
export interface BakeOptions {
  /** The bake file. */
  readonly file: string;
  /** Where bake records what it built. */
  readonly metadataFile: string;
  /** Target the tags are injected into, or `"*"`. */
  readonly imageTarget: string;
  /** References to tag the image with. */
  readonly tags: readonly string[];
  /** Build without pushing or exporting. */
  readonly dryRun: boolean;
  /** Build arguments, set on every target. */
  readonly buildArgs: readonly BakeArg[];
  /** Target or group to build. */
  readonly selector: string | undefined;
}

/**
 * The images a bake produced.
 */
export class BakedImages {
  /**
   * @param digest Digest hex of the image target, or an empty string when
   *               bake did not record one.
   */
  constructor(readonly digest: string) {}
}

/**
 * A `docker buildx bake` run: one bake file, one group or target, several
 * outputs from a shared build.
 */
export class Bake {
  /**
   * @param docker  Runs docker commands.
   * @param options What to bake.
   */
  constructor(
    private readonly docker: DockerRun,
    private readonly options: BakeOptions,
  ) {}

  /**
   * Runs the bake and reads the digest it recorded. The metadata file is
   * always removed afterwards.
   *
   * @returns The baked images.
   */
  async run(): Promise<BakedImages> {
    const { options } = this;
    const tagging = options.dryRun
      ? ['--set', '*.output=type=cacheonly']
      : options.tags.flatMap((tag) => [
          '--set',
          `${options.imageTarget}.tags=${tag}`,
        ]);
    try {
      await this.docker([
        'buildx',
        'bake',
        '--file',
        options.file,
        '--metadata-file',
        options.metadataFile,
        ...tagging,
        ...options.buildArgs.flatMap(({ key, value }) => [
          '--set',
          `*.args.${key}=${value}`,
        ]),
        ...(options.selector ? [options.selector] : []),
      ]);
      return new BakedImages(
        parseBakeDigest(options.metadataFile, options.imageTarget),
      );
    } finally {
      fs.rmSync(options.metadataFile, { force: true });
    }
  }
}
