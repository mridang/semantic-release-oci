import fs from 'fs';
import path from 'path';

const NAME_EXP = /^(?:@([^/]+)\/)?(.+)$/;

/**
 * Splits an npm package name into its optional scope and bare name.
 *
 * @param pkgname Package name, optionally scoped (`@scope/name`).
 * @returns       The parsed `scope` and `name`, each `null` when absent.
 */
export function parsePkgName(pkgname: string): {
  scope: string | null;
  name: string | null;
} {
  const match = NAME_EXP.exec(pkgname);
  if (!match) return { scope: null, name: null };
  return { scope: match[1] ?? null, name: match[2] ?? null };
}

/**
 * Reads `package.json` from the given directory, if present.
 *
 * @param cwd Directory to read `package.json` from.
 * @returns   The parsed package, or `null` when no file exists.
 */
export function readPkg(cwd: string): { name?: string } | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
}

/**
 * Joins the registry, project, and image name into a full repository
 * path, skipping any empty segments.
 *
 * @param registry Registry hostname, or `undefined`.
 * @param project  Project/organization segment, or `undefined`.
 * @param name     Image name.
 * @returns        The combined repository path.
 */
export function buildImageRepo(
  registry: string | undefined,
  project: string | undefined,
  name: string,
): string {
  return [registry, project, name].filter(Boolean).join('/');
}
