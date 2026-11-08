import { describe, expect, it } from '@jest/globals';
import { maskAssignments, scrub, secretsIn } from '../../src/lib/redact.js';

describe('secretsIn', () => {
  it.each([
    [['build', '--build-arg', 'TOKEN=abc123'], ['abc123']],
    [['build', '--build-arg=TOKEN=abc123'], ['abc123']],
    [['bake', '--set', '*.args.TOKEN=abc123'], ['abc123']],
    [['bake', '--set=*.args.TOKEN=abc123'], ['abc123']],
    [['bake', '--set', 'image.tags=repo:abc123'], []],
    [['build', '--build-arg', 'TOKEN=a=b.args.c=d'], ['a=b.args.c=d']],
    [['build', '--build-arg', 'FLAG'], []],
    [['build', '--build-arg', 'TOKEN=ab'], []],
    [
      ['build', '--cache-from', 'type=s3,secret_access_key=KEY123,bucket=b'],
      ['KEY123'],
    ],
    [
      ['build', '--cache-to', `type=registry,ref=u:PASS1${'@'}host/x`],
      ['PASS1'],
    ],
    [['build', '--auth-token', 'TOK123'], ['TOK123']],
    [['build', '--password=PW123'], ['PW123']],
    [['build', '--tag', 'repo:1.2.3@sha256:abcdef'], []],
    [['login', 'ghcr.io', '-u', 'someuser', '--password-stdin'], ['someuser']],
    [['build', '-u', 'someuser'], []],
  ])('finds the secrets in %j', (args, expected) => {
    expect(secretsIn(args)).toEqual(expected);
  });

  it('lists each value once, longest first', () => {
    expect(
      secretsIn([
        'build',
        '--build-arg',
        'A=abcd',
        '--build-arg',
        'B=abcdef',
        '--build-arg',
        'C=abcd',
      ]),
    ).toEqual(['abcdef', 'abcd']);
  });
});

describe('scrub', () => {
  it('replaces every occurrence of every secret', () => {
    expect(scrub('abc and abc and xyz', ['abc', 'xyz'])).toBe(
      '*** and *** and ***',
    );
  });

  it('leaves text without secrets alone', () => {
    expect(scrub('nothing here', [])).toBe('nothing here');
  });
});

describe('maskAssignments', () => {
  it('masks values by position, however short', () => {
    expect(
      maskAssignments(['build', '--build-arg', 'N=1', '--build-arg=M=2']),
    ).toEqual(['build', '--build-arg', 'N=***', '--build-arg=M=***']);
  });

  it('keeps arguments that are not assignments', () => {
    expect(
      maskAssignments(['bake', '--set', 'image.tags=x', '--build-arg', 'FLAG']),
    ).toEqual(['bake', '--set', 'image.tags=x', '--build-arg', 'FLAG']);
  });

  it('masks a bake build argument from its first =', () => {
    expect(maskAssignments(['--set', '*.args.K=v.args.x=y'])).toEqual([
      '--set',
      '*.args.K=***',
    ]);
  });
});
