import { describe, expect, it } from '@jest/globals';
import { maskArgs, scrub, secretsIn } from '../../src/lib/secrets.js';

describe('secretsIn', () => {
  const env = { FROM_ENV_TOKEN: 'ENVSECRET99', VERSION: '1.2.3.4.5' };
  const readFile = (file: string): string | undefined =>
    file === '/run/token' ? 'FILESECRET1\n' : undefined;

  it.each([
    [['build', '--build-arg', 'NPM_TOKEN=abc123xyz'], ['abc123xyz']],
    [['build', '--build-arg=NPM_TOKEN=abc123xyz'], ['abc123xyz']],
    [['bake', '--set', '*.args.NPM_TOKEN=abc123xyz'], ['abc123xyz']],
    [['bake', '--set=*.args.NPM_TOKEN=abc123xyz'], ['abc123xyz']],
    [['bake', '--set', 'image.tags=repo:abc123xyz'], []],
    [['build', '--build-arg', 'NPM_TOKEN=a=b.args.c=d1'], ['a=b.args.c=d1']],
    [['build', '--build-arg', 'FLAG'], []],
    [['build', '--build-arg', 'FROM_ENV_TOKEN'], ['ENVSECRET99']],
    [['build', '--build-arg', 'VERSION'], []],
    [['build', '--build-arg', 'NODE_VERSION=22.1.0'], []],
    [['build', '--build-arg', 'GIT_COMMIT=abcdef0123456'], []],
    [['build', '--build-arg', 'GH_PAT=PatValueABCDEF12'], ['PatValueABCDEF12']],
    [['build', '--build-arg', 'DEBUG=production'], []],
    [['build', '--build-arg', 'APP_MODE=prod-eu1'], ['prod-eu1']],
    [['build', '--build-arg', 'SHORT=abc12'], []],
    [['build', '--build-arg', 'NPM_TOKEN=ab12'], ['ab12']],
    [['build', '--build-arg', 'NPM_TOKEN=ab1'], []],
    [['build', '--build-arg', 'MISSING'], []],
    [['build', '--build-arg', 'VERSION=abcdefgh'], []],
    [['build', '--build-arg', 'AUTHORS=abcdefgh'], ['abcdefgh']],
    [['build', '--build-arg', 'ssh_key=abcdefgh'], ['abcdefgh']],
    [
      ['build', '--cache-from', 'type=s3,secret_access_key=KEY123abc,bucket=b'],
      ['KEY123abc'],
    ],
    [
      ['build', '--cache-to', `type=registry,ref=u:PASS1234${'@'}host/x`],
      ['PASS1234'],
    ],
    [
      [
        'build',
        '--cache-from',
        'type=registry,ref=ghcr.io/o/a:latest@sha256:abc',
      ],
      [],
    ],
    [['build', '--auth-token', 'TOK123abc'], ['TOK123abc']],
    [['build', '--password=PW123abcd'], ['PW123abcd']],
    [['build', '--secret', 'id=npm,env=FROM_ENV_TOKEN'], ['ENVSECRET99']],
    [['build', '--secret=id=npm,env=FROM_ENV_TOKEN'], ['ENVSECRET99']],
    [['build', '--secret', 'id=npm,env=UNSET'], []],
    [['build', '--secret', 'id=npm,src=/run/token'], ['FILESECRET1']],
    [['build', '--secret', 'id=npm,source=/run/token'], ['FILESECRET1']],
    [['build', '--secret', 'id=npm,src=/missing'], []],
    [['build', '--secret', 'id=npm,type=file'], []],
    [['build', '--secret', 'id'], []],
    [['build', '--secret', 'id=npm,src=/home/x/.npmrc'], []],
    [['build', '--tag', 'repo:1.2.3@sha256:abcdef'], []],
    [['login', 'ghcr.io', '-u', 'someuser1', '--password-stdin'], []],
  ])('finds the secrets in %j', async (args, expected) => {
    expect(await secretsIn(args, env, readFile)).toEqual(expected);
  });

  it('ignores an inherited member of the environment', async () => {
    expect(
      await secretsIn(['build', '--build-arg', 'constructor'], {}),
    ).toEqual([]);
  });

  it('reads no files unless it is given a reader', async () => {
    expect(
      await secretsIn(['build', '--secret', 'id=a,src=/run/token'], {}),
    ).toEqual([]);
  });

  it('includes what is sent on stdin', async () => {
    expect(
      await secretsIn(['login'], {}, undefined, 'registry-password'),
    ).toEqual(['registry-password']);
    expect(await secretsIn(['login'], {}, undefined, 'abc')).toEqual([]);
  });

  it('scans a long cache spec in linear time', async () => {
    const started = performance.now();

    await secretsIn(
      ['build', '--cache-from', `type=${'a:a='.repeat(100_000)}`],
      {},
    );

    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('lists each value once', async () => {
    expect(
      await secretsIn(
        [
          'build',
          '--build-arg',
          'A_TOKEN=abcdefg',
          '--build-arg',
          'B_TOKEN=abcdefg',
        ],
        {},
      ),
    ).toEqual(['abcdefg']);
  });
});

describe('scrub', () => {
  it('replaces every occurrence of every secret', () => {
    expect(scrub('abcdef and abcdef and uvwxyz', ['abcdef', 'uvwxyz'])).toBe(
      '[redacted] and [redacted] and [redacted]',
    );
  });

  it.each(['abcdefgh', 'abcdefghi', 'abcdefghij', 'abcdefghijk'])(
    'replaces the base64 form of %s with or without its padding',
    (secret) => {
      const base64 = Buffer.from(secret).toString('base64');
      const bare = base64.replaceAll('=', '');

      expect(scrub(`x ${base64} y ${bare} z`, [secret])).toBe(
        'x [redacted] y [redacted] z',
      );
    },
  );

  it('replaces each line of a multi-line secret and the base64 form', () => {
    const secret = 'first-line-secret\nsecond-line-secret';

    const text = `a first-line-secret b ${Buffer.from(secret).toString('base64')}`;

    expect(scrub(text, [secret])).toBe('a [redacted] b [redacted]');
  });

  it('leaves text without secrets alone', () => {
    expect(scrub('nothing here', [])).toBe('nothing here');
  });
});

describe('maskArgs', () => {
  it('masks build-argument values by position, however short', () => {
    expect(
      maskArgs(['build', '--build-arg', 'N=1', '--build-arg=M=2']),
    ).toEqual([
      'build',
      '--build-arg',
      'N=[redacted]',
      '--build-arg=M=[redacted]',
    ]);
  });

  it('keeps arguments that are not assignments', () => {
    expect(
      maskArgs(['bake', '--set', 'image.tags=x', '--build-arg', 'FLAG']),
    ).toEqual(['bake', '--set', 'image.tags=x', '--build-arg', 'FLAG']);
  });

  it('masks a bake build argument from its first =', () => {
    expect(maskArgs(['--set', '*.args.K=v.args.x=y'])).toEqual([
      '--set',
      '*.args.K=[redacted]',
    ]);
  });

  it('masks the user of a registry login', () => {
    expect(
      maskArgs(['login', 'h', '-u', 'someone', '--password-stdin']),
    ).toEqual(['login', 'h', '-u', '[redacted]', '--password-stdin']);
  });
});
