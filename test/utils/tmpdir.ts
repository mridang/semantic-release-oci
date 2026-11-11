import { rmSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The directory that holds every temporary directory of this test file.
 */
const root = await mkdtemp(path.join(tmpdir(), 'semantic-release-oci-'));

process.on('exit', () => rmSync(root, { recursive: true, force: true }));

/**
 * Create a temporary directory that {@link removeTempDirs} deletes. Register
 * `afterEach(removeTempDirs)` in the test file, so the directory is removed
 * even when an assertion fails.
 * @returns The directory path.
 */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(root, 'test-'));
}

/**
 * Remove every directory made by {@link makeTempDir} so far.
 */
export async function removeTempDirs(): Promise<void> {
  const names = await readdir(root);
  await Promise.all(
    names.map((name) =>
      rm(path.join(root, name), { recursive: true, force: true }),
    ),
  );
}
