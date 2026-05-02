import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

import { ClaudeCodeAdapter, CodexAdapter } from "@specrail/adapters";
import { getTrackArtifactPaths, loadConfig, materializeTrackArtifacts, writeApprovedTrackArtifact } from "@specrail/config";
import {
  FileAttachmentReferenceRepository,
  FileApprovalRequestRepository,
  FileArtifactRevisionRepository,
  FileChannelBindingRepository,
  FileExecutionRepository,
  FilePlanningSessionRepository,
  FileProjectRepository,
  FileTrackRepository,
  JsonlEventStore,
  JsonlPlanningMessageStore,
  SpecRailService,
  createExecutionWorkspaceManager,
  type SpecRailServiceDependencies,
} from "@specrail/core";

import { SpecRailAcpServer, type JsonRpcRequest } from "./server.js";

function createService(dataDir: string, repoArtifactRoot: string): SpecRailService {
  const config = loadConfig();
  const stateDir = path.join(dataDir, "state");
  const artifactRoot = path.join(dataDir, "artifacts");
  const workspaceRoot = path.join(dataDir, "workspaces");
  const sessionsDir = path.join(dataDir, "sessions");
  const templateDir = path.resolve(PROJECT_ROOT, ".specrail-template");

  const eventStore = new JsonlEventStore(stateDir);
  const projectRepository = new FileProjectRepository(stateDir);
  const trackRepository = new FileTrackRepository(stateDir);
  const planningSessionRepository = new FilePlanningSessionRepository(stateDir);
  const planningMessageStore = new JsonlPlanningMessageStore(stateDir);
  const artifactRevisionRepository = new FileArtifactRevisionRepository(stateDir);
  const approvalRequestRepository = new FileApprovalRequestRepository(stateDir);
  const channelBindingRepository = new FileChannelBindingRepository(stateDir);
  const attachmentReferenceRepository = new FileAttachmentReferenceRepository(stateDir);
  const executionRepository = new FileExecutionRepository(stateDir);
  let service: SpecRailService | null = null;

  const codexExecutor = new CodexAdapter({
    sessionsDir,
    onEvent: async (event) => {
      if (service) {
        await service.recordExecutionEvent(event);
        return;
      }

      await eventStore.append(event);
    },
  });

  const claudeCodeExecutor = new ClaudeCodeAdapter({
    sessionsDir,
    onEvent: async (event) => {
      if (service) {
        await service.recordExecutionEvent(event);
        return;
      }

      await eventStore.append(event);
    },
  });

  const dependencies: SpecRailServiceDependencies = {
    projectRepository,
    trackRepository,
    planningSessionRepository,
    planningMessageStore,
    artifactRevisionRepository,
    approvalRequestRepository,
    channelBindingRepository,
    attachmentReferenceRepository,
    executionRepository,
    eventStore,
    artifactWriter: {
      async write(input) {
        await materializeTrackArtifacts({
          rootDir: artifactRoot,
          repoVisibleRootDir: repoArtifactRoot,
          templateDir,
          trackId: input.track.id,
          projectName: input.project.name,
          trackTitle: input.track.title,
          trackDescription: input.track.description,
          specContent: input.specContent,
          planContent: input.planContent,
          tasksContent: input.tasksContent,
        });
      },
      async writeApprovedArtifact(input) {
        await writeApprovedTrackArtifact({
          rootDir: artifactRoot,
          repoVisibleRootDir: repoArtifactRoot,
          trackId: input.track.id,
          artifact: input.artifact,
          content: input.content,
        });
      },
    },
    executor: codexExecutor,
    executors: {
      codex: codexExecutor,
      claude_code: claudeCodeExecutor,
    },
    defaultExecutionBackend: config.executionBackend,
    defaultExecutionProfile: config.executionProfile,
    defaultProject: {
      id: "project-default",
      name: "SpecRail",
      repoUrl: "https://github.com/yoophi-a/specrail",
      localRepoPath: process.cwd(),
      defaultWorkflowPolicy: "artifact-first-mvp",
    },
    workspaceRoot,
    workspaceManager: createExecutionWorkspaceManager(config.executionWorkspaceMode),
  };

  service = new SpecRailService(dependencies);
  return service;
}

export function createDefaultAcpServer(): SpecRailAcpServer {
  const config = loadConfig();
  return new SpecRailAcpServer({
    service: createService(config.dataDir, config.repoArtifactDir),
    stateDir: path.join(config.dataDir, "state"),
  });
}

export { SpecRailAcpServer } from "./server.js";

const isMainModule = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMainModule) {
  const server = createDefaultAcpServer();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }

    const response = await server.handleMessage(message, (payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    });

    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}
