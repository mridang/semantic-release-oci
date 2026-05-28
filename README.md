# Semantic Release - OCI

A [semantic-release](https://github.com/semantic-release/semantic-release)
plugin to automatically build, tag, and push Docker/OCI images to a
container registry.

This plugin automates the final step of a Docker image release workflow.
It verifies Docker credentials, builds your image from a Dockerfile, tags
it with configurable version-based tags, and pushes it to your configured
registry. This eliminates the need for manual commands or scripts, ensuring
your Docker images are always up-to-date and published consistently.

## Why?

Automating the release of a Docker image involves more than just creating a
Git tag. For a new version to be consumable, an image must be built, tagged,
and pushed to a container registry. This final synchronization step is a
common point of friction in an otherwise automated pipeline.

Without this plugin, developers typically face one of two issues:

- **Manual Docker Workflow:** The most common method is manually running
  `docker build`, `docker tag`, and `docker push`. This adds toil and
  creates opportunities for mistakes or skipped steps.
- **Incomplete Automation:** Other existing plugins may build images, but
  they often lack support for multi-platform builds (buildx), configurable
  tag templates, or proper cleanup. This leaves a manual gap in the release
  process.

This plugin provides a lightweight and direct solution. Instead of relying
on ad-hoc scripts, it ensures that after `semantic-release` successfully
creates a new release, your Docker image is built, tagged, pushed, and
optionally cleaned up.

## Installation

Install using NPM with the following command:

```sh
npm install --save-dev @mridang/semantic-release-oci
```

## Usage

To use this plugin, add it to your semantic-release configuration file
(e.g., `.releaserc.js`, `release.config.js`, or in your `package.json`).

### Example Configuration (`.releaserc.js`)

```javascript
module.exports = {
  branches: ['main', 'next'],
  plugins: [
    '@semantic-release/commit-analyzer',
    [
      '@mridang/semantic-release-oci',
      {
        dockerRegistry: 'ghcr.io',
        dockerProject: 'my-org',
        dockerImage: 'my-app',
        dockerTags: ['latest', '{{major}}-latest', '{{version}}'],
        dockerPlatform: ['linux/amd64', 'linux/arm64'],
        dockerArgs: {
          BUILD_DATE: '{{now}}',
          VERSION: '{{version}}',
        },
      },
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/github',
  ],
};
```

### Configuration Options

All options are case-sensitive and lowercased in the JSON configuration.

- **`dockerFile` (string, optional):**
  Path to the Dockerfile, relative to the project root. Default: `"Dockerfile"`.

- **`dockerRegistry` (string, optional):**
  Docker registry hostname (e.g., `ghcr.io`, `quay.io`). Default: Docker Hub.

- **`dockerImage` (string, optional):**
  Docker image name. Default: parsed from `package.json` name.

- **`dockerProject` (string, optional):**
  Docker project/organization namespace. Default: parsed scope from
  `package.json`.

- **`dockerTags` (string[], optional):**
  Tag templates with `{{variable}}` substitution. Available variables:
  `version`, `major`, `minor`, `patch`, `gitTag`, `gitHead`, `channel`,
  `type`, `now`. Default: `['latest', '{{major}}-latest', '{{version}}']`.

- **`dockerArgs` (object, optional):**
  Build arguments as key-value pairs. Values support `{{variable}}`
  templates. Set a value to `true` to pass the key as a build arg
  sourced from the environment.

- **`dockerBuildFlags` (object, optional):**
  Additional docker build flags. Keys are flag names, values are strings,
  arrays, or `null` (for boolean flags). For example, to disable default
  provenance attestations in buildx (required for AWS Lambda compatible
  images), use `{ provenance: 'false' }`.

- **`dockerPlatform` (string[], optional):**
  Target platform(s) for multi-arch builds via `docker buildx`. When set,
  buildx is used instead of standard `docker build`. Default: `[]` (disabled).

- **`dockerPublish` (boolean, optional):**
  Whether to push images to the registry. Default: `true`.

- **`dockerLogin` (boolean, optional):**
  Whether to perform `docker login`. Credentials are read from
  `DOCKER_REGISTRY_USER` and `DOCKER_REGISTRY_PASSWORD` environment
  variables, with `GITHUB_TOKEN` as a password fallback. Default: `true`.

- **`dockerContext` (string, optional):**
  Docker build context path, relative to the project root. Default: `"."`.

- **`dockerNetwork` (string, optional):**
  Docker network for the build. When not set, no `--network` flag is
  passed, allowing both Docker and Podman to use their own defaults.

- **`dockerAutoClean` (boolean, optional):**
  Remove local images after publish. Default: `true`.

- **`dockerBuildQuiet` (boolean, optional):**
  Suppress docker build output. Default: `true`.

- **`dockerNoCache` (boolean, optional):**
  Disable build cache. Default: `false`.

- **`dockerBuildCacheFrom` (string | string[], optional):**
  External cache sources for the build.

- **`dockerTimeout` (number, optional):**
  Timeout in milliseconds applied to each individual Docker CLI invocation
  (build, push, login, tag, and cleanup). Default: `600000` (10 minutes).
  Increase this when building large images or pushing to slow registries.

- **`dockerBake` (object, optional):**
  Drives `docker buildx bake` instead of `docker buildx build`, so a single
  bake group can produce several outputs (for example a pushed image and
  host-exported binaries) from one shared compile. See "Bake Mode" below.
  Fields:
  - **`file` (string, optional):** Path to the bake definition file.
    Default: `"docker-bake.hcl"`.
  - **`group` (string, optional):** Bake group to build.
  - **`target` (string, optional):** Bake target to build, used when no
    group is given. Takes precedence over `group` when both are set.
  - **`imageTarget` (string, optional):** Target whose `tags` receive the
    resolved version tags via `--set`. Defaults to the configured `target`,
    or `"*"` (all targets) when only a `group` is given. For a multi-target
    group, set this to the image target so the version tags are not applied
    to non-image targets such as binary exports.

## Environment Variables

When `dockerLogin` is enabled (the default), the plugin reads credentials
from the following environment variables:

- **`DOCKER_REGISTRY_USER`**: Username for `docker login`.
- **`DOCKER_REGISTRY_PASSWORD`**: Password for `docker login`.
- **`GITHUB_TOKEN`**: Used as a password fallback when
  `DOCKER_REGISTRY_PASSWORD` is not set.

## Multi-Platform Builds

When `dockerPlatform` is configured with one or more platforms (e.g.,
`['linux/amd64', 'linux/arm64']`), the plugin uses `docker buildx build`
instead of `docker build`. In buildx mode, images are pushed during the
build step (via `--push`) rather than tagged and pushed separately.

## Bake Mode

When `dockerBake` is set, the build step runs `docker buildx bake` against
the configured `group` or `target` instead of `docker buildx build`. The
plugin renders the configured `dockerTags` and injects them into the chosen
`imageTarget` via `--set <imageTarget>.tags=<repo>:<tag>`, and forwards
string-valued `dockerArgs` as `--set *.args.<key>=<value>`. Boolean
`dockerArgs` (the env-sourced form) are not supported in bake mode and are
skipped with a log message; declare them in the bake file instead.
Everything else about the build — platforms, contexts, Dockerfiles, and
per-target outputs — is declared in the bake file, which is the source of
truth in this mode. Options that describe build mechanics (`dockerPlatform`,
`dockerFile`, `dockerContext`, `dockerNetwork`, `dockerNoCache`,
`dockerBuildCacheFrom`, `dockerBuildQuiet`, `dockerBuildFlags`) are owned by
the bake file and not forwarded.

Bake mode requires either `group` or `target` to be set, and verifies that
the bake file (not a `Dockerfile`) exists during `verifyConditions`.

Push behaviour follows each target's `output` (for example `type=registry`
to push, `type=local` to export files to the host); `dockerPublish` is not
consulted in bake mode. In dry-run mode the plugin overrides outputs to
`type=cacheonly` so the build is validated without pushing or writing
artifacts. The image digest is read from a bake metadata file and exposed
via the `docker_image_sha_*` outputs.

## GitHub Actions Outputs

When running in GitHub Actions, the plugin sets the following step
outputs, accessible via `${{ steps.<step-id>.outputs.<name> }}`:

- `docker_image`: Full image path (without tag)
- `docker_image_build_id`: Unique build identifier
- `docker_image_sha_short`: First 12 characters of the image SHA256 digest
- `docker_image_sha_long`: Full SHA256 digest

These outputs can be used in subsequent steps, for example to sign
the image or to reference the exact digest in a deployment manifest.

## Known Issues

- None.

## Useful links

- **[Docker](https://docs.docker.com/):** Docker documentation.
- **[Buildx](https://docs.docker.com/build/buildx/):** Docker multi-platform build documentation.

## Contributing

If you have suggestions for how this plugin could be improved, or
want to report a bug, open an issue — we'd love all and any
contributions.

## Credits

This project is derived from
[`@codedependant/semantic-release-docker`](https://github.com/esatterwhite/semantic-release-docker)
by [Eric Satterwhite](https://github.com/esatterwhite), originally
licensed under the MIT License. See the [NOTICE](./NOTICE) file for
the full original license text.

## License

Apache License 2.0 © 2024 Mridang Agarwalla
