/**
 * Normalise an option that is either a comma separated string or a list of
 * strings into a fresh list. Blank items in a string are dropped.
 *
 * @param value A comma separated string, or a list of strings.
 * @returns A new list of strings.
 */
export function toList(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string'
    ? value.split(/\s*,\s*/).filter(Boolean)
    : [...value];
}
