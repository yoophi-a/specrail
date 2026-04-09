import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  OpenSpecAdapter,
  OpenSpecExportInput,
  OpenSpecExportResult,
  OpenSpecImportInput,
  OpenSpecImportResult,
  OpenSpecTrackPackage,
  OpenSpecTrackPackageFiles,
} from "../interfaces/openspec-adapter.js";

const MANIFEST_FILE_NAME = "openspec.json";

interface FileOpenSpecAdapterOptions {
  now?: () => string;
}

interface PersistedOpenSpecManifest {
  metadata: OpenSpecTrackPackage["metadata"];
  track: OpenSpecTrackPackage["track"];
  files: OpenSpecTrackPackageFiles;
}

export class FileOpenSpecAdapter implements OpenSpecAdapter {
  readonly name = "openspec-file";

  private readonly now: () => string;

  constructor(options: FileOpenSpecAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async importPackage(input: OpenSpecImportInput): Promise<OpenSpecImportResult> {
    if (input.source.kind !== "file") {
      throw new Error(`Unsupported OpenSpec import source: ${String((input.source as { kind?: string }).kind)}`);
    }

    const rootDir = input.source.path;
    const manifestPath = path.join(rootDir, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PersistedOpenSpecManifest;
    validateManifest(manifest);

    const artifacts = {
      spec: await readRequiredArtifact(rootDir, manifest.files.spec),
      plan: await readRequiredArtifact(rootDir, manifest.files.plan),
      tasks: await readRequiredArtifact(rootDir, manifest.files.tasks),
    };

    return {
      package: {
        metadata: manifest.metadata,
        track: manifest.track,
        files: manifest.files,
        artifacts,
      },
    };
  }

  async exportPackage(input: OpenSpecExportInput): Promise<OpenSpecExportResult> {
    if (input.target.kind !== "file") {
      throw new Error(`Unsupported OpenSpec export target: ${String((input.target as { kind?: string }).kind)}`);
    }

    const rootDir = input.target.path;
    const overwrite = input.target.overwrite ?? false;
    const manifestPath = path.join(rootDir, MANIFEST_FILE_NAME);

    if (!overwrite) {
      await assertPathDoesNotExist(rootDir);
    }

    await mkdir(rootDir, { recursive: true });

    const pkg: OpenSpecTrackPackage = {
      ...input.package,
      metadata: {
        ...input.package.metadata,
        exportedAt: this.now(),
      },
    };

    const manifest: PersistedOpenSpecManifest = {
      metadata: pkg.metadata,
      track: pkg.track,
      files: pkg.files,
    };

    await Promise.all([
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      writeArtifact(rootDir, pkg.files.spec, pkg.artifacts.spec),
      writeArtifact(rootDir, pkg.files.plan, pkg.artifacts.plan),
      writeArtifact(rootDir, pkg.files.tasks, pkg.artifacts.tasks),
    ]);

    return {
      package: pkg,
      target: input.target,
    };
  }
}

async function readRequiredArtifact(rootDir: string, relativePath: string): Promise<string> {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

async function writeArtifact(rootDir: string, relativePath: string, content: string): Promise<void> {
  const targetPath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
}

async function assertPathDoesNotExist(targetPath: string): Promise<void> {
  try {
    await stat(targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(`OpenSpec export target already exists: ${targetPath}`);
}

function validateManifest(manifest: PersistedOpenSpecManifest): void {
  if (manifest.metadata?.format !== "specrail.openspec.bundle") {
    throw new Error("Invalid OpenSpec package manifest format");
  }

  if (manifest.metadata?.version !== 1) {
    throw new Error("Unsupported OpenSpec package manifest version");
  }

  if (!manifest.track?.id) {
    throw new Error("OpenSpec package manifest is missing track.id");
  }

  if (!manifest.files?.spec || !manifest.files.plan || !manifest.files.tasks) {
    throw new Error("OpenSpec package manifest is missing artifact file mappings");
  }
}
