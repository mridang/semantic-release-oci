import type { DockerRun } from './docker-run.js';

/**
 * An image that has been pushed to its registry.
 */
export class PushedImage {
  /**
   * @param image  The image that was pushed.
   * @param output What the push wrote, such as its progress and digest.
   */
  constructor(
    readonly image: Image,
    readonly output: string,
  ) {}
}

/**
 * A local image under one reference (`repository:tag`).
 */
export class Image {
  /**
   * @param docker     Runs docker commands.
   * @param repository Image repository path, including registry and project.
   * @param tag        Tag of the image.
   */
  constructor(
    private readonly docker: DockerRun,
    readonly repository: string,
    readonly tag: string,
  ) {}

  /**
   * The reference docker knows the image by.
   *
   * @returns `repository:tag`.
   */
  get reference(): string {
    return `${this.repository}:${this.tag}`;
  }

  /**
   * Pushes the image to the registry its repository names.
   *
   * @returns The pushed image, with what the push wrote.
   */
  async push(): Promise<PushedImage> {
    const output = await this.docker(['push', this.reference]);
    return new PushedImage(this, output.trim());
  }
}
