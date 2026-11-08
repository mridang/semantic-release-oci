import { describe, it, expect, afterEach } from '@jest/globals';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    execSync('docker buildx bake --help', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function imageExists(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function removeImage(ref: string): void {
  try {
    execSync(`docker image rm -f ${ref}`, { stdio: 'ignore' });
  } catch {
    /* image may not exist; nothing to clean up */
  }
}

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-bake-it-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM busybox:latest\n');
  fs.writeFileSync(
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

  afterEach(() => {
    removeImage(`${repo}:1.2.3`);
    removeImage(`${repo}:latest`);
    if (projectDir) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      projectDir = '';
    }
  });

  it('builds the image, applies every tag, and captures a real digest', () => {
    projectDir = makeProject();
    const strategy = makeStrategy(projectDir, {
      target: 'image',
      imageTarget: 'image',
    });

    const result = strategy.build({
      repo,
      tagTemplates: ['1.2.3', 'latest'],
      vars: { version: '1.2.3', major: '1' },
      buildId: `it${process.pid}`,
      isDryRun: false,
    } satisfies BuildParams);

    expect(result.tags).toEqual(['1.2.3', 'latest']);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imageExists(`${repo}:1.2.3`)).toBe(true);
    expect(imageExists(`${repo}:latest`)).toBe(true);
  }, 180_000);

  it('validates without producing an image in dry-run mode', () => {
    projectDir = makeProject();
    const strategy = makeStrategy(projectDir, {
      target: 'image',
      imageTarget: 'image',
    });

    const result = strategy.build({
      repo,
      tagTemplates: ['1.2.3'],
      vars: { version: '1.2.3', major: '1' },
      buildId: `itdry${process.pid}`,
      isDryRun: true,
    } satisfies BuildParams);

    expect(result.tags).toEqual(['1.2.3']);
    expect(imageExists(`${repo}:1.2.3`)).toBe(false);
  }, 180_000);
});
