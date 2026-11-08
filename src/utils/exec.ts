import { execFileSync } from 'node:child_process';
import { codeOf, messageOf, signalOf, statusOf } from './error.js';
import { isRecord, stringAt } from './object.js';
import { redactCredentials } from './redact.js';

/**
 * Options of a {@link Runner} call.
 */
export interface RunOptions {
  /**
   * Directory the program runs in.
   */
  readonly cwd?: string;

  /**
   * Environment of the program. Inherited from this process when omitted.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /**
   * Text written to the program's stdin.
   */
  readonly input?: string;

  /**
   * Milliseconds after which the program is killed.
   */
  readonly timeout?: number;
}

/**
 * A function that runs a program synchronously, without a shell: the program
 * and each argument are passed separately, so values are never interpreted as
 * shell syntax. Clients take one as a parameter, so they are unit-testable
 * without mocking Node's built-in modules.
 *
 * It returns what the program wrote to stdout and throws an {@link ExecError}
 * when the program cannot be run or exits unsuccessfully.
 */
export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => string;

/**
 * The largest output, in bytes, a child process may write before it is
 * killed. Node's default of 1 MiB makes chatty build output fail with
 * `ENOBUFS`.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * A failed child process. Its message and `stderr` have had credentials in
 * URLs and well-known tokens redacted, and it keeps the machine-readable
 * fields of the original error, so callers can tell a missing program
 * (`ENOENT`) from a failing one (`status`) or a kill (`signal`) without
 * carrying the unredacted original along.
 */
export class ExecError extends Error {
  /**
   * The error code, such as `ENOENT` or `ETIMEDOUT`.
   */
  readonly code: string | undefined;

  /**
   * The exit status of a program that ran and failed.
   */
  readonly status: number | undefined;

  /**
   * The signal that killed the program.
   */
  readonly signal: string | undefined;

  /**
   * What the program wrote to stderr, redacted.
   */
  readonly stderr: string | undefined;

  /**
   * @param source The error thrown by `execFileSync`.
   */
  constructor(source: unknown) {
    super(redactCredentials(messageOf(source)));
    this.name = 'ExecError';
    this.code = codeOf(source);
    this.status = statusOf(source);
    this.signal = signalOf(source);
    const stderr = isRecord(source) ? stringAt(source, 'stderr') : undefined;
    this.stderr = stderr === undefined ? undefined : redactCredentials(stderr);
  }
}

/**
 * The default {@link Runner}, built on Node's `execFileSync`. A failure is
 * rethrown as an {@link ExecError}.
 *
 * @param file The program to run.
 * @param args Its arguments.
 * @param options Directory, environment, stdin and timeout.
 * @returns What the program wrote to stdout.
 * @throws ExecError when the program cannot be run or exits unsuccessfully.
 */
export const run: Runner = (file, args, options = {}) => {
  try {
    const output = execFileSync(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      timeout: options.timeout,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return typeof output === 'string' ? output : '';
  } catch (error: unknown) {
    throw new ExecError(error);
  }
};
