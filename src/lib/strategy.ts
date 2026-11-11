import type { VerifyConditionsContext } from 'semantic-release';
import type { Runner } from '../utils/exec.js';
import { OciConfig } from '../plugin-config.js';
import { BuildStrategy } from './build-strategy.js';
import { BakeStrategy } from './bake-strategy.js';
import { ImageStrategy } from './image-strategy.js';

/**
 * Selects the build strategy for the given configuration: bake mode when
 * `dockerBake` is set, otherwise the standard `docker build` strategy.
 * @param config - Resolved plugin configuration.
 * @param context - Semantic-release context.
 * @param run - Runs the docker binary; only tests pass one.
 * @returns The chosen {@link ImageStrategy}.
 */
export function selectStrategy(
  config: OciConfig,
  context: VerifyConditionsContext,
  run?: Runner,
): ImageStrategy {
  const bake = config.getDockerBake();
  return bake
    ? new BakeStrategy(config, context, bake, run)
    : new BuildStrategy(config, context, run);
}
