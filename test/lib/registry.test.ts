import { beforeEach, describe, expect, it } from '@jest/globals';
import { dockerRun } from '../../src/lib/docker-run.js';
import { Registry } from '../../src/lib/registry.js';
import { dockerSpy, runnerOf } from '../utils/runner.js';

const spy = dockerSpy();

const docker = dockerRun({
  cwd: '/work',
  env: {},
  timeoutMs: 1000,
  logger: { log: () => undefined },
  run: runnerOf(spy),
});

beforeEach(() => {
  spy.mockReset();
  spy.mockReturnValue('');
});

describe('Registry', () => {
  it('logs in to a host with the password on stdin', async () => {
    const registry = new Registry(docker, 'ghcr.io');

    expect(await registry.login('user', 'pass')).toBe(registry);

    expect(spy.mock.calls[0][0]).toEqual([
      'login',
      'ghcr.io',
      '-u',
      'user',
      '--password-stdin',
    ]);
    expect(spy.mock.calls[0][1]).toEqual(
      expect.objectContaining({ input: 'pass' }),
    );
  });

  it('logs in to the default registry when there is no host', async () => {
    await new Registry(docker, undefined).login('user', 'pass');

    expect(spy.mock.calls[0][0]).toEqual([
      'login',
      '-u',
      'user',
      '--password-stdin',
    ]);
  });
});
