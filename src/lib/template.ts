/**
 * Replaces `{{variable}}` placeholders in a template string with values
 * from the provided variables map. Unknown variables resolve to the
 * empty string.
 *
 * @param template Template string containing `{{key}}` placeholders.
 * @param vars     Key-value map of replacement values.
 * @returns        The rendered string.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_match: string, key: string): string => {
      const value = vars[key];
      return value !== undefined ? String(value) : '';
    },
  );
}
