import { readFile } from "node:fs/promises";

const requiredPackages = [
  { path: "apps/api/package.json", name: "@specrail/api" },
  { path: "apps/github/package.json", name: "@specrail/github" },
  { path: "apps/telegram/package.json", name: "@specrail/telegram" },
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
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Checked ${requiredPackages.length} service start scripts.`);
