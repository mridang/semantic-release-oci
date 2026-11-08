import { beforeEach, describe, expect, it } from '@jest/globals';
import { Build, type BuildOptions } from '../../src/lib/build.js';
import { dockerRun } from '../../src/lib/docker-run.js';
import { dockerSpy, runnerOf } from '../utils/runner.js';

const spy = dockerSpy();

const BUILD: BuildOptions = {
  buildx: false,
  network: undefined,
  buildTag: undefined,
  tags: [],
  quiet: false,
  noCache: false,
  cacheFrom: [],
  buildArgs: [],
  flags: {},
  platforms: [],
  push: false,
  dockerfile: '/work/Dockerfile',
  context: '/work',
};

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

describe('Build.run', () => {
  it('assembles a plain build in the documented order', () => {
    Build.run(docker, 'app', 'id1', {
      ...BUILD,
      network: 'host',
      buildTag: 'app:id1',
      tags: ['app:1.2.3', 'app:latest'],
      quiet: true,
      noCache: true,
      cacheFrom: ['type=local,src=/c'],
      buildArgs: [
        { key: 'VERSION', value: '1.2.3' },
        { key: 'FROM_ENV', value: undefined },
      ],
      flags: { target: 'prod', s: null, build_context: ['a=b', 'c=d'] },
    });

    expect(spy.mock.calls[0][0]).toEqual([
      'build',
      '--network=host',
      '--tag',
      'app:id1',
      '--tag',
      'app:1.2.3',
      '--tag',
      'app:latest',
      '--quiet',
      '--no-cache',
      '--cache-from',
      'type=local,src=/c',
      '--build-arg',
      'VERSION=1.2.3',
      '--build-arg',
      'FROM_ENV',
      '--target',
      'prod',
      '-s',
      '--build-context',
      'a=b',
      '--build-context',
      'c=d',
      '-f',
      '/work/Dockerfile',
      '/work',
    ]);
  });

  it('adds the platforms, pull and push for a buildx build', () => {
    Build.run(docker, 'app', 'id1', {
      ...BUILD,
      buildx: true,
      platforms: ['linux/amd64', 'linux/arm64'],
      push: true,
    });

    expect(spy.mock.calls[0][0]).toEqual([
      'buildx',
      'build',
      '--platform',
      'linux/amd64,linux/arm64',
      '--pull',
      '--push',
      '-f',
      '/work/Dockerfile',
      '/work',
    ]);
  });

  it('does not push a buildx build that must not publish', () => {
    Build.run(docker, 'app', 'id1', {
      ...BUILD,
      buildx: true,
      platforms: ['linux/amd64'],
    });

    expect(spy.mock.calls[0][0]).not.toContain('--push');
  });

  it('keeps flags that already start with a dash as they are', () => {
    Build.run(docker, 'app', 'id1', {
      ...BUILD,
      flags: { '--Keep_Case': 'x' },
    });

    expect(spy.mock.calls[0][0]).toContain('--Keep_Case');
  });

  it('keeps shell metacharacters in one argument and values literal', () => {
    const arg = 'MSG=hello world; touch /tmp/pwned $(id) `id` * $HOME ~ "q"';

    Build.run(docker, 'app', 'id1', { ...BUILD, flags: { label: arg } });

    expect(spy.mock.calls[0][0]).toContain(arg);
  });

  it('takes the digest from the last line that names one', () => {
    spy.mockReturnValue(
      '#8 exporting\n#8 writing image sha256:abc123def456 done\nnothing\n',
    );

    expect(Build.run(docker, 'app', 'id1', BUILD).digest).toBe('abc123def456');
  });

  it('has an empty digest when the output names none', () => {
    spy.mockReturnValue('Step 1/1 : FROM alpine\n');

    expect(Build.run(docker, 'app', 'id1', BUILD).digest).toBe('');
  });
});

describe('Build', () => {
  const build = new Build(docker, 'app', 'id1', 'abc');

  it('tags the build and returns the image under the new tag', () => {
    const image = build.tag('1.2.3');

    expect(spy.mock.calls[0][0]).toEqual(['tag', 'app:id1', 'app:1.2.3']);
    expect(image.reference).toBe('app:1.2.3');
  });

  it('force-removes the local images of the repository', () => {
    spy.mockReturnValueOnce('id1\nid2\n');

    build.remove();

    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      ['images', 'app', '-q'],
      ['rmi', '-f', 'id1', 'id2'],
    ]);
  });

  it('removes nothing when there are no local images', () => {
    spy.mockReturnValueOnce('  \n');

    build.remove();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
