import fs from 'node:fs';
import path from 'node:path';
import { setSecret } from '@actions/core';
import SemanticReleaseError from '@semantic-release/error';
import type { VerifyConditionsContext } from 'semantic-release';
import { codeOf, signalOf, statusOf } from '../utils/error.js';
import { run as defaultRun, type Runner } from '../utils/exec.js';
import { isRecord, stringAt } from '../utils/object.js';
import { maskArgs, scrub, secretsIn } from './secrets.js';

/**
 * Runs one docker command and returns what it wrote to stdout. Every noun
 * that works with docker (a build, an image, a registry) is given one, so
 * logging, secret hiding and error mapping happen in a single place.
 */
export type DockerRun = (args: readonly string[], input?: string) => string;

/**
 * What a {@link dockerRun} needs.
 */
export interface DockerRunOptions {
  /** Directory the commands run in. */
  readonly cwd: string;
  /** The release's environment, added to this process's. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Milliseconds after which a command is killed. */
  readonly timeoutMs: number;
  /** Where the executed commands are logged. */
  readonly logger: Pick<VerifyConditionsContext['logger'], 'log'>;
  /** Runs the program; only tests pass one. */
  readonly run?: Runner;
  /** Reads a file named by `--secret src=`; only tests pass one. */
  readonly readFile?: (file: string) => string | undefined;
}

/**
 * Reads a text file, relative to the working directory.
 *
 * @param cwd  Directory relative paths are resolved against.
 * @param file Path of the file.
 * @returns The contents, or undefined when the file cannot be read.
 */
function readText(cwd: string, file: string): string | undefined {
  try {
    return fs.readFileSync(path.resolve(cwd, file), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A docker command that did not succeed, as semantic-release prints it: a
 * `SemanticReleaseError` with the code `EDOCKER`. It keeps the exit status,
 * signal and error code of the failure, but its message is rebuilt from
 * scrubbed parts only, because the error Node throws embeds the full command
 * line.
 */
class DockerCommandError extends SemanticReleaseError {
  /** The exit status of the command, when it ran and failed. */
  readonly status: number | undefined;

  /** The signal that killed the command. */
  readonly signal: string | undefined;

  /** The code of the underlying failure, such as `ENOENT` or `ETIMEDOUT`. */
  readonly errno: string | undefined;

  /**
   * @param message The scrubbed message.
   * @param source  The error that was thrown by the runner.
   */
  constructor(message: string, source: unknown) {
    super(message, 'EDOCKER');
    this.status = statusOf(source);
    this.signal = signalOf(source);
    this.errno = codeOf(source);
  }
}

/**
 * What a failed docker call has to say, chosen by the shape of the failure
 * and never by its message text, which holds the command line: the code and
 * signal when there are any, and what the command wrote to stderr. A value
 * that is not an error is described by its string form.
 *
 * @param error The value thrown by the runner.
 * @returns The lines of detail, which are not yet scrubbed.
 */
function detailsOf(error: unknown): readonly string[] {
  if (!isRecord(error)) {
    return [String(error)];
  }
  const signal = signalOf(error);
  const reason = [codeOf(error), signal ? `killed by ${signal}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(', ');
  return [reason, stringAt(error, 'stderr') ?? ''];
}

/**
 * Create the function that runs docker commands. It runs them without a
 * shell, in the release's directory and environment; hides the secrets a
 * command carries from the logged line and from any error; and rebuilds a
 * failure from scrubbed parts only.
 *
 * @param options Directory, environment, timeout, logger and runner.
 * @returns The function that runs a docker command.
 */
export function dockerRun(options: DockerRunOptions): DockerRun {
  const run = options.run ?? defaultRun;
  const readFile =
    options.readFile ?? ((file: string) => readText(options.cwd, file));
  const env = { ...process.env, ...options.env };
  return (args, input) => {
    const nul = args.findIndex((arg) => arg.includes('\0'));
    if (nul >= 0) {
      throw new Error(`Docker argument ${nul} contains a NUL byte.`);
    }
    const secrets = secretsIn(args, env, readFile, input);
    // `setSecret` prints `::add-mask::<value>` to stdout, which only the
    // GitHub Actions runner removes; anywhere else it would leak the value.
    if (env['GITHUB_ACTIONS'] === 'true') {
      secrets.forEach((secret) => setSecret(secret));
    }
    const shown = scrub(['docker', ...maskArgs(args)].join(' '), secrets);
    options.logger.log(`Executing: ${shown}`);
    try {
      return run('docker', args, {
        cwd: options.cwd,
        env: options.env,
        input,
        timeout: options.timeoutMs,
      });
    } catch (error: unknown) {
      const details = detailsOf(error)
        .map((detail) => scrub(detail, secrets))
        .filter((detail) => detail !== '');
      throw new DockerCommandError(
        ['Command failed: ' + shown, ...details].join('\n'),
        error,
      );
    }
  };
}

/**
 * Verifies the Docker CLI is installed and reachable.
 *
 * @param docker Runs docker commands.
 * @throws SemanticReleaseError with code `ENOENT` when Docker is not
 *         installed; any other failure is rethrown with its detail.
 */
export function assertDockerAvailable(docker: DockerRun): void {
  try {
    docker(['version']);
  } catch (error: unknown) {
    if (!(error instanceof DockerCommandError) || error.errno !== 'ENOENT') {
      throw error;
    }
    throw new SemanticReleaseError(
      'Docker is not installed or not available in PATH. Ensure Docker is installed and accessible.',
      'ENOENT',
    );
  }
}
