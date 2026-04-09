import type { Track } from "@specrail/core";

export interface OpenSpecTrackArtifacts {
  spec: string;
  plan: string;
  tasks: string;
}

export interface OpenSpecTrackPackageMetadata {
  version: 1;
  format: "specrail.openspec.bundle";
  exportedAt: string;
  generatedBy: "specrail";
}

export interface OpenSpecTrackPackageFiles {
  spec: string;
  plan: string;
  tasks: string;
}

export interface OpenSpecTrackPackage {
  metadata: OpenSpecTrackPackageMetadata;
  track: Track;
  artifacts: OpenSpecTrackArtifacts;
  files: OpenSpecTrackPackageFiles;
}

export interface OpenSpecImportSource {
  kind: "file";
  path: string;
}

export interface OpenSpecExportTarget {
  kind: "file";
  path: string;
  overwrite?: boolean;
}

export interface OpenSpecImportInput {
  source: OpenSpecImportSource;
}

export interface OpenSpecExportInput {
  package: OpenSpecTrackPackage;
  target: OpenSpecExportTarget;
}

export interface OpenSpecImportResult {
  package: OpenSpecTrackPackage;
}

export interface OpenSpecExportResult {
  package: OpenSpecTrackPackage;
  target: OpenSpecExportTarget;
}

export interface OpenSpecAdapter {
  readonly name: string;
  importPackage(input: OpenSpecImportInput): Promise<OpenSpecImportResult>;
  exportPackage(input: OpenSpecExportInput): Promise<OpenSpecExportResult>;
}
