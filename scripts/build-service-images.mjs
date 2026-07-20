import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const serviceImageBuilds = [
  {
    service: "api",
    image: "specrail-api",
    packageName: "@specrail/api",
    port: 4000,
  },
  {
    service: "github",
    image: "specrail-github",
    packageName: "@specrail/github",
    port: 4200,
  },
  {
    service: "telegram",
    image: "specrail-telegram",
    packageName: "@specrail/telegram",
    port: 4300,
  },
];

const dockerfile = "docker/service.Dockerfile";

function parseArgs(argv) {
  const defaultTags = (process.env.SPECRAIL_IMAGE_TAGS ?? process.env.SPECRAIL_IMAGE_TAG ?? "local")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const options = {
    owner: process.env.SPECRAIL_IMAGE_OWNER ?? "your-org",
    tags: [],
    push: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--push") {
      options.push = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--owner") {
      options.owner = argv[++index];
    } else if (arg === "--tag") {
      options.tags.push(
        ...argv[++index]
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (!options.owner) {
    throw new Error("owner must not be empty");
  }
  if (options.tags.length === 0) {
    options.tags = defaultTags;
  }
  if (options.tags.length === 0) {
    throw new Error("at least one tag is required");
  }

  return options;
}

export function createDockerBuildCommands({ owner, tag, tags, push = false }) {
  const resolvedTags = tags ?? [tag ?? "local"];
  return serviceImageBuilds.flatMap((definition) => {
    const images = resolvedTags.map((resolvedTag) => `ghcr.io/${owner}/${definition.image}:${resolvedTag}`);
    const buildCommand = [
      "docker",
      ...(push ? ["buildx", "build"] : ["build"]),
      "--file",
      dockerfile,
      "--build-arg",
      `SERVICE_PACKAGE=${definition.packageName}`,
      "--build-arg",
      `SERVICE_PORT=${definition.port}`,
      ...images.flatMap((image) => ["--tag", image]),
      ...(push ? ["--provenance=true", "--sbom=true", "--push"] : []),
      ".",
    ];
    return [buildCommand];
  });
}

function quoteCommand(command) {
  return command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");
}

function runCommand(command) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${quoteCommand(command)} failed with exit code ${result.status}`);
  }
}

export function runServiceImageBuilds(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const commands = createDockerBuildCommands(options);

  if (options.dryRun) {
    for (const command of commands) {
      console.log(quoteCommand(command));
    }
    return;
  }

  for (const command of commands) {
    runCommand(command);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runServiceImageBuilds();
}
