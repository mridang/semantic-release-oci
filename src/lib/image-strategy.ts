import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { OciConfig } from '../plugin-config.js';
import type { Runner } from '../utils/exec.js';
import {
  assertDockerAvailable,
  dockerRun,
  type DockerRun,
} from './docker-run.js';
import { Registry } from './registry.js';
import type { BuildParams, BuildResult, BuildState } from './types.js';

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
   * The directory every command runs in.
   */
  readonly cwd: string;

  /**
   * Runs docker commands for the nouns this strategy works with.
   */
  protected readonly docker: DockerRun;

  /**
   * Whether the build step itself pushes the image (buildx and bake), so that
   * nothing is left to tag, push or clean up at publish time.
   */
  abstract readonly isBuildx: boolean;

  /**
   * @param config - Resolved plugin configuration.
   * @param context - Semantic-release context with cwd, env, and logger.
   * @param run - Runs the docker binary; only tests pass one.
   */
  constructor(
    protected readonly config: OciConfig,
    protected readonly context: VerifyConditionsContext,
    run?: Runner,
  ) {
    this.cwd = context.cwd ?? process.cwd();
    this.docker = dockerRun({
      cwd: this.cwd,
      env: context.env,
      timeoutMs: config.getDockerTimeout(),
      logger: context.logger,
      run,
    });
  }

  /**
   * Replaces `{{variable}}` placeholders in a template string with values
   * from the provided variables map. Unknown variables resolve to the
   * empty string.
   * @param template - Template string containing `{{key}}` placeholders.
   * @param vars - Key-value map of replacement values.
   * @returns The rendered string.
   */
  protected renderTemplate(
    template: string,
    vars: Readonly<Record<string, string | number | undefined>>,
  ): string {
    return template.replaceAll(
      /\{\{(\w+)\}\}/g,
      (_match: string, key: string): string => {
        // Own keys only: `{{constructor}}` must not reach Object.prototype.
        const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
        return value === undefined ? '' : String(value);
      },
    );
  }

  /**
   * Renders a list of tag templates, dropping any that resolve to an
   * empty string and any that repeat an earlier tag.
   * @param templates - Tag template strings.
   * @param vars - Key-value map of replacement values.
   * @returns The rendered, non-empty tags.
   */
  protected renderTags(
    templates: readonly string[],
    vars: Readonly<Record<string, string | number | undefined>>,
  ): readonly string[] {
    const rendered = templates
      .map((template) => this.renderTemplate(template, vars))
      .filter(Boolean);
    return [...new Set(rendered)];
  }

  /**
   * Verifies the Docker CLI is installed and reachable on PATH.
   * @throws SemanticReleaseError with code `ENOENT` when Docker is
   *         unavailable.
   */
  async verifyDocker(): Promise<void> {
    await assertDockerAvailable(this.docker);
  }

  /**
   * Performs a Docker registry login when login is enabled and
   * credentials are present, passing the password over stdin.
   * @throws SemanticReleaseError with code `EAUTH` when only partial
   *         credentials are supplied.
   */
  async login(): Promise<void> {
    if (!this.config.isLoginEnabled() || !this.config.hasCredentials()) {
      return;
    }
    const user = this.config.getRegistryUser();
    const password = this.config.getRegistryPassword();
    if (user === undefined || password === undefined) {
      throw new SemanticReleaseError(
        'Docker login requires both DOCKER_REGISTRY_USER and DOCKER_REGISTRY_PASSWORD (or GITHUB_TOKEN) environment variables.',
        'EAUTH',
      );
    }

    await new Registry(this.docker, this.config.getDockerRegistry()).login(
      user,
      password,
    );

    this.context.logger.log('Docker login successful.');
  }

  /**
   * Validates strategy preconditions (required files and config) and
   * returns a short label describing what was verified, for logging.
   * @returns A log label describing the verified target.
   */
  abstract verifyTarget(): string;

  /**
   * Runs the build, returning the captured image digest hex (or an empty
   * string when it cannot be determined) and the rendered tags applied.
   * @param params - Resolved per-build inputs.
   * @returns The captured digest hex and the rendered tags.
   */
  abstract build(params: BuildParams): Promise<BuildResult>;

  /**
   * Performs any tag/push/cleanup that must happen during publish. No-op
   * for strategies that push during the build step.
   * @param state - The stored build state.
   */
  abstract finalizePublish(state: BuildState): Promise<void>;
}
