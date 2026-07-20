# Container Image Publishing Contract

SpecRail deployment templates reference container images, but this repository does not yet include Dockerfiles or a publish workflow. This contract defines what those future images must provide so Docker Compose, Kubernetes, and other deployment targets can converge on the same runtime assumptions.

## Image Names

Publish one image per network service:

| Service | Image | Runtime package | Default command |
| --- | --- | --- | --- |
| API and hosted operator UI | `ghcr.io/<owner>/specrail-api` | `@specrail/api` | generated from package `start:built` |
| GitHub webhook adapter | `ghcr.io/<owner>/specrail-github` | `@specrail/github` | generated from package `start:built` |
| Telegram adapter | `ghcr.io/<owner>/specrail-telegram` | `@specrail/telegram` | generated from package `start:built` |

Keep CLI-only clients such as the terminal app out of always-on service images unless a deployment target explicitly needs them.

The package `start` scripts are source-checkout commands used by systemd-style deployments. Container images use the package `start:built` scripts through `docker/service.Dockerfile`.

Current implementation note: source-checkout `start` scripts still point at `src/index.ts`, while built runtime scripts use the dedicated `specrail-built` export condition. Service package builds are not fully flat yet, so use the declared `start:built` scripts instead of inferring `node apps/<service>/dist/index.js`.

## Tagging

Every published image should have immutable tags:

- `sha-<git-sha>` for every release build.
- `v<semver>` for versioned releases.
- `main` only for the latest successful build from the default branch.

Deployment manifests should prefer immutable `sha-<git-sha>` or `v<semver>` tags. Use `latest` only for local demos.

## Runtime Contract

Each service image should:

1. Run as a non-root user.
2. Include only built JavaScript, production dependencies, package metadata needed by Node.js, and runtime assets.
3. Use Node.js 22 or newer; Node.js 24 is acceptable when the CI runner and dependencies support it.
4. Expose exactly one HTTP port through environment configuration:
   - API: `SPECRAIL_PORT`, integer TCP port `0..65535`, default `4000`
   - GitHub: `GITHUB_APP_PORT`, integer TCP port `0..65535`, default `4200`
   - Telegram: `TELEGRAM_APP_PORT`, integer TCP port `0..65535`, default `4300`
5. Serve `GET /healthz` with `{ ok: true, service: "<service-id>" }`.
6. Keep secrets in environment variables or mounted secret files, never in image layers or labels.
7. Leave durable state on mounted volumes:
   - API: `SPECRAIL_DATA_DIR`, `SPECRAIL_REPO_ARTIFACT_DIR`
   - GitHub: `GITHUB_RELAY_QUEUE_DIR` when using the filesystem relay queue

## Build And Publish Flow

The future publish workflow should run after the full validation gate:

```text
checkout
setup Node.js and pnpm
pnpm install --frozen-lockfile
pnpm check:links
pnpm check
pnpm test
pnpm build
pnpm docker:build-services -- --owner <owner> --tag sha-<git-sha>
docker push immutable tags
```

For GitHub Actions, grant only the permissions needed to publish package images:

```yaml
permissions:
  contents: read
  packages: write
```

Builds should fail if `pnpm validate` fails. Docs-only changes should not publish images.

## Dockerfile Expectations

Service images use the shared `docker/service.Dockerfile` multi-stage pattern:

1. Install dependencies with the pinned pnpm version from `packageManager`.
2. Build the workspace once.
3. Run `pnpm check:built-entrypoints` and `pnpm check:built-health`.
4. Deploy production dependencies for the target service with `pnpm --filter <package> deploy --prod --legacy`.
5. Remove deployed source trees, test directories, and TypeScript configs from the runtime stage.
6. Generate the final process command from the target package's `start:built` script.

Avoid embedding repository-local state, provider credentials, execution transcripts, test artifacts, or `.env` files in images.

Before publishing those images, keep the [built runtime entrypoint contract](./architecture/built-runtime-entrypoints.md) aligned:

- decide whether service builds emit a flat `dist/index.js` or keep workspace-relative paths such as `dist/apps/<service>/src/index.js`
- keep workspace package exports resolving built `@specrail/*` packages through the `specrail-built` condition instead of source `.ts` files in image runtimes
- keep source-checkout `start`/`dev` scripts working for local and systemd deployments, either through explicit source conditions or separate built-runtime scripts
- run `pnpm build`, `pnpm check:built-entrypoints`, `pnpm check:built-health`, and `pnpm docker:build-services -- --owner <owner> --tag sha-<git-sha>` before wiring image publishing into CI

## Deployment Template Alignment

- [GitHub and Telegram Docker Compose example](./github-docker-compose-example.md) uses placeholder `ghcr.io/your-org/specrail-*` images that should be replaced with tags from this contract.
- [Kubernetes deployment skeleton](./kubernetes-deployment.md) uses the same placeholder image names and expects `/healthz` probes to work in every service image.
- [Systemd deployment templates](./systemd-deployment.md) remain source-checkout based and do not require published images.

## Open Implementation Work

- Add a publish workflow that runs only after full validation.
- Add image provenance/SBOM generation if the target registry or deployment environment requires it.
- Decide whether release tags come from Git tags, GitHub releases, or a manual workflow dispatch.
