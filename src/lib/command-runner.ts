import { execSync } from 'child_process';
import type { Logger } from './types.js';

/**
 * Options accepted by {@link commandRunner.exec}.
 */
interface ExecOptions {
  cwd: string;
  input?: string;
  stdio?: 'inherit' | 'pipe';
  timeout?: number;
}

/**
 * Executes Docker CLI commands via `child_process.execSync`. Exported as
 * a mutable object so tests can replace `.exec` without running into ESM
 * module immutability restrictions.
 */
export const commandRunner = {
  exec(args: string[], options: ExecOptions, logger: Logger): string {
    const cmd = ['docker', ...args].join(' ');
    logger.log(`Executing: ${cmd}`);
    const result = execSync(cmd, {
      cwd: options.cwd,
      encoding: 'utf8',
      input: options.input,
      stdio: options.stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout ?? 600_000,
    });
    return typeof result === 'string' ? result : '';
  },
};
