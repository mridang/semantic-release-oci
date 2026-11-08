const MASK = '***';

/**
 * Values shorter than this are not scrubbed by value: replacing one or two
 * characters would mangle the text around them and hide nothing.
 */
const MIN_SECRET_LENGTH = 3;

/**
 * Names that mark a `key=value` pair, or a flag, as carrying a credential.
 */
const SENSITIVE =
  /secret|token|passw|credential|api[_-]?key|access[_-]?key|auth/i;

/**
 * Flags whose value is a `KEY=value` assignment.
 */
const ASSIGNING_FLAGS = ['--build-arg', '--set'] as const;

/**
 * The assignment an argument carries, when it is one: the argument after
 * `--build-arg` or `--set`, or the joined form `--build-arg=KEY=value`. A
 * `--set` only counts when it sets a build argument (`*.args.KEY=value`).
 *
 * @param args  Docker arguments.
 * @param index Position of the argument to look at.
 * @returns The `KEY=value` text, or undefined when it is not an assignment.
 */
function assignmentAt(
  args: readonly string[],
  index: number,
): string | undefined {
  const arg = args[index] ?? '';
  const previous = args[index - 1];
  const hit = ASSIGNING_FLAGS.flatMap((flag) => {
    if (previous === flag) {
      return [{ flag, payload: arg }];
    }
    return arg.startsWith(`${flag}=`)
      ? [{ flag, payload: arg.slice(flag.length + 1) }]
      : [];
  })[0];
  if (!hit) {
    return undefined;
  }
  return hit.flag === '--build-arg' || /^[^=]*\.args\.[^=]*=/.test(hit.payload)
    ? hit.payload
    : undefined;
}

/**
 * The text after the first `=`.
 *
 * @param assignment A `KEY=value` string.
 * @returns The value, or undefined when there is no `=`.
 */
function valueOf(assignment: string): string | undefined {
  const at = assignment.indexOf('=');
  return at < 0 ? undefined : assignment.slice(at + 1);
}

/**
 * Credentials hidden inside one argument that is not a plain assignment:
 * `key=value` pairs whose key names a credential (`secret_access_key=...` in
 * a cache spec), the password of `user:password@host`, and the value of a
 * flag that names a credential (`--password`, `--auth-token=...`).
 *
 * @param args  Docker arguments.
 * @param index Position of the argument to look at.
 * @returns The credential values found.
 */
function embeddedSecrets(
  args: readonly string[],
  index: number,
): readonly string[] {
  const arg = args[index] ?? '';
  const previous = args[index - 1] ?? '';
  const pairs = arg.split(',').flatMap((piece) => {
    const at = piece.indexOf('=');
    return at > 0 && SENSITIVE.test(piece.slice(0, at))
      ? [piece.slice(at + 1)]
      : [];
  });
  const userinfo =
    /^--cache-(?:from|to)$/.test(previous) || /^--cache-(?:from|to)=/.test(arg)
      ? [...arg.matchAll(/[=,/]?[^\s/@:,=]+:([^\s/@,]+)@/g)].flatMap((match) =>
          match[1] ? [match[1]] : [],
        )
      : [];
  const flagValue =
    previous.startsWith('--') &&
    !previous.includes('=') &&
    SENSITIVE.test(previous)
      ? [arg]
      : [];
  const joinedFlagValue =
    /^--[^=]+=/.test(arg) && SENSITIVE.test(arg.slice(0, arg.indexOf('=')))
      ? [arg.slice(arg.indexOf('=') + 1)]
      : [];
  return [...pairs, ...userinfo, ...flagValue, ...joinedFlagValue];
}

/**
 * Every secret value that a docker command line carries: build-argument
 * values, credentials inside flag values and cache specs, and the user of a
 * registry login (some registries use a token as the user name).
 *
 * @param args Docker arguments.
 * @returns The distinct values worth hiding, longest first.
 */
export function secretsIn(args: readonly string[]): readonly string[] {
  const found = args.flatMap((arg, index) => {
    const assignment = assignmentAt(args, index);
    const assigned = assignment === undefined ? undefined : valueOf(assignment);
    const loginUser =
      args[0] === 'login' && args[index - 1] === '-u' ? [arg] : [];
    return [
      ...(assigned === undefined ? [] : [assigned]),
      ...embeddedSecrets(args, index),
      ...loginUser,
    ];
  });
  return [...new Set(found)]
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    .toSorted((a, b) => b.length - a.length);
}

/**
 * Replace every secret in a text.
 *
 * @param text    Text that may contain secrets, such as docker's stderr.
 * @param secrets Values to hide, as returned by {@link secretsIn}.
 * @returns The text with every secret replaced.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (clean, secret) => clean.replaceAll(secret, MASK),
    text,
  );
}

/**
 * The args with the value of every build argument masked by position, so
 * that even a value too short to be scrubbed by value is not shown.
 *
 * @param args Docker arguments.
 * @returns The arguments, safe to join into a log line once scrubbed.
 */
export function maskAssignments(args: readonly string[]): readonly string[] {
  return args.map((arg, index) => {
    const assignment = assignmentAt(args, index);
    if (assignment === undefined) {
      return arg;
    }
    const at = assignment.indexOf('=');
    // The assignment is the end of the argument, after any `--flag=` prefix.
    return at < 0
      ? arg
      : `${arg.slice(0, arg.length - assignment.length)}${assignment.slice(0, at)}=${MASK}`;
  });
}
