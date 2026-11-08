import type { DockerRun } from './docker-run.js';

/**
 * A container registry that images are pushed to.
 */
export class Registry {
  /**
   * @param docker Runs docker commands.
   * @param host   Registry host, or undefined for Docker's default.
   */
  constructor(
    private readonly docker: DockerRun,
    readonly host: string | undefined,
  ) {}

  /**
   * Logs in to the registry. The password goes over stdin, so it is never
   * part of a command line.
   *
   * @param user     Registry user.
   * @param password Registry password or token.
   * @returns The registry, now logged in.
   */
  login(user: string, password: string): Registry {
    const host = this.host ? [this.host] : [];
    this.docker(['login', ...host, '-u', user, '--password-stdin'], password);
    return this;
  }
}
