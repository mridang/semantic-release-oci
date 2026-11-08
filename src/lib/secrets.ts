import { redactSecrets } from '../utils/redact.js';

/**
 * What a secret is replaced with.
 */
const MASK = '[redacted]';

/**
 * Values shorter than this are never scrubbed by value, whatever they came
 * from: replacing a few characters would mangle the text around them.
 */
const MIN_SECRET_LENGTH = 4;

/**
 * Shortest value that is scrubbed when only its place in the command made it
 * a secret (a literal build argument with an unremarkable name), as opposed to
 * one whose name or position says it is a credential.
 */
const MIN_DEFAULT_LENGTH = 6;

/**
 * Key names (of build arguments and of `key=value` pairs) that carry a
 * credential. A name matches when the word stands alone or is set off by
 * punctuation, so `NPM_TOKEN` and `secret_access_key` match and `AUTHORS`,
 * `VERSION` and `KEYBOARD` do not.
 */
const SENSITIVE_KEY =
  /(?:^|[^a-z])(?:token|secret|passw(?:or)?d|credentials?|api-?key|access-?key|key|auth|cert|npmrc)(?:[^a-z]|$)/i;

/**
 * Names of build arguments that carry a known-public release variable, such
 * as a version, a commit or a build date. These are the only literal build
 * arguments that are not hidden from error text by default.
 */
const PUBLIC_KEY =
  /(?:^|[^a-z])(?:version|major|minor|patch|git-?tag|git-?sha|git-?head|git-?commit|commit|revision|build-?date|build-?time|channel)(?:[^a-z]|$)/i;

/**
 * Values too common to hide when only the place made them secret: hiding
 * `production` or `true` from an error would make it unreadable.
 */
const COMMON_VALUE =
  /^(?:true|false|yes|no|on|off|production|development|test|latest|debug|release)$/i;

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
 * The password of a `user:password@host` cache reference in one piece of a
 * cache spec. The piece is cut at its last `@` first, so the pattern only
 * ever scans the text before it, once.
 *
 * @param piece One comma-separated piece of a cache spec.
 * @returns The password, or undefined when the piece has none.
 */
function cachePassword(piece: string): string | undefined {
  const at = piece.lastIndexOf('@');
  if (at < 0) {
    return undefined;
  }
  return /^(?:[^=]*=)?(?:[a-z][a-z0-9+.-]*:\/\/)?[^\s/@:=]+:([^\s/@]+)$/i.exec(
    piece.slice(0, at),
  )?.[1];
}

/**
 * Where a `--secret` mount gets its value: the environment variable named by
 * `env=` and the file named by `src=` or `source=`.
 *
 * @param spec     The `--secret` specification (`id=npm,env=TOKEN`).
 * @param env      The environment docker runs with.
 * @param readFile Reads a file, or returns undefined when it cannot.
 * @returns The values the mount will carry.
 */
function mountSecrets(
  spec: string,
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): readonly (string | undefined)[] {
  return spec.split(',').map((piece) => {
    const at = piece.indexOf('=');
    const name = piece.slice(0, at);
    const value = piece.slice(at + 1);
    if (at < 0) {
      return undefined;
    }
    if (name === 'env') {
      return Object.hasOwn(env, value) ? env[value] : undefined;
    }
    if (name === 'src' || name === 'source') {
      return readFile(value)?.trim();
    }
    return undefined;
  });
}

/**
 * Credentials hidden inside an argument that is not a build argument:
 * `key=value` pairs whose key names a credential (`secret_access_key=...`,
 * `--auth-token=...`), the password of `user:password@host` in a cache spec,
 * the value of a flag that names a credential (`--auth-token`), and what a
 * `--secret` mount reads from the environment or a file.
 *
 * @param arg      The argument.
 * @param previous The argument before it.
 * @param env      The environment docker runs with.
 * @param readFile Reads a file, or returns undefined when it cannot.
 * @returns The credential values found.
 */
function embeddedSecrets(
  arg: string,
  previous: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): readonly (string | undefined)[] {
  const pieces = arg.split(',');
  const pairs = pieces.map((piece) => {
    const at = piece.indexOf('=');
    const key = piece.slice(0, at);
    // `--secret=id=...` only points at a secret; its sources are read below.
    return at > 0 && key !== '--secret' && SENSITIVE_KEY.test(key)
      ? piece.slice(at + 1)
      : undefined;
  });
  const cache =
    (previous !== undefined && CACHE_FLAG.test(previous)) ||
    /^--cache-(?:from|to)=/.test(arg);
  const passwords = cache ? pieces.map(cachePassword) : [];
  const flagValue =
    previous !== undefined && SENSITIVE_FLAG.test(previous) ? [arg] : [];
  const mount =
    previous === '--secret' ? arg : /^--secret=(.*)$/.exec(arg)?.[1];
  const mounted = mount === undefined ? [] : mountSecrets(mount, env, readFile);
  return [...pairs, ...passwords, ...flagValue, ...mounted];
}

/**
 * The value of a build argument that is worth hiding, with the shortest
 * length at which it is scrubbed. A literal value is hidden by default, the
 * way a credential would be, unless its name is a known-public release
 * variable or the value is a common word; a value docker takes from the
 * environment is looked up there first.
 *
 * @param assignment The build argument.
 * @param env        The environment docker runs with.
 * @returns The value and its length floor, or undefined when it is public.
 */
function assignedSecret(
  assignment: Assignment,
  env: Readonly<Record<string, string | undefined>>,
): { readonly value: string; readonly floor: number } | undefined {
  const { key } = assignment;
  const sensitive = SENSITIVE_KEY.test(key);
  if (!sensitive && PUBLIC_KEY.test(key)) {
    return undefined;
  }
  const value =
    assignment.value ?? (Object.hasOwn(env, key) ? env[key] : undefined);
  if (value === undefined) {
    return undefined;
  }
  if (sensitive) {
    return { value, floor: MIN_SECRET_LENGTH };
  }
  if (COMMON_VALUE.test(value)) {
    return undefined;
  }
  return { value, floor: MIN_DEFAULT_LENGTH };
}

/**
 * Every secret value that a docker command carries: literal build arguments
 * (all of them, except known-public release variables and common words),
 * build arguments that docker takes from the environment, credentials inside
 * flag values and cache specs, what `--secret` mounts read from the
 * environment or from files, and the text sent on stdin. Versions, tags and
 * digests are not build arguments and are never hidden.
 *
 * @param args     Docker arguments.
 * @param env      The environment docker runs with.
 * @param readFile Reads a file named by `--secret src=`, or returns undefined
 *                 when it cannot.
 * @param input    Text written to stdin, such as a registry password.
 * @returns The distinct values worth hiding.
 */
export function secretsIn(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined = () => undefined,
  input?: string,
): readonly string[] {
  const found = args.flatMap((arg, index) => {
    const previous = args[index - 1];
    const assignment = assignmentOf(arg, previous);
    const assigned = assignment ? assignedSecret(assignment, env) : undefined;
    const explicit = embeddedSecrets(arg, previous, env, readFile).flatMap(
      (value) =>
        value === undefined ? [] : [{ value, floor: MIN_SECRET_LENGTH }],
    );
    return assigned ? [assigned, ...explicit] : explicit;
  });
  const sent =
    input === undefined ? [] : [{ value: input, floor: MIN_SECRET_LENGTH }];
  const values = [...found, ...sent]
    .filter(({ value, floor }) => value.length >= floor)
    .map(({ value }) => value);
  return [...new Set(values)];
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
