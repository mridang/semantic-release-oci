import { describe, it, expect, jest } from '@jest/globals';
import { selectStrategy } from '../../src/lib/strategy.js';
import { BuildStrategy } from '../../src/lib/build-strategy.js';
import { BakeStrategy } from '../../src/lib/bake-strategy.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import type { SemanticReleaseContext } from '../../src/lib/types.js';

function makeContext(): SemanticReleaseContext {
  return {
    cwd: '/work',
    env: {},
    logger: { log: jest.fn(), error: jest.fn() },
  };
}

function makeConfig(overrides: Partial<OciPluginConfig> = {}): OciConfig {
  return new OciConfig(overrides as OciPluginConfig, {});
}

describe('selectStrategy', () => {
  it('should return a BakeStrategy when dockerBake is set', () => {
    const strategy = selectStrategy(
      makeConfig({ dockerBake: { group: 'release' } }),
      makeContext(),
    );

    expect(strategy).toBeInstanceOf(BakeStrategy);
  });

  it('should return a BuildStrategy when dockerBake is not set', () => {
    const strategy = selectStrategy(makeConfig(), makeContext());

    expect(strategy).toBeInstanceOf(BuildStrategy);
  });

  it('should return a BuildStrategy even when platforms are configured', () => {
    const strategy = selectStrategy(
      makeConfig({ dockerPlatform: ['linux/amd64'] }),
      makeContext(),
    );

    expect(strategy).toBeInstanceOf(BuildStrategy);
  });
});
