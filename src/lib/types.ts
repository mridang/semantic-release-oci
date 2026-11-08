/**
 * State tracked for a built image between the prepare and publish
 * lifecycle hooks.
 */
export interface BuildState {
  readonly sha: string;
  readonly sha256: string;
  readonly buildId: string;
  readonly tags: readonly string[];
  readonly repo: string;
  readonly isBuildx: boolean;
}

/**
 * Per-build inputs handed to a strategy's `build` step, resolved by the
 * prepare hook from config and the release context.
 */
export interface BuildParams {
  readonly repo: string;
  readonly tagTemplates: readonly string[];
  readonly vars: Readonly<Record<string, string | number | undefined>>;
  readonly buildId: string;
  readonly isDryRun: boolean;
}

/**
 * What a strategy's `build` step reports: the captured image digest hex (or
 * an empty string when it cannot be determined) and the rendered tags.
 */
export interface BuildResult {
  readonly sha256: string;
  readonly tags: readonly string[];
}
