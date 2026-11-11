import { beforeEach, describe, expect, it } from '@jest/globals';
import { Build, type BuildOptions } from '../../src/lib/build.js';
import { dockerRun } from '../../src/lib/docker-run.js';
import { dockerSpy, runnerOf } from '../utils/runner.js';

const spy = dockerSpy();

// Declared without a value, so it is undefined: the options leave these unset.
let unset: string | undefined;

const BUILD: BuildOptions = {
  buildx: false,
  network: unset,
  buildTag: unset,
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
  it('assembles a plain build in the documented order', async () => {
    await Build.run(docker, 'app', 'id1', {
      ...BUILD,
      network: 'host',
      buildTag: 'app:id1',
      tags: ['app:1.2.3', 'app:latest'],
      quiet: true,
      noCache: true,
      cacheFrom: ['type=local,src=/c'],
      buildArgs: [
        { key: 'VERSION', value: '1.2.3' },
        { key: 'FROM_ENV', value: unset },
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

  it('adds the platforms, pull and push for a buildx build', async () => {
    await Build.run(docker, 'app', 'id1', {
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

  it('does not push a buildx build that must not publish', async () => {
    await Build.run(docker, 'app', 'id1', {
      ...BUILD,
      buildx: true,
      platforms: ['linux/amd64'],
    });

    expect(spy.mock.calls[0][0]).not.toContain('--push');
  });

  it('keeps flags that already start with a dash as they are', async () => {
    await Build.run(docker, 'app', 'id1', {
      ...BUILD,
      flags: { '--Keep_Case': 'x' },
    });

    expect(spy.mock.calls[0][0]).toContain('--Keep_Case');
  });

  it('keeps shell metacharacters in one argument and values literal', async () => {
    const arg = 'MSG=hello world; touch /tmp/pwned $(id) `id` * $HOME ~ "q"';

    await Build.run(docker, 'app', 'id1', { ...BUILD, flags: { label: arg } });

    expect(spy.mock.calls[0][0]).toContain(arg);
  });

  it('takes the digest from the last line that names one', async () => {
    spy.mockReturnValue(
      '#8 exporting\n#8 writing image sha256:abc123def456 done\nnothing\n',
    );

    const built = await Build.run(docker, 'app', 'id1', BUILD);

    expect(built.digest).toBe('abc123def456');
  });

  it('takes the last digest when several lines name one', async () => {
    spy.mockReturnValue(
      '#9 exporting manifest sha256:aaaa1111\n#9 writing image sha256:bbbb2222\n',
    );

    const built = await Build.run(docker, 'app', 'id1', BUILD);

    expect(built.digest).toBe('bbbb2222');
  });

  it('has an empty digest when the output names none', async () => {
    spy.mockReturnValue('Step 1/1 : FROM alpine\n');

    const built = await Build.run(docker, 'app', 'id1', BUILD);

    expect(built.digest).toBe('');
  });
});

describe('Build', () => {
  const build = new Build(docker, 'app', 'id1', 'abc');

  it('tags the build and returns the image under the new tag', async () => {
    const image = await build.tag('1.2.3');

    expect(spy.mock.calls[0][0]).toEqual(['tag', 'app:id1', 'app:1.2.3']);
    expect(image.reference).toBe('app:1.2.3');
  });

  it('force-removes the local images of the repository', async () => {
    spy.mockReturnValueOnce('id1\nid2\n');

    await build.remove();

    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      ['images', 'app', '-q'],
      ['rmi', '-f', 'id1', 'id2'],
    ]);
  });

  it('removes nothing when there are no local images', async () => {
    spy.mockReturnValueOnce('  \n');

    await build.remove();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
