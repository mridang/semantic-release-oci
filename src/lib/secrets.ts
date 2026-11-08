import { redactSecrets } from '../utils/redact.js';

/**
 * What a secret is replaced with.
 */
const MASK = '***';

/**
 * Values shorter than this are not scrubbed by value: replacing a few
 * characters would mangle the text around them and hide nothing.
 */
const MIN_SECRET_LENGTH = 6;

/**
 * Key names (of build arguments and of `key=value` pairs) that carry a
 * credential. A name matches when the word stands alone or is set off by
 * punctuation, so `NPM_TOKEN` and `secret_access_key` match and `AUTHORS`,
 * `VERSION` and `KEYBOARD` do not.
 */
const SENSITIVE_KEY =
  /(?:^|[^a-z])(?:token|secret|passw(?:or)?d|credentials?|api-?key|access-?key|key|auth|cert|npmrc)(?:[^a-z]|$)/i;

/**
 * Flags whose value is a credential, such as `--auth-token` or `--password`.
 * `--secret` is not one: its value only points at a secret.
 */
const SENSITIVE_FLAG =
  /^--(?:[a-z0-9]+-)*(?:token|password|passwd|credentials?|auth|api-?key)$/i;

/**
 * Flags that take a cache specification.
 */
const CACHE_FLAG = /^--cache-(?:from|to)$/;

/**
 * A `KEY=value` assignment carried by an argument.
 */
interface Assignment {
  /**
   * The text of the assignment, which ends the argument.
   */
  readonly payload: string;

  /**
   * The build argument's name.
   */
  readonly key: string;

  /**
   * The value, or undefined when the argument has no `=` and docker takes the
   * value from the environment.
   */
  readonly value: string | undefined;
}

/**
 * The build-argument assignment an argument carries, when it is one: the
 * argument after `--build-arg` or `--set`, or the joined form
 * `--build-arg=KEY=value`. A `--set` only counts when it sets a build
 * argument (`*.args.KEY=value`). The value starts at the first `=`.
 *
 * @param arg      The argument.
 * @param previous The argument before it.
 * @returns The assignment, or undefined when the argument is not one.
 */
function assignmentOf(
  arg: string,
  previous: string | undefined,
): Assignment | undefined {
  const joined = /^(--build-arg|--set)=([\s\S]*)$/.exec(arg);
  const flag = joined?.[1] ?? previous;
  const payload = joined?.[2] ?? arg;
  const split = payload.indexOf('=');
  const name = split < 0 ? payload : payload.slice(0, split);
  const value = split < 0 ? undefined : payload.slice(split + 1);
  if (flag === '--build-arg') {
    return { payload, key: name, value };
  }
  const built = /^[^=]*\.args\.([^=]*)$/.exec(name);
  return flag === '--set' && split >= 0 && built?.[1] !== undefined
    ? { payload, key: built[1], value }
    : undefined;
}

/**
 * Credentials hidden inside an argument that is not a build argument:
 * `key=value` pairs whose key names a credential (`secret_access_key=...` in
 * a cache spec), the password of `user:password@host` in a cache spec, and
 * the value of a flag that names a credential (`--auth-token`).
 *
 * @param arg      The argument.
 * @param previous The argument before it.
 * @returns The credential values found.
 */
function embeddedSecrets(
  arg: string,
  previous: string | undefined,
): readonly string[] {
  // Split first and match each piece with anchored patterns, so a long
  // argument cannot make a pattern backtrack.
  const pieces = arg.split(',');
  const pairs = pieces.flatMap((piece) => {
    const at = piece.indexOf('=');
    return at > 0 && SENSITIVE_KEY.test(piece.slice(0, at))
      ? [piece.slice(at + 1)]
      : [];
  });
  const cache =
    (previous !== undefined && CACHE_FLAG.test(previous)) ||
    /^--cache-(?:from|to)=/.test(arg);
  const userinfo = cache
    ? pieces.flatMap((piece) => {
        const password =
          /(?:^|=)(?:[a-z][a-z0-9+.-]*:\/\/)?[^\s/@:]+:([^\s/@]+)@/i.exec(
            piece,
          )?.[1];
        return password === undefined ? [] : [password];
      })
    : [];
  const flagValue =
    previous !== undefined && SENSITIVE_FLAG.test(previous) ? [arg] : [];
  const joinedFlag = /^(--[^=]+)=([\s\S]*)$/.exec(arg);
  const joinedValue =
    joinedFlag?.[1] !== undefined &&
    joinedFlag[2] !== undefined &&
    SENSITIVE_FLAG.test(joinedFlag[1])
      ? [joinedFlag[2]]
      : [];
  return [...pairs, ...userinfo, ...flagValue, ...joinedValue];
}

/**
 * Every secret value that a docker command carries: the value of a build
 * argument whose name looks like a credential, the value of any build
 * argument that docker takes from the environment, and credentials inside
 * flag values and cache specs. Other build arguments (versions, dates, tags)
 * are deliberately not secrets, since hiding them would make the log
 * unreadable.
 *
 * @param args Docker arguments.
 * @param env  The environment docker runs with.
 * @returns The distinct values worth hiding, longest first.
 */
export function secretsIn(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const found = args.flatMap((arg, index) => {
    const previous = args[index - 1];
    const assignment = assignmentOf(arg, previous);
    const assigned =
      assignment === undefined
        ? []
        : assignment.value === undefined
          ? [
              Object.hasOwn(env, assignment.key)
                ? env[assignment.key]
                : undefined,
            ]
          : SENSITIVE_KEY.test(assignment.key)
            ? [assignment.value]
            : [];
    return [...assigned, ...embeddedSecrets(arg, previous)];
  });
  return [...new Set(found)].filter(
    (value): value is string =>
      value !== undefined && value.length >= MIN_SECRET_LENGTH,
  );
}

/**
 * The texts to hide for a secret: the secret, each line of it (BuildKit
 * prefixes every line of output), and its base64 form. The URL-encoded and
 * JSON-escaped forms are added by {@link redactSecrets}.
 *
 * @param secret A secret value.
 * @returns The distinct texts to hide.
 */
function formsOf(secret: string): readonly string[] {
  const parts = [secret, ...secret.split(/\r?\n/).map((line) => line.trim())];
  const forms = parts.flatMap((part) => {
    const base64 = Buffer.from(part).toString('base64');
    return [part, base64, base64.replace(/=+$/, '')];
  });
  return [...new Set(forms)].filter((form) => form.length >= MIN_SECRET_LENGTH);
}

/**
 * Replace every secret, in every form, in a text. This is best effort: a
 * secret that a build step transforms in another way (hashing, splitting
 * across lines) is not recognised.
 *
 * @param text    Text that may contain secrets, such as docker's stderr.
 * @param secrets Values to hide, as returned by {@link secretsIn}.
 * @returns The text with every secret replaced.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  return redactSecrets(text, secrets.flatMap(formsOf));
}

/**
 * The args with what is known by position to be sensitive masked, whatever
 * its length: the value of every build argument, and the user of a registry
 * login.
 *
 * @param args Docker arguments.
 * @returns The arguments, safe to join into a log line.
 */
export function maskArgs(args: readonly string[]): readonly string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1];
    if (args[0] === 'login' && previous === '-u') {
      return MASK;
    }
    const assignment = assignmentOf(arg, previous);
    if (assignment?.value === undefined) {
      return arg;
    }
    const name = assignment.payload.slice(0, assignment.payload.indexOf('='));
    return `${arg.slice(0, arg.length - assignment.payload.length)}${name}=${MASK}`;
  });
}
