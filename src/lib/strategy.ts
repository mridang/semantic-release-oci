import { OciConfig } from '../plugin-config.js';
import { BuildStrategy } from './build-strategy.js';
import { BakeStrategy } from './bake-strategy.js';
import type { ImageStrategy, SemanticReleaseContext } from './types.js';

/**
 * Selects the build strategy for the given configuration: bake mode when
 * `dockerBake` is set, otherwise the standard `docker build` strategy.
 *
 * @param config  Resolved plugin configuration.
 * @param context Semantic-release context.
 * @returns       The chosen {@link ImageStrategy}.
 */
export function selectStrategy(
  config: OciConfig,
  context: SemanticReleaseContext,
): ImageStrategy {
  return config.isBakeEnabled()
    ? new BakeStrategy(config, context)
    : new BuildStrategy(config, context);
}
