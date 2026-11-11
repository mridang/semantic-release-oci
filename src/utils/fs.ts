import { access } from 'node:fs/promises';

/**
 * Tells whether a file or directory exists.
 * @param target - Path to check.
 * @returns True when the path can be accessed, false otherwise.
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
