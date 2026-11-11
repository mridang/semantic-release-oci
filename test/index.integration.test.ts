import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { verifyConditions, prepare, publish } from '../src/index.js';
import type { OciPluginConfig } from '../src/plugin-config.js';
import { stepContext } from './utils/context.js';
import { isRecord, stringAt } from '../src/utils/object.js';

const execAsync = promisify(exec);

async function requireDocker(): Promise<void> {
  try {
    await execAsync('docker version');
  } catch {
    throw new Error('Docker is required to run these tests.');
  }
}

async function makeTempDir(): Promise<string> {
  return fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'semantic-release-oci-it-'),
  );
}

describe('semantic-release-oci (integration, real Docker)', () => {
  let registry: StartedTestContainer | null = null;
  let registryHost = '';

  const logger = {
    log: (...args: unknown[]) => {
      console.log(...args);
    },
    error: (...args: unknown[]) => {
      console.error(...args);
    },
  };

  let workdir: string;

  beforeAll(async () => {
    await requireDocker();

    registry = await new GenericContainer('registry:2')
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .start();

    registryHost = `localhost:${registry.getMappedPort(5000)}`;
  }, 120_000);

  afterAll(async () => {
    if (registry !== null) {
      await registry.stop();
    }
  });

  beforeEach(async () => {
    workdir = await makeTempDir();
    await fs.promises.copyFile(
      new URL('fixture/Dockerfile', import.meta.url),
      path.join(workdir, 'Dockerfile'),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(workdir, { recursive: true, force: true });
  });

  it('verifyConditions succeeds with Dockerfile present', async () => {
    const cfg: OciPluginConfig = {
      dockerImage: 'test-app',
      dockerLogin: false,
    };

    const ctx = stepContext(workdir, {}, { logger });

    await expect(verifyConditions(cfg, ctx)).resolves.toBeUndefined();
  }, 30_000);

  it('prepare builds a real Docker image', async () => {
    const cfg: OciPluginConfig = {
      dockerImage: 'test-app',
      dockerRegistry: registryHost,
      dockerTags: ['{{version}}'],
      dockerLogin: false,
      dockerBuildQuiet: false,
      dockerAutoClean: false,
    };

    const ctx = stepContext(
      workdir,
      {},
      {
        logger,
        nextRelease: { version: '1.0.0', gitTag: 'v1.0.0', gitHead: 'abc123' },
      },
    );

    await expect(prepare(cfg, ctx)).resolves.toBeUndefined();
  }, 120_000);

  it('full lifecycle: verify → prepare → publish pushes to registry', async () => {
    const cfg: OciPluginConfig = {
      dockerImage: 'integration-test',
      dockerRegistry: registryHost,
      dockerTags: ['{{version}}', 'latest'],
      dockerLogin: false,
      dockerBuildQuiet: false,
      dockerAutoClean: false,
    };

    const ctx = stepContext(
      workdir,
      {},
      {
        logger,
        nextRelease: { version: '2.0.0', gitTag: 'v2.0.0', gitHead: 'def456' },
      },
    );

    await verifyConditions(cfg, ctx);
    await prepare(cfg, ctx);
    await publish(cfg, ctx);

    const { stdout: tagsResponse } = await execAsync(
      `curl -s http://${registryHost}/v2/integration-test/tags/list`,
    );
    const parsed: unknown = JSON.parse(tagsResponse);
    if (!isRecord(parsed)) {
      throw new Error('The registry did not answer with an object.');
    }

    expect(stringAt(parsed, 'name')).toBe('integration-test');
    expect(parsed['tags']).toContain('2.0.0');
    expect(parsed['tags']).toContain('latest');
  }, 180_000);

  it('publish with dockerAutoClean removes local images', async () => {
    const imageName = `cleanup-test-${Date.now()}`;
    const cfg: OciPluginConfig = {
      dockerImage: imageName,
      dockerRegistry: registryHost,
      dockerTags: ['{{version}}'],
      dockerLogin: false,
      dockerBuildQuiet: false,
      dockerAutoClean: true,
    };

    const ctx = stepContext(
      workdir,
      {},
      {
        logger,
        nextRelease: { version: '3.0.0', gitTag: 'v3.0.0', gitHead: 'ghi789' },
      },
    );

    await prepare(cfg, ctx);
    await publish(cfg, ctx);

    const { stdout: images } = await execAsync(
      `docker images ${registryHost}/${imageName} -q`,
    );

    expect(images.trim()).toBe('');
  }, 180_000);
});
