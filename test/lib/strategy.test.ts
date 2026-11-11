import { describe, it, expect } from '@jest/globals';
import { selectStrategy } from '../../src/lib/strategy.js';
import { BuildStrategy } from '../../src/lib/build-strategy.js';
import { BakeStrategy } from '../../src/lib/bake-strategy.js';
import { OciConfig, OciPluginConfig } from '../../src/plugin-config.js';
import { stepContext } from '../utils/context.js';

function makeConfig(overrides: OciPluginConfig = {}): OciConfig {
  return new OciConfig(overrides, {});
}

describe('selectStrategy', () => {
  it('should return a BakeStrategy when dockerBake is set', () => {
    const strategy = selectStrategy(
      makeConfig({ dockerBake: { group: 'release' } }),
      stepContext('/work'),
    );

    expect(strategy).toBeInstanceOf(BakeStrategy);
  });

  it.each<OciPluginConfig['dockerBake']>([undefined, null, false, 0, ''])(
    'should return a BuildStrategy when dockerBake is %j',
    (dockerBake) => {
      const strategy = selectStrategy(
        makeConfig(structuredClone({ dockerBake })),
        stepContext('/work'),
      );

      expect(strategy).toBeInstanceOf(BuildStrategy);
    },
  );

  it('should return a BuildStrategy when dockerBake is not set', () => {
    const strategy = selectStrategy(makeConfig(), stepContext('/work'));

    expect(strategy).toBeInstanceOf(BuildStrategy);
  });

  it('should return a BuildStrategy even when platforms are configured', () => {
    const strategy = selectStrategy(
      makeConfig({ dockerPlatform: ['linux/amd64'] }),
      stepContext('/work'),
    );

    expect(strategy).toBeInstanceOf(BuildStrategy);
  });
});
