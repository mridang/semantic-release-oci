import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The directory that holds every temporary directory of this test file.
 */
const root = mkdtempSync(join(tmpdir(), 'semantic-release-oci-'));

process.on('exit', () => rmSync(root, { recursive: true, force: true }));

/**
 * Create a temporary directory that {@link removeTempDirs} deletes. Register
 * `afterEach(removeTempDirs)` in the test file, so the directory is removed
 * even when an assertion fails.
 * @returns The directory path.
 */
export function makeTempDir(): string {
  return mkdtempSync(join(root, 'test-'));
}

/**
 * Remove every directory made by {@link makeTempDir} so far.
 */
export function removeTempDirs(): void {
  readdirSync(root).forEach((name) =>
    rmSync(join(root, name), { recursive: true, force: true }),
  );
}
