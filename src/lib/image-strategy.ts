import { execFileSync } from 'node:child_process';
import { setSecret } from '@actions/core';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { codeOf } from '../utils/error.js';
import { isRecord, numberAt, stringAt } from '../utils/object.js';
import { maskAssignments, scrub, secretsIn } from './redact.js';
import { OciConfig } from '../plugin-config.js';
import type { BuildParams, BuildResult, BuildState } from './types.js';

/**
 * Options accepted by {@link ImageStrategy.exec}.
 */
interface ExecOptions {
  readonly input?: string;
  readonly stdio?: 'inherit' | 'pipe';
  readonly timeout?: number;
}

/**
 * Largest output, in bytes, captured from one docker command. Build logs can
 * run to many megabytes, and the default of 1 MiB would kill the child.
 */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * A docker command that did not succeed. It carries the exit status, signal
 * and error code of the failure, but its message is rebuilt from redacted
 * parts only: the error Node throws embeds the full command line.
 */
class DockerCommandError extends Error {
  readonly status: number | undefined;

  readonly signal: string | undefined;

  readonly code: string | undefined;

  /**
   * @param message The redacted message.
   * @param source  The error that was thrown by the child process call.
   */
  constructor(message: string, source: unknown) {
    super(message);
    this.name = 'DockerCommandError';
    this.status = isRecord(source) ? numberAt(source, 'status') : undefined;
    this.signal = isRecord(source) ? stringAt(source, 'signal') : undefined;
    this.code = codeOf(source);
  }
}

/**
 * What a failed docker call has to say, chosen by the shape of the failure
 * and never by its message text: a command that ran reports its stderr, and
 * one that could not run (no binary, timeout, bad argument) reports its
 * error code.
 *
 * @param error The value thrown by the child process call.
 * @returns The detail, which is not yet scrubbed.
 */
function detailOf(error: unknown): string | undefined {
  const code = codeOf(error);
  if (code !== undefined) {
    return code;
  }
  return isRecord(error) ? stringAt(error, 'stderr') : String(error);
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
   * The directory every command runs in.
   */
  readonly cwd: string;

  /**
   * Whether the build step itself pushes the image (buildx and bake), so that
   * nothing is left to tag, push or clean up at publish time.
   */
  abstract readonly isBuildx: boolean;

  /**
   * @param config  Resolved plugin configuration.
   * @param context Semantic-release context with cwd, env, and logger.
   */
  constructor(
    protected readonly config: OciConfig,
    protected readonly context: VerifyConditionsContext,
  ) {
    this.cwd = context.cwd ?? process.cwd();
  }

  /**
   * Executes a Docker CLI command via `child_process.execFileSync` with an argv array (never a shell), using the
   * context's working directory and logger. Public so tests can spy on
   * `ImageStrategy.prototype.exec`.
   *
   * @param args    Docker arguments, passed as-is after the `docker` binary.
   * @param options Execution options (input, stdio, timeout).
   * @returns       The command's stdout, or an empty string.
   */
  exec(args: readonly string[], options: ExecOptions = {}): string {
    const nul = args.findIndex((arg) => arg.includes('\0'));
    if (nul >= 0) {
      throw new Error(`Docker argument ${nul} contains a NUL byte.`);
    }
    const secrets = secretsIn(args);
    secrets.forEach((secret) => setSecret(secret));
    const shown = scrub(
      ['docker', ...maskAssignments(args)].join(' '),
      secrets,
    );
    this.context.logger.log(`Executing: ${shown}`);
    try {
      const result = execFileSync('docker', [...args], {
        cwd: this.cwd,
        encoding: 'utf8',
        input: options.input,
        maxBuffer: MAX_BUFFER,
        stdio:
          options.stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
        timeout: options.timeout ?? 600_000,
      });
      return typeof result === 'string' ? result : '';
    } catch (error: unknown) {
      const detail = scrub(detailOf(error) ?? '', secrets);
      throw new DockerCommandError(
        `Command failed: ${shown}${detail ? `\n${detail}` : ''}`,
        error,
      );
    }
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
    vars: Readonly<Record<string, string | number | undefined>>,
  ): string {
    return template.replace(
      /\{\{(\w+)\}\}/g,
      (_match: string, key: string): string => {
        // Own keys only: `{{constructor}}` must not reach Object.prototype.
        const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
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
    vars: Readonly<Record<string, string | number | undefined>>,
  ): readonly string[] {
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
    } catch (error: unknown) {
      if (codeOf(error) !== 'ENOENT') {
        throw error;
      }
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
    const user = this.config.getRegistryUser();
    const password = this.config.getRegistryPassword();
    if (user === undefined || password === undefined) {
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
      user,
      '--password-stdin',
    ];

    this.exec(loginArgs, {
      input: password,
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
  abstract build(params: BuildParams): BuildResult;

  /**
   * Performs any tag/push/cleanup that must happen during publish. No-op
   * for strategies that push during the build step.
   *
   * @param state The stored build state.
   */
  abstract finalizePublish(state: BuildState): void;
}
