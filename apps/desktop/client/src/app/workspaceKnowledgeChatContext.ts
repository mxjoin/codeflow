import path from "node:path";

import type {
  EngineType,
  KnowledgeAssetRuntimeMode,
  ExecutableToolRegistry,
  KnowledgeSpecificationRules,
} from "@codeflowai/shared";

import type { RequiredWorkspaceSkill } from "../engines/threadSession.js";
import { KnowledgeAssetStore } from "../knowledge/knowledgeAssetStore.js";
import { KnowledgeAssetError } from "../knowledge/knowledgeAssetFiles.js";
import { KNOWLEDGE_ASSET_READING_RULE, buildKnowledgeAssetReadTools, renderKnowledgeSpecificationRules } from "../knowledge/knowledgeAssetTools.js";
import { buildKnowledgeChangeTool, KNOWLEDGE_CHANGE_RULE } from "../knowledge/knowledgeChangeTools.js";
import { buildKnowledgeAcceptanceTool } from "../knowledge/knowledgeSpecificationTurn.js";

export type WorkspaceKnowledgeChatStatus = "ready" | "initializing" | "not_initialized" | "unavailable";

export type WorkspaceKnowledgeIssue = {
  code: string;
  message: string;
  path?: string | null;
};

export type WorkspaceKnowledgeReadiness = {
  status: WorkspaceKnowledgeChatStatus;
  reasonCode: string | null;
  engine: EngineType;
  runtimeMode: KnowledgeAssetRuntimeMode;
  workspacePath: string;
  targetProjectRoot: string;
  knowledgeRoot: string;
  knowledgeEntryPath: string;
  issues: WorkspaceKnowledgeIssue[];
};

export type WorkspaceKnowledgeChatPrompt = {
  systemRule: string | null;
  requiredWorkspaceSkills: RequiredWorkspaceSkill[];
  knowledgeAssetTools?: ExecutableToolRegistry | null;
  specifications?: KnowledgeSpecificationRules;
};

export type WorkspaceKnowledgeChatContext = WorkspaceKnowledgeReadiness & WorkspaceKnowledgeChatPrompt;

/** 读取当前项目资产知识状态，并把新知识工具挂到普通会话。 */
export function resolveWorkspaceKnowledgeChatContext(input: {
  workspacePath: string;
  engine: EngineType;
  enabled?: boolean;
  paths?: string[];
}): WorkspaceKnowledgeChatContext {
  const readiness = resolveWorkspaceKnowledgeReadiness(input);
  return {
    ...readiness,
    ...renderWorkspaceKnowledgeChatPrompt(readiness, input.enabled === true, input.paths),
  };
}

/** 新资产树是项目知识可用性的唯一判断。 */
export function resolveWorkspaceKnowledgeReadiness(input: {
  workspacePath: string;
  engine: EngineType;
}): WorkspaceKnowledgeReadiness {
  const workspacePath = path.resolve(input.workspacePath);
  const base = {
    engine: input.engine,
    workspacePath,
    targetProjectRoot: workspacePath,
    knowledgeRoot: "",
    knowledgeEntryPath: "",
  };

  try {
    const snapshot = new KnowledgeAssetStore(workspacePath).snapshot(false, false);
    base.knowledgeRoot = path.posix.dirname(snapshot.root);
    base.knowledgeEntryPath = snapshot.root;
    if (!snapshot.initialized) {
      return {
        ...base,
        status: "not_initialized",
        reasonCode: "KNOWLEDGE_NOT_INITIALIZED",
        runtimeMode: "project_assets_v1",
        issues: [{ code: "KNOWLEDGE_NOT_INITIALIZED", message: "当前项目尚未建立资产知识库" }],
      };
    }
    return {
      ...base,
      status: "ready",
      reasonCode: null,
      runtimeMode: "project_assets_v1",
      issues: [],
    };
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      reasonCode: "KNOWLEDGE_READINESS_UNAVAILABLE",
      runtimeMode: "project_assets_v1",
      issues: [{ code: "KNOWLEDGE_READINESS_UNAVAILABLE", message: `项目资产知识库读取失败：${errorMessage(error)}` }],
    };
  }
}

/** 启用知识时读取失败必须中止；规格确定加载，其他知识按需导航。 */
export function renderWorkspaceKnowledgeChatPrompt(readiness: WorkspaceKnowledgeReadiness, enabled = false, paths: string[] = []): WorkspaceKnowledgeChatPrompt {
  if (enabled && readiness.status === "unavailable") {
    throw new KnowledgeAssetError(readiness.reasonCode ?? "KNOWLEDGE_READINESS_UNAVAILABLE", readiness.issues.map(issue => issue.message).join("；") || "项目知识库不可用", 503);
  }
  if (!enabled || readiness.status !== "ready") return { systemRule: null, requiredWorkspaceSkills: [] };
  const store = new KnowledgeAssetStore(readiness.workspacePath);
  const specifications = store.rules(paths);
  return {
    specifications,
    systemRule: [`项目知识实际目录：${readiness.knowledgeEntryPath}。`,
      renderKnowledgeSpecificationRules(store, specifications),
      KNOWLEDGE_ASSET_READING_RULE, KNOWLEDGE_CHANGE_RULE].filter(Boolean).join("\n"),
    requiredWorkspaceSkills: [],
    knowledgeAssetTools: { tools: [...buildKnowledgeAssetReadTools(true).tools, buildKnowledgeChangeTool(), buildKnowledgeAcceptanceTool()] },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
