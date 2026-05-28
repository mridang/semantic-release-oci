import { execSync } from 'child_process';
import SemanticReleaseError from '@semantic-release/error';
import { OciConfig } from '../plugin-config.js';
import type {
  BuildParams,
  BuildState,
  SemanticReleaseContext,
} from './types.js';

/**
 * Options accepted by {@link ImageStrategy.exec}.
 */
interface ExecOptions {
  readonly input?: string;
  readonly stdio?: 'inherit' | 'pipe';
  readonly timeout?: number;
}

/**
 * A build mechanism (plain/buildx `docker build`, or `docker buildx
 * bake`). Each strategy owns how it validates preconditions, constructs
 * and runs its build command (capturing the image digest), and what it
 * must do at publish time. Shared Docker plumbing (running commands,
 * rendering templates, verifying Docker, logging in) lives on this base
 * class so concrete strategies only implement what differs.
 */
export abstract class ImageStrategy {
  /**
   * @param config  Resolved plugin configuration.
   * @param context Semantic-release context with cwd, env, and logger.
   */
  constructor(
    protected readonly config: OciConfig,
    protected readonly context: SemanticReleaseContext,
  ) {}

  /**
   * Executes a Docker CLI command via `child_process.execSync`, using the
   * context's working directory and logger. Public so tests can spy on
   * `ImageStrategy.prototype.exec`.
   *
   * @param args    Docker arguments, joined onto a leading `docker`.
   * @param options Execution options (input, stdio, timeout).
   * @returns       The command's stdout, or an empty string.
   */
  exec(args: readonly string[], options: ExecOptions = {}): string {
    const cmd = ['docker', ...args].join(' ');
    this.context.logger.log(`Executing: ${cmd}`);
    const result = execSync(cmd, {
      cwd: this.context.cwd,
      encoding: 'utf8',
      input: options.input,
      stdio: options.stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? 600_000,
    });
    return typeof result === 'string' ? result : '';
  }

  /**
   * Replaces `{{variable}}` placeholders in a template string with values
   * from the provided variables map. Unknown variables resolve to the
   * empty string.
   *
   * @param template Template string containing `{{key}}` placeholders.
   * @param vars     Key-value map of replacement values.
   * @returns        The rendered string.
   */
  protected renderTemplate(
    template: string,
    vars: Record<string, string | number | undefined>,
  ): string {
    return template.replace(
      /\{\{(\w+)\}\}/g,
      (_match: string, key: string): string => {
        const value = vars[key];
        return value !== undefined ? String(value) : '';
      },
    );
  }

  /**
   * Renders a list of tag templates, dropping any that resolve to an
   * empty string.
   *
   * @param templates Tag template strings.
   * @param vars      Key-value map of replacement values.
   * @returns         The rendered, non-empty tags.
   */
  protected renderTags(
    templates: readonly string[],
    vars: Record<string, string | number | undefined>,
  ): string[] {
    return templates.map((t) => this.renderTemplate(t, vars)).filter(Boolean);
  }

  /**
   * Verifies the Docker CLI is installed and reachable on PATH.
   *
   * @throws SemanticReleaseError with code `ENOENT` when Docker is
   *         unavailable.
   */
  verifyDocker(): void {
    try {
      this.exec(['version'], { timeout: this.config.getDockerTimeout() });
    } catch {
      throw new SemanticReleaseError(
        'Docker is not installed or not available in PATH. Ensure Docker is installed and accessible.',
        'ENOENT',
      );
    }
  }

  /**
   * Performs a Docker registry login when login is enabled and
   * credentials are present, passing the password over stdin.
   *
   * @throws SemanticReleaseError with code `EAUTH` when only partial
   *         credentials are supplied.
   */
  login(): void {
    if (!this.config.isLoginEnabled() || !this.config.hasCredentials()) {
      return;
    }
    if (!this.config.hasCompleteCredentials()) {
      throw new SemanticReleaseError(
        'Docker login requires both DOCKER_REGISTRY_USER and DOCKER_REGISTRY_PASSWORD (or GITHUB_TOKEN) environment variables.',
        'EAUTH',
      );
    }

    const registry = this.config.getDockerRegistry();
    const loginArgs: readonly string[] = [
      'login',
      ...(registry ? [registry] : []),
      '-u',
      this.config.getRegistryUser()!,
      '--password-stdin',
    ];

    this.exec(loginArgs, {
      input: this.config.getRegistryPassword(),
      timeout: this.config.getDockerTimeout(),
    });

    this.context.logger.log('Docker login successful.');
  }

  /**
   * Validates strategy preconditions (required files and config) and
   * returns a short label describing what was verified, for logging.
   *
   * @returns A log label describing the verified target.
   */
  abstract verifyTarget(): string;

  /**
   * Runs the build, returning the captured image digest hex (or an empty
   * string when it cannot be determined) and the rendered tags applied.
   *
   * @param params Resolved per-build inputs.
   * @returns      The captured digest hex and the rendered tags.
   */
  abstract build(params: BuildParams): { sha256: string; tags: string[] };

  /**
   * Performs any tag/push/cleanup that must happen during publish. No-op
   * for strategies that push during the build step.
   *
   * @param state The stored build state.
   */
  abstract finalizePublish(state: BuildState): void;
}
