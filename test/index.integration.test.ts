import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { verifyConditions, prepare, publish } from '../src/index.js';
import type { OciPluginConfig } from '../src/plugin-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireDocker(): void {
  try {
    execSync('docker version', { stdio: 'pipe' });
  } catch {
    throw new Error('Docker is required to run these tests.');
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-release-oci-it-'));
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
    requireDocker();

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

  beforeEach(() => {
    workdir = makeTempDir();
    fs.cpSync(
      path.join(__dirname, 'fixture', 'Dockerfile'),
      path.join(workdir, 'Dockerfile'),
    );
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it('verifyConditions succeeds with Dockerfile present', async () => {
    const cfg: OciPluginConfig = {
      dockerImage: 'test-app',
      dockerLogin: false,
    } as OciPluginConfig;

    const ctx = {
      logger,
      cwd: workdir,
      env: {},
    };

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
    } as OciPluginConfig;

    const ctx = {
      logger,
      cwd: workdir,
      env: {},
      nextRelease: { version: '1.0.0', gitTag: 'v1.0.0', gitHead: 'abc123' },
      options: { dryRun: false },
    };

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
    } as OciPluginConfig;

    const ctx = {
      logger,
      cwd: workdir,
      env: {},
      nextRelease: { version: '2.0.0', gitTag: 'v2.0.0', gitHead: 'def456' },
      options: { dryRun: false },
    };

    await verifyConditions(cfg, ctx);
    await prepare(cfg, ctx);
    await publish(cfg, ctx);

    const tagsResponse = execSync(
      `curl -s http://${registryHost}/v2/integration-test/tags/list`,
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(tagsResponse) as {
      name: string;
      tags: string[];
    };

    expect(parsed.name).toBe('integration-test');
    expect(parsed.tags).toContain('2.0.0');
    expect(parsed.tags).toContain('latest');
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
    } as OciPluginConfig;

    const ctx = {
      logger,
      cwd: workdir,
      env: {},
      nextRelease: { version: '3.0.0', gitTag: 'v3.0.0', gitHead: 'ghi789' },
      options: { dryRun: false },
    };

    await prepare(cfg, ctx);
    await publish(cfg, ctx);

    const images = execSync(`docker images ${registryHost}/${imageName} -q`, {
      encoding: 'utf8',
    }).trim();

    expect(images).toBe('');
  }, 180_000);
});
