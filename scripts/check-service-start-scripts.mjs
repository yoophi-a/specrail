import { readFile } from "node:fs/promises";

const requiredPackages = [
  {
    path: "apps/api/package.json",
    name: "@specrail/api",
    builtStart: "node --conditions=specrail-built dist/apps/api/src/index.js",
  },
  {
    path: "apps/github/package.json",
    name: "@specrail/github",
    builtStart: "node --conditions=specrail-built dist/index.js",
  },
  {
    path: "apps/telegram/package.json",
    name: "@specrail/telegram",
    builtStart: "node --conditions=specrail-built dist/index.js",
  },
];

const expectedStart = "node --import tsx src/index.ts";
const failures = [];

for (const entry of requiredPackages) {
  const raw = await readFile(entry.path, "utf8");
  const pkg = JSON.parse(raw);
  const start = pkg?.scripts?.start;

  if (pkg?.name !== entry.name) {
    failures.push(`${entry.path}: expected package name ${entry.name}`);
  }

  if (start !== expectedStart) {
    failures.push(`${entry.path}: expected scripts.start to be ${JSON.stringify(expectedStart)}`);
  }

  if (pkg?.scripts?.["start:built"] !== entry.builtStart) {
    failures.push(`${entry.path}: expected scripts.start:built to be ${JSON.stringify(entry.builtStart)}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Checked ${requiredPackages.length} service source and built start scripts.`);
