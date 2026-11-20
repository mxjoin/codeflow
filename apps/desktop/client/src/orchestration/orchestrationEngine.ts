import crypto from "node:crypto";
import { evaluateSharedWorkspaceHostToolPolicy, sharedWorkspaceToolDeniedResult, type SharedWorkspaceToolExecutionContext } from "../app/sharedWorkspaceToolPolicy.js";
import fs from "node:fs";
import path from "node:path";
import type {
  AccessMode,
  AttachmentFormat,
  AttachmentKind,
  Artifact,
  ArtifactId,
  ArtifactBinding,
  ArtifactOutputMode,
  FeedbackRecordId,
  FeedbackRecordAction,
  ConversationEventInput,
  DownstreamThreadReusePolicy,
  NodeAcceptanceCheck,
  ExecutableToolRegistry,
  FeedbackAction,
  FeedbackRecord,
  GateResult,
  EngineType,
  EngineCredentialSource,
  EngineModelProviderId,
  KnowledgeCatalogSnapshot,
  KnowledgeBundleDefinition,
  NodeArtifactInput,
  NodeExecutionConclusion,
  NodeExecutionEnvelope,
  NodeFeedbackExecutionOverride,
  NodeExecutionProfileScope,
  NodeExecutionProfileSnapshot,
  NodeExecutionState,
  NodeExecutionStatus,
  NodeHumanActionSource,
  NodeFinalAnswerPayload,
  NodeHumanInputRequest,
  NodeWorkItem,
  NodeWorkItemAcceptanceCriterion,
  NodeWorkItemCompletionCheck,
  NodeWorkItemPolicy,
  NodeWorkItemReworkScope,
  NodeWorkItemSummary,
  OrchestrationManagedServicesChangedPayload,
  OrchestrationArtifactRevisedPayload,
  NodeNextAction,
  NodeResultContractValidationResult,
  NodeResultField,
  NodeResultValidationStatus,
  NodePromptSnapshot,
  NodePromptInputReferenceSnapshot,
  NodePromptBillingContext,
  NodeReworkDirective,
  NodeThreadReusePolicy,
  NodeRuntimePolicy,
  OrchestrationId,
  OrchestrationAssetRuntimeSnapshot,
  OrchestrationRuntimeAssetSource,
  OrchestrationInstance,
  OrchestrationRoleExecutionOverride,
  ManagedServiceSnapshot,
  RawEngineEventInput,
  RelayPricingCatalogSnapshot,
  RoleDefinition,
  RoleOutputFileDefinition,
  RoleOutputFormat,
  RoleExecutionRevision,
  RoleId,
  ResolvedNodeContext,
  ResolvedNodeInput,
  SkillDefinition,
  SkillId,
  TaskAcceptanceCriterion,
  ThreadManagedServicesScope,
  ToolDefinition,
  ToolRef,
  ToolsetDefinition,
  ToolsetId,
  WorkflowEdge,
  WorkflowNode,
  WorkspaceId,
  ItemId,
  ThreadId,
  NodeThreadRecoveryStrategy,
  SessionId,
  TurnId,
} from "@codeflowai/shared";
import {
  extractTurnErrorMetadata,
  MANUAL_TURN_INTERRUPT_CODE,
  buildRoleExecutionRevision,
  DEFAULT_MAX_REWORK_ROUNDS,
  getDefaultEngineProviderId,
  getArtifactRevisionMetadata,
  getTaskIntakeTitle,
  inferRoleArtifactOutputMode,
  isOrchestrationDeterministicRecoveryDiagnostic,
  normalizeEngineKeyProviderId,
  normalizeCodexServiceTier,
  normalizeRoleOutputDefinition,
  resolveRelayInvocationPriceSnapshot,
  OrchestrationRuntimeConflictError,
  validateInlineThreadPayload,
} from "@codeflowai/shared";
import {
  createTurnErrorEventInputFromError,
  createTurnErrorEventInput,
} from "../errors/turnErrors.js";
import { describeWorkspaceProfileFailure, type ClientDb } from "../db/clientDb.js";
import { readExistingCodeflowaiConfig } from "../codeflowai/codeflowaiConfig.js";
import type { OrchNodeAttempt, OrchNodeAttemptStatus } from "../db/repos/orchNodeAttemptRepo.js";
import { NodeWorkItemRepoError, type NodeWorkItemUpdatePatch } from "../db/repos/orchNodeWorkItemRepo.js";
import type { ThreadStore } from "../threads/threadStore.js";
import type { ThreadSessionManager } from "../engines/threadSessionManager.js";
import type { HostToolExecutionResult, TurnTimeoutPolicy } from "../engines/threadSession.js";
import { KnowledgeAssetStore } from "../knowledge/knowledgeAssetStore.js";
import { buildKnowledgeAssetReadTools, renderKnowledgeSpecificationRules } from "../knowledge/knowledgeAssetTools.js";
import { buildKnowledgeAcceptanceTool, createKnowledgeSpecificationTurn } from "../knowledge/knowledgeSpecificationTurn.js";
import { buildKnowledgeChangeTool, createKnowledgeSuggestionTurn, KNOWLEDGE_CHANGE_RULE } from "../knowledge/knowledgeChangeTools.js";
import { KnowledgeAssetError } from "../knowledge/knowledgeAssetFiles.js";
import { assertClientReasoningEffortSupported } from "../engines/engineModelCapabilities.js";
import {
  getRuntimeEngineModelCatalogItem,
  getRuntimeEngineModels,
  resolveRuntimeEngineModelProviderId,
  resolveRuntimeRoleExecutionConfigForEngine,
  resolveRuntimeRoleExecutionConfigForStrategy,
} from "../engines/engineModelCatalogRuntime.js";
import { emitTurnTerminalWithAssistantReconcile } from "../engines/turnTerminalEmitter.js";
import { isBinaryFile } from "../fs/fsHelpers.js";
import { decodeTextBuffer } from "../fs/textEncoding.js";
import type { WorkspacePathIndex } from "../fs/workspacePathIndexService.js";
import { renderTemplate } from "./templateRenderer.js";
import { evaluateGates, hasBlockingFailure } from "./gateEvaluator.js";
import { AiGateEvaluationService } from "./aiGateEvaluationService.js";
import { notifyChatWorkflowThreadActivity } from "./chatWorkflowActivity.js";
import { KnowledgeRuntimeService } from "./knowledgeRuntimeService.js";
import { ManagedServiceRuntime } from "./managedServiceRuntime.js";
import { NodePromptBuilder, type BuiltNodePrompt } from "./nodePromptBuilder.js";
import { XmlNodePromptRenderer } from "./promptRenderer.js";
import { ToolRuntimeService, type ToolExecutionResult } from "./toolRuntimeService.js";
import {
  ArtifactPersistenceService,
  type ArtifactOutputPathValidationIssue,
  validateArtifactWorkspaceOutput,
} from "./artifactPersistenceService.js";
import { buildArtifactPathRuntimeTokens } from "./assetBundleService.js";
import { buildDefaultArtifactBaseDir, buildTaskTitlePathSegment } from "./artifactPathPolicy.js";
import {
  toNodeResultValidationReport,
  validateNodeResultContract,
} from "./nodeResultContractValidator.js";
import { RuntimeEvidenceService } from "./runtimeEvidenceService.js";
import {
  buildSkillScriptToolEntries,
  installBoundSkillPackage,
  SKILL_PACKAGE_INSTALL_TOOL_ID,
} from "./skillPackageService.js";
import { logger } from "../logger.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";
import type { ReminderCompletionNotifier } from "../notifications/reminderNotificationTypes.js";
import { readClaudeNativeAuthState, readCodexNativeAuthState } from "../enginesConfig.js";
import { buildTurnExecutionOptionsSnapshot } from "../queue/threadQueueExecutionPolicy.js";

export type OrchestrationEngineContext = {
  /** 每个同步数据库段独立申请许可，网络、工具和引擎等待不得放进回调。 */
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  /** 恢复及每次真实派发前复验固定资产来源，不影响已开始的回合收尾。 */
  assertAssetExecution?: (instance: OrchestrationInstance) => void;
  /** 读取 Client 生命周期准入；更新询问期间仅等待后续派发，不改变实例暂停态。 */
  isTaskAdmissionPaused?: () => boolean;
  assertWorkspaceWriteAvailable?: (workspaceId: WorkspaceId, instanceId: OrchestrationId) => void;
  /** 目录被占用时等待其释放；未注入时退化为同步断言。 */
  waitWorkspaceWriteAvailable?: (
    workspaceId: WorkspaceId,
    instanceId: OrchestrationId,
    options?: { shouldAbort?: () => boolean },
  ) => Promise<void>;
  db: ClientDb;
  threads: ThreadStore;
  sessions: ThreadSessionManager;
  workspaces: Map<WorkspaceId, string>;
  /** Client 本地文件路径索引；编排产物落盘后用于增量同步搜索索引。 */
  workspacePathIndex?: WorkspacePathIndex;
  timeoutPolicy: TurnTimeoutPolicy;
  emitConversation: (event: ConversationEventInput) => void;
  emitRaw: (event: RawEngineEventInput) => void;
  emitOrchestration?: (workspaceId: WorkspaceId, event: {
    id: string;
    instanceId: OrchestrationId;
    nodeId?: string | null;
    type: string;
    payloadJson: string;
    createdAt: number;
  }) => void;
  /** 提醒派生数据变化时通知外层刷新 Web 待办。 */
  notifyReminderChanged?: (workspaceId: WorkspaceId) => void;
  /**
   * 解析实例绑定的会话工作流；普通编排实例未绑定任务时返回 null。
   * 由装配方注入查库实现（见 index.ts），未注入时不发会话行状态事件。
   */
  resolveChatWorkflowBinding?: (instanceId: OrchestrationId, workspaceId?: WorkspaceId) => { threadId: string; taskId: string } | null;
  /** 编排完成并派生待查收时上报 Server 通知事件。 */
  reminderCompletionNotifier?: ReminderCompletionNotifier | null;
  /** 返回 Server 最近确认的 Relay 价格目录；断线或旧版 Server 下为空。 */
  getRelayPricingCatalog?: () => RelayPricingCatalogSnapshot | null;
  /** 为历史非终态实例补录完整运行图；缺失或失败时禁止继续推进。 */
  ensureAssetRuntimeSnapshot?: (
    instanceId: OrchestrationId,
    workspaceId?: WorkspaceId,
  ) => OrchestrationAssetRuntimeSnapshot | null | Promise<OrchestrationAssetRuntimeSnapshot | null>;
  /** 后台续跑注册时登记工作区活动，避免调度交接窗口与目录迁移并发。 */
  beginWorkspaceActivity?: (workspaceId: WorkspaceId, instanceId: OrchestrationId) => () => void;
};

const ORCH_RUNTIME_TOOLSET_ID = "__runtime_orchestration__";
const ORCH_SUBMIT_NODE_RESULT_TOOL_ID = "runtime.submitNodeResult";
const ORCH_SUBMIT_NODE_RESULT_TOOL_NAME = "提交节点结果";
const ORCH_WORK_ITEMS_LIST_TOOL_ID = "runtime.workItems.list";
const ORCH_WORK_ITEMS_CREATE_TOOL_ID = "runtime.workItems.create";
const ORCH_WORK_ITEMS_UPDATE_TOOL_ID = "runtime.workItems.update";
const ORCH_WORK_ITEMS_DELETE_TOOL_ID = "runtime.workItems.delete";
const ORCH_WORK_ITEMS_REOPEN_MANY_TOOL_ID = "runtime.workItems.reopenMany";
const ORCH_WORK_ITEMS_COMPLETE_TOOL_ID = "runtime.workItems.complete";
const ORCH_AUTO_RECOVERY_REQUIRED_CODE = "ORCHESTRATION_AUTO_RECOVERY_REQUIRED";
const ORCH_WORK_ITEM_TOOL_IDS = new Set([
  ORCH_WORK_ITEMS_LIST_TOOL_ID,
  ORCH_WORK_ITEMS_CREATE_TOOL_ID,
  ORCH_WORK_ITEMS_UPDATE_TOOL_ID,
  ORCH_WORK_ITEMS_DELETE_TOOL_ID,
  ORCH_WORK_ITEMS_REOPEN_MANY_TOOL_ID,
  ORCH_WORK_ITEMS_COMPLETE_TOOL_ID,
]);
const MAX_WORK_ITEM_NO_PROGRESS_TURNS = 8;

/**
 * 同一实例内并行执行的节点上限。轻量 Loop 是串行链、不触发该上限；
 * fork/join 或宽图此前没有任何闸门，会按就绪数一次性拉起全部节点。
 */
const MAX_CONCURRENT_NODES_PER_INSTANCE = 3;
const RECOVERABLE_PERSISTED_NODE_STATUSES = new Set<NodeExecutionStatus>([
  "ready",
  "queued",
  "running",
  "result-submitted",
  "finalizing",
  "artifact-writing",
  "gate-checking",
]);
const AUTO_RECOVERABLE_NODE_ERROR_CODE = "session_invalidated";
const SUBMIT_NODE_RESULT_TEXT_EXAMPLE = '{"review":{"verdict":"pass","summary":"完成"},"control":{"nextAction":"continue"},"answer":{"mode":"text","text":"结果摘要"}}';
const SUBMIT_NODE_RESULT_ASK_HUMAN_EXAMPLE = '{"review":{"verdict":"partial","summary":"需要用户确认"},"control":{"nextAction":"ask_human"},"humanInput":{"summary":"请确认具体内容"},"answer":{"mode":"text","text":"等待用户补充"}}';
const SUBMIT_NODE_RESULT_REWORK_EXAMPLE = '{"review":{"verdict":"fail","summary":"需要返工"},"control":{"nextAction":"rework"},"rework":{"targetNodeId":"req","reason":"返工原因","rerunNodeIds":["req","current-review"],"workItemScopes":[{"nodeId":"req","mode":"all"},{"nodeId":"current-review","mode":"all"}]},"answer":{"mode":"text","text":"返工原因"}}';
const SUBMIT_NODE_RESULT_ACCEPTANCE_EXAMPLE = '{"review":{"verdict":"pass","summary":"完成"},"control":{"nextAction":"continue"},"answer":{"mode":"text","text":"结果摘要"},"acceptanceChecks":[{"label":"验收项","verdict":"pass","blocking":true,"evidence":"已验证"}]}';
const MAX_UPSTREAM_FIELD_VALUE_CHARS = 1_000;

type ResolvedNodeWorkItemReworkScope = NodeWorkItemReworkScope & {
  alwaysClientKeys: string[];
};

type CodexRecoveryFenceBinding = {
  threadId: ThreadId;
  providerThreadId: SessionId;
};

/** 编排层统一使用的 turn.error 恢复元数据；展示文案不能替代这些字段。 */
type OrchestrationRecoveryErrorMetadata = {
  message: string;
  code: string | null;
  providerThreadId: string | null;
  recoveryReason: string | null;
  preserveBinding: boolean | null;
  userChoiceRequired: boolean | null;
  recoveryStrategies: NodeThreadRecoveryStrategy[] | null;
};

function normalizeOrchestrationRecoveryMetadata(input: {
  message: string;
  code?: string | null;
  providerThreadId?: string | null;
  recoveryReason?: string | null;
  preserveBinding?: boolean | null;
  userChoiceRequired?: boolean | null;
  recoveryStrategies?: unknown;
}): OrchestrationRecoveryErrorMetadata {
  const providerThreadId = String(input.providerThreadId ?? "").trim();
  const recoveryReason = String(input.recoveryReason ?? "").trim();
  const code = String(input.code ?? "").trim();
  const strategies = Array.from(new Set((Array.isArray(input.recoveryStrategies) ? input.recoveryStrategies : []).filter(
    (item): item is NodeThreadRecoveryStrategy => item === "retry-existing" || item === "new-thread",
  )));
  const metadata: OrchestrationRecoveryErrorMetadata = {
    message: String(input.message ?? "turn error"),
    code: code || null,
    providerThreadId: providerThreadId || null,
    recoveryReason: recoveryReason || null,
    preserveBinding: typeof input.preserveBinding === "boolean" ? input.preserveBinding : null,
    userChoiceRequired: typeof input.userChoiceRequired === "boolean" ? input.userChoiceRequired : null,
    recoveryStrategies: strategies.length ? strategies : null,
  };
  return metadata;
}

/** 判断持久化实例是否仍有启动恢复工作，避免只依赖可能滞后的实例派生状态。 */
export function shouldRecoverPersistedOrchestrationInstance(
  instance: Pick<OrchestrationInstance, "status" | "nodeStates">,
): boolean {
  if (instance.status === "completed"
    || instance.status === "failed"
    || instance.status === "cancelled"
    || instance.status === "paused") {
    return false;
  }
  if (instance.status === "running") return true;
  return Object.values(instance.nodeStates).some((state) => (
    RECOVERABLE_PERSISTED_NODE_STATUSES.has(state.status)
  ));
}

/** 为 submitNodeResult 校验错误补充最小示例，但不改变失败语义。 */
function withSubmitNodeResultExample(message: string, example: string): string {
  return `${message}。runtime.submitNodeResult 示例（answer 仍需按当前节点 outputMode/交付物契约填写）：${example}`;
}

const ATTACHMENT_KIND_VALUES: AttachmentKind[] = [
  "source",
  "document",
  "data",
  "image",
  "diff",
  "patch",
  "log",
  "archive",
  "binary",
  "unknown",
];
const ATTACHMENT_KINDS = new Set<AttachmentKind>(ATTACHMENT_KIND_VALUES);
const ATTACHMENT_FORMAT_VALUES: AttachmentFormat[] = [
  "markdown",
  "json",
  "yaml",
  "text",
  "html",
  "javascript",
  "css",
  "sql",
  "image",
  "diff",
  "patch",
  "log",
  "binary",
  "archive",
  "unknown",
];
const ROLE_OUTPUT_FORMAT_EXTENSIONS: Record<RoleOutputFormat, string[]> = {
  markdown: [".md", ".markdown"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  text: [".txt", ".text", ".log", ".diff", ".patch", ".csv", ".tsv"],
  html: [".html", ".htm"],
  javascript: [".js", ".mjs", ".cjs"],
  css: [".css"],
  sql: [".sql"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"],
};
const LEGACY_ATTACHMENT_FORMAT_VALUES: AttachmentFormat[] = [...ATTACHMENT_FORMAT_VALUES, "source"];
const ATTACHMENT_FORMATS = new Set<AttachmentFormat>(LEGACY_ATTACHMENT_FORMAT_VALUES);

/** 格式化动态附件 kind 的合法枚举，供工具说明和恢复提示复用。 */
function formatAttachmentKindAllowedValues(): string {
  return ATTACHMENT_KIND_VALUES.join(" / ");
}

/** 格式化动态附件 format 的合法枚举，避免模型把 format 当作文件后缀。 */
function formatAttachmentFormatAllowedValues(): string {
  return ATTACHMENT_FORMAT_VALUES.join(" / ");
}

type NodeArtifactInputItem = NodeArtifactInput["artifacts"][number];
type NodeArtifactInputField = NonNullable<NodeArtifactInputItem["fields"]>[number];
type NodeArtifactInputFileRef = NonNullable<NodeArtifactInputItem["workspaceFileRefs"]>[number];
type NodeArtifactInputAttachmentRef = NonNullable<NodeArtifactInputItem["workspaceAttachmentRefs"]>[number];

type NodeInputArtifactResolution = {
  ids: ArtifactId[] | null;
  missingRequired: string[];
  fieldValues: Record<string, string>;
  resolvedInputs: ResolvedNodeInput[];
  resolutionStatus: ResolvedNodeContext["status"];
};

type NodeResultSubmissionToolContext = {
  outputMode: ArtifactOutputMode;
  outputDefinition?: RoleDefinition["outputDefinition"] | null;
};

type NormalizedNodeResultSubmissionToolContext = {
  outputMode: ArtifactOutputMode;
  outputDefinition: RoleDefinition["outputDefinition"];
};

type OrchestrationRunState = {
  requestId?: string | null;
  paused: boolean;
  cancelled: boolean;
  runId: string;
  drivePromise: Promise<void> | null;
  activeNodePromises?: Map<string, Promise<NodeExecutionSettlement>>;
  wakePromise?: Promise<void> | null;
  wakeResolver?: (() => void) | null;
};

type NodeExecutionSettlement = {
  nodeId: string;
  failed?: boolean;
  error: unknown | null;
};

/** 新结算显式区分失败；旧运行对象仍按既有非空错误兼容。 */
function isNodeExecutionFailure(settlement: NodeExecutionSettlement): boolean {
  return settlement.failed ?? settlement.error != null;
}

type CancellationOwner = {
  promise: Promise<PromiseSettledResult<void>>;
  result?: PromiseSettledResult<void>;
};

type OrchestrationWorkPromise<T> = Promise<T> & { settled?: boolean; settlement?: T };

/** 仅本组自产诊断可穿透重试及控制退出，不信任外部同名 code。 */
class OrchestrationWorkspaceLogFailure extends AggregateError {
  readonly code = "ORCHESTRATION_WORKSPACE_LOG_FAILED";
  #workspaceLogFailure = true;

  /** 保留原原因层级、顺序与 falsy 值；旧诊断标题仍可检索。 */
  constructor(errors: unknown[], cause: unknown, message = "ORCHESTRATION_WORKSPACE_LOG_FAILED") {
    super(errors, message, { cause });
  }

  /** 私有品牌检查不执行未知对象的 getter 或反射 trap。 */
  static is(error: unknown): error is OrchestrationWorkspaceLogFailure {
    return typeof error === "object" && error !== null && #workspaceLogFailure in error;
  }
}

/** 本次成功投递的自产诊断；私有标记识别不反射未知拒绝对象。 */
class OrchestrationCompletionEventFailure extends AggregateError {
  readonly code = "ORCHESTRATION_COMPLETION_EVENT_FAILED";
  #completionEventFailure = true;

  /** 保留投递原因及可选诊断/释放副因，包含 falsy 原值。 */
  constructor(errors: unknown[], cause: unknown) {
    super(errors, "ORCHESTRATION_COMPLETION_EVENT_FAILED", { cause });
  }

  /** 仅接受本模块自产包装，不按 message 或未知 getter 判断。 */
  static is(error: unknown): error is OrchestrationCompletionEventFailure {
    return typeof error === "object" && error !== null && #completionEventFailure in error;
  }
}

/** 本片诊断仅凭自产 data code 分流；此处不展开未知根因。 */
function isSkillRuntimeDiagnosticFailure(error: unknown): boolean {
  if (!(error instanceof AggregateError)) return false;
  const code = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(code && "value" in code && code.value === "SKILL_RUNTIME_FAILURE_LOG_FAILED");
}

/** 已知 Profile/托管日志聚合共用原诊断边界；自有 data descriptor 不执行 getter。 */
function describeOrchestrationProfileFailure(error: unknown, depth = 0, managed = false, skill = false): Record<string, unknown> | undefined {
  const type = error === null ? "null" : typeof error;
  if (!(error instanceof Error)) return depth ? { type } : undefined;
  /** 访问器与未知正文不参与诊断。 */
  const data = (key: string): PropertyDescriptor | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor : undefined;
  };
  const titles = ["WORKSPACE_PROFILE_FAILURE_LOG_FAILED", "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED",
    "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED", "ORCHESTRATION_BACKGROUND_START_DIAGNOSTIC_FAILED", "MANAGED_SERVICE_FAILURE_LOG_FAILED",
    "MANAGED_SERVICE_STARTUP_CLEANUP_FAILED", "ORCHESTRATION_MANAGED_RUNTIME_DISPOSAL_DIAGNOSTIC_FAILED", "SKILL_RUNTIME_FAILURE_LOG_FAILED"];
  const known = error instanceof AggregateError && titles.includes(data("message")?.value);
  if (!depth && !known) return undefined;
  if (!depth) {
    let nested: unknown = error;
    for (let index = 0; index < 4; index++) {
      if (!(nested instanceof AggregateError)) return undefined;
      const title = Object.getOwnPropertyDescriptor(nested, "message");
      if (!title || !("value" in title) || !titles.includes(title.value)) return undefined;
      if (title.value === "WORKSPACE_PROFILE_FAILURE_LOG_FAILED") break;
      const code = Object.getOwnPropertyDescriptor(nested, "code");
      if (title.value === "SKILL_RUNTIME_FAILURE_LOG_FAILED" && code && "value" in code && code.value === "SKILL_RUNTIME_FAILURE_LOG_FAILED") { skill = true; break; }
      if (title.value === "MANAGED_SERVICE_FAILURE_LOG_FAILED"
        || title.value === "MANAGED_SERVICE_STARTUP_CLEANUP_FAILED" && code && "value" in code && code.value === "MANAGED_SERVICE_FAILURE_LOG_FAILED") { managed = true; break; }
      const items = Object.getOwnPropertyDescriptor(nested, "errors");
      const first = items && "value" in items && Array.isArray(items.value) ? Object.getOwnPropertyDescriptor(items.value, "0") : undefined;
      if (!first || !("value" in first) || index === 3) return undefined;
      nested = first.value;
    }
  }
  const safe = new Error();
  for (const key of ["name", "message", "code", "errno", "errcode"]) {
    if (skill && key === "message") continue;
    const descriptor = data(key);
    if (descriptor && (typeof descriptor.value === "string" || typeof descriptor.value === "number")) Object.defineProperty(safe, key, descriptor);
  }
  const context: Record<string, unknown> = {};
  if (known) for (const key of ["requestId", "workspaceId", "instanceId", "nodeId", "attemptId"]) {
    const value = data(key)?.value;
    if (typeof value === "string") context[key] = value;
  }
  const cause = data("cause"), errors = data("errors");
  const length = depth < 3 && error instanceof AggregateError && Array.isArray(errors?.value)
    ? Object.getOwnPropertyDescriptor(errors.value, "length") : undefined;
  if (length && (!("value" in length) || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0)) {
    throw new Error("ORCHESTRATION_PROFILE_DIAGNOSTIC_ARRAY_INVALID");
  }
  return { type: "Error", ...describeWorkspaceProfileFailure(safe), ...context,
    ...(managed && typeof data("message")?.value === "string" ? { message: redactClientStartupText(data("message")!.value).slice(0, 1000) } : {}),
    ...(depth < 3 && cause ? { cause: describeOrchestrationProfileFailure(cause.value, depth + 1, managed, skill) } : {}),
    ...(errors && length && "value" in length
      ? { errors: Array.from({ length: Math.min(length.value, 10) }, (_, index) => {
        const item = Object.getOwnPropertyDescriptor(errors.value, String(index));
        return describeOrchestrationProfileFailure(item && "value" in item ? item.value : undefined, depth + 1, managed, skill);
      }) } : {}),
  };
}

/** 规范化节点处理人列表，空值表示不启用节点级处理人限制。 */
function normalizeNodeAssigneeUserIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)));
  return ids.length ? ids : null;
}

/**
 * 确定性 DAG 执行引擎。
 * 只在以下场景调用 LLM：
 * - 条件节点判断 (Condition Node)
 * - AI 类质量门禁检查
 * - 自动生成工作流 DAG
 */
export class OrchestrationEngine {
  private readonly promptBuilder = new NodePromptBuilder();
  private readonly managedServiceRuntime: ManagedServiceRuntime;
  private readonly aiGateEvaluationService: AiGateEvaluationService;
  private runningInstances = new Map<OrchestrationId, OrchestrationRunState>();
  private recoveryPromises = new Map<OrchestrationId, Promise<void>>();
  private continuationPromises = new Set<OrchestrationWorkPromise<void>>();
  private managedRuntimeDisposalPromises = new Set<Promise<void>>();
  private cancellationPromises = new Map<OrchestrationId, CancellationOwner>();
  private pendingContinuationActivities = new Map<OrchestrationId, { count: number; release: () => void }>();
  private instanceControlVersions = new Map<OrchestrationId, number>();
  private stopping = false;
  private readonly workspaceEngines = new Map<WorkspaceId, OrchestrationEngine>();

  /** 每个后台 owner 固定工作区视图；仅根引擎聚合生命周期，绝不跨 await 切换上下文。 */
  forWorkspace(workspaceId: WorkspaceId): OrchestrationEngine {
    if (this.ctx.db.workspaceId === workspaceId) return this;
    const existing = this.workspaceEngines.get(workspaceId);
    if (existing) return existing;
    this.assertAcceptingExecution();
    const scoped = new OrchestrationEngine({ ...this.ctx, db: this.ctx.db.forWorkspace(workspaceId),
      resolveChatWorkflowBinding: instanceId => this.ctx.resolveChatWorkflowBinding?.(instanceId, workspaceId) ?? null,
      ensureAssetRuntimeSnapshot: instanceId => {
        if (!this.ctx.ensureAssetRuntimeSnapshot) throw new Error("ORCHESTRATION_ASSET_SNAPSHOT_OWNER_MISSING");
        return this.ctx.ensureAssetRuntimeSnapshot(instanceId, workspaceId);
      },
    });
    this.workspaceEngines.set(workspaceId, scoped);
    return scoped;
  }

  /** 活动检查仅查询已有后台 owner，不为迁移中的工作区初始化仓储或服务。 */
  existingWorkspace(workspaceId: WorkspaceId): OrchestrationEngine | null {
    return this.ctx.db.workspaceId === workspaceId ? this : this.workspaceEngines.get(workspaceId) ?? null;
  }

  private databaseDepth = 0;

  /** 已持本引擎同步许可时复用当前短段，其余操作沿Client唯一协调器准入。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    const run = (): T => {
      this.databaseDepth++;
      try {
        const value = operation();
        if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("ORCHESTRATION_DATABASE_CALLBACK_MUST_BE_SYNCHRONOUS");
        return value;
      } finally { this.databaseDepth--; }
    };
    return this.ctx.withLegacyDatabase && !this.databaseDepth
      ? await this.ctx.withLegacyDatabase(`orchestration:${this.ctx.db.workspaceId ?? "root"}`, run) : run();
  }

  constructor(private ctx: OrchestrationEngineContext) {
    this.managedServiceRuntime = new ManagedServiceRuntime({
      db: ctx.db,
      withLegacyDatabase: (_requestId, operation) => this.withDatabase(operation),
      onChanged: ({ instanceId, threadId, serviceId, status, reason }) => {
        if (!instanceId) return;
        const instance = this.ctx.db.orchInstances.get(instanceId);
        if (!instance) return;
        const payload: OrchestrationManagedServicesChangedPayload = {
          instanceId,
          threadId,
          serviceId,
          status,
          reason,
        };
        this.emitOrchEvent(instance, "orchestration.managedServices.changed", payload);
      },
    });
    this.aiGateEvaluationService = new AiGateEvaluationService({
      db: ctx.db,
      withLegacyDatabase: (_requestId, operation) => this.withDatabase(operation),
      gateRuns: ctx.db.orchGateEvaluationRuns,
      threads: ctx.threads,
      sessions: ctx.sessions,
      timeoutPolicy: ctx.timeoutPolicy,
      emitConversation: ctx.emitConversation,
      emitRaw: ctx.emitRaw,
      createPromptSnapshot: (input) => this.createPromptSnapshotByInput(input),
      emitEvent: (type, payload) => {
        const instance = this.ctx.db.orchInstances.get(String(payload.instanceId) as OrchestrationId);
        if (!instance) return;
        const nodeId = String(payload.nodeId ?? "");
        const nodeState = instance.nodeStates[nodeId];
        if (nodeState) {
          if (type === "orchestration.gateEvaluationStarted") {
            const existing = nodeState.activeGateEvaluation;
            const retryOrdinal = Number(payload.retryOrdinal ?? 0);
            if (existing && existing.evaluationRunId === String(payload.evaluationRunId)
              && (existing.retryOrdinal > retryOrdinal
                || (existing.retryOrdinal === retryOrdinal && existing.evaluationCallId !== String(payload.evaluationCallId)))) {
              this.emitOrchEvent(instance, type, payload);
              return;
            }
            nodeState.activeGateEvaluation = {
              evaluationRunId: String(payload.evaluationRunId),
              evaluationCallId: String(payload.evaluationCallId),
              retryOrdinal,
              statusVersion: Number(payload.statusVersion ?? 0),
              artifactId: String(payload.artifactId),
              nodeAttemptId: String(payload.nodeAttemptId),
              threadId: String(payload.threadId) as ThreadId,
              turnId: String(payload.turnId) as TurnId,
              promptSnapshotId: String(payload.promptSnapshotId),
              startedAt: Date.now(),
            };
            nodeState.promptSnapshotIds = Array.from(new Set([...(nodeState.promptSnapshotIds ?? []), String(payload.promptSnapshotId)]));
          } else if (type === "orchestration.gateEvaluationCompleted" || type === "orchestration.gateEvaluationFailed") {
            const active = nodeState.activeGateEvaluation;
            if (active?.evaluationRunId === String(payload.evaluationRunId) && active.evaluationCallId === String(payload.evaluationCallId)) {
              nodeState.activeGateEvaluation = null;
            }
          }
          instance.nodeStates[nodeId] = nodeState;
          this.ctx.db.orchInstances.updateNodeStates(instance.id, instance.nodeStates);
        }
        this.emitOrchEvent(instance, type, payload);
      },
    });
  }

  /** 创建实例级单协调器状态；节点 Promise 和唤醒信号均归该实例统一持有。 */
  private createRunState(): OrchestrationRunState {
    return {
      paused: false,
      cancelled: false,
      runId: crypto.randomUUID(),
      drivePromise: null,
      activeNodePromises: new Map(),
      wakePromise: null,
      wakeResolver: null,
    };
  }

  /** 同步停止本地调度并唤醒协调器，不改变实例业务状态。 */
  stop(): void {
    this.stopping = true;
    for (const engine of this.workspaceEngines.values()) engine.stop();
    for (const state of this.runningInstances.values()) {
      this.signalCoordinator(state);
    }
  }

  /** 停止本地调度并等待引擎已持有的异步工作收口，不改变实例业务状态。 */
  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.waitForInFlightWork();
  }

  /** 只读查询原异步 owner；已结算失败仍可等待，但不再算作在途活动。 */
  hasInFlightWork(): boolean {
    return this.collectDrainPromises(true).length > 0 || [...this.workspaceEngines.values()].some(engine => engine.hasInFlightWork());
  }

  /** 自然等待原 owner 及其交接工作；不停止调度、取消实例或改写业务终态。 */
  async waitForInFlightWork(options: { requestId?: string; timeoutMs?: number } = {}): Promise<void> {
    const children = await Promise.allSettled([...this.workspaceEngines.values()].map(engine => engine.waitForInFlightWork(options)));
    const childFailures = children.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (childFailures.length) throw new AggregateError(childFailures, "ORCHESTRATION_WORKSPACE_DRAIN_FAILED");
    const { timeoutMs } = options;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw Object.assign(new Error("ORCHESTRATION_IN_FLIGHT_WAIT_INPUT_INVALID"), {
        code: "ORCHESTRATION_IN_FLIGHT_WAIT_INPUT_INVALID", requestId: options.requestId ?? null, timeoutMs,
      });
    }
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    const drained = new Set<Promise<unknown>>();
    const failures: unknown[] = [];
    /** 原 owner 可重复报告同一失败；去重时保留 -0 等原始拒绝值。 */
    const recordFailure = (failure: unknown): void => {
      if (!failures.some(error => Object.is(error, failure))) failures.push(failure);
    };
    while (true) {
      const nodes = new Set<Promise<unknown>>();
      for (const state of this.runningInstances.values()) {
        for (const promise of this.ensureActiveNodePromises(state).values()) nodes.add(promise);
      }
      const cancellations = new Set<Promise<unknown>>([...this.cancellationPromises.values()].map(owner => owner.promise));
      const pending = this.collectDrainPromises().filter((promise) => !drained.has(promise));
      if (pending.length === 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settlements: PromiseSettledResult<unknown>[];
      try {
        const waiting = Promise.allSettled(pending);
        settlements = deadline === null ? await waiting : await Promise.race([
          waiting,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error("ORCHESTRATION_IN_FLIGHT_WAIT_TIMEOUT"), {
              code: "ORCHESTRATION_IN_FLIGHT_WAIT_TIMEOUT", requestId: options.requestId ?? null, timeoutMs,
              instanceIds: [...new Set([...this.runningInstances.keys(), ...this.recoveryPromises.keys(), ...this.cancellationPromises.keys()])],
            })), Math.max(0, deadline - Date.now()));
          }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      for (const promise of pending) drained.add(promise);
      for (const [index, settlement] of settlements.entries()) {
        if (settlement.status === "rejected") recordFailure(settlement.reason);
        else if (nodes.has(pending[index])) {
          const node = settlement.value as NodeExecutionSettlement;
          if (isNodeExecutionFailure(node)) recordFailure(node.error);
        } else if (cancellations.has(pending[index])) {
          const result = settlement.value as PromiseSettledResult<void>;
          if (result.status === "rejected") recordFailure(result.reason);
        }
      }
    }
    for (const [instanceId, state] of this.runningInstances) {
      const active = this.ensureActiveNodePromises(state);
      for (const [nodeId, promise] of active) {
        if (drained.has(promise) && active.get(nodeId) === promise) active.delete(nodeId);
      }
      await this.withDatabase(() => this.cleanupSettledRunState(instanceId, state));
    }
    for (const [instanceId, owner] of this.cancellationPromises) {
      if (drained.has(owner.promise) && this.cancellationPromises.get(instanceId) === owner) this.cancellationPromises.delete(instanceId);
    }
    for (const promise of this.continuationPromises) {
      if (drained.has(promise)) this.continuationPromises.delete(promise);
    }
    for (const promise of this.managedRuntimeDisposalPromises) {
      if (drained.has(promise)) this.managedRuntimeDisposalPromises.delete(promise);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "ORCHESTRATION_IN_FLIGHT_WORK_FAILED");
  }

  /** 收集原异步 owner；活动查询排除已结算项，等待仍消费其失败结果。 */
  private collectDrainPromises(pendingOnly = false): Promise<unknown>[] {
    const promises = new Set<Promise<unknown>>([
      ...this.recoveryPromises.values(),
      ...this.continuationPromises,
      ...this.managedRuntimeDisposalPromises,
      ...[...this.cancellationPromises.values()].filter(owner => !pendingOnly || !owner.result).map(owner => owner.promise),
    ]);
    for (const state of this.runningInstances.values()) {
      if (state.drivePromise) promises.add(state.drivePromise);
      for (const promise of this.ensureActiveNodePromises(state).values()) promises.add(promise);
    }
    return [...promises].filter(promise => !pendingOnly || !(promise as OrchestrationWorkPromise<unknown>).settled);
  }

  /** 拒绝关闭开始后的新执行入口，避免 DB 排空阶段重新推进实例。 */
  private assertAcceptingExecution(): void {
    if (this.stopping) throw new Error("编排引擎正在停止，不能继续执行");
  }

  /** 读取实例暂停/终止控制版本，用于识别异步恢复期间的新用户控制。 */
  private getInstanceControlVersion(instanceId: OrchestrationId): number {
    return this.instanceControlVersions.get(instanceId) ?? 0;
  }

  /** 记录新的实例暂停或终止请求，避免旧恢复结果覆盖后到的用户控制。 */
  private advanceInstanceControlVersion(instanceId: OrchestrationId): void {
    this.instanceControlVersions.set(instanceId, this.getInstanceControlVersion(instanceId) + 1);
  }

  /** 启动并等待原协调器收敛，保留内部调用方已有等待语义。 */
  async start(instanceId: OrchestrationId): Promise<void> {
    const state = await this.prepareStart(instanceId);
    await this.driveInstance(instanceId, state);
  }

  /** API 等待受理完成；执行仍交给唯一 coordinator，后台失败保存真实失败态。 */
  async startInBackground(instanceId: OrchestrationId, requestId: string): Promise<void> {
    const state = await this.prepareStart(instanceId);
    state.requestId = requestId;
    const pending: OrchestrationWorkPromise<void> = this.driveInstance(instanceId, state).catch(async error => {
      if (OrchestrationCompletionEventFailure.is(error)) throw error;
      // 最终诊断属于原 continuation owner，失败保留供 wait/drain 消费。
      if (!this.stopping) await this.withDatabase(() => this.writeLifecycleLog(instanceId, "background start did not settle", "ORCHESTRATION_BACKGROUND_START_FAILED", "background_start", {
        requestId, runId: state.runId,
      }, { error, title: "ORCHESTRATION_BACKGROUND_START_DIAGNOSTIC_FAILED" }));
      throw error;
    });
    this.continuationPromises.add(pending);
    void pending.then(() => { pending.settled = true; this.continuationPromises.delete(pending); }, () => { pending.settled = true; });
  }

  /** 两种启动方式共用原快照准入；受理前失败留实例事实并向请求抛出。 */
  private async prepareStart(instanceId: OrchestrationId): Promise<OrchestrationRunState> {
    let state: OrchestrationRunState | undefined;
    try {
      const instance = await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
      this.assertAcceptingExecution();
      state = this.createRunState();
      this.runningInstances.set(instanceId, state);
      await this.withDatabase(() => {
        this.updateInstanceStatus(instanceId, "running");
        this.emitOrchEvent(instance, "orchestration.started", { instanceId, workflowName: instance.workflowSnapshot.name });
      });
      return state;
    } catch (error) {
      try {
        await this.withDatabase(() => {
        if (!this.stopping) {
          const instance = this.ctx.db.orchInstances.get(instanceId);
          if (instance) {
            this.updateInstanceStatus(instanceId, "failed");
            this.emitOrchEvent(instance, "orchestration.error", { instanceId, source: "start_preparation", error: error instanceof Error ? error.message : String(error) });
          }
        }
        });
      } catch (failure) {
        throw new AggregateError([error, failure], "ORCHESTRATION_START_PREPARATION_FAILED");
      } finally {
        if (state && this.runningInstances.get(instanceId) === state) this.runningInstances.delete(instanceId);
      }
      throw error;
    }
  }

  /** Client 重启后的恢复：重新接管 DB 中仍处于运行中的实例。 */
  recover(instanceId: OrchestrationId): Promise<void> {
    const existing = this.recoveryPromises.get(instanceId);
    if (existing) return existing;

    let recoveryPromise!: Promise<void>;
    recoveryPromise = this.recoverOnce(instanceId).finally(() => {
      if (this.recoveryPromises.get(instanceId) === recoveryPromise) {
        this.recoveryPromises.delete(instanceId);
      }
    });
    this.recoveryPromises.set(instanceId, recoveryPromise);
    return recoveryPromise;
  }

  /** 执行一次实例恢复；同实例并发入口由 recover 复用同一 Promise。 */
  private async recoverOnce(instanceId: OrchestrationId): Promise<void> {
    await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    const instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    if (!shouldRecoverPersistedOrchestrationInstance(instance)) return;

    const state = this.runningInstances.get(instanceId) ?? this.createRunState();
    if (!this.runningInstances.has(instanceId)) {
      this.runningInstances.set(instanceId, state);
    }
    state.paused = false;
    state.cancelled = false;
    (await this.withDatabase(() => this.updateInstanceStatus(instanceId, "running")));

    await this.withDatabase(() => this.aiGateEvaluationService.recover(instanceId));
    await this.reconcileRecoveredInstance(instanceId);

    const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!latest || this.isTerminalInstanceStatus(latest.status)) {
      if (this.runningInstances.get(instanceId) === state && state.drivePromise) await state.drivePromise;
      else if (this.runningInstances.get(instanceId) === state) this.runningInstances.delete(instanceId);
      return;
    }

    (await this.withDatabase(() => this.emitOrchEvent(latest, "orchestration.recovered", {
      instanceId,
      workflowName: latest.workflowSnapshot.name,
    })));

    await this.driveInstance(instanceId, state);
  }

  /** 启动时修正非终态实例的派生状态，并收敛暂停实例中的遗留活跃节点。 */
  normalizePersistedInstanceStatuses(): void {
    if (this.ctx.db.workspaceId !== null) {
      for (const instance of this.ctx.db.orchInstances.listByWorkspace(this.ctx.db.workspaceId)) this.normalizePersistedInstanceState(instance);
      return;
    }
    for (const workspace of this.ctx.db.workspaces.list()) {
      this.forWorkspace(workspace.id).normalizePersistedInstanceStatuses();
    }
  }

  /** 只规范化一个已补录实例；快照缺失时在任何状态写入前失败。 */
  normalizePersistedInstanceStatus(instanceId: OrchestrationId): void {
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    this.normalizePersistedInstanceState(instance);
  }

  /** 在已读取实例上执行状态规范化，快照校验必须先于所有写入。 */
  private normalizePersistedInstanceState(instance: OrchestrationInstance): void {
    if (this.isTerminalInstanceStatus(instance.status)) return;
    this.requireAssetRuntimeSnapshot(instance);
    this.hydrateAutomaticFeedbackRecoveryError(instance);
    if (instance.status === "paused") {
      this.normalizePausedInstanceActiveNodes(instance.id, instance);
      return;
    }
    this.syncInstanceRuntimeStatus(instance.id, instance);
  }

  /** 对账因执行中断而缺失的节点终态，仅在引擎仍接受执行时继续持久化。 */
  async reconcileExecutionInterruptedTurnCompletion(input: {
    threadId: ThreadId;
    turnId: TurnId | null;
    responseText?: string | null;
  }): Promise<void> {
    const normalizedThreadId = String(input.threadId ?? "").trim() as ThreadId;
    if (!normalizedThreadId) return;

    for (const candidate of (await this.withDatabase(() => this.listInstancesBoundToThread(normalizedThreadId)))) {
      const current = (await this.withDatabase(() => this.ctx.db.orchInstances.get(candidate.id))) ?? candidate;
      if (this.isTerminalInstanceStatus(current.status)) continue;
      await this.ensureAssetRuntimeSnapshotForExecution(candidate.id);
      this.assertAcceptingExecution();
      const instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(candidate.id))) ?? candidate;
      if (this.isTerminalInstanceStatus(instance.status)) continue;

      for (const node of instance.workflowSnapshot.nodes) {
        if (node.type !== "role" || !node.roleId) continue;
        const nodeState = instance.nodeStates[node.id];
        if (
          !nodeState
          || nodeState.status !== "waiting-feedback"
          || nodeState.humanActionSource !== "execution"
          || String(nodeState.threadId ?? "").trim() !== normalizedThreadId
        ) {
          continue;
        }

        const role = this.resolveRecoveredRoleDefinition(node, instance);
        if (!role) continue;
        const recoveredTurnId = input.turnId;
        const recoveredExecution = recoveredTurnId
          ? (await this.withDatabase(() => this.findRecoverableExecutionFromTurn(instance, node, role, normalizedThreadId, recoveredTurnId)))
          : null;
        if (!recoveredTurnId || !recoveredExecution) continue;

        const attempt = (await this.withDatabase(() => this.ensureRecoveredSubmittedAttempt(
          instance,
          node,
          normalizedThreadId,
          recoveredTurnId,
          recoveredExecution,
        )));
        await this.finalizeRecoveredRoleExecution(instance.id, node, instance, role, {
          rawOutput: recoveredExecution.responseText,
          finalAnswer: recoveredExecution.finalAnswer,
        }, attempt.id);

        const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instance.id))) ?? instance;
        (await this.withDatabase(() => this.emitOrchEvent(latest, "orchestration.nodeRecovered", {
          instanceId: instance.id,
          nodeId: node.id,
          nodeLabel: node.label,
          action: "execution-feedback-turn-completed",
          threadId: normalizedThreadId,
          turnId: input.turnId,
        })));

        if (latest.status === "running") {
          const activeState = await this.ensureRecoverableActiveRunState(instance.id);
          if (!activeState.paused && !activeState.cancelled) {
            await this.driveInstance(instance.id, activeState);
          }
        }
      }
    }
  }

  /** 平台record保持原查询；内部快照可复用已核thread scope，避免迁移中重开写连接。 */
  listManagedServicesForThread(threadId: ThreadId, verifiedScope?: ThreadManagedServicesScope): ManagedServiceSnapshot[] {
    if (verifiedScope?.threadId && verifiedScope.threadId !== threadId) throw new Error("MANAGED_SERVICE_THREAD_SCOPE_MISMATCH");
    const platformItems = this.managedServiceRuntime.listThreadServices(threadId);
    const scope = verifiedScope ?? this.getManagedServicesScopeForThread(threadId);
    if (!scope.visible || !scope.threadId) return platformItems;
    const engineItems = this.ctx.sessions.listEngineManagedServices(scope.threadId);
    return [...platformItems, ...engineItems]
      .sort((left, right) => right.startedAt - left.startedAt || left.serviceId.localeCompare(right.serviceId));
  }

  /** 父实体删除后仍回收并交付原平台失败，未命中才核原 fallback scope。 */
  async stopManagedServiceForThread(threadId: ThreadId, serviceId: string): Promise<boolean> {
    const platformStopped = await this.managedServiceRuntime.stopThreadService(threadId, serviceId);
    if (platformStopped) return true;
    const scope = (await this.withDatabase(() => this.getManagedServicesScopeForThread(threadId)));
    if (!scope.visible || !scope.threadId) return false;
    return await this.ctx.sessions.stopEngineManagedService(scope.threadId, serviceId);
  }

  async disposeManagedServicesForThread(threadId: ThreadId, reason = "thread-disposed"): Promise<void> {
    await this.managedServiceRuntime.disposeThreadServices(threadId, reason);
  }

  buildManagedServiceToolRegistry(accessMode: AccessMode, opts?: { includeWhenReadOnly?: boolean }): ExecutableToolRegistry | null {
    if (accessMode === "read-only" && opts?.includeWhenReadOnly !== true) return null;
    const tools = this.managedServiceRuntime.buildBuiltinTools();
    if (!tools.length) return null;
    return { tools };
  }

  /** 内建服务沿原 retained owner 消费，父 thread 删除不改变资源清理归属。 */
  async executeManagedServiceToolForThread(input: {
    threadId: ThreadId;
    workspacePath: string;
    toolId: string;
    toolInput: unknown;
    accessMode: AccessMode;
  }): Promise<ToolExecutionResult> {
    const tool = this.managedServiceRuntime
      .buildBuiltinTools()
      .find((item) => String(item.toolId) === String(input.toolId));
    if (!tool) {
      return {
        ok: false,
        toolId: input.toolId,
        code: "TOOL_NOT_FOUND",
        message: `未找到进程工具：${input.toolId}`,
        stage: "validating",
        retryable: false,
      };
    }
    const runtime = new ToolRuntimeService(input.workspacePath, {
      db: this.ctx.db,
      withLegacyDatabase: (_requestId, operation) => this.withDatabase(operation),
      managedServices: this.managedServiceRuntime,
      threadId: input.threadId,
      instanceId: null,
    });
    return runtime.execute(tool, input.toolInput, input.accessMode);
  }

  getManagedServicesScopeForThread(threadId: ThreadId): ThreadManagedServicesScope {
    const thread = this.ctx.db.threads.get(threadId);
    if (!thread) {
      return { visible: false, threadId: null };
    }
    return {
      visible: true,
      threadId,
    };
  }

  ensureDiscussionThread(
    instanceId: OrchestrationId,
    nodeId: string,
  ): { threadId: ThreadId; created: boolean } {
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);

    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) throw new Error(`节点不存在: ${nodeId}`);
    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) throw new Error(`节点不存在: ${nodeId}`);

    const discussionTitle = `讨论：${node.label || nodeId}`;
    const boundDiscussionThreadId = String(nodeState.discussionThreadId ?? "").trim() as ThreadId;
    const nodeThreadId = String(nodeState.threadId ?? "").trim() as ThreadId;
    const nodeThread = nodeThreadId ? this.ctx.db.threads.get(nodeThreadId) : null;
    const preferredEngine = nodeThread?.engine ?? "codex";
    const preferredModel = nodeThread?.model ?? null;
    const preferredEffort = nodeThread?.effort ?? null;

    if (boundDiscussionThreadId) {
      const persistedThread = this.ctx.db.threads.get(boundDiscussionThreadId);
      if (
        persistedThread
        && persistedThread.workspaceId === instance.workspaceId
        && persistedThread.threadType === "chat"
        && persistedThread.threadSubtype === "node-discussion"
      ) {
        this.ctx.db.threads.rename(boundDiscussionThreadId, discussionTitle);
        this.ctx.db.threads.updatePrefs(boundDiscussionThreadId, {
          model: persistedThread.model ?? preferredModel,
          effort: persistedThread.effort ?? preferredEffort,
          accessMode: "read-only",
          planMode: false,
          autoCompactPct: persistedThread.autoCompactPct ?? null,
          contextWindow: persistedThread.contextWindow ?? null,
        });
        const runtimeThread = this.ctx.threads.get(boundDiscussionThreadId) ?? this.ctx.threads.create({
          threadId: boundDiscussionThreadId,
          workspaceId: instance.workspaceId,
          engine: persistedThread.engine,
          title: discussionTitle,
          sessionId: persistedThread.sessionId,
          sessionCapabilities: persistedThread.sessionCapabilities,
        });
        if (persistedThread.sessionId && !runtimeThread.sessionId) {
          this.ctx.threads.setSessionBinding(
            boundDiscussionThreadId,
            persistedThread.sessionId,
            persistedThread.sessionCapabilities,
          );
        }
        this.ctx.threads.setTitle(boundDiscussionThreadId, discussionTitle);
        this.assignDiscussionThread(instance, nodeId, boundDiscussionThreadId);
        return { threadId: boundDiscussionThreadId, created: false };
      }
    }

    const threadId = `orch-discussion-${instance.id}-${nodeId}-${Date.now()}-${crypto.randomUUID()}` as ThreadId;
    this.ctx.db.threads.create({
      id: threadId,
      workspaceId: instance.workspaceId,
      engine: preferredEngine,
      title: discussionTitle,
      threadType: "chat",
      threadSubtype: "node-discussion",
      prefs: {
        model: preferredModel,
        effort: preferredEffort,
        accessMode: "read-only",
        planMode: false,
      },
    });
    this.ctx.threads.create({
      threadId,
      workspaceId: instance.workspaceId,
      engine: preferredEngine,
      title: discussionTitle,
    });
    this.assignDiscussionThread(instance, nodeId, threadId);
    return { threadId, created: true };
  }

  /** 暂停流程：立即中断活跃节点 turn，并把节点放回可恢复执行态。 */
  async pause(instanceId: OrchestrationId): Promise<void> {
    const instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    this.advanceInstanceControlVersion(instanceId);

    const state = this.runningInstances.get(instanceId);
    if (state) state.paused = true;

    (await this.withDatabase(() => this.updateInstanceStatus(instanceId, "paused")));
    instance.status = "paused";
    const pausedNodeIds = await this.pauseActiveRoleNodesForResume(
      instanceId,
      instance,
      "流程已暂停，当前节点执行已中断；恢复流程后将沿用本线程上下文继续执行。",
    );
    (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.paused", { instanceId, pausedNodeIds })));
  }

  /** 恢复执行。 */
  async resume(instanceId: OrchestrationId): Promise<void> {
    const resumeControlVersion = this.getInstanceControlVersion(instanceId);
    await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    if (this.getInstanceControlVersion(instanceId) !== resumeControlVersion) return;
    const recovered = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!recovered) throw new Error(`编排实例不存在: ${instanceId}`);
    if (this.isTerminalInstanceStatus(recovered.status)) return;
    await this.withDatabase(() => this.ctx.assertWorkspaceWriteAvailable?.(recovered.workspaceId, instanceId));
    const { state, requiresReconcile } = (await this.withDatabase(() => this.prepareResumeRun(instanceId)));
    if (requiresReconcile) {
      await this.reconcileRecoveredInstance(instanceId);
      const reconciled = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
      if (!reconciled) throw new Error(`编排实例不存在: ${instanceId}`);
      if (this.isTerminalInstanceStatus(reconciled.status)) return;
      if (this.getInstanceControlVersion(instanceId) !== resumeControlVersion
        || reconciled.status === "paused"
        || state.paused
        || state.cancelled) {
        return;
      }
    }
    await this.driveInstance(instanceId, state);
  }

  /** 恢复同步状态后后台推进，避免 HTTP 请求等待长任务执行完成。 */
  async resumeInBackground(instanceId: OrchestrationId): Promise<void> {
    const resumeControlVersion = this.getInstanceControlVersion(instanceId);
    await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    if (this.getInstanceControlVersion(instanceId) !== resumeControlVersion) return;
    const recovered = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!recovered) throw new Error(`编排实例不存在: ${instanceId}`);
    if (this.isTerminalInstanceStatus(recovered.status)) return;
    await this.withDatabase(() => this.ctx.assertWorkspaceWriteAvailable?.(recovered.workspaceId, instanceId));
    const { state, requiresReconcile } = (await this.withDatabase(() => this.prepareResumeRun(instanceId)));
    if (requiresReconcile) {
      await this.reconcileRecoveredInstance(instanceId);
      const reconciled = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
      if (!reconciled) throw new Error(`编排实例不存在: ${instanceId}`);
      if (this.isTerminalInstanceStatus(reconciled.status)) return;
      if (this.getInstanceControlVersion(instanceId) !== resumeControlVersion
        || reconciled.status === "paused"
        || state.paused
        || state.cancelled) {
        return;
      }
    }
    const pending: OrchestrationWorkPromise<void> = this.continueRunInBackground(instanceId, state).catch(async (error) => {
      if (OrchestrationCompletionEventFailure.is(error)) throw error;
      await this.withDatabase(() => this.emitBackgroundDriveError(instanceId, error));
      throw error;
    });
    this.continuationPromises.add(pending);
    void pending.then(() => { pending.settled = true; this.continuationPromises.delete(pending); }, () => { pending.settled = true; });
  }

  /** 初始化恢复运行态；仅新建本地运行态时要求执行重启恢复对账。 */
  private prepareResumeRun(instanceId: OrchestrationId): {
    instance: OrchestrationInstance;
    state: OrchestrationRunState;
    requiresReconcile: boolean;
  } {
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    const existingState = this.runningInstances.get(instanceId) ?? null;
    const state = existingState ?? this.createRunState();
    if (!existingState) {
      this.runningInstances.set(instanceId, state);
    }
    state.paused = false;
    state.cancelled = false;
    this.updateInstanceStatus(instanceId, "running");
    this.emitOrchEvent(instance, "orchestration.resumed", { instanceId });
    return { instance, state, requiresReconcile: !existingState };
  }

  /** 原后台 owner 同时保留推进失败和事件投递副错，不覆盖主因。 */
  private emitBackgroundDriveError(instanceId: OrchestrationId, error: unknown): void {
    if (OrchestrationWorkspaceLogFailure.is(error)) throw error;
    if (this.stopping) return;
    try {
      const latest = this.ctx.db.orchInstances.get(instanceId);
      if (!latest) throw new Error(`编排后台失败缺少实例: ${instanceId}`);
      this.emitOrchEvent(latest, "orchestration.error", {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (eventError) { throw new OrchestrationWorkspaceLogFailure([error, eventError], error); }
  }

  /** 同步记录取消终态，异步中断与清理归同一次取消，供等待入口确认。 */
  cancel(instanceId: OrchestrationId, options: { requestId?: string } = {}): void {
    const previous = this.cancellationPromises.get(instanceId);
    if (previous && !previous.result) return;
    const pending: Promise<unknown>[] = [];
    const state = this.runningInstances.get(instanceId);
    if (state?.drivePromise) pending.push(state.drivePromise);
    const recovery = this.recoveryPromises.get(instanceId);
    if (recovery) pending.push(recovery);
    if (state) {
      const active = this.ensureActiveNodePromises(state);
      for (const [nodeId, promise] of active) pending.push(promise.then(result => {
        if (isNodeExecutionFailure(result)) throw result.error;
      }).finally(async () => {
        if (active.get(nodeId) === promise) active.delete(nodeId);
        await this.withDatabase(() => this.cleanupSettledRunState(instanceId, state));
      }));
    }
    this.trackCancellation(instanceId, pending, options.requestId ?? state?.requestId ?? `cancel:${instanceId}`);
    try {
      this.advanceInstanceControlVersion(instanceId);
      if (state) {
        state.cancelled = true;
        state.paused = false;
        this.signalCoordinator(state);
        if (!state.drivePromise) this.runningInstances.delete(instanceId);
      }
      this.ctx.db.orchNodeAttempts.cancelActiveByInstance(instanceId, "编排实例已取消");
      for (const gateRun of this.ctx.db.orchGateEvaluationRuns.listRecoverable(instanceId)) {
        this.ctx.db.orchGateEvaluationRuns.updateCas(gateRun.id, gateRun.statusVersion, {
          status: "cancelled", activeCallId: null, activeThreadId: null, activeTurnId: null,
          lastErrorCode: "AI_GATE_CANCELLED", lastError: "编排实例已取消", finishedAt: Date.now(),
        });
      }
      const instance = this.ctx.db.orchInstances.get(instanceId);
      const recoveryBindings = instance ? this.collectCodexRecoveryFenceBindings(instance) : [];
      if (instance) {
        const runningByThread = this.ctx.db.turns.listRunningByWorkspace(instance.workspaceId);
        let changed = false;
        for (const node of instance.workflowSnapshot.nodes) {
          const nodeState = instance.nodeStates[node.id];
          if (!nodeState) continue;
          const activeGate = nodeState.activeGateEvaluation ?? null;
          const threadId = nodeState.threadId ?? null;
          const runningTurnId = threadId ? runningByThread[threadId]?.runningTurnId
            ?? this.ctx.sessions.getActiveTurnId?.(threadId as ThreadId) ?? null : null;
          if (activeGate?.threadId && activeGate.turnId) {
            this.interruptRunningTurnForCancel(instance, activeGate.threadId as ThreadId, activeGate.turnId, pending);
          }
          if (threadId && runningTurnId) this.interruptRunningTurnForCancel(instance, threadId as ThreadId, runningTurnId, pending);
          if (nodeState.status === "queued"
            || nodeState.status === "running"
            || nodeState.status === "result-submitted"
            || nodeState.status === "finalizing"
            || nodeState.status === "artifact-writing"
            || nodeState.status === "gate-checking"
            || nodeState.status === "waiting-start"
            || nodeState.status === "waiting-approval"
            || nodeState.status === "waiting-feedback") {
            if (activeGate?.threadId && activeGate.turnId) {
              const gateRun = this.ctx.db.orchGateEvaluationRuns.get(activeGate.evaluationRunId);
              if (gateRun && gateRun.statusVersion && gateRun.status !== "cancelled") {
                this.ctx.db.orchGateEvaluationRuns.updateCas(gateRun.id, gateRun.statusVersion, {
                  status: "cancelled", activeCallId: null, activeThreadId: null, activeTurnId: null,
                  lastErrorCode: "AI_GATE_CANCELLED", lastError: "编排实例已取消", finishedAt: Date.now(),
                });
              }
            }
            nodeState.status = "cancelled";
            nodeState.completedAt = Date.now();
            instance.nodeStates[node.id] = nodeState;
            this.emitNodeStateChanged(instance, node.id, node.label, "cancelled");
            changed = true;
          }
        }
        if (changed) {
          this.ctx.db.orchInstances.updateNodeStates(instanceId, instance.nodeStates);
        }
        this.emitOrchEvent(instance, "orchestration.cancelled", { instanceId });
      }
      this.updateInstanceStatus(instanceId, "cancelled");
      // fence 诊断失败也必须尝试本次必要释放，归原取消 owner 收齐。
      try { if (instance) this.releaseCodexRecoveryFences(instance, recoveryBindings, "cancel-instance"); }
      finally { pending.push(this.disposeManagedRuntime(instanceId)); }
    } catch (error) {
      pending.push(Promise.reject(error));
      throw error;
    }
  }

  /** 停止单个节点：中断 in-flight turn，并立即收敛为 waiting-feedback。 */
  async cancelNode(instanceId: OrchestrationId, nodeId: string): Promise<void> {
    const instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) throw new Error(`节点不存在: ${nodeId}`);
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) throw new Error(`节点状态不存在: ${nodeId}`);
    const cancellable: NodeExecutionStatus[] = [
      "running",
      "queued",
      "result-submitted",
      "finalizing",
      "artifact-writing",
      "gate-checking",
    ];
    if (!cancellable.includes(nodeState.status)) {
      throw new Error(`当前节点状态不可停止: ${nodeState.status}`);
    }
    const interrupted = await this.interruptNodeTurns(instance, nodeId, nodeState, "用户停止节点执行");

    const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId))) ?? instance;
    const latestNodeState = latest.nodeStates[nodeId];
    if (!latestNodeState || !cancellable.includes(latestNodeState.status)) return;
    const requestedAttemptId = this.resolveNodeAttemptId(nodeState);
    const latestAttemptId = this.resolveNodeAttemptId(latestNodeState);
    if (requestedAttemptId && latestAttemptId !== requestedAttemptId) return;
    const recoveryBinding = this.captureCodexRecoveryFenceBinding(latestNodeState);

    const reason = interrupted
      ? "用户已停止节点执行"
      : "用户停止节点时未发现活跃会话，节点已转为待反馈";
    (await this.withDatabase(() => this.markNodeAsExecutionInterrupted(instanceId, node, latest, reason)));
    (await this.withDatabase(() => this.releaseCodexRecoveryFences(latest, recoveryBinding ? [recoveryBinding] : [], "cancel-node")));
  }

  /** 复用会话层的中断裁决，只停止当前节点的角色和门禁 turn，不改变节点结论。 */
  private async interruptNodeTurns(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeState: NodeExecutionState,
    reason: string,
  ): Promise<boolean> {
    const threadId = nodeState.threadId ?? null;
    const runningByThread = threadId ? (await this.withDatabase(() => this.ctx.db.turns.listRunningByWorkspace(instance.workspaceId))) : {};
    const runningTurnId = threadId ? runningByThread[threadId]?.runningTurnId ?? null : null;

    let interrupted = false;
    const activeGate = nodeState.activeGateEvaluation ?? null;
    for (const gateRun of (await this.withDatabase(() => this.ctx.db.orchGateEvaluationRuns.listRecoverable(instance.id)))) {
      if (gateRun.nodeId !== nodeId) continue;
      (await this.withDatabase(() => this.ctx.db.orchGateEvaluationRuns.updateCas(gateRun.id, gateRun.statusVersion, {
        status: "cancelled", activeCallId: null, activeThreadId: null, activeTurnId: null,
        lastErrorCode: "AI_GATE_CANCELLED", lastError: reason, finishedAt: Date.now(),
      })));
    }
    if (activeGate?.threadId && activeGate.turnId) {
      const gateRun = (await this.withDatabase(() => this.ctx.db.orchGateEvaluationRuns.get(activeGate.evaluationRunId)));
      if (gateRun && gateRun.status !== "cancelled") {
        (await this.withDatabase(() => this.ctx.db.orchGateEvaluationRuns.updateCas(gateRun.id, gateRun.statusVersion, {
          status: "cancelled", activeCallId: null, activeThreadId: null, activeTurnId: null,
          lastErrorCode: "AI_GATE_CANCELLED", lastError: reason, finishedAt: Date.now(),
        })));
      }
      interrupted = await this.ctx.sessions.interrupt(activeGate.threadId as ThreadId, activeGate.turnId);
    }
    if (threadId && runningTurnId) {
      interrupted = await this.ctx.sessions.interrupt(threadId as ThreadId, runningTurnId);
    }
    return interrupted;
  }

  /** 放行等待人工启动的节点，并把启动补充说明注入本轮节点上下文。 */
  async startWaitingNode(
    instanceId: OrchestrationId,
    nodeId: string,
    actorUserId?: string | null,
    feedback?: string | null,
  ): Promise<void> {
    const instance = await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    if (this.isTerminalInstanceStatus(instance.status) || instance.status === "paused") {
      throw new Error(`当前编排状态不可启动节点: ${instance.status}`);
    }
    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) throw new Error(`节点不存在: ${nodeId}`);
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) throw new Error(`节点状态不存在: ${nodeId}`);
    if (nodeState.status !== "waiting-start") {
      throw new Error(`当前节点状态不可启动: ${nodeState.status}`);
    }

    const previousStatus = nodeState.status;
    const approvedBy = String(actorUserId ?? "").trim() || null;
    const manualStartFeedback = String(feedback ?? "").trim();
    if (manualStartFeedback) {
      (await this.withDatabase(() => this.assertFeedbackContextBudgetForAppend(
        instance,
        nodeId,
        { feedback: manualStartFeedback, images: null },
        `节点「${node.label}」的启动补充说明`,
      )));
      const record = (await this.withDatabase(() => this.ctx.db.orchFeedback.create({
        instanceId,
        nodeId,
        action: "manual_start_context",
        source: "human_input",
        feedback: manualStartFeedback,
        artifactIds: [],
        createdAt: Date.now(),
      })));
      this.appendFeedbackHistoryRecord(nodeState, record.id);
      this.appendActiveFeedbackRecord(nodeState, record.id);
    }
    nodeState.status = "ready";
    nodeState.manualStartApprovedAt = Date.now();
    nodeState.manualStartApprovedBy = approvedBy;
    nodeState.humanActionSource = null;
    nodeState.error = null;
    nodeState.startedAt = null;
    nodeState.completedAt = null;
    instance.nodeStates[nodeId] = nodeState;
    (await this.withDatabase(() => this.ctx.db.orchInstances.updateNodeStates(instanceId, instance.nodeStates)));
    this.notifyReminderChangedForNodeStatus(instance.workspaceId, previousStatus, "ready");
    (await this.withDatabase(() => this.emitNodeStateChanged(instance, node.id, node.label, "ready")));
    (await this.withDatabase(() => this.updateInstanceStatus(instanceId, "running")));
    (await this.withDatabase(() => this.scheduleActiveRunAfterManualStart(instanceId)));
  }

  /** 跳过等待人工启动的节点，并把实例重新交给 DAG 调度。 */
  async skipWaitingNode(instanceId: OrchestrationId, nodeId: string, actorUserId?: string | null): Promise<void> {
    const instance = await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    if (this.isTerminalInstanceStatus(instance.status) || instance.status === "paused") {
      throw new Error(`当前编排状态不可跳过节点: ${instance.status}`);
    }
    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) throw new Error(`节点不存在: ${nodeId}`);
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) throw new Error(`节点状态不存在: ${nodeId}`);
    if (nodeState.status !== "waiting-start") {
      throw new Error(`当前节点状态不可跳过: ${nodeState.status}`);
    }
    const recoveryBinding = this.captureCodexRecoveryFenceBinding(nodeState);

    const actor = String(actorUserId ?? "").trim();
    const record = (await this.withDatabase(() => this.ctx.db.orchFeedback.create({
      instanceId,
      nodeId,
      action: "skip",
      source: nodeState.humanActionSource ?? null,
      feedback: actor ? `用户 ${actor} 跳过待启动节点` : "用户跳过待启动节点",
      artifactIds: [],
      createdAt: Date.now(),
    })));
    this.appendFeedbackHistoryRecord(nodeState, record.id);
    this.replaceActiveFeedbackRecords(nodeState, null);
    nodeState.error = null;
    nodeState.startedAt = null;
    nodeState.completedAt = null;
    instance.nodeStates[nodeId] = nodeState;
    (await this.withDatabase(() => this.updateNodeStatus(instanceId, node, instance, "skipped")));
    (await this.withDatabase(() => this.releaseCodexRecoveryFences(instance, recoveryBinding ? [recoveryBinding] : [], "skip-waiting-node")));
    const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId))) ?? instance;
    if (latest.status === "completed" || latest.status === "failed") {
      if (latest.status === "failed") (await this.withDatabase(() => this.emitOrchEvent(latest, "orchestration.completed", { instanceId, status: latest.status })));
      else if (!this.runningInstances.get(instanceId)?.drivePromise) (await this.withDatabase(() => this.emitCompletionEvent(latest, this.runningInstances.get(instanceId))));
      else this.signalCoordinator(this.runningInstances.get(instanceId)!);
      return;
    }
    (await this.withDatabase(() => this.scheduleReadyNodeBatchesAfterWaitingSkip(instanceId)));
  }

  /** 中断暂停实例里的活跃角色节点，并记录恢复时需要注入的系统补充。 */
  private async pauseActiveRoleNodesForResume(
    instanceId: OrchestrationId,
    instance: OrchestrationInstance,
    reason: string,
  ): Promise<string[]> {
    const runningByThread = (await this.withDatabase(() => this.ctx.db.turns.listRunningByWorkspace(instance.workspaceId)));
    const pausedNodeIds: string[] = [];

    for (const node of instance.workflowSnapshot.nodes) {
      if (node.type !== "role") continue;
      const nodeState = instance.nodeStates[node.id];
      if (!nodeState || !this.isInterruptibleNodeExecutionStatus(nodeState.status)) continue;

      const threadId = nodeState.threadId ?? null;
      const runningTurnId = threadId ? runningByThread[threadId]?.runningTurnId ?? null : null;
      if (threadId && runningTurnId) {
        await this.ctx.sessions.interrupt(threadId as ThreadId, runningTurnId);
      }
      (await this.withDatabase(() => this.markNodeReadyAfterPause(instanceId, node, instance, reason, Boolean(threadId))));
      pausedNodeIds.push(node.id);
    }

    return pausedNodeIds;
  }

  /** 立即补齐唯一终态，同时把 provider 裁决交给原取消 owner 等待。 */
  private interruptRunningTurnForCancel(instance: OrchestrationInstance, threadId: ThreadId, turnId: TurnId, pending?: Promise<unknown>[]): void {
    const interrupted = Promise.resolve().then(() => this.ctx.sessions.interrupt(threadId, turnId)).then(result => {
      if (result === false && this.ctx.sessions.getActiveTurnId?.(threadId)) {
        throw Object.assign(new Error("编排会话中断未确认"), { code: "ORCHESTRATION_INTERRUPT_UNCONFIRMED", instanceId: instance.id, threadId, turnId });
      }
    }, error => {
      throw Object.assign(new Error("ORCHESTRATION_TURN_INTERRUPT_FAILED", { cause: error }), {
        code: "ORCHESTRATION_TURN_INTERRUPT_FAILED", instanceId: instance.id, threadId, turnId,
      });
    });
    pending?.push(interrupted);
    if (!this.isTurnStillStarted(turnId)) return;
    const endedAt = Date.now();
    this.ctx.emitConversation(createTurnErrorEventInput({
      ts: endedAt,
      workspaceId: instance.workspaceId,
      threadId,
      engine: this.ctx.db.threads.get(threadId)?.engine ?? "codex",
      turnId,
      error: "turn interrupted",
      code: MANUAL_TURN_INTERRUPT_CODE,
      terminationKind: "manual_interrupt",
    }));
    // 同步索引已建立终态时保留序号，仅补齐仍未结算的 turn。
    if (this.isTurnStillStarted(turnId)) this.ctx.db.turns.setEnded(turnId, { status: "error", endedAt, endEventSeq: null });
  }

  /** 判断 turn 是否仍可写终态；手动中断可能已经先行补齐 terminal。 */
  private isTurnStillStarted(turnId: TurnId): boolean {
    const existing = this.ctx.db.turns.get(turnId);
    return !existing || existing.status === "started";
  }

  /** 启动时收敛旧版本遗留的 paused + running 节点，避免暂停实例永久卡住。 */
  private normalizePausedInstanceActiveNodes(instanceId: OrchestrationId, instance: OrchestrationInstance): void {
    for (const node of instance.workflowSnapshot.nodes) {
      if (node.type !== "role") continue;
      const nodeState = instance.nodeStates[node.id];
      if (!nodeState || !this.isInterruptibleNodeExecutionStatus(nodeState.status)) continue;
      this.markNodeReadyAfterPause(
        instanceId,
        node,
        instance,
        "CodeFlow 启动时发现暂停流程仍有执行中节点，已按暂停恢复点处理；恢复流程后将沿用本线程上下文继续执行。",
        Boolean(nodeState.threadId),
      );
    }
  }

  /** 将被暂停打断的节点放回 ready，并用系统反馈保证恢复时走继续当前节点语义。 */
  private markNodeReadyAfterPause(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    reason: string,
    createContinuationFeedback: boolean,
  ): void {
    const latest = this.ctx.db.orchInstances.get(instanceId) ?? instance;
    const nodeState = latest.nodeStates[node.id];
    if (!nodeState) return;

    const previousStatus = nodeState.status ?? null;
    const parentExecutionId = this.resolveNodeAttemptId(nodeState);
    this.ctx.db.orchNodeAttempts.invalidateActiveByNode(instanceId, node.id, reason);
    if (createContinuationFeedback) {
      const record = this.createSystemFeedbackRecord(instanceId, node.id, "system_human_input", {
        feedback: reason,
        artifactIds: nodeState.inputArtifactIds ?? null,
      });
      this.appendFeedbackHistoryRecord(nodeState, record.id);
      this.appendActiveFeedbackRecord(nodeState, record.id);
    }

    nodeState.status = "ready";
    nodeState.attemptId = null;
    nodeState.nodeExecutionId = null;
    nodeState.submissionId = null;
    nodeState.parentExecutionId = parentExecutionId;
    nodeState.humanActionSource = null;
    nodeState.error = null;
    nodeState.startedAt = null;
    nodeState.completedAt = null;
    latest.nodeStates[node.id] = nodeState;
    this.ctx.db.orchInstances.updateNodeStates(instanceId, latest.nodeStates);
    this.notifyReminderChangedForNodeStatus(latest.workspaceId, previousStatus, "ready");
    this.emitNodeStateChanged(latest, node.id, node.label, "ready");
  }

  /** 判断节点状态是否代表当前可能有 in-flight 执行需要暂停收敛。 */
  private isInterruptibleNodeExecutionStatus(status: NodeExecutionStatus): boolean {
    return status === "queued"
      || status === "running";
  }

  /**
   * 把节点置为"异常中断待反馈"态：waiting-feedback + humanActionSource=execution + 发出 feedbackRequested 事件。
   * 与 applyRoleFailurePolicy 的 wait-feedback 分支等价，但不吃 node.failPolicy —— 手动中断必须走恢复路径。
   */
  private markNodeAsExecutionInterrupted(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    reason: string,
  ): void {
    this.ctx.db.orchNodeAttempts.invalidateActiveByNode(instanceId, node.id, reason);
    this.updateNodeStatus(instanceId, node, instance, "waiting-feedback", {
      error: reason,
      humanActionSource: "execution",
    });
    this.emitOrchEvent(instance, "orchestration.feedbackRequested", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      source: "execution",
      gateResults: null,
      reason,
    });
  }

  /** 等待 live 中断及节点/资源结果；detached provider 须由调用方先走精确 turn 补偿。 */
  async cancelAndWait(instanceId: OrchestrationId, options: { requestId?: string } = {}): Promise<void> {
    let synchronousFailure: unknown;
    let hasSynchronousFailure = false;
    try { if (this.cancellationPromises.get(instanceId)?.result?.status !== "rejected") await this.withDatabase(() => this.cancel(instanceId, options)); }
    catch (error) {
      // 已登记 owner 会保留同步失败；只有 owner 创建前的异常需要本调用补交。
      if (!this.cancellationPromises.has(instanceId)) { synchronousFailure = error; hasSynchronousFailure = true; }
    }
    const pending = this.cancellationPromises.get(instanceId);
    try {
      const result = pending ? await pending.promise : null;
      if (result?.status === "rejected") {
        if (hasSynchronousFailure) throw new AggregateError([synchronousFailure, result.reason], "ORCHESTRATION_CANCEL_FAILED");
        throw result.reason;
      }
      if (hasSynchronousFailure) throw synchronousFailure;
    } finally {
      if (this.cancellationPromises.get(instanceId) === pending) this.cancellationPromises.delete(instanceId);
    }
  }

  /** 同步 cancel 的异步失败保留可等待失败态，避免未处理拒绝或仅日志后丢失。 */
  private trackCancellation(instanceId: OrchestrationId, pending: Promise<unknown>[], requestId: string): void {
    const owner: CancellationOwner = { promise: undefined! };
    owner.promise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(pending);
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      let failures = rejected.slice();
      if (!failures.length) {
        owner.result = { status: "fulfilled", value: undefined };
        if (this.cancellationPromises.get(instanceId) === owner) this.cancellationPromises.delete(instanceId);
        return owner.result;
      }
      try {
        failures = rejected.map(error => {
          if (error === null || (typeof error !== "object" && typeof error !== "function")) return error;
          const code = Object.getOwnPropertyDescriptor(error, "code"), cause = Object.getOwnPropertyDescriptor(error, "cause");
          return code && "value" in code && code.value === "ORCHESTRATION_TURN_INTERRUPT_FAILED" && cause && "value" in cause ? cause.value : error;
        });
        await this.withDatabase(() => this.writeLifecycleLog(instanceId, "orchestration cancellation failed", "ORCHESTRATION_CANCEL_FAILED", "cancel", { requestId }, undefined,
          describe => rejected.slice(0, 10).map(error => describe(error))));
      } catch (logError) {
        if (OrchestrationWorkspaceLogFailure.is(logError)) failures.push(...logError.errors);
        else failures.push(logError);
        owner.result = { status: "rejected", reason: new OrchestrationWorkspaceLogFailure(failures, failures[0], "ORCHESTRATION_CANCEL_FAILED") };
        return owner.result;
      }
      owner.result = { status: "rejected", reason: failures.length === 1 ? failures[0] : new AggregateError(failures, "ORCHESTRATION_CANCEL_FAILED", { cause: failures[0] }) };
      return owner.result;
    });
    this.cancellationPromises.set(instanceId, owner);
  }

  /** 只校验人工重跑范围，不修改实例、会话、运行覆盖或产物。 */
  validateRerunFromNodeScope(
    instanceId: OrchestrationId,
    targetNodeId: string,
    rerunNodeIds: string[] | null,
  ): void {
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    this.resolveRerunNodeIds(instance, String(targetNodeId ?? "").trim(), rerunNodeIds);
  }

  /**
   * 用户主动「从指定节点重跑」：刹停当前运行 → 重置明确影响集为 pending → resume 拉起调度。
   * 与 submitFeedback("rework_to_target") 的区别：
   * - 不依赖节点处于 waiting-approval/waiting-feedback 状态，任意非 start/end/parallel/condition 的 role 节点均可发起。
   * - 不走 reworkPolicy.allowedTargetNodeIds 权限约束，这是运维干预而非业务驳回。
   * - 可选 note/images：非空时写入 system_rework feedback，下轮 prompt 注入。
   */
  async rerunFromNode(
    instanceId: OrchestrationId,
    targetNodeId: string,
    input?: {
      note?: string | null;
      images?: string[] | null;
      threadReusePolicy?: NodeThreadReusePolicy | null;
      downstreamThreadReusePolicy?: DownstreamThreadReusePolicy | null;
      rerunNodeIds?: string[] | null;
      applyLatestWorkItemPolicy?: boolean | null;
    },
  ): Promise<void> {
    const initialControlVersion = this.getInstanceControlVersion(instanceId);
    const initial = await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    await this.withDatabase(() => this.ctx.assertWorkspaceWriteAvailable?.(initial.workspaceId, instanceId));
    if (this.getInstanceControlVersion(instanceId) !== initialControlVersion) {
      throw new Error("从指定节点重跑已被后续暂停或取消终止");
    }

    const normalizedTargetNodeId = String(targetNodeId ?? "").trim();
    if (!normalizedTargetNodeId) throw new Error("从指定节点重跑时必须提供 targetNodeId");
    const targetNode = initial.workflowSnapshot.nodes.find((item) => item.id === normalizedTargetNodeId) ?? null;
    if (!targetNode) throw new Error(`节点不存在: ${normalizedTargetNodeId}`);
    if (targetNode.type !== "role") {
      throw new Error(`仅 role 节点支持重跑，当前节点类型: ${targetNode.type}`);
    }

    const affectedNodeIds = this.resolveRerunNodeIds(initial, normalizedTargetNodeId, input?.rerunNodeIds ?? null);
    const latestWorkItemPolicySync = input?.applyLatestWorkItemPolicy === true
      ? (await this.withDatabase(() => this.resolveLatestWorkItemPoliciesForRerun(initial, affectedNodeIds)))
      : null;
    const note = String(input?.note ?? "").trim();
    const images = normalizeFeedbackImages(input?.images);
    const reason = note || "用户从此节点重跑";
    (await this.withDatabase(() => this.assertFeedbackContextBudgetForAppend(initial, normalizedTargetNodeId, { feedback: reason, images }, "当前重跑说明")));

    this.advanceInstanceControlVersion(instanceId);
    const rerunControlVersion = this.getInstanceControlVersion(instanceId);
    await this.interruptAffectedNodesForRerun(initial, affectedNodeIds);
    if (this.getInstanceControlVersion(instanceId) !== rerunControlVersion) {
      throw new Error("从指定节点重跑已被后续暂停或取消终止");
    }

    let instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);

    if (latestWorkItemPolicySync) {
      const runtimeConfig = {
        ...(instance.runtimeConfig ?? {}),
        nodeWorkItemPolicyOverrides: {
          ...(instance.runtimeConfig?.nodeWorkItemPolicyOverrides ?? {}),
          ...latestWorkItemPolicySync.policies,
        },
      };
      (await this.withDatabase(() => this.ctx.db.orchInstances.updateRuntimeConfig(instanceId, runtimeConfig)));
      instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
      if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
      (await this.withDatabase(() => this.emitOrchEvent(instance!, "orchestration.nodeWorkItemPoliciesUpdated", {
        instanceId,
        targetNodeId: normalizedTargetNodeId,
        source: "rerun_from_node",
        workflowId: instance!.workflowId,
        workflowVersion: latestWorkItemPolicySync.workflowVersion,
        workflowUpdatedAt: latestWorkItemPolicySync.workflowUpdatedAt,
        nodeIds: Object.keys(latestWorkItemPolicySync.policies),
      })));
    }

    await this.applyRequestedRework(instanceId, targetNode, instance, {
      targetNodeId: normalizedTargetNodeId,
      reason,
      images: images.length ? images : null,
      sourceArtifactIds: [],
      threadReusePolicy: input?.threadReusePolicy ?? "reuse-existing",
      downstreamThreadReusePolicy: input?.downstreamThreadReusePolicy ?? "preserve-existing",
      useDeclaredImpact: false,
      affectedNodeIds,
    });
    if (this.getInstanceControlVersion(instanceId) !== rerunControlVersion) {
      throw new Error("从指定节点重跑已被后续暂停或取消终止");
    }

    const reopened = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!reopened) throw new Error(`编排实例不存在: ${instanceId}`);
    if (this.isTerminalInstanceStatus(reopened.status)) {
      (await this.withDatabase(() => this.updateInstanceStatus(instanceId, "pending")));
    }
    await this.resumeInBackground(instanceId);
  }

  /** 读取同一工作流的当前定义，并只提取重跑范围内结构兼容的工作项策略。 */
  private resolveLatestWorkItemPoliciesForRerun(
    instance: OrchestrationInstance,
    affectedNodeIds: Set<string>,
  ): { policies: Record<string, NodeWorkItemPolicy>; workflowVersion: number; workflowUpdatedAt: number } {
    const liveWorkflow = this.ctx.db.orchWorkflows.get(instance.workflowId);
    if (!liveWorkflow) throw new Error(`当前工作区缺少实例对应的工作流，不能同步工作项策略：${instance.workflowId}`);

    const policies: Record<string, NodeWorkItemPolicy> = {};
    for (const snapshotNode of instance.workflowSnapshot.nodes) {
      if (!affectedNodeIds.has(snapshotNode.id) || snapshotNode.workItemPolicy?.mode !== "sequential") continue;
      const liveNode = liveWorkflow.nodes.find((candidate) => candidate.id === snapshotNode.id) ?? null;
      if (!liveNode
        || liveNode.type !== "role"
        || String(liveNode.roleId ?? "") !== String(snapshotNode.roleId ?? "")
        || liveNode.workItemPolicy?.mode !== "sequential") {
        throw new Error(`节点「${snapshotNode.label}」的当前工作项定义与实例快照不兼容，不能自动同步`);
      }
      policies[snapshotNode.id] = cloneNodeWorkItemPolicy(liveNode.workItemPolicy);
    }
    if (Object.keys(policies).length === 0) throw new Error("重跑范围内没有可同步的工作项节点");
    return {
      policies,
      workflowVersion: liveWorkflow.version,
      workflowUpdatedAt: liveWorkflow.updatedAt,
    };
  }

  /** 提交用户反馈；普通重试始终沿用节点当前会话。 */
  async submitFeedback(
    instanceId: OrchestrationId,
    nodeId: string,
    action: FeedbackAction,
    input?: {
      feedback?: string | null;
      images?: string[] | null;
      artifactIds?: ArtifactId[] | null;
      targetNodeId?: string | null;
      executionOverride?: NodeFeedbackExecutionOverride | null;
    },
  ): Promise<void> {
    let instance = await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    let nodeState = instance.nodeStates[nodeId];
    if (!nodeState) throw new Error(`节点不存在: ${nodeId}`);
    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    this.validateFeedbackActionInput(instance, node, nodeState, action, input);
    const recoveryBinding = this.captureCodexRecoveryFenceBinding(nodeState);
    const normalizedArtifactIds = action === "retry" || action === "resume_with_input"
      ? (await this.withDatabase(() => this.resolveRetryBaselineArtifactIds(instance, nodeId, input?.artifactIds ?? null)))
      : (await this.withDatabase(() => this.resolveLatestSelectedArtifactIds(instance, input?.artifactIds ?? null)));
    const feedbackImages = normalizeFeedbackImages(input?.images);
    if (action !== "resume_with_input" && input?.executionOverride != null) {
      throw new Error("节点执行覆盖只允许用于恢复当前节点");
    }
    const executionOverride = action === "resume_with_input"
      ? normalizeNodeFeedbackExecutionOverride(input?.executionOverride)
      : null;
    const propagatesApprovalFeedback = action === "override"
      || (action === "approve" && nodeState.conclusion?.nextAction !== "rework");
    if (node && propagatesApprovalFeedback) {
      (await this.withDatabase(() => this.assertApprovalFeedbackPropagationBudget(instance, node, input?.feedback ?? null, feedbackImages)));
    }

    if (action === "override") {
      const requestedAttemptId = this.resolveNodeAttemptId(nodeState);
      try {
        await this.interruptNodeTurns(instance, nodeId, nodeState, "用户手动完成节点");
        // 中断可能触发会话终态，并行节点也可能完成；必须沿用最新实例进度。
        const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
        const latestNodeState = latest?.nodeStates[nodeId];
        if (!latest || !latestNodeState || this.resolveNodeAttemptId(latestNodeState) !== requestedAttemptId) {
          throw new Error("当前节点执行已变化，本次手动完成未生效，请刷新后重试。");
        }
        instance = latest;
        nodeState = latestNodeState;
      } catch (error) {
        (await this.withDatabase(() => this.writeLifecycleLog(instance, "manual node completion failed before override", "orchestration_manual_completion_failed", "manual_override", {
          code: "orchestration_manual_completion_failed",
          requestId: `manual-override:${instanceId}:${requestedAttemptId ?? nodeId}`,
          instanceId,
          nodeId,
          attemptId: requestedAttemptId,
          threadId: nodeState.threadId ?? null,
          action,
        }, { error })));
        throw error;
      }
    }

    const record = (await this.withDatabase(() => this.ctx.db.orchFeedback.create({
      instanceId,
      nodeId,
      action,
      source: nodeState.humanActionSource ?? null,
      feedback: input?.feedback ?? null,
      images: feedbackImages.length ? feedbackImages : null,
      artifactIds: normalizedArtifactIds,
      executionOverride,
      createdAt: Date.now(),
    })));

    this.appendFeedbackHistoryRecord(nodeState, record.id);
    const nodeLabel = node?.label ?? nodeId;
    let settledNodeStatus: NodeExecutionStatus | null = null;
    let nextAttemptParentExecutionId: string | null | undefined;

    switch (action) {
      case "approve":
        if (node && nodeState.conclusion?.nextAction === "rework") {
          (await this.withDatabase(() => this.approveNodeArtifacts(instance, nodeId, nodeState)));
          await this.applyModelRequestedRework(instanceId, node, instance, nodeState, input?.feedback ?? null, feedbackImages);
          break;
        }
        (await this.withDatabase(() => this.approveNodeArtifacts(instance, nodeId, nodeState)));
        if (node) {
          (await this.withDatabase(() => this.propagateApprovalFeedbackToNextRoleNodes(instanceId, node, instance, nodeState, input?.feedback ?? null, feedbackImages)));
        }
        nodeState.humanActionSource = null;
        nodeState.error = null;
        this.replaceActiveFeedbackRecords(nodeState, null);
        nodeState.status = "completed";
        nodeState.completedAt = Date.now();
        settledNodeStatus = "completed";
        break;
      case "reevaluate_gates": {
        if (!node) throw new Error(`节点不存在: ${nodeId}`);
        const reevaluated = await this.reevaluateAiGatesForExistingArtifact(instanceId, node, instance, nodeState);
        nodeState.gateResults = reevaluated;
        (await this.withDatabase(() => this.ctx.db.orchInstances.updateNodeStates(instanceId, instance.nodeStates)));
        (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.gateResult", {
          instanceId, nodeId, nodeLabel, artifactId: this.resolveLatestNodeOutputArtifacts(instance, nodeId, nodeState)[0]?.id ?? null, results: reevaluated,
        })));
        if (hasBlockingFailure(reevaluated, this.resolveSnapshotRoleDefinitionForAttempt(instance, node.roleId as RoleId).gateCriteria)) {
          nodeState.humanActionSource = "gate";
          nodeState.status = "waiting-feedback";
          settledNodeStatus = "waiting-feedback";
        } else {
          (await this.withDatabase(() => this.approveNodeArtifacts(instance, nodeId, nodeState)));
          nodeState.humanActionSource = null;
          nodeState.error = null;
          this.replaceActiveFeedbackRecords(nodeState, null);
          nodeState.status = "completed";
          nodeState.completedAt = Date.now();
          settledNodeStatus = "completed";
        }
        break;
      }
      case "retry": {
        (await this.withDatabase(() => this.rejectNodeArtifacts(instance, nodeId, nodeState)));
        const retryParentExecutionId = this.resolveNodeAttemptId(nodeState);
        const reopenedWorkItemSummary = node && nodeState.status === "waiting-approval"
          ? (await this.withDatabase(() => this.reopenCurrentNodeWorkItemsForManualRetry(instance, node, input?.feedback ?? "用户驳回并重新执行当前节点", retryParentExecutionId)))
          : null;
        (await this.withDatabase(() => this.finishNodeAttempt(instance, nodeId, nodeLabel, nodeState, "cancelled", input?.feedback || "用户要求重试")));
        this.resetNodeForRetry(nodeState, [record.id]);
        nodeState.status = "ready";
        nodeState.retryCount += 1;
        nodeState.inputArtifactIds = normalizedArtifactIds ?? nodeState.inputArtifactIds ?? null;
        if (reopenedWorkItemSummary) nodeState.workItemSummary = reopenedWorkItemSummary;
        if (!node) throw new Error(`节点不存在: ${nodeId}`);
        nextAttemptParentExecutionId = retryParentExecutionId;
        settledNodeStatus = "ready";
        break;
      }
      case "override":
        (await this.withDatabase(() => this.approveNodeArtifacts(instance, nodeId, nodeState)));
        this.applyHumanConclusionOverride(nodeState, input?.feedback ?? null);
        if (node) {
          (await this.withDatabase(() => this.propagateApprovalFeedbackToNextRoleNodes(instanceId, node, instance, nodeState, input?.feedback ?? null, feedbackImages)));
        }
        nodeState.humanActionSource = null;
        this.replaceActiveFeedbackRecords(nodeState, null);
        nodeState.status = "completed";
        nodeState.completedAt = Date.now();
        settledNodeStatus = "completed";
        break;
      case "choose_branch": {
        if (!node) {
          throw new Error(`节点不存在: ${nodeId}`);
        }
        const selection = this.resolveConditionBranchSelection(instance, node, String(input?.targetNodeId ?? "").trim());
        (await this.withDatabase(() => this.applyConditionBranchChoice(
          instanceId,
          node,
          instance,
          nodeState,
          selection.branchTaken,
          selection.branchLabel,
          input?.feedback ?? null,
        )));
        settledNodeStatus = "completed";
        break;
      }
      case "rework_to_target": {
        if (!node) {
          throw new Error(`节点不存在: ${nodeId}`);
        }
        (await this.withDatabase(() => this.approveNodeArtifacts(instance, nodeId, nodeState)));
        const sourceArtifactIds = normalizedArtifactIds?.length
          ? normalizedArtifactIds
          : (await this.withDatabase(() => this.resolveLatestNodeOutputArtifacts(instance, node.id, nodeState))).map((artifact) => artifact.id);
        await this.applyRequestedRework(instanceId, node, instance, {
          targetNodeId: String(input?.targetNodeId ?? "").trim(),
          reason: String(input?.feedback ?? "").trim(),
          images: feedbackImages,
          sourceArtifactIds,
        });
        this.replaceActiveFeedbackRecords(nodeState, null);
        break;
      }
      case "skip":
        (await this.withDatabase(() => this.rejectNodeArtifacts(instance, nodeId, nodeState)));
        this.clearNodeFailureState(nodeState);
        this.replaceActiveFeedbackRecords(nodeState, null);
        nodeState.status = "skipped";
        nodeState.completedAt = Date.now();
        settledNodeStatus = "skipped";
        break;
      case "resume_with_input": {
        (await this.withDatabase(() => this.rejectNodeArtifacts(instance, nodeId, nodeState)));
        const resumeParentExecutionId = this.resolveNodeAttemptId(nodeState);
        const reopenedWorkItemSummary = node && nodeState.status === "waiting-approval"
          ? (await this.withDatabase(() => this.reopenCurrentNodeWorkItemsForManualRetry(instance, node, input?.feedback ?? "用户补充意见并重新执行当前节点", resumeParentExecutionId)))
          : null;
        this.resetNodeForRetry(nodeState, [record.id]);
        nodeState.status = "ready";
        nodeState.inputArtifactIds = normalizedArtifactIds ?? nodeState.inputArtifactIds ?? null;
        if (reopenedWorkItemSummary) nodeState.workItemSummary = reopenedWorkItemSummary;
        if (!node) throw new Error(`节点不存在: ${nodeId}`);
        nextAttemptParentExecutionId = resumeParentExecutionId;
        settledNodeStatus = "ready";
        break;
      }
      case "cancel":
      case "abort":
        nodeState.humanActionSource = null;
        this.replaceActiveFeedbackRecords(nodeState, null);
        nodeState.status = "failed";
        nodeState.error = input?.feedback || "用户终止";
        nodeState.completedAt = Date.now();
        settledNodeStatus = "failed";
        break;
      default:
        throw new Error(`不支持的反馈动作: ${String(action)}`);
    }

    instance.nodeStates[nodeId] = nodeState;
    (await this.withDatabase(() => this.ctx.db.orchInstances.updateNodeStates(instanceId, instance.nodeStates)));
    if (action === "cancel" || action === "abort") {
      (await this.withDatabase(() => this.updateInstanceStatus(instanceId, "failed")));
    }
    if (settledNodeStatus
      && recoveryBinding
      && (settledNodeStatus === "completed" || settledNodeStatus === "failed" || settledNodeStatus === "skipped")) {
      try { (await this.withDatabase(() => this.releaseCodexRecoveryFences(instance, [recoveryBinding], `feedback-${action}`))); }
      catch (error) {
        // 终止事实已提交；诊断拒绝仍必须归原 owner 完成必要释放，停止后续推进。
        if (action === "cancel" || action === "abort") (await this.withDatabase(() => this.disposeManagedRuntimeInBackground(instanceId, `feedback_${action}`, { error })));
        throw error;
      }
    }
    if (nextAttemptParentExecutionId !== undefined && node) {
      (await this.withDatabase(() => this.beginNodeAttempt(instanceId, node, instance, nextAttemptParentExecutionId)));
    }
    (await this.withDatabase(() => this.syncInstanceRuntimeStatus(instanceId, instance)));
    if (settledNodeStatus) {
      (await this.withDatabase(() => this.emitNodeStateChanged(instance, nodeId, nodeLabel, settledNodeStatus)));
    }
    if (action === "cancel" || action === "abort") {
      (await this.withDatabase(() => this.disposeManagedRuntimeInBackground(instanceId, `feedback_${action}`)));
    }
    if (instance.status === "paused" && (action === "retry" || action === "resume_with_input")) {
      await this.resumeInBackground(instanceId);
    } else {
      (await this.withDatabase(() => this.scheduleActiveRunAfterFeedback(instanceId)));
    }
  }

  /** 复用已有 Artifact 重新评估 AI 门禁，不重跑产出节点。 */
  private async reevaluateAiGatesForExistingArtifact(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    nodeState: NodeExecutionState,
  ): Promise<GateResult[]> {
    const role = this.resolveSnapshotRoleDefinitionForAttempt(instance, node.roleId as RoleId);
    const aiCriteria = role.gateCriteria.filter((criterion) => criterion.type === "ai");
    const artifact = (await this.withDatabase(() => this.resolveLatestNodeOutputArtifacts(instance, node.id, nodeState)))[0] ?? null;
    if (!artifact) throw new Error("当前节点没有可重新评估的产物");
    const text = this.extractArtifactText(artifact);
    const snapshot = (await this.withDatabase(() => this.ctx.db.orchPromptSnapshots.listByNode(instanceId, node.id, { includeContent: true }).slice(-1)))[0] ?? null;
    if (!snapshot) throw new Error("当前节点缺少 Prompt Snapshot，无法重新评估门禁");
    const evaluationRunId = `gate-run-${crypto.randomUUID()}`;
    let results: GateResult[];
    try {
      const evaluation = await this.aiGateEvaluationService.evaluate({
        requestId: `gate-reevaluate-${crypto.randomUUID()}`,
        evaluationRunId,
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        nodeAttemptId: this.resolveNodeAttemptId(nodeState) ?? `attempt-${crypto.randomUUID()}`,
        artifactId: artifact.id,
        workspaceId: instance.workspaceId,
        criteria: aiCriteria,
        artifactSources: [{
          sourceId: "artifact-body",
          path: null,
          text,
          sha256: crypto.createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex"),
        }],
        engine: snapshot.engine,
        model: snapshot.model ?? null,
        effort: snapshot.effort ?? null,
        accessMode: "read-only",
        contextWindow: snapshot.runtimePolicy.contextWindow ?? null,
        autoCompactPct: snapshot.runtimePolicy.autoCompactPct ?? null,
        prompt: {
          promptEnvelope: snapshot.promptEnvelope,
          runtimePolicy: { ...snapshot.runtimePolicy, accessMode: "read-only", toolRuntimePolicy: { allowedToolIds: ["orchestration.submit_gate_evaluation"], requiresWorkspaceWrite: false } },
          artifactInput: { artifacts: [], fieldBindings: {} },
          knowledgeCatalogs: [],
          knowledgeWarnings: [],
          systemMessage: "你是独立的 AI 文本门禁评估器。",
          developerMessage: "只读评估现有 Artifact，不得生成或修改产物。",
        },
        forceNewCall: true,
      });
      results = evaluation.results;
    } catch (error) {
      if (error instanceof Error && "code" in error && String((error as { code?: unknown }).code) === "AI_GATE_CANCELLED") throw error;
      const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "AI_GATE_EVALUATION_FAILED") : "AI_GATE_EVALUATION_FAILED";
      const evaluationError = error as { evaluationRunId?: string; evaluationCallId?: string; threadId?: ThreadId | null; turnId?: TurnId | null; promptSnapshotId?: string | null };
      results = aiCriteria.map((criterion) => ({
        criterionId: criterion.id,
        passed: false,
        message: error instanceof Error ? error.message : String(error),
        outcome: "error" as const,
        evaluatorKind: "ai" as const,
        errorCode: code,
        evaluationRunId: evaluationError.evaluationRunId ?? evaluationRunId,
        evaluationCallId: evaluationError.evaluationCallId ?? null,
        evaluationThreadId: evaluationError.threadId ?? null,
        evaluationTurnId: evaluationError.turnId ?? null,
        promptSnapshotId: evaluationError.promptSnapshotId ?? snapshot.id,
      }));
    }
    const deterministic = await evaluateGates(text, role.gateCriteria.filter((criterion) => criterion.type !== "ai"));
    return [...deterministic, ...results];
  }

  reviseArtifact(
    instanceId: OrchestrationId,
    nodeId: string,
    artifactId: ArtifactId,
    input: {
      note?: string | null;
      answer: NodeExecutionEnvelope;
    },
  ): Artifact {
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    this.requireAssetRuntimeSnapshot(instance);

    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) throw new Error(`节点不存在: ${nodeId}`);
    if (nodeState.status !== "waiting-approval" && nodeState.status !== "waiting-feedback") {
      throw new Error("只有等待人工审核或处理的节点，才能人工修订产出物");
    }

    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) throw new Error(`节点不存在: ${nodeId}`);

    const artifact = this.ctx.db.orchArtifacts.get(artifactId);
    if (!artifact || artifact.instanceId !== instanceId || artifact.nodeId !== nodeId) {
      throw new Error(`工件不存在：${artifactId}`);
    }
    if (artifact.status === "rejected" || artifact.status === "superseded") {
      throw new Error("当前工件已经失效，不能继续修订");
    }

    const nextVersion = this.ctx.db.orchArtifacts
      .listByNode(instance.id, nodeId)
      .filter((item) => item.kind === artifact.kind)
      .length + 1;
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    const persistence = new ArtifactPersistenceService({ db: this.ctx.db, workspacePath, workspaceId: instance.workspaceId, workspacePathIndex: this.ctx.workspacePathIndex });
    if (!node.roleId) throw new Error(`节点 ${node.label} 缺少角色配置，不能修订产出物`);
    const role = this.resolveSnapshotRoleDefinitionForAttempt(instance, node.roleId as RoleId);
    const revisionResult = this.buildHumanRevisionFinalAnswer(input.answer);
    this.validateFinalAnswerSemantics(instance, node, role, revisionResult);
    const contractValidation = this.validateNodeResultContract(instance, node, role, revisionResult);
    if (!contractValidation.accepted) {
      throw new Error(this.buildNodeResultContractRecoveryMessage(contractValidation, this.buildNodeResultSubmissionToolContext(node, role)));
    }
    const revised = persistence.createRevision({
      basedOn: artifact,
      nodeLabel: node.label,
      version: nextVersion,
      envelope: contractValidation.normalizedAnswer,
      threadId: String(nodeState.threadId ?? ""),
      roleId: String(node.roleId ?? ""),
      note: input.note ?? null,
      contractValidation,
      metadata: {
        nodeResult: {
          completion: contractValidation.completion,
          nextAction: revisionResult.control.nextAction,
          validationStatus: this.resolveNodeResultValidationStatus(contractValidation),
          validationReport: toNodeResultValidationReport(contractValidation),
          consumable: contractValidation.consumable,
          contractVersion: contractValidation.contractVersion,
        },
      },
    });
    this.persistNodeResultFields(revised, instance, node, artifact.kind, contractValidation);

    const feedbackRecord = this.ctx.db.orchFeedback.create({
      instanceId,
      nodeId,
      action: "human_artifact_edit",
      feedback: String(input.note ?? "").trim() || "人工修订了当前产出物，请以后续最新版本为准。",
      artifactIds: [revised.id],
      createdAt: Date.now(),
    });

    nodeState.outputArtifactIds = Array.from(new Set([...(nodeState.outputArtifactIds ?? []), revised.id]));
    this.appendFeedbackHistoryRecord(nodeState, feedbackRecord.id);
    this.replaceActiveFeedbackRecords(nodeState, [feedbackRecord.id]);
    instance.nodeStates[nodeId] = nodeState;
    this.ctx.db.orchInstances.updateNodeStates(instanceId, instance.nodeStates);

    const artifactIndex = { ...(instance.artifactIndex ?? {}) };
    artifactIndex[nodeId] = [...(artifactIndex[nodeId] ?? []), revised.id];
    instance.artifactIndex = artifactIndex;
    this.ctx.db.orchInstances.updateArtifactIndex(instance.id, artifactIndex);

    this.emitOrchEvent(instance, "orchestration.artifactWritten", {
      instanceId,
      nodeId,
      nodeLabel: node.label,
      artifactId: revised.id,
      artifactKind: revised.kind,
      payloadMode: revised.payloadMode ?? null,
      persistenceMode: revised.persistenceMode ?? null,
    });
    if (revised.workspaceStatus && revised.workspaceStatus !== "none") {
      this.emitOrchEvent(instance, "orchestration.artifactWorkspaceWritten", {
        instanceId: instance.id,
        nodeId,
        nodeLabel: node.label,
        artifactId: revised.id,
        workspaceStatus: revised.workspaceStatus,
        stagingPath: revised.stagingPath ?? null,
        publishedPath: revised.publishedPath ?? null,
        fileCount: this.ctx.db.orchArtifactFiles.listByArtifact(revised.id).length,
      });
    }
    const revisionPayload = this.buildArtifactRevisedEventPayload(instance, nodeId, node.label, nodeState, artifact, revised, input);
    this.emitOrchEvent(instance, "orchestration.artifactRevised", revisionPayload);
    this.emitArtifactRevisionConversationEvent(instance, nodeState.threadId ?? null, revisionPayload);

    return revised;
  }

  // ── DAG Execution ──────────────────────────────────────────────

  private async executeDAG(instanceId: OrchestrationId, runId: string): Promise<void> {
    await this.executeReadyNodeBatches(instanceId, runId, { resolveIdleOutcome: true });
  }

  /** 单协调器循环；控制态退出先收已启动节点，将本片诊断交回原协调器。 */
  private async executeReadyNodeBatches(
    instanceId: OrchestrationId,
    runId: string,
    options: { resolveIdleOutcome: boolean },
  ): Promise<void> {
    const controlState = this.runningInstances.get(instanceId);
    if (!controlState || controlState.runId !== runId) return;
    const activeNodePromises = this.ensureActiveNodePromises(controlState);

    while (true) {
      const { controlExit, instance } = await this.withDatabase(() => {
      const controlExit = this.stopping || this.runningInstances.get(instanceId) !== controlState
        || controlState.runId !== runId || controlState.cancelled || controlState.paused;
      const instance = controlExit ? null : this.ctx.db.orchInstances.get(instanceId);
      return { controlExit, instance };
      });
      if (controlExit || !instance || this.isTerminalInstanceStatus(instance.status)) {
        const settled = await Promise.allSettled([...activeNodePromises.values()]);
        const failures: unknown[] = [];
        for (const result of settled) {
          const failure = result.status === "rejected" ? { error: result.reason }
            : isNodeExecutionFailure(result.value) ? { error: result.value.error } : null;
          if (failure) failures.push(failure.error);
        }
        if (failures.some(error => OrchestrationWorkspaceLogFailure.is(error))) {
          if (failures.length === 1) throw failures[0];
          throw new OrchestrationWorkspaceLogFailure(failures, failures[0]);
        }
        for (const error of failures) if (isSkillRuntimeDiagnosticFailure(error)) throw error;
        return;
      }
      if (this.ctx.isTaskAdmissionPaused?.()) {
        const settlement = await Promise.race([
          ...activeNodePromises.values(),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 25)),
        ]);
        if (settlement && isNodeExecutionFailure(settlement)) {
          if (!OrchestrationWorkspaceLogFailure.is(settlement.error)) activeNodePromises.delete(settlement.nodeId);
          throw settlement.error;
        }
        continue;
      }

      const launchedCount = await this.withDatabase(() => this.launchReadyNodes(instanceId, instance, controlState));
      if (launchedCount > 0) continue;

      if (activeNodePromises.size === 0) {
        if (!options.resolveIdleOutcome) return;
        const outcome = this.resolveDagIdleOutcome(instance);
        if (outcome) {
          await this.withDatabase(() => {
          this.updateInstanceStatus(instanceId, outcome);
          if (outcome !== "completed") this.emitOrchEvent(instance, "orchestration.completed", { instanceId, status: outcome });
          });
        }
        return;
      }

      const wakePromise = this.getCoordinatorWakePromise(controlState).then(() => null);
      const settlement = await Promise.race([...activeNodePromises.values(), wakePromise]);
      if (settlement && isNodeExecutionFailure(settlement)) {
        if (!OrchestrationWorkspaceLogFailure.is(settlement.error)) activeNodePromises.delete(settlement.nodeId);
        throw settlement.error;
      }
    }
  }

  /** 为更早的自动反馈失败节点回填 canonical session_invalidated 错误码。 */
  private hydrateAutomaticFeedbackRecoveryError(instance: OrchestrationInstance): void {
    let changed = false;
    for (const nodeState of Object.values(instance.nodeStates)) {
      if (nodeState.errorCode
        || nodeState.status !== "waiting-feedback"
        || nodeState.humanActionSource !== "execution"
        || !(nodeState.activeFeedbackRecordIds?.length)) {
        continue;
      }
      const evidence = this.resolveExactLatestAttemptError(instance.id, nodeState.nodeId, nodeState);
      const metadata = evidence?.metadata ?? null;
      if (metadata?.code !== AUTO_RECOVERABLE_NODE_ERROR_CODE) continue;
      nodeState.errorCode = metadata.code;
      changed = true;
    }
    if (changed) this.ctx.db.orchInstances.updateNodeStates(instance.id, instance.nodeStates);
  }

  /** 把节点会话输入持久化到尚未启动的当前节点，供下一次角色 prompt 首轮读取。 */
  appendPendingNodeInput(
    instanceId: OrchestrationId,
    nodeId: string,
    input: {
      feedback?: string | null;
      images?: string[] | null;
      executionOverride?: NodeFeedbackExecutionOverride | null;
    },
  ): void {
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    if (this.isTerminalInstanceStatus(instance.status)) {
      throw new Error(`当前编排状态不可接收节点输入: ${instance.status}`);
    }
    const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) throw new Error(`节点不存在: ${nodeId}`);
    if (node.type !== "role") throw new Error(`当前节点类型不可接收自由文本: ${node.type}`);
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) throw new Error(`节点状态不存在: ${nodeId}`);
    if (nodeState.status !== "pending" && nodeState.status !== "ready" && nodeState.status !== "queued") {
      throw new Error(`当前节点状态不可追加启动输入: ${nodeState.status}`);
    }

    const feedback = String(input.feedback ?? "").trim();
    const images = normalizeFeedbackImages(input.images);
    const executionOverride = normalizeNodeFeedbackExecutionOverride(input.executionOverride);
    if (!feedback && images.length === 0) throw new Error("节点补充内容为空");
    this.assertFeedbackContextBudgetForAppend(
      instance,
      nodeId,
      { feedback, images },
      `节点「${node.label}」的会话补充`,
    );
    const record = this.createSystemFeedbackRecord(instanceId, nodeId, "system_human_input", {
      feedback,
      images,
      artifactIds: null,
      executionOverride,
    });
    this.appendFeedbackHistoryRecord(nodeState, record.id);
    this.appendActiveFeedbackRecord(nodeState, record.id);
    instance.nodeStates[nodeId] = nodeState;
    this.ctx.db.orchInstances.updateNodeStates(instanceId, instance.nodeStates);
  }

  /** 认领前拒绝既有诊断，避免唤醒先兑现时启动新业务；取消异常仍归原 owner。 */
  private launchReadyNodes(
    instanceId: OrchestrationId,
    instance: OrchestrationInstance,
    controlState: OrchestrationRunState,
  ): number {
    this.assertNoWorkspaceLogFailure(instanceId);
    if (this.stopping || controlState.cancelled || this.ctx.isTaskAdmissionPaused?.()) return 0;
    const { nodes, edges } = instance.workflowSnapshot;
    const readyNodes = this.findReadyNodes(nodes, edges, instance);
    if (readyNodes.length === 0) return 0;

    const launchableNodes: WorkflowNode[] = [];
    for (const node of readyNodes) {
      const nodeState = instance.nodeStates[node.id];
      if (this.shouldWaitForManualStart(instance, node, nodeState)) {
        this.markNodeWaitingStart(instanceId, node, instance);
        continue;
      }
      launchableNodes.push(node);
    }

    const activeNodePromises = this.ensureActiveNodePromises(controlState);
    // 并发闸门：同一实例内同时执行的节点数设上限。串行链不受影响；
    // fork/join 或宽图不会一次性拉起过多引擎回合（每个回合都是一个独立引擎进程/会话）。
    const availableSlots = Math.max(0, MAX_CONCURRENT_NODES_PER_INSTANCE - activeNodePromises.size);
    if (availableSlots === 0) return 0;
    const claimedNodes: WorkflowNode[] = [];
    for (const node of launchableNodes) {
      if (claimedNodes.length >= availableSlots) break;
      if (activeNodePromises.has(node.id)) continue;
      if (this.claimReadyNodeForExecution(instanceId, node, instance)) claimedNodes.push(node);
    }

    for (const node of claimedNodes) {
      const executionInstance = this.ctx.db.orchInstances.get(instanceId) ?? instance;
      let failed = false;
      const promise: OrchestrationWorkPromise<NodeExecutionSettlement> = this.executeNode(instanceId, node, executionInstance)
        .then<NodeExecutionSettlement>(() => ({ nodeId: node.id, failed: false, error: null }))
        .catch<NodeExecutionSettlement>((error) => {
          failed = true;
          if ((this.stopping || controlState.cancelled) && !OrchestrationWorkspaceLogFailure.is(error) && !isSkillRuntimeDiagnosticFailure(error) && !describeOrchestrationProfileFailure(error)) throw error;
          return promise.settlement = { nodeId: node.id, failed: true, error };
        })
        .finally(async () => {
          promise.settled = true;
          // 失败结算保留到协调器消费，避免唤醒先兑现后丢失根因。
          if (!failed) activeNodePromises.delete(node.id);
          this.signalCoordinator(controlState);
          await this.withDatabase(() => this.cleanupSettledRunState(instanceId, controlState));
        });
      activeNodePromises.set(node.id, promise);
    }
    return claimedNodes.length;
  }

  /** 兼容恢复出的旧运行态对象，惰性补齐活动节点 Promise 容器。 */
  private ensureActiveNodePromises(state: OrchestrationRunState): Map<string, Promise<NodeExecutionSettlement>> {
    state.activeNodePromises ??= new Map();
    return state.activeNodePromises;
  }

  /** 返回当前协调器唤醒 Promise；同一等待周期内复用同一个信号。 */
  private getCoordinatorWakePromise(state: OrchestrationRunState): Promise<void> {
    if (state.wakePromise) return state.wakePromise;
    state.wakePromise = new Promise<void>((resolve) => {
      state.wakeResolver = resolve;
    });
    return state.wakePromise;
  }

  /** 唤醒实例协调器；没有等待者时，下一轮扫描本身会读取最新状态。 */
  private signalCoordinator(state: OrchestrationRunState): void {
    const resolve = state.wakeResolver ?? null;
    state.wakeResolver = null;
    state.wakePromise = null;
    resolve?.();
  }

  /** 活动节点晚于协调器结束时补做运行态清理，避免取消路径残留实例句柄。 */
  private cleanupSettledRunState(instanceId: OrchestrationId, state: OrchestrationRunState): void {
    if (state.drivePromise || this.ensureActiveNodePromises(state).size > 0) return;
    const latest = this.ctx.db.orchInstances.get(instanceId);
    if (!latest || this.isTerminalInstanceStatus(latest.status) || state.cancelled) {
      this.runningInstances.delete(instanceId);
    }
  }

  /** 找出所有前驱已完成的就绪节点。 */
  private findReadyNodes(
    nodes: WorkflowNode[],
    edges: WorkflowEdge[],
    instance: OrchestrationInstance,
  ): WorkflowNode[] {
    const ready: WorkflowNode[] = [];
    const nodeStates = instance.nodeStates;

    for (const node of nodes) {
      const state = nodeStates[node.id];
      if (!state || (state.status !== "pending" && state.status !== "ready")) continue;

      // 找到所有入边（前驱节点）
      const inEdges = edges.filter((e) => e.targetNodeId === node.id);
      const activeInEdges = inEdges.filter((edge) => !this.isInactiveConditionEdge(edge, instance));

      if (inEdges.length === 0 && node.type === "start") {
        ready.push(node);
        continue;
      }

      if (activeInEdges.length === 0) continue;

      const allPredecessorsComplete = activeInEdges.every((edge) =>
        this.isReadyPredecessorSettled(edge, instance, new Set([node.id])),
      );

      if (allPredecessorsComplete) {
        ready.push(node);
      }
    }

    return ready;
  }

  /** 判断入边前驱是否已经足以释放目标；已结算桥节点仍需等待本轮被重开的上游。 */
  private isReadyPredecessorSettled(
    edge: WorkflowEdge,
    instance: OrchestrationInstance,
    visitedSettledNodeIds: Set<string>,
  ): boolean {
    const predState = instance.nodeStates[edge.sourceNodeId];
    if (!predState) return false;
    if (predState.status !== "completed" && predState.status !== "skipped") return false;
    return this.areSettledNodeInputsSettled(edge.sourceNodeId, instance, visitedSettledNodeIds);
  }

  /** completed/skipped 节点作为透明桥时，递归确认其有效上游仍处于已结算状态。 */
  private areSettledNodeInputsSettled(
    nodeId: string,
    instance: OrchestrationInstance,
    visitedSettledNodeIds: Set<string>,
  ): boolean {
    if (visitedSettledNodeIds.has(nodeId)) {
      throw new Error(`流程依赖存在循环，无法判断已结算节点是否可释放下游: ${nodeId}`);
    }
    const nextVisited = new Set(visitedSettledNodeIds);
    nextVisited.add(nodeId);
    const inEdges = instance.workflowSnapshot.edges.filter((edge) => edge.targetNodeId === nodeId);
    const activeInEdges = inEdges.filter((edge) => !this.isInactiveConditionEdge(edge, instance));
    if (activeInEdges.length === 0) {
      return inEdges.length === 0 || inEdges.every((edge) => this.isInactiveConditionEdge(edge, instance));
    }
    return activeInEdges.every((edge) => this.isReadyPredecessorSettled(edge, instance, nextVisited));
  }

  /** 执行单个节点。 */
  private async executeNode(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
  ): Promise<void> {
    switch (node.type) {
      case "start":
        await this.withDatabase(() => this.executeStartNode(instanceId, node, instance));
        break;
      case "end":
        await this.withDatabase(() => this.executeEndNode(instanceId, node, instance));
        break;
      case "role":
        await this.executeRoleNode(instanceId, node, instance);
        break;
      case "condition":
        await this.withDatabase(() => this.executeConditionNode(instanceId, node, instance));
        break;
      case "parallel-fork":
        await this.withDatabase(() => this.executeForkNode(instanceId, node, instance));
        break;
      case "parallel-join":
        await this.withDatabase(() => this.executeJoinNode(instanceId, node, instance));
        break;
    }
  }

  /** 控制节点由调度方持同步许可结算，无异步执行。 */
  private executeStartNode(instanceId: OrchestrationId, node: WorkflowNode, instance: OrchestrationInstance): void {
    this.updateNodeStatus(instanceId, node, instance, "completed");
  }

  /** 终点状态在调用方的同一同步许可段持久化。 */
  private executeEndNode(instanceId: OrchestrationId, node: WorkflowNode, instance: OrchestrationInstance): void {
    this.updateNodeStatus(instanceId, node, instance, "completed");
  }

  /** 分支派发只写当前控制节点，由调用方授予许可。 */
  private executeForkNode(instanceId: OrchestrationId, node: WorkflowNode, instance: OrchestrationInstance): void {
    // parallel-fork：直接完成，让所有后继同时变为就绪
    this.updateNodeStatus(instanceId, node, instance, "completed");
  }

  /** 汇合条件已由调度器确认，仅同步结算节点。 */
  private executeJoinNode(instanceId: OrchestrationId, node: WorkflowNode, instance: OrchestrationInstance): void {
    // parallel-join：等待所有前驱完成后才执行到这里
    this.updateNodeStatus(instanceId, node, instance, "completed");
  }

  /** 执行条件节点；自动模式立即写入分支，人工模式停在分支选择反馈态。 */
  private executeConditionNode(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
  ): void {
    this.updateNodeStatus(instanceId, node, instance, "running");

    const conditionExpr = node.conditionExpr ?? "";
    const outEdges = instance.workflowSnapshot.edges.filter((e) => e.sourceNodeId === node.id);
    if (this.resolveConditionDecisionMode(node) === "manual") {
      const rememberedBranchTaken = this.resolveRememberedManualConditionBranch(instance, node, outEdges);
      if (rememberedBranchTaken) {
        this.completeConditionNodeWithBranch(instanceId, node, instance, rememberedBranchTaken);
        return;
      }
      this.markConditionNodeWaitingBranchDecision(instanceId, node, instance, outEdges);
      return;
    }

    let branchTaken: string;
    try {
      branchTaken = this.evaluateAutomaticConditionBranch(node, instance, outEdges, conditionExpr);
    } catch (error) {
      this.failConditionNode(instanceId, node, instance, error);
      return;
    }

    this.completeConditionNodeWithBranch(instanceId, node, instance, branchTaken);
  }

  /** 读取条件节点决策方式；缺省保持自动判断以兼容历史流程。 */
  private resolveConditionDecisionMode(node: WorkflowNode): "auto" | "manual" {
    return node.type === "condition" && node.conditionDecisionMode === "manual" ? "manual" : "auto";
  }

  /** 自动条件节点不解析自然语言条件，避免关键词误分支；未实现表达式引擎前沿用默认分支。 */
  private evaluateAutomaticConditionBranch(
    node: WorkflowNode,
    instance: OrchestrationInstance,
    outEdges: WorkflowEdge[],
    conditionExpr: string,
  ): string {
    const firstEdge = outEdges[0] ?? null;
    const branchTaken = firstEdge ? this.resolveConditionEdgeSelectionKey(firstEdge) : "default";
    void node;
    void instance;
    void conditionExpr;
    return branchTaken;
  }

  /** 人工条件重跑时沿用已保存的唯一分支选择，避免再次询问或恢复未选分支。 */
  private resolveRememberedManualConditionBranch(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    outEdges: WorkflowEdge[],
  ): string | null {
    const branchTaken = String(instance.nodeStates[node.id]?.branchTaken ?? "").trim();
    if (!branchTaken) return null;
    const selectedEdges = outEdges.filter((edge) => this.isConditionEdgeSelected(edge, branchTaken));
    return selectedEdges.length === 1 ? branchTaken : null;
  }

  /** 完成条件节点，并按统一选择键关闭未选条件出边。 */
  private completeConditionNodeWithBranch(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    branchTaken: string,
  ): void {
    const nodeState = instance.nodeStates[node.id];
    if (nodeState) {
      nodeState.branchTaken = branchTaken;
      nodeState.status = "completed";
      instance.nodeStates[node.id] = nodeState;
      this.persistNodeState(instanceId, instance, node.id);
    }

    this.emitNodeStateChanged(instance, node.id, node.label, "completed");
    this.skipUnselectedConditionBranches(instanceId, node, instance, branchTaken);
  }

  /** 人工条件节点停在分支选择态；没有出边时按流程配置错误显式失败。 */
  private markConditionNodeWaitingBranchDecision(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    outEdges: WorkflowEdge[],
  ): void {
    if (outEdges.length === 0) {
      this.failConditionNode(instanceId, node, instance, new Error(`人工分支节点缺少出边: ${node.id}`));
      return;
    }
    const reason = "等待人工选择分支";
    this.updateNodeStatus(instanceId, node, instance, "waiting-feedback", {
      error: reason,
      humanActionSource: "branch_decision",
    });
    this.emitOrchEvent(instance, "orchestration.feedbackRequested", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      source: "branch_decision",
      reason,
      branchOptions: outEdges.map((edge) => ({
        targetNodeId: edge.targetNodeId,
        conditionBranch: edge.conditionBranch ?? null,
      })),
    });
  }

  /** 条件节点配置或判断失败时，写入节点失败态并结束本轮实例。 */
  private failConditionNode(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateNodeStatus(instanceId, node, instance, "failed", { error: message });
    this.updateInstanceStatus(instanceId, "failed");
    this.emitOrchEvent(instance, "orchestration.error", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      source: "condition",
      error: message,
    });
  }

  /** 沿原 Attempt 准备角色并派发；本片诊断失败先交回协调器收齐尾链。 */
  private async executeRoleNode(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
  ): Promise<void> {
    try {
      // 目录被其它会话占用通常很短暂：先等待其释放，避免节点立刻失败后白等一次更久的重跑。
      if (this.ctx.waitWorkspaceWriteAvailable) {
        await this.ctx.waitWorkspaceWriteAvailable(instance.workspaceId, instanceId, {
          // 引擎正在停止，或本节点被「停止节点」取消时，立即结束等待。
          shouldAbort: () => this.stopping || this.isNodeExecutionSuperseded(instanceId, node.id),
        });
        // 等待期间节点可能已被停止：此时不能再往下走，否则 beginNodeAttempt/updateNodeStatus("running")
        // 会把取消态覆盖掉，让已停止的节点继续跑完一轮。
        if (this.stopping || await this.withDatabase(() => this.isNodeExecutionSuperseded(instanceId, node.id) || this.isInstanceExecutionAborted(instanceId))) return;
      } else {
        await this.withDatabase(() => this.ctx.assertWorkspaceWriteAvailable?.(instance.workspaceId, instanceId));
      }
      await this.withDatabase(() => this.ctx.assertAssetExecution?.(instance));
    } catch (error) {
      // 实例已取消/进入终态或引擎正在停止时不再套用失败策略：
      // 否则会把已取消的节点改回 waiting-feedback，取消后冒出幽灵待反馈。
      await this.withDatabase(() => {
        if (this.stopping || this.isInstanceExecutionAborted(instanceId)) return;
        this.applyRoleFailurePolicy(instanceId, node, instance, error instanceof Error ? error.message : String(error), { source: "execution" });
      });
      return;
    }
    const ready = await this.withDatabase(() => {
    node = this.withRuntimeNodeWorkItemPolicy(instance, node);
    if (!node.roleId) {
      this.applyRoleFailurePolicy(instanceId, node, instance, "角色未配置", { source: "execution" });
      return;
    }

    let role: RoleDefinition;
    try {
      role = this.resolveSnapshotRoleDefinitionForAttempt(instance, node.roleId);
    } catch (error) {
      this.applyRoleFailurePolicy(instanceId, node, instance, error instanceof Error ? error.message : String(error), { source: "execution" });
      return;
    }

    let attempt: OrchNodeAttempt;
    try {
      attempt = this.beginNodeAttempt(instanceId, node, instance);
    } catch (error) {
      this.applyRoleFailurePolicy(instanceId, node, instance, error instanceof Error ? error.message : String(error), { source: "execution" });
      return;
    }
    this.updateNodeStatus(instanceId, node, instance, "running");
    return { role, attempt };
    });
    if (!ready) return;
    const { role, attempt } = ready;
    let maxRetries = 0;

    try {
      const prepared = await this.withDatabase(() => {
      // 1. 渲染输入模板
      const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
      const effectiveContext = this.buildRenderContext(instance);
      const inEdges = instance.workflowSnapshot.edges.filter((e) => e.targetNodeId === node.id);
      const allMappings = inEdges.flatMap((e) => e.dataMappings ?? []);
      const inputResolution = this.resolveNodeInputArtifacts(instance, node, role);
      const inputContext = this.persistNodeInputResolution(instance, node, attempt, inputResolution);
      if (inputResolution.missingRequired.length) {
        const errorMessage = inputResolution.resolutionStatus === "invalid"
          ? `节点输入引用合同无效: ${inputResolution.missingRequired.join(", ")}`
          : `缺少必需输入工件: ${inputResolution.missingRequired.join(", ")}`;
        this.applyRoleFailurePolicy(
          instanceId,
          node,
          instance,
          errorMessage,
          { source: "execution" },
        );
        this.settleAttemptFromNodeState(attempt.id, instanceId, node.id);
        return;
      }
      const inputArtifactIds = inputResolution.ids;
      const feedbackContext = this.collectFeedbackContext(instance, node.id);
      const feedbackPatch = feedbackContext.feedbackPatch;
      const taskGoal = this.resolveTaskGoal(instance);
      const taskTitle = this.resolveTaskTitle(instance);
      const taskTitlePathSegment = buildTaskTitlePathSegment(instance.intakeSnapshot);
      const knowledgeRuntime = new KnowledgeRuntimeService(workspacePath);
      const runtimeEvidence = new RuntimeEvidenceService({
        db: this.ctx.db,
        instance,
      });

      const renderedInputBase = renderTemplate(role.inputDefinition.instructions, {
        dataMappings: allMappings,
        boundFields: inputResolution.fieldValues,
        context: effectiveContext,
        workflow: instance.workflowSnapshot,
        globals: {
          requirement: taskGoal,
          requirementTitle: taskTitle,
          taskTitle,
          taskTitlePathSegment,
          timestamp: new Date().toISOString(),
          workspacePath,
          feedbackPatch: feedbackPatch ?? "",
        },
      });
      const renderedTaskInput = this.appendNodeWorkItemPromptContext(instance, node, renderedInputBase);
      const roleTools = this.resolveRoleTools(instance, role);
      const executionPrefs = this.resolveExecutionPrefs(instance, role, roleTools, feedbackContext.executionOverride);
      if (instance.assetRuntimeSnapshot?.executionAuthorization) executionPrefs.accessMode = "read-only";
      assertClientReasoningEffortSupported(
        this.ctx.db,
        executionPrefs.engine,
        executionPrefs.model,
        executionPrefs.effort,
      );
      const roleSkills = this.resolveRoleSkills(instance, role, executionPrefs.engine);
      const roleSkillTools = buildSkillScriptToolEntries({
        db: this.ctx.db, requestId: `node-attempt:${attempt.id}`, instanceId: instance.id, nodeId: node.id, attemptId: attempt.id,
        threadId: attempt.threadId, turnId: attempt.turnId,
        workspacePath,
        workspaceId: instance.workspaceId,
        skills: roleSkills,
      });
      const availableTools = [...roleTools, ...roleSkillTools];
      this.assertToolAccessAllowed(role, availableTools, executionPrefs.accessMode);
      const roleExecutionRevision = this.buildRoleExecutionRevision(role, roleTools, roleSkills);
      maxRetries = executionPrefs.maxRetries ?? 0;
      const artifactInput = this.buildArtifactInputSnapshot(instance, inputArtifactIds, inputResolution.fieldValues, inputContext);
      const feedbackArtifactInput = this.buildArtifactInputSnapshot(instance, feedbackContext.artifactIds, {});
      const knowledgeContext = this.resolveKnowledgeContext(instance, node, role, knowledgeRuntime);
      const toolRegistry = this.buildToolRegistry(
        availableTools,
        runtimeEvidence,
        executionPrefs.accessMode,
        this.buildNodeResultSubmissionToolContext(node, role),
        node,
      );
      if (toolRegistry && knowledgeContext.catalogs.some(catalog => catalog.bundleId === "project-file-knowledge")) {
        toolRegistry.tools.push(...buildKnowledgeAssetReadTools(true).tools, buildKnowledgeChangeTool(), buildKnowledgeAcceptanceTool());
      }
      const runtimePolicy = this.buildRuntimePolicy(instance, node, role, executionPrefs, toolRegistry);
      const executionProfiles = this.resolveNodeExecutionProfiles(instance, node);
      const billingContext = this.resolveNodeBillingContext(executionPrefs.engine, executionPrefs.model);
      const builtPrompt = this.promptBuilder.build({
        instanceId: instance.id,
        role,
        node,
        taskTitle,
        taskTitlePathSegment,
        taskGoal,
        taskBackground: instance.intakeSnapshot.background ?? null,
        acceptanceCriteria: instance.intakeSnapshot.acceptanceCriteria ?? null,
        renderedTaskInput,
        feedbackPatch,
        latestFeedbackPatch: feedbackContext.latestFeedbackPatch,
        latestFeedbackText: feedbackContext.latestFeedbackText,
        latestFeedbackAction: feedbackContext.latestAction,
        latestFeedbackSource: feedbackContext.latestSource,
        feedbackImages: feedbackContext.feedbackImages,
        runtimePolicy,
        toolRegistry,
        roleExecutionRevision,
        knowledgeCatalogs: knowledgeContext.catalogs,
        projectSpecifications: knowledgeContext.projectSpecifications,
        knowledgeWarnings: knowledgeContext.warnings,
        skills: roleSkills,
        artifactInput,
        feedbackArtifactInput,
        executionProfiles,
        billingContext,
        artifactPathTokens: this.buildArtifactPathTokens(instance, node, taskTitle, taskTitlePathSegment),
      });

      // 更新渲染后的输入
      const nodeState = instance.nodeStates[node.id];
      if (nodeState) {
        nodeState.renderedInput = builtPrompt.renderedInputPreview;
        nodeState.inputArtifactIds = inputArtifactIds;
        nodeState.knowledgeWarnings = knowledgeContext.warnings?.map((item) => item.message) ?? null;
        if (this.isSequentialWorkItemNode(node)) {
          nodeState.workItemSummary = this.ctx.db.orchNodeWorkItems.getSummary(instance.id, node.id);
        }
        instance.nodeStates[node.id] = nodeState;
        this.persistNodeState(instanceId, instance, node.id);
      }
      return { builtPrompt, executionPrefs, runtimeEvidence, roleSkills };
      });
      if (!prepared) return;

      // 2. 创建子线程并执行
      const execution = await this.executeSubThread(instance, node, role, prepared.builtPrompt, prepared.executionPrefs, prepared.runtimeEvidence, prepared.roleSkills, attempt.id);
      if (!await this.withDatabase(() => this.canContinueNodeAttempt(instanceId, node, attempt.id, "execution-completed"))) return;
      await this.finalizeRoleExecution(instanceId, node, instance, role, execution, attempt.id);
    } catch (e) {
      // 已知诊断先于取消及终态，禁止 retry/failPolicy 再派发。
      if (OrchestrationWorkspaceLogFailure.is(e) || isSkillRuntimeDiagnosticFailure(e) || describeOrchestrationProfileFailure(e)) throw e;
      await this.withDatabase(() => {
      try { this.assertNoWorkspaceLogFailure(instanceId); }
      catch (previous) {
        if (OrchestrationWorkspaceLogFailure.is(previous)) throw new OrchestrationWorkspaceLogFailure([previous, e], previous);
        throw previous;
      }
      if (!this.canContinueNodeAttempt(instanceId, node, attempt.id, "execution-error")) return;
      const errorMetadata = extractTurnErrorMetadata(e);
      const error = errorMetadata.message;
      const profileFailure = errorMetadata.code === "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED";
      // 物理 W 由持久 instance 决定，shared scope 仅作业务维度。
      if (profileFailure) try { this.ctx.db.writeWorkspaceLog(instance.workspaceId, { level: "error", tag: "workspace-profile", message: "node Profile read failed before dispatch", data: {
        code: errorMetadata.code, errorCode: errorMetadata.code, event: { category: "workspace-profile", action: "node.execute", outcome: "fail" }, requestId: `node-attempt:${attempt.id}`, workspaceId: instance.workspaceId,
        instanceId, nodeId: node.id, attemptId: attempt.id, userIds: this.resolveExecutionProfileUserIds(instance, node),
        scope: this.resolveExecutionProfileScope(instance), rootCause: describeWorkspaceProfileFailure(e),
      } }); } catch (logError) { throw Object.assign(new AggregateError([e, logError], "WORKSPACE_PROFILE_FAILURE_LOG_FAILED", { cause: e }), {
        requestId: `node-attempt:${attempt.id}`, workspaceId: instance.workspaceId, instanceId, nodeId: node.id, attemptId: attempt.id,
      }); }
      // 更新准入等待被统一停止打断时保留可恢复事实，不转成人工反馈。
      if (this.stopping && errorMetadata.terminationKind === "manual_interrupt") return;
      const persistedAttempt = this.ctx.db.orchNodeAttempts.get(attempt.id);

      if (persistedAttempt?.submission) {
        this.failSubmittedAttempt(instanceId, node, instance, attempt.id, error);
        return;
      }

      if (errorMetadata.terminationKind === "manual_interrupt") {
        // 手动中断统一走恢复路径，与 node.failPolicy 解耦，避免被 skip/retry/failed 吞掉。
        this.markNodeAsExecutionInterrupted(instanceId, node, instance, error);
        return;
      }

      // 检查重试
      const nodeState = instance.nodeStates[node.id];
      const recoveryMetadata = normalizeOrchestrationRecoveryMetadata(errorMetadata);
      if (nodeState && nodeState.retryCount < maxRetries) {
        const parentExecutionId = this.resolveNodeAttemptId(nodeState) ?? attempt.id;
        this.finishNodeAttempt(instance, node.id, node.label, nodeState, "failed", error);
        nodeState.retryCount += 1;
        this.resetNodeForRetry(nodeState, nodeState.activeFeedbackRecordIds ?? null);
        nodeState.status = "ready";
        instance.nodeStates[node.id] = nodeState;
        this.beginNodeAttempt(instanceId, node, instance, parentExecutionId);
        this.persistNodeState(instanceId, instance, node.id);
        this.emitNodeStateChanged(instance, node.id, node.label, "ready");
        return;
      }

      if (this.applyRoleFailurePolicy(instanceId, node, instance, error, {
        source: "execution",
        recoveryMetadata,
      })) {
        if (!profileFailure) this.writeLifecycleLog(instance, "role execution failed", errorMetadata.code ?? "orchestration_role_execution_failed", "role_execute", {
          code: errorMetadata.code ?? "orchestration_role_execution_failed",
          requestId: `node-attempt:${attempt.id}`,
          instanceId,
          nodeId: node.id,
          attemptId: attempt.id,
          threadId: instance.nodeStates[node.id]?.threadId ?? null,
        }, { error: e });
        this.settleAttemptFromNodeState(attempt.id, instanceId, node.id, error);
        return;
      }
      });
    }
  }

  /** 每轮等待更新准入后刷新项目规格；取消仍沿原 Attempt 权属收口。 */
  private async executeSubThread(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    prompt: BuiltNodePrompt,
    executionPrefs: {
      engine: EngineType;
      model: string | null;
      effort: string | null;
      accessMode: AccessMode;
      autoCompactPct: number | null;
      contextWindow: number | null;
      serviceTier: "fast" | null;
    },
    runtimeEvidence: RuntimeEvidenceService,
    roleSkills: SkillDefinition[] = [],
    attemptId?: string,
  ): Promise<{ rawOutput: string; finalAnswer: NodeFinalAnswerPayload }> {
    if (instance.assetRuntimeSnapshot?.executionAuthorization) executionPrefs = { ...executionPrefs, accessMode: "read-only" };
    const executionAttemptId = String(attemptId ?? "").trim()
      || (await this.withDatabase(() => this.beginNodeAttempt(instance.id, node, instance))).id;
    const engine = executionPrefs.engine;
    const dispatchState = this.runningInstances.get(instance.id);
    const dispatchRunId = dispatchState?.runId;
    /** 输出回调沿现有运行代次 fencing，不能逐 delta 打开数据库。 */
    const isCurrentOutputOwner = () => {
      const current = this.runningInstances.get(instance.id);
      return current === dispatchState && (!current || current.runId === dispatchRunId && !current.cancelled);
    };
    let { threadId, thread, reused } = (await this.withDatabase(() => this.resolveOrCreateNodeThread(instance, node, role, {
      engine,
      model: executionPrefs.model,
      effort: executionPrefs.effort,
      accessMode: executionPrefs.accessMode,
      autoCompactPct: executionPrefs.autoCompactPct,
      contextWindow: executionPrefs.contextWindow,
      serviceTier: executionPrefs.serviceTier,
    })));

    // 获取会话
    let session = await this.withDatabase(() => this.ctx.sessions.getOrCreate(thread));
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    const knowledgeRuntime = new KnowledgeRuntimeService(workspacePath);
    const projectStore = workspacePath ? new KnowledgeAssetStore(workspacePath) : null;
    const promptRenderer = new XmlNodePromptRenderer();
    let toolRuntime = new ToolRuntimeService(workspacePath, {
      db: this.ctx.db, workspaceId: instance.workspaceId, nodeId: node.id, attemptId: executionAttemptId,
      withLegacyDatabase: (_requestId, operation) => this.withDatabase(operation),
      runtimeEvidence,
      managedServices: this.managedServiceRuntime,
      instanceId: instance.id,
      threadId,
    });
    const toolRegistry = prompt.snapshots.toolRegistry;
    const toolTransport = await this.withDatabase(() => session.resolvePlatformToolTransport(toolRegistry, "required"));
    if (toolRegistry?.tools.length && toolTransport !== "native-dynamic") {
      throw new Error(`当前 ${engine} 提供商未启用编排节点所需的真实工具提交流程，无法继续执行当前节点。`);
    }
    let currentUserMessage = reused && prompt.continuationUserMessage
      ? prompt.continuationUserMessage
      : prompt.userMessage;
    const requiresSkillPackageInstall = Boolean(
      toolRegistry?.tools.some((tool) => String(tool.toolId) === SKILL_PACKAGE_INSTALL_TOOL_ID),
    );
    const installedSkillSlugs = new Set<string>();
    let observedWorkItemBoardVersion = this.isSequentialWorkItemNode(node)
      ? (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.getSummary(instance.id, node.id))).boardVersion
      : 0;
    let workItemNoProgressTurns = 0;
    let completedWorkItemsInCurrentThread = 0;
    try {
      for (let turnIndex = 1; ; turnIndex += 1) {
        if (this.ctx.isTaskAdmissionPaused) {
          while (true) {
            if (this.stopping || this.runningInstances.get(instance.id)?.cancelled
              || !(await this.withDatabase(() => this.canContinueNodeAttempt(instance.id, node, executionAttemptId, "model-dispatch")))) {
              throw Object.assign(new Error("编排节点派发已中断"), {
                code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt",
                instanceId: instance.id, nodeId: node.id, attemptId: executionAttemptId,
              });
            }
            if (!this.ctx.isTaskAdmissionPaused()) break;
            await new Promise<void>(resolve => setTimeout(resolve, 25));
          }
        }
        const turnId = `turn_orch_${crypto.randomUUID()}` as TurnId;
        const userItemId = `item_user_${crypto.randomUUID()}` as ItemId;
        const assistantItemId = `item_assistant_${crypto.randomUUID()}`;
        const reasoningItemId = `item_reasoning_${crypto.randomUUID()}`;
        const turnImages = turnIndex === 1 ? (prompt.feedbackImages ?? []) : [];
        let responseText = "";
        let terminalError: Error | null = null;
        let workItemContextCheckpointRequired = false;
        const now = Date.now();
        const turnBillingContext = (await this.withDatabase(() => this.resolveNodeBillingContext(engine, executionPrefs.model)));
        const providedSpecifications = projectStore?.snapshot(false, false).initialized ? projectStore.rules() : null;
        const turnPromptEnvelope = {
          ...prompt.promptEnvelope,
          knowledge: {
            ...prompt.promptEnvelope.knowledge,
            projectSpecifications: projectStore && providedSpecifications ? renderKnowledgeSpecificationRules(projectStore, providedSpecifications) : null,
          },
          meta: {
            ...prompt.promptEnvelope.meta,
            billingContext: turnBillingContext,
          },
        };
        const turnPrompt = turnPromptEnvelope.knowledge.projectSpecifications === (prompt.promptEnvelope.knowledge?.projectSpecifications ?? null)
          ? prompt : promptRenderer.render(turnPromptEnvelope);

        (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.bindExecution(executionAttemptId, threadId, turnId)));
        (await this.withDatabase(() => this.createPromptSnapshot(instance, node, {
          turnId,
          threadId,
          engine,
          model: executionPrefs.model,
          effort: executionPrefs.effort,
          promptEnvelope: turnPromptEnvelope,
          systemMessage: turnPrompt.systemMessage,
          developerMessage: turnPrompt.developerMessage,
          userMessage: currentUserMessage,
          renderedInputPreview: this.renderPromptPreview(turnPrompt.systemMessage, turnPrompt.developerMessage, currentUserMessage),
          runtimePolicy: prompt.snapshots.runtimePolicy,
          toolRegistry,
          knowledgeCatalogs: prompt.snapshots.knowledgeCatalogs,
          knowledgeWarnings: prompt.snapshots.knowledgeWarnings,
          artifactInput: prompt.snapshots.artifactInput,
        })));

        this.ctx.emitConversation({
          ts: now,
          workspaceId: instance.workspaceId,
          threadId,
          engine,
          type: "turn.started",
          payload: {
            turnId,
            execution: buildTurnExecutionOptionsSnapshot(executionPrefs),
          },
        });
        this.ctx.emitConversation({
          ts: now,
          workspaceId: instance.workspaceId,
          threadId,
          engine,
          type: "item.userMessage.created",
          payload: {
            turnId,
            itemId: userItemId,
            text: currentUserMessage,
            images: turnImages.length ? turnImages : undefined,
          },
        });

        let submittedResult: NodeFinalAnswerPayload | null = null;
        let forwardedTerminalKind: "completed" | "error" | null = null;
        const specificationTurn = projectStore && providedSpecifications ? createKnowledgeSpecificationTurn({
          store: projectStore, specifications: providedSpecifications, workspaceId: instance.workspaceId, threadId, turnId, engine,
          userRequirements: currentUserMessage, isActive: isCurrentOutputOwner, emit: event => this.ctx.emitConversation(event),
        }) : null;
        const knowledgeSuggestions = toolRegistry?.tools.some(tool => String(tool.toolsetId) === "__knowledge_assets__") ? createKnowledgeSuggestionTurn({
          store: new KnowledgeAssetStore(workspacePath), workspaceId: instance.workspaceId, threadId, turnId, engine,
          origin: "workflow", canPropose: true,
          specificationTurn,
          isActive: isCurrentOutputOwner,
          emit: event => this.ctx.emitConversation(event),
        }) : null;
        try {
          const canDispatch = await this.withDatabase(() => {
            this.ctx.assertAssetExecution?.(instance);
            return this.canContinueNodeAttempt(instance.id, node, executionAttemptId, "model-dispatch");
          });
          if (!canDispatch || !isCurrentOutputOwner()) {
            throw Object.assign(new Error("编排节点派发已中断"), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt",
              instanceId: instance.id, nodeId: node.id, attemptId: executionAttemptId });
          }
          const sharedWorkspaceToolContext: SharedWorkspaceToolExecutionContext | null = instance.assetRuntimeSnapshot?.executionAuthorization
            ? { sharedWorkspaceId: instance.assetRuntimeSnapshot.executionAuthorization.sharedWorkspaceId,
              operationId: turnId as SharedWorkspaceToolExecutionContext["operationId"],
              operationKey: "ai.thread.send.personal", toolPolicyKey: "ai.personal.readonly" } : null;
          const sendResult = await session.sendMessage(
            {
              turnId,
              userItemId,
              text: currentUserMessage,
              userMessage: currentUserMessage,
              systemMessage: turnPrompt.systemMessage,
              developerMessage: mergeDeveloperMessages(turnPrompt.developerMessage, buildNativeDynamicToolDeveloperMessage(toolRegistry)),
              toolRegistryJson: toolRegistry ? JSON.stringify(toolRegistry) : null,
              toolRegistry: toolRegistry,
              platformToolTransportRequirement: "required",
              executeHostTool: async ({ toolId, toolInput, accessMode }) => {
                this.assertNoWorkspaceLogFailure(instance.id);
                if (sharedWorkspaceToolContext) {
                  accessMode = "read-only";
                  const tool = toolRegistry?.tools.find(item => String(item.toolId) === String(toolId));
                  const decision = evaluateSharedWorkspaceHostToolPolicy({ context: sharedWorkspaceToolContext, tool, toolInput });
                  if (!decision.allowed) return sharedWorkspaceToolDeniedResult(decision);
                }
                if (ORCH_WORK_ITEM_TOOL_IDS.has(toolId)) {
                  if (workItemContextCheckpointRequired && toolId !== ORCH_WORK_ITEMS_LIST_TOOL_ID) {
                    return {
                      ok: false,
                      code: "WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED",
                      message: "当前底层上下文已达到节点配置的工作项换段阈值。请结束本回合，不要继续启动工作项；平台会在同一节点和看板上自动切换上下文。",
                    } satisfies HostToolExecutionResult;
                  }
                  const result = await this.executeNodeWorkItemTool(instance, node, executionAttemptId, toolId, toolInput);
                  if (toolId === ORCH_WORK_ITEMS_COMPLETE_TOOL_ID && result.ok) {
                    completedWorkItemsInCurrentThread += 1;
                    const maxItemsPerThread = node.workItemPolicy?.maxItemsPerThread ?? null;
                    const summary = result.output && typeof result.output === "object"
                      ? (result.output as { summary?: NodeWorkItemSummary }).summary ?? null
                      : null;
                    if (maxItemsPerThread != null
                      && completedWorkItemsInCurrentThread >= maxItemsPerThread
                      && summary
                      && summary.completed < summary.total) {
                      workItemContextCheckpointRequired = true;
                      return {
                        ...result,
                        output: {
                          ...(result.output as Record<string, unknown>),
                          contextCheckpointRequired: true,
                          contextCheckpointReason: `当前上下文已完成 ${completedWorkItemsInCurrentThread} 项，平台将在本回合结束后换段`,
                        },
                      } satisfies HostToolExecutionResult;
                    }
                  }
                  return result;
                }
                if (toolId === ORCH_SUBMIT_NODE_RESULT_TOOL_ID) {
                  try {
                    const finalAnswer = this.normalizeNodeResultSubmission(
                      toolInput,
                      prompt.snapshots.runtimePolicy.artifactPolicy.outputMode,
                    );
                    if (this.isAutoRecoverableNodeHumanInput(finalAnswer)) {
                      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeResultAutoRecoveryRequested", {
                        instanceId: instance.id,
                        nodeId: node.id,
                        nodeLabel: node.label,
                        attemptId: executionAttemptId,
                        code: ORCH_AUTO_RECOVERY_REQUIRED_CODE,
                      })));
                      return this.buildAutoRecoveryNodeSubmissionResult();
                    }
                    (await this.withDatabase(() => this.validateNodeWorkItemSubmission(instance, node, finalAnswer)));
                    if (requiresSkillPackageInstall && finalAnswer.control.nextAction === "continue") {
                      const missingSlugs = roleSkills
                        .map((skill) => String(skill.slug ?? "").trim())
                        .filter((slug) => slug && !installedSkillSlugs.has(slug));
                      if (missingSlugs.length) {
                        return {
                          ok: false,
                          message: `环境节点继续前必须先调用 ${SKILL_PACKAGE_INSTALL_TOOL_ID} 安装当前角色绑定的 Skill：${missingSlugs.join("、")}`,
                          code: "VALIDATION_FAILED",
                          output: { missingSkillSlugs: missingSlugs },
                        } satisfies HostToolExecutionResult;
                      }
                    }
                    (await this.withDatabase(() => this.validateFinalAnswerSemantics(instance, node, role, finalAnswer, prompt.snapshots.runtimePolicy.artifactPolicy.primaryKind)));
                    const contractValidation = this.validateNodeResultContract(instance, node, role, finalAnswer);
                    if (!contractValidation.accepted) {
                      return {
                        ok: false,
                        message: this.buildNodeResultContractRecoveryMessage(
                          contractValidation,
                          this.buildNodeResultSubmissionToolContext(node, role),
                        ),
                        code: "VALIDATION_FAILED",
                        output: { issues: contractValidation.blockingIssues },
                      } satisfies HostToolExecutionResult;
                    }
                    const normalizedFinalAnswer: NodeFinalAnswerPayload = {
                      ...finalAnswer,
                      answer: contractValidation.normalizedAnswer,
                    };
                    const artifactPathIssues = finalAnswer.control.nextAction === "continue"
                      ? this.validateArtifactOutputForExecution(instance, node, role, normalizedFinalAnswer.answer)
                      : [];
                    if (artifactPathIssues.length) {
                      return {
                        ok: false,
                        message: this.buildArtifactOutputRecoveryMessage(artifactPathIssues),
                        code: "VALIDATION_FAILED",
                        output: { issues: artifactPathIssues },
                      } satisfies HostToolExecutionResult;
                    }
                    const submission = (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.submit(executionAttemptId, normalizedFinalAnswer)));
                    if (submission.attempt.status === "result-submitted") {
                      (await this.withDatabase(() => this.projectSubmittedNodeAttempt(instance, node, submission.attempt)));
                    }
                    submittedResult = submission.attempt.submission ?? normalizedFinalAnswer;
                    (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeResultSubmitted", {
                      instanceId: instance.id,
                      nodeId: node.id,
                      nodeLabel: node.label,
                      attemptId: executionAttemptId,
                      attemptNo: submission.attempt.attemptNo,
                      submissionId: submission.attempt.id,
                      idempotent: submission.idempotent,
                    })));
                    return {
                      ok: true,
                      output: {
                        accepted: true,
                        submissionId: submission.attempt.id,
                        idempotent: submission.idempotent,
                        nextAction: finalAnswer.control.nextAction,
                        reviewVerdict: finalAnswer.review.verdict,
                        validationStatus: this.resolveNodeResultValidationStatus(contractValidation),
                      },
                    } satisfies HostToolExecutionResult;
                  } catch (error) {
                    (await this.withDatabase(() => this.emitRejectedNodeAttemptContinuation(instance, node, executionAttemptId, "submit", error)));
                    return {
                      ok: false,
                      message: error instanceof Error ? error.message : String(error),
                      code: "VALIDATION_FAILED",
                    } satisfies HostToolExecutionResult;
                  }
                }

                const tool = toolRegistry?.tools.find((item) => item.toolId === toolId) ?? null;
                if (!tool) {
                  return {
                    ok: false,
                    message: `未找到已注册工具：${toolId}`,
                    code: "TOOL_NOT_FOUND",
                  } satisfies HostToolExecutionResult;
                }
                if (knowledgeSuggestions && String(tool.toolsetId) === "__knowledge_assets__") {
                  try {
                    return await this.withDatabase(() => {
                      if (!this.isTurnStillStarted(turnId) || !this.canContinueNodeAttempt(instance.id, node, executionAttemptId, "knowledge-proposal")) {
                        return { ok: false, code: "ORCHESTRATION_ATTEMPT_FENCED", message: "节点执行已被取消或接管" };
                      }
                      return knowledgeSuggestions.execute(String(toolId), toolInput);
                    });
                  }
                  catch (error) {
                    let failure = { code: "KNOWLEDGE_ASSET_IO_FAILED", message: "项目知识操作失败，请查看对应请求的 Client 日志" };
                    const context = {
                      requestId: turnId, nodeId: node.id, attemptId: executionAttemptId, threadId, turnId, toolId,
                      code: failure.code, errorCode: failure.code,
                    };
                    (await this.withDatabase(() => this.writeLifecycleLog(instance, "workflow knowledge tool failed", failure.code, "workflow_knowledge_tool", context, { error }, describe => {
                      const safe = describe(error);
                      if (error instanceof KnowledgeAssetError && typeof safe.code === "string") {
                        failure = { code: safe.code, message: typeof safe.message === "string" ? safe.message : failure.message };
                      } else if (typeof safe.message === "string" && safe.message.trim()) failure.message = `项目知识操作失败：${safe.message.trim().slice(0, 2000)}`;
                      context.code = context.errorCode = failure.code;
                      return safe;
                    }, "knowledge-assets")));
                    return {
                      ok: false,
                      ...failure,
                      output: {
                        requestId: turnId,
                        operation: String(toolId),
                        instanceId: instance.id,
                        nodeId: node.id,
                        rootCause: failure.message,
                      },
                    };
                  }
                }
                if (toolId === SKILL_PACKAGE_INSTALL_TOOL_ID) {
                  if (accessMode !== "full-access") {
                    return {
                      ok: false,
                      message: `Skill 安装工具需要 full-access，当前节点访问模式是 ${accessMode}`,
                      code: "TOOL_PERMISSION_DENIED",
                    } satisfies HostToolExecutionResult;
                  }
                  try {
                    const result = await installBoundSkillPackage({
                      workspacePath,
                      skills: roleSkills,
                      toolInput,
                    });
                    const notReady = result.status.filter((item) => !item.ready);
                    if (notReady.length) {
                      throw new Error(`Skill 安装后仍未就绪：${notReady.map((item) => `${item.targetId}:${item.message}`).join("；")}`);
                    }
                    installedSkillSlugs.add(result.slug);
                    return {
                      ok: true,
                      output: result,
                    } satisfies HostToolExecutionResult;
                  } catch (error) {
                    (await this.withDatabase(() => this.emitRejectedNodeAttemptContinuation(instance, node, executionAttemptId, "submit", error)));
                    return {
                      ok: false,
                      message: error instanceof Error ? error.message : String(error),
                      code: "TOOL_EXECUTION_FAILED",
                    } satisfies HostToolExecutionResult;
                  }
                }
                return toHostToolExecutionResult(await toolRuntime.execute(tool, toolInput, accessMode, { requestId: turnId, turnId }));
              },
              responseFormat: "text",
              sharedWorkspaceToolContext,
              providerNativeToolPolicy: "allow",
              conversationProfile: "orchestration",
              images: turnImages,
              assistantItemId,
              reasoningItemId,
              accessMode: executionPrefs.accessMode,
              model: executionPrefs.model,
              effort: executionPrefs.effort,
              contextWindow: executionPrefs.contextWindow,
              autoCompactPct: executionPrefs.autoCompactPct,
              serviceTier: executionPrefs.serviceTier,
              timeoutPolicy: this.ctx.timeoutPolicy,
            },
            {
              conversation: (event) => {
                if (!isCurrentOutputOwner()) return;
                specificationTurn?.observe(event);
                const terminalKind = resolveTurnTerminalKind(event, turnId);
                if (terminalKind) {
                  if (submittedResult && terminalKind === "error") {
                    return;
                  }
                  if (forwardedTerminalKind) {
                    return;
                  }
                  forwardedTerminalKind = terminalKind;
                }
                this.ctx.emitConversation(event);
                if (event.type === "turn.error") {
                  terminalError = buildErrorFromTurnErrorPayload((event.payload as any) ?? {});
                }
                if (event.type === "item.agentMessage.completed") {
                  responseText = String((event.payload as any).text ?? "");
                }
              },
              raw: (event) => {
                if (!isCurrentOutputOwner()) return;
                this.ctx.emitRaw(event);
              },
            },
          );
          if (!responseText.trim()) {
            responseText = String(sendResult.responseText ?? "").trim();
          }
          if (forwardedTerminalKind === "error" && !submittedResult) {
            throw terminalError ?? new Error("turn error");
          }
          if (!forwardedTerminalKind && (await this.withDatabase(() => this.isTurnStillStarted(turnId)))) {
            forwardedTerminalKind = "completed";
            await emitTurnTerminalWithAssistantReconcile({
              session,
              turnId,
              outcome: "completed",
              emitConversation: this.ctx.emitConversation,
              buildTerminalEvent: (latestAssistantText) => ({
                ts: Date.now(),
                workspaceId: instance.workspaceId,
                threadId,
                engine,
                type: "turn.completed",
                payload: {
                  turnId,
                  result: { responseText: latestAssistantText ?? responseText },
                },
              }),
            });
          }
        } catch (error) {
          if (OrchestrationWorkspaceLogFailure.is(error)) throw error;
          if (submittedResult) {
            if (!forwardedTerminalKind && (await this.withDatabase(() => this.isTurnStillStarted(turnId)))) {
              forwardedTerminalKind = "completed";
              await emitTurnTerminalWithAssistantReconcile({
                session,
                turnId,
                outcome: "completed",
                emitConversation: this.ctx.emitConversation,
                buildTerminalEvent: (latestAssistantText) => ({
                  ts: Date.now(),
                  workspaceId: instance.workspaceId,
                  threadId,
                  engine,
                  type: "turn.completed",
                  payload: {
                    turnId,
                    result: { responseText: latestAssistantText ?? responseText },
                  },
                }),
              });
            }
            (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.saveResponseText(executionAttemptId, responseText)));
            return {
              rawOutput: responseText,
              finalAnswer: submittedResult,
            };
          }
          if (
            workItemContextCheckpointRequired
            && String((error as { code?: unknown } | null)?.code ?? "") === "WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED"
          ) {
            if (!responseText.trim()) {
              responseText = "当前工作项上下文已达到换段阈值，继续使用同一节点和看板。";
            }
            if (!forwardedTerminalKind && (await this.withDatabase(() => this.isTurnStillStarted(turnId)))) {
              forwardedTerminalKind = "completed";
              await emitTurnTerminalWithAssistantReconcile({
                session,
                turnId,
                outcome: "completed",
                emitConversation: this.ctx.emitConversation,
                buildTerminalEvent: (latestAssistantText) => ({
                  ts: Date.now(),
                  workspaceId: instance.workspaceId,
                  threadId,
                  engine,
                  type: "turn.completed",
                  payload: {
                    turnId,
                    result: { responseText: latestAssistantText ?? responseText },
                  },
                }),
              });
            }
          } else {
            if (!forwardedTerminalKind && (await this.withDatabase(() => this.isTurnStillStarted(turnId)))) {
              forwardedTerminalKind = "error";
              await emitTurnTerminalWithAssistantReconcile({
                session,
                turnId,
                outcome: "error",
                emitConversation: this.ctx.emitConversation,
                buildTerminalEvent: () => createTurnErrorEventInputFromError({
                  ts: Date.now(),
                  workspaceId: instance.workspaceId,
                  threadId,
                  engine,
                  turnId,
                  error,
                }),
              });
            }
            throw error;
          }
        }

        if (submittedResult) {
          (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.saveResponseText(executionAttemptId, responseText)));
          return {
            rawOutput: responseText,
            finalAnswer: submittedResult,
          };
        }

        if (this.isSequentialWorkItemNode(node)) {
          const summary = (await this.withDatabase(() => this.syncNodeWorkItemSummary(instance, node)));
          if (summary.boardVersion === observedWorkItemBoardVersion) workItemNoProgressTurns += 1;
          else workItemNoProgressTurns = 0;
          observedWorkItemBoardVersion = summary.boardVersion;
          if (workItemNoProgressTurns >= MAX_WORK_ITEM_NO_PROGRESS_TURNS) {
            throw new Error(`节点 ${node.label} 连续 ${MAX_WORK_ITEM_NO_PROGRESS_TURNS} 个回合没有创建、更新或完成工作项，已停止以避免无进展消耗。`);
          }
          if (workItemContextCheckpointRequired && summary.completed < summary.total) {
            const previousThreadId = threadId;
            const nextThread = (await this.withDatabase(() => this.resolveOrCreateNodeThread(instance, node, role, {
              engine,
              model: executionPrefs.model,
              effort: executionPrefs.effort,
              accessMode: executionPrefs.accessMode,
              autoCompactPct: executionPrefs.autoCompactPct,
              contextWindow: executionPrefs.contextWindow,
              serviceTier: executionPrefs.serviceTier,
              threadReusePolicy: "new-thread",
            })));
            threadId = nextThread.threadId;
            thread = nextThread.thread;
            session = await this.withDatabase(() => this.ctx.sessions.getOrCreate(thread));
            const nextToolTransport = await this.withDatabase(() => session.resolvePlatformToolTransport(toolRegistry, "required"));
            if (toolRegistry?.tools.length && nextToolTransport !== "native-dynamic") {
              throw new Error(`当前 ${engine} 提供商未启用编排节点所需的真实工具提交流程，无法在上下文换段后继续执行当前节点。`);
            }
            toolRuntime = new ToolRuntimeService(workspacePath, {
              db: this.ctx.db, workspaceId: instance.workspaceId, nodeId: node.id, attemptId: executionAttemptId,
              withLegacyDatabase: (_requestId, operation) => this.withDatabase(operation),
              runtimeEvidence,
              managedServices: this.managedServiceRuntime,
              instanceId: instance.id,
              threadId,
            });
            completedWorkItemsInCurrentThread = 0;
            (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeWorkItemContextCheckpoint", {
              instanceId: instance.id,
              nodeId: node.id,
              nodeLabel: node.label,
              previousThreadId,
              threadId,
              summary,
            })));
          }
          currentUserMessage = (await this.withDatabase(() => this.buildNodeWorkItemContinuationMessage(instance, node, summary)));
          continue;
        }

        if (turnIndex < 8) {
          currentUserMessage = this.buildNodeResultSubmissionRecoveryMessage(
            prompt.snapshots.runtimePolicy.artifactPolicy.outputMode,
            responseText,
            `当前平台工具已经作为真实工具注册，请在同一轮里直接调用 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID} 完成节点结果提交。`,
            role.outputDefinition,
          );
          continue;
        }
        throw new Error(`当前平台工具已经作为真实工具注册，但模型在本轮结束前没有调用 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID}。`);
      }
    } finally {}
  }

  private resolveOrCreateNodeThread(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    executionPrefs: {
      engine: EngineType;
      model: string | null;
      effort: string | null;
      accessMode: AccessMode;
      autoCompactPct: number | null;
      contextWindow: number | null;
      serviceTier: "fast" | null;
      threadReusePolicy?: NodeThreadReusePolicy | null;
    },
  ): { threadId: ThreadId; thread: ReturnType<ThreadStore["create"]>; reused: boolean } {
    const persistedTitle = `[编排] ${role.name} - ${instance.workflowSnapshot.name}`;
    const runtimeTitle = `[编排] ${role.name}`;
    const nodeState = instance.nodeStates[node.id] ?? null;
    const threadReusePolicy = executionPrefs.threadReusePolicy ?? "reuse-existing";
    if (threadReusePolicy === "new-thread" && nodeState?.threadId) {
      this.clearNodeThreadForNewAttempt(nodeState);
      instance.nodeStates[node.id] = nodeState;
      this.persistNodeState(instance.id, instance, node.id);
    }
    const existingThreadId = String(instance.nodeStates[node.id]?.threadId ?? "").trim() as ThreadId;

    if (existingThreadId) {
      const persistedThread = this.ctx.db.threads.get?.(existingThreadId) ?? null;
      const runtimeThread = this.ctx.threads.get(existingThreadId);
      const canReuseThread = persistedThread
        && persistedThread.workspaceId === instance.workspaceId
        && persistedThread.engine === executionPrefs.engine
        && (!runtimeThread || (
          runtimeThread.workspaceId === instance.workspaceId
          && runtimeThread.engine === executionPrefs.engine
        ));
      if (canReuseThread) {
        if (executionPrefs.engine === "codex") {
          const persistedSessionId = String(persistedThread.sessionId ?? "").trim();
          const runtimeSessionId = String(runtimeThread?.sessionId ?? "").trim();
          if (runtimeThread && persistedSessionId && runtimeSessionId && runtimeSessionId !== persistedSessionId) {
            throw new OrchestrationRuntimeConflictError({
              code: "THREAD_REUSE_CONFLICT",
              message: `节点「${node.label}」的 Codex provider binding 不一致（持久化=${persistedSessionId}，运行态=${runtimeSessionId || "缺失"}），不能继续发送或静默新建会话。`,
              nodeId: node.id,
              threadId: existingThreadId,
              availablePolicies: ["reuse-existing", "new-thread"],
            });
          }
        }
        this.ctx.db.threads.rename?.(existingThreadId, persistedTitle);
        this.ctx.db.threads.updatePrefs(existingThreadId, {
          model: executionPrefs.model,
          effort: executionPrefs.effort,
          accessMode: executionPrefs.accessMode,
          autoCompactPct: executionPrefs.autoCompactPct,
          contextWindow: executionPrefs.contextWindow,
          serviceTier: executionPrefs.serviceTier,
        });

        const thread = runtimeThread ?? this.ctx.threads.create({
          threadId: existingThreadId,
          workspaceId: instance.workspaceId,
          engine: executionPrefs.engine,
          title: runtimeTitle,
          sessionId: persistedThread.sessionId,
          sessionCapabilities: persistedThread.sessionCapabilities,
        });
        if (persistedThread.sessionId && !thread.sessionId) {
          this.ctx.threads.setSessionBinding?.(
            existingThreadId,
            persistedThread.sessionId,
            persistedThread.sessionCapabilities,
          );
        }
        this.ctx.threads.setTitle(existingThreadId, runtimeTitle);
        this.assignNodeThread(instance, node.id, existingThreadId);
        return { threadId: existingThreadId, thread, reused: true };
      }
      throw new OrchestrationRuntimeConflictError({
        code: "THREAD_REUSE_CONFLICT",
        message: `节点「${node.label}」已有会话 ${existingThreadId}，但该会话与当前角色执行配置不兼容，不能静默新建会话。请明确选择新建会话重跑。`,
        nodeId: node.id,
        threadId: existingThreadId,
        availablePolicies: ["reuse-existing", "new-thread"],
      });
    }

    const threadId = `orch-${instance.id}-${node.id}-${Date.now()}-${crypto.randomUUID()}` as ThreadId;
    this.ctx.db.threads.create({
      id: threadId,
      workspaceId: instance.workspaceId,
      engine: executionPrefs.engine,
      title: persistedTitle,
      threadType: "orchestration",
      threadSubtype: "node",
    });
    this.ctx.db.threads.updatePrefs(threadId, {
      model: executionPrefs.model,
      effort: executionPrefs.effort,
      accessMode: executionPrefs.accessMode,
      autoCompactPct: executionPrefs.autoCompactPct,
      contextWindow: executionPrefs.contextWindow,
      serviceTier: executionPrefs.serviceTier,
    });

    const thread = this.ctx.threads.create({
      threadId,
      workspaceId: instance.workspaceId,
      engine: executionPrefs.engine,
      title: runtimeTitle,
    });
    this.assignNodeThread(instance, node.id, threadId);
    return { threadId, thread, reused: false };
  }

  /** 记录节点执行线程，按单节点合并写回，避免覆盖并行分支状态。 */
  private assignNodeThread(instance: OrchestrationInstance, nodeId: string, threadId: ThreadId): void {
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) return;
    if (nodeState.threadId === threadId) return;
    const previousCurrentThreadId = String(nodeState.threadId ?? "").trim() as ThreadId;
    const archivedThreadId = previousCurrentThreadId || String(nodeState.previousThreadIds?.at(-1) ?? "").trim();
    nodeState.threadId = threadId;
    instance.nodeStates[nodeId] = nodeState;
    this.persistNodeState(instance.id, instance, nodeId);
    if (archivedThreadId && archivedThreadId !== threadId) {
      this.emitOrchEvent(instance, "orchestration.nodeThreadSwitched", {
        instanceId: instance.id,
        nodeId,
        nodeLabel: this.findNodeLabel(instance, nodeId),
        oldThreadId: archivedThreadId,
        newThreadId: threadId,
        reason: "new-thread",
      });
    }
  }

  /** 记录节点讨论线程，按单节点合并写回，避免覆盖并行分支状态。 */
  private assignDiscussionThread(instance: OrchestrationInstance, nodeId: string, threadId: ThreadId): void {
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) return;
    if (nodeState.discussionThreadId === threadId) return;
    nodeState.discussionThreadId = threadId;
    instance.nodeStates[nodeId] = nodeState;
    this.persistNodeState(instance.id, instance, nodeId);
  }

  // ── Helpers ──────────────────────────────────────────────────

  /** 读取当前节点处理人的工作区 Profile；未配置或为空时不注入。 */
  private resolveNodeExecutionProfiles(instance: OrchestrationInstance, node: WorkflowNode): NodeExecutionProfileSnapshot[] {
    const scope = this.resolveExecutionProfileScope(instance);
    const userIds = this.resolveExecutionProfileUserIds(instance, node);
    return this.ctx.db.withWorkspaceExecutionProfiles(instance.workspaceId, repo => {
      const profiles: NodeExecutionProfileSnapshot[] = [];
      for (const userId of userIds) {
        const profile = repo.get(scope, userId);
        const profileText = String(profile?.profileText ?? "").trim();
        if (!profileText) continue;
        profiles.push({
          userId,
          scope,
          profileText,
          profileHash: profile?.profileHash ?? null,
          updatedAt: profile?.updatedAt ?? null,
        });
      }
      return profiles;
    });
  }

  /** Resolves the provider and credential route that the engine will use for this model call. */
  private resolveNodeBillingContext(engine: EngineType, model: string | null): NodePromptBillingContext {
    const providerId = normalizeEngineKeyProviderId(
      engine,
      resolveRuntimeEngineModelProviderId(engine, model),
    ) ?? getDefaultEngineProviderId(engine);
    const credentialSource = this.resolveNodeCredentialSource(engine, providerId);
    const capturedAt = Date.now();
    const priceSnapshot = credentialSource === "codeflow_key"
      ? resolveRelayInvocationPriceSnapshot({
          catalog: this.ctx.getRelayPricingCatalog?.() ?? null,
          providerId,
          model,
          capturedAt,
        })
      : null;
    return { providerId, credentialSource, priceSnapshot, capturedAt };
  }

  /** Mirrors engine credential precedence without exposing credential values. */
  private resolveNodeCredentialSource(engine: EngineType, providerId: EngineModelProviderId): EngineCredentialSource {
    if (this.ctx.db.engineKeys.getActive(engine, providerId)) return "codeflow_key";
    if (providerId !== getDefaultEngineProviderId(engine)) return "none";
    const native = engine === "claude" ? readClaudeNativeAuthState() : readCodexNativeAuthState();
    return native.available ? native.source : "none";
  }

  /** 解析实例冻结的 Profile 作用域；旧实例缺失时按本地工作区处理。 */
  private resolveExecutionProfileScope(instance: OrchestrationInstance): NodeExecutionProfileScope {
    const scope = instance.runtimeConfig?.executionProfileScope;
    if (scope?.scopeType === "shared_workspace" && String(scope.scopeId ?? "").trim()) {
      return { scopeType: "shared_workspace", scopeId: String(scope.scopeId).trim() };
    }
    if (scope?.scopeType === "local_workspace" && String(scope.scopeId ?? "").trim()) {
      return { scopeType: "local_workspace", scopeId: String(scope.scopeId).trim() };
    }
    return { scopeType: "local_workspace", scopeId: String(instance.workspaceId) };
  }

  /** 节点有处理人时按处理人读取；独立运行无处理人时回退到发起人。 */
  private resolveExecutionProfileUserIds(instance: OrchestrationInstance, node: WorkflowNode): string[] {
    const assigneeUserIds = normalizeNodeAssigneeUserIds(instance.nodeStates[node.id]?.assigneeUserIds);
    if (assigneeUserIds?.length) return assigneeUserIds;
    const initiatorUserId = String(instance.runtimeConfig?.initiatorUserId ?? "").trim();
    return initiatorUserId ? [initiatorUserId] : [];
  }

  /** 只合并写回单个节点状态，避免并行分支用旧快照覆盖兄弟节点。 */
  private persistNodeState(
    instanceId: OrchestrationId,
    instance: OrchestrationInstance,
    nodeId: string,
  ): OrchestrationInstance {
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) return instance;
    const getInstance = this.ctx.db.orchInstances.get;
    const latest = typeof getInstance === "function" ? getInstance.call(this.ctx.db.orchInstances, instanceId) ?? instance : instance;
    latest.nodeStates[nodeId] = nodeState;
    this.ctx.db.orchInstances.updateNodeStates(instanceId, latest.nodeStates);
    instance.nodeStates = latest.nodeStates;
    instance.status = latest.status;
    instance.artifactIndex = latest.artifactIndex;
    return latest;
  }

  /** 更新节点状态，并在人工处理态变化时标记提醒数据。 */
  private updateNodeStatus(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    status: NodeExecutionStatus,
    options?: {
      error?: string | null;
      errorCode?: string | null;
      recoveryMetadata?: OrchestrationRecoveryErrorMetadata | null;
      humanActionSource?: NodeHumanActionSource | null;
    },
  ): void {
    const getInstance = this.ctx.db.orchInstances.get;
    const latest = typeof getInstance === "function" ? getInstance.call(this.ctx.db.orchInstances, instanceId) ?? instance : instance;
    let nodeState = latest.nodeStates[node.id] ?? instance.nodeStates[node.id] ?? { nodeId: node.id, retryCount: 0 };
    const previousStatus = nodeState.status ?? null;
    if (status === "waiting-start" || status === "queued" || status === "running") {
      this.beginNodeAttempt(instanceId, node, latest, nodeState.parentExecutionId ?? null);
      nodeState = latest.nodeStates[node.id] ?? nodeState;
    }
    nodeState.assigneeUserIds = normalizeNodeAssigneeUserIds(nodeState.assigneeUserIds);
    nodeState.status = status;

    if (status === "running") {
      nodeState.startedAt = Date.now();
    }
    if (status === "completed" || status === "failed" || status === "skipped") {
      nodeState.completedAt = Date.now();
    }
    if (status === "waiting-approval" || status === "waiting-feedback") {
      nodeState.humanActionSource = options?.humanActionSource ?? nodeState.humanActionSource ?? null;
    } else {
      nodeState.humanActionSource = null;
    }
    if (options && "error" in options) {
      nodeState.error = options.error ?? null;
      const recoveryMetadata = options.recoveryMetadata ?? null;
      nodeState.errorCode = recoveryMetadata?.code ?? options.errorCode ?? null;
      nodeState.providerThreadId = recoveryMetadata?.providerThreadId ?? null;
      nodeState.recoveryReason = recoveryMetadata?.recoveryReason ?? null;
      nodeState.preserveBinding = recoveryMetadata?.preserveBinding ?? null;
      nodeState.userChoiceRequired = recoveryMetadata?.userChoiceRequired ?? null;
      nodeState.recoveryStrategies = recoveryMetadata?.recoveryStrategies ?? null;
    } else if (status !== "waiting-feedback") {
      nodeState.errorCode = null;
      nodeState.providerThreadId = null;
      nodeState.recoveryReason = null;
      nodeState.preserveBinding = null;
      nodeState.userChoiceRequired = null;
      nodeState.recoveryStrategies = null;
    }

    latest.nodeStates[node.id] = nodeState;
    this.ctx.db.orchInstances.updateNodeStates(instanceId, latest.nodeStates);
    instance.nodeStates = latest.nodeStates;
    instance.status = latest.status;
    instance.artifactIndex = latest.artifactIndex;
    this.syncInstanceRuntimeStatus(instanceId, latest);
    instance.status = latest.status;
    this.notifyReminderChangedForNodeStatus(latest.workspaceId, previousStatus, status);
    this.notifyOrchestrationActionIfNeeded(latest, node, nodeState, previousStatus, status);

    this.emitNodeStateChanged(latest, node.id, node.label, status);
  }

  /** 在调用方已校验运行快照后驱动唯一协调器，并同步登记 drive owner。 */
  private async driveInstance(
    instanceId: OrchestrationId,
    state: OrchestrationRunState,
  ): Promise<void> {
    this.assertAcceptingExecution();
    while (true) {
      this.signalCoordinator(state);
      const drivePromise = state.drivePromise ?? this.startCoordinator(instanceId, state);
      await drivePromise;
      if (!await this.withDatabase(() => this.hasPendingCoordinatorWork(instanceId, state))) return;
    }
  }

  /** 原协调器收齐节点与清理后投递成功；投递拒绝不进入执行失败策略。 */
  private startCoordinator(instanceId: OrchestrationId, state: OrchestrationRunState): Promise<void> {
    this.assertAcceptingExecution();
    if (state.drivePromise) return state.drivePromise;
    const runId = crypto.randomUUID();
    state.runId = runId;
    let drivePromise!: Promise<void>;
    drivePromise = (async () => {
      await Promise.resolve();
      const controlVersion = this.getInstanceControlVersion(instanceId);
      let completed = false;
      let executionFailure: { error: unknown; originalError: unknown; profileFailure?: boolean; skillFailure?: boolean; workspaceFailure?: boolean; managedCleanupFailed?: boolean } | null = null;
      try {
        await this.executeDAG(instanceId, runId);
        completed = this.isActiveRun(instanceId, state, runId) && !this.stopping && !state.paused && !state.cancelled
          && this.getInstanceControlVersion(instanceId) === controlVersion && await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)?.status === "completed");
      } catch (e) {
        executionFailure = { error: e, originalError: e, skillFailure: isSkillRuntimeDiagnosticFailure(e), workspaceFailure: OrchestrationWorkspaceLogFailure.is(e) };
        // 描述构造也是诊断；失败进入同一保因 owner，finally 不再次检查未知对象。
        let profile: Record<string, unknown> | undefined;
        try {
          profile = describeOrchestrationProfileFailure(e); executionFailure.profileFailure = Boolean(profile);
          executionFailure.managedCleanupFailed = Boolean(profile && e instanceof Error
            && Object.getOwnPropertyDescriptor(e, "code")?.value === "MANAGED_SERVICE_FAILURE_LOG_FAILED"
            && Object.getOwnPropertyDescriptor(e, "message")?.value === "MANAGED_SERVICE_STARTUP_CLEANUP_FAILED");
        }
        catch (diagnosticError) {
          executionFailure.workspaceFailure = true;
          executionFailure.error = new OrchestrationWorkspaceLogFailure([e, diagnosticError], e, "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED");
          throw executionFailure.error;
        }
        if (state.cancelled) throw e;
        if (this.stopping) {
          try { await this.withDatabase(() => this.writeLifecycleLog(instanceId, "instance coordinator stopped after execution error", "orchestration_coordinator_stopped_with_error", "coordinator_stopped", {
            code: "orchestration_coordinator_stopped_with_error",
            requestId: state.requestId ?? profile?.requestId ?? `run:${runId}`, runId, instanceId,
            ...(profile ? { nodeId: profile.nodeId, attemptId: profile.attemptId } : {}),
          }, { error: e, title: "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED" })); } catch (diagnosticError) {
            executionFailure.workspaceFailure = true;
            executionFailure.error = diagnosticError;
            throw executionFailure.error;
          }
          throw e;
        }
        if (!this.isActiveRun(instanceId, state, runId)) { if (profile || executionFailure.workspaceFailure) throw e; return; }
        if (executionFailure.skillFailure || executionFailure.workspaceFailure) {
          let latest: OrchestrationInstance | null;
          try { latest = await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)); }
          catch (diagnosticError) {
            executionFailure.error = new AggregateError([e, diagnosticError], "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED", { cause: e });
            throw executionFailure.error;
          }
          if (!latest || this.isTerminalInstanceStatus(latest.status)) throw e;
        }
        try { await this.withDatabase(() => this.writeLifecycleLog(instanceId, "instance coordinator failed", "ORCHESTRATION_COORDINATOR_FAILED", "coordinator", {
          requestId: state.requestId ?? profile?.requestId ?? `run:${runId}`, runId, instanceId,
          ...(profile ? { nodeId: profile.nodeId, attemptId: profile.attemptId } : {}),
        }, { error: e, title: "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED" })); } catch (diagnosticError) {
          executionFailure.workspaceFailure = true;
          executionFailure.error = diagnosticError;
          throw executionFailure.error;
        }
        if (executionFailure.workspaceFailure) throw e;
        const error = e instanceof Error ? e.message : String(e);
        try {
          await this.withDatabase(() => {
          this.ctx.db.orchNodeAttempts.cancelActiveByInstance(instanceId, `实例协调器失败: ${error}`);
          this.updateInstanceStatus(instanceId, "failed");
          const latest = this.ctx.db.orchInstances.get(instanceId);
          if (latest) this.emitOrchEvent(latest, "orchestration.error", { instanceId, error, source: "instance_coordinator" });
          });
        } catch (diagnosticError) {
          if (!executionFailure.skillFailure) throw diagnosticError;
          executionFailure.error = new AggregateError([e, diagnosticError], "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED", { cause: e });
          throw executionFailure.error;
        }
        if (executionFailure.skillFailure) throw e;
      } finally {
        // 本片失败先收齐已启动节点；原协调器继续持有诊断和托管释放尾链。
        if (executionFailure?.skillFailure || executionFailure?.workspaceFailure) {
          const active = this.ensureActiveNodePromises(state), owned = [...active.entries()];
          const settled = await Promise.allSettled(owned.map(([, promise]) => promise));
          const failures = [executionFailure.error];
          for (let index = 0; index < owned.length; index++) {
            const [nodeId, promise] = owned[index]!, result = settled[index]!;
            const failure = result.status === "rejected" ? { error: result.reason } : isNodeExecutionFailure(result.value) ? { error: result.value.error } : null;
            if (failure && !Object.is(failure.error, executionFailure.originalError) && !failures.some(value => Object.is(value, failure.error))) failures.push(failure.error);
            if (active.get(nodeId) === promise) active.delete(nodeId);
          }
          if (failures.length > 1) executionFailure.error = executionFailure.workspaceFailure
            ? new OrchestrationWorkspaceLogFailure(failures, failures[0], "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED")
            : new AggregateError(failures, "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED", { cause: failures[0] });
        }
        if (!this.isActiveRun(instanceId, state, runId)) {
          if (executionFailure?.workspaceFailure && !executionFailure.managedCleanupFailed) {
            try { await this.disposeManagedRuntime(instanceId); }
            catch (cleanupError) { throw new OrchestrationWorkspaceLogFailure([executionFailure.error, cleanupError], executionFailure.error, "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED"); }
          }
          if (executionFailure?.profileFailure || executionFailure?.skillFailure || executionFailure?.workspaceFailure) throw executionFailure.error;
          return;
        }
        let latest: OrchestrationInstance | null;
        try { latest = await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)); }
        catch (diagnosticError) {
          if (!executionFailure?.skillFailure && !executionFailure?.workspaceFailure) throw diagnosticError;
          executionFailure.error = executionFailure.workspaceFailure
            ? new OrchestrationWorkspaceLogFailure([executionFailure.error, diagnosticError], executionFailure.error, "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED")
            : new AggregateError([executionFailure.error, diagnosticError], "ORCHESTRATION_COORDINATOR_DIAGNOSTIC_FAILED", { cause: executionFailure.error });
          latest = null;
        }
        if (!latest || this.isTerminalInstanceStatus(latest.status) || state.cancelled || executionFailure?.skillFailure || executionFailure?.workspaceFailure) {
          try {
            // 原 runtime 已尝试且失败的启动清理只交显式重试，不借诊断自动再清理。
            if (!executionFailure?.managedCleanupFailed) await this.disposeManagedRuntime(instanceId);
          } catch (cleanupError) {
            if (executionFailure?.workspaceFailure) throw new OrchestrationWorkspaceLogFailure([executionFailure.error, cleanupError], executionFailure.error, "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED");
            if (executionFailure) throw new AggregateError([executionFailure.error, cleanupError], "ORCHESTRATION_COORDINATOR_CLEANUP_FAILED", { cause: executionFailure.error });
            throw cleanupError;
          } finally {
            if (state.drivePromise === drivePromise) state.drivePromise = null;
            if (this.ensureActiveNodePromises(state).size === 0 && this.runningInstances.get(instanceId) === state) this.runningInstances.delete(instanceId);
          }
        } else if (state.drivePromise === drivePromise) {
          state.drivePromise = null;
        }
        if (executionFailure?.skillFailure || executionFailure?.workspaceFailure) throw executionFailure.error;
      }
      // 正常 finally 已移除 owner；只同步复核原控制与已提交终态，不再检查 isActiveRun。
      if (completed && !this.stopping && !state.paused && !state.cancelled && state.runId === runId
        && (!this.runningInstances.has(instanceId) || this.runningInstances.get(instanceId) === state)
        && this.getInstanceControlVersion(instanceId) === controlVersion) {
        await this.withDatabase(() => {
          const latest = this.ctx.db.orchInstances.get(instanceId);
          if (latest?.status === "completed") this.emitCompletionEvent(latest, state);
        });
      }
    })();
    state.drivePromise = drivePromise;
    return drivePromise;
  }

  /** 后台入口只发送唤醒信号；实例内始终由唯一协调器推进。 */
  private async continueRunInBackground(
    instanceId: OrchestrationId,
    state: OrchestrationRunState,
  ): Promise<void> {
    this.signalCoordinator(state);
    const activeDrive = state.drivePromise;
    if (activeDrive) {
      await activeDrive;
      if (state.drivePromise || !await this.withDatabase(() => this.hasPendingCoordinatorWork(instanceId, state))) return;
    }
    const pending: OrchestrationWorkPromise<void> = this.startCoordinator(instanceId, state).catch(async (error) => {
      if (OrchestrationCompletionEventFailure.is(error)) throw error;
      await this.withDatabase(() => this.emitBackgroundDriveError(instanceId, error));
      throw error;
    });
    this.continuationPromises.add(pending);
    void pending.then(() => { pending.settled = true; this.continuationPromises.delete(pending); }, () => { pending.settled = true; });
  }

  /** 协调器交接后检查尚未结算的节点 Promise 或新就绪节点，避免退出窗口丢失唤醒。 */
  private hasPendingCoordinatorWork(instanceId: OrchestrationId, state: OrchestrationRunState): boolean {
    if (this.stopping || this.runningInstances.get(instanceId) !== state || state.paused || state.cancelled) return false;
    if (this.ensureActiveNodePromises(state).size > 0) return true;
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance || this.isTerminalInstanceStatus(instance.status) || instance.status === "paused") return false;
    return this.findReadyNodes(instance.workflowSnapshot.nodes, instance.workflowSnapshot.edges, instance).length > 0;
  }

  /** 将人工启动后的续跑推到后台，避免启动接口等待后续节点执行。 */
  private scheduleActiveRunAfterManualStart(instanceId: OrchestrationId): void {
    this.scheduleDatabaseContinuation(
      instanceId,
      () => this.continueActiveRunAfterFeedback(instanceId),
      (error) => this.markManualStartContinuationFailed(instanceId, error),
    );
  }

  /** 将人工反馈后的续跑推到后台，避免反馈接口被后续节点执行耗时阻塞。 */
  private scheduleActiveRunAfterFeedback(instanceId: OrchestrationId): void {
    this.scheduleDatabaseContinuation(
      instanceId,
      () => this.continueActiveRunAfterFeedback(instanceId),
      (error) => this.markFeedbackContinuationFailed(instanceId, error),
    );
  }

  /** 跳过待启动节点后扫描就绪批次；实例仍可能因其他人工节点保持 waiting 状态。 */
  private scheduleReadyNodeBatchesAfterWaitingSkip(instanceId: OrchestrationId): void {
    this.scheduleDatabaseContinuation(
      instanceId,
      async () => {
        const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
        if (!latest || this.isTerminalInstanceStatus(latest.status)) return;
        const activeState = await this.ensureRecoverableActiveRunState(instanceId);
        if (activeState.paused || activeState.cancelled) return;
        await this.continueRunInBackground(instanceId, activeState);
      },
      (error) => this.markFeedbackContinuationFailed(instanceId, error),
    );
  }

  /** 原续跑 Promise 持完整任务、诊断及释放；失败结算后仍供公开 wait 消费。 */
  private scheduleDatabaseContinuation(
    instanceId: OrchestrationId,
    task: () => Promise<void>,
    onFailure: (error: unknown) => void,
  ): void {
    if (this.stopping) return;
    const finishActivity = this.beginContinuationActivity(instanceId);
    const continuationPromise: OrchestrationWorkPromise<void> = (async () => {
      let failure: { error: unknown } | undefined;
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (!this.stopping) await task();
      } catch (error) {
        failure = { error };
        if (!OrchestrationCompletionEventFailure.is(error)) {
          try {
            if (!this.stopping && !OrchestrationWorkspaceLogFailure.is(error)) await this.withDatabase(() => onFailure(error));
          } catch (handlerError) {
            failure.error = OrchestrationWorkspaceLogFailure.is(handlerError) ? handlerError
              : new AggregateError([error, handlerError], "ORCHESTRATION_CONTINUATION_HANDLER_FAILED", { cause: error });
          }
        }
      }
      try { await this.withDatabase(finishActivity); }
      catch (releaseError) {
        if (!failure) failure = { error: releaseError };
        else if (OrchestrationCompletionEventFailure.is(failure.error)) failure.error = new OrchestrationCompletionEventFailure([failure.error, releaseError], failure.error);
        else failure.error = OrchestrationWorkspaceLogFailure.is(failure.error)
          ? new OrchestrationWorkspaceLogFailure([failure.error, releaseError], failure.error)
          : new AggregateError([failure.error, releaseError], "ORCHESTRATION_CONTINUATION_RELEASE_FAILED", { cause: failure.error });
      }
      if (failure) {
        if (!OrchestrationCompletionEventFailure.is(failure.error)) (await this.withDatabase(() => this.writeLifecycleLog(instanceId, "database continuation owner failed", "orchestration_database_continuation_failed", "database_continuation", {
          requestId: `continuation:${instanceId}`,
        }, { error: failure.error })));
        throw failure.error;
      }
    })();
    this.continuationPromises.add(continuationPromise);
    void continuationPromise.then(() => { continuationPromise.settled = true; this.continuationPromises.delete(continuationPromise); }, () => { continuationPromise.settled = true; });
  }

  /** 按实例引用计数登记后台续跑活动，多次并发调度只暴露一个稳定阻断项。 */
  private beginContinuationActivity(instanceId: OrchestrationId): () => void {
    const existing = this.pendingContinuationActivities.get(instanceId);
    if (existing) {
      existing.count += 1;
      return this.createContinuationActivityRelease(instanceId, existing);
    }
    const instance = this.ctx.db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    const created = {
      count: 1,
      release: this.ctx.beginWorkspaceActivity?.(instance.workspaceId, instanceId) ?? (() => {}),
    };
    this.pendingContinuationActivities.set(instanceId, created);
    return this.createContinuationActivityRelease(instanceId, created);
  }

  /** 生成幂等释放器，并在最后一个后台续跑交接结束时释放迁移活动。 */
  private createContinuationActivityRelease(
    instanceId: OrchestrationId,
    activity: { count: number; release: () => void },
  ): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activity.count -= 1;
      if (activity.count > 0) return;
      if (this.pendingContinuationActivities.get(instanceId) !== activity) {
        throw new Error(`编排后台续跑活动 owner 不匹配: instanceId=${instanceId}`);
      }
      this.pendingContinuationActivities.delete(instanceId);
      activity.release();
    };
  }

  /** 人工启动后的后台续跑失败时显式落失败态并发出可检索错误事件。 */
  private markManualStartContinuationFailed(instanceId: OrchestrationId, error: unknown): void {
    this.writeLifecycleLog(instanceId, "manual start continuation failed", "ORCHESTRATION_MANUAL_START_CONTINUATION_FAILED", "manual_start_continuation", {
      requestId: `manual-start:${instanceId}`,
    }, { error });
    const message = error instanceof Error ? error.message : String(error);
    const latest = this.ctx.db.orchInstances.get(instanceId);
    if (!latest || this.isTerminalInstanceStatus(latest.status)) return;
    this.updateInstanceStatus(instanceId, "failed");
    this.emitOrchEvent(latest, "orchestration.error", {
      instanceId,
      error: message,
      source: "manual_start_continuation",
    });
  }

  /** 后台续跑失败时显式落失败态并发出可检索错误事件。 */
  private markFeedbackContinuationFailed(instanceId: OrchestrationId, error: unknown): void {
    this.writeLifecycleLog(instanceId, "feedback continuation failed", "ORCHESTRATION_FEEDBACK_CONTINUATION_FAILED", "feedback_continuation", {
      requestId: `feedback:${instanceId}`,
    }, { error });
    const message = error instanceof Error ? error.message : String(error);
    const latest = this.ctx.db.orchInstances.get(instanceId);
    if (!latest || this.isTerminalInstanceStatus(latest.status)) return;
    this.updateInstanceStatus(instanceId, "failed");
    this.emitOrchEvent(latest, "orchestration.error", {
      instanceId,
      error: message,
      source: "feedback_continuation",
    });
  }

  /** 人工反馈后的后台续跑仅排除终态和暂停；其他分支等待时仍推进独立 ready 分支。 */
  private async continueActiveRunAfterFeedback(instanceId: OrchestrationId): Promise<void> {
    const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!latest || this.isTerminalInstanceStatus(latest.status) || latest.status === "paused") return;
    const activeState = await this.ensureRecoverableActiveRunState(instanceId);
    const refreshed = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!refreshed || this.isTerminalInstanceStatus(refreshed.status) || refreshed.status === "paused") return;
    if (activeState.paused || activeState.cancelled) return;
    await this.continueRunInBackground(instanceId, activeState);
  }

  private ensureActiveRunState(
    instanceId: OrchestrationId,
  ): OrchestrationRunState {
    const existing = this.runningInstances.get(instanceId);
    if (existing) return existing;

    const created = this.createRunState();
    this.runningInstances.set(instanceId, created);
    return created;
  }

  /** 确保恢复续跑具备本地运行态，并在新建运行态前复查关闭闸门。 */
  private async ensureRecoverableActiveRunState(
    instanceId: OrchestrationId,
  ): Promise<OrchestrationRunState> {
    await this.ensureAssetRuntimeSnapshotForExecution(instanceId);
    this.assertAcceptingExecution();
    const hadExisting = this.runningInstances.has(instanceId);
    const activeState = this.ensureActiveRunState(instanceId);
    if (!hadExisting) {
      await this.reconcileRecoveredInstance(instanceId);
    }
    return activeState;
  }

  private isActiveRun(
    instanceId: OrchestrationId,
    state: OrchestrationRunState,
    runId: string,
  ): boolean {
    const active = this.runningInstances.get(instanceId);
    return active === state && active.runId === runId;
  }

  /** 对账仅处理本次非终态；无协调器时承担直接完成事件。 */
  private async reconcileRecoveredInstance(instanceId: OrchestrationId): Promise<void> {
    let instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!instance) return;
    if (this.isTerminalInstanceStatus(instance.status) || instance.status === "paused") return;
    const state = this.runningInstances.get(instanceId), controlVersion = this.getInstanceControlVersion(instanceId);

    for (const node of instance.workflowSnapshot.nodes) {
      instance = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId))) ?? instance;
      const nodeState = instance.nodeStates[node.id];
      if (!nodeState) continue;
      if (nodeState.status === "queued") {
        (await this.withDatabase(() => this.requeueRecoveredNode(instanceId, node, instance!, "节点在 client 重启前已被认领但尚未启动 turn，已重新排队")));
        continue;
      }
      if (node.type !== "role" && nodeState.status === "running") {
        (await this.withDatabase(() => this.requeueRecoveredNode(instanceId, node, instance!, "控制节点在 client 重启前未完成执行，已重新排队")));
        continue;
      }
      if (node.type !== "role" || !node.roleId) continue;
      if (nodeState.status !== "running"
        && nodeState.status !== "result-submitted"
        && nodeState.status !== "finalizing"
        && nodeState.status !== "artifact-writing"
        && nodeState.status !== "gate-checking") {
        continue;
      }

      const role = this.resolveRecoveredRoleDefinition(node, instance);
      if (!role) continue;
      await this.reconcileRecoveredRoleNode(instanceId, node, instance, role, nodeState);
    }

    const latest = (await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId)));
    if (!latest) return;
    if (!this.isTerminalInstanceStatus(latest.status) && latest.status !== "paused") {
      (await this.withDatabase(() => this.syncInstanceRuntimeStatus(instanceId, latest)));
      const outcome = this.resolveDagIdleOutcome(latest);
      if (outcome) {
        (await this.withDatabase(() => this.updateInstanceStatus(instanceId, outcome)));
        if (outcome !== "completed") (await this.withDatabase(() => this.emitOrchEvent(latest, "orchestration.completed", { instanceId, status: outcome })));
      }
    }
    if (latest.status === "completed" && !state?.drivePromise && !this.stopping && !state?.paused && !state?.cancelled
      && this.runningInstances.get(instanceId) === state && this.getInstanceControlVersion(instanceId) === controlVersion) {
      try { (await this.withDatabase(() => this.emitCompletionEvent(latest, state))); }
      finally {
        if (state && this.runningInstances.get(instanceId) === state && this.ensureActiveNodePromises(state).size === 0) this.runningInstances.delete(instanceId);
      }
    }
  }

  /** 精确核对节点最新 Attempt 与 canonical turn.error，禁止跨 thread/turn 猜测恢复。 */
  private resolveExactLatestAttemptError(
    instanceId: OrchestrationId,
    nodeId: string,
    nodeState: NodeExecutionState,
  ): {
    attempt: OrchNodeAttempt;
    threadId: ThreadId;
    turnId: TurnId;
    metadata: OrchestrationRecoveryErrorMetadata;
  } | null {
    const attemptId = this.resolveNodeAttemptId(nodeState);
    if (!attemptId) return null;
    const normalizedNodeId = String(nodeId ?? "").trim();
    if (!normalizedNodeId || normalizedNodeId !== String(nodeState.nodeId ?? "").trim()) return null;
    const attempt = this.ctx.db.orchNodeAttempts.getLatestByNode(instanceId, normalizedNodeId);
    if (!attempt
      || attempt.id !== attemptId
      || attempt.instanceId !== instanceId
      || attempt.nodeId !== normalizedNodeId) {
      return null;
    }
    const threadId = String(attempt.threadId ?? "").trim() as ThreadId;
    const turnId = String(attempt.turnId ?? "").trim() as TurnId;
    if (!threadId || !turnId) return null;
    const projectedThreadId = String(nodeState.threadId ?? "").trim();
    if (projectedThreadId && projectedThreadId !== String(threadId)) return null;
    const metadata = this.findErroredTurnMetadata(threadId, turnId);
    return metadata ? { attempt, threadId, turnId, metadata } : null;
  }

  /** 恢复已发出 turn 时沿用实例冻结的角色定义，不再追加本地 revision 准入。 */
  private resolveRecoveredRoleDefinition(
    node: WorkflowNode,
    instance: OrchestrationInstance,
  ): RoleDefinition | null {
    if (!node.roleId) return null;
    return this.resolveSnapshotRoleDefinitionForAttempt(instance, node.roleId);
  }

  /** 恢复读取与写回分别准入，等待门禁或角色结算时释放许可。 */
  private async reconcileRecoveredRoleNode(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    role: RoleDefinition,
    nodeState: NodeExecutionState,
  ): Promise<void> {
    const threadId = String(nodeState.threadId ?? "").trim();
    if (!threadId) {
      (await this.withDatabase(() => this.requeueRecoveredNode(instanceId, node, instance, "节点恢复时缺少 threadId，已重新排队")));
      return;
    }

    const persistedAttempt = (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.getLatestByNode(instanceId, node.id)));
    if (persistedAttempt?.submission
      && (persistedAttempt.status === "result-submitted" || persistedAttempt.status === "finalizing")) {
      (await this.withDatabase(() => this.restoreSubmittedAttemptProjection(instance, node, persistedAttempt)));
      await this.finalizeRecoveredRoleExecution(instanceId, node, instance, role, {
        rawOutput: persistedAttempt.responseText ?? "",
        finalAnswer: persistedAttempt.submission,
      }, persistedAttempt.id);
      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeRecovered", {
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        action: "submitted-attempt-replayed",
        attemptId: persistedAttempt.id,
        threadId: persistedAttempt.threadId ?? threadId,
        turnId: persistedAttempt.turnId,
      })));
      return;
    }

    const turns = (await this.withDatabase(() => this.ctx.db.turns.listByThread(threadId as ThreadId)));
    const latestTurn = turns.at(-1) ?? null;
    if (!latestTurn) {
      (await this.withDatabase(() => this.requeueRecoveredNode(instanceId, node, instance, "节点恢复时没有找到任何 turn 记录，已重新排队")));
      return;
    }

    if (latestTurn.status === "completed") {
      const recoveredExecution = (await this.withDatabase(() => this.findRecoverableExecutionFromTurn(instance, node, role, threadId as ThreadId, latestTurn.turnId)));
      if (!recoveredExecution) {
        (await this.withDatabase(() => this.requeueRecoveredNode(instanceId, node, instance, "节点恢复时未找到最终输出，已重新排队")));
        return;
      }

      const recoveredAttempt = (await this.withDatabase(() => this.ensureRecoveredSubmittedAttempt(
        instance,
        node,
        threadId as ThreadId,
        latestTurn.turnId,
        recoveredExecution,
      )));
      await this.finalizeRecoveredRoleExecution(instanceId, node, instance, role, {
        rawOutput: recoveredExecution.responseText,
        finalAnswer: recoveredExecution.finalAnswer,
      }, recoveredAttempt.id);
      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeRecovered", {
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        action: "completed-turn-replayed",
        threadId,
        turnId: latestTurn.turnId,
      })));
      return;
    }

    if (latestTurn.status === "error") {
      const metadata = (await this.withDatabase(() => this.findErroredTurnMetadata(threadId as ThreadId, latestTurn.turnId)));
      (await this.withDatabase(() => this.handleRecoveredRoleError(
        instanceId,
        node,
        instance,
        role,
        metadata?.message ?? "子线程执行失败",
        metadata?.code ?? null,
        threadId,
        latestTurn.turnId,
        metadata,
      )));
      return;
    }

    // Startup provider reconciliation may leave the exact turn running while its
    // terminal state is still unknown. Keep the existing Attempt and binding in
    // place until a later authoritative read or an explicit user action settles it.
    if (persistedAttempt
      && String(persistedAttempt.threadId ?? "").trim() === threadId
      && String(persistedAttempt.turnId ?? "").trim() === String(latestTurn.turnId)
      && latestTurn.status === "started") {
      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeRecovered", {
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        action: "provider-recovery-pending",
        attemptId: persistedAttempt.id,
        threadId,
        turnId: latestTurn.turnId,
      })));
      return;
    }

    (await this.withDatabase(() => this.requeueRecoveredNode(instanceId, node, instance, "节点在 client 重启前仍处于执行中，已重新排队")));
  }

  /** 将旧事件或已持久化提交恢复为正式 Attempt，供统一 finalizer 重放。 */
  private ensureRecoveredSubmittedAttempt(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    threadId: ThreadId,
    turnId: TurnId,
    execution: { rawOutput?: string; responseText: string; finalAnswer: NodeFinalAnswerPayload },
  ): OrchNodeAttempt {
    const latest = this.ctx.db.orchNodeAttempts.getLatestByNode(instance.id, node.id);
    if (latest?.submission
      && latest.threadId === String(threadId)
      && latest.turnId === String(turnId)
      && (latest.status === "result-submitted" || latest.status === "finalizing")) {
      this.restoreSubmittedAttemptProjection(instance, node, latest);
      return latest;
    }

    const started = this.beginNodeAttempt(instance.id, node, instance);
    this.ctx.db.orchNodeAttempts.bindExecution(started.id, threadId, turnId);
    const submitted = this.ctx.db.orchNodeAttempts.submit(started.id, execution.finalAnswer).attempt;
    this.ctx.db.orchNodeAttempts.saveResponseText(started.id, execution.responseText ?? execution.rawOutput ?? "");
    const recovered = this.ctx.db.orchNodeAttempts.get(started.id) ?? submitted;
    this.restoreSubmittedAttemptProjection(instance, node, recovered);
    this.emitOrchEvent(instance, "orchestration.nodeSubmissionRecovered", {
      instanceId: instance.id,
      nodeId: node.id,
      nodeLabel: node.label,
      attemptId: recovered.id,
      attemptNo: recovered.attemptNo,
      threadId,
      turnId,
    });
    return recovered;
  }

  /** 重放已接受提交；收尾失败时显式收敛节点与 Attempt，禁止恢复路径悬挂。 */
  private async finalizeRecoveredRoleExecution(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    role: RoleDefinition,
    execution: { rawOutput: string; finalAnswer: NodeFinalAnswerPayload },
    attemptId: string,
  ): Promise<void> {
    try {
      await this.finalizeRoleExecution(instanceId, node, instance, role, execution, attemptId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if ((await this.withDatabase(() => this.canContinueNodeAttempt(instanceId, node, attemptId, "recovery-finalize-error")))) {
        (await this.withDatabase(() => this.failSubmittedAttempt(instanceId, node, instance, attemptId, message)));
      }
      throw error;
    }
  }

  /** 重建已提交 Attempt 的节点投影，不改写提交真源。 */
  private restoreSubmittedAttemptProjection(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    attempt: OrchNodeAttempt,
  ): void {
    const latest = this.ctx.db.orchInstances.get(instance.id) ?? instance;
    const nodeState = latest.nodeStates[node.id] ?? instance.nodeStates[node.id];
    if (!nodeState) throw new Error(`恢复 Attempt 时节点状态不存在: ${node.id}`);
    nodeState.attemptId = attempt.id;
    nodeState.nodeExecutionId = attempt.id;
    nodeState.attemptNo = attempt.attemptNo;
    nodeState.submissionId = attempt.id;
    nodeState.humanActionSource = null;
    nodeState.error = null;
    nodeState.completedAt = null;
    latest.nodeStates[node.id] = nodeState;
    this.persistNodeState(instance.id, latest, node.id);
    instance.nodeStates = latest.nodeStates;
    this.updateNodeStatus(instance.id, node, latest, "result-submitted");
  }

  private handleRecoveredRoleError(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    role: RoleDefinition,
    error: string,
    errorCode: string | null,
    threadId: string,
    turnId: TurnId,
    recoveryMetadata?: OrchestrationRecoveryErrorMetadata | null,
  ): void {
    const getInstance = this.ctx.db.orchInstances.get;
    const latest = typeof getInstance === "function"
      ? getInstance.call(this.ctx.db.orchInstances, instanceId) ?? instance
      : instance;
    const latestNodeState = latest.nodeStates[node.id];
    const maxRetries = this.resolveExecutionPrefs(latest, role, []).maxRetries ?? 0;
    const normalizedRecovery = recoveryMetadata ?? normalizeOrchestrationRecoveryMetadata({
      message: error,
      code: errorCode,
      providerThreadId: latestNodeState?.providerThreadId,
      recoveryReason: latestNodeState?.recoveryReason,
      preserveBinding: latestNodeState?.preserveBinding,
      userChoiceRequired: latestNodeState?.userChoiceRequired,
      recoveryStrategies: latestNodeState?.recoveryStrategies,
    });
    if (latestNodeState && latestNodeState.retryCount < maxRetries) {
      const parentExecutionId = this.resolveNodeAttemptId(latestNodeState);
      this.finishNodeAttempt(latest, node.id, node.label, latestNodeState, "failed", error);
      latestNodeState.retryCount += 1;
      this.resetNodeForRetry(latestNodeState, latestNodeState.activeFeedbackRecordIds ?? null);
      latestNodeState.status = "ready";
      latest.nodeStates[node.id] = latestNodeState;
      this.beginNodeAttempt(instanceId, node, latest, parentExecutionId);
      this.ctx.db.orchInstances.updateNodeStates(instanceId, latest.nodeStates);
      this.emitNodeStateChanged(latest, node.id, node.label, "ready");
      this.emitOrchEvent(latest, "orchestration.nodeRecovered", {
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        action: "retry-queued-after-error",
        threadId,
        turnId,
        error,
      });
      return;
    }

    this.ctx.db.orchNodeAttempts.invalidateActiveByNode(instanceId, node.id, error);
    this.applyRoleFailurePolicy(instanceId, node, latest, error, {
      source: "execution",
      recoveryMetadata: normalizedRecovery,
    });
    this.writeLifecycleLog(latest, "recovered role execution failed", errorCode ?? "orchestration_recovered_role_execution_failed", "role_recovery", {
      code: errorCode ?? "orchestration_recovered_role_execution_failed",
      requestId: `recovery:${instanceId}:${this.resolveNodeAttemptId(latestNodeState) ?? node.id}`,
      instanceId,
      nodeId: node.id,
      threadId,
      turnId,
      attemptId: this.resolveNodeAttemptId(latestNodeState),
    }, { error });
    this.emitOrchEvent(latest, "orchestration.nodeRecovered", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      action: "failed-after-recovery",
      threadId,
      turnId,
      error,
    });
  }

  private requeueRecoveredNode(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    reason: string,
  ): void {
    const latest = this.ctx.db.orchInstances.get(instanceId) ?? instance;
    const latestNodeState = latest.nodeStates[node.id];
    if (!latestNodeState) return;
    const parentExecutionId = this.resolveNodeAttemptId(latestNodeState);
    this.ctx.db.orchNodeAttempts.invalidateActiveByNode(instanceId, node.id, reason);
    latestNodeState.status = "ready";
    latestNodeState.error = null;
    latestNodeState.errorCode = null;
    latestNodeState.startedAt = null;
    latestNodeState.completedAt = null;
    latestNodeState.attemptId = null;
    latestNodeState.nodeExecutionId = null;
    latestNodeState.submissionId = null;
    latestNodeState.parentExecutionId = parentExecutionId;
    latest.nodeStates[node.id] = latestNodeState;
    this.ctx.db.orchInstances.updateNodeStates(instanceId, latest.nodeStates);
    this.emitNodeStateChanged(latest, node.id, node.label, "ready");
    this.emitOrchEvent(latest, "orchestration.nodeRecovered", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      action: "requeued",
      threadId: latestNodeState.threadId ?? null,
      reason,
    });
  }

  /** Returns only instances whose master or node thread explicitly matches this thread. */
  private listInstancesBoundToThread(threadId: ThreadId): OrchestrationInstance[] {
    const seen = new Set<string>();
    const instances: OrchestrationInstance[] = [];
    const normalizedThreadId = String(threadId ?? "").trim();
    const addIfBound = (instance: OrchestrationInstance): void => {
      if (seen.has(instance.id)) return;
      const isBound = String(instance.masterThreadId ?? "").trim() === normalizedThreadId
        || Object.values(instance.nodeStates).some(
          (nodeState) => String(nodeState.threadId ?? "").trim() === normalizedThreadId,
        );
      if (!isBound) return;
      seen.add(instance.id);
      instances.push(instance);
    };

    const persistedThread = this.ctx.db.threads?.get?.(threadId) ?? null;
    if (persistedThread) {
      for (const instance of this.ctx.db.orchInstances.listByWorkspace?.(persistedThread.workspaceId) ?? []) {
        addIfBound(instance);
      }
    }

    for (const instanceId of this.runningInstances.keys()) {
      const instance = this.ctx.db.orchInstances.get(instanceId);
      if (!instance) continue;
      addIfBound(instance);
    }

    return instances;
  }

  /** 释放实例名下全部托管服务。 */
  private async disposeManagedRuntime(instanceId: OrchestrationId): Promise<void> {
    await this.managedServiceRuntime.disposeInstanceServices(instanceId);
  }

  /** 原 Set 持诊断与必要释放整链；保留终止前因和清理副错供公开 wait 消费。 */
  private disposeManagedRuntimeInBackground(instanceId: OrchestrationId, source: string, previous?: { error: unknown }): void {
    const disposalPromise: OrchestrationWorkPromise<void> = this.disposeManagedRuntime(instanceId).catch(async (error) => {
      await this.withDatabase(() => this.writeLifecycleLog(instanceId, "managed runtime disposal failed", "orchestration_managed_runtime_disposal_failed", "managed_runtime_disposal", {
        code: "orchestration_managed_runtime_disposal_failed",
        requestId: `managed-runtime-disposal:${instanceId}:${source}`,
        instanceId,
        source,
      }, { error, title: "ORCHESTRATION_MANAGED_RUNTIME_DISPOSAL_DIAGNOSTIC_FAILED" }));
      throw error;
    }).then(() => { if (previous) throw previous.error; }, error => {
      if (previous) throw new OrchestrationWorkspaceLogFailure([previous.error, error], previous.error);
      throw error;
    });
    this.managedRuntimeDisposalPromises.add(disposalPromise);
    void disposalPromise.then(() => { disposalPromise.settled = true; this.managedRuntimeDisposalPromises.delete(disposalPromise); }, () => { disposalPromise.settled = true; });
  }

  /** 从节点投影捕获同一 Codex binding；只释放明确标记为保留的恢复门禁。 */
  private captureCodexRecoveryFenceBinding(nodeState: NodeExecutionState | null | undefined): CodexRecoveryFenceBinding | null {
    if (!nodeState || nodeState.preserveBinding !== true) return null;
    const threadId = String(nodeState.threadId ?? "").trim();
    const providerThreadId = String(nodeState.providerThreadId ?? "").trim();
    if (!threadId || !providerThreadId) return null;
    return { threadId: threadId as ThreadId, providerThreadId: providerThreadId as SessionId };
  }

  /** 收集实例内去重的恢复 binding，供实例级终止动作统一解锁。 */
  private collectCodexRecoveryFenceBindings(instance: OrchestrationInstance): CodexRecoveryFenceBinding[] {
    const bindings = new Map<string, CodexRecoveryFenceBinding>();
    for (const nodeState of Object.values(instance.nodeStates)) {
      const binding = this.captureCodexRecoveryFenceBinding(nodeState);
      if (binding) bindings.set(`${binding.threadId}\u0000${binding.providerThreadId}`, binding);
    }
    return Array.from(bindings.values());
  }

  /** 终态后收齐全部已捕获 fence；独立失败保序返回，不跳过其他必要释放。 */
  private releaseCodexRecoveryFences(instance: OrchestrationInstance, bindings: CodexRecoveryFenceBinding[], action: string): void {
    const failures: unknown[] = [];
    for (const binding of bindings) {
      try {
        const released = this.ctx.sessions.releaseCodexRecoveryPending(binding.threadId, binding.providerThreadId);
        if (released) continue;
        this.writeLifecycleLog(instance, "failed to release Codex recovery fence after terminal action", "codex_recovery_fence_release_failed", "recovery_fence_release", {
          code: "codex_recovery_fence_release_failed",
          requestId: `recovery-fence:${instance.id}:${action}`,
          action,
          threadId: binding.threadId,
          providerThreadId: binding.providerThreadId,
          rootCause: "runtime binding no longer matched the persisted recovery binding",
        });
      } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new OrchestrationWorkspaceLogFailure(failures, failures[0]);
  }

  /** 根据节点状态同步实例运行态，并标记实例级提醒变化。 */
  private syncInstanceRuntimeStatus(instanceId: OrchestrationId, instance: OrchestrationInstance): void {
    if (this.isTerminalInstanceStatus(instance.status)) return;
    if (instance.status === "paused") return;

    const nextStatus = this.deriveActiveInstanceStatus(instance);
    if (!nextStatus || nextStatus === instance.status) return;
    const previousStatus = instance.status;
    instance.status = nextStatus;
    this.ctx.db.orchInstances.updateStatus(instanceId, nextStatus);
    this.notifyReminderChangedForInstanceStatus(instance.workspaceId, previousStatus, nextStatus);
    this.notifyChatWorkflowStatusChanged(instance, nextStatus);
  }

  /** 更新实例状态，并在待办派生结果可能变化时发出提醒脏标记。 */
  private updateInstanceStatus(instanceId: OrchestrationId, status: OrchestrationInstance["status"]): void {
    const before = this.ctx.db.orchInstances.get(instanceId);
    this.ctx.db.orchInstances.updateStatus(instanceId, status);
    if (!before) return;
    this.notifyReminderChangedForInstanceStatus(before.workspaceId, before.status, status);
    this.notifyOrchestrationCompletionIfNeeded(before, status);
    this.notifyChatWorkflowStatusChanged(before, status);
  }

  /**
   * 通知会话工作流的源会话行刷新活跃标签。
   * 仅当实例被会话工作流任务绑定时才发事件；普通编排实例解析不到绑定，直接返回。
   */
  private notifyChatWorkflowStatusChanged(instance: OrchestrationInstance, status: OrchestrationInstance["status"]): void {
    const binding = this.ctx.resolveChatWorkflowBinding?.(instance.id);
    if (!binding) return;
    this.emitOrchEvent(instance, "orchestration.chatWorkflowStatusChanged", {
      instanceId: instance.id,
      threadId: binding.threadId,
      taskId: binding.taskId,
      status,
    });
  }

  /** 节点进入或离开人工处理态时，提醒结果会变化。 */
  private notifyReminderChangedForNodeStatus(
    workspaceId: WorkspaceId,
    previousStatus: NodeExecutionStatus | null,
    nextStatus: NodeExecutionStatus,
  ): void {
    if (!this.isReminderNodeStatus(previousStatus) && !this.isReminderNodeStatus(nextStatus)) return;
    this.ctx.notifyReminderChanged?.(workspaceId);
  }

  /** 实例进入或离开完成/失败/暂停态时，提醒结果会变化。 */
  private notifyReminderChangedForInstanceStatus(
    workspaceId: WorkspaceId,
    previousStatus: OrchestrationInstance["status"] | null,
    nextStatus: OrchestrationInstance["status"],
  ): void {
    if (!this.isReminderInstanceStatus(previousStatus) && !this.isReminderInstanceStatus(nextStatus)) return;
    this.ctx.notifyReminderChanged?.(workspaceId);
  }

  /** 判断节点状态是否会直接派生待办项。 */
  private isReminderNodeStatus(status: NodeExecutionStatus | null | undefined): boolean {
    return status === "waiting-start" || status === "waiting-feedback" || status === "waiting-approval";
  }

  /** 判断实例状态是否会直接派生待办项。 */
  private isReminderInstanceStatus(status: OrchestrationInstance["status"] | null | undefined): boolean {
    return status === "completed" || status === "failed" || status === "paused";
  }

  /** 完成事实不回滚；通知失败保留在原 continuation，供等待及关闭显式消费。 */
  private notifyOrchestrationCompletionIfNeeded(
    before: OrchestrationInstance,
    nextStatus: OrchestrationInstance["status"],
  ): void {
    const notifier = this.ctx.reminderCompletionNotifier;
    if (!notifier || before.status === "completed" || nextStatus !== "completed") return;
    const latest = this.ctx.db.orchInstances.get(before.id) ?? before;
    const workspace = this.ctx.db.workspaces.get(latest.workspaceId);
    const title = String(latest.intakeSnapshot.title ?? latest.intakeSnapshot.goal ?? "").trim() || "未命名需求";
    const pending: OrchestrationWorkPromise<void> = Promise.resolve().then(() => notifier.notifyCompletion({
      notificationKey: `orch:${latest.id}:completed`,
      sourceType: "orchestration",
      workspaceId: latest.workspaceId,
      workspaceTitle: workspace?.title ?? String(latest.workspaceId),
      title,
      summary: "编排执行已完成，等待您查看结果。",
      targetId: String(latest.id),
      completedAt: Number(latest.updatedAt ?? Date.now()),
      sharedWorkspaceId: this.resolveSharedWorkspaceIdForReminder(latest),
      recipientUserIds: this.resolveCompletionReminderRecipientUserIds(latest),
    })).catch(async (error) => {
      await this.withDatabase(() => this.writeLifecycleLog(latest, "completion external notification failed", "ORCHESTRATION_COMPLETION_NOTIFICATION_FAILED", "completion_notification", {}, { error }));
      throw error;
    });
    this.continuationPromises.add(pending);
    void pending.then(() => { pending.settled = true; this.continuationPromises.delete(pending); }, () => { pending.settled = true; });
  }

  /** 待办通知失败沿原 continuation 收口，节点已提交的状态保持真实。 */
  private notifyOrchestrationActionIfNeeded(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    nodeState: NodeExecutionState,
    previousStatus: NodeExecutionStatus | null,
    nextStatus: NodeExecutionStatus,
  ): void {
    const notifier = this.ctx.reminderCompletionNotifier;
    if (!notifier || previousStatus === nextStatus || !this.isReminderNodeStatus(nextStatus)) return;
    const descriptor = this.describeReminderAction(nextStatus, nodeState);
    if (!descriptor) return;
    const workspace = this.ctx.db.workspaces.get(instance.workspaceId);
    const title = getTaskIntakeTitle(instance.intakeSnapshot);
    const occurredAt = Date.now();
    const pending: OrchestrationWorkPromise<void> = Promise.resolve().then(() => notifier.notifyAction({
      notificationKey: `orch:${instance.id}:${descriptor.kind}:${node.id}:${occurredAt}`,
      sourceType: "orchestration",
      workspaceId: instance.workspaceId,
      workspaceTitle: workspace?.title ?? String(instance.workspaceId),
      title,
      summary: `${node.label} · ${descriptor.detailLabel}`,
      targetId: String(instance.id),
      statusLabel: descriptor.statusLabel,
      actionLabel: descriptor.actionLabel,
      occurredAt,
      sharedWorkspaceId: this.resolveSharedWorkspaceIdForReminder(instance),
      recipientUserIds: this.resolveActionReminderRecipientUserIds(instance, nodeState),
    })).catch(async (error) => {
      await this.withDatabase(() => this.writeLifecycleLog(instance, "action external notification failed", "ORCHESTRATION_ACTION_NOTIFICATION_FAILED", "action_notification", {
        nodeId: node.id,
        nodeStatus: nextStatus,
        notificationKind: descriptor.kind,
      }, { error }));
      throw error;
    });
    this.continuationPromises.add(pending);
    void pending.then(() => { pending.settled = true; this.continuationPromises.delete(pending); }, () => { pending.settled = true; });
  }

  /** 读取共享区 ID，仅共享编排通知需要 Server 成员校验。 */
  private resolveSharedWorkspaceIdForReminder(instance: OrchestrationInstance): string | null {
    const profileScope = instance.runtimeConfig?.executionProfileScope;
    return String(instance.sharedContext?.sharedWorkspaceId ?? instance.intakeSnapshot.sharedContext?.sharedWorkspaceId ?? (profileScope?.scopeType === "shared_workspace" ? profileScope.scopeId : null) ?? "").trim() || null;
  }

  /** 流程完成通知优先发给发起人，共享上下文 owner 仅作回退。 */
  private resolveCompletionReminderRecipientUserIds(instance: OrchestrationInstance): string[] | null {
    const initiatorUserIds = normalizeNodeAssigneeUserIds([instance.runtimeConfig?.initiatorUserId]);
    if (initiatorUserIds?.length) return initiatorUserIds;
    return normalizeNodeAssigneeUserIds([instance.sharedContext?.ownerUserId ?? instance.intakeSnapshot.sharedContext?.ownerUserId]);
  }

  /** 节点待办通知优先发给节点处理人，未指定时沿用完成通知收件人。 */
  private resolveActionReminderRecipientUserIds(instance: OrchestrationInstance, nodeState: NodeExecutionState): string[] | null {
    const assigneeUserIds = normalizeNodeAssigneeUserIds(nodeState.assigneeUserIds);
    if (assigneeUserIds?.length) return assigneeUserIds;
    return this.resolveCompletionReminderRecipientUserIds(instance);
  }

  /** 将人工待办节点状态转换为外部通知展示字段。 */
  private describeReminderAction(
    status: NodeExecutionStatus,
    nodeState: NodeExecutionState,
  ): { kind: "start" | "feedback" | "approval"; statusLabel: string; detailLabel: string; actionLabel: string } | null {
    if (status === "waiting-start") {
      return {
        kind: "start",
        statusLabel: "待启动",
        detailLabel: "等待人工启动",
        actionLabel: "启动节点",
      };
    }
    if (status === "waiting-approval") {
      const awaitingRework = nodeState.conclusion?.nextAction === "rework";
      return {
        kind: "approval",
        statusLabel: awaitingRework ? "待确认退回" : "待审核",
        detailLabel: awaitingRework ? "建议退回，等待人工确认" : "等待人工审核",
        actionLabel: awaitingRework ? "查看结果并决策" : "查看结果并审核",
      };
    }
    if (status === "waiting-feedback") {
      return this.describeFeedbackReminderAction(nodeState);
    }
    return null;
  }

  /** 根据人工介入来源生成 waiting-feedback 的外部通知展示字段。 */
  private describeFeedbackReminderAction(
    nodeState: NodeExecutionState,
  ): { kind: "feedback"; statusLabel: string; detailLabel: string; actionLabel: string } {
    const source = nodeState.humanActionSource ?? null;
    if (source === "human_input") {
      return { kind: "feedback", statusLabel: "待补充", detailLabel: "等待补充输入", actionLabel: "补充反馈" };
    }
    if (source === "branch_decision") {
      return { kind: "feedback", statusLabel: "待选分支", detailLabel: "等待人工选择分支", actionLabel: "选择分支" };
    }
    if (source === "review") {
      return { kind: "feedback", statusLabel: "待决策", detailLabel: "等待人工决策", actionLabel: "查看结果并决策" };
    }
    if (source === "gate") {
      return { kind: "feedback", statusLabel: "门禁未过", detailLabel: "等待人工处理门禁结果", actionLabel: "处理门禁结果" };
    }
    if (source === "execution") {
      return { kind: "feedback", statusLabel: "异常中断", detailLabel: "会话异常中断，等待人工处理", actionLabel: "补充反馈" };
    }
    return { kind: "feedback", statusLabel: "待处理", detailLabel: "等待人工处理", actionLabel: "查看并处理" };
  }

  private deriveActiveInstanceStatus(instance: OrchestrationInstance): OrchestrationInstance["status"] | null {
    const statuses = instance.workflowSnapshot.nodes.map((node) => instance.nodeStates[node.id]?.status ?? "pending");
    if (statuses.includes("waiting-approval")) return "waiting-approval";
    if (statuses.includes("waiting-feedback")) return "waiting-feedback";
    if (statuses.includes("waiting-start")) return "waiting-start";

    const outcome = this.resolveDagIdleOutcome(instance);
    if (outcome) return outcome;
    const hasProgress = statuses.some((status) =>
      status !== "pending" && status !== "ready" && status !== "queued");
    if (!hasProgress) return "pending";
    return "running";
  }

  private findRecoverableExecutionFromTurn(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    threadId: ThreadId,
    turnId: TurnId,
  ): { responseText: string; finalAnswer: NodeFinalAnswerPayload } | null {
    const responseText = this.findCompletedTurnResponseText(threadId, turnId) ?? "";
    const finalAnswer = this.findSubmittedNodeResultFromTurn(instance, node, role, threadId, turnId);
    if (!finalAnswer) return null;
    return {
      responseText,
      finalAnswer,
    };
  }

  private findSubmittedNodeResultFromTurn(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    threadId: ThreadId,
    turnId: TurnId,
  ): NodeFinalAnswerPayload | null {
    const events = this.findTurnConversationEvents(threadId, turnId);
    if (!events.length) return null;
    const outputMode = node.outputArtifactMode ?? inferRoleArtifactOutputMode(role.outputDefinition);
    const acceptedToolItemIds = new Set<string>();

    for (const event of events) {
      if (event?.type !== "item.tool.completed") continue;
      const toolName = String((event.payload as any)?.toolName ?? "").trim();
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      if (!itemId || !isNodeResultSubmissionToolName(toolName)) continue;
      const status = String((event.payload as any)?.status ?? "").trim().toLowerCase();
      const accepted = (event.payload as any)?.output?.accepted;
      if ((status && status !== "completed") || accepted !== true) continue;
      acceptedToolItemIds.add(itemId);
    }

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "item.tool.started") continue;
      const toolName = String((event.payload as any)?.toolName ?? "").trim();
      const itemId = String((event.payload as any)?.itemId ?? "").trim();
      if (!itemId || !isNodeResultSubmissionToolName(toolName) || !acceptedToolItemIds.has(itemId)) continue;
      try {
        const submission = this.normalizeNodeResultSubmission((event.payload as any)?.input, outputMode);
        this.validateFinalAnswerSemantics(instance, node, role, submission, this.resolveOutputArtifactSpec(node, role).kind);
        return submission;
      } catch {
        return null;
      }
    }
    return null;
  }

  private findTurnConversationEvents(threadId: ThreadId, turnId: TurnId): ConversationEventInput[] {
    const events = this.ctx.db.conversationEvents.listByThread(threadId, { limit: 4000 }) as ConversationEventInput[];
    let terminalIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "turn.completed" && event?.type !== "turn.error") continue;
      const eventTurnId = String((event.payload as any)?.turnId ?? "").trim();
      if (eventTurnId !== String(turnId)) continue;
      terminalIndex = index;
      break;
    }
    if (terminalIndex < 0) return [];

    let startIndex = -1;
    for (let index = terminalIndex; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "turn.started") continue;
      const eventTurnId = String((event.payload as any)?.turnId ?? "").trim();
      if (eventTurnId !== String(turnId)) continue;
      startIndex = index;
      break;
    }
    if (startIndex < 0) return [];
    return events.slice(startIndex, terminalIndex + 1);
  }

  private findCompletedTurnResponseText(threadId: ThreadId, turnId: TurnId): string | null {
    const events = this.ctx.db.conversationEvents.listByThread(threadId, { limit: 4000 });
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "turn.completed") continue;
      const eventTurnId = String((event.payload as any)?.turnId ?? "").trim();
      if (eventTurnId !== String(turnId)) continue;
      const responseText = String((event.payload as any)?.result?.responseText ?? "").trim();
      if (responseText) return responseText;
    }
    return null;
  }

  /** 读取指定 turn 的结构化失败信息，恢复逻辑禁止根据展示文案猜测错误类型。 */
  private findErroredTurnMetadata(threadId: ThreadId, turnId: TurnId): OrchestrationRecoveryErrorMetadata | null {
    const events = this.ctx.db.conversationEvents.listByThread(threadId, { limit: 4000 });
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "turn.error") continue;
      const eventTurnId = String((event.payload as any)?.turnId ?? "").trim();
      if (eventTurnId !== String(turnId)) continue;
      const message = String((event.payload as any)?.error ?? "").trim();
      const code = String((event.payload as any)?.code ?? "").trim() || null;
      if (message || code) {
        return normalizeOrchestrationRecoveryMetadata({
          message: message || "子线程执行失败",
          code,
          providerThreadId: (event.payload as any)?.providerThreadId,
          recoveryReason: (event.payload as any)?.recoveryReason,
          preserveBinding: (event.payload as any)?.preserveBinding,
          userChoiceRequired: (event.payload as any)?.userChoiceRequired,
          recoveryStrategies: (event.payload as any)?.recoveryStrategies,
        });
      }
    }
    return null;
  }

  private resolveDagIdleOutcome(instance: OrchestrationInstance): "completed" | "failed" | null {
    const statuses = instance.workflowSnapshot.nodes.map((node) => instance.nodeStates[node.id]?.status ?? "pending");
    const hasWaitingStart = statuses.includes("waiting-start");
    const hasWaitingFeedback = statuses.includes("waiting-feedback");
    const hasWaitingApproval = statuses.includes("waiting-approval");
    if (hasWaitingStart || hasWaitingFeedback || hasWaitingApproval) return null;

    const hasActive = statuses.some((status) =>
      status === "queued"
      || status === "running"
      || status === "result-submitted"
      || status === "finalizing"
      || status === "artifact-writing"
      || status === "gate-checking");
    if (hasActive) return null;

    const hasFailed = statuses.includes("failed");
    const allTerminal = statuses.every((status) =>
      status === "completed" || status === "skipped" || status === "failed" || status === "cancelled");

    if (allTerminal) return hasFailed ? "failed" : "completed";
    if (hasFailed) return "failed";
    return null;
  }

  private isTerminalInstanceStatus(status: OrchestrationInstance["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  /** 创建或复用持久化 Attempt，并把同一个 ID 投影为运行度量身份。 */
  private beginNodeAttempt(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    parentExecutionId: string | null = null,
  ): OrchNodeAttempt {
    const getInstance = this.ctx.db.orchInstances.get;
    const latest = typeof getInstance === "function"
      ? getInstance.call(this.ctx.db.orchInstances, instanceId) ?? instance
      : instance;
    this.requireAssetRuntimeSnapshot(latest);
    const persistedNodeState = latest.nodeStates[node.id];
    const requestedNodeState = instance.nodeStates[node.id];
    if (!persistedNodeState && !requestedNodeState) throw new Error(`节点状态不存在，无法绑定 Attempt: ${node.id}`);
    const nodeState: NodeExecutionState = {
      ...(persistedNodeState ?? requestedNodeState!),
      ...(requestedNodeState ?? persistedNodeState!),
    };

    const projectedIds = Array.from(new Set([
      String(nodeState.attemptId ?? "").trim(),
      String(nodeState.nodeExecutionId ?? "").trim(),
    ].filter(Boolean)));
    const current = projectedIds
      .map((id) => this.ctx.db.orchNodeAttempts.get(id))
      .find((attempt): attempt is OrchNodeAttempt => Boolean(
        attempt
        && attempt.instanceId === instanceId
        && attempt.nodeId === node.id
        && this.ctx.db.orchNodeAttempts.isCurrent(instanceId, node.id, attempt.id),
      )) ?? null;
    if (current) {
      const legacyExecutionId = projectedIds.find((id) => id !== current.id) ?? null;
      nodeState.attemptId = current.id;
      nodeState.nodeExecutionId = current.id;
      nodeState.attemptNo = current.attemptNo;
      nodeState.submissionId = current.submission ? current.id : null;
      nodeState.parentExecutionId = parentExecutionId
        ?? nodeState.parentExecutionId
        ?? legacyExecutionId;
      latest.nodeStates[node.id] = nodeState;
      this.persistNodeState(instanceId, latest, node.id);
      instance.nodeStates = latest.nodeStates;
      return current;
    }

    const legacyExecutionId = String(nodeState.nodeExecutionId ?? nodeState.attemptId ?? "").trim() || null;
    const persistedLegacyAttempt = legacyExecutionId
      ? this.ctx.db.orchNodeAttempts.get(legacyExecutionId)
      : null;
    const adoptLegacyExecutionId = legacyExecutionId && !persistedLegacyAttempt
      ? legacyExecutionId
      : null;
    const legacyExecutionBelongsToNode = !persistedLegacyAttempt
      || (persistedLegacyAttempt.instanceId === instanceId && persistedLegacyAttempt.nodeId === node.id);
    const projectedAttemptNo = Number(nodeState.attemptNo ?? 0);
    const attempt = this.ctx.db.orchNodeAttempts.begin({
      instanceId,
      nodeId: node.id,
      invalidationReason: "同节点开始新一轮执行",
      id: adoptLegacyExecutionId,
      attemptNo: Number.isFinite(projectedAttemptNo) && projectedAttemptNo > 0
        ? projectedAttemptNo + (adoptLegacyExecutionId ? 0 : 1)
        : null,
    });
    nodeState.attemptId = attempt.id;
    nodeState.nodeExecutionId = attempt.id;
    nodeState.attemptNo = attempt.attemptNo;
    nodeState.submissionId = null;
    nodeState.parentExecutionId = parentExecutionId
      ?? nodeState.parentExecutionId
      ?? (!adoptLegacyExecutionId && legacyExecutionBelongsToNode && legacyExecutionId !== attempt.id
        ? legacyExecutionId
        : null);
    latest.nodeStates[node.id] = nodeState;
    this.persistNodeState(instanceId, latest, node.id);
    instance.nodeStates = latest.nodeStates;
    this.emitOrchEvent(latest, "orchestration.nodeAttemptStarted", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      attemptId: attempt.id,
      nodeExecutionId: attempt.id,
      attemptNo: attempt.attemptNo,
      parentExecutionId: nodeState.parentExecutionId ?? null,
    });
    return attempt;
  }

  /** 将已持久化提交投影到节点状态；投影成功后工具才返回 accepted=true。 */
  private projectSubmittedNodeAttempt(instance: OrchestrationInstance, node: WorkflowNode, attempt: OrchNodeAttempt): void {
    const instanceId = instance.id;
    const getInstance = this.ctx.db.orchInstances.get;
    const latest = typeof getInstance === "function"
      ? getInstance.call(this.ctx.db.orchInstances, instanceId) ?? instance
      : instance;
    const nodeState = latest.nodeStates[node.id];
    if (!nodeState || this.resolveNodeAttemptId(nodeState) !== attempt.id) {
      throw new Error(`节点 Attempt 已被替换，拒绝投影迟到提交: nodeId=${node.id}, attemptId=${attempt.id}`);
    }
    nodeState.attemptId = attempt.id;
    nodeState.nodeExecutionId = attempt.id;
    nodeState.attemptNo = attempt.attemptNo;
    nodeState.submissionId = attempt.id;
    latest.nodeStates[node.id] = nodeState;
    this.persistNodeState(instanceId, latest, node.id);
    this.updateNodeStatus(instanceId, node, latest, "result-submitted");
    instance.nodeStates = latest.nodeStates;
  }

  /** 判断 Attempt 是否仍拥有节点写回权；失效结果必须记录事件，禁止静默丢弃。 */
  private canContinueNodeAttempt(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    attemptId: string,
    phase: string,
  ): boolean {
    this.assertNoWorkspaceLogFailure(instanceId);
    const attempt = this.ctx.db.orchNodeAttempts.get(attemptId);
    if (!attempt) throw new Error(`节点 Attempt 不存在: ${attemptId}`);
    const latest = this.ctx.db.orchInstances.get(instanceId);
    const projectedAttemptId = this.resolveNodeAttemptId(latest?.nodeStates[node.id] ?? null);
    const accepted = attempt.instanceId === instanceId
      && attempt.nodeId === node.id
      && projectedAttemptId === attemptId
      && this.ctx.db.orchNodeAttempts.isCurrent(instanceId, node.id, attemptId)
      && latest?.status !== "cancelled"
      && latest?.status !== "failed";
    if (accepted) return true;
    this.emitRejectedNodeAttemptContinuation(latest ?? null, node, attemptId, phase, attempt.lastError);
    return false;
  }

  /** 已结算诊断沿原活动 Promise 阻止同实例迟到业务写，清理仍由原 drive 收齐。 */
  private assertNoWorkspaceLogFailure(instanceId: OrchestrationId): void {
    const active = this.runningInstances.get(instanceId)?.activeNodePromises;
    for (const promise of active?.values() ?? []) {
      const settlement = (promise as OrchestrationWorkPromise<NodeExecutionSettlement>).settlement;
      if (settlement && isNodeExecutionFailure(settlement) && OrchestrationWorkspaceLogFailure.is(settlement.error)) throw settlement.error;
    }
  }

  /** 记录旧 Attempt 被拒绝的原因，供运行报告和现场排障检索。 */
  private emitRejectedNodeAttemptContinuation(
    instance: OrchestrationInstance | null,
    node: WorkflowNode,
    attemptId: string,
    phase: string,
    error: unknown,
  ): void {
    const attempt = this.ctx.db.orchNodeAttempts.get(attemptId);
    const latest = instance ?? (attempt ? this.ctx.db.orchInstances.get(attempt.instanceId) : null);
    if (!attempt || !latest) {
      const missing = new Error(`旧 Attempt 诊断缺少可信归属: attemptId=${attemptId}`);
      throw new OrchestrationWorkspaceLogFailure([missing], missing);
    }
    const projectedAttemptId = this.resolveNodeAttemptId(latest.nodeStates[node.id] ?? null);
    const ownsNode = attempt.instanceId === latest.id
      && attempt.nodeId === node.id
      && projectedAttemptId === attemptId
      && this.ctx.db.orchNodeAttempts.isCurrent(latest.id, node.id, attemptId)
      && latest.status !== "cancelled"
      && latest.status !== "failed";
    if (ownsNode) return;
    let reason = "Attempt 已失去写回权";
    const context = {
      requestId: `node-attempt:${attemptId}`,
      instanceId: latest.id,
      nodeId: node.id,
      attemptId,
      attemptStatus: attempt.status,
      projectedAttemptId,
      phase,
      reason,
    };
    this.writeLifecycleLog(latest, "rejected stale node attempt continuation", "ORCHESTRATION_NODE_ATTEMPT_REJECTED", "node_attempt_rejected", context, undefined, describe => {
      const safe = describe(error ?? attempt.lastError ?? reason);
      if (typeof safe.message === "string") context.reason = reason = safe.message;
      return safe;
    }, "orchestration", "warn");
    this.emitOrchEvent(latest, "orchestration.nodeAttemptRejected", {
      instanceId: latest.id,
      nodeId: node.id,
      nodeLabel: node.label,
      attemptId,
      attemptStatus: attempt.status,
      projectedAttemptId,
      phase,
      reason,
    });
  }

  /** 收尾失败必须显式落失败态，不把已接受提交重新交给模型生成。 */
  private failSubmittedAttempt(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    attemptId: string,
    error: string,
  ): void {
    this.ctx.db.orchNodeAttempts.markTerminal(attemptId, "failed", error);
    this.updateNodeStatus(instanceId, node, instance, "failed", { error });
    this.updateInstanceStatus(instanceId, "failed");
    const latest = this.ctx.db.orchInstances.get(instanceId) ?? instance;
    this.emitOrchEvent(latest, "orchestration.nodeFinalizationFailed", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      attemptId,
      error,
    });
  }

  /** 按节点当前投影收敛未提交 Attempt，保持失败策略与 Attempt 审计一致。 */
  private settleAttemptFromNodeState(attemptId: string, instanceId: OrchestrationId, nodeId: string, error?: string | null): void {
    const status = this.ctx.db.orchInstances.get(instanceId)?.nodeStates[nodeId]?.status ?? null;
    const terminalStatus = this.toAttemptTerminalStatus(status);
    if (!terminalStatus) throw new Error(`节点 ${nodeId} 尚未收敛，不能结束 Attempt ${attemptId}`);
    this.ctx.db.orchNodeAttempts.markTerminal(attemptId, terminalStatus, error ?? null);
  }

  /** 映射节点终态到 Attempt 终态；非终态返回 null。 */
  private toAttemptTerminalStatus(status: NodeExecutionStatus | null): Extract<OrchNodeAttemptStatus, "completed" | "waiting-approval" | "waiting-feedback" | "failed" | "skipped" | "cancelled"> | null {
    if (status === "completed"
      || status === "waiting-approval"
      || status === "waiting-feedback"
      || status === "failed"
      || status === "skipped"
      || status === "cancelled") {
      return status;
    }
    return null;
  }

  /** 读取统一执行身份；迁移期优先信任持久化 attemptId。 */
  private resolveNodeAttemptId(nodeState: NodeExecutionState | null | undefined): string | null {
    const attemptId = String(nodeState?.attemptId ?? "").trim();
    if (attemptId) return attemptId;
    const nodeExecutionId = String(nodeState?.nodeExecutionId ?? "").trim();
    return nodeExecutionId || null;
  }

  /** 将节点终态收敛到仍活跃的持久化 Attempt；已终结的历史结果不被人工后续动作改写。 */
  private settleCurrentNodeAttemptForStatus(
    instanceId: OrchestrationId,
    nodeId: string,
    nodeState: NodeExecutionState | null,
    status: NodeExecutionStatus,
  ): void {
    const terminalStatus = this.toAttemptTerminalStatus(status);
    const attemptId = this.resolveNodeAttemptId(nodeState);
    if (!terminalStatus || !attemptId) return;
    const attempt = this.ctx.db.orchNodeAttempts.get(attemptId);
    if (!attempt || attempt.instanceId !== instanceId || attempt.nodeId !== nodeId) return;
    if (attempt.status === terminalStatus) {
      this.ctx.db.orchNodeAttempts.markTerminal(attempt.id, terminalStatus, nodeState?.error ?? null);
      return;
    }
    if (attempt.status !== "running" && attempt.status !== "result-submitted" && attempt.status !== "finalizing") return;
    this.ctx.db.orchNodeAttempts.markTerminal(attempt.id, terminalStatus, nodeState?.error ?? null);
  }

  private clearNodeFailureState(nodeState: NodeExecutionState): void {
    nodeState.humanActionSource = null;
    nodeState.error = null;
    nodeState.errorCode = null;
    nodeState.providerThreadId = null;
    nodeState.recoveryReason = null;
    nodeState.preserveBinding = null;
    nodeState.userChoiceRequired = null;
    nodeState.recoveryStrategies = null;
    nodeState.gateResults = null;
    nodeState.conclusion = null;
    nodeState.output = null;
    nodeState.outputArtifactIds = null;
    nodeState.startedAt = null;
    nodeState.completedAt = null;
    nodeState.manualStartApprovedAt = null;
    nodeState.manualStartApprovedBy = null;
  }

  /** 重置节点执行痕迹；条件节点重跑可显式保留既有分支选择。 */
  private resetNodeForRetry(
    nodeState: NodeExecutionState,
    nextActiveFeedbackRecordIds: FeedbackRecordId[] | null = null,
    options?: { threadReusePolicy?: NodeThreadReusePolicy | null; preserveBranchTaken?: boolean },
  ): void {
    const preservedBranchTaken = options?.preserveBranchTaken ? nodeState.branchTaken ?? null : null;
    const previousExecutionId = this.resolveNodeAttemptId(nodeState);
    this.clearNodeFailureState(nodeState);
    nodeState.attemptId = null;
    nodeState.nodeExecutionId = null;
    nodeState.submissionId = null;
    nodeState.parentExecutionId = previousExecutionId ?? nodeState.parentExecutionId ?? null;
    nodeState.renderedInput = null;
    nodeState.branchTaken = preservedBranchTaken;
    if (options?.threadReusePolicy === "new-thread") {
      this.clearNodeThreadForNewAttempt(nodeState);
    }
    this.replaceActiveFeedbackRecords(nodeState, nextActiveFeedbackRecordIds);
  }

  /** Emits the terminal snapshot for an attempt before the mutable node state is reused. */
  private finishNodeAttempt(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeLabel: string,
    nodeState: NodeExecutionState,
    status: Extract<NodeExecutionStatus, "failed" | "cancelled">,
    error: string | null,
  ): void {
    const attemptId = this.resolveNodeAttemptId(nodeState);
    if (!attemptId) return;
    nodeState.attemptId = attemptId;
    nodeState.nodeExecutionId = attemptId;
    nodeState.status = status;
    nodeState.completedAt = Date.now();
    nodeState.error = error;
    instance.nodeStates[nodeId] = nodeState;
    this.emitNodeStateChanged(instance, nodeId, nodeLabel, status);
  }

  /** 抢占 pending/ready 节点执行权，避免多个后台调度器重复启动同一节点。 */
  private claimReadyNodeForExecution(instanceId: OrchestrationId, node: WorkflowNode, instance: OrchestrationInstance): boolean {
    const latest = this.ctx.db.orchInstances.get(instanceId) ?? instance;
    const nodeState = latest.nodeStates[node.id];
    if (!nodeState || (nodeState.status !== "pending" && nodeState.status !== "ready")) return false;
    this.updateNodeStatus(instanceId, node, latest, "queued");
    return true;
  }

  /** 解析实例级启动策略；无人值守只覆盖节点人工启动门禁。 */
  private resolveNodeStartMode(instance: OrchestrationInstance, node: WorkflowNode): "auto" | "manual" {
    if (node.type !== "role") return "auto";
    if (instance.runtimeConfig?.interactionMode === "unattended") return "auto";
    return node.startMode === "manual" ? "manual" : "auto";
  }

  /** 判断就绪节点是否应先停在 waiting-start，已人工放行的同一轮不再拦截。 */
  private shouldWaitForManualStart(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    nodeState: NodeExecutionState | null | undefined,
  ): boolean {
    if (!nodeState) return false;
    if (nodeState.manualStartApprovedAt) return false;
    return this.resolveNodeStartMode(instance, node) === "manual";
  }

  /** 把满足前置条件的人工启动节点停在 waiting-start，不创建会话也不调用 AI。 */
  private markNodeWaitingStart(instanceId: OrchestrationId, node: WorkflowNode, instance: OrchestrationInstance): void {
    this.updateNodeStatus(instanceId, node, instance, "waiting-start", {
      error: "等待人工启动节点",
      humanActionSource: null,
    });
  }

  /** 清空当前节点会话前把旧 threadId 归档，下一次执行会创建新会话。 */
  private clearNodeThreadForNewAttempt(nodeState: NodeExecutionState): void {
    const currentThreadId = String(nodeState.threadId ?? "").trim() as ThreadId;
    if (!currentThreadId) return;
    const previousThreadIds = new Set((nodeState.previousThreadIds ?? []).map((item) => String(item ?? "").trim()).filter(Boolean));
    previousThreadIds.add(currentThreadId);
    nodeState.previousThreadIds = Array.from(previousThreadIds) as ThreadId[];
    nodeState.threadId = null;
  }

  /** 根据目标节点定位条件出边，并返回需要写入 branchTaken 的稳定选择键。 */
  private resolveConditionBranchSelection(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    targetNodeId: string,
  ): { branchTaken: string; branchLabel: string; edge: WorkflowEdge } {
    if (node.type !== "condition") {
      throw new Error(`节点不是条件分支节点: ${node.id}`);
    }
    if (!targetNodeId) {
      throw new Error("人工选择分支时必须选择目标节点");
    }
    const outEdges = instance.workflowSnapshot.edges.filter((edge) => edge.sourceNodeId === node.id);
    const edge = outEdges.find((item) => item.targetNodeId === targetNodeId) ?? null;
    if (!edge) {
      throw new Error(`人工选择分支目标不属于当前条件节点：${targetNodeId}`);
    }
    return {
      branchTaken: this.resolveConditionEdgeSelectionKey(edge),
      branchLabel: this.resolveConditionEdgeDisplayLabel(instance, edge),
      edge,
    };
  }

  /** 写入人工分支选择并复用现有分支跳过逻辑清理未选路径。 */
  private applyConditionBranchChoice(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    nodeState: NodeExecutionState,
    branchTaken: string,
    branchLabel: string,
    feedback: string | null | undefined,
  ): void {
    const summary = String(feedback ?? "").trim() || `人工选择分支：${branchLabel}`;
    nodeState.branchTaken = branchTaken;
    nodeState.humanActionSource = null;
    nodeState.error = null;
    this.replaceActiveFeedbackRecords(nodeState, null);
    nodeState.conclusion = {
      nextAction: "continue",
      reviewVerdict: "pass",
      summary,
      blockingIssues: null,
      acceptanceChecks: null,
      humanInput: null,
      rework: null,
      decidedBy: "human",
      decidedAt: Date.now(),
    };
    nodeState.status = "completed";
    nodeState.completedAt = Date.now();
    instance.nodeStates[node.id] = nodeState;

    this.skipUnselectedConditionBranches(instanceId, node, instance, branchTaken);
  }

  /** 条件出边选择键：命名分支保留原标签，无标签分支按目标节点区分。 */
  private resolveConditionEdgeSelectionKey(edge: WorkflowEdge): string {
    const branchLabel = String(edge.conditionBranch ?? "").trim();
    if (branchLabel) return branchLabel;
    const targetNodeId = String(edge.targetNodeId ?? "").trim();
    return targetNodeId ? `target:${targetNodeId}` : `edge:${String(edge.id ?? "").trim()}`;
  }

  /** 条件分支摘要展示名：优先分支标签，否则使用目标节点标签。 */
  private resolveConditionEdgeDisplayLabel(instance: OrchestrationInstance, edge: WorkflowEdge): string {
    const branchLabel = String(edge.conditionBranch ?? "").trim();
    if (branchLabel) return branchLabel;
    return this.findNodeLabel(instance, edge.targetNodeId);
  }

  /** 判断条件出边是否匹配已保存选择；兼容历史 default 无标签分支。 */
  private isConditionEdgeSelected(edge: WorkflowEdge, branchTaken: string): boolean {
    const normalizedBranchTaken = String(branchTaken ?? "").trim();
    if (!normalizedBranchTaken) return false;
    if (this.resolveConditionEdgeSelectionKey(edge) === normalizedBranchTaken) return true;
    const branchLabel = String(edge.conditionBranch ?? "").trim();
    return !branchLabel && normalizedBranchTaken === "default";
  }

  /** 跳过同一条件节点下未选中的分支目标。 */
  private skipUnselectedConditionBranches(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    branchTaken: string,
  ): void {
    for (const edge of instance.workflowSnapshot.edges.filter((item) => item.sourceNodeId === node.id)) {
      if (!this.isConditionEdgeSelected(edge, branchTaken)) {
        this.skipBranch(instanceId, edge.targetNodeId, instance);
      }
    }
  }

  /** 校验反馈动作输入，确保人工分支和定向退回只能提交合法目标。 */
  private validateFeedbackActionInput(
    instance: OrchestrationInstance,
    node: WorkflowNode | null,
    nodeState: NodeExecutionState,
    action: FeedbackAction,
    input?: {
      feedback?: string | null;
      images?: string[] | null;
      artifactIds?: ArtifactId[] | null;
      targetNodeId?: string | null;
    },
  ): void {
    const hasFeedbackImages = normalizeFeedbackImages(input?.images).length > 0;
    if (action === "reevaluate_gates") {
      if (!node || node.type !== "role") throw new Error("只有角色节点支持重新评估 AI 门禁");
      if (nodeState.status !== "waiting-feedback" || nodeState.humanActionSource !== "gate") throw new Error("当前节点不在可重新评估门禁状态");
      if (!nodeState.gateResults?.some((result) => result.evaluatorKind === "ai")) throw new Error("当前节点没有可重新评估的 AI 门禁结果");
      return;
    }
    if (action === "rework_to_target") {
      const feedback = String(input?.feedback ?? "").trim();
      if (!feedback && !hasFeedbackImages) {
        throw new Error("驳回到指定节点时必须填写退回说明或附图");
      }
      const targetNodeId = String(input?.targetNodeId ?? "").trim();
      if (!targetNodeId) {
        throw new Error("驳回到指定节点时必须选择目标节点");
      }
      if (!node) {
        throw new Error(`节点不存在: ${nodeState.nodeId}`);
      }
      if (!instance.workflowSnapshot.nodes.some((item) => item.id === targetNodeId)) {
        throw new Error(`rework.targetNodeId 不存在：${targetNodeId}`);
      }
      const allowedTargets = this.resolveAllowedReworkTargets(instance, node);
      if (!allowedTargets.has(targetNodeId)) {
        throw new Error(`节点 ${node.label} 不允许退回到 ${targetNodeId}`);
      }
      return;
    }
    if (action === "choose_branch") {
      if (!node) throw new Error(`节点不存在: ${nodeState.nodeId}`);
      if (node.type !== "condition") throw new Error("只有条件分支节点支持人工选择分支");
      if (nodeState.status !== "waiting-feedback" || nodeState.humanActionSource !== "branch_decision") {
        throw new Error("当前节点不在人工选择分支状态");
      }
      this.resolveConditionBranchSelection(instance, node, String(input?.targetNodeId ?? "").trim());
      return;
    }
    const requiredMessage = this.resolveRequiredImprovementFeedbackMessage(nodeState, action);
    if (!requiredMessage) return;
    if (String(input?.feedback ?? "").trim() || hasFeedbackImages) return;
    throw new Error(requiredMessage);
  }

  private resolveRequiredImprovementFeedbackMessage(
    nodeState: NodeExecutionState,
    action: FeedbackAction,
  ): string | null {
    if (nodeState.status !== "waiting-approval") return null;
    if (action === "approve" && nodeState.conclusion?.nextAction === "rework") {
      return "确认退回修改时必须填写改进意见或附图";
    }
    if (action === "retry" || action === "resume_with_input") {
      return "退回重跑前必须填写改进意见或附图";
    }
    return null;
  }

  private applyHumanConclusionOverride(nodeState: NodeExecutionState, feedback: string | null): void {
    nodeState.humanActionSource = null;
    nodeState.error = null;
    nodeState.gateResults = null;
    const summary = String(feedback ?? "").trim() || "人工确认放行，继续后续流程。";
    nodeState.conclusion = {
      nextAction: "continue",
      reviewVerdict: "pass",
      summary,
      blockingIssues: null,
      acceptanceChecks: nodeState.conclusion?.acceptanceChecks ?? null,
      humanInput: null,
      rework: null,
      decidedBy: "human",
      decidedAt: Date.now(),
    };
  }

  private approveNodeArtifacts(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeState: NodeExecutionState | null,
  ): void {
    if (!nodeState) return;
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    const persistence = new ArtifactPersistenceService({ db: this.ctx.db, workspacePath, workspaceId: instance.workspaceId, workspacePathIndex: this.ctx.workspacePathIndex });
    const activeArtifacts = this.resolveLatestNodeOutputArtifacts(instance, nodeId, nodeState);
    const activeIds = new Set(activeArtifacts.map((artifact) => artifact.id));
    for (const artifactId of nodeState.outputArtifactIds ?? []) {
      if (activeIds.has(artifactId)) continue;
      const staleArtifact = this.ctx.db.orchArtifacts.get(artifactId);
      if (!staleArtifact || staleArtifact.status === "rejected" || staleArtifact.status === "superseded") continue;
      this.ctx.db.orchArtifacts.updateStatus(staleArtifact.id, "superseded");
      this.emitOrchEvent(instance, "orchestration.artifactDiscarded", {
        instanceId: instance.id,
        nodeId,
        nodeLabel: this.findNodeLabel(instance, nodeId),
        artifactId: staleArtifact.id,
        discardedPath: staleArtifact.publishedPath ?? staleArtifact.stagingPath ?? null,
        disposition: "superseded",
      });
    }
    for (const artifact of activeArtifacts) {
      const approvedArtifact = persistence.approveArtifact(artifact.id);
      if (!approvedArtifact) continue;
      this.emitOrchEvent(instance, "orchestration.artifactPublished", {
        instanceId: instance.id,
        nodeId,
        nodeLabel: this.findNodeLabel(instance, nodeId),
        artifactId: approvedArtifact.id,
        publishedPath: approvedArtifact.publishedPath ?? null,
        fileCount: this.ctx.db.orchArtifactFiles.listByArtifact(approvedArtifact.id).length,
      });
    }
  }

  private rejectNodeArtifacts(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeState: NodeExecutionState | null,
  ): void {
    if (!nodeState) return;
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    const persistence = new ArtifactPersistenceService({ db: this.ctx.db, workspacePath, workspaceId: instance.workspaceId, workspacePathIndex: this.ctx.workspacePathIndex });
    for (const artifactId of nodeState.outputArtifactIds ?? []) {
      const artifact = persistence.discardArtifact(artifactId);
      if (!artifact) continue;
      this.emitOrchEvent(instance, "orchestration.artifactDiscarded", {
        instanceId: instance.id,
        nodeId,
        nodeLabel: this.findNodeLabel(instance, nodeId),
        artifactId: artifact.id,
        discardedPath: artifact.stagingPath ?? artifact.publishedPath ?? null,
      });
    }
  }

  private supersedeNodeArtifacts(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeState: NodeExecutionState | null,
  ): void {
    if (!nodeState) return;
    for (const artifactId of nodeState.outputArtifactIds ?? []) {
      const artifact = this.ctx.db.orchArtifacts.get(artifactId);
      if (!artifact) continue;
      if (artifact.status === "rejected" || artifact.status === "superseded") continue;
      this.ctx.db.orchArtifacts.updateStatus(artifact.id, "superseded");
      this.emitOrchEvent(instance, "orchestration.artifactDiscarded", {
        instanceId: instance.id,
        nodeId,
        nodeLabel: this.findNodeLabel(instance, nodeId),
        artifactId: artifact.id,
        discardedPath: artifact.publishedPath ?? artifact.stagingPath ?? null,
        disposition: "superseded",
      });
    }
  }

  /** 裁剪重跑节点的产物索引，避免后续详情或轮询恢复旧产物引用。 */
  private pruneArtifactIndexForNodes(
    artifactIndex: Record<string, ArtifactId[]> | null | undefined,
    nodeIds: Set<string>,
  ): Record<string, ArtifactId[]> {
    if (!artifactIndex || !nodeIds.size) return artifactIndex ?? {};
    return Object.fromEntries(
      Object.entries(artifactIndex).filter(([nodeId]) => !nodeIds.has(nodeId)),
    );
  }

  private waitForHumanFeedback(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    artifactId: ArtifactId,
    conclusion: NodeExecutionConclusion,
    source: "review" | "human_input",
  ): void {
    const reason = this.describeConclusionForHumanFeedback(conclusion);
    this.updateNodeStatus(instanceId, node, instance, "waiting-feedback", {
      error: reason,
      humanActionSource: source,
    });
    this.emitOrchEvent(instance, "orchestration.feedbackRequested", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      source,
      gateResults: [],
      reason,
      artifactId,
      reviewVerdict: conclusion.reviewVerdict,
      nextAction: conclusion.nextAction,
      reworkTargetNodeId: conclusion.rework?.targetNodeId ?? null,
      humanSummary: conclusion.humanInput?.summary ?? null,
    });
  }

  private describeConclusionForHumanFeedback(conclusion: NodeExecutionConclusion): string {
    if (conclusion.nextAction === "ask_human") {
      return conclusion.humanInput?.summary ?? conclusion.summary ?? "需要用户补充信息后继续";
    }
    if (conclusion.nextAction === "stop") {
      return conclusion.summary ?? "模型建议暂停当前流程，等待人工决策";
    }
    if (conclusion.nextAction === "rework") {
      return conclusion.rework?.reason ?? conclusion.summary ?? "模型建议退回上游节点修改";
    }
    return conclusion.summary ?? "等待人工处理";
  }

  /** 执行模型给出的退回指令，并合并人工审核文字/图片。 */
  private async applyModelRequestedRework(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    nodeState: NodeExecutionState | null,
    approvalFeedback: string | null,
    images: string[] | null = null,
  ): Promise<void> {
    const directive = nodeState?.conclusion?.rework ?? null;
    if (!directive) {
      throw new Error(`节点 ${node.label} 没有可执行的 rework 指令`);
    }
    const sourceArtifactIds = (await this.withDatabase(() => this.resolveLatestNodeOutputArtifacts(instance, node.id, nodeState))).map((artifact) => artifact.id);
    const combinedReason = [directive.reason, String(approvalFeedback ?? "").trim()]
      .filter(Boolean)
      .join("\n\n");
    const affectedNodeIds = this.resolveModelReworkNodeIds(instance, node, directive);
    await this.applyRequestedRework(instanceId, node, instance, {
      targetNodeId: directive.targetNodeId,
      reason: combinedReason,
      images,
      sourceArtifactIds,
      affectedNodeIds,
      workItemScopes: directive.workItemScopes ?? null,
      downstreamThreadReusePolicy: "cascade-new-thread",
      preserveSourceReworkContext: true,
    });
  }

  /** 解析节点允许的自动回退轮次上限：显式合法值优先，缺省与非法值一律回落默认上限。 */
  private resolveMaxReworkRounds(node: WorkflowNode): number {
    const raw = node.reworkPolicy?.maxReworkRounds;
    if (raw === null || raw === undefined) return DEFAULT_MAX_REWORK_ROUNDS;
    const declared = Number(raw);
    if (!Number.isFinite(declared) || declared < 0) return DEFAULT_MAX_REWORK_ROUNDS;
    return Math.floor(declared);
  }

  /** 自动回退是否已达轮次上限；达上限后不再自动回退，改由人工决策。 */
  private hasReachedReworkLimit(node: WorkflowNode, nodeState: NodeExecutionState | null): boolean {
    const rounds = Math.max(0, Number(nodeState?.reworkCount ?? 0));
    return rounds >= this.resolveMaxReworkRounds(node);
  }

  /** 记录来源节点本轮发起的回退次数，供自动回退上限判定使用。 */
  private incrementNodeReworkCount(instanceId: OrchestrationId, nodeId: string, instance: OrchestrationInstance): void {
    const getInstance = this.ctx.db.orchInstances.get;
    const latest = typeof getInstance === "function" ? getInstance.call(this.ctx.db.orchInstances, instanceId) ?? instance : instance;
    const nodeState = latest.nodeStates[nodeId] ?? instance.nodeStates[nodeId];
    if (!nodeState) return;
    // 原地累加，保持节点状态对象标识不变，避免替换引用后引擎持有的旧引用失去同步。
    nodeState.reworkCount = Math.max(0, Number(nodeState.reworkCount ?? 0)) + 1;
    if (latest !== instance) {
      instance.nodeStates[nodeId] = nodeState;
    }
    this.ctx.db.orchInstances.updateNodeStates(instanceId, latest.nodeStates);
  }

  /** 重置退回目标子图，并把退回要求写入目标节点 active feedback。 */
  private async applyRequestedRework(
    instanceId: OrchestrationId,
    fromNode: WorkflowNode,
    instance: OrchestrationInstance,
    input: {
      targetNodeId: string;
      reason: string;
      images?: string[] | null;
      sourceArtifactIds: ArtifactId[] | null;
      threadReusePolicy?: NodeThreadReusePolicy | null;
      downstreamThreadReusePolicy?: DownstreamThreadReusePolicy | null;
      preserveSourceReworkContext?: boolean;
      useDeclaredImpact?: boolean;
      affectedNodeIds?: Set<string> | null;
      workItemScopes?: NodeWorkItemReworkScope[] | null;
    },
  ): Promise<void> {
    const targetNodeId = String(input.targetNodeId ?? "").trim();
    const affectedNodeIds = input.affectedNodeIds ?? this.collectAffectedReworkNodes(
      instance,
      targetNodeId,
      input.useDeclaredImpact === false ? null : fromNode.id,
    );
    if (!affectedNodeIds.size) {
      throw new Error(`无法为 ${targetNodeId} 计算返工影响范围`);
    }
    // 计入来源节点已发起的回退轮次，供自动回退上限判定（人工授权的回退同样计入）。
    (await this.withDatabase(() => this.incrementNodeReworkCount(instanceId, fromNode.id, instance)));

    const sourceArtifactIds = input.sourceArtifactIds?.length ? input.sourceArtifactIds : [];
    const revisionNotes = (await this.withDatabase(() => this.collectArtifactRevisionNotes(instance, sourceArtifactIds)));
    const reworkReason = [String(input.reason ?? "").trim(), revisionNotes]
      .filter(Boolean)
      .join("\n\n");
    const reworkImages = normalizeFeedbackImages(input.images);
    const feedbackRecord = (await this.withDatabase(() => this.createSystemFeedbackRecord(instanceId, targetNodeId, "system_rework", {
      feedback: reworkReason,
      images: reworkImages,
      artifactIds: sourceArtifactIds.length ? sourceArtifactIds : null,
    })));
    const sourceFollowupRecord = input.preserveSourceReworkContext
      && fromNode.id !== targetNodeId
      && affectedNodeIds.has(fromNode.id)
      ? (await this.withDatabase(() => this.createSystemFeedbackRecord(instanceId, fromNode.id, "system_rework_followup", {
          feedback: "上一轮本节点已发起上游返工。重新执行时必须读取关联的上一轮节点工件，先核对已提出问题的修复结果，再完成当前角色声明的全部验收范围。上一轮列举项只是已知问题，不代表其他范围已经通过；若在未变化输入中发现同类漏检，必须先扩展出完整受影响集合再一次性提交，禁止按小批次反复退回。",
          artifactIds: sourceArtifactIds.length ? sourceArtifactIds : null,
        })))
      : null;

    (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.reworkRequested", {
      instanceId,
      fromNodeId: fromNode.id,
      fromNodeLabel: fromNode.label,
      targetNodeId,
      targetNodeLabel: this.findNodeLabel(instance, targetNodeId),
      artifactIds: sourceArtifactIds.length ? sourceArtifactIds : null,
      reason: reworkReason,
      affectedNodeIds: Array.from(affectedNodeIds),
    })));

    const sourceExecutionId = this.resolveNodeAttemptId(instance.nodeStates[fromNode.id] ?? null);
    const isManualFullReopen = input.workItemScopes === undefined;
    const requestedWorkItemScopes = await this.withDatabase(() => isManualFullReopen
      ? instance.workflowSnapshot.nodes
          .filter((candidate) => affectedNodeIds.has(candidate.id)
            && this.isSequentialWorkItemNode(candidate)
            && this.ctx.db.orchNodeWorkItems.getSummary(instance.id, candidate.id).total > 0)
          .map((candidate) => ({ nodeId: candidate.id, mode: "all" as const }))
      : input.workItemScopes);
    const resolvedWorkItemScopes = (await this.withDatabase(() => this.resolveNodeWorkItemReworkScopes(
      instance,
      affectedNodeIds,
      requestedWorkItemScopes,
      `节点 ${fromNode.label} 的返工应用`,
      { allowInProgress: isManualFullReopen },
    )));
    const reopenedWorkItems = resolvedWorkItemScopes.length
      ? (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.reopenMany({
          instanceId,
          scopes: resolvedWorkItemScopes,
          reason: reworkReason,
          actorAttemptId: sourceExecutionId,
          allowInProgress: isManualFullReopen,
        })))
      : null;
    const workItemSummaryByNodeId = new Map(
      (reopenedWorkItems?.nodes ?? []).map((entry) => [entry.nodeId, entry.summary]),
    );
    if (reopenedWorkItems) {
      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeWorkItemsReopened", {
        instanceId,
        fromNodeId: fromNode.id,
        batchId: reopenedWorkItems.batchId,
        nodes: reopenedWorkItems.nodes.map((entry) => ({
          nodeId: entry.nodeId,
          reopenedCount: entry.reopenedClientKeys.length,
          unchangedCount: entry.unchangedClientKeys.length,
          summary: entry.summary,
        })),
      })));
    }

    for (const affectedNodeId of affectedNodeIds) {
      const affectedState = instance.nodeStates[affectedNodeId];
      if (!affectedState) continue;
      const affectedNode = instance.workflowSnapshot.nodes.find((node) => node.id === affectedNodeId) ?? null;
      const previousExecutionId = this.resolveNodeAttemptId(affectedState);
      if (previousExecutionId && affectedState.status !== "completed" && affectedState.status !== "failed" && affectedState.status !== "skipped" && affectedState.status !== "cancelled") {
        (await this.withDatabase(() => this.finishNodeAttempt(instance, affectedNodeId, this.findNodeLabel(instance, affectedNodeId), affectedState, "cancelled", reworkReason || "节点因返工重置")));
      }
      (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.invalidateActiveByNode(
        instanceId,
        affectedNodeId,
        `节点被返工影响集重置，来源节点: ${fromNode.id}`,
      )));
      (await this.withDatabase(() => this.supersedeNodeArtifacts(instance, affectedNodeId, affectedState)));
      this.resetNodeForRetry(affectedState, null, {
        threadReusePolicy: this.resolveReworkThreadReusePolicy(instance, affectedNodeId, targetNodeId, input),
        preserveBranchTaken: affectedNode?.type === "condition",
      });
      affectedState.parentExecutionId = sourceExecutionId ?? previousExecutionId;
      affectedState.status = "pending";
      if (workItemSummaryByNodeId.has(affectedNodeId)) {
        affectedState.workItemSummary = workItemSummaryByNodeId.get(affectedNodeId) ?? null;
      }
      if (affectedNodeId === targetNodeId) {
        this.appendFeedbackHistoryRecord(affectedState, feedbackRecord.id);
        this.replaceActiveFeedbackRecords(affectedState, [feedbackRecord.id]);
        affectedState.inputArtifactIds = Array.from(new Set([
          ...(affectedState.inputArtifactIds ?? []),
          ...sourceArtifactIds,
        ]));
      } else if (affectedNodeId === fromNode.id && sourceFollowupRecord) {
        this.appendFeedbackHistoryRecord(affectedState, sourceFollowupRecord.id);
        this.replaceActiveFeedbackRecords(affectedState, [sourceFollowupRecord.id]);
      }
      instance.nodeStates[affectedNodeId] = affectedState;
      (await this.withDatabase(() => this.emitNodeStateChanged(instance, affectedNodeId, this.findNodeLabel(instance, affectedNodeId), "pending")));
    }

    instance.artifactIndex = this.pruneArtifactIndexForNodes(instance.artifactIndex, affectedNodeIds);
    (await this.withDatabase(() => this.ctx.db.orchInstances.updateArtifactIndex(instanceId, instance.artifactIndex!)));
    (await this.withDatabase(() => this.ctx.db.orchInstances.updateNodeStates(instanceId, instance.nodeStates)));
  }

  /** 重跑前只中断目标子图中的活跃节点，不影响并行兄弟分支。 */
  private async interruptAffectedNodesForRerun(
    instance: OrchestrationInstance,
    affectedNodeIds: Set<string>,
  ): Promise<void> {
    const runningByThread = (await this.withDatabase(() => this.ctx.db.turns.listRunningByWorkspace(instance.workspaceId)));
    for (const node of instance.workflowSnapshot.nodes) {
      if (!affectedNodeIds.has(node.id)) continue;
      const nodeState = instance.nodeStates[node.id];
      if (!nodeState || !this.isInterruptibleNodeExecutionStatus(nodeState.status)) continue;
      const threadId = nodeState.threadId ?? null;
      const runningTurnId = threadId ? runningByThread[threadId]?.runningTurnId ?? null : null;
      if (threadId && runningTurnId) {
        await this.ctx.sessions.interrupt(threadId as ThreadId, runningTurnId);
      }
    }
  }

  /** 将审核补充文字/图片传播到后续角色节点。 */
  private propagateApprovalFeedbackToNextRoleNodes(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    nodeState: NodeExecutionState | null,
    feedback: string | null,
    images: string[] | null = null,
  ): void {
    const approvalNote = String(feedback ?? "").trim();
    const approvalImages = normalizeFeedbackImages(images);
    if (!approvalNote && !approvalImages.length) return;

    const targetNodeIds = this.collectNextRoleNodeIds(instance, node.id);
    if (!targetNodeIds.size) return;

    const sourceArtifactIds = this.resolveLatestNodeOutputArtifacts(instance, node.id, nodeState).map((artifact) => artifact.id);
    for (const targetNodeId of targetNodeIds) {
      const targetState = instance.nodeStates[targetNodeId];
      if (!targetState) continue;
      const feedbackRecord = this.createSystemFeedbackRecord(instanceId, targetNodeId, "system_approval_note", {
        feedback: approvalNote,
        images: approvalImages,
        artifactIds: sourceArtifactIds.length ? sourceArtifactIds : null,
      });
      this.appendFeedbackHistoryRecord(targetState, feedbackRecord.id);
      this.appendActiveFeedbackRecord(targetState, feedbackRecord.id);
      instance.nodeStates[targetNodeId] = targetState;
    }
  }

  /** 校验审核补充传播后，各后续角色节点仍满足下一轮消息预算。 */
  private assertApprovalFeedbackPropagationBudget(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    feedback: string | null,
    images: string[] | null,
  ): void {
    const approvalNote = String(feedback ?? "").trim();
    const approvalImages = normalizeFeedbackImages(images);
    if (!approvalNote && !approvalImages.length) return;
    for (const targetNodeId of this.collectNextRoleNodeIds(instance, node.id)) {
      this.assertFeedbackContextBudgetForAppend(instance, targetNodeId, {
        feedback: approvalNote,
        images: approvalImages,
      });
    }
  }

  /** 校验追加反馈后仍满足下轮节点消息的 inline 附件预算。 */
  private assertFeedbackContextBudgetForAppend(
    instance: OrchestrationInstance,
    nodeId: string,
    input: { feedback?: string | null; images?: string[] | null },
    contextLabel?: string,
  ): void {
    const existingRecords = this.resolvePromptFeedbackRecordIds(instance, nodeId)
      .map((id) => this.ctx.db.orchFeedback.get(id))
      .filter((record): record is FeedbackRecord => Boolean(record));
    const nextImages = normalizeFeedbackImages([
      ...existingRecords.flatMap((record) => record.images ?? []),
      ...(input.images ?? []),
    ]);
    const inputImages = normalizeFeedbackImages(input.images);
    const nextText = [
      ...existingRecords.map((record) => this.formatFeedbackRecord(instance, record)).filter(Boolean),
      String(input.feedback ?? "").trim(),
      inputImages.length ? `附图：${inputImages.length} 张` : "",
    ].filter(Boolean).join("\n\n");
    const budgetCheck = validateInlineThreadPayload(
      { text: nextText, images: nextImages },
      { contextLabel: contextLabel ?? `节点「${this.findNodeLabel(instance, nodeId)}」的审核反馈` },
    );
    if (!budgetCheck.ok) {
      throw new Error(budgetCheck.message);
    }
  }

  private collectNextRoleNodeIds(instance: OrchestrationInstance, sourceNodeId: string): Set<string> {
    const visited = new Set<string>();
    const queue = instance.workflowSnapshot.edges
      .filter((edge) => edge.sourceNodeId === sourceNodeId)
      .map((edge) => edge.targetNodeId);
    const nextRoleNodeIds = new Set<string>();

    while (queue.length > 0) {
      const currentNodeId = queue.shift()!;
      if (visited.has(currentNodeId)) continue;
      visited.add(currentNodeId);
      const currentNode = instance.workflowSnapshot.nodes.find((item) => item.id === currentNodeId) ?? null;
      if (!currentNode) continue;
      if (currentNode.type === "role") {
        nextRoleNodeIds.add(currentNodeId);
        continue;
      }
      if (currentNode.type === "end") continue;
      queue.push(
        ...instance.workflowSnapshot.edges
          .filter((edge) => edge.sourceNodeId === currentNodeId)
          .map((edge) => edge.targetNodeId),
      );
    }

    return nextRoleNodeIds;
  }

  /** 收集返工子图；模型返工只重置因果路径，人工重跑才重置完整下游。 */
  private collectAffectedReworkNodes(
    instance: OrchestrationInstance,
    targetNodeId: string,
    fromNodeId: string | null = null,
  ): Set<string> {
    /** 沿激活路径收集下游；返工校验可穿透 skipped 透明桥，但不默认重置桥节点。 */
    const collectDownstreamNodeIds = (originNodeId: string, traverseSkippedBridges = false): Set<string> => {
      const visited = new Set<string>();
      const queue = [originNodeId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const outEdges = instance.workflowSnapshot.edges.filter((edge) => edge.sourceNodeId === current);
        for (const edge of outEdges) {
          if (this.isInactiveConditionEdge(edge, instance)) continue;
          const targetState = instance.nodeStates[edge.targetNodeId] ?? null;
          if (edge.targetNodeId !== originNodeId && targetState?.status === "skipped") {
            if (traverseSkippedBridges) queue.push(edge.targetNodeId);
            continue;
          }
          queue.push(edge.targetNodeId);
        }
      }
      return visited;
    };
    const fromNode = fromNodeId
      ? instance.workflowSnapshot.nodes.find((node) => node.id === fromNodeId) ?? null
      : null;
    const declared = fromNode?.reworkPolicy?.affectedNodeIdsByTargetNodeId?.[targetNodeId];
    const downstreamOfTarget = collectDownstreamNodeIds(targetNodeId, Boolean(fromNodeId && declared == null));
    if (declared == null) {
      if (!fromNodeId) return downstreamOfTarget;
      if (!downstreamOfTarget.has(fromNodeId)) {
        throw new Error(`节点 ${fromNode?.label ?? fromNodeId} 不能退回非上游节点: ${targetNodeId}`);
      }

      const ancestorsOfRequester = new Set<string>();
      const queue = [fromNodeId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (ancestorsOfRequester.has(current)) continue;
        ancestorsOfRequester.add(current);
        const inEdges = instance.workflowSnapshot.edges.filter((edge) => edge.targetNodeId === current);
        for (const edge of inEdges) {
          if (this.isInactiveConditionEdge(edge, instance)) continue;
          queue.push(edge.sourceNodeId);
        }
      }

      const shouldResetNode = (nodeId: string): boolean =>
        nodeId === targetNodeId
        || nodeId === fromNodeId
        || instance.nodeStates[nodeId]?.status !== "skipped";
      const affectedNodeIds = new Set(
        Array.from(downstreamOfTarget).filter((nodeId) => ancestorsOfRequester.has(nodeId) && shouldResetNode(nodeId)),
      );
      for (const nodeId of collectDownstreamNodeIds(fromNodeId, true)) {
        if (shouldResetNode(nodeId)) affectedNodeIds.add(nodeId);
      }
      return affectedNodeIds;
    }
    if (!Array.isArray(declared)) {
      throw new Error(`节点 ${fromNode?.label ?? fromNodeId} 的返工影响集必须是节点 ID 数组: ${targetNodeId}`);
    }

    const affectedNodeIds = new Set(declared.map((nodeId) => String(nodeId ?? "").trim()).filter(Boolean));
    if (!affectedNodeIds.has(targetNodeId)) {
      throw new Error(`节点 ${fromNode?.label ?? fromNodeId} 的返工影响集必须包含目标节点: ${targetNodeId}`);
    }
    const invalidNodeIds = Array.from(affectedNodeIds).filter((nodeId) => !downstreamOfTarget.has(nodeId));
    if (invalidNodeIds.length > 0) {
      throw new Error(
        `节点 ${fromNode?.label ?? fromNodeId} 的返工影响集包含目标下游之外的节点: ${invalidNodeIds.join(", ")}`,
      );
    }
    return affectedNodeIds;
  }

  /** 校验模型精确返工集合存在，且只能缩小节点声明的最大影响范围。 */
  private resolveModelReworkNodeIds(
    instance: OrchestrationInstance,
    fromNode: WorkflowNode,
    directive: NodeReworkDirective,
  ): Set<string> {
    if (!Array.isArray(directive.rerunNodeIds) || directive.rerunNodeIds.length === 0) {
      throw new Error(withSubmitNodeResultExample(
        "模型返工必须显式提供非空 rework.rerunNodeIds，系统不会默认采用完整影响范围",
        SUBMIT_NODE_RESULT_REWORK_EXAMPLE,
      ));
    }
    const declaredNodeIds = this.collectAffectedReworkNodes(instance, directive.targetNodeId, fromNode.id);
    if (!declaredNodeIds.has(fromNode.id)) {
      throw new Error(`节点 ${fromNode.label} 的返工影响范围必须包含当前节点 ${fromNode.id}，否则上游修正后无法重新评审`);
    }
    const rerunNodeIds = this.resolveRerunNodeIds(
      instance,
      directive.targetNodeId,
      directive.rerunNodeIds,
      declaredNodeIds,
    );
    if (!rerunNodeIds.has(fromNode.id)) {
      throw new Error(withSubmitNodeResultExample(
        `模型返工的 rework.rerunNodeIds 必须包含当前节点 ${fromNode.id}，以便上游修正后重新执行当前评审`,
        SUBMIT_NODE_RESULT_REWORK_EXAMPLE,
      ));
    }
    return rerunNodeIds;
  }

  /** 校验受影响顺序节点都有精确工作项范围，并预检 sourceKey 与固定伴随项。 */
  private resolveNodeWorkItemReworkScopes(
    instance: OrchestrationInstance,
    affectedNodeIds: Set<string>,
    submittedScopes: NodeWorkItemReworkScope[] | null | undefined,
    contextLabel: string,
    options?: { allowInProgress?: boolean },
  ): ResolvedNodeWorkItemReworkScope[] {
    const requiredNodeIds = new Set(instance.workflowSnapshot.nodes
      .filter((candidate) => affectedNodeIds.has(candidate.id)
        && this.isSequentialWorkItemNode(candidate)
        && this.ctx.db.orchNodeWorkItems.getSummary(instance.id, candidate.id).total > 0)
      .map((candidate) => candidate.id));
    const scopes = submittedScopes ?? [];
    if (requiredNodeIds.size === 0) {
      if (scopes.length > 0) throw new Error(`${contextLabel} 未影响已有工作项看板，不能提交 workItemScopes`);
      return [];
    }
    if (scopes.length === 0) {
      throw new Error(`${contextLabel} 必须为受影响工作项节点显式提交 rework.workItemScopes；每项使用 mode=all，或 mode=selected + 稳定 sourceKeys`);
    }
    const scopeNodeIds = new Set(scopes.map((scope) => scope.nodeId));
    const missing = Array.from(requiredNodeIds).filter((nodeId) => !scopeNodeIds.has(nodeId));
    const extra = Array.from(scopeNodeIds).filter((nodeId) => !requiredNodeIds.has(nodeId));
    if (missing.length || extra.length) {
      throw new Error(`${contextLabel} 的 workItemScopes 必须精确覆盖已有看板节点；missing=${missing.join(",") || "[]"}，extra=${extra.join(",") || "[]"}`);
    }
    const resolved = scopes.map((scope) => {
      const workflowNode = instance.workflowSnapshot.nodes.find((candidate) => candidate.id === scope.nodeId);
      if (!workflowNode) throw new Error(`${contextLabel} 的 workItemScopes 节点不存在：${scope.nodeId}`);
      return {
        ...scope,
        alwaysClientKeys: this.resolveNodeWorkItemPolicy(instance, workflowNode)?.reworkAlwaysClientKeys ?? [],
      };
    });
    this.ctx.db.orchNodeWorkItems.validateReopenMany({
      instanceId: instance.id,
      scopes: resolved,
      allowInProgress: options?.allowInProgress === true,
    });
    return resolved;
  }

  /** 人工审核驳回当前节点时一次性重开已有看板；中途补充信息的恢复路径不调用此方法。 */
  private reopenCurrentNodeWorkItemsForManualRetry(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    reason: string,
    actorAttemptId: string | null,
  ): NodeWorkItemSummary | null {
    if (!this.isSequentialWorkItemNode(node)) return null;
    if (this.ctx.db.orchNodeWorkItems.getSummary(instance.id, node.id).total === 0) return null;
    const scopes = this.resolveNodeWorkItemReworkScopes(
      instance,
      new Set([node.id]),
      [{ nodeId: node.id, mode: "all" }],
      `节点 ${node.label} 的人工审核驳回`,
      { allowInProgress: true },
    );
    const reopened = this.ctx.db.orchNodeWorkItems.reopenMany({
      instanceId: instance.id,
      scopes,
      reason: String(reason ?? "").trim() || "用户驳回并重新执行当前节点",
      actorAttemptId,
      allowInProgress: true,
    });
    const nodeResult = reopened.nodes.find((entry) => entry.nodeId === node.id);
    if (!nodeResult) throw new Error(`节点 ${node.label} 的工作项看板未完成重开`);
    this.emitOrchEvent(instance, "orchestration.nodeWorkItemsReopened", {
      instanceId: instance.id,
      fromNodeId: node.id,
      batchId: reopened.batchId,
      nodes: [{
        nodeId: node.id,
        reopenedCount: nodeResult.reopenedClientKeys.length,
        unchangedCount: nodeResult.unchangedClientKeys.length,
        summary: nodeResult.summary,
      }],
    });
    return nodeResult.summary;
  }

  /** 校验精确重跑集合，并允许经已完成或已跳过节点连接后续选中节点。 */
  private resolveRerunNodeIds(
    instance: OrchestrationInstance,
    targetNodeId: string,
    rawNodeIds: string[] | null,
    maximumNodeIds: Set<string> | null = null,
  ): Set<string> {
    const downstreamNodeIds = this.collectAffectedReworkNodes(instance, targetNodeId);
    const allowedNodeIds = maximumNodeIds ?? downstreamNodeIds;
    if (rawNodeIds == null) return new Set(allowedNodeIds);
    if (!Array.isArray(rawNodeIds) || rawNodeIds.length === 0) {
      throw new Error("精确重跑节点集合不能为空");
    }

    const selectedNodeIds = new Set(rawNodeIds.map((nodeId) => String(nodeId ?? "").trim()).filter(Boolean));
    if (!selectedNodeIds.has(targetNodeId)) {
      throw new Error(`精确重跑节点集合必须包含起点: ${targetNodeId}`);
    }
    const unknownNodeIds = Array.from(selectedNodeIds).filter(
      (nodeId) => !instance.workflowSnapshot.nodes.some((node) => node.id === nodeId),
    );
    if (unknownNodeIds.length > 0) {
      throw new Error(`精确重跑节点集合包含不存在的节点: ${unknownNodeIds.join(", ")}`);
    }
    const outsideNodeIds = Array.from(selectedNodeIds).filter((nodeId) => !allowedNodeIds.has(nodeId));
    if (outsideNodeIds.length > 0) {
      const boundary = maximumNodeIds ? "工作流声明影响范围" : "起点有效下游";
      throw new Error(`精确重跑节点集合包含${boundary}之外的节点: ${outsideNodeIds.join(", ")}`);
    }

    const blockedRequiredBridgeNodes = new Map<string, string>();
    const inspectedPredecessorNodeIds = new Set<string>();
    const predecessorQueue = Array.from(selectedNodeIds);
    while (predecessorQueue.length > 0) {
      const selectedOrBridgeNodeId = predecessorQueue.shift()!;
      if (inspectedPredecessorNodeIds.has(selectedOrBridgeNodeId)) continue;
      inspectedPredecessorNodeIds.add(selectedOrBridgeNodeId);
      for (const edge of instance.workflowSnapshot.edges) {
        if (edge.targetNodeId !== selectedOrBridgeNodeId || selectedNodeIds.has(edge.sourceNodeId)) continue;
        if (this.isInactiveConditionEdge(edge, instance)) continue;
        const bridgeStatus = instance.nodeStates[edge.sourceNodeId]?.status ?? "missing";
        if (bridgeStatus !== "completed" && bridgeStatus !== "skipped") {
          blockedRequiredBridgeNodes.set(edge.sourceNodeId, bridgeStatus);
          continue;
        }
        predecessorQueue.push(edge.sourceNodeId);
      }
    }
    if (blockedRequiredBridgeNodes.size > 0) {
      const blocked = Array.from(blockedRequiredBridgeNodes, ([nodeId, status]) => `${nodeId}(${status})`).join(", ");
      throw new Error(`精确重跑范围依赖未选中的非终态桥节点: ${blocked}`);
    }

    const reachableNodeIds = new Set<string>();
    const blockedBridgeNodes = new Map<string, string>();
    const queue = [targetNodeId];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (reachableNodeIds.has(nodeId)) continue;
      reachableNodeIds.add(nodeId);
      for (const edge of instance.workflowSnapshot.edges) {
        if (edge.sourceNodeId !== nodeId) continue;
        if (this.isInactiveConditionEdge(edge, instance)) continue;
        if (selectedNodeIds.has(edge.targetNodeId)) {
          queue.push(edge.targetNodeId);
          continue;
        }
        const bridgeStatus = instance.nodeStates[edge.targetNodeId]?.status ?? "missing";
        if (bridgeStatus === "completed" || bridgeStatus === "skipped") {
          queue.push(edge.targetNodeId);
        } else {
          blockedBridgeNodes.set(edge.targetNodeId, bridgeStatus);
        }
      }
    }
    const disconnectedNodeIds = Array.from(selectedNodeIds).filter((nodeId) => !reachableNodeIds.has(nodeId));
    if (disconnectedNodeIds.length > 0) {
      const blocked = Array.from(blockedBridgeNodes, ([nodeId, status]) => `${nodeId}(${status})`).join(", ");
      throw new Error(
        `精确重跑节点必须从起点经所选节点或已完成桥节点可达: ${disconnectedNodeIds.join(", ")}`
        + (blocked ? `；未选中的非终态桥节点: ${blocked}` : ""),
      );
    }
    return selectedNodeIds;
  }

  /** 决定返工影响范围内每个节点是否要在下次执行时新建会话。 */
  private resolveReworkThreadReusePolicy(
    instance: OrchestrationInstance,
    affectedNodeId: string,
    targetNodeId: string,
    input: {
      threadReusePolicy?: NodeThreadReusePolicy | null;
      downstreamThreadReusePolicy?: DownstreamThreadReusePolicy | null;
    },
  ): NodeThreadReusePolicy {
    const affectedNode = instance.workflowSnapshot.nodes.find((node) => node.id === affectedNodeId) ?? null;
    const affectedState = instance.nodeStates[affectedNodeId] ?? null;
    if (affectedNode?.type !== "role" || !affectedState?.threadId) return "reuse-existing";
    if (affectedNodeId === targetNodeId) return input.threadReusePolicy ?? "reuse-existing";
    return input.downstreamThreadReusePolicy === "cascade-new-thread" ? "new-thread" : "reuse-existing";
  }

  private resolveAllowedReworkTargets(instance: OrchestrationInstance, node: WorkflowNode): Set<string> {
    const declaredTargets = node.reworkPolicy?.allowedTargetNodeIds;
    const explicitTargets = (declaredTargets ?? [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    if (Array.isArray(declaredTargets)) {
      return new Set(explicitTargets);
    }
    return this.resolveUpstreamRoleNodeIds(instance, node.id);
  }

  /** 创建系统反馈记录，并统一规范图片与关联产出物。 */
  private createSystemFeedbackRecord(
    instanceId: OrchestrationId,
    nodeId: string,
    action: Extract<FeedbackRecordAction, "system_rework" | "system_rework_followup" | "system_human_input" | "system_approval_note">,
    input?: {
      feedback?: string | null;
      images?: string[] | null;
      artifactIds?: ArtifactId[] | null;
      executionOverride?: NodeFeedbackExecutionOverride | null;
    },
  ): FeedbackRecord {
    const images = normalizeFeedbackImages(input?.images);
    return this.ctx.db.orchFeedback.create({
      instanceId,
      nodeId,
      action,
      feedback: input?.feedback ?? null,
      images: images.length ? images : null,
      artifactIds: input?.artifactIds ?? null,
      executionOverride: input?.executionOverride ?? null,
      createdAt: Date.now(),
    });
  }

  private skipBranch(instanceId: OrchestrationId, nodeId: string, instance: OrchestrationInstance): void {
    if (!this.shouldCascadeSkip(nodeId, instance)) return;
    const state = instance.nodeStates[nodeId];
    if (state && (state.status === "pending" || state.status === "ready")) {
      state.status = "skipped";
      state.completedAt = Date.now();
      instance.nodeStates[nodeId] = state;
      this.persistNodeState(instanceId, instance, nodeId);

      const node = instance.workflowSnapshot.nodes.find((n) => n.id === nodeId);
      if (node) {
        this.emitNodeStateChanged(instance, nodeId, node.label, "skipped");
      }

      // 递归跳过后继节点
      const outEdges = instance.workflowSnapshot.edges.filter((e) => e.sourceNodeId === nodeId);
      for (const edge of outEdges) {
        if (this.shouldCascadeSkip(edge.targetNodeId, instance)) {
          this.skipBranch(instanceId, edge.targetNodeId, instance);
        }
      }
    }
  }

  /** 判断节点是否已没有可执行入边；未选条件入边视为关闭，但其他活跃入边可保留节点。 */
  private shouldCascadeSkip(nodeId: string, instance: OrchestrationInstance): boolean {
    const inEdges = instance.workflowSnapshot.edges.filter((edge) => edge.targetNodeId === nodeId);
    if (!inEdges.length) return true;
    return inEdges.every((edge) => {
      if (this.isInactiveConditionEdge(edge, instance)) return true;
      return instance.nodeStates[edge.sourceNodeId]?.status === "skipped";
    });
  }

  /** 判断条件节点出边是否因已选择其他分支而失活；新无标签分支按目标节点区分。 */
  private isInactiveConditionEdge(edge: WorkflowEdge, instance: OrchestrationInstance): boolean {
    const sourceNode = instance.workflowSnapshot.nodes.find((node) => node.id === edge.sourceNodeId);
    if (sourceNode?.type !== "condition") return false;
    const branchTaken = String(instance.nodeStates[edge.sourceNodeId]?.branchTaken ?? "").trim();
    if (!branchTaken) return false;
    return !this.isConditionEdgeSelected(edge, branchTaken);
  }

  private emitNodeStateChanged(instance: OrchestrationInstance, nodeId: string, nodeLabel: string, status: NodeExecutionStatus): void {
    const nodeState = instance.nodeStates[nodeId] ?? null;
    const attemptId = this.resolveNodeAttemptId(nodeState);
    if (nodeState && attemptId) {
      nodeState.attemptId = attemptId;
      nodeState.nodeExecutionId = attemptId;
    }
    this.settleCurrentNodeAttemptForStatus(instance.id, nodeId, nodeState, status);
    this.emitOrchEvent(instance, "orchestration.nodeStateChanged", {
      instanceId: instance.id,
      nodeId,
      nodeLabel,
      status,
      nodeExecutionId: attemptId,
      attemptNo: nodeState?.attemptNo ?? null,
      parentExecutionId: nodeState?.parentExecutionId ?? null,
      threadId: nodeState?.threadId,
      nodeState,
    });
  }

  /** 记录并广播编排事件，同时补齐需求上下文供共享工作区授权过滤。 */
  private emitOrchEvent(instance: OrchestrationInstance, type: string, payload: Record<string, unknown>): void {
    const requirementId = String(instance.intakeSnapshot?.id ?? "").trim();
    const eventPayload = requirementId
      ? { ...payload, requirementId, intakeId: requirementId }
      : payload;
    const event = this.ctx.db.orchEvents.append({
      instanceId: instance.id,
      nodeId: typeof eventPayload.nodeId === "string" ? eventPayload.nodeId : null,
      type,
      payloadJson: JSON.stringify(eventPayload),
    });
    this.ctx.emitOrchestration?.(instance.workspaceId, event);
    this.syncChatWorkflowThreadActivity(instance);
  }

  /** 生命周期诊断只用持久实例 W；描述、脱敏与同步写入共享一个保因边界。 */
  private writeLifecycleLog(
    source: OrchestrationInstance | OrchestrationId,
    message: string,
    code: string,
    action: string,
    context: Record<string, unknown>,
    business?: { error: unknown; title?: string },
    root?: (describe: (error: unknown, depth?: number) => Record<string, unknown>) => unknown,
    tag = "orchestration",
    level: "error" | "warn" = "error",
  ): void {
    try {
      const instance = typeof source === "string" ? this.ctx.db.orchInstances.get(source) : source;
      if (!instance) throw new Error(`编排日志缺少可信实例: ${source}`);
      let remaining = 20;
      /** 只读 data descriptor；聚合数组仅按有界 length/索引读取，不执行未知代码。 */
      const describe = (error: unknown, depth = 0, skill = false): Record<string, unknown> => {
        if (remaining-- <= 0) return { message: "[TRUNCATED]" };
        const result: Record<string, unknown> = { type: error === null ? "null" : typeof error };
        if (error === null || (typeof error !== "object" && typeof error !== "function")) {
          if (typeof error === "string") result.message = redactClientStartupText(error).slice(0, 1000);
          return result;
        }
        /** 反射本身失败交给外层保因，不访问 getter。 */
        const data = (key: string): PropertyDescriptor | undefined => {
          const field = Object.getOwnPropertyDescriptor(error, key);
          return field && "value" in field ? field : undefined;
        };
        skill ||= data("code")?.value === "SKILL_RUNTIME_PACKAGE_INVALID";
        for (const key of ["name", "message", "code", "errno", "errcode", "threadId", "turnId", "instanceId", "nodeId", "attemptId", "requestId", "workspaceId"]) {
          if (skill && key === "message") continue;
          const field = data(key);
          if (field && (typeof field.value === "string" || typeof field.value === "number")) result[key] = typeof field.value === "string" ? redactClientStartupText(field.value).slice(0, 1000) : field.value;
        }
        const cause = data("cause"), errors = data("errors");
        if (depth < 3 && cause) result.cause = describe(cause.value, depth + 1, skill);
        if (result.code === "ORCHESTRATION_TURN_INTERRUPT_FAILED" && cause && depth < 3) result.message = (result.cause as Record<string, unknown>).message;
        if (depth < 3 && Array.isArray(errors?.value)) {
          const length = Object.getOwnPropertyDescriptor(errors.value, "length");
          if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) throw new Error("ORCHESTRATION_DIAGNOSTIC_ARRAY_INVALID");
          result.errors = Array.from({ length: Math.min(length.value, 10) }, (_, index) => {
            const item = Object.getOwnPropertyDescriptor(errors.value, String(index));
            return describe(item && "value" in item ? item.value : undefined, depth + 1, skill);
          });
        }
        return result;
      };
      const rootCause = root ? root(describe) : business ? describeOrchestrationProfileFailure(business.error) ?? describe(business.error) : context.rootCause;
      this.ctx.db.writeWorkspaceLog(instance.workspaceId, { level, tag, message, data: {
        code, errorCode: code, event: { category: tag, action, outcome: "fail" }, ...context,
        requestId: context.requestId ?? `instance:${instance.id}:${action}`, workspaceId: instance.workspaceId, instanceId: instance.id, rootCause,
      } });
    } catch (diagnosticError) {
      throw new OrchestrationWorkspaceLogFailure(business ? [business.error, diagnosticError] : [diagnosticError], business ? business.error : diagnosticError, business?.title);
    }
  }

  /** 成功事件只尝试一次；安全描述和固定日志同边界失败，原提交事实保持。 */
  private emitCompletionEvent(instance: OrchestrationInstance, state?: OrchestrationRunState): void {
    try {
      this.emitOrchEvent(instance, "orchestration.completed", { instanceId: instance.id, status: "completed" });
    } catch (error) {
      try {
        const rootCause: Record<string, unknown> = { type: error === null ? "null" : typeof error };
        if (error !== null && (typeof error === "object" || typeof error === "function")) {
          for (const key of ["name", "message", "code", "errno", "errcode"]) {
            const field = Object.getOwnPropertyDescriptor(error, key);
            if (field && "value" in field && (typeof field.value === "string" || typeof field.value === "number")) {
              rootCause[key] = typeof field.value === "string" ? redactClientStartupText(field.value).slice(0, 1000) : field.value;
            }
          }
        } else if (typeof error === "string") rootCause.message = redactClientStartupText(error).slice(0, 1000);
        else rootCause.value = error;
        this.ctx.db.writeWorkspaceLog(instance.workspaceId, { level: "error", tag: "orchestration", message: "completion event delivery failed", data: {
          event: { category: "orchestration", action: "completion_event", outcome: "fail" }, errorCode: "ORCHESTRATION_COMPLETION_EVENT_FAILED",
          requestId: state?.requestId ?? null, workspaceId: instance.workspaceId, instanceId: instance.id, runId: state?.runId ?? null,
          eventType: "orchestration.completed", rootCause,
        } });
      } catch (diagnosticError) {
        throw new OrchestrationCompletionEventFailure([error, diagnosticError], error);
      }
      throw new OrchestrationCompletionEventFailure([error], error);
    }
  }

  /**
   * 会话工作流绑定实例的每次编排活动都静默同步承载会话的活动时间：
   * 让左侧会话行的「活动」时间跟随节点执行刷新，且不产生会话流消息。
   */
  private syncChatWorkflowThreadActivity(instance: OrchestrationInstance): void {
    const binding = this.ctx.resolveChatWorkflowBinding?.(instance.id);
    if (!binding) return;
    notifyChatWorkflowThreadActivity({
      host: {
        touchThread: (threadId, updatedAt) => this.ctx.db.threads.touch(threadId, updatedAt),
        emitOrchestration: this.ctx.emitOrchestration,
      },
      workspaceId: instance.workspaceId,
      threadId: binding.threadId,
      instanceId: instance.id,
      taskId: binding.taskId,
    });
  }

  private emitArtifactRevisionConversationEvent(
    instance: OrchestrationInstance,
    threadId: string | null | undefined,
    payload: OrchestrationArtifactRevisedPayload,
  ): void {
    const normalizedThreadId = String(threadId ?? "").trim();
    if (!normalizedThreadId) return;
    const thread = this.ctx.db.threads?.get?.(normalizedThreadId as ThreadId);
    if (!thread?.engine) return;
    this.ctx.emitConversation({
      ts: Date.now(),
      workspaceId: instance.workspaceId,
      threadId: normalizedThreadId as ThreadId,
      engine: thread.engine,
      type: "orchestration.artifactRevised",
      payload,
    });
  }

  private buildArtifactRevisedEventPayload(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeLabel: string,
    nodeState: NodeExecutionState,
    basedOn: Artifact,
    revised: Artifact,
    input: {
      note?: string | null;
      answer: NodeExecutionEnvelope;
    },
  ): OrchestrationArtifactRevisedPayload {
    return {
      instanceId: instance.id,
      nodeId,
      nodeLabel,
      threadId: nodeState.threadId ?? null,
      artifactId: revised.id,
      artifactKind: revised.kind,
      version: revised.version,
      basedOnArtifactId: basedOn.id,
      basedOnVersion: basedOn.version,
      note: String(input.note ?? "").trim() || null,
      summary: revised.manifest?.summary ?? input.answer.summary ?? null,
      changedFiles: revised.manifest?.changedFiles ?? input.answer.changedFiles ?? null,
      files: this.collectArtifactRevisionFiles(input.answer),
      workspaceStatus: revised.workspaceStatus ?? null,
      stagingPath: revised.stagingPath ?? null,
      publishedPath: revised.publishedPath ?? null,
    };
  }

  private collectArtifactRevisionFiles(
    envelope: NodeExecutionEnvelope,
  ): Array<{ path: string; summary?: string | null }> | null {
    if (envelope.mode === "file") {
      return [{
        path: envelope.file.path,
        summary: envelope.file.summary ?? null,
      }, ...(envelope.attachments ?? []).map((file) => ({ path: file.path, summary: file.summary ?? null }))];
    }
    if (envelope.mode === "file-set") {
      return [
        ...envelope.files.map((file) => ({
          path: file.path,
          summary: file.summary ?? null,
        })),
        ...(envelope.attachments ?? []).map((file) => ({
          path: file.path,
          summary: file.summary ?? null,
        })),
      ];
    }
    return null;
  }

  /** 在任何推进副作用前确保实例已持久化完整运行图。 */
  async ensureAssetRuntimeSnapshotForExecution(instanceId: OrchestrationId): Promise<OrchestrationInstance> {
    this.assertAcceptingExecution();
    const existing = await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId));
    if (!existing) throw new Error(`编排实例不存在: ${instanceId}`);
    await this.withDatabase(() => this.ctx.assertAssetExecution?.(existing));
    if (existing.assetRuntimeSnapshot) return existing;
    if (this.isTerminalInstanceStatus(existing.status)) {
      throw new Error(`终态历史实例无需补录运行快照，不能继续推进: ${instanceId}`);
    }
    if (!this.ctx.ensureAssetRuntimeSnapshot) {
      throw new Error(`编排实例缺少完整运行快照且补录服务未装配: ${instanceId}`);
    }
    await this.ctx.ensureAssetRuntimeSnapshot(instanceId);
    this.assertAcceptingExecution();
    const persisted = await this.withDatabase(() => this.ctx.db.orchInstances.get(instanceId));
    if (!persisted?.assetRuntimeSnapshot) {
      throw new Error(`编排实例完整运行快照补录失败: ${instanceId}`);
    }
    await this.withDatabase(() => this.ctx.assertAssetExecution?.(persisted));
    return persisted;
  }

  /** 读取已校验持久化的实例运行图；缺失时同步阻断任何 attempt。 */
  private requireAssetRuntimeSnapshot(instance: OrchestrationInstance): OrchestrationAssetRuntimeSnapshot {
    const snapshot = instance.assetRuntimeSnapshot ?? null;
    if (!snapshot) throw new Error(`编排实例缺少完整运行快照: ${instance.id}`);
    return snapshot;
  }

  /** 仅从实例完整图解析角色，并补齐旧运行 helper 仍要求的非展示时间字段。 */
  private resolveSnapshotRoleDefinitionForAttempt(instance: OrchestrationInstance, roleId: RoleId): RoleDefinition {
    const snapshot = this.requireAssetRuntimeSnapshot(instance);
    const entry = snapshot.roles[String(roleId)];
    if (!entry || entry.definition.workspaceId !== instance.workspaceId) {
      throw new Error(`实例运行快照缺少角色或角色不属于当前工作区: ${roleId}`);
    }
    return materializeSnapshotDefinition(entry.definition, entry.source);
  }

  /** 保留既有私有测试入口，但数据源固定为实例完整图。 */
  private resolveRoleDefinition(instance: OrchestrationInstance, roleId: RoleId): RoleDefinition | null {
    return this.resolveSnapshotRoleDefinitionForAttempt(instance, roleId);
  }

  private describeGateFailure(results: GateResult[]): string {
    const failures = results.filter((result) => !result.passed);
    if (!failures.length) return "门禁未通过";
    return `门禁未通过: ${failures.map((result) => `${result.criterionId}(${result.message})`).join("; ")}`;
  }

  private applyRoleFailurePolicy(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    reason: string,
    options: {
      source: "gate" | "execution";
      errorCode?: string | null;
      recoveryMetadata?: OrchestrationRecoveryErrorMetadata | null;
      gateResults?: GateResult[] | null;
      artifactId?: ArtifactId | null;
    },
  ): boolean {
    const recoveryMetadata = options.recoveryMetadata ?? null;
    const failPolicy = node.failPolicy ?? "wait-feedback";
    const actionSource = options.source;

    if (options.artifactId && failPolicy !== "wait-feedback") {
      const state = instance.nodeStates[node.id] ?? null;
      this.rejectNodeArtifacts(instance, node.id, {
        ...(state ?? { nodeId: node.id, status: "failed", retryCount: 0 }),
        outputArtifactIds: options.artifactId ? [options.artifactId] : state?.outputArtifactIds ?? null,
      });
    }

    if (failPolicy === "skip") {
      this.updateNodeStatus(instanceId, node, instance, "skipped", {
        error: reason,
        errorCode: recoveryMetadata?.code ?? options.errorCode ?? null,
        recoveryMetadata,
      });
      return true;
    }

    if (failPolicy === "wait-feedback") {
      this.updateNodeStatus(instanceId, node, instance, "waiting-feedback", {
        error: reason,
        errorCode: recoveryMetadata?.code ?? options.errorCode ?? null,
        recoveryMetadata,
        humanActionSource: actionSource,
      });
      this.emitOrchEvent(instance, "orchestration.feedbackRequested", {
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        source: actionSource,
        gateResults: options.gateResults ?? null,
        reason,
      });
      return true;
    }

    this.updateInstanceStatus(instanceId, "failed");
    this.updateNodeStatus(instanceId, node, instance, "failed", {
      error: reason,
      errorCode: recoveryMetadata?.code ?? options.errorCode ?? null,
      recoveryMetadata,
    });
    return true;
  }

  private resolveNodeApprovalMode(
    instance: OrchestrationInstance,
    node: WorkflowNode,
  ): "auto" | "manual" {
    if (instance.runtimeConfig?.interactionMode === "unattended") {
      return "auto";
    }
    if (node.approvalMode === "manual" || node.approvalMode === "auto") {
      return node.approvalMode;
    }
    const intakeMode = instance.intakeSnapshot.constraints?.nodeApprovalMode;
    if (intakeMode === "manual" || intakeMode === "auto") {
      return intakeMode;
    }
    const runtimeMode = instance.runtimeConfig?.defaultNodeApprovalMode;
    if (runtimeMode === "manual" || runtimeMode === "auto") {
      return runtimeMode;
    }
    return "auto";
  }

  private resolveNodeInputArtifacts(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
  ): NodeInputArtifactResolution {
    if (node.inputReferences?.length) {
      return this.resolveStructuredNodeInputs(instance, node);
    }
    const bindableArtifacts = this.pickLatestBindableArtifacts(
      this.ctx.db.orchArtifacts.listByInstance(instance.id),
      (artifact) => `${artifact.nodeId}::${artifact.kind}`,
    );
    const predecessorNodeIds = new Set(
      instance.workflowSnapshot.edges
        .filter((edge) => edge.targetNodeId === node.id)
        .map((edge) => edge.sourceNodeId),
    );
    const upstreamRoleNodeIds = this.resolveUpstreamRoleNodeIds(instance, node.id);
    const ids: ArtifactId[] = [];
    const missingRequired: string[] = [];
    const fieldValues: Record<string, string> = {};

    const bindings = node.inputBindings ?? [];
    if (bindings.length) {
      for (const binding of bindings) {
        const matched = this.matchArtifactsForBinding(bindableArtifacts, predecessorNodeIds, binding);
        ids.push(...matched.map((artifact) => artifact.id));
        if (binding.targetField && matched.length) {
          const resolvedText = matched
            .map((artifact) => this.extractArtifactText(artifact))
            .filter(Boolean)
            .join("\n\n");
          if (resolvedText) {
            fieldValues[binding.targetField] = fieldValues[binding.targetField]
              ? `${fieldValues[binding.targetField]}\n\n${resolvedText}`
              : resolvedText;
          }
        }
        if (binding.required && matched.length === 0) {
          missingRequired.push(this.describeBinding(binding));
        }
      }
    } else {
      for (const artifact of bindableArtifacts) {
        if (upstreamRoleNodeIds.has(artifact.nodeId)) {
          ids.push(artifact.id);
        }
      }
    }

    ids.push(...(instance.nodeStates[node.id]?.inputArtifactIds ?? []));
    const uniqueIds = this.resolveLatestSelectedArtifactIds(instance, ids) ?? [];
    return {
      ids: uniqueIds.length ? uniqueIds : null,
      missingRequired,
      fieldValues,
      resolvedInputs: [],
      resolutionStatus: missingRequired.length ? "missing_required" : "resolved",
    };
  }

  /** Resolves the frozen inputReferences contract without inferring fields from prompt text. */
  private resolveStructuredNodeInputs(instance: OrchestrationInstance, node: WorkflowNode): NodeInputArtifactResolution {
    const references = node.inputReferences ?? [];
    const artifacts = this.ctx.db.orchArtifacts.listByInstance(instance.id);
    const declaredInputIds = new Set(references.map((item) => String(item.id ?? "").trim()).filter(Boolean));
    const seenInputIds = new Set<string>();
    const persistedInputIds = new Set<string>();
    const resolvedInputs: ResolvedNodeInput[] = [];
    const ids: ArtifactId[] = [];
    const fieldValues: Record<string, string> = {};
    let hasInvalidContract = false;

    for (const [referenceIndex, reference] of references.entries()) {
      const inputId = String(reference.id ?? "").trim();
      const targetKey = String(reference.targetKey ?? "").trim();
      const sourceNodeId = String(reference.sourceNodeId ?? "").trim();
      const sourceResultName = String(reference.sourceResultName ?? "").trim();
      const selector = reference.sourceSelector;
      const selectorValid = selector !== null && typeof selector === "object"
        && ["result-summary", "field", "file", "file-set", "result-record"].includes(selector.type)
        && (selector.type !== "field" || Boolean(String(selector.fieldKey ?? "").trim()));
      const promptModeValid = ["reference-only", "inline-value", "inline-summary"].includes(reference.promptMode);
      const duplicateInputId = Boolean(inputId) && seenInputIds.has(inputId);
      if (inputId) seenInputIds.add(inputId);
      if (!inputId || !targetKey || !sourceNodeId || !sourceResultName || !selectorValid
        || !promptModeValid || typeof reference.required !== "boolean" || duplicateInputId) {
        hasInvalidContract = true;
        let persistedInputId = `invalid-contract-${referenceIndex + 1}`;
        while (persistedInputIds.has(persistedInputId) || declaredInputIds.has(persistedInputId)) {
          persistedInputId = `${persistedInputId}-duplicate`;
        }
        persistedInputIds.add(persistedInputId);
        resolvedInputs.push({
          inputId: persistedInputId,
          targetKey,
          required: reference.required === true,
          status: "invalid",
          errorCode: duplicateInputId ? "duplicate_input_id" : "invalid_contract",
          errorMessage: `节点输入引用合同无效: nodeId=${node.id}, inputId=${inputId || "missing"}`,
          config: {
            ...reference,
            id: inputId || persistedInputId,
            targetKey,
            sourceNodeId,
            sourceResultName,
            sourceSelector: selectorValid ? selector : { type: "result-record" },
            required: reference.required === true,
            promptMode: promptModeValid ? reference.promptMode : "reference-only",
          },
          value: null,
          promptText: "",
        });
        continue;
      }

      const resolved = this.resolveStructuredNodeInput(instance, reference, artifacts);
      persistedInputIds.add(resolved.inputId);
      resolvedInputs.push(resolved);
      if (resolved.status !== "resolved" || !resolved.source) continue;
      ids.push(resolved.source.artifactId);
      if (resolved.promptText) fieldValues[resolved.targetKey] = resolved.promptText;
    }

    const requiredFailures = resolvedInputs.filter((item) => item.required && item.status !== "resolved");
    const invalidInputs = resolvedInputs.filter((item) => item.status === "invalid");
    const resolutionStatus: ResolvedNodeContext["status"] = hasInvalidContract || invalidInputs.length
      ? "invalid"
      : requiredFailures.length
        ? "missing_required"
        : "resolved";
    const missingRequired = [
      ...requiredFailures.map((item) => `${item.inputId}:${item.errorCode ?? item.status}`),
      ...invalidInputs.filter((item) => !item.required).map((item) => `${item.inputId}:${item.errorCode ?? item.status}`),
    ];
    const uniqueIds = this.resolveLatestSelectedArtifactIds(instance, ids) ?? [];
    return {
      ids: uniqueIds.length ? uniqueIds : null,
      missingRequired,
      fieldValues,
      resolvedInputs,
      resolutionStatus,
    };
  }

  /** Resolves one structured input reference to an Artifact selector result or an explicit failure. */
  private resolveStructuredNodeInput(
    instance: OrchestrationInstance,
    reference: NonNullable<WorkflowNode["inputReferences"]>[number],
    artifacts: Artifact[],
  ): ResolvedNodeInput {
    const fail = (status: "missing" | "invalid", errorCode: string, errorMessage: string): ResolvedNodeInput => ({
      inputId: reference.id,
      targetKey: reference.targetKey,
      required: reference.required,
      status,
      errorCode,
      errorMessage,
      config: reference,
      value: null,
      promptText: "",
    });
    if (reference.versionPolicy === "specific-artifact" && !reference.sourceArtifactId) {
      return fail("invalid", "specific_artifact_required", `输入引用缺少指定 Artifact: inputId=${reference.id}`);
    }
    const candidates = artifacts.filter((artifact) => (
      artifact.instanceId === instance.id
      && artifact.nodeId === reference.sourceNodeId
      && artifact.kind === reference.sourceResultName
      && artifact.status !== "rejected"
      && artifact.status !== "superseded"
    ));
    let artifact: Artifact | null = null;
    if (reference.sourceArtifactId) {
      artifact = candidates.find((item) => item.id === reference.sourceArtifactId) ?? null;
    } else {
      artifact = candidates.reduce<Artifact | null>((latest, item) => (
        !latest || this.isArtifactNewer(item, latest) ? item : latest
      ), null);
    }
    if (!artifact) return fail("missing", "artifact_not_found", `输入 Artifact 不存在或不可消费: inputId=${reference.id}`);

    const source = {
      nodeId: artifact.nodeId,
      artifactId: artifact.id,
      resultName: artifact.kind,
      version: artifact.version,
      status: artifact.status,
    };
    const selector = reference.sourceSelector;
    let value: ResolvedNodeInput["value"] = null;
    let inlineValue = "";
    let inlineSummary = this.extractArtifactSummary(artifact) ?? "";
    if (selector.type === "field") {
      const fields = this.ctx.db.orchArtifactFields.listByArtifact(artifact.id)
        .filter((field) => field.resultName === reference.sourceResultName && field.fieldKey === selector.fieldKey);
      if (fields.length !== 1) return fail("missing", "field_not_found", `输入字段无法唯一解析: inputId=${reference.id}, fieldKey=${selector.fieldKey}`);
      const field = fields[0]!;
      if (field.validationStatus !== "valid") return fail("invalid", "field_invalid", `输入字段无效: inputId=${reference.id}, fieldKey=${selector.fieldKey}`);
      if (reference.expectedValueType && field.valueType !== reference.expectedValueType) {
        return fail("invalid", "type_mismatch", `输入字段类型不匹配: inputId=${reference.id}, expected=${reference.expectedValueType}, actual=${field.valueType}`);
      }
      value = { type: "field", fieldKey: field.fieldKey, valueJson: field.valueJson, preview: field.valuePreview ?? null };
      inlineValue = formatNodeResultFieldValue(field).valueText;
      inlineSummary = field.valuePreview ?? inlineValue.slice(0, 240);
    } else if (selector.type === "file") {
      const requestedPath = String(selector.path ?? "").trim().replace(/\\/g, "/");
      const files = this.ctx.db.orchArtifactFiles.listByArtifact(artifact.id).filter((file) => {
        if (selector.fileKey && file.fileKey !== selector.fileKey) return false;
        if (!requestedPath) return true;
        return [file.relPath, file.stagingPath, file.publishedPath]
          .map((item) => String(item ?? "").replace(/\\/g, "/"))
          .includes(requestedPath);
      });
      if (files.length !== 1) return fail("missing", "file_not_found", `输入文件无法唯一解析: inputId=${reference.id}`);
      const file = files[0]!;
      if (file.validationStatus !== "valid") {
        return fail("invalid", "file_invalid", `输入文件无效: inputId=${reference.id}, fileId=${file.id}`);
      }
      const extension = path.extname(file.relPath).toLowerCase();
      const allowedExtensions = (reference.allowedExtensions ?? []).map((item) => {
        const normalized = String(item ?? "").trim().toLowerCase();
        return normalized && !normalized.startsWith(".") ? `.${normalized}` : normalized;
      }).filter(Boolean);
      if (allowedExtensions.length && !allowedExtensions.includes(extension)) {
        return fail("invalid", "extension_not_allowed", `输入文件扩展名不允许: inputId=${reference.id}, extension=${extension || "none"}`);
      }
      if (reference.expectedFormat && file.format !== reference.expectedFormat) {
        return fail("invalid", "format_mismatch", `输入文件格式不匹配: inputId=${reference.id}, expected=${reference.expectedFormat}, actual=${file.format ?? "missing"}`);
      }
      const workspacePath = file.publishedPath || file.stagingPath || file.relPath;
      value = {
        type: "file", fileKey: file.fileKey ?? null, artifactFileId: file.id, relPath: file.relPath,
        workspacePath, summary: file.summary ?? null, format: file.format ?? null,
        sizeBytes: file.sizeBytes, contentHash: file.contentHash, readRequired: true,
      };
      inlineValue = workspacePath;
      inlineSummary = file.summary ?? workspacePath;
    } else if (selector.type === "file-set") {
      const baseDir = String(selector.baseDir ?? "").trim().replace(/\\/g, "/");
      const files = this.ctx.db.orchArtifactFiles.listByArtifact(artifact.id).filter((file) => (
        !baseDir || String(file.relPath).replace(/\\/g, "/").startsWith(`${baseDir.replace(/\/$/, "")}/`)
      ));
      if (!files.length) return fail("missing", "file_set_empty", `输入文件集为空: inputId=${reference.id}`);
      const invalidFile = files.find((file) => file.validationStatus !== "valid");
      if (invalidFile) return fail("invalid", "file_invalid", `输入文件集包含无效文件: inputId=${reference.id}, fileId=${invalidFile.id}`);
      const invalidExtension = files.find((file) => {
        const allowed = (reference.allowedExtensions ?? []).map((item) => {
          const normalized = String(item ?? "").trim().toLowerCase();
          return normalized && !normalized.startsWith(".") ? `.${normalized}` : normalized;
        }).filter(Boolean);
        return allowed.length > 0 && !allowed.includes(path.extname(file.relPath).toLowerCase());
      });
      if (invalidExtension) return fail("invalid", "extension_not_allowed", `输入文件集包含不允许的扩展名: inputId=${reference.id}`);
      const invalidFormat = reference.expectedFormat
        ? files.find((file) => file.format !== reference.expectedFormat)
        : null;
      if (invalidFormat) {
        return fail("invalid", "format_mismatch", `输入文件集格式不匹配: inputId=${reference.id}, expected=${reference.expectedFormat}, actual=${invalidFormat.format ?? "missing"}`);
      }
      const resultFiles = files.map((file) => ({
        artifactId: artifact.id,
        fileKey: file.fileKey ?? null,
        source: file.fileRole ?? undefined,
        contractKey: file.contractKey ?? null,
        relPath: file.relPath,
        workspacePath: file.publishedPath || file.stagingPath || file.relPath,
        summary: file.summary ?? null,
        format: file.format ?? null,
        sizeBytes: file.sizeBytes,
        contentHash: file.contentHash,
        readRequired: true,
      }));
      value = { type: "file-set", baseDir: baseDir || null, files: resultFiles, summary: inlineSummary || null };
      inlineValue = resultFiles.map((file) => file.workspacePath).join("\n");
    } else if (selector.type === "result-summary") {
      if (!inlineSummary) return fail("missing", "summary_not_found", `输入摘要不存在: inputId=${reference.id}`);
      value = { type: "result-summary", summary: inlineSummary };
      inlineValue = inlineSummary;
    } else {
      inlineValue = this.extractArtifactText(artifact);
      if (!inlineValue) return fail("missing", "result_record_empty", `输入结果记录为空: inputId=${reference.id}`);
      value = { type: "inline", text: inlineValue };
    }

    const maxInlineChars = Math.max(1, Math.min(100_000, Number(reference.maxInlineChars ?? 12_000) || 12_000));
    const promptText = reference.promptMode === "reference-only"
      ? `Artifact ${artifact.id} / ${reference.sourceResultName} / ${reference.sourceSelector.type}`
      : (reference.promptMode === "inline-summary" ? inlineSummary : inlineValue).slice(0, maxInlineChars);
    return {
      inputId: reference.id,
      targetKey: reference.targetKey,
      required: reference.required,
      status: "resolved",
      errorCode: null,
      errorMessage: null,
      config: reference,
      source,
      value,
      promptText,
    };
  }

  /** Persists one attempt-scoped input resolution before any required-input block or prompt creation. */
  private persistNodeInputResolution(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    attempt: OrchNodeAttempt,
    resolution: NodeInputArtifactResolution,
  ): ResolvedNodeContext | null {
    if (!node.inputReferences?.length) return null;
    const existing = this.ctx.db.orchNodeContextResolutions
      .listByNode(instance.id, node.id)
      .find((record) => record.attemptNo === attempt.attemptNo) ?? null;
    const comparable = {
      status: resolution.resolutionStatus,
      inputs: resolution.resolvedInputs,
      task: {
        title: this.resolveTaskTitle(instance),
        titlePathSegment: buildTaskTitlePathSegment(instance.intakeSnapshot),
        goal: this.resolveTaskGoal(instance),
        background: instance.intakeSnapshot.background ?? null,
      },
    };
    if (existing) {
      const persistedComparable = {
        status: existing.context.status,
        inputs: existing.context.inputs,
        task: existing.context.task,
      };
      if (JSON.stringify(persistedComparable) !== JSON.stringify(comparable)) {
        throw new Error(`节点输入解析在同一 Attempt 内发生漂移: instanceId=${instance.id}, nodeId=${node.id}, attemptNo=${attempt.attemptNo}`);
      }
      return existing.context;
    }
    const now = Date.now();
    const context: ResolvedNodeContext = {
      schemaVersion: "node-context/v1",
      contextId: `ctx_${crypto.randomUUID()}`,
      instanceId: instance.id,
      nodeId: node.id,
      attemptNo: attempt.attemptNo,
      status: resolution.resolutionStatus,
      createdAt: now,
      error: resolution.resolutionStatus === "resolved" ? null : {
        code: resolution.resolutionStatus === "invalid" ? "INVALID_INPUT_CONTRACT" : "MISSING_REQUIRED_INPUT",
        message: resolution.missingRequired.join(", "),
        details: resolution.resolvedInputs
          .filter((item) => item.status !== "resolved")
          .map((item) => ({ inputId: item.inputId, errorCode: item.errorCode ?? item.status })),
      },
      task: comparable.task,
      inputs: resolution.resolvedInputs,
      upstreamResults: resolution.resolvedInputs.flatMap((item) => item.source ? [{
        nodeId: item.source.nodeId,
        artifactId: item.source.artifactId,
        resultName: item.source.resultName,
        version: item.source.version,
        status: item.source.status,
      }] : []),
    };
    this.ctx.db.orchNodeContextResolutions.create({
      instanceId: instance.id,
      nodeId: node.id,
      attemptNo: attempt.attemptNo,
      status: context.status,
      context,
      error: context.error ?? null,
    });
    return context;
  }

  private buildRenderContext(instance: OrchestrationInstance): Record<string, string> {
    const context: Record<string, string> = {};
    const artifacts = this.pickLatestBindableArtifacts(
      this.ctx.db.orchArtifacts.listByInstance(instance.id),
      (artifact) => artifact.nodeId,
    );
    for (const artifact of artifacts) {
      const text = this.extractArtifactText(artifact);
      if (text) context[artifact.nodeId] = text;
    }
    return context;
  }

  private resolveTaskGoal(instance: OrchestrationInstance): string {
    return String(instance.intakeSnapshot.goal ?? "").trim();
  }

  /** Resolves the stable requirement title used to group role output paths. */
  private resolveTaskTitle(instance: OrchestrationInstance): string {
    return getTaskIntakeTitle(instance.intakeSnapshot);
  }

  /** Collects active feedback records and images for the next node prompt. */
  private collectFeedbackContext(instance: OrchestrationInstance, nodeId: string): {
    feedbackPatch: string | null;
    latestFeedbackPatch: string | null;
    latestFeedbackText: string | null;
    latestAction: FeedbackRecordAction | null;
    latestSource: NodeHumanActionSource | null;
    feedbackImages: string[] | null;
    artifactIds: ArtifactId[] | null;
    executionOverride: NodeFeedbackExecutionOverride | null;
  } {
    const recordIds = this.resolvePromptFeedbackRecordIds(instance, nodeId);
    if (!recordIds.length) {
      return {
        feedbackPatch: null,
        latestFeedbackPatch: null,
        latestFeedbackText: null,
        latestAction: null,
        latestSource: null,
        feedbackImages: null,
        artifactIds: null,
        executionOverride: null,
      };
    }
    const records = recordIds
      .map((id) => this.ctx.db.orchFeedback.get(id))
      .filter((record): record is FeedbackRecord => Boolean(record));
    const patches = records
      .map((record) => this.formatFeedbackRecord(instance, record))
      .filter(Boolean);
    const latestRecord = records.length ? records[records.length - 1] ?? null : null;
    const latestFeedbackPatch = latestRecord ? this.formatFeedbackRecord(instance, latestRecord) : null;
    const artifactIds = Array.from(new Set(records.flatMap((record) => record.artifactIds ?? [])));
    const feedbackImages = normalizeFeedbackImages(records.flatMap((record) => record.images ?? []));
    let executionOverride: NodeFeedbackExecutionOverride | null = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const candidate = records[index]?.executionOverride;
      if (candidate == null) continue;
      executionOverride = normalizeNodeFeedbackExecutionOverride(candidate);
      break;
    }
    return {
      feedbackPatch: patches.length ? patches.join("\n\n") : null,
      latestFeedbackPatch,
      latestFeedbackText: String(latestRecord?.feedback ?? "").trim() || null,
      latestAction: latestRecord?.action ?? null,
      latestSource: latestRecord?.source ?? null,
      feedbackImages: feedbackImages.length ? feedbackImages : null,
      artifactIds: artifactIds.length ? artifactIds : null,
      executionOverride,
    };
  }

  private resolvePromptFeedbackRecordIds(instance: OrchestrationInstance, nodeId: string): FeedbackRecordId[] {
    const nodeState = instance.nodeStates[nodeId];
    if (!nodeState) return [];
    if (nodeState.activeFeedbackRecordIds !== undefined) {
      return [...(nodeState.activeFeedbackRecordIds ?? [])];
    }
    const legacyRecordIds = nodeState.feedbackRecordIds ?? [];
    if (!legacyRecordIds.length) return [];
    const records = legacyRecordIds
      .map((id) => this.ctx.db.orchFeedback.get(id))
      .filter((record): record is FeedbackRecord => Boolean(record));
    const latestRecord = records.length ? records[records.length - 1] ?? null : null;
    if (!latestRecord) return [];
    if (
      (latestRecord.action === "retry"
        || latestRecord.action === "resume_with_input"
        || latestRecord.action === "human_artifact_edit")
      && nodeState.status === "ready"
    ) {
      return [latestRecord.id];
    }
    if (
      (
        latestRecord.action === "system_rework"
        || latestRecord.action === "system_rework_followup"
        || latestRecord.action === "system_human_input"
        || latestRecord.action === "system_approval_note"
      )
      && (nodeState.status === "pending" || nodeState.status === "ready")
    ) {
      return [latestRecord.id];
    }
    return [];
  }

  private appendFeedbackHistoryRecord(nodeState: NodeExecutionState, recordId: FeedbackRecordId): void {
    nodeState.feedbackRecordIds = this.mergeFeedbackRecordIds(nodeState.feedbackRecordIds, [recordId]);
  }

  private appendActiveFeedbackRecord(nodeState: NodeExecutionState, recordId: FeedbackRecordId): void {
    nodeState.activeFeedbackRecordIds = this.mergeFeedbackRecordIds(nodeState.activeFeedbackRecordIds, [recordId]);
  }

  private replaceActiveFeedbackRecords(
    nodeState: NodeExecutionState,
    recordIds: FeedbackRecordId[] | null | undefined,
  ): void {
    nodeState.activeFeedbackRecordIds = this.mergeFeedbackRecordIds(null, recordIds);
  }

  private mergeFeedbackRecordIds(
    current: FeedbackRecordId[] | null | undefined,
    next: Array<FeedbackRecordId | null | undefined> | null | undefined,
  ): FeedbackRecordId[] | null {
    const ids = Array.from(new Set([
      ...(current ?? []),
      ...((next ?? []).filter((value): value is FeedbackRecordId => Boolean(value))),
    ]));
    return ids.length ? ids : null;
  }

  private resolveLatestSelectedArtifactIds(
    instance: OrchestrationInstance,
    artifactIds: Array<ArtifactId | string> | null | undefined,
  ): ArtifactId[] | null {
    if (!artifactIds?.length) return null;
    const artifacts = artifactIds
      .map((artifactId) => this.ctx.db.orchArtifacts.get(String(artifactId) as ArtifactId))
      .filter((artifact): artifact is Artifact => {
        if (!artifact) return false;
        return artifact.instanceId === instance.id;
      })
      .filter((artifact) => artifact.status !== "rejected" && artifact.status !== "superseded");
    const latest = this.pickLatestBindableArtifacts(artifacts, (artifact) => `${artifact.nodeId}::${artifact.kind}`);
    return latest.length ? latest.map((artifact) => artifact.id) : null;
  }

  private resolveLatestNodeOutputArtifacts(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeState: NodeExecutionState | null | undefined,
  ): Artifact[] {
    const selectedIds = nodeState?.outputArtifactIds?.length
      ? nodeState.outputArtifactIds
      : this.ctx.db.orchArtifacts.listByNode(instance.id, nodeId).map((artifact) => artifact.id);
    const latestIds = this.resolveLatestSelectedArtifactIds(instance, selectedIds) ?? [];
    return latestIds
      .map((artifactId) => this.ctx.db.orchArtifacts.get(artifactId))
      .filter((artifact): artifact is Artifact => {
        if (!artifact) return false;
        return artifact.nodeId === nodeId;
      });
  }

  /** 解析重试/人工补充要带回 prompt 的反馈证据；允许当前节点被驳回的 Ask 中间结果。 */
  private resolveRetryBaselineArtifactIds(
    instance: OrchestrationInstance,
    nodeId: string,
    artifactIds: Array<ArtifactId | string> | null | undefined,
  ): ArtifactId[] | null {
    const explicit = this.resolveArtifactEvidenceByIds(instance, artifactIds);
    const nodeOutputs = this.resolveNodeOutputArtifactEvidence(instance, nodeId, instance.nodeStates[nodeId] ?? null);
    const latest = this.pickLatestArtifacts([...explicit, ...nodeOutputs], (artifact) => `${artifact.nodeId}::${artifact.kind}`);
    return latest.length ? latest.map((artifact) => artifact.id) : null;
  }

  /** 按显式 id 读取反馈证据工件，保留 rejected/superseded 作为问题来源。 */
  private resolveArtifactEvidenceByIds(
    instance: OrchestrationInstance,
    artifactIds: Array<ArtifactId | string> | null | undefined,
  ): Artifact[] {
    if (!artifactIds?.length) return [];
    return artifactIds
      .map((artifactId) => this.ctx.db.orchArtifacts.get(String(artifactId) as ArtifactId))
      .filter((artifact): artifact is Artifact => {
        if (!artifact) return false;
        return artifact.instanceId === instance.id;
      });
  }

  /** 读取当前节点输出作为反馈证据，Ask 结果即使被 discard 也应能回传给下一轮。 */
  private resolveNodeOutputArtifactEvidence(
    instance: OrchestrationInstance,
    nodeId: string,
    nodeState: NodeExecutionState | null | undefined,
  ): Artifact[] {
    const selectedIds = nodeState?.outputArtifactIds?.length
      ? nodeState.outputArtifactIds
      : this.ctx.db.orchArtifacts.listByNode(instance.id, nodeId).map((artifact) => artifact.id);
    return this.resolveArtifactEvidenceByIds(instance, selectedIds)
      .filter((artifact) => artifact.nodeId === nodeId);
  }

  /** Builds prompt artifact references from explicit ids; feedback evidence may include inactive artifacts. */
  private buildArtifactInputSnapshot(
    instance: OrchestrationInstance,
    artifactIds: ArtifactId[] | null,
    fieldBindings: Record<string, string>,
    inputContext: ResolvedNodeContext | null = null,
  ): NodeArtifactInput {
    const inputReferences: NodePromptInputReferenceSnapshot[] | null = inputContext
      ? inputContext.inputs.map((item) => ({
          inputId: item.inputId,
          targetKey: item.targetKey,
          required: item.required,
          selectorType: item.config.sourceSelector.type,
          promptMode: item.config.promptMode,
          status: item.status,
          errorCode: item.errorCode ?? null,
          sourceArtifactId: item.source?.artifactId ?? null,
          sourceFieldKey: item.config.sourceSelector.type === "field" ? item.config.sourceSelector.fieldKey : null,
        })).sort((left, right) => left.inputId.localeCompare(right.inputId))
      : null;
    if (!artifactIds?.length) {
      return {
        artifacts: [],
        fieldBindings,
        inputContextId: inputContext?.contextId ?? null,
        inputReferences,
      };
    }
    const artifactMap = new Map(
      this.ctx.db.orchArtifacts
        .listByInstance(instance.id)
        .map((artifact) => [artifact.id, artifact] as const),
    );
    const selected = artifactIds
      .map((artifactId) => artifactMap.get(artifactId))
      .filter((artifact): artifact is Artifact => Boolean(artifact));
    return {
      artifacts: selected.map((artifact) => {
        const artifactFiles = this.ctx.db.orchArtifactFiles.listByArtifact(artifact.id);
        const fields = this.buildArtifactInputFields(artifact);
        const workspaceFileRefs = this.buildArtifactInputFileRefs(artifact, artifactFiles);
        const workspaceAttachmentRefs = this.buildArtifactInputAttachmentRefs(artifact, artifactFiles);
        return {
          artifactId: artifact.id,
          kind: artifact.kind,
          nodeId: artifact.nodeId,
          title: artifact.title || artifact.kind,
          version: artifact.version,
          status: artifact.status,
          summaryText: this.extractArtifactSummary(artifact),
          textContent: artifactFiles.length ? "" : this.extractArtifactText(artifact),
          workspaceFiles: artifactFiles.map((item) => item.publishedPath || item.stagingPath || item.relPath),
          fields: fields.length ? fields : null,
          workspaceFileRefs: workspaceFileRefs.length ? workspaceFileRefs : null,
          workspaceAttachmentRefs: workspaceAttachmentRefs.length ? workspaceAttachmentRefs : null,
        };
      }),
      fieldBindings,
      inputContextId: inputContext?.contextId ?? null,
      inputReferences,
    };
  }

  /** 读取 artifact 字段索引，转成下游 prompt 可直接消费的稳定字段值。 */
  private buildArtifactInputFields(artifact: Artifact): NodeArtifactInputField[] {
    return this.ctx.db.orchArtifactFields.listByArtifact(artifact.id).map((field) => {
      const formatted = formatNodeResultFieldValue(field);
      return {
        key: field.fieldKey,
        label: field.label ?? null,
        valueType: field.valueType,
        valueText: formatted.valueText,
        valuePreview: field.valuePreview ?? null,
        required: field.required,
        validationStatus: field.validationStatus,
        truncated: formatted.truncated,
      };
    });
  }

  /** 读取 artifact 文件索引，保留 fileKey/format/path 给下游按引用读取。 */
  private buildArtifactInputFileRefs(
    artifact: Artifact,
    files: ReturnType<ClientDb["orchArtifactFiles"]["listByArtifact"]>,
  ): NodeArtifactInputFileRef[] {
    return files
      .filter((file) => (file.fileRole ?? "contract") !== "attachment")
      .map((file) => {
        const pathValue = file.publishedPath || file.stagingPath || file.relPath;
        const manifestFile = (artifact.manifest?.files ?? []).find((item) => item.relPath === file.relPath || item.relPath === pathValue);
        return {
          fileKey: file.fileKey ?? null,
          path: pathValue,
          summary: manifestFile?.summary ?? file.relPath,
          format: file.format ?? null,
          validationStatus: file.validationStatus ?? null,
        };
      });
  }

  /** 读取 artifact 附件索引；附件可读但不是稳定交付契约输入。 */
  private buildArtifactInputAttachmentRefs(
    artifact: Artifact,
    files: ReturnType<ClientDb["orchArtifactFiles"]["listByArtifact"]>,
  ): NodeArtifactInputAttachmentRef[] {
    return files
      .filter((file) => file.fileRole === "attachment")
      .map((file) => {
        const pathValue = file.publishedPath || file.stagingPath || file.relPath;
        const manifestFile = (artifact.manifest?.files ?? []).find((item) => item.relPath === file.relPath || item.relPath === pathValue);
        return {
          key: file.fileKey ?? null,
          path: pathValue,
          summary: file.summary ?? manifestFile?.summary ?? file.relPath,
          kind: normalizeAttachmentRefKind(file.format),
          format: file.format ?? null,
          validationStatus: file.validationStatus ?? null,
        };
      });
  }

  private extractArtifactSummary(artifact: Artifact): string | null {
    const manifestSummary = String(artifact.manifest?.summary ?? "").trim();
    const text = this.extractArtifactText(artifact)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    const summary = manifestSummary || (text ? (text.length > 240 ? `${text.slice(0, 240)}...` : text) : null);
    const revisionHint = this.describeArtifactRevisionHint(artifact);
    if (summary && revisionHint) return `${summary}；${revisionHint}`;
    return summary ?? revisionHint;
  }

  /** 规格确定加载，其他项目知识只注入导航；读取失败交由节点执行边界记录并失败。 */
  private resolveKnowledgeContext(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    knowledgeRuntime: KnowledgeRuntimeService,
  ): { catalogs: KnowledgeCatalogSnapshot[]; warnings: NodePromptSnapshot["knowledgeWarnings"]; projectSpecifications: string | null } {
    const snapshot = this.requireAssetRuntimeSnapshot(instance);
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    const bundleIds = new Set<string>(instance.workflowSnapshot.workflowKnowledgeBundleIds ?? []);
    for (const bundleId of role.defaultKnowledgeBundleIds ?? []) bundleIds.add(bundleId);
    for (const bundleId of node.knowledgeOverrideBundleIds ?? []) bundleIds.add(bundleId);
    const catalogs: KnowledgeCatalogSnapshot[] = [];
    let projectSpecifications: string | null = null;
    const warnings: NonNullable<NodePromptSnapshot["knowledgeWarnings"]> = [];
    for (const bundleId of bundleIds) {
      const entry = snapshot.knowledgeBundles[bundleId];
      if (!entry) throw new Error(`实例运行快照缺少知识包：${bundleId}`);
      const bundle = materializeSnapshotDefinition(entry.definition, entry.source) as KnowledgeBundleDefinition;
      const catalog = knowledgeRuntime.buildCatalog(bundle);
      catalogs.push(catalog);
      warnings.push(...(catalog.warnings ?? []));
    }
    {
      const projectStore = workspacePath ? new KnowledgeAssetStore(workspacePath) : null;
      const projectKnowledge = projectStore?.snapshot(false, false);
      if (projectKnowledge?.initialized) {
        projectSpecifications = renderKnowledgeSpecificationRules(projectStore!);
        catalogs.push({
          bundleId: "project-file-knowledge" as any,
          bundleName: "项目文件知识",
          scope: "shared",
          createdAt: Date.now(),
          inlineItems: [],
          runtimeSources: [{
            bundleId: "project-file-knowledge" as any,
            bundleName: "项目文件知识",
            sourceId: "asset-tree",
            sourceKey: "project-file-knowledge/asset-tree",
            sourceKind: "workspace-dir",
            title: "项目资产树与按需知识文档",
            description: `项目知识保存在 ${projectKnowledge.root}；先用 knowledge.tree.read 返回的 nodeStates.hasCurrent/hasDraft 判断资产状态，只有需要正文、来源或 currentHash 时才调用 knowledge.node.read；通过 knowledge.search 按需定位资料。\n${KNOWLEDGE_CHANGE_RULE}`,
            originRef: projectKnowledge.root,
            workspaceRelPath: projectKnowledge.root,
            targetType: "directory",
          }],
          warnings: [],
        });
      }
    }
    const selectedInlineItems = knowledgeRuntime.trimInlineItemsForPrompt(
      catalogs.flatMap((catalog) => catalog.inlineItems ?? []),
    );
    const inlineBySourceKey = new Map(selectedInlineItems.map((item) => [item.sourceKey, item]));
    return {
      catalogs: catalogs.map((catalog) => ({
        ...catalog,
        inlineItems: (catalog.inlineItems ?? [])
          .map((item) => inlineBySourceKey.get(item.sourceKey))
          .filter((item): item is KnowledgeCatalogSnapshot["inlineItems"][number] => Boolean(item)),
      })),
      warnings,
      projectSpecifications,
    };
  }

  /** 判断节点是否启用同会话严格串行工作项。 */
  private isSequentialWorkItemNode(node: WorkflowNode | null | undefined): boolean {
    return node?.type === "role" && node.workItemPolicy?.mode === "sequential";
  }

  /** 解析本轮生效的工作项策略，运行覆盖优先且不改写历史流程快照。 */
  private resolveNodeWorkItemPolicy(
    instance: OrchestrationInstance,
    node: WorkflowNode | null | undefined,
  ): NodeWorkItemPolicy | null {
    if (!node) return null;
    return instance.runtimeConfig?.nodeWorkItemPolicyOverrides?.[node.id]
      ?? node.workItemPolicy
      ?? null;
  }

  /** 为单次节点执行附加运行态工作项策略，保留快照对象不可变。 */
  private withRuntimeNodeWorkItemPolicy(instance: OrchestrationInstance, node: WorkflowNode): WorkflowNode {
    const workItemPolicy = this.resolveNodeWorkItemPolicy(instance, node);
    return workItemPolicy === node.workItemPolicy ? node : { ...node, workItemPolicy };
  }

  /** 在严格节点创建清单时冻结稳定来源、输出路径和逐项验收条件。 */
  private validateNodeWorkItemCreateInputs(
    node: WorkflowNode,
    items: Array<{
      clientKey: string;
      sourceKey: string | null;
      outputPath: string | null;
      acceptanceCriteria: Array<{ id: string; label: string }>;
    }>,
  ): void {
    const completion = node.workItemPolicy?.completion ?? null;
    if (!completion) return;
    for (const [index, item] of items.entries()) {
      if (!item.sourceKey) {
        throw new Error(`严格工作项 items[${index}] 必须声明稳定 sourceKey，供精确返工定位`);
      }
      if (completion.verifyOutputPath && !item.outputPath) {
        throw new Error(`严格工作项 items[${index}] 必须声明 workspace 相对 outputPath`);
      }
    }
  }

  /** 严格节点启动前可调整工作项，但不能移除精确返工和完成门禁所需字段。 */
  private validateNodeWorkItemUpdatePatch(
    node: WorkflowNode,
    patch: NodeWorkItemUpdatePatch,
    currentItem: NodeWorkItem | null = null,
  ): void {
    const completion = node.workItemPolicy?.completion ?? null;
    if (!completion) return;
    if (currentItem?.status === "completed" && patch.status === "pending") {
      throw new Error(`严格工作项 ${currentItem.clientKey} 已完成；请使用 ${ORCH_WORK_ITEMS_REOPEN_MANY_TOOL_ID} 按稳定 sourceKey 批量重开`);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "sourceKey") && !patch.sourceKey) {
      throw new Error("严格工作项不能清空稳定 sourceKey");
    }
    if (completion.verifyOutputPath
      && Object.prototype.hasOwnProperty.call(patch, "outputPath")
      && !patch.outputPath) {
      throw new Error("严格工作项不能清空 workspace 相对 outputPath");
    }
    if (completion.requireAcceptanceChecks
      && Object.prototype.hasOwnProperty.call(patch, "acceptanceCriteria")
      && patch.acceptanceCriteria?.length === 0
      && currentItem?.startedAt != null
      && (currentItem?.acceptanceCriteria.length ?? 0) > 0) {
      throw new Error("严格工作项不能清空已有 acceptanceCriteria");
    }
  }

  /** 完成工作项前验证证据、已配置的验收条件和 UTF-8 输出文件，并返回 Host 计算的哈希。 */
  private validateNodeWorkItemCompletion(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    input: {
      itemId: string;
      evidence: string[];
      completionChecks: NodeWorkItemCompletionCheck[];
      outputPath: string | null;
    },
  ): { outputPath: string | null; outputSha256: string | null } {
    const item = this.ctx.db.orchNodeWorkItems.get(instance.id, node.id, input.itemId);
    if (!item) throw new Error(`当前节点不存在工作项：${input.itemId}`);
    const completion = node.workItemPolicy?.completion ?? null;
    if (item.outputPath && input.outputPath && item.outputPath !== input.outputPath) {
      throw new Error(`工作项 ${item.clientKey} 完成时不能改写冻结 outputPath：${input.outputPath}`);
    }
    const outputPath = item.outputPath ?? input.outputPath;
    if (!completion) return { outputPath, outputSha256: null };
    if (completion.requireEvidence && input.evidence.length === 0) {
      throw new Error(`工作项 ${item.clientKey} 完成前必须提供至少一条 evidence`);
    }
    // 空条件表示零项验收；证据和输出文件仍按当前严格策略校验。
    if (completion.requireAcceptanceChecks
      && item.acceptanceCriteria.length > 0
      && input.completionChecks.length === 0) {
      throw new Error(`工作项 ${item.clientKey} 完成前必须逐项提交 completionChecks`);
    }
    if (!completion.verifyOutputPath) return { outputPath, outputSha256: null };
    if (!outputPath) throw new Error(`工作项 ${item.clientKey} 缺少 outputPath，不能验证真实产出`);
    if (path.isAbsolute(outputPath)) throw new Error(`工作项 ${item.clientKey} 的 outputPath 必须是工作区相对路径：${outputPath}`);
    const workspacePath = String(this.ctx.workspaces.get(instance.workspaceId) ?? "").trim();
    if (!workspacePath) throw new Error(`工作项 ${item.clientKey} 无法解析工作区路径`);
    const workspaceAbs = fs.realpathSync(path.resolve(workspacePath));
    const candidateAbs = path.resolve(workspaceAbs, outputPath);
    if (!isSameOrNestedAbsolutePath(candidateAbs, workspaceAbs)) {
      throw new Error(`工作项 ${item.clientKey} 的 outputPath 越出工作区：${outputPath}`);
    }
    if (!fs.existsSync(candidateAbs) || !fs.statSync(candidateAbs).isFile()) {
      throw new Error(`工作项 ${item.clientKey} 的 outputPath 不是可读取文件：${outputPath}`);
    }
    const realOutputAbs = fs.realpathSync(candidateAbs);
    if (!isSameOrNestedAbsolutePath(realOutputAbs, workspaceAbs)) {
      throw new Error(`工作项 ${item.clientKey} 的 outputPath 通过链接越出工作区：${outputPath}`);
    }
    const content = fs.readFileSync(realOutputAbs);
    if (content.includes(0)) throw new Error(`工作项 ${item.clientKey} 的 outputPath 不是文本文件：${outputPath}`);
    const decoded = decodeTextBuffer(content);
    if (decoded.encoding !== "utf8") {
      throw new Error(`工作项 ${item.clientKey} 的 outputPath 必须使用 UTF-8：${outputPath}`);
    }
    return {
      outputPath,
      outputSha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
  }

  /** 在节点任务说明末尾追加轻量工作项恢复上下文，不内联完整清单。 */
  private appendNodeWorkItemPromptContext(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    renderedInput: string,
  ): string {
    if (!this.isSequentialWorkItemNode(node)) return renderedInput;
    const summary = this.ctx.db.orchNodeWorkItems.getSummary(instance.id, node.id);
    const nextItem = this.ctx.db.orchNodeWorkItems.getNext(instance.id, node.id);
    return [
      renderedInput,
      "",
      "节点工作项执行约束：当前节点使用同一 Agent 会话维护工作项，禁止为工作项新建独立会话。",
      `当前进度：${summary.completed}/${summary.total}，pending=${summary.pending}，in_progress=${summary.inProgress}，boardVersion=${summary.boardVersion}。`,
      nextItem
        ? `恢复入口：首个未完成项 id=${nextItem.id}，clientKey=${nextItem.clientKey}，status=${nextItem.status}，version=${nextItem.version}。`
        : "恢复入口：当前没有未完成项。首次执行应先完整创建清单；已有清单全部完成时应汇总并提交节点结果。",
      `必须使用 ${ORCH_WORK_ITEMS_LIST_TOOL_ID} / create / update / delete / reopenMany / complete 维护平台工作项。任意时刻只能有一个 in_progress，且只能按顺序处理首个未完成项。`,
      "严格工作项必须逐条满足冻结 acceptanceCriteria，并由 Host 校验 evidence、UTF-8 outputPath 和 SHA256。Reviewer 的 completed 只表示该项已完成检查，不等于资产审核通过；发现问题仍应记录 finding 后完成该项。",
      `存在未完成项时不得调用 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID} 提交 continue 或 rework；中途需要人工信息时可保留当前进度并提交 ask_human，异常终止可提交 stop。`,
    ].join("\n");
  }

  /** 同步工作项汇总到节点轻量状态，并发出监控刷新事件。 */
  private syncNodeWorkItemSummary(instance: OrchestrationInstance, node: WorkflowNode): NodeWorkItemSummary {
    const summary = this.ctx.db.orchNodeWorkItems.getSummary(instance.id, node.id);
    const nodeState = instance.nodeStates[node.id];
    if (!nodeState) return summary;
    const previous = nodeState.workItemSummary ?? null;
    nodeState.workItemSummary = summary;
    instance.nodeStates[node.id] = nodeState;
    if (previous?.boardVersion === summary.boardVersion && previous.updatedAt === summary.updatedAt) return summary;
    const latest = this.persistNodeState(instance.id, instance, node.id);
    this.emitNodeStateChanged(latest, node.id, node.label, nodeState.status);
    this.emitOrchEvent(latest, "orchestration.nodeWorkItemsChanged", {
      instanceId: latest.id,
      nodeId: node.id,
      nodeLabel: node.label,
      summary,
    });
    return summary;
  }

  /** 构造工作项节点下一回合的最小恢复消息。 */
  private buildNodeWorkItemContinuationMessage(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    summary: NodeWorkItemSummary,
  ): string {
    const nextItem = this.ctx.db.orchNodeWorkItems.getNext(instance.id, node.id);
    if (summary.total === 0) {
      return [
        "当前节点尚未建立工作项清单。",
        `请先根据已批准输入调用 ${ORCH_WORK_ITEMS_CREATE_TOOL_ID} 批量创建完整清单；clientKey 必须稳定且可幂等重放。`,
        "创建后从工具返回的 nextItem 开始，严格按顺序逐项执行。",
      ].join("\n");
    }
    if (nextItem) {
      return [
        `继续当前节点工作项：已完成 ${summary.completed}/${summary.total}。`,
        `首个未完成项：id=${nextItem.id}，clientKey=${nextItem.clientKey}，status=${nextItem.status}，version=${nextItem.version}。`,
        `固定身份：sourceKey=${nextItem.sourceKey ?? "未声明"}，outputPath=${nextItem.outputPath ?? "未声明"}；验收条件=${nextItem.acceptanceCriteria.map((item) => `${item.id}:${item.label}`).join("；") || "无"}。`,
        nextItem.status === "pending"
          ? `先调用 ${ORCH_WORK_ITEMS_UPDATE_TOOL_ID} 把该项切换为 in_progress，再执行实际工作并调用 ${ORCH_WORK_ITEMS_COMPLETE_TOOL_ID}。`
          : `该项已经是 in_progress；继续实际工作，完成后调用 ${ORCH_WORK_ITEMS_COMPLETE_TOOL_ID}。`,
        "不得跳到后续项，不得提前提交节点 continue 或 rework；ask_human 和 stop 不受此完成门禁限制。",
      ].join("\n");
    }
    return [
      `工作项已全部完成：${summary.completed}/${summary.total}。`,
      "请复核清单与实际产出，生成当前角色声明的汇总交付物。",
      `确认无遗漏后调用 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID}：通过时提交 continue，需要驳回时提交 rework。`,
    ].join("\n");
  }

  /** 阻止启用工作项的节点在空清单或未完成状态下提交完成或驳回结论。 */
  private validateNodeWorkItemSubmission(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    finalAnswer: NodeFinalAnswerPayload,
  ): void {
    const nextAction = finalAnswer.control.nextAction;
    if (!this.isSequentialWorkItemNode(node) || (nextAction !== "continue" && nextAction !== "rework")) return;
    const summary = this.ctx.db.orchNodeWorkItems.getSummary(instance.id, node.id);
    if (summary.total === 0) {
      throw new Error(`节点 ${node.label} 提交 ${nextAction} 前必须建立工作项，但当前尚未创建任何工作项；请先调用 ${ORCH_WORK_ITEMS_CREATE_TOOL_ID}`);
    }
    if (summary.completed !== summary.total || summary.pending > 0 || summary.inProgress > 0) {
      throw new Error(`节点 ${node.label} 提交 ${nextAction} 前仍有未完成工作项：completed=${summary.completed}/${summary.total}，pending=${summary.pending}，in_progress=${summary.inProgress}`);
    }
  }

  /** 执行绑定到当前实例和节点的工作项平台工具。 */
  private async executeNodeWorkItemTool(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    attemptId: string,
    toolId: string,
    toolInput: unknown,
  ): Promise<HostToolExecutionResult> {
    if (!this.isSequentialWorkItemNode(node)) {
      return { ok: false, code: "TOOL_NOT_ALLOWED", message: `节点 ${node.label} 未启用工作项` };
    }
    try {
      const body = readNodeWorkItemToolObject(toolInput);
      if (toolId === ORCH_WORK_ITEMS_LIST_TOOL_ID) {
        return {
          ok: true,
          output: (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.list({
            instanceId: instance.id,
            nodeId: node.id,
            statuses: readNodeWorkItemStatuses(body.statuses),
            includeDeleted: body.includeDeleted === true,
            limit: readOptionalInteger(body.limit) ?? undefined,
            cursor: nullableString(body.cursor),
          }))),
        };
      }
      if (toolId === ORCH_WORK_ITEMS_CREATE_TOOL_ID) {
        const rawItems = Array.isArray(body.items) ? body.items : [];
        const items = rawItems.map((raw) => {
          const item = readNodeWorkItemToolObject(raw);
          return {
            clientKey: String(item.clientKey ?? ""),
            title: String(item.title ?? ""),
            description: nullableString(item.description),
            sourceKey: nullableString(item.sourceKey),
            outputPath: nullableString(item.outputPath),
            sortOrder: readOptionalInteger(item.sortOrder),
            acceptanceCriteria: readNodeWorkItemAcceptanceCriteria(item.acceptanceCriteria),
          };
        });
        this.validateNodeWorkItemCreateInputs(node, items);
        const result = (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.createMany({
          instanceId: instance.id,
          nodeId: node.id,
          actorAttemptId: attemptId,
          items,
        })));
        const summary = (await this.withDatabase(() => this.syncNodeWorkItemSummary(instance, node)));
        return {
          ok: true,
          output: {
            createdOrMatchedCount: result.items.length,
            idempotentClientKeys: result.idempotentClientKeys,
            summary,
            nextItem: (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.getNext(instance.id, node.id))),
          },
        };
      }
      if (toolId === ORCH_WORK_ITEMS_UPDATE_TOOL_ID) {
        const patch = readNodeWorkItemToolObject(body.patch);
        const itemId = String(body.itemId ?? "");
        const normalizedPatch: NodeWorkItemUpdatePatch = {
          ...(Object.prototype.hasOwnProperty.call(patch, "title") ? { title: String(patch.title ?? "") } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "description") ? { description: nullableString(patch.description) } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "sourceKey") ? { sourceKey: nullableString(patch.sourceKey) } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "outputPath") ? { outputPath: nullableString(patch.outputPath) } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "sortOrder") ? { sortOrder: Number(patch.sortOrder) } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "acceptanceCriteria")
            ? { acceptanceCriteria: readNodeWorkItemAcceptanceCriteria(patch.acceptanceCriteria) }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "status") ? { status: String(patch.status) as "pending" | "in_progress" } : {}),
        };
        const currentItem = (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.get(instance.id, node.id, itemId)));
        if (!currentItem) throw new NodeWorkItemRepoError("WORK_ITEM_NOT_FOUND", `当前节点不存在工作项：${itemId}`);
        this.validateNodeWorkItemUpdatePatch(node, normalizedPatch, currentItem);
        const result = (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.update({
          instanceId: instance.id,
          nodeId: node.id,
          itemId,
          expectedVersion: Number(body.expectedVersion),
          reason: nullableString(body.reason),
          actorAttemptId: attemptId,
          patch: normalizedPatch,
        })));
        const summary = (await this.withDatabase(() => this.syncNodeWorkItemSummary(instance, node)));
        return { ok: true, output: { ...result, summary } };
      }
      if (toolId === ORCH_WORK_ITEMS_DELETE_TOOL_ID) {
        const result = (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.delete({
          instanceId: instance.id,
          nodeId: node.id,
          itemId: String(body.itemId ?? ""),
          expectedVersion: Number(body.expectedVersion),
          reason: nullableString(body.reason),
          actorAttemptId: attemptId,
        })));
        const summary = (await this.withDatabase(() => this.syncNodeWorkItemSummary(instance, node)));
        return { ok: true, output: { ...result, summary } };
      }
      if (toolId === ORCH_WORK_ITEMS_REOPEN_MANY_TOOL_ID) {
        const mode = String(body.mode ?? "").trim() as "all" | "selected";
        const result = (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.reopenMany({
          instanceId: instance.id,
          actorAttemptId: attemptId,
          reason: String(body.reason ?? ""),
          scopes: [{
            nodeId: node.id,
            mode,
            sourceKeys: Array.isArray(body.sourceKeys) ? body.sourceKeys.map((item) => String(item ?? "")) : null,
            alwaysClientKeys: node.workItemPolicy?.reworkAlwaysClientKeys ?? null,
          }],
        })));
        const summary = (await this.withDatabase(() => this.syncNodeWorkItemSummary(instance, node)));
        return { ok: true, output: { ...result, summary, nextItem: (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.getNext(instance.id, node.id))) } };
      }
      if (toolId === ORCH_WORK_ITEMS_COMPLETE_TOOL_ID) {
        const itemId = String(body.itemId ?? "");
        const evidence = Array.isArray(body.evidence) ? body.evidence.map((item) => String(item ?? "")) : [];
        const submittedCompletionChecks = readNodeWorkItemCompletionChecks(body.completionChecks);
        const currentItem = (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.get(instance.id, node.id, itemId)));
        if (!currentItem) throw new NodeWorkItemRepoError("WORK_ITEM_NOT_FOUND", `当前节点不存在工作项：${itemId}`);
        // 历史空验收合同固定为零项检查，避免旧提示生成的无效 criterionId 阻断完成。
        const completionChecks = currentItem.acceptanceCriteria.length === 0 ? [] : submittedCompletionChecks;
        const completionProof = (await this.withDatabase(() => this.validateNodeWorkItemCompletion(instance, node, {
          itemId,
          evidence,
          completionChecks,
          outputPath: nullableString(body.outputPath),
        })));
        const result = (await this.withDatabase(() => this.ctx.db.orchNodeWorkItems.complete({
          instanceId: instance.id,
          nodeId: node.id,
          itemId,
          expectedVersion: Number(body.expectedVersion),
          resultSummary: String(body.resultSummary ?? ""),
          evidence,
          completionChecks,
          outputPath: completionProof.outputPath,
          outputSha256: completionProof.outputSha256,
          actorAttemptId: attemptId,
        })));
        const summary = (await this.withDatabase(() => this.syncNodeWorkItemSummary(instance, node)));
        return { ok: true, output: { ...result, summary } };
      }
      return { ok: false, code: "TOOL_NOT_FOUND", message: `未找到工作项工具：${toolId}` };
    } catch (error) {
      const code = error instanceof NodeWorkItemRepoError ? error.code : "WORK_ITEM_TOOL_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.nodeWorkItemToolRejected", {
        instanceId: instance.id,
        nodeId: node.id,
        nodeLabel: node.label,
        attemptId,
        toolId,
        code,
        error: message,
      })));
      const recoverable = code === "WORK_ITEM_NOT_FOUND" || code === "WORK_ITEM_VERSION_CONFLICT";
      return {
        ok: false,
        code,
        message,
        ...(recoverable ? {
          output: {
            retryable: true,
            recoveryAction: ORCH_WORK_ITEMS_LIST_TOOL_ID,
            recoveryInput: { statuses: ["pending", "in_progress"], limit: 100 },
          },
        } : {}),
      };
    }
  }

  /** 构造本轮可用工具，并把当前节点输出契约注入提交工具。 */
  private buildToolRegistry(
    tools: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }>,
    _runtimeEvidence: RuntimeEvidenceService,
    accessMode: AccessMode,
    submissionContext?: NodeResultSubmissionToolContext | null,
    node?: WorkflowNode | null,
  ): ExecutableToolRegistry | null {
    const userTools = tools.map(({ toolset, tool, ref }) => ({
      toolsetId: toolset.id,
      toolsetName: toolset.name,
      toolId: tool.id,
      name: tool.name,
      alias: ref.alias ?? null,
      description: tool.description,
      runtime: tool.runtime,
      usageGuidance: ref.usageGuidance ?? null,
      invocationHint: tool.invocationHint ?? null,
      code: tool.code,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      timeoutMs: tool.timeoutMs ?? null,
      workingDirectory: tool.workingDirectory ?? null,
      permissions: {
        requiresWrite: Boolean(tool.requiresWrite),
      },
      envPolicy: tool.envPolicy ?? null,
      required: ref.required ?? false,
    }));
    const runtimeTools = [
      buildNodeResultSubmissionTool(submissionContext),
      ...(this.isSequentialWorkItemNode(node) ? buildNodeWorkItemTools(node?.workItemPolicy ?? null) : []),
      ...(accessMode === "read-only" ? [] : this.managedServiceRuntime.buildBuiltinTools()),
    ];
    const deduped = Array.from(new Map([...userTools, ...runtimeTools].map((tool) => [String(tool.toolId), tool])).values());
    if (!deduped.length) return null;
    return {
      tools: deduped,
    };
  }

  /** 提取当前节点提交工具需要暴露的输出契约上下文。 */
  private buildNodeResultSubmissionToolContext(node: WorkflowNode, role: RoleDefinition): NodeResultSubmissionToolContext {
    return {
      outputMode: node.outputArtifactMode ?? inferRoleArtifactOutputMode(role.outputDefinition),
      outputDefinition: role.outputDefinition,
    };
  }

  private buildRuntimePolicy(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    executionPrefs: {
      engine: EngineType;
      sourceMode?: "auto" | "custom";
      accessMode: AccessMode;
      autoCompactPct: number | null;
      contextWindow: number | null;
    },
    toolRegistry: ExecutableToolRegistry | null,
  ): NodeRuntimePolicy {
    const { kind } = this.resolveOutputArtifactSpec(node, role);
    const outputMode = node.outputArtifactMode ?? inferRoleArtifactOutputMode(role.outputDefinition);
    return {
      workflowId: instance.workflowId,
      workflowName: instance.workflowSnapshot.name,
      nodeId: node.id,
      nodeLabel: node.label,
      approvalMode: this.resolveNodeApprovalMode(instance, node),
      executionEngine: executionPrefs.engine,
      executionProfileMode: executionPrefs.sourceMode ?? null,
      executionProfileLabel: `${executionPrefs.engine}:${executionPrefs.sourceMode ?? "custom"}`,
      accessMode: executionPrefs.accessMode,
      autoCompactPct: executionPrefs.autoCompactPct,
      contextWindow: executionPrefs.contextWindow,
      toolRuntimePolicy: {
        allowedToolIds: toolRegistry?.tools.map((tool) => tool.toolId) ?? [],
        requiresWorkspaceWrite: toolRegistry?.tools.some((tool) => Boolean(tool.permissions.requiresWrite)) ?? false,
      },
      artifactPolicy: {
        persistenceMode: this.resolveArtifactPersistenceMode(node, outputMode),
        outputMode,
        primaryKind: kind,
      },
    };
  }

  private createPromptSnapshot(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    input: Omit<NodePromptSnapshot, "id" | "instanceId" | "nodeId" | "attemptNo" | "createdAt"> & { renderedInputPreview: string },
  ): NodePromptSnapshot {
    const nodeState = instance.nodeStates[node.id];
    const attemptNo = Math.max(1, Number(nodeState?.attemptNo ?? 0) || (nodeState?.promptSnapshotIds?.length ?? 0) + 1);
    const snapshot = this.ctx.db.orchPromptSnapshots.create({
      instanceId: instance.id,
      nodeId: node.id,
      attemptNo,
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      engine: input.engine,
      model: input.model ?? null,
      effort: input.effort ?? null,
      promptEnvelope: input.promptEnvelope,
      roleExecutionRevision: input.promptEnvelope.meta.roleExecutionRevision ?? null,
      systemMessage: input.systemMessage,
      developerMessage: input.developerMessage ?? null,
      userMessage: input.userMessage,
      renderedInputPreview: input.renderedInputPreview,
      runtimePolicy: input.runtimePolicy,
      toolRegistry: input.toolRegistry ?? null,
      knowledgeCatalogs: input.knowledgeCatalogs,
      knowledgeWarnings: input.knowledgeWarnings ?? [],
      artifactInput: input.artifactInput,
      createdAt: Date.now(),
    });
    if (nodeState) {
      nodeState.renderedInput = null;
      nodeState.promptSnapshotIds = [...(nodeState.promptSnapshotIds ?? []), snapshot.id];
      instance.nodeStates[node.id] = nodeState;
      this.persistNodeState(instance.id, instance, node.id);
    }
    this.emitOrchEvent(instance, "orchestration.promptSnapshotCreated", {
      instanceId: instance.id,
      nodeId: node.id,
      nodeLabel: node.label,
      promptSnapshotId: snapshot.id,
      threadId: input.threadId ?? null,
    });
    return snapshot;
  }

  /** 为独立评估线程写入快照；评估线程不依赖普通节点对象。 */
  private createPromptSnapshotByInput(
    input: Omit<NodePromptSnapshot, "id" | "instanceId" | "nodeId" | "attemptNo" | "createdAt"> & { renderedInputPreview: string },
  ): NodePromptSnapshot {
    const snapshot = this.ctx.db.orchPromptSnapshots.create({
      ...input,
      instanceId: input.promptEnvelope.meta.instanceId,
      nodeId: input.promptEnvelope.meta.nodeId,
      attemptNo: 1,
      createdAt: Date.now(),
    });
    const instance = this.ctx.db.orchInstances.get(snapshot.instanceId);
    if (instance) {
      this.emitOrchEvent(instance, "orchestration.promptSnapshotCreated", {
        instanceId: snapshot.instanceId,
        nodeId: snapshot.nodeId,
        nodeLabel: input.promptEnvelope.meta.nodeLabel,
        promptSnapshotId: snapshot.id,
        threadId: snapshot.threadId ?? null,
      });
    }
    return snapshot;
  }

  private renderPromptPreview(systemMessage: string, developerMessage: string | null, userMessage: string): string {
    return [
      "[SYSTEM]",
      systemMessage,
      developerMessage ? "[DEVELOPER]" : "",
      developerMessage ?? "",
      "[USER]",
      userMessage,
    ].filter(Boolean).join("\n\n");
  }

  private matchArtifactsForBinding(
    artifacts: Artifact[],
    predecessorNodeIds: Set<string>,
    binding: ArtifactBinding,
  ): Artifact[] {
    return artifacts.filter((artifact) => {
      if (binding.sourceNodeId) {
        if (artifact.nodeId !== binding.sourceNodeId) return false;
      } else if (predecessorNodeIds.size > 0 && !predecessorNodeIds.has(artifact.nodeId)) {
        return false;
      }
      if (binding.sourceArtifactKind && artifact.kind !== binding.sourceArtifactKind) return false;
      return true;
    });
  }

  private resolveUpstreamRoleNodeIds(instance: OrchestrationInstance, nodeId: string): Set<string> {
    const visited = new Set<string>();
    const upstreamRoleNodeIds = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const inEdges = instance.workflowSnapshot.edges.filter((edge) => edge.targetNodeId === current);
      for (const edge of inEdges) {
        queue.push(edge.sourceNodeId);
        const upstreamNode = instance.workflowSnapshot.nodes.find((item) => item.id === edge.sourceNodeId);
        if (upstreamNode?.type === "role" && upstreamNode.id !== nodeId) {
          upstreamRoleNodeIds.add(upstreamNode.id);
        }
      }
    }
    return upstreamRoleNodeIds;
  }

  private pickLatestBindableArtifacts(
    artifacts: Artifact[],
    keySelector: (artifact: Artifact) => string,
  ): Artifact[] {
    const latestByKey = new Map<string, Artifact>();
    for (const artifact of artifacts) {
      if (artifact.status === "rejected" || artifact.status === "superseded") continue;
      const key = keySelector(artifact);
      const current = latestByKey.get(key);
      if (!current || this.isArtifactNewer(artifact, current)) {
        latestByKey.set(key, artifact);
      }
    }
    return Array.from(latestByKey.values());
  }

  /** 按 key 选择最新工件，不过滤状态；仅用于反馈证据等需要读取失效结果的链路。 */
  private pickLatestArtifacts(
    artifacts: Artifact[],
    keySelector: (artifact: Artifact) => string,
  ): Artifact[] {
    const latestByKey = new Map<string, Artifact>();
    for (const artifact of artifacts) {
      const key = keySelector(artifact);
      const current = latestByKey.get(key);
      if (!current || this.isArtifactNewer(artifact, current)) {
        latestByKey.set(key, artifact);
      }
    }
    return Array.from(latestByKey.values());
  }

  private isArtifactNewer(candidate: Artifact, current: Artifact): boolean {
    if (candidate.version !== current.version) {
      return candidate.version > current.version;
    }
    if (candidate.updatedAt !== current.updatedAt) {
      return candidate.updatedAt > current.updatedAt;
    }
    if (candidate.createdAt !== current.createdAt) {
      return candidate.createdAt > current.createdAt;
    }
    return String(candidate.id) > String(current.id);
  }

  private describeBinding(binding: ArtifactBinding): string {
    return [
      binding.sourceNodeId ? `sourceNode=${binding.sourceNodeId}` : "",
      binding.sourceArtifactKind ? `kind=${binding.sourceArtifactKind}` : "",
      binding.targetField ? `target=${binding.targetField}` : "",
    ].filter(Boolean).join(" ");
  }

  private formatFeedbackRecord(instance: OrchestrationInstance, record: FeedbackRecord): string | null {
    const feedback = String(record.feedback ?? "").trim();
    const artifactSummary = this.describeFeedbackArtifacts(instance, record.artifactIds ?? null);
    const imageCount = normalizeFeedbackImages(record.images).length;
    if (!feedback && !artifactSummary && !imageCount) return null;
    const lines = [`- ${this.feedbackActionLabel(record.action)}`];
    if (feedback) lines.push(feedback);
    if (imageCount) lines.push(`附图：${imageCount} 张`);
    if (artifactSummary) lines.push(`相关产出物：${artifactSummary}`);
    return lines.join("\n");
  }

  /** 将反馈动作转成注入后续 prompt 的短标签。 */
  private feedbackActionLabel(action: FeedbackRecordAction): string {
    if (action === "system_rework") return "退回修改要求";
    if (action === "system_rework_followup") return "返工后复审要求";
    if (action === "system_human_input") return "人工补充要求";
    if (action === "system_approval_note") return "上游审核补充意见";
    if (action === "manual_start_context") return "人工启动补充说明";
    if (action === "human_artifact_edit") return "人工修订记录";
    if (action === "approve") return "人工审核通过";
    if (action === "retry") return "人工要求重做";
    if (action === "override") return "人工忽略建议";
    if (action === "skip") return "人工跳过节点";
    if (action === "resume_with_input") return "人工补充后继续";
    if (action === "choose_branch") return "人工选择分支";
    if (action === "rework_to_target") return "人工驳回到指定节点";
    if (action === "abort") return "人工终止";
    if (action === "cancel") return "人工取消";
    return action;
  }

  private describeFeedbackArtifacts(
    instance: OrchestrationInstance,
    artifactIds: ArtifactId[] | null | undefined,
  ): string | null {
    if (!artifactIds?.length) return null;
    const artifacts = artifactIds
      .map((artifactId) => this.ctx.db.orchArtifacts.get(artifactId))
      .filter((artifact): artifact is Artifact => {
        if (!artifact) return false;
        return artifact.instanceId === instance.id;
      });
    if (!artifacts.length) return null;
    return artifacts
      .map((artifact) => artifact.title || artifact.kind)
      .join("、");
  }

  private collectArtifactRevisionNotes(
    instance: OrchestrationInstance,
    artifactIds: ArtifactId[] | null | undefined,
  ): string | null {
    if (!artifactIds?.length) return null;
    const artifactsById = new Map(
      this.ctx.db.orchArtifacts.listByInstance(instance.id).map((artifact) => [artifact.id, artifact] as const),
    );
    const entries = Array.from(new Set(
      artifactIds.flatMap((artifactId) => {
        const artifact = artifactsById.get(artifactId);
        return artifact ? this.collectArtifactRevisionLineageEntries(artifactsById, artifact) : [];
      }),
    ));
    if (!entries.length) return null;
    return [
      "人工修订记录：",
      ...entries.map((entry) => `- ${entry}`),
    ].join("\n");
  }

  private collectArtifactRevisionLineageEntries(
    artifactsById: Map<ArtifactId, Artifact>,
    artifact: Artifact,
  ): string[] {
    const entries: string[] = [];
    const visited = new Set<ArtifactId>();
    let current: Artifact | null = artifact;

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const revision = getArtifactRevisionMetadata(current);
      if (revision?.source === "human") {
        const note = String(revision.note ?? "").trim() || "人工修订后未填写说明";
        entries.push(`${current.title || current.kind}：${note}`);
      }
      current = revision?.basedOnArtifactId ? (artifactsById.get(revision.basedOnArtifactId) ?? null) : null;
    }

    return entries.reverse();
  }

  private describeArtifactRevisionHint(artifact: Artifact): string | null {
    const revision = getArtifactRevisionMetadata(artifact);
    if (!revision || revision.source !== "human") return null;
    const note = String(revision.note ?? "").trim();
    const basedOnVersion = revision.basedOnVersion ? `，基于 v${revision.basedOnVersion}` : "";
    return note
      ? `人工修订${basedOnVersion}：${note}`
      : `人工修订${basedOnVersion}`;
  }

  private resolveRoleTools(
    instance: OrchestrationInstance,
    role: RoleDefinition,
  ): Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }> {
    const snapshot = this.requireAssetRuntimeSnapshot(instance);
    const resolved: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }> = [];
    for (const ref of role.toolRefs ?? []) {
      const entry = snapshot.toolsets[String(ref.toolsetId)];
      if (!entry) {
        throw new Error(`实例运行快照缺少角色「${role.name}」绑定的工具集：${ref.toolsetId}`);
      }
      const toolset = materializeSnapshotDefinition(entry.definition, entry.source) as ToolsetDefinition;
      const tool = toolset.tools.find((item) => item.id === ref.toolId);
      if (!tool) {
        throw new Error(`实例运行快照缺少角色「${role.name}」绑定的工具：${ref.toolsetId}/${ref.toolId}`);
      }
      resolved.push({ toolset, tool, ref });
    }
    return resolved;
  }

  /** 解析角色绑定的 Skills，并确保每个 Skill 属于当前工作区且支持当前执行引擎。 */
  private resolveRoleSkills(
    instance: OrchestrationInstance,
    role: RoleDefinition,
    engine: EngineType,
  ): SkillDefinition[] {
    const snapshot = this.requireAssetRuntimeSnapshot(instance);
    const resolved: SkillDefinition[] = [];
    const seen = new Set<string>();
    const targetEngine = engine === "claude" || engine === "codex" ? engine : null;
    for (const rawSkillId of role.defaultSkillIds ?? []) {
      const skillId = String(rawSkillId ?? "").trim() as SkillId;
      if (!skillId || seen.has(skillId)) continue;
      seen.add(skillId);
      const entry = snapshot.skills[String(skillId)];
      if (!entry) {
        throw new Error(`实例运行快照缺少角色「${role.name}」绑定的 Skill：${skillId}`);
      }
      const skill = materializeSnapshotDefinition(entry.definition, entry.source) as SkillDefinition;
      if (!targetEngine || !skill.targetEngines.includes(targetEngine)) {
        throw new Error(`角色「${role.name}」绑定的 Skill 不支持当前执行引擎 ${engine}：${skill.name}`);
      }
      resolved.push(skill);
    }
    return resolved;
  }

  /** Builds the prompt snapshot revision exclusively from the instance runtime snapshot. */
  private buildRoleExecutionRevision(
    role: RoleDefinition,
    tools: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }>,
    skills: SkillDefinition[] = [],
  ): RoleExecutionRevision {
    const toolsetsById = new Map<ToolsetId, ToolsetDefinition>();
    for (const item of tools) {
      toolsetsById.set(item.toolset.id, item.toolset);
    }
    return buildRoleExecutionRevision(role, Array.from(toolsetsById.values()), skills);
  }

  private resolveExecutionPrefs(
    instance: OrchestrationInstance,
    role: RoleDefinition,
    tools: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }>,
    nodeOverride: NodeFeedbackExecutionOverride | null = null,
  ): {
    engine: EngineType;
    model: string | null;
    effort: string | null;
    sourceMode: "auto" | "custom";
    accessMode: AccessMode;
    autoCompactPct: number | null;
    contextWindow: number | null;
    serviceTier: "fast" | null;
    maxRetries: number;
  } {
    const roleOverride = this.resolveRoleExecutionOverride(instance, role);
    const executionConfig = roleOverride?.engine
      ? resolveRuntimeRoleExecutionConfigForEngine(role.executionConfig, roleOverride.engine, role.executionConfig.preferredEngine)
      : resolveRuntimeRoleExecutionConfigForStrategy(
          role.executionConfig,
          instance.runtimeConfig?.executionEngineStrategy,
          role.executionConfig.preferredEngine,
        );
    const engine = executionConfig.engine;
    const effectiveAccessMode = executionConfig.accessMode;
    this.assertToolAccessAllowed(role, tools, effectiveAccessMode);

    const roleContextWindow = roleOverride?.contextWindow ?? executionConfig.contextWindow;
    const contextWindow = nodeOverride && Object.prototype.hasOwnProperty.call(nodeOverride, "contextWindow")
      ? nodeOverride.contextWindow ?? roleContextWindow ?? null
      : roleContextWindow ?? null;
    const effort = nodeOverride && Object.prototype.hasOwnProperty.call(nodeOverride, "effort")
      ? nodeOverride.effort ?? null
      : roleOverride && Object.prototype.hasOwnProperty.call(roleOverride, "effort")
        ? roleOverride.effort ?? null
        : executionConfig.effort;
    const autoCompactPct = nodeOverride && Object.prototype.hasOwnProperty.call(nodeOverride, "autoCompactPct")
      ? nodeOverride.autoCompactPct ?? roleOverride?.autoCompactPct ?? executionConfig.autoCompactPct ?? null
      : roleOverride?.autoCompactPct ?? executionConfig.autoCompactPct ?? null;
    // 服务档位：节点级 > 角色级 > 角色执行配置，只认显式 "fast"。
    // 与相邻 effort/autoCompactPct 一致地用 hasOwnProperty：显式 null 表示"本层关闭 fast"，不再下探更低优先级。
    const requestedServiceTier = nodeOverride && Object.prototype.hasOwnProperty.call(nodeOverride, "serviceTier")
      ? nodeOverride.serviceTier ?? null
      : roleOverride && Object.prototype.hasOwnProperty.call(roleOverride, "serviceTier")
        ? roleOverride.serviceTier ?? null
        : executionConfig.serviceTier ?? null;
    const resolvedModel = this.resolveExecutionModel({
      engine,
      model: nodeOverride?.model ?? roleOverride?.model ?? executionConfig.model,
      contextWindow,
    });
    // 直接复用线程偏好路径的 Fast 能力闸门：它包含本地自定义模型，
    // 避免编排侧另立一套只查 Server 目录行的口径（自定义模型会永远拿不到 fast）。
    const serviceTier = normalizeCodexServiceTier(engine, resolvedModel, requestedServiceTier, getRuntimeEngineModels(engine));

    return {
      engine,
      model: resolvedModel,
      effort,
      sourceMode: roleOverride || nodeOverride ? "custom" : executionConfig.sourceMode,
      accessMode: effectiveAccessMode,
      autoCompactPct,
      contextWindow,
      serviceTier,
      maxRetries: executionConfig.maxRetries ?? 0,
    };
  }

  private assertToolAccessAllowed(
    role: RoleDefinition,
    tools: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }>,
    effectiveAccessMode: AccessMode,
  ): void {
    const toolRequirement = this.resolveToolAccessRequirement(tools);
    if (this.compareAccessModes(toolRequirement.accessMode, effectiveAccessMode) <= 0) return;
    const toolsLabel = toolRequirement.toolNames.length ? `（工具：${toolRequirement.toolNames.join("、")}）` : "";
    throw new Error(
      `角色「${role.name}」绑定的工具至少需要 ${toolRequirement.accessMode}，但角色执行配置里只声明了 ${effectiveAccessMode}${toolsLabel}。请提高该角色的访问模式，或调整工具定义/角色配置。`,
    );
  }

  /** 读取本次流程实例冻结的角色执行覆盖；显式空 effort 表示不发送。 */
  /** 实例已被取消或进入终态：其节点不应再套用失败策略。 */
  private isInstanceExecutionAborted(instanceId: OrchestrationId): boolean {
    const latest = this.ctx.db.orchInstances.get(instanceId);
    return !latest || this.isTerminalInstanceStatus(latest.status);
  }

  /**
   * 节点在等待期间是否已被停止/取消：登记执行后节点只应处于 queued 或 running，
   * 出现其它状态说明它被外部干预过，本轮不应继续。
   */
  private isNodeExecutionSuperseded(instanceId: OrchestrationId, nodeId: string): boolean {
    const status = this.ctx.db.orchInstances.get(instanceId)?.nodeStates[nodeId]?.status;
    if (!status) return false;
    return status !== "queued" && status !== "running";
  }

  /** 读取本次流程实例冻结的角色执行覆盖；显式空 effort 表示不发送该参数。 */
  private resolveRoleExecutionOverride(
    instance: OrchestrationInstance,
    role: RoleDefinition,
  ): OrchestrationRoleExecutionOverride | null {
    const raw = instance.runtimeConfig?.roleExecutionOverrides?.[role.id] ?? null;
    if (!raw || typeof raw !== "object") return null;
    const override: OrchestrationRoleExecutionOverride = {};
    if (raw.engine === "claude" || raw.engine === "codex") override.engine = raw.engine;
    const model = String(raw.model ?? "").trim();
    if (model) override.model = model;
    if (Object.prototype.hasOwnProperty.call(raw, "effort")) {
      const effort = String(raw.effort ?? "").trim();
      override.effort = effort || null;
    }
    const autoCompactPct = Number(raw.autoCompactPct);
    if (Number.isFinite(autoCompactPct) && autoCompactPct >= 50 && autoCompactPct <= 99) override.autoCompactPct = Math.round(autoCompactPct);
    const contextWindow = Number(raw.contextWindow);
    if (Number.isFinite(contextWindow) && contextWindow > 0) override.contextWindow = Math.round(contextWindow);
    if (raw.serviceTier === "fast") override.serviceTier = "fast";
    return Object.keys(override).length ? override : null;
  }

  private resolveExecutionModel(executionConfig: {
    engine: EngineType;
    model: string;
    contextWindow?: number | null;
  }): string | null {
    const baseModel = String(executionConfig.model ?? "").trim();
    if (!baseModel) return null;
    if (executionConfig.engine !== "claude") return baseModel;
    const contextWindow = Number(executionConfig.contextWindow ?? 0);
    const modelInfo = getRuntimeEngineModelCatalogItem("claude", baseModel);
    const hasExplicit1MVariant = Boolean(getRuntimeEngineModelCatalogItem("claude", `${baseModel}[1m]`));
    if (
      Number.isFinite(contextWindow)
      && contextWindow > 200_000
      && !baseModel.endsWith("[1m]")
      && (modelInfo?.supports1MContext || hasExplicit1MVariant)
    ) {
      return `${baseModel}[1m]`;
    }
    return baseModel;
  }

  private resolveToolAccessRequirement(
    tools: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }>,
  ): { accessMode: AccessMode; toolNames: string[] } {
    const requirements = tools.map(({ tool }) => {
      if (tool.requiresWrite) return { accessMode: "full-access" as AccessMode, toolName: tool.name };
      if (
        tool.runtime === "shell"
        || tool.runtime === "python"
        || tool.runtime === "node"
        || tool.runtime === "java"
      ) {
        return { accessMode: "current" as AccessMode, toolName: tool.name };
      }
      return { accessMode: "read-only" as AccessMode, toolName: tool.name };
    });

    let highest: AccessMode = "read-only";
    for (const item of requirements) {
      if (this.compareAccessModes(item.accessMode, highest) > 0) highest = item.accessMode;
    }

    return {
      accessMode: highest,
      toolNames: requirements
        .filter((item) => item.accessMode === highest && highest !== "read-only")
        .map((item) => item.toolName),
    };
  }

  private compareAccessModes(left: AccessMode, right: AccessMode): number {
    return this.accessModeRank(left) - this.accessModeRank(right);
  }

  private accessModeRank(mode: AccessMode): number {
    if (mode === "read-only") return 0;
    if (mode === "current") return 1;
    return 2;
  }

  /** 归一化节点提交工具入参；只有 continue 需要完整满足节点交付模式。 */
  private normalizeNodeResultSubmission(raw: any, expectedMode: ArtifactOutputMode): NodeFinalAnswerPayload {
    if (raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "kind")) {
      throw new Error("节点结果工具入参不应再包含 kind；请直接提交 answer/control/review 等字段");
    }
    const control = this.normalizeFinalAnswerControl(raw?.control);
    return {
      answer: control.nextAction === "continue"
        ? this.normalizeExecutionEnvelope(raw?.answer, expectedMode)
        : this.normalizePartialExecutionEnvelope(raw?.answer),
      control,
      review: this.normalizeFinalAnswerReview(raw?.review),
      acceptanceChecks: this.normalizeAcceptanceChecks(raw?.acceptanceChecks),
      humanInput: this.normalizeHumanInputRequest(raw?.humanInput),
      rework: this.normalizeReworkDirective(raw?.rework),
    };
  }

  /** 为人工修订构造最小节点结果，复用同一套输出契约校验与字段索引逻辑。 */
  private buildHumanRevisionFinalAnswer(answer: NodeExecutionEnvelope): NodeFinalAnswerPayload {
    return {
      answer,
      control: {
        nextAction: "continue",
        reason: "人工修订后的产出物继续作为当前节点结果使用。",
      },
      review: {
        verdict: "pass",
        summary: "人工修订后的产出物作为当前节点最新版本。",
        blockingIssues: [],
      },
      acceptanceChecks: null,
      humanInput: null,
      rework: null,
    };
  }

  /** 按节点声明的输出模式归一化完整交付结果。 */
  private normalizeExecutionEnvelope(raw: any, expectedMode: ArtifactOutputMode): NodeExecutionEnvelope {
    const mode = String(raw?.mode ?? "").trim() || expectedMode;
    if (mode !== expectedMode) {
      throw new Error(`模型输出模式与节点要求不一致：期望 ${expectedMode}，实际 ${mode}`);
    }
    const fields = normalizeEnvelopeFields(raw?.fields);
    const attachments = this.normalizeEnvelopeAttachments(raw?.attachments);
    switch (expectedMode) {
      case "structured":
        return {
          mode: "structured",
          data: raw?.data ?? {},
          summary: nullableString(raw?.summary),
          changedFiles: normalizeStringArray(raw?.changedFiles),
          fields,
          attachments,
        };
      case "file": {
        const file = raw?.file;
        if (!file || typeof file !== "object") throw new Error("模型输出缺少 file 对象");
        const filePath = String(file.path ?? "").trim();
        if (!filePath) throw new Error("模型输出缺少 file.path");
        const inlineContent = typeof file.content === "string" ? file.content.trim() : "";
        if (inlineContent) {
          throw new Error("file 节点不能在节点结果工具入参内联文件正文；请先写入工作区文件，再只返回 path/summary");
        }
        return {
          mode: "file",
          file: {
            key: nullableString(file.key),
            path: filePath,
            summary: nullableString(file.summary),
          },
          summary: nullableString(raw?.summary),
          changedFiles: normalizeStringArray(raw?.changedFiles),
          fields,
          attachments,
        };
      }
      case "file-set": {
        const files = Array.isArray(raw?.files) ? raw.files : [];
        if (!files.length) throw new Error("模型输出缺少 files 数组");
        return {
          mode: "file-set",
          files: files.map((file: any, index: number) => {
            const filePath = String(file?.path ?? "").trim();
            if (!filePath) throw new Error(`模型输出缺少 files[${index}].path`);
            const inlineContent = typeof file?.content === "string" ? file.content.trim() : "";
            if (inlineContent) {
              throw new Error("file-set 节点不能在节点结果工具入参内联文件正文；请先写入工作区文件，再只返回 path/summary");
            }
            return {
              key: nullableString(file?.key),
              path: filePath,
              summary: nullableString(file?.summary),
            };
          }),
          summary: nullableString(raw?.summary),
          changedFiles: normalizeStringArray(raw?.changedFiles),
          fields,
          attachments,
        };
      }
      default:
        return {
          mode: "text",
          text: String(raw?.text ?? raw?.content ?? "").trim(),
          summary: nullableString(raw?.summary),
          changedFiles: normalizeStringArray(raw?.changedFiles),
          fields,
          attachments,
        };
    }
  }

  /** 归一化人工询问、退回、停止等决策型提交，允许只提交说明而不是完整交付物。 */
  private normalizePartialExecutionEnvelope(raw: any): NodeExecutionEnvelope {
    const fields = normalizeEnvelopeFields(raw?.fields);
    const attachments = this.normalizeEnvelopeAttachments(raw?.attachments);
    const mode = String(raw?.mode ?? "").trim();
    if (mode === "structured") {
      return {
        mode: "structured",
        data: raw?.data ?? {},
        summary: nullableString(raw?.summary),
        changedFiles: normalizeStringArray(raw?.changedFiles),
        fields,
        attachments,
      };
    }
    if (mode === "file" && raw?.file && typeof raw.file === "object" && String(raw.file.path ?? "").trim()) {
      return this.normalizeExecutionEnvelope(raw, "file");
    }
    if (mode === "file-set" && Array.isArray(raw?.files) && raw.files.length > 0) {
      return this.normalizeExecutionEnvelope(raw, "file-set");
    }
    return {
      mode: "text",
      text: String(raw?.text ?? raw?.content ?? raw?.summary ?? "").trim(),
      summary: nullableString(raw?.summary),
      changedFiles: normalizeStringArray(raw?.changedFiles),
      fields,
      attachments,
    };
  }

  /** 归一化动态附件；附件不是正式交付物，不能内联正文。 */
  private normalizeEnvelopeAttachments(raw: any): NodeExecutionEnvelope["attachments"] {
    if (raw == null) return null;
    if (!Array.isArray(raw)) {
      throw new Error("节点结果.answer.attachments 必须是数组");
    }
    const attachments = raw.map((file, index) => {
      const filePath = String(file?.path ?? "").trim();
      if (!filePath) throw new Error(`模型输出缺少 attachments[${index}].path`);
      const inlineContent = typeof file?.content === "string" ? file.content.trim() : "";
      if (inlineContent) {
        throw new Error("附件不能在节点结果工具入参内联文件正文；请先写入工作区文件，再只返回 path/summary");
      }
      return {
        key: nullableString(file?.key),
        path: filePath,
        summary: nullableString(file?.summary),
        kind: normalizeAttachmentKind(file?.kind),
        format: normalizeAttachmentFormat(file?.format),
        language: normalizeAttachmentLanguage(file?.language),
      };
    });
    return attachments.length ? attachments : null;
  }

  /** 校验 control 字段，失败时提示 submitNodeResult 基础结构。 */
  private normalizeFinalAnswerControl(raw: any): NodeFinalAnswerPayload["control"] {
    if (!raw || typeof raw !== "object") {
      throw new Error(withSubmitNodeResultExample("节点结果.control 缺失或格式错误", SUBMIT_NODE_RESULT_TEXT_EXAMPLE));
    }
    const nextAction = String(raw.nextAction ?? "").trim();
    if (nextAction !== "continue" && nextAction !== "rework" && nextAction !== "ask_human" && nextAction !== "stop") {
      throw new Error(withSubmitNodeResultExample("节点结果.control.nextAction 无效，必须是 continue / rework / ask_human / stop", SUBMIT_NODE_RESULT_TEXT_EXAMPLE));
    }
    return {
      nextAction,
      reason: nullableString(raw.reason),
    };
  }

  /** 校验 review 字段，确保工具调用包含可审计结论摘要。 */
  private normalizeFinalAnswerReview(raw: any): NodeFinalAnswerPayload["review"] {
    if (!raw || typeof raw !== "object") {
      throw new Error(withSubmitNodeResultExample("节点结果.review 缺失或格式错误", SUBMIT_NODE_RESULT_TEXT_EXAMPLE));
    }
    const verdict = String(raw.verdict ?? "").trim();
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "partial") {
      throw new Error(withSubmitNodeResultExample("节点结果.review.verdict 无效，必须是 pass / fail / partial", SUBMIT_NODE_RESULT_TEXT_EXAMPLE));
    }
    const summary = String(raw.summary ?? "").trim();
    if (!summary) {
      throw new Error(withSubmitNodeResultExample("节点结果.review.summary 不能为空", SUBMIT_NODE_RESULT_TEXT_EXAMPLE));
    }
    return {
      verdict,
      summary,
      blockingIssues: normalizeStringArray(raw.blockingIssues),
    };
  }

  /** 校验 acceptanceChecks 列表格式，未知 criterionId 时允许只提交 label。 */
  private normalizeAcceptanceChecks(raw: any): NodeAcceptanceCheck[] | null {
    if (raw == null) return null;
    if (!Array.isArray(raw)) {
      throw new Error(withSubmitNodeResultExample("节点结果.acceptanceChecks 必须是数组", SUBMIT_NODE_RESULT_ACCEPTANCE_EXAMPLE));
    }
    const checks = raw
      .map((item, index) => this.normalizeAcceptanceCheck(item, index))
      .filter((item): item is NodeAcceptanceCheck => Boolean(item));
    return checks.length ? checks : null;
  }

  /** 校验单个 acceptanceChecks 条目，阻止数组里混入字符串或空对象。 */
  private normalizeAcceptanceCheck(raw: any, index: number): NodeAcceptanceCheck | null {
    if (!raw || typeof raw !== "object") {
      throw new Error(withSubmitNodeResultExample(`节点结果.acceptanceChecks[${index}] 必须是对象`, SUBMIT_NODE_RESULT_ACCEPTANCE_EXAMPLE));
    }
    const criterionId = nullableString(raw.criterionId);
    const label = String(raw.label ?? "").trim();
    if (!criterionId && !label) {
      throw new Error(withSubmitNodeResultExample(`节点结果.acceptanceChecks[${index}] 缺少 criterionId 或 label`, SUBMIT_NODE_RESULT_ACCEPTANCE_EXAMPLE));
    }
    const verdict = String(raw.verdict ?? "").trim();
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "not_evaluated") {
      throw new Error(withSubmitNodeResultExample(`节点结果.acceptanceChecks[${index}].verdict 无效`, SUBMIT_NODE_RESULT_ACCEPTANCE_EXAMPLE));
    }
    return {
      criterionId,
      label: label || criterionId || `acceptance-check-${index + 1}`,
      verdict,
      blocking: raw.blocking !== false,
      evidence: nullableString(raw.evidence),
    };
  }

  /** 校验 ask_human 请求体，确保能生成明确的人工补充问题。 */
  private normalizeHumanInputRequest(raw: any): NodeHumanInputRequest | null {
    if (raw == null) return null;
    if (!raw || typeof raw !== "object") {
      throw new Error(withSubmitNodeResultExample("节点结果.humanInput 必须是对象", SUBMIT_NODE_RESULT_ASK_HUMAN_EXAMPLE));
    }
    const summary = String(raw.summary ?? "").trim();
    if (!summary) {
      throw new Error(withSubmitNodeResultExample("节点结果.humanInput.summary 不能为空", SUBMIT_NODE_RESULT_ASK_HUMAN_EXAMPLE));
    }
    const fields = Array.isArray(raw.fields)
      ? raw.fields.map((field: unknown, index: number) => this.normalizeHumanInputField(field, index))
      : null;
    return {
      summary,
      fields: fields?.length ? fields : null,
    };
  }

  /** 校验 humanInput.fields 单项，保留可选字段的默认文本类型。 */
  private normalizeHumanInputField(raw: any, index: number): NonNullable<NodeHumanInputRequest["fields"]>[number] {
    if (!raw || typeof raw !== "object") {
      throw new Error(withSubmitNodeResultExample(`节点结果.humanInput.fields[${index}] 必须是对象`, SUBMIT_NODE_RESULT_ASK_HUMAN_EXAMPLE));
    }
    const key = String(raw.key ?? "").trim() || `field_${index + 1}`;
    const label = String(raw.label ?? "").trim() || key;
    const valueType = String(raw.valueType ?? "").trim();
    return {
      key,
      label,
      valueType: valueType === "markdown" || valueType === "json" || valueType === "file-path" ? valueType : "text",
      required: raw.required !== false,
      description: nullableString(raw.description),
    };
  }

  /** 校验 rework 指令结构，并强制模型明确声明精确重跑集合。 */
  private normalizeReworkDirective(raw: any): NodeFinalAnswerPayload["rework"] {
    if (raw == null) return null;
    if (!raw || typeof raw !== "object") {
      throw new Error(withSubmitNodeResultExample("节点结果.rework 必须是对象", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    const targetNodeId = String(raw.targetNodeId ?? "").trim();
    const reason = String(raw.reason ?? "").trim();
    if (!targetNodeId) {
      throw new Error(withSubmitNodeResultExample("节点结果.rework.targetNodeId 不能为空", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    if (!reason) {
      throw new Error(withSubmitNodeResultExample("节点结果.rework.reason 不能为空", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    if (!Object.prototype.hasOwnProperty.call(raw, "rerunNodeIds") || raw.rerunNodeIds == null) {
      throw new Error(withSubmitNodeResultExample(
        "节点结果.rework.rerunNodeIds 必须显式填写，系统不会默认扩大为全部影响节点",
        SUBMIT_NODE_RESULT_REWORK_EXAMPLE,
      ));
    }
    if (!Array.isArray(raw.rerunNodeIds)) {
      throw new Error(withSubmitNodeResultExample("节点结果.rework.rerunNodeIds 必须是节点 ID 数组", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    const rerunNodeIds: string[] = Array.from(new Set<string>(
      raw.rerunNodeIds.map((nodeId: unknown) => String(nodeId ?? "").trim()).filter(Boolean),
    ));
    if (rerunNodeIds.length === 0) {
      throw new Error(withSubmitNodeResultExample("节点结果.rework.rerunNodeIds 不能为空数组", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    const hasWorkItemScopes = Object.prototype.hasOwnProperty.call(raw, "workItemScopes");
    return {
      targetNodeId,
      reason,
      rerunNodeIds,
      ...(hasWorkItemScopes ? { workItemScopes: this.normalizeWorkItemReworkScopes(raw.workItemScopes) } : {}),
    };
  }

  /** 归一化模型声明的跨节点工作项返工范围，禁止空选择和重复节点。 */
  private normalizeWorkItemReworkScopes(raw: unknown): NodeWorkItemReworkScope[] | null {
    if (raw == null) return null;
    if (!Array.isArray(raw)) {
      throw new Error(withSubmitNodeResultExample("节点结果.rework.workItemScopes 必须是数组", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    if (raw.length === 0) {
      throw new Error(withSubmitNodeResultExample("节点结果.rework.workItemScopes 不能为空数组", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    if (raw.length > 100) {
      throw new Error(withSubmitNodeResultExample("节点结果.rework.workItemScopes 最多包含 100 个节点", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    const seenNodeIds = new Set<string>();
    return raw.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(withSubmitNodeResultExample(`节点结果.rework.workItemScopes[${index}] 必须是对象`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      const scope = value as Record<string, unknown>;
      const nodeId = String(scope.nodeId ?? "").trim();
      if (!nodeId) throw new Error(withSubmitNodeResultExample(`节点结果.rework.workItemScopes[${index}].nodeId 不能为空`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      if (seenNodeIds.has(nodeId)) throw new Error(withSubmitNodeResultExample(`节点结果.rework.workItemScopes 节点重复：${nodeId}`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      seenNodeIds.add(nodeId);
      const mode = String(scope.mode ?? "").trim();
      if (mode !== "all" && mode !== "selected") {
        throw new Error(withSubmitNodeResultExample(`节点结果.rework.workItemScopes[${index}].mode 只能是 all 或 selected`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      const sourceKeys = Array.isArray(scope.sourceKeys)
        ? Array.from(new Set(scope.sourceKeys.map((item) => String(item ?? "").trim()).filter(Boolean)))
        : [];
      if (mode === "selected" && sourceKeys.length === 0) {
        throw new Error(withSubmitNodeResultExample(`节点结果.rework.workItemScopes[${index}].sourceKeys 在 selected 模式不能为空`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      if (mode === "all" && sourceKeys.length > 0) {
        throw new Error(withSubmitNodeResultExample(`节点结果.rework.workItemScopes[${index}].sourceKeys 在 all 模式必须省略`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      if (sourceKeys.length > 2_000) {
        throw new Error(withSubmitNodeResultExample(`节点结果.rework.workItemScopes[${index}].sourceKeys 最多包含 2000 项`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      return {
        nodeId,
        mode,
        ...(mode === "selected" ? { sourceKeys } : {}),
      } as NodeWorkItemReworkScope;
    });
  }

  /** 判断模型是否把可确定修复的内部合同错误错误地提交成等待人工动作。 */
  private isAutoRecoverableNodeHumanInput(finalAnswer: NodeFinalAnswerPayload): boolean {
    if (finalAnswer.control.nextAction !== "ask_human" && finalAnswer.control.nextAction !== "stop") return false;
    const answerText = finalAnswer.answer.mode === "text" ? finalAnswer.answer.text : "";
    const diagnosticText = [
      finalAnswer.control.reason,
      finalAnswer.review.summary,
      finalAnswer.humanInput?.summary,
      finalAnswer.answer.summary,
      answerText,
    ].filter(Boolean).join("\n");
    return isOrchestrationDeterministicRecoveryDiagnostic(diagnosticText);
  }

  /** 把内部合同错误退回当前 Agent，避免错误进入用户人工等待态。 */
  private buildAutoRecoveryNodeSubmissionResult(): HostToolExecutionResult {
    return {
      ok: false,
      code: ORCH_AUTO_RECOVERY_REQUIRED_CODE,
      message: [
        "这不是需要用户补充的业务信息，而是当前节点的内部工具或提交校验问题。",
        `请在当前节点读取最新状态，修正确定无疑的参数后重试；工作项问题先调用 ${ORCH_WORK_ITEMS_LIST_TOOL_ID}，提交问题按工具返回的校验提示修正。`,
        "不要提交 ask_human，也不要把内部错误、字段名或错误码写给用户；只有确实缺少业务事实或无法安全判断时才请求用户介入。",
      ].join("\n"),
      output: {
        retryable: true,
        recoveryAction: "continue_current_node",
      },
    };
  }

  /** 校验 nextAction 与 rework/humanInput/验收结果之间的一致性。 */
  private validateFinalAnswerSemantics(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    finalAnswer: NodeFinalAnswerPayload,
    primaryKind: string | null = null,
  ): void {
    finalAnswer.acceptanceChecks = this.bindAcceptanceChecksToIntake(
      instance.intakeSnapshot.acceptanceCriteria ?? null,
      finalAnswer.acceptanceChecks ?? null,
    );

    if (finalAnswer.control.nextAction === "rework") {
      if (!finalAnswer.rework) {
        throw new Error(withSubmitNodeResultExample("当 control.nextAction=rework 时，必须填写节点结果.rework", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      if (!instance.workflowSnapshot.nodes.some((item) => item.id === finalAnswer.rework?.targetNodeId)) {
        throw new Error(withSubmitNodeResultExample(`rework.targetNodeId 不存在：${finalAnswer.rework.targetNodeId}`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      const allowedTargets = this.resolveAllowedReworkTargets(instance, node);
      if (!allowedTargets.has(finalAnswer.rework.targetNodeId)) {
        throw new Error(withSubmitNodeResultExample(`节点 ${node.label} 不允许退回到 ${finalAnswer.rework.targetNodeId}`, SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
      }
      const affectedNodeIds = this.resolveModelReworkNodeIds(instance, node, finalAnswer.rework);
      this.resolveNodeWorkItemReworkScopes(
        instance,
        affectedNodeIds,
        finalAnswer.rework.workItemScopes,
        `节点 ${node.label} 的模型返工`,
      );
    } else if (finalAnswer.rework) {
      throw new Error(withSubmitNodeResultExample("只有 control.nextAction=rework 时，才能返回节点结果.rework", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }

    if (finalAnswer.control.nextAction === "ask_human") {
      if (!finalAnswer.humanInput?.summary) {
        throw new Error(withSubmitNodeResultExample("当 control.nextAction=ask_human 时，必须填写节点结果.humanInput.summary", SUBMIT_NODE_RESULT_ASK_HUMAN_EXAMPLE));
      }
    } else if (finalAnswer.humanInput) {
      throw new Error(withSubmitNodeResultExample("只有 control.nextAction=ask_human 时，才能返回节点结果.humanInput", SUBMIT_NODE_RESULT_ASK_HUMAN_EXAMPLE));
    }

    if (finalAnswer.control.nextAction === "continue" && finalAnswer.review.verdict === "fail") {
      throw new Error(withSubmitNodeResultExample("review.verdict=fail 时，control.nextAction 不能是 continue", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }
    if (finalAnswer.control.nextAction === "rework" && finalAnswer.review.verdict === "pass") {
      throw new Error(withSubmitNodeResultExample("review.verdict=pass 时，control.nextAction 不能是 rework", SUBMIT_NODE_RESULT_TEXT_EXAMPLE));
    }

    const blockingFailures = (finalAnswer.acceptanceChecks ?? []).filter((check) => check.blocking && check.verdict === "fail");
    if (blockingFailures.length && finalAnswer.control.nextAction === "continue") {
      throw new Error(withSubmitNodeResultExample("存在阻断性验收未通过项，control.nextAction 不能是 continue", SUBMIT_NODE_RESULT_REWORK_EXAMPLE));
    }

    this.validateUiPrototypeDeliveryMode(instance, finalAnswer, primaryKind ?? this.resolveOutputArtifactSpec(node, role).kind);
  }

  /** 按角色输出定义校验节点结果契约，结果同时用于提交反馈和落库元数据。 */
  private validateNodeResultContract(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    finalAnswer: NodeFinalAnswerPayload,
  ): NodeResultContractValidationResult {
    const { kind } = this.resolveOutputArtifactSpec(node, role);
    return validateNodeResultContract({
      instanceId: instance.id,
      nodeId: node.id,
      resultName: kind,
      role,
      answer: finalAnswer.answer,
      nextAction: finalAnswer.control.nextAction,
      reviewVerdict: finalAnswer.review.verdict,
    });
  }

  /** 只对明确 ui-spec 结果启用集成原型路径强校验，禁止从角色文案猜测 UI 类型。 */
  private validateUiPrototypeDeliveryMode(
    instance: OrchestrationInstance,
    finalAnswer: NodeFinalAnswerPayload,
    primaryKind: string | null,
  ): void {
    if (primaryKind !== "ui-spec") return;
    if (finalAnswer.control.nextAction !== "continue") return;
    if (finalAnswer.answer.mode !== "file-set") return;
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    if (!workspacePath) return;

    const workflowDocsRoot = readWorkflowDocsRootFromWorkspace(workspacePath);
    const outputPaths = finalAnswer.answer.files
      .map((file) => normalizeWorkspaceRelPath(file.path))
      .filter(Boolean);
    if (outputPaths.some((filePath) => !isSameOrNestedWorkspaceRelPath(filePath, workflowDocsRoot))) {
      return;
    }

    const integratedBaselinePath = findExistingIntegratedPrototypeBaselinePath(workspacePath, workflowDocsRoot);
    if (!integratedBaselinePath) return;

    throw new Error([
      `当前工作区已存在项目集成原型基线：${integratedBaselinePath}。`,
      "本轮 UI 原型不能只交付 workflowDocsRoot 下的文档、截图或独立静态原型文件。",
      `请沿用现有前端项目框架，在工具 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID} 的 answer.files 中至少返回 1 个真实项目内的集成原型路径，例如 prototype/prototypes 页面、路由接线、mock 数据或同级 README；如果已经修改了项目文件，也必须把该路径一并返回。`,
    ].join("\n"));
  }

  private bindAcceptanceChecksToIntake(
    criteria: TaskAcceptanceCriterion[] | null,
    checks: NodeAcceptanceCheck[] | null,
  ): NodeAcceptanceCheck[] | null {
    if (!checks?.length) return null;
    const criteriaById = new Map((criteria ?? []).map((item) => [item.id, item] as const));
    return checks.map((check) => {
      if (!check.criterionId) return check;
      const criterion = criteriaById.get(check.criterionId);
      if (!criterion) {
        throw new Error(withSubmitNodeResultExample(`acceptanceChecks 引用了不存在的 criterionId：${check.criterionId}；不确定运行时 ID 时请省略 criterionId，仅填写 label/verdict/evidence`, SUBMIT_NODE_RESULT_ACCEPTANCE_EXAMPLE));
      }
      return {
        ...check,
        label: criterion.text,
        blocking: criterion.blocking,
      };
    });
  }

  /** 按现有 Attempt 收口产物和门禁，各同步持久化段独立准入。 */
  private async finalizeRoleExecution(
    instanceId: OrchestrationId,
    node: WorkflowNode,
    instance: OrchestrationInstance,
    role: RoleDefinition,
    execution: { rawOutput: string; finalAnswer: NodeFinalAnswerPayload },
    attemptId: string,
  ): Promise<void> {
    if (!(await this.withDatabase(() => this.canContinueNodeAttempt(instanceId, node, attemptId, "finalize-start")))) return;
    const finalizing = (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.markFinalizing(attemptId)));
    if (finalizing.alreadyFinalized) return;
    (await this.withDatabase(() => this.updateNodeStatus(instanceId, node, instance, "finalizing")));
    const contractValidation = this.validateNodeResultContract(instance, node, role, execution.finalAnswer);
    if (!contractValidation.accepted) {
      throw new Error(this.buildNodeResultContractRecoveryMessage(contractValidation, this.buildNodeResultSubmissionToolContext(node, role)));
    }
    (await this.withDatabase(() => this.updateNodeStatus(instanceId, node, instance, "artifact-writing")));
    const artifact = (await this.withDatabase(() => this.persistOutputArtifact(instance, node, role, execution.finalAnswer, contractValidation, attemptId)));
    const conclusion = this.buildExecutionConclusion(execution.finalAnswer);

    if (instance.nodeStates[node.id]) {
      instance.nodeStates[node.id].output = execution.rawOutput;
      instance.nodeStates[node.id].outputArtifactIds = Array.from(new Set([
        ...(instance.nodeStates[node.id].outputArtifactIds ?? []),
        artifact.id,
      ]));
      instance.nodeStates[node.id].conclusion = conclusion;
      (await this.withDatabase(() => this.persistNodeState(instanceId, instance, node.id)));
    }

    (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.artifactWritten", {
      instanceId,
      nodeId: node.id,
      nodeLabel: node.label,
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      payloadMode: artifact.payloadMode ?? null,
      persistenceMode: artifact.persistenceMode ?? null,
    })));

    const gateInputText = this.extractArtifactText(artifact);
    const gateResults: GateResult[] = [];

    if (role.gateCriteria.length > 0) {
      (await this.withDatabase(() => this.updateNodeStatus(instanceId, node, instance, "gate-checking")));

      const deterministicCriteria = role.gateCriteria.filter((criterion) => criterion.type !== "ai");
      const aiCriteria = role.gateCriteria.filter((criterion) => criterion.type === "ai");
      if (deterministicCriteria.length) {
        gateResults.push(...await evaluateGates(gateInputText, deterministicCriteria));
      }
      if (aiCriteria.length) {
        const latestSnapshotId = instance.nodeStates[node.id]?.promptSnapshotIds?.at(-1) ?? null;
        const latestSnapshot = latestSnapshotId ? (await this.withDatabase(() => this.ctx.db.orchPromptSnapshots.get(latestSnapshotId))) : null;
        if (!latestSnapshot) {
          gateResults.push(...aiCriteria.map((criterion) => ({
            criterionId: criterion.id,
            passed: false,
            message: "缺少本次节点执行的 Prompt Snapshot，无法启动 AI 门禁评估",
            outcome: "error" as const,
            evaluatorKind: "ai" as const,
            errorCode: "AI_GATE_PROMPT_SNAPSHOT_MISSING",
          })));
        } else {
          try {
            const aiEvaluation = await this.aiGateEvaluationService.evaluate({
              requestId: `gate-request-${crypto.randomUUID()}`,
              evaluationRunId: `gate-run-${crypto.randomUUID()}`,
              instanceId,
              nodeId: node.id,
              nodeLabel: node.label,
              nodeAttemptId: attemptId,
              artifactId: artifact.id,
              workspaceId: instance.workspaceId,
              criteria: aiCriteria,
              artifactSources: [{
                sourceId: "artifact-body",
                path: null,
                text: gateInputText,
                sha256: crypto.createHash("sha256").update(gateInputText.replace(/\r\n?/g, "\n"), "utf8").digest("hex"),
              }],
              engine: latestSnapshot.engine,
              model: latestSnapshot.model ?? null,
              effort: latestSnapshot.effort ?? null,
              accessMode: "read-only",
              contextWindow: latestSnapshot.runtimePolicy.contextWindow ?? null,
              autoCompactPct: latestSnapshot.runtimePolicy.autoCompactPct ?? null,
              prompt: {
                promptEnvelope: latestSnapshot.promptEnvelope,
                runtimePolicy: {
                  ...latestSnapshot.runtimePolicy,
                  accessMode: "read-only",
                  toolRuntimePolicy: { allowedToolIds: ["orchestration.submit_gate_evaluation"], requiresWorkspaceWrite: false },
                },
                artifactInput: { artifacts: [], fieldBindings: {} },
                knowledgeCatalogs: [],
                knowledgeWarnings: [],
                systemMessage: "你是独立的 AI 文本门禁评估器。",
                developerMessage: "只读评估，不得调用除门禁提交工具之外的任何工具。",
              },
            });
            gateResults.push(...aiEvaluation.results);
          } catch (error) {
            const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code ?? "AI_GATE_EVALUATION_FAILED") : "AI_GATE_EVALUATION_FAILED";
            if (code === "AI_GATE_CANCELLED" || code === "AI_GATE_ALREADY_RUNNING") return;
            const evaluationError = error as {
              evaluationRunId?: string;
              evaluationCallId?: string;
              threadId?: ThreadId | null;
              turnId?: TurnId | null;
              promptSnapshotId?: string | null;
            };
            gateResults.push(...aiCriteria.map((criterion) => ({
              criterionId: criterion.id,
              passed: false,
              message: error instanceof Error ? error.message : String(error),
              outcome: "error" as const,
              evaluatorKind: "ai" as const,
              errorCode: code,
              evaluationRunId: evaluationError.evaluationRunId ?? null,
              evaluationCallId: evaluationError.evaluationCallId ?? null,
              evaluationThreadId: evaluationError.threadId ?? null,
              evaluationTurnId: evaluationError.turnId ?? null,
              promptSnapshotId: evaluationError.promptSnapshotId ?? null,
            })));
          }
        }
      }
      if (!(await this.withDatabase(() => this.canContinueNodeAttempt(instanceId, node, attemptId, "gate-completed")))) return;
    }

    if (gateResults.length > 0) {
      if (instance.nodeStates[node.id]) {
        instance.nodeStates[node.id].gateResults = gateResults;
        (await this.withDatabase(() => this.persistNodeState(instanceId, instance, node.id)));
      }

      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.gateResult", {
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        artifactId: artifact.id,
        results: gateResults,
      })));

      if (hasBlockingFailure(gateResults, role.gateCriteria)) {
        const gateFailure = this.describeGateFailure(gateResults);
        (await this.withDatabase(() => this.applyRoleFailurePolicy(instanceId, node, instance, gateFailure, {
          source: "gate",
          gateResults,
          artifactId: artifact.id,
        })));
        (await this.withDatabase(() => this.settleAttemptFromNodeState(attemptId, instanceId, node.id, gateFailure)));
        return;
      }
    }

    if (conclusion.nextAction === "ask_human") {
      (await this.withDatabase(() => this.waitForHumanFeedback(instanceId, node, instance, artifact.id, conclusion, "human_input")));
      (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.markTerminal(attemptId, "waiting-feedback")));
      return;
    }

    if (conclusion.nextAction === "stop") {
      (await this.withDatabase(() => this.waitForHumanFeedback(instanceId, node, instance, artifact.id, conclusion, "review")));
      (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.markTerminal(attemptId, "waiting-feedback")));
      return;
    }

    if (this.resolveNodeApprovalMode(instance, node) === "manual") {
      (await this.withDatabase(() => this.updateNodeStatus(instanceId, node, instance, "waiting-approval", {
        humanActionSource: "approval",
      })));
      (await this.withDatabase(() => this.emitOrchEvent(instance, "orchestration.approvalRequested", {
        instanceId,
        nodeId: node.id,
        nodeLabel: node.label,
        artifactId: artifact.id,
        reviewVerdict: conclusion.reviewVerdict,
        nextAction: conclusion.nextAction,
        reworkTargetNodeId: conclusion.rework?.targetNodeId ?? null,
      })));
      (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.markTerminal(attemptId, "waiting-approval")));
      return;
    }

    if (conclusion.nextAction === "rework") {
      const reworkNodeState = instance.nodeStates[node.id] ?? null;
      if (this.hasReachedReworkLimit(node, reworkNodeState)) {
        // 自动回退已达轮次上限：停止自动回退并停在人工决策点，避免无人值守下反复回退。
        (await this.withDatabase(() => this.waitForHumanFeedback(instanceId, node, instance, artifact.id, conclusion, "review")));
        (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.markTerminal(attemptId, "waiting-feedback")));
        return;
      }
      (await this.withDatabase(() => this.approveNodeArtifacts(instance, node.id, reworkNodeState)));
      (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.markTerminal(attemptId, "rework")));
      await this.applyModelRequestedRework(instanceId, node, instance, reworkNodeState, null);
      return;
    }

    (await this.withDatabase(() => this.approveNodeArtifacts(instance, node.id, instance.nodeStates[node.id] ?? null)));
    (await this.withDatabase(() => this.updateNodeStatus(instanceId, node, instance, "completed")));
    (await this.withDatabase(() => this.ctx.db.orchNodeAttempts.markTerminal(attemptId, "completed")));
  }

  private buildExecutionConclusion(finalAnswer: NodeFinalAnswerPayload): NodeExecutionConclusion {
    return {
      nextAction: finalAnswer.control.nextAction,
      reviewVerdict: finalAnswer.review.verdict,
      summary: finalAnswer.review.summary,
      blockingIssues: finalAnswer.review.blockingIssues ?? null,
      acceptanceChecks: finalAnswer.acceptanceChecks ?? null,
      humanInput: finalAnswer.humanInput ?? null,
      rework: finalAnswer.rework ?? null,
      decidedBy: "model",
      decidedAt: Date.now(),
    };
  }

  /** 生成未调用提交工具时的恢复提示，并带上当前输出契约示例。 */
  private buildNodeResultSubmissionRecoveryMessage(
    outputMode: ArtifactOutputMode,
    responseText: string,
    validationError?: string | null,
    outputDefinition?: RoleDefinition["outputDefinition"] | null,
  ): string {
    const excerpt = String(responseText ?? "").trim().slice(0, 800);
    const submissionContext = normalizeNodeResultSubmissionToolContext({ outputMode, outputDefinition });
    return [
      "上一轮您已经执行了一些操作，但还没有通过平台真实工具提交节点结果。",
      validationError ? `本轮问题：${validationError}` : "",
      "不要重复过程说明、不要继续汇报计划、不要输出 assistant 文本 JSON 协议。",
      outputMode === "file" || outputMode === "file-set"
        ? "如果 control.nextAction=continue，file/file-set 节点必须先把正式交付文件写到工作区目标路径，再通过 runtime.submitNodeResult 只提交 path 与 summary；如果需要 ask_human/rework/stop，可用 answer.mode=\"text\" 提交决策说明，不要为未确认占位符伪造正式文件路径；但本轮已生成且需要用户查看、确认或下游引用的真实文件必须放 answer.attachments，不要只在正文里写路径。"
        : "如果需要 ask_human/rework/stop，可用 answer.mode=\"text\" 简要提交决策说明，不要补完整 delivery_template、required_outputs 或伪造正式交付结论；但本轮已生成且需要用户查看、确认或下游引用的真实文件必须放 answer.attachments，不要只在正文里写路径。",
      ...buildNodeResultContractSummaryLines(submissionContext),
      `现在请直接调用工具 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID} 提交当前节点结果；工具入参应满足下面的 canonical 结构：`,
      "```json",
      JSON.stringify(this.buildNodeResultSubmissionExample(outputMode, outputDefinition), null, 2),
      "```",
      excerpt ? `上一轮返回摘录（仅供您对照，不要重复）：\n${excerpt}` : "",
    ].filter(Boolean).join("\n\n");
  }

  private buildArtifactOutputRecoveryMessage(issues: ArtifactOutputPathValidationIssue[]): string {
    const lines = issues.map((issue, index) => {
      const expected = issue.expectedPath ? `；平台期望路径：${issue.expectedPath}` : "";
      return `${index + 1}. ${issue.message}${expected}`;
    });
    return [
      `本轮提交给 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID} 的文件输出路径没有通过平台校验。`,
      "平台不会猜测或兜底修正这些路径；如果路径不对，会直接要求您重输出。",
      "请先把正式文件写到工作区正确位置，再返回最终 path/summary。",
      ...lines,
    ].join("\n");
  }

  /** 生成角色输出配置校验失败后的模型恢复提示。 */
  private buildNodeResultContractRecoveryMessage(
    validation: NodeResultContractValidationResult,
    submissionContext?: NodeResultSubmissionToolContext | null,
  ): string {
    const lines = validation.blockingIssues.map((item, index) => {
      const path = item.path && !item.message.includes(item.path) ? `（位置：${item.path}）` : "";
      return `${index + 1}. ${item.message}${path}`;
    });
    const normalizedContext = submissionContext ? normalizeNodeResultSubmissionToolContext(submissionContext) : null;
    return [
      `本轮提交给 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID} 的节点结果，与当前角色定义里的“输出”配置不一致。`,
      "请按下面提示修改 answer.fields / answer.file / answer.files / answer.attachments 后重新调用提交工具。",
      "注意：file.key 是角色输出配置里的交付物编号，不是文件名；动态材料不要放在 answer.files，应放入 answer.attachments。",
      ...(normalizedContext ? buildNodeResultContractSummaryLines(normalizedContext) : []),
      ...(normalizedContext
        ? [
            "可从下面的最小结构修正；不要重复同一个 answer.files[].key，动态材料放 answer.attachments：",
            "```json",
            JSON.stringify(buildNodeResultSubmissionExamplePayload(normalizedContext), null, 2),
            "```",
          ]
        : []),
      ...lines,
    ].join("\n");
  }

  /** 生成当前 outputMode 对应的提交工具示例。 */
  private buildNodeResultSubmissionExample(
    outputMode: ArtifactOutputMode,
    outputDefinition?: RoleDefinition["outputDefinition"] | null,
  ): NodeFinalAnswerPayload {
    return buildNodeResultSubmissionExamplePayload(normalizeNodeResultSubmissionToolContext({ outputMode, outputDefinition }));
  }

  private resolveArtifactPersistenceMode(node: WorkflowNode, outputMode: ArtifactOutputMode): "db-only" | "workspace-only" | "dual-write" {
    return node.outputWritePolicy?.persistenceMode
      ?? (outputMode === "file" || outputMode === "file-set" ? "dual-write" : "db-only");
  }

  private persistOutputArtifact(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    finalAnswer: NodeFinalAnswerPayload,
    contractValidation: NodeResultContractValidationResult,
    attemptId: string,
  ): Artifact {
    const persistTx = this.ctx.db.db.transaction(() => {
      const existingForAttempt = this.ctx.db.orchArtifacts.getByNodeAttempt(instance.id, attemptId);
      if (existingForAttempt) {
        this.ctx.db.orchNodeAttempts.attachArtifact(attemptId, existingForAttempt.id);
        this.ensureArtifactIndexed(instance, node.id, existingForAttempt.id);
        return existingForAttempt;
      }

      const existing = this.ctx.db.orchArtifacts.listByNode(instance.id, node.id);
      const { kind } = this.resolveOutputArtifactSpec(node, role);
      const nextVersion = existing.filter((item) => item.kind === kind).length + 1;
      const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
      const persistence = new ArtifactPersistenceService({ db: this.ctx.db, workspacePath, workspaceId: instance.workspaceId, workspacePathIndex: this.ctx.workspacePathIndex });
      const defaultBaseDir = this.resolveDefaultArtifactBaseDir(instance, node, role);
      const artifact = persistence.persist({
        instanceId: instance.id,
        nodeId: node.id,
        nodeLabel: node.label,
        kind,
        schemaRef: null,
        version: nextVersion,
        threadId: String(instance.nodeStates[node.id]?.threadId ?? ""),
        roleId: String(node.roleId ?? ""),
        node,
        envelope: contractValidation.normalizedAnswer,
        defaultBaseDir,
        contractValidation,
        enableRootedPathGuard: isArtifactPathRuleResolved(role),
        metadata: {
          nodeAttemptId: attemptId,
          nodeResult: {
            completion: contractValidation.completion,
            nextAction: finalAnswer.control.nextAction,
            validationStatus: this.resolveNodeResultValidationStatus(contractValidation),
            validationReport: toNodeResultValidationReport(contractValidation),
            consumable: contractValidation.consumable,
            contractVersion: contractValidation.contractVersion,
          },
        },
      });
      this.persistNodeResultFields(artifact, instance, node, kind, contractValidation);
      this.ensureArtifactIndexed(instance, node.id, artifact.id);
      this.ctx.db.orchNodeAttempts.attachArtifact(attemptId, artifact.id);
      return artifact;
    });
    const artifact = persistTx();

    if (artifact.workspaceStatus && artifact.workspaceStatus !== "none") {
      this.emitOrchEvent(instance, "orchestration.artifactWorkspaceWritten", {
        instanceId: instance.id,
        nodeId: node.id,
        nodeLabel: node.label,
        artifactId: artifact.id,
        workspaceStatus: artifact.workspaceStatus,
        stagingPath: artifact.stagingPath ?? null,
        publishedPath: artifact.publishedPath ?? null,
        fileCount: this.ctx.db.orchArtifactFiles.listByArtifact(artifact.id).length,
      });
    }
    return artifact;
  }

  /** 幂等补齐节点 Artifact 索引，避免收尾重放产生重复引用。 */
  private ensureArtifactIndexed(instance: OrchestrationInstance, nodeId: string, artifactId: ArtifactId): void {
    const latest = this.ctx.db.orchInstances.get(instance.id) ?? instance;
    const artifactIndex = { ...(latest.artifactIndex ?? {}) };
    artifactIndex[nodeId] = Array.from(new Set([...(artifactIndex[nodeId] ?? []), artifactId]));
    latest.artifactIndex = artifactIndex;
    instance.artifactIndex = artifactIndex;
    this.ctx.db.orchInstances.updateArtifactIndex(instance.id, artifactIndex);
  }

  /** 将可消费节点结果字段写入字段索引，供详情页、审核和下游引用使用。 */
  private persistNodeResultFields(
    artifact: Artifact,
    instance: OrchestrationInstance,
    node: WorkflowNode,
    resultName: string,
    contractValidation: NodeResultContractValidationResult,
  ): void {
    if (!contractValidation.consumable || contractValidation.normalizedFields.length === 0) return;
    const entries: Array<Omit<NodeResultField, "id" | "createdAt" | "updatedAt" | "artifactId">> =
      contractValidation.normalizedFields.map((field) => ({
        instanceId: instance.id,
        nodeId: node.id,
        resultName,
        fieldKey: field.fieldKey,
        label: field.label ?? null,
        valueType: field.valueType,
        valueJson: field.valueJson,
        valuePreview: field.valuePreview ?? null,
        required: field.required,
        source: field.source,
        validationStatus: field.validationStatus,
      }));
    this.ctx.db.orchArtifactFields.replaceForArtifact(artifact.id, entries);
  }

  /** 汇总节点结果契约校验状态，用于 artifact metadata 和工具返回。 */
  private resolveNodeResultValidationStatus(
    validation: NodeResultContractValidationResult,
  ): NodeResultValidationStatus {
    if (validation.completion === "decision") return "not_validated";
    if (validation.blockingIssues.length > 0) return "invalid";
    if (validation.recoverableIssues.length > 0 || validation.warnings.length > 0 || validation.completion === "partial") {
      return "warning";
    }
    return "valid";
  }

  private validateArtifactOutputForExecution(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
    answer: NodeExecutionEnvelope,
  ): ArtifactOutputPathValidationIssue[] {
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    const defaultBaseDir = this.resolveDefaultArtifactBaseDir(instance, node, role);
    return validateArtifactWorkspaceOutput({
      workspacePath,
      node,
      envelope: answer,
      defaultBaseDir,
      enableRootedPathGuard: isArtifactPathRuleResolved(role),
    }).issues;
  }

  private resolveDefaultArtifactBaseDir(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    role: RoleDefinition,
  ): string | null {
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    return workspacePath
      ? buildDefaultArtifactBaseDir({
          workspacePath,
          intake: instance.intakeSnapshot,
          workflow: instance.workflowSnapshot,
          node,
          role,
        })
      : null;
  }

  /**
   * 产物路径运行时 token：编号按该节点已产出产物数递增（多轮返工不重名），
   * 主题与目录段取平台渲染值。工作区未登记时用默认产物根继续解析，避免整链退化。
   */
  private buildArtifactPathTokens(
    instance: OrchestrationInstance,
    node: WorkflowNode,
    taskTitle: string,
    taskTitlePathSegment: string,
  ): Record<string, string> {
    const workspacePath = this.ctx.workspaces.get(instance.workspaceId) ?? "";
    const producedCount = this.ctx.db.orchArtifacts
      .listSummariesByInstance(instance.id)
      .filter((artifact) => String(artifact.nodeId ?? "") === node.id).length;
    return buildArtifactPathRuntimeTokens({
      workspacePath,
      topicTitle: taskTitle,
      topicDirName: taskTitlePathSegment,
      ordinal: producedCount + 1,
    });
  }

  private resolveOutputArtifactSpec(
    node: WorkflowNode,
    role: RoleDefinition,
  ): { kind: string } {
    const outputMode = node.outputArtifactMode ?? inferRoleArtifactOutputMode(role.outputDefinition);
    const configuredKey = String(node.outputResultKey ?? "").trim();
    const roleDefaultKey = String(role.outputDefinition.resultKey ?? "").trim();

    if (configuredKey) {
      return { kind: configuredKey };
    }

    if (roleDefaultKey) {
      return { kind: roleDefaultKey };
    }

    return {
      kind:
        outputMode === "file"
          ? `file-output/${node.id}`
          : outputMode === "file-set"
            ? `file-set-output/${node.id}`
            : outputMode === "structured"
              ? `structured-output/${node.id}`
              : `node-output/${node.id}`,
    };
  }

  private findNodeLabel(instance: OrchestrationInstance, nodeId: string): string {
    return instance.workflowSnapshot.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  }

  private extractArtifactText = (artifact: Artifact): string => {
    // 只有 contentJson 取不到正文时才回读工作区文件：原先无条件先读盘全文再丢弃，
    // 越靠后的节点（git 会自动绑定全部上游产物）重复读越多。
    // envelope 读取仍留在 try 内：损坏行（如 mode=file-set 但 files 缺失）必须回落到工作区文本，
    // 不能把 TypeError 抛给下游节点；工作区回读放在 try 外，避免它的 IO 错误再被吞掉重读一次。
    try {
      const parsed = JSON.parse(String(artifact.contentJson ?? "{}")) as NodeExecutionEnvelope | { text?: string };
      const mode = (parsed as NodeExecutionEnvelope).mode;
      if (mode === "text" || mode === "structured" || mode === "file" || mode === "file-set") {
        const envelopeText = this.extractExecutionEnvelopeText(parsed as NodeExecutionEnvelope);
        if (envelopeText) return envelopeText;
      } else {
        const text = String((parsed as { text?: string }).text ?? "").trim();
        if (text) return text;
      }
    } catch {
      // 解析失败或 envelope 读取失败：回落到工作区文本，与惰性化之前的行为一致。
    }
    return this.readArtifactWorkspaceText(artifact);
  };

  private extractExecutionEnvelopeText = (envelope: NodeExecutionEnvelope): string => {
    switch (envelope.mode) {
      case "text":
        return String(envelope.text ?? "").trim();
      case "structured":
        return JSON.stringify(envelope.data ?? {}, null, 2);
      case "file":
        return String(envelope.file?.content ?? "").trim();
      case "file-set":
        return envelope.files
          .map((file) => {
            const filePath = String(file.path ?? "").trim();
            const content = String(file.content ?? "").trim();
            return [`# ${filePath || "result"}`, content].filter(Boolean).join("\n\n");
          })
          .filter(Boolean)
          .join("\n\n");
      default:
        return "";
    }
  };

  /** 从工作区产物文件读取文本内容，兼容 UTF-8 与 GBK；文件缺失时保留 DB 内容兜底。 */
  private readArtifactWorkspaceText = (artifact: Artifact): string => {
    const orchInstancesRepo = this.ctx?.db?.orchInstances as {
      get?: (id: Artifact["instanceId"]) => OrchestrationInstance | null;
    } | undefined;
    if (typeof orchInstancesRepo?.get !== "function") return "";
    const instance = orchInstancesRepo.get(artifact.instanceId);
    if (!instance) return "";
    const workspacePath = this.ctx?.workspaces?.get(instance.workspaceId) ?? "";
    if (!workspacePath) return "";
    const orchArtifactFilesRepo = this.ctx?.db?.orchArtifactFiles as {
      listByArtifact?: (id: Artifact["id"]) => Array<any>;
    } | undefined;
    if (typeof orchArtifactFilesRepo?.listByArtifact !== "function") return "";
    return orchArtifactFilesRepo.listByArtifact(artifact.id)
      .map((entry) => {
        const displayPath = String(entry.relPath ?? "").trim()
          || String(entry.publishedPath ?? entry.stagingPath ?? "").trim()
          || "result";
        const candidatePath = String(entry.publishedPath ?? entry.stagingPath ?? entry.relPath ?? "").trim();
        if (!candidatePath) return "";
        if (isBinaryFile(candidatePath)) return "";
        const absPath = path.resolve(workspacePath, candidatePath);
        if (!fs.existsSync(absPath)) return "";
        const content = decodeTextBuffer(fs.readFileSync(absPath)).content.trim();
        return [`# ${displayPath}`, content].filter(Boolean).join("\n\n");
      })
      .filter(Boolean)
      .join("\n\n");
  };

}

/** 生成动态工具注册后的补充开发者提示。 */
function buildNativeDynamicToolDeveloperMessage(toolRegistry: ExecutableToolRegistry | null): string | null {
  if (!toolRegistry?.tools.length) return null;
  const hasWorkItems = toolRegistry.tools.some((tool) => ORCH_WORK_ITEM_TOOL_IDS.has(String(tool.toolId)));
  const toolList = toolRegistry.tools
    .map((tool) => `${tool.toolId}（${tool.alias || tool.name}）`)
    .join("，");
  return [
    "补充说明：当前这些平台补充能力已经作为真实工具注册好了。",
    `已注册工具：${toolList}`,
    "需要时直接调用工具名，不要输出任何 assistant 文本 JSON 协议。",
    ...(hasWorkItems ? [
      "当前节点启用了平台工作项。工作项全部完成前，必须在同一节点内按顺序调用 workItems 工具推进，不得为每项新建会话，也不得提前提交 continue 或 rework；只有缺少业务信息或确实需要人工决策时，才提交 ask_human/stop。工作项工具或提交校验返回错误时，先读取最新状态、修正确定参数并重试，不要把内部错误转给用户。严格工作项必须满足冻结验收条件并由 Host 校验真实输出；Reviewer 项完成只表示检查完成，不表示资产审核通过。上下文换段由平台自动处理，不得重建看板。",
    ] : []),
    `当前节点的最终结果提交必须通过工具 ${ORCH_SUBMIT_NODE_RESULT_TOOL_ID} 完成。`,
    "工具返回后，可以继续同一轮思考并补充自然语言总结，但那只是说明，不是提交事实。",
  ].join("\n");
}

/** 复制工作项策略，避免运行覆盖与当前工作流定义共享可变引用。 */
function cloneNodeWorkItemPolicy(policy: NodeWorkItemPolicy): NodeWorkItemPolicy {
  return {
    mode: "sequential",
    ...(policy.completion ? { completion: { ...policy.completion } } : {}),
    ...(policy.reworkAlwaysClientKeys?.length ? { reworkAlwaysClientKeys: [...policy.reworkAlwaysClientKeys] } : {}),
    ...(policy.maxItemsPerThread != null ? { maxItemsPerThread: policy.maxItemsPerThread } : {}),
  };
}

/** 定义同会话串行工作项工具组；新建项冻结合同，完成时核验已配置条件。 */
function buildNodeWorkItemTools(policy: WorkflowNode["workItemPolicy"]): ExecutableToolRegistry["tools"] {
  const completion = policy?.completion ?? null;
  const createRequiredFields = [
    "clientKey",
    "title",
    ...(completion ? ["sourceKey"] : []),
    ...(completion?.verifyOutputPath ? ["outputPath"] : []),
    ...(completion?.requireAcceptanceChecks ? ["acceptanceCriteria"] : []),
  ];
  const completeRequiredFields = [
    "itemId",
    "expectedVersion",
    "resultSummary",
    ...(completion?.requireEvidence ? ["evidence"] : []),
    ...(completion?.verifyOutputPath ? ["outputPath"] : []),
  ];
  const common = {
    toolsetId: ORCH_RUNTIME_TOOLSET_ID as any,
    toolsetName: "内建节点工作项",
    runtime: "builtin" as const,
    alias: null,
    code: "",
    outputSchema: JSON.stringify({ type: "object" }),
    timeoutMs: null,
    workingDirectory: null,
    permissions: { requiresWrite: false },
    envPolicy: null,
    required: false,
  };
  return [
    {
      ...common,
      toolId: ORCH_WORK_ITEMS_LIST_TOOL_ID as any,
      name: "查看节点工作项",
      description: "分页读取当前节点的持久化工作项、进度和首个未完成项。恢复执行、找不到工作项或遇到版本冲突时先调用。",
      usageGuidance: "只读取当前流程实例的当前节点；不能读取或修改其他节点。",
      invocationHint: JSON.stringify({ statuses: ["pending", "in_progress"], limit: 100 }),
      inputSchema: JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties: {
          statuses: { type: "array", items: { type: "string", enum: ["pending", "in_progress", "completed"] } },
          includeDeleted: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          cursor: { type: ["string", "null"] },
        },
      }),
    },
    {
      ...common,
      toolId: ORCH_WORK_ITEMS_CREATE_TOOL_ID as any,
      name: "创建节点工作项",
      description: "根据当前节点已批准输入批量创建持久化工作项。clientKey 在当前节点内幂等；同一清单可安全重放。",
      usageGuidance: "先创建完整清单，再从返回的 nextItem 开始处理。acceptanceCriteria 可为空数组，表示没有额外验收项；不要用工作项替代实际产出。",
      invocationHint: JSON.stringify({
        items: [{
          clientKey: "asset:example",
          title: "生成 example 详情",
          sourceKey: "example",
          outputPath: "docs/example.md",
          ...(completion?.requireAcceptanceChecks
            ? { acceptanceCriteria: [{ id: "evidence-read", label: "已读取并归纳直接证据" }] }
            : {}),
        }],
      }),
      inputSchema: JSON.stringify({
        type: "object",
        required: ["items"],
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 2000,
            items: {
              type: "object",
              required: createRequiredFields,
              additionalProperties: false,
              properties: {
                clientKey: { type: "string" },
                title: { type: "string" },
                description: { type: ["string", "null"] },
                sourceKey: { type: ["string", "null"] },
                outputPath: { type: ["string", "null"] },
                sortOrder: { type: ["integer", "null"], minimum: 0 },
                acceptanceCriteria: {
                  type: "array",
                  minItems: 0,
                  maxItems: 100,
                  items: {
                    type: "object",
                    required: ["id", "label"],
                    additionalProperties: false,
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    },
    {
      ...common,
      toolId: ORCH_WORK_ITEMS_UPDATE_TOOL_ID as any,
      name: "更新节点工作项",
      description: "使用 expectedVersion 修改未启动项，切换首个未完成项，或把当前 in_progress 收口项退回 pending。成批返工使用 reopenMany。",
      usageGuidance: "任意时刻只能有一个 in_progress；不能跳过首个未完成项。已启动项的 sourceKey、outputPath、acceptanceCriteria 和 sortOrder 被锁定。",
      invocationHint: JSON.stringify({ itemId: "workitem_id", expectedVersion: 1, patch: { status: "in_progress" }, reason: "开始处理" }),
      inputSchema: JSON.stringify({
        type: "object",
        required: ["itemId", "expectedVersion", "patch"],
        additionalProperties: false,
        properties: {
          itemId: { type: "string" },
          expectedVersion: { type: "integer", minimum: 1 },
          reason: { type: ["string", "null"] },
          patch: {
            type: "object",
            minProperties: 1,
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              description: { type: ["string", "null"] },
              sourceKey: { type: ["string", "null"] },
              outputPath: { type: ["string", "null"] },
              sortOrder: { type: "integer", minimum: 0 },
              acceptanceCriteria: {
                type: "array",
                minItems: 0,
                maxItems: 100,
                items: {
                  type: "object",
                  required: ["id", "label"],
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                  },
                },
              },
              status: { type: "string", enum: ["pending", "in_progress"] },
            },
          },
        },
      }),
    },
    {
      ...common,
      toolId: ORCH_WORK_ITEMS_DELETE_TOOL_ID as any,
      name: "删除未开始工作项",
      description: "使用 expectedVersion 软删除从未启动的 pending 工作项，删除事件会永久保留。",
      usageGuidance: "已启动或已完成项不能删除；成批返工使用 reopenMany，不得逐项循环恢复。",
      invocationHint: JSON.stringify({ itemId: "workitem_id", expectedVersion: 1, reason: "清单复核后确认不适用" }),
      inputSchema: JSON.stringify({
        type: "object",
        required: ["itemId", "expectedVersion", "reason"],
        additionalProperties: false,
        properties: {
          itemId: { type: "string" },
          expectedVersion: { type: "integer", minimum: 1 },
          reason: { type: "string" },
        },
      }),
    },
    {
      ...common,
      toolId: ORCH_WORK_ITEMS_REOPEN_MANY_TOOL_ID as any,
      name: "批量重开节点工作项",
      description: "仅在当前节点内，按 all 或稳定 sourceKeys 原子批量重开工作项；固定收口/门禁项由节点策略自动包含。",
      usageGuidance: "不得根据标题、正文、正则或自然语言猜范围。当前 in_progress 收口项应先用 update 退回 pending，再执行批量重开。",
      invocationHint: JSON.stringify({ mode: "selected", sourceKeys: ["asset-id-1", "asset-id-2"], reason: "收口检查定位到同类问题" }),
      inputSchema: JSON.stringify({
        type: "object",
        required: ["mode", "reason"],
        additionalProperties: false,
        properties: {
          mode: { type: "string", enum: ["all", "selected"] },
          sourceKeys: { type: ["array", "null"], minItems: 1, maxItems: 2_000, items: { type: "string" } },
          reason: { type: "string" },
        },
      }),
    },
    {
      ...common,
      toolId: ORCH_WORK_ITEMS_COMPLETE_TOOL_ID as any,
      name: "完成当前工作项",
      description: "完成当前唯一 in_progress 工作项，保存结果摘要和证据引用，并返回严格顺序中的下一项。",
      usageGuidance: completion
        ? "实际产出完成后调用。当前工作项有验收条件时，completionChecks 必须逐项覆盖；没有验收条件时可省略或传空数组。Host 会校验 evidence、UTF-8 outputPath 并保存 SHA256。"
        : "实际工作和必要验证完成后调用。resultSummary 必须说明该项真实产出，evidence 使用可复核路径或标识。",
      invocationHint: JSON.stringify({
        itemId: "workitem_id",
        expectedVersion: 2,
        resultSummary: "已生成并核对详情",
        evidence: ["src/example.ts", "docs/example.md"],
        outputPath: "docs/example.md",
      }),
      inputSchema: JSON.stringify({
        type: "object",
        required: completeRequiredFields,
        additionalProperties: false,
        properties: {
          itemId: { type: "string" },
          expectedVersion: { type: "integer", minimum: 1 },
          resultSummary: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          outputPath: { type: ["string", "null"] },
          completionChecks: {
            type: "array",
            minItems: 0,
            maxItems: 100,
            items: {
              type: "object",
              required: ["criterionId", "evidence"],
              additionalProperties: false,
              properties: {
                criterionId: { type: "string" },
                evidence: { type: "string" },
              },
            },
          },
        },
      }),
    },
  ];
}

/** 定义节点结果提交工具的模型可见契约。 */
function buildNodeResultSubmissionTool(context?: NodeResultSubmissionToolContext | null): ExecutableToolRegistry["tools"][number] {
  const submissionContext = normalizeNodeResultSubmissionToolContext(context);
  const contractSummary = buildNodeResultContractSummaryLines(submissionContext).join("\n");
  return {
    toolsetId: ORCH_RUNTIME_TOOLSET_ID as any,
    toolsetName: "内建编排提交",
    toolId: ORCH_SUBMIT_NODE_RESULT_TOOL_ID as any,
    name: ORCH_SUBMIT_NODE_RESULT_TOOL_NAME,
    alias: null,
    description: [
      "把当前节点的最终结构化结果正式提交给平台。平台会立即做语义校验、工件路径校验和流程控制校验；通过后，这份结果就会成为本轮业务真相。",
      contractSummary,
    ].filter(Boolean).join("\n"),
    runtime: "builtin",
    usageGuidance: buildNodeResultSubmissionUsageGuidance(submissionContext),
    invocationHint: JSON.stringify(buildNodeResultSubmissionExamplePayload(submissionContext), null, 2),
    code: "",
    inputSchema: JSON.stringify(buildNodeResultSubmissionInputSchema(submissionContext)),
    outputSchema: JSON.stringify({
      type: "object",
      required: ["accepted"],
      properties: {
        accepted: { type: "boolean" },
        submissionId: { type: "string" },
        idempotent: { type: "boolean" },
        nextAction: { type: "string" },
        reviewVerdict: { type: "string" },
        validationStatus: { type: "string" },
      },
    }),
    permissions: { requiresWrite: false },
    envPolicy: null,
    required: true,
  };
}

/** 归一化提交工具上下文，确保工具提示和校验使用同一套角色输出定义。 */
function normalizeNodeResultSubmissionToolContext(
  context?: NodeResultSubmissionToolContext | null,
): NormalizedNodeResultSubmissionToolContext {
  const outputDefinition = normalizeRoleOutputDefinition(context?.outputDefinition);
  return {
    outputMode: context?.outputMode ?? inferRoleArtifactOutputMode(outputDefinition),
    outputDefinition,
  };
}

/** 生成模型可见的提交工具使用说明。 */
function buildNodeResultSubmissionUsageGuidance(context: NormalizedNodeResultSubmissionToolContext): string {
  return [
    "当交付完成，或需要 ask_human/rework/stop 决策时调用；非 continue 决策可用 answer.mode=\"text\" 提交原因，不要求正式交付文件，但本轮已生成且需要用户查看、确认或下游引用的真实文件必须放 answer.attachments，不要只在正文里写路径。调用成功就代表本轮节点结果已经提交。",
    ...buildNodeResultContractSummaryLines(context),
  ].join("\n");
}

/** 生成当前节点输出契约摘要，用于工具说明和失败恢复提示。 */
function buildNodeResultContractSummaryLines(context: NormalizedNodeResultSubmissionToolContext): string[] {
  const lines = [`当前节点 outputMode=${context.outputMode}。`];
  const fieldHint = formatSubmissionFieldContractHint(context.outputDefinition.requiredFields);
  if (fieldHint) lines.push(fieldHint);
  if (context.outputMode === "file" || context.outputMode === "file-set") {
    const target = context.outputMode === "file" ? "answer.file" : "answer.files";
    lines.push(`只有 control.nextAction="continue" 时，${target} 才必须提交正式交付物；ask_human/rework/stop 可使用 answer.mode="text" 提交原因，不要求提交 ${target}，不要为缺失占位符生成“待补充”或 xxx 伪路径。`);
    lines.push(`${target} 只放角色 delivery_files 声明的正式交付物；key 必须严格等于当前允许 key，不能用文件名、业务简称或源码路径临时自造。`);
    if (context.outputMode === "file-set") {
      lines.push("file-set 中每个 answer.files[].key 必须唯一；同一正式交付物的多份内容应合并到该 key 对应的文件或目录。");
    }
    lines.push(formatSubmissionFileContractHint(context));
    lines.push("源码改动路径放 answer.changedFiles；截图、日志、diff、mock、README、SQL、trace 等数量不稳定材料放 answer.attachments，attachments[].key 只是本轮附件标签。");
    lines.push("ask_human/rework/stop 前如果已生成供用户查看、确认、复核或下游引用的真实文件，必须提交 answer.attachments[]；不要只在 answer.text 里写路径。");
  } else {
    lines.push("只有 control.nextAction=\"continue\" 时才要求完整 text/structured 正式结果；ask_human/rework/stop 可使用 answer.mode=\"text\" 简要提交原因，不要展开完整 delivery_template 或伪造正式交付结论。");
    lines.push("answer.file / answer.files 只用于 file/file-set 正式交付；text/structured 节点如有动态证据文件，放 answer.attachments。");
    lines.push("ask_human/rework/stop 前如果已生成供用户查看、确认、复核或下游引用的真实文件，必须提交 answer.attachments[]；不要只在 answer.text 里写路径。");
  }
  lines.push(`动态附件 answer.attachments[].kind 合法值：${formatAttachmentKindAllowedValues()}；answer.attachments[].format 是兼容旧字段，合法值：${formatAttachmentFormatAllowedValues()}，不是 png/jpg 等文件扩展名。图片附件请优先填写 kind="image"，format 可省略。`);
  lines.push("acceptanceChecks[].criterionId 只能引用运行时验收项 ID；不确定时省略 criterionId，使用 label/verdict/evidence，不要自造 ID。");
  lines.push("control.nextAction=\"rework\" 时必须显式填写非空 rework.rerunNodeIds；集合必须同时包含 targetNodeId 和当前 nodeId，确保上游修正后当前节点重新评审，且不得超出当前节点 reworkPolicy 声明的最大影响集。受影响节点已有工作项看板时，还必须用 rework.workItemScopes 精确覆盖这些节点：全量问题使用 mode=all，局部问题使用 mode=selected + 稳定 sourceKeys；不得按标题、正文或正则猜范围。系统不会在字段缺失时默认扩大返工范围。");
  return lines;
}

/** 脱离实例快照定义，并仅从已记录来源补齐旧 helper 的时间类型字段。 */
function materializeSnapshotDefinition<T extends object>(
  definition: T,
  source: OrchestrationRuntimeAssetSource | null,
): T & { createdAt: number; updatedAt: number } {
  const createdAt = source?.authorityMode === "legacy" ? source.createdAt : 0;
  const updatedAt = source?.authorityMode === "legacy" ? source.updatedAt : 0;
  return { ...structuredClone(definition), createdAt, updatedAt };
}

/** 描述当前角色声明的结构化输出字段。 */
function formatSubmissionFieldContractHint(fields: RoleDefinition["outputDefinition"]["requiredFields"]): string {
  if (!fields.length) return "";
  const descriptions = fields.map((field) => {
    const required = field.required ? "必填" : "可选";
    return `${field.key}（${field.label || field.key}，${field.valueType}，${required}）`;
  });
  return `当前输出字段：${descriptions.join("；")}。`;
}

/** 描述当前角色声明的正式交付物 key。 */
function formatSubmissionFileContractHint(context: NormalizedNodeResultSubmissionToolContext): string {
  const files = context.outputDefinition.files ?? [];
  if (!files.length) return "当前角色没有配置固定 delivery_files key；不要把动态材料伪装成正式交付物。";
  return `当前角色允许的文件 key（交付物编号）：${files.map((file) => describeSubmissionFileContract(file, context.outputDefinition.format)).join("；")}。`;
}

/** 描述单个正式交付物，强调 key、格式和是否必填。 */
function describeSubmissionFileContract(file: RoleOutputFileDefinition, fallbackFormat: RoleOutputFormat): string {
  const key = String(file.key ?? "").trim() || "main";
  const name = String(file.name ?? "").trim();
  const format = file.format ?? fallbackFormat;
  const required = file.required ? "必填" : "可选";
  const extensions = file.allowedExtensions?.length ? file.allowedExtensions : ROLE_OUTPUT_FORMAT_EXTENSIONS[format];
  const suffix = extensions.length ? `，后缀 ${extensions.join("/")}` : "";
  return name
    ? `${key}（${name}，格式 ${format}，${required}${suffix}）`
    : `${key}（格式 ${format}，${required}${suffix}）`;
}

/** 生成当前提交工具的 JSON schema，并把当前允许 key 写入字段说明。 */
function buildNodeResultSubmissionInputSchema(context: NormalizedNodeResultSubmissionToolContext): Record<string, unknown> {
  const fileKeyDescription = buildSubmissionFileKeySchemaDescription(context);
  return {
    type: "object",
    description: `提交当前节点结果；当前 outputMode=${context.outputMode}。`,
    required: ["answer", "control", "review"],
    properties: {
      answer: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: {
            type: "string",
            enum: ["text", "structured", "file", "file-set"],
            description: `control.nextAction=continue 时必须与当前节点输出模式一致；ask_human/rework/stop 可使用 text 提交决策说明。当前 outputMode=${context.outputMode}。`,
          },
          text: { type: "string" },
          data: {},
          fields: {
            type: "object",
            description: "角色输出定义中声明的结构化字段，key 必须与配置一致；不要把正式文件路径或动态附件塞进 fields。",
            additionalProperties: true,
          },
          file: {
            type: "object",
            required: ["key", "path"],
            description: "单个正式交付物；只用于 file 输出模式的 continue 提交。",
            properties: {
              key: { type: "string", description: fileKeyDescription },
              path: { type: "string", description: "正式交付文件的 workspace 相对路径；文件正文必须已经写入工作区。" },
              summary: { type: "string" },
            },
          },
          files: {
            type: "array",
            description: "正式交付物列表，只用于 file-set 输出模式的 continue 提交；每个 key 最多一次，动态材料放 attachments。",
            items: {
              type: "object",
              required: ["key", "path"],
              properties: {
                key: { type: "string", description: fileKeyDescription },
                path: { type: "string", description: "正式交付文件的 workspace 相对路径；文件正文必须已经写入工作区。" },
                summary: { type: "string" },
              },
            },
          },
          attachments: {
            type: "array",
            description: "本轮动态附件；不属于角色 delivery_files 的源码、SQL、图、草案、日志、diff 等材料放这里，不要求命中角色文件 key。ask_human/rework/stop 前已生成且需要用户查看、确认或下游引用的真实文件也必须放这里，不能只在正文写路径。",
            items: {
              type: "object",
              required: ["path"],
              properties: {
                key: { type: "string", description: "可选的本轮附件标签，不是角色交付物 key，可以省略。" },
                path: { type: "string" },
                summary: { type: "string" },
                kind: { type: "string", enum: ATTACHMENT_KIND_VALUES, description: `附件用途分类，合法值：${formatAttachmentKindAllowedValues()}。` },
                format: { type: "string", enum: ATTACHMENT_FORMAT_VALUES, description: `兼容旧字段或可选内容格式，合法值：${formatAttachmentFormatAllowedValues()}；不是 png/jpg 等文件扩展名，新提交优先填写 kind。` },
                language: { type: "string", description: "源码附件的语言标识，例如 vue、typescript、java。仅用于展示和索引。" },
              },
            },
          },
          summary: { type: "string" },
          changedFiles: {
            type: "array",
            description: "本轮修改过的源码或文档路径清单；这里不是正式交付物引用。",
            items: { type: "string" },
          },
        },
      },
      control: {
        type: "object",
        required: ["nextAction"],
        properties: {
          nextAction: { type: "string", enum: ["continue", "rework", "ask_human", "stop"] },
          reason: { type: "string" },
        },
      },
      review: {
        type: "object",
        required: ["verdict", "summary"],
        properties: {
          verdict: { type: "string", enum: ["pass", "fail", "partial"] },
          summary: { type: "string" },
          blockingIssues: { type: "array", items: { type: "string" } },
        },
      },
      acceptanceChecks: {
        type: "array",
        items: {
          type: "object",
          required: ["verdict"],
          anyOf: [{ required: ["criterionId"] }, { required: ["label"] }],
          properties: {
            criterionId: { type: "string", description: "只能引用运行时已经声明的验收项 ID；不确定就省略，不要自造。" },
            label: { type: "string" },
            verdict: { type: "string", enum: ["pass", "fail", "not_evaluated"] },
            blocking: { type: "boolean" },
            evidence: { type: "string" },
          },
        },
      },
      humanInput: { type: ["object", "null"] },
      rework: {
        type: ["object", "null"],
        required: ["targetNodeId", "reason", "rerunNodeIds"],
        additionalProperties: false,
        properties: {
          targetNodeId: { type: "string" },
          reason: { type: "string" },
          rerunNodeIds: {
            type: "array",
            minItems: 1,
            description: "必填精确返工节点集合；必须同时包含 targetNodeId 和当前 nodeId，确保返工后重新评审，且只能缩小工作流声明的最大影响范围。",
            items: { type: "string" },
          },
          workItemScopes: {
            type: ["array", "null"],
            minItems: 1,
            maxItems: 100,
            description: "受影响节点已有工作项看板时必填，并精确覆盖这些节点。",
            items: {
              type: "object",
              required: ["nodeId", "mode"],
              additionalProperties: false,
              properties: {
                nodeId: { type: "string" },
                mode: { type: "string", enum: ["all", "selected"] },
                sourceKeys: { type: ["array", "null"], minItems: 1, maxItems: 2_000, items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };
}

/** 生成 file.key 的 schema 说明，直接列出当前允许 key。 */
function buildSubmissionFileKeySchemaDescription(context: NormalizedNodeResultSubmissionToolContext): string {
  const files = context.outputDefinition.files ?? [];
  const allowed = files.map((file) => String(file.key ?? "").trim()).filter(Boolean);
  if (!allowed.length) {
    return "正式交付物 key；当前角色没有配置固定 delivery_files key，动态附件不要放这里。";
  }
  return `正式交付物 key，必须严格等于当前允许 key 之一：${allowed.join(", ")}；动态附件不要放这里。`;
}

/** 生成提交工具的最小示例，示例只使用当前角色声明的正式 key。 */
function buildNodeResultSubmissionExamplePayload(context: NormalizedNodeResultSubmissionToolContext): NodeFinalAnswerPayload {
  return {
    answer: buildNodeResultAnswerExample(context),
    control: {
      nextAction: "continue",
      reason: "当前节点交付已完成，可以继续后续流程。",
    },
    review: {
      verdict: "pass",
      summary: "当前节点交付满足要求，可以继续。",
      blockingIssues: [],
    },
    acceptanceChecks: [
      {
        label: "关键验收项",
        verdict: "pass",
        blocking: true,
        evidence: "说明您如何验证这条验收项。",
      },
    ],
    humanInput: null,
    rework: null,
  };
}

/** 按当前 outputMode 生成 answer 示例，避免静态 key 误导模型。 */
function buildNodeResultAnswerExample(context: NormalizedNodeResultSubmissionToolContext): NodeExecutionEnvelope {
  const fields = buildExampleSubmissionFields(context.outputDefinition.requiredFields);
  switch (context.outputMode) {
    case "structured":
      return { mode: "structured", data: {}, summary: "简要说明", changedFiles: [], fields, attachments: [] };
    case "file":
      return {
        mode: "file",
        file: buildExampleSubmissionFile(selectPrimaryExampleFile(context), 0, context.outputDefinition),
        fields,
        attachments: [],
        changedFiles: [],
      };
    case "file-set":
      return {
        mode: "file-set",
        files: buildExampleSubmissionFileSet(context),
        fields,
        attachments: [],
        changedFiles: [],
      };
    default:
      return { mode: "text", text: "最终正文", summary: "简要说明", changedFiles: [], fields, attachments: [] };
  }
}

/** 只把必填字段放进示例，避免诱导模型提交无关字段。 */
function buildExampleSubmissionFields(fields: RoleDefinition["outputDefinition"]["requiredFields"]): Record<string, unknown> {
  return Object.fromEntries(fields
    .filter((field) => field.required)
    .map((field) => [field.key, exampleSubmissionFieldValue(field.valueType)]));
}

/** 为不同字段类型生成短示例值。 */
function exampleSubmissionFieldValue(valueType: RoleDefinition["outputDefinition"]["requiredFields"][number]["valueType"]): unknown {
  if (valueType === "json") return {};
  if (valueType === "file-path") return "«上游交付物的工作区相对路径»";
  if (valueType === "markdown") return "简要 Markdown 内容";
  return "简要说明";
}

/** 选择单文件模式的示例交付项。 */
function selectPrimaryExampleFile(context: NormalizedNodeResultSubmissionToolContext): RoleOutputFileDefinition | undefined {
  const files = context.outputDefinition.files ?? [];
  return files.find((file) => file.required) ?? files[0];
}

/** 生成 file-set 示例文件列表；有契约时只列必填 key。 */
function buildExampleSubmissionFileSet(context: NormalizedNodeResultSubmissionToolContext): Array<{ key: string; path: string; summary: string }> {
  const files = context.outputDefinition.files ?? [];
  const requiredFiles = files.filter((file) => file.required);
  if (requiredFiles.length) {
    return requiredFiles.map((file, index) => buildExampleSubmissionFile(file, index, context.outputDefinition));
  }
  if (files.length) return [];
  return [buildExampleSubmissionFile(undefined, 0, context.outputDefinition)];
}

/** 生成单个正式交付物示例。 */
function buildExampleSubmissionFile(
  file: RoleOutputFileDefinition | undefined,
  index: number,
  outputDefinition: RoleDefinition["outputDefinition"],
): { key: string; path: string; summary: string } {
  const key = String(file?.key ?? (index === 0 ? "main" : `file-${index + 1}`)).trim() || "main";
  return {
    key,
    path: buildExampleSubmissionPath(file, key, outputDefinition.format),
    summary: `${file?.name ? `${file.name}：` : ""}正式交付物摘要`,
  };
}

/** 生成不会要求模型复制占位符或落错目录的示例路径；与 promptRenderer 的示例规则保持一致。 */
function buildExampleSubmissionPath(
  file: RoleOutputFileDefinition | undefined,
  key: string,
  fallbackFormat: RoleOutputFormat,
): string {
  const pathRule = String(file?.pathRule ?? "").trim();
  if (pathRule && !/[{}<>]/.test(pathRule)) return pathRule;
  const extension = exampleExtensionForOutputFormat(file?.format ?? fallbackFormat);
  return `«按路径规则解析的工作区相对路径»/${key}.${extension}`;
}

/**
 * 交付路径规则是否已被平台完整解析：仍含占位符说明资产包尚未升级到 token 版，
 * 此时不能启用根目录守卫，否则旧包环境会陷入"拒绝-重试"而比升级前更差。
 */
function isArtifactPathRuleResolved(role: RoleDefinition): boolean {
  const rules = [role.outputDefinition.filePathRule, ...(role.outputDefinition.files ?? []).map((file) => file.pathRule)]
    .map((rule) => String(rule ?? "").trim())
    .filter(Boolean);
  return rules.length > 0 && rules.every((rule) => !/[{}<>]/.test(rule));
}

/** 把正式交付格式映射为示例后缀。 */
function exampleExtensionForOutputFormat(format: RoleOutputFormat): string {
  const extension = ROLE_OUTPUT_FORMAT_EXTENSIONS[format]?.[0] ?? ".md";
  return extension.replace(/^\./, "");
}

function isNodeResultSubmissionToolName(toolName: string): boolean {
  const normalized = String(toolName ?? "").trim();
  if (!normalized) return false;
  return normalized === ORCH_SUBMIT_NODE_RESULT_TOOL_ID || normalized === ORCH_SUBMIT_NODE_RESULT_TOOL_NAME;
}

function resolveTurnTerminalKind(
  event: { type?: string; payload?: unknown } | null | undefined,
  turnId: TurnId,
): "completed" | "error" | null {
  const type = String(event?.type ?? "").trim();
  if (type !== "turn.completed" && type !== "turn.error") return null;
  const eventTurnId = String((event?.payload as any)?.turnId ?? "").trim();
  if (eventTurnId && eventTurnId !== String(turnId)) return null;
  return type === "turn.completed" ? "completed" : "error";
}

function buildErrorFromTurnErrorPayload(payload: Record<string, unknown>): Error {
  const error = new Error(String(payload.error ?? "turn error")) as Error & {
    code?: string;
    terminationKind?: string;
    providerThreadId?: string;
    reason?: string;
    preserveBinding?: boolean;
    userChoiceRequired?: boolean;
    recoveryStrategies?: NodeThreadRecoveryStrategy[];
  };
  const code = String(payload.code ?? "").trim();
  const terminationKind = String(payload.terminationKind ?? "").trim();
  const providerThreadId = String(payload.providerThreadId ?? "").trim();
  const recoveryReason = String(payload.recoveryReason ?? "").trim();
  if (code) error.code = code;
  if (terminationKind) error.terminationKind = terminationKind;
  if (providerThreadId) error.providerThreadId = providerThreadId;
  if (recoveryReason) error.reason = recoveryReason;
  if (typeof payload.preserveBinding === "boolean") error.preserveBinding = payload.preserveBinding;
  if (typeof payload.userChoiceRequired === "boolean") error.userChoiceRequired = payload.userChoiceRequired;
  if (Array.isArray(payload.recoveryStrategies)) {
    const strategies = payload.recoveryStrategies.filter(
      (item): item is NodeThreadRecoveryStrategy => item === "retry-existing" || item === "new-thread",
    );
    if (strategies.length) error.recoveryStrategies = Array.from(new Set(strategies));
  }
  return error;
}

function mergeDeveloperMessages(base: string | null | undefined, extra: string | null | undefined): string | null {
  const parts = [String(base ?? "").trim(), String(extra ?? "").trim()].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

function toHostToolExecutionResult(result: ToolExecutionResult): HostToolExecutionResult {
  if (result.ok) {
    return {
      ok: true,
      output: result.output,
      durationMs: result.durationMs,
    };
  }
  return {
    ok: false,
    message: result.message,
    code: result.code,
    output: {
      code: result.code,
      message: result.message,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
      exitCode: result.exitCode ?? null,
    },
    durationMs: result.durationMs ?? null,
  };
}

/** 严格读取工作项工具对象输入。 */
function readNodeWorkItemToolObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NodeWorkItemRepoError("INVALID_INPUT", "工作项工具输入必须是对象");
  }
  return value as Record<string, unknown>;
}

/** 读取工作项创建时的结构化验收条件，详细唯一性由仓储校验。 */
function readNodeWorkItemAcceptanceCriteria(value: unknown): NodeWorkItemAcceptanceCriterion[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new NodeWorkItemRepoError("INVALID_INPUT", "acceptanceCriteria 必须是数组");
  return value.map((raw) => {
    const criterion = readNodeWorkItemToolObject(raw);
    return { id: String(criterion.id ?? ""), label: String(criterion.label ?? "") };
  });
}

/** 读取工作项完成检查，精确覆盖关系由仓储校验。 */
function readNodeWorkItemCompletionChecks(value: unknown): NodeWorkItemCompletionCheck[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new NodeWorkItemRepoError("INVALID_INPUT", "completionChecks 必须是数组");
  return value.map((raw) => {
    const check = readNodeWorkItemToolObject(raw);
    return { criterionId: String(check.criterionId ?? ""), evidence: String(check.evidence ?? "") };
  });
}

/** 读取工作项状态筛选并拒绝未知值。 */
function readNodeWorkItemStatuses(value: unknown): Array<"pending" | "in_progress" | "completed"> | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new NodeWorkItemRepoError("INVALID_INPUT", "statuses 必须是数组");
  return value.map((item) => {
    const status = String(item ?? "").trim();
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new NodeWorkItemRepoError("INVALID_INPUT", `未知工作项状态：${status}`);
    }
    return status;
  });
}

/** 读取可选整数，具体范围由仓储继续校验。 */
function readOptionalInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new NodeWorkItemRepoError("INVALID_INPUT", "参数必须是整数");
  return parsed;
}

function normalizeStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  return items.length ? items : null;
}

/** 归一化审核反馈图片 dataURL；空数组表示没有可发送图片。 */
function normalizeFeedbackImages(images: string[] | null | undefined): string[] {
  return Array.from(new Set(
    (images ?? [])
      .map((item) => String(item ?? "").trim())
      .filter(Boolean),
  ));
}

/** 校验并归一化节点反馈携带的一次性模型覆盖，非法输入直接阻断恢复。 */
function normalizeNodeFeedbackExecutionOverride(
  raw: NodeFeedbackExecutionOverride | null | undefined,
): NodeFeedbackExecutionOverride | null {
  if (raw == null) return null;
  const model = String(raw.model ?? "").trim();
  if (!model) throw new Error("节点恢复执行模型不能为空");

  const normalized: NodeFeedbackExecutionOverride = { model };
  if (Object.prototype.hasOwnProperty.call(raw, "effort")) {
    normalized.effort = String(raw.effort ?? "").trim() || null;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "autoCompactPct")) {
    const value = raw.autoCompactPct;
    if (value == null) normalized.autoCompactPct = null;
    else if (Number.isSafeInteger(value) && value >= 50 && value <= 99) normalized.autoCompactPct = value;
    else throw new Error("节点恢复执行压缩阈值必须是 50 到 99 的整数");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "contextWindow")) {
    const value = raw.contextWindow;
    if (value == null) normalized.contextWindow = null;
    else if (Number.isSafeInteger(value) && value > 0) normalized.contextWindow = value;
    else throw new Error("节点恢复执行上下文窗口必须是正整数");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "serviceTier")) {
    if (raw.serviceTier == null || raw.serviceTier === "fast") normalized.serviceTier = raw.serviceTier;
    else throw new Error("节点恢复执行服务档位不受支持");
  }
  return normalized;
}

/** 归一化附件用途分类；空值允许由后续校验按文件后缀推断。 */
function normalizeAttachmentKind(raw: unknown): AttachmentKind | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (ATTACHMENT_KINDS.has(value as AttachmentKind)) return value as AttachmentKind;
  throw new Error(`节点结果.answer.attachments[].kind 无效：${value}。合法值：${formatAttachmentKindAllowedValues()}`);
}

/** 归一化兼容附件格式；空值允许由后续校验按文件后缀推断。 */
function normalizeAttachmentFormat(raw: unknown): AttachmentFormat | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (ATTACHMENT_FORMATS.has(value as AttachmentFormat)) return value as AttachmentFormat;
  throw new Error(`节点结果.answer.attachments[].format 无效：${value}。format 不是文件扩展名，合法值：${formatAttachmentFormatAllowedValues()}；图片请填 kind="image"，format 可省略或填 "image"，不要填 png/jpg/jpeg/webp`);
}

/** 将持久化的附件分类值转回下游 prompt 可见 kind；兼容旧 format 存量值。 */
function normalizeAttachmentRefKind(raw: unknown): AttachmentKind | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (ATTACHMENT_KINDS.has(value as AttachmentKind)) return value as AttachmentKind;
  if (value === "markdown" || value === "text") return "document";
  if (value === "json" || value === "yaml" || value === "sql") return "data";
  if (value === "html" || value === "javascript" || value === "css" || value === "source") return "source";
  if (value === "image") return "image";
  return null;
}

/** 归一化源码附件语言；只影响展示和索引，不参与正式契约判定。 */
function normalizeAttachmentLanguage(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  const normalized = value.replace(/[^a-z0-9_+#.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized ? normalized.slice(0, 40) : null;
}

/** 将字段索引中的 JSON 值转成有界预览，完整内容留给工件文件或运行证据读取。 */
function formatNodeResultFieldValue(field: NodeResultField): { valueText: string; truncated: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(field.valueJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`节点输出字段 ${field.fieldKey} 的 valueJson 无法解析：${reason}`);
  }
  const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  const valueText = String(text ?? "");
  if (valueText.length <= MAX_UPSTREAM_FIELD_VALUE_CHARS) {
    return { valueText, truncated: false };
  }
  const preview = (String(field.valuePreview ?? "").trim() || valueText).slice(0, 240);
  return {
    valueText: `${preview}\n[字段值已压缩；完整内容请读取工件文件引用或通过运行证据定位原工件]`,
    truncated: true,
  };
}

/** 保留模型提交的结构化输出字段；非对象输入视为未提交字段。 */
function normalizeEnvelopeFields(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { ...(raw as Record<string, unknown>) };
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

const WORKSPACE_SCAN_SKIP_DIR_NAMES = new Set([
  ".git",
  ".idea",
  ".next",
  ".nuxt",
  ".turbo",
  ".vscode",
  "bin",
  "build",
  ".codeflowai",
  "codeflowai",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "out",
  "target",
  "temp",
  "tmp",
  "vendor",
]);

const INTEGRATED_PROTOTYPE_DIR_NAMES = new Set(["prototype", "prototypes"]);

function findExistingIntegratedPrototypeBaselinePath(workspacePath: string, workflowDocsRoot: string): string | null {
  const workspaceRoot = path.resolve(String(workspacePath ?? "").trim());
  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return null;
  const docsRootAbs = path.resolve(workspaceRoot, normalizeWorkspaceRelPath(workflowDocsRoot) || "codeflow-docs");
  const queue = [workspaceRoot];
  let scannedDirs = 0;

  while (queue.length > 0 && scannedDirs < 2048) {
    const currentDir = queue.shift()!;
    scannedDirs += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      const childAbs = path.join(currentDir, entry.name);
      if (isSameOrNestedAbsolutePath(childAbs, docsRootAbs)) continue;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;

      const dirName = entry.name.toLowerCase();
      if (WORKSPACE_SCAN_SKIP_DIR_NAMES.has(dirName)) continue;
      if (INTEGRATED_PROTOTYPE_DIR_NAMES.has(dirName)) {
        const foundFile = findFirstRegularFile(childAbs, 4);
        if (foundFile) return toWorkspaceRelativePath(workspaceRoot, foundFile);
        continue;
      }
      queue.push(childAbs);
    }
  }

  return null;
}

function findFirstRegularFile(dirAbs: string, remainingDepth: number): string | null {
  if (remainingDepth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return null;
  }

  for (const entry of entries) {
    const childAbs = path.join(dirAbs, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile()) return childAbs;
    if (!entry.isDirectory()) continue;
    const dirName = entry.name.toLowerCase();
    if (WORKSPACE_SCAN_SKIP_DIR_NAMES.has(dirName)) continue;
    const nested = findFirstRegularFile(childAbs, remainingDepth - 1);
    if (nested) return nested;
  }

  return null;
}

function readWorkflowDocsRootFromWorkspace(workspacePath: string): string {
  try {
    const existing = readExistingCodeflowaiConfig(workspacePath);
    return normalizeWorkspaceRelPath(String(existing?.config.paths?.workflowDocsRoot ?? "").trim() || "codeflow-docs");
  } catch {
    return "codeflow-docs";
  }
}

function toWorkspaceRelativePath(workspaceRoot: string, targetAbsPath: string): string {
  return normalizeWorkspaceRelPath(path.relative(path.resolve(workspaceRoot), path.resolve(targetAbsPath)));
}

function normalizeWorkspaceRelPath(filePath: string | null | undefined): string {
  return String(filePath ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isSameOrNestedWorkspaceRelPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeWorkspaceRelPath(candidate);
  const normalizedRoot = normalizeWorkspaceRelPath(root);
  if (!normalizedCandidate || !normalizedRoot) return false;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/** 按宿主平台路径语义判断候选绝对路径是否位于根内。 */
function isSameOrNestedAbsolutePath(candidateAbs: string, rootAbs: string): boolean {
  const normalizedCandidate = normalizeAbsolutePathForComparison(candidateAbs);
  const normalizedRoot = normalizeAbsolutePathForComparison(rootAbs);
  if (!normalizedCandidate || !normalizedRoot) return false;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** 仅在 Windows 上折叠大小写，POSIX 保留大小写敏感语义。 */
function normalizeAbsolutePathForComparison(absPath: string): string {
  const resolved = path.resolve(String(absPath ?? "").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

