/**
 * Logger surface used by the plugin, matching the subset of the
 * semantic-release logger the plugin actually calls.
 */
export interface Logger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Simplified semantic-release context consumed by the plugin lifecycle
 * hooks and build strategies. Only the fields used are typed.
 */
export interface SemanticReleaseContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly logger: Logger;
  readonly nextRelease?: {
    readonly version?: string;
    readonly gitTag?: string;
    readonly gitHead?: string;
    readonly channel?: string;
    readonly type?: string;
  };
  readonly lastRelease?: {
    readonly version?: string;
    readonly gitTag?: string;
    readonly gitHead?: string;
  };
  readonly options?: {
    readonly dryRun?: boolean;
  };
}

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
  readonly vars: Record<string, string | number | undefined>;
  readonly buildId: string;
  readonly isDryRun: boolean;
}
