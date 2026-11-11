/**
 * Normalise an option that is either a comma separated string or a list of
 * strings into a fresh list. Blank items in a string are dropped.
 * @param value - A comma separated string, or a list of strings.
 * @returns A new list of strings.
 */
export function toList(value: string | readonly string[]): readonly string[] {
  if (typeof value !== 'string') {
    return [...value];
  }
  // Whitespace around a comma is dropped; the ends of the string are kept.
  const parts = value.split(',');
  return parts
    .map((part, index) => {
      const head = index === 0 ? part : part.trimStart();
      return index === parts.length - 1 ? head : head.trimEnd();
    })
    .filter(Boolean);
}
