/**
 * Normalise an option that is either a comma separated string or a list of
 * strings into a fresh list. Blank items in a string are dropped.
 * @param value - A comma separated string, or a list of strings.
 * @returns A new list of strings.
 */
export function toList(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string'
    ? // eslint-disable-next-line sonarjs/super-linear-regex -- the input is a short configuration string, so the whitespace runs are bounded
      value.split(/\s*,\s*/).filter(Boolean)
    : [...value];
}
