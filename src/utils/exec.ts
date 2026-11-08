import { execFileSync } from 'node:child_process';
import { codeOf, messageOf, signalOf, statusOf } from './error.js';
import { isRecord, stringAt } from './object.js';
import { redactCredentials } from './redact.js';

/**
 * Largest output captured from a command: 64 MiB, so a long listing is not
 * mistaken for a failure.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Options for running a command.
 */
export interface ExecOptions {
  /** Working directory of the command. */
  readonly cwd?: string;
  /** Variables added to the current environment for the command. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Text written to the command's standard input. */
  readonly input?: string;
  /** Milliseconds after which the command is killed. */
  readonly timeout?: number;
  /** Largest stdout or stderr captured, in bytes. */
  readonly maxBuffer?: number;
}

/**
 * Runs a program without a shell and returns its standard output.
 */
export type Runner = (
  file: string,
  args: readonly string[],
  options?: ExecOptions,
) => string;

/**
 * The error raised when a command cannot be started or exits unsuccessfully.
 * It carries the same shape in every plugin: `code` (a system error such as
 * `ENOENT`), `status` (the exit code), `signal`, and the captured output.
 * Credentials are removed from the message and the output.
 */
export class ExecError extends Error {
  readonly code: string | undefined;

  readonly status: number | undefined;

  readonly signal: string | undefined;

  readonly stdout: string;

  readonly stderr: string;

  /**
   * @param message Description of the failure, already free of credentials.
   * @param details The code, exit status, signal and captured output.
   */
  constructor(
    message: string,
    details: {
      readonly code: string | undefined;
      readonly status: number | undefined;
      readonly signal: string | undefined;
      readonly stdout: string;
      readonly stderr: string;
    },
  ) {
    super(message);
    this.name = 'ExecError';
    this.code = details.code;
    this.status = details.status;
    this.signal = details.signal;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

/**
 * Run a program without a shell. Arguments are passed as an array, so nothing
 * in them is interpreted; the environment is the current one plus
 * `options.env`.
 *
 * @param file Program to run.
 * @param args Its arguments.
 * @param options Working directory, extra environment, input, timeout and
 *   output limit.
 * @returns The standard output as a string.
 * @throws ExecError when the program cannot be started or fails; its message
 *   and output have credentials redacted.
 */
export const run: Runner = (file, args, options = {}) => {
  try {
    const output = execFileSync(file, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      input: options.input,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return typeof output === 'string' ? output : '';
  } catch (error: unknown) {
    const text = (key: string): string => {
      const value = isRecord(error) ? stringAt(error, key) : undefined;
      return redactCredentials(value ?? '');
    };
    throw new ExecError(redactCredentials(messageOf(error)), {
      code: codeOf(error),
      status: statusOf(error),
      signal: signalOf(error),
      stdout: text('stdout'),
      stderr: text('stderr'),
    });
  }
};
