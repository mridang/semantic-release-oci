import { jest } from '@jest/globals';
import type { PrepareContext } from 'semantic-release';

/**
 * Build a semantic-release context for a step. The real context carries far
 * more than the plugin reads, so the fixture supplies the parts the plugin
 * uses and is the one place a test context is typed as the library's.
 * @param cwd - Working directory of the release.
 * @param env - Environment variables seen by the plugin.
 * @param overrides - Properties to add or replace, such as `nextRelease`.
 * @returns A context usable for every step, with `jest.fn` loggers.
 */
export function stepContext(
  cwd: string,
  env: Readonly<Record<string, string>> = {},
  overrides: Readonly<Partial<Record<keyof PrepareContext, unknown>>> = {},
): PrepareContext {
  const context = {
    cwd,
    env,
    logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
    nextRelease: {
      version: '1.2.3',
      gitTag: 'v1.2.3',
      gitHead: 'abc1234',
      channel: '',
      type: 'minor',
    },
    options: { dryRun: false },
    stdout: process.stdout,
    stderr: process.stderr,
    envCi: { isCi: false, commit: 'abc1234', branch: 'main' },
    branch: { name: 'main' },
    branches: [],
    commits: [],
    releases: [],
    lastRelease: {
      version: '1.2.2',
      gitTag: 'v1.2.2',
      channels: [],
      gitHead: 'abc1233',
      name: 'v1.2.2',
    },
    ...overrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the fixture supplies the parts the plugin uses, a recording logger instead of the full one and overrides of any type, so this is the one place it is declared to be the library's type
  return context as PrepareContext;
}
