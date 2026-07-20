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
  const options = {
    owner: process.env.SPECRAIL_IMAGE_OWNER ?? "your-org",
    tag: process.env.SPECRAIL_IMAGE_TAG ?? "local",
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
      options.tag = argv[++index];
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (!options.owner) {
    throw new Error("owner must not be empty");
  }
  if (!options.tag) {
    throw new Error("tag must not be empty");
  }

  return options;
}

export function createDockerBuildCommands({ owner, tag, push = false }) {
  return serviceImageBuilds.flatMap((definition) => {
    const image = `ghcr.io/${owner}/${definition.image}:${tag}`;
    const buildCommand = [
      "docker",
      "build",
      "--file",
      dockerfile,
      "--build-arg",
      `SERVICE_PACKAGE=${definition.packageName}`,
      "--build-arg",
      `SERVICE_PORT=${definition.port}`,
      "--tag",
      image,
      ".",
    ];
    const commands = [buildCommand];
    if (push) {
      commands.push(["docker", "push", image]);
    }
    return commands;
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
