import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The directory that holds every temporary directory of this test file.
 */
// eslint-disable-next-line n/no-sync -- sync is fine in a script or bootstrap: runs once at module load
const root = mkdtempSync(path.join(tmpdir(), 'semantic-release-oci-'));

// eslint-disable-next-line n/no-sync -- sync is fine in a script or bootstrap: the exit handler must be synchronous
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

/**
 * Create a temporary directory that {@link removeTempDirs} deletes. Register
 * `afterEach(removeTempDirs)` in the test file, so the directory is removed
 * even when an assertion fails.
 * @returns The directory path.
 */
export function makeTempDir(): string {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper: tests call it synchronously
  return mkdtempSync(path.join(root, 'test-'));
}

/**
 * Remove every directory made by {@link makeTempDir} so far.
 */
export function removeTempDirs(): void {
  // eslint-disable-next-line n/no-sync -- sync is fine in a test helper: afterEach hooks and tests rely on it finishing
  readdirSync(root).forEach((name) =>
    // eslint-disable-next-line n/no-sync -- sync is fine in a test helper: afterEach hooks and tests rely on it finishing
    rmSync(path.join(root, name), { recursive: true, force: true }),
  );
}
