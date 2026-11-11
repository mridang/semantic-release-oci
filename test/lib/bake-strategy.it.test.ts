import { describe, it, expect, afterEach } from '@jest/globals';
import { exec, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BakeStrategy } from '../../src/lib/bake-strategy.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { BuildParams } from '../../src/lib/types.js';
import { stepContext } from '../utils/context.js';

/**
 * Whether a real `docker buildx bake` is reachable on this host. The
 * suite drives the actual Docker CLI, so it self-skips wherever Docker
 * or buildx is absent (e.g. CI runners without a Docker daemon) instead
 * of failing.
 */
const dockerAvailable: boolean = (() => {
  try {
    // eslint-disable-next-line n/no-sync, sonarjs/no-os-command-from-path -- bootstrap probe: it decides at load time whether the suite is defined, so it must be synchronous, and docker is looked up on PATH by design
    execSync('docker buildx bake --help', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const execAsync = promisify(exec);

async function imageExists(ref: string): Promise<boolean> {
  try {
    await execAsync(`docker image inspect ${ref}`);
    return true;
  } catch {
    return false;
  }
}

async function removeImage(ref: string): Promise<void> {
  try {
    await execAsync(`docker image rm -f ${ref}`);
  } catch {
    /* image may not exist; nothing to clean up */
  }
}

async function makeProject(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oci-bake-it-'));
  await fs.promises.writeFile(
    path.join(dir, 'Dockerfile'),
    'FROM busybox:latest\n',
  );
  await fs.promises.writeFile(
    path.join(dir, 'docker-bake.hcl'),
    [
      'target "image" {',
      '  context = "."',
      '  dockerfile = "Dockerfile"',
      '  output = ["type=docker"]',
      '}',
      'group "release" {',
      '  targets = ["image"]',
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

function makeStrategy(
  cwd: string,
  bakeConfig: OciPluginConfig['dockerBake'],
): BakeStrategy {
  const context = stepContext(
    cwd,
    {},
    {
      logger: { log: () => undefined, error: () => undefined },
    },
  );
  const config = new OciConfig({ dockerBake: bakeConfig }, context.env);
  const bake = config.getDockerBake();
  if (!bake) {
    throw new Error('dockerBake must be configured for the bake strategy');
  }
  return new BakeStrategy(config, context, bake);
}

const describeOrSkip = dockerAvailable ? describe : describe.skip;

describeOrSkip('BakeStrategy (integration, real docker buildx bake)', () => {
  const repo = `oci-bake-it-${process.pid}`;
  let projectDir = '';

  afterEach(async () => {
    await removeImage(`${repo}:1.2.3`);
    await removeImage(`${repo}:latest`);
    if (projectDir) {
      await fs.promises.rm(projectDir, { recursive: true, force: true });
      projectDir = '';
    }
  });

  it('builds the image, applies every tag, and captures a real digest', async () => {
    projectDir = await makeProject();
    const strategy = makeStrategy(projectDir, {
      target: 'image',
      imageTarget: 'image',
    });

    const result = await strategy.build({
      repo,
      tagTemplates: ['1.2.3', 'latest'],
      vars: { version: '1.2.3', major: '1' },
      buildId: `it${process.pid}`,
      isDryRun: false,
    } satisfies BuildParams);

    expect(result.tags).toEqual(['1.2.3', 'latest']);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await imageExists(`${repo}:1.2.3`)).toBe(true);
    expect(await imageExists(`${repo}:latest`)).toBe(true);
  }, 180_000);

  it('validates without producing an image in dry-run mode', async () => {
    projectDir = await makeProject();
    const strategy = makeStrategy(projectDir, {
      target: 'image',
      imageTarget: 'image',
    });

    const result = await strategy.build({
      repo,
      tagTemplates: ['1.2.3'],
      vars: { version: '1.2.3', major: '1' },
      buildId: `itdry${process.pid}`,
      isDryRun: true,
    } satisfies BuildParams);

    expect(result.tags).toEqual(['1.2.3']);
    expect(await imageExists(`${repo}:1.2.3`)).toBe(false);
  }, 180_000);
});
