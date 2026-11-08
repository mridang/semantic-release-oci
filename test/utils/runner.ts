import { jest } from '@jest/globals';
import type { ExecOptions, Runner } from '../../src/utils/exec.js';

/**
 * A spy that stands in for the docker binary: it receives the arguments (not
 * the program name) and the options of each call, and returns its stdout.
 */
export type DockerSpy = jest.Mock<
  (args: readonly string[], options?: ExecOptions) => string
>;

/**
 * Create a spy for the docker binary that succeeds with empty output.
 *
 * @returns The spy.
 */
export function dockerSpy(): DockerSpy {
  return jest
    .fn<(args: readonly string[], options?: ExecOptions) => string>()
    .mockReturnValue('');
}

/**
 * Adapt a docker spy to the {@link Runner} a client takes.
 *
 * @param spy The spy that records the calls.
 * @returns A runner that forwards to it.
 */
export function runnerOf(spy: DockerSpy): Runner {
  return async (_file, args, options) => spy(args, options);
}

/**
 * The error a docker command that ran and failed throws: an exit status and
 * what it wrote to stderr.
 *
 * @param stderr What the command wrote to stderr.
 * @returns The error to throw from a spy.
 */
export function failure(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { status: 1, stderr });
}
