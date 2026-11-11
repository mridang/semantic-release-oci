/**
 * State tracked for a built image between the prepare and publish
 * lifecycle hooks.
 */
export interface BuildState {
  /** The short form of the digest, or the build id when there is none. */
  readonly sha: string;
  /** The image digest hex, or an empty string. */
  readonly sha256: string;
  /** The id the build was tagged with. */
  readonly buildId: string;
  /** The rendered tags. */
  readonly tags: readonly string[];

  /**
   * The release version, used to push the version tag before the floating ones.
   */
  readonly version: string;
  /** The full image repository path. */
  readonly repo: string;
  /** Whether the build itself pushed the image. */
  readonly isBuildx: boolean;
}

/**
 * Per-build inputs handed to a strategy's `build` step, resolved by the
 * prepare hook from config and the release context.
 */
export interface BuildParams {
  /** The full image repository path. */
  readonly repo: string;
  /** Tag templates with `{{variable}}` placeholders. */
  readonly tagTemplates: readonly string[];
  /** Values for the placeholders. */
  readonly vars: Readonly<Record<string, string | number | undefined>>;
  /** Id to tag the build with. */
  readonly buildId: string;
  /** Build without publishing. */
  readonly isDryRun: boolean;
}

/**
 * What a strategy's `build` step reports: the captured image digest hex (or
 * an empty string when it cannot be determined) and the rendered tags.
 */
export interface BuildResult {
  /** The image digest hex, or an empty string. */
  readonly sha256: string;
  /** The rendered tags. */
  readonly tags: readonly string[];
}
