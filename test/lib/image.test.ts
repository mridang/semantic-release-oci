import { beforeEach, describe, expect, it } from '@jest/globals';
import { dockerRun } from '../../src/lib/docker-run.js';
import { Image } from '../../src/lib/image.js';
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

describe('Image', () => {
  it('is known by repository and tag', async () => {
    expect(new Image(docker, 'ghcr.io/o/app', '1.2.3').reference).toBe(
      'ghcr.io/o/app:1.2.3',
    );
  });

  it('pushes its reference and returns the pushed image with the output', async () => {
    spy.mockReturnValue('The push refers to repository [app]\n');
    const image = new Image(docker, 'app', '1');

    const pushed = await image.push();

    expect(spy.mock.calls[0][0]).toEqual(['push', 'app:1']);
    expect(pushed.image).toBe(image);
    expect(pushed.output).toBe('The push refers to repository [app]');
  });
});
