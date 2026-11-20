import crypto from "node:crypto";
import { handleChatWorkflowRequest } from "./handlers/chatWorkflowHandlers.js";
import { assertChatDirectoryAvailable, reserveChatWorkflowDirectory } from "../orchestration/workspaceExecutionGuard.js";
import { readExistingCodeflowaiConfig } from "../codeflowai/codeflowaiConfig.js";
import { ChatWorkflowService, CHAT_WORKFLOW_TOOL_ID, buildChatWorkflowToolRegistry, executeChatWorkflowTool } from "../orchestration/chatWorkflowService.js";
import { trackOrdinaryTurnExecution, type OrdinaryTurnExecutionControl } from "./ordinaryTurnExecution.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";
import type {
  AccessMode,
  CodexServiceTier,
  ConversationEventInput,
  EngineType,
  ItemId,
  NodeExecutionProfileScope,
  OrchestrationEventRecord,
  OrchestrationId,
  RawEngineEventInput,
  RoleId,
  OrchAssetExecutionAuthorization,
  WorkspaceExecutionProfileScope,
  WorkspacePathReference,
  ThreadId,
  ThreadInputKind,
  TurnExecutionOptionsSnapshot,
  TurnId,
  WorkspaceId,
} from "@codeflowai/shared";
import {
  createWorkspacePathReference,
  buildCodexCliSlashInputActions,
  estimateBinaryBytesFromDataUrl,
  extractTurnErrorMetadata,
  MANUAL_TURN_INTERRUPT_CODE,
  normalizeThreadInputContract,
  ThreadInputContractError,
  normalizeWorkspacePathReferenceList,
  validateInlineThreadPayload,
} from "@codeflowai/shared";
import {
  createTurnErrorEventInput,
  createTurnErrorEventInputFromError,
} from "../errors/turnErrors.js";

import type { ClientToServerMessage, ServerToClientMessage } from "../protocol/messages.js";
import { describeWorkspaceProfileFailure, type ClientDb } from "../db/clientDb.js";
import type { OrchIntakeListReader } from "../db/orchIntakeListSnapshot.js";
import { OrchInstanceSummaryProjectionError } from "../db/orchInstanceSummaryProjection.js";
import { OrchIntakeRepoError } from "../db/repos/orchIntakeRepo.js";
import { OrchProposalScopeError } from "../db/repos/orchProposalRepo.js";
import { OrchInstanceScopeError } from "../db/repos/orchInstanceRepo.js";
import { OrchRequirementAnalysisSessionRepoError } from "../db/repos/orchRequirementAnalysisSessionRepo.js";
import type { ClientDbCleanupService } from "../db/clientDbCleanupService.js";
import type { WorkspacePathIndex } from "../fs/workspacePathIndexService.js";
import type { ThreadStore } from "../threads/threadStore.js";
import {
  THREAD_DELETION_IN_PROGRESS_CODE,
  THREAD_OPERATION_IN_PROGRESS_CODE,
  THREAD_RUNTIME_STALE_CODE,
  type ThreadSessionManager,
} from "../engines/threadSessionManager.js";
import { assertClientReasoningEffortSupported } from "../engines/engineModelCapabilities.js";
import {
  buildClientThreadPromptText,
  hasExplicitThreadInputContract,
  normalizeClientThreadDisplayInput,
  resolveProviderSlashPreflightConflict,
} from "../engines/threadInputActions.js";
import { extractSafeClaudeSlashCommandName } from "../engines/claude/claudeInputActions.js";
import { getUploadWorkspacePath } from "../fs/fsService.js";
import {
  ACTIVE_TURN_CONFLICT_MESSAGE,
  isEngineWorkspaceLogFailure,
  type HostToolExecutionResult,
  type PreparedCodexSkillInput,
  type ThreadEngineSession,
  type TurnTimeoutPolicy,
} from "../engines/threadSession.js";
import { emitTurnTerminalWithAssistantReconcile } from "../engines/turnTerminalEmitter.js";
import type { TerminalManager } from "../terminal/terminalManager.js";
import type { OrchestrationEngine } from "../orchestration/orchestrationEngine.js";
import type { OrchAssetAuthorityRuntimeReadService, OrchAssetRuntimeRoot } from "../orchestration/orchAssetAuthorityRuntimeReadService.js";
import { isDesktopLocalThreadAssetExecution } from "../orchestration/orchAssetAuthorityRuntimeReadService.js";
import type { OrchAssetLaunchSnapshotService } from "../orchestration/orchAssetLaunchSnapshotService.js";
import {
  resolveOrchestrationNodeQueueBinding,
} from "../queue/orchestrationNodeQueuePolicy.js";
import { buildTurnExecutionOptionsSnapshot } from "../queue/threadQueueExecutionPolicy.js";
import { RequirementAnalysisService, RequirementAnalysisServiceError } from "../orchestration/requirementAnalysisService.js";
import { AssetDraftService, AssetDraftServiceError } from "../orchestration/assetDraftService.js";
import { MANAGED_SERVICE_TOOL_ID } from "../orchestration/managedServiceRuntime.js";
import { ToolRuntimeService, type ToolExecutionResult } from "../orchestration/toolRuntimeService.js";
import {
  handleWorkspaceExecutionProfileGet,
  handleWorkspaceExecutionProfileStatus,
  handleWorkspaceExecutionProfileUpdate,
  handleWorkspacesDelete,
  handleWorkspacesList,
  handleWorkspacesUpsert,
} from "./handlers/workspaceHandlers.js";
import { handleApprovalsRespond, handleUserInputRespond } from "./handlers/interactionHandlers.js";
import { handleEnginesStatus } from "./handlers/engineHandlers.js";
import { handleCodeflowaiConfigGet, handleCodeflowaiConfigSet } from "./handlers/codeflowaiHandlers.js";
import { handleEnginesConfigGet, handleEnginesConfigSet } from "./handlers/enginesConfigHandlers.js";
import { handleEngineKeysList, handleEngineKeysUpsert, handleEngineKeysDelete, handleEngineKeysActivate, handleEngineKeysDeactivate, handleEngineKeysTest } from "./handlers/engineKeyHandlers.js";
import { handleEngineCustomModelsDelete, handleEngineCustomModelsList, handleEngineCustomModelsUpsert } from "./handlers/engineCustomModelHandlers.js";
import { handleMcpConfigure, handleMcpEnable, handleMcpImport, handleMcpInstall, handleMcpTest, handleMcpUnconfigure, handleMcpUninstall, handleMcpUpdate, handleSkillsInstall, handleSkillsSuites, handleSkillsUninstall } from "./handlers/skillsHandlers.js";
import { handleClientExit, handleClientUpgrade, handleNpmInstall, handleSoftwareUpdateStatus } from "./handlers/softwareUpdateHandlers.js";
import { handleClientLogsDownload, handleClientLogsFiles, handleClientLogsTail } from "./handlers/clientLogHandlers.js";
import { handleTerminalActionsList, handleTerminalActionsSave, handleTerminalShellsList } from "./handlers/terminalHandlers.js";
import { buildPromptText, normalizeTextFiles } from "./utils/promptWithAttachments.js";
import { buildDefaultChatSystemPrompt } from "./defaultChatSystemPrompt.js";
import { resolveWorkspaceKnowledgeChatContext } from "./workspaceKnowledgeChatContext.js";
import { handleKnowledgeAssetRequest } from "./handlers/knowledgeAssetHandlers.js";
import { createKnowledgeSuggestionTurn } from "../knowledge/knowledgeChangeTools.js";
import { createKnowledgeSpecificationTurn } from "../knowledge/knowledgeSpecificationTurn.js";
import { KnowledgeAssetStore } from "../knowledge/knowledgeAssetStore.js";
import { createKnowledgeConversationTurn, readKnowledgeConversationActor, settleKnowledgeConversationEvent, type KnowledgeConversationActor } from "../knowledge/knowledgeConversationService.js";
import { KnowledgeAssetError, knowledgeFailure } from "../knowledge/knowledgeAssetFiles.js";
import {
  buildNativeDynamicToolDeveloperMessageForChat,
  mergeExecutableToolRegistries,
  prepareChatRoleSkills,
  resolveChatRoleRuntime,
} from "./chatRoleRuntime.js";
import {
  evaluateSharedWorkspaceHostToolPolicy,
  readSharedWorkspaceToolExecutionContext,
  sharedWorkspaceToolDeniedResult,
  type SharedWorkspaceToolExecutionContext,
} from "./sharedWorkspaceToolPolicy.js";
import { handleThreadsFileChangesAccept, handleThreadsFileChangesDiff, handleThreadsFileChangesList, handleThreadsFileChangesUndo } from "./handlers/fileChangeHandlers.js";
import { handleThreadsRollback, handleThreadsRollbackPreview, reconcileUnresolvedRollbackBeforeMutation } from "./handlers/rollbackHandlers.js";
import {
  handleClientDirectoryTree,
  handleFsDocumentPreview,
  handleFsExtractAttachment,
  handleFsDownloadChunk,
  handleFsDownloadFile,
  handleFsDownloadStat,
  handleFsTree,
  handleFsReadFile,
  handleFsReindex,
  handleFsSearch,
  handleFsSpreadsheetPreview,
  handleFsStat,
  handleFsUploadBegin,
  handleFsUploadCancel,
  handleFsUploadChunk,
  handleFsUploadComplete,
} from "./handlers/fsHandlers.js";
import {
  handleGitStatus, handleGitDiff, handleGitDiffFiles, handleGitStage, handleGitUnstage, handleGitDiscard,
  handleGitCommit, handleGitLog, handleGitShow, handleGitShowFileDiff,
  handleGitBranchList, handleGitBranchCreate, handleGitBranchSwitch, handleGitBranchDelete,
  handleGitCodeAttributionCollect,
} from "./handlers/gitHandlers.js";
import {
  handleThreadsArchive,
  handleClientDbCleanupStart,
  handleClientDbCleanupStatus,
  handleThreadsClear,
  handleThreadsCreate,
  handleThreadsDelete,
  handleThreadsEvents,
  handleThreadGroupAssign,
  handleThreadGroupsCreate,
  handleThreadGroupsDelete,
  handleThreadGroupsList,
  handleThreadGroupsRename,
  handleThreadsList,
  handleThreadsLatestPrefs,
  handleThreadsLoad,
  handleThreadsPresentation,
  handleThreadMessageDelete,
  handleThreadsManagedServicesList,
  handleThreadsManagedServicesStop,
  handleThreadsPin,
  handleThreadsRestartCodexAppServer,
  handleThreadsSummary,
  handleThreadsDraftClear,
  handleThreadsDraftGet,
  handleThreadsDraftSave,
  handleThreadsPrefs,
  handleThreadsRename,
  handleThreadsUpdatePrefs,
} from "./handlers/threadHandlers.js";
import {
  handleReminderIgnoreItems,
  handleReminderItemsList,
  handleReminderMarkRead,
  handleReminderMetricReviewScan,
  handleReminderWorkspaceSummaries,
} from "./handlers/reminderHandlers.js";
import { handleWorkspacePrefsGet, handleWorkspacePrefsSave } from "./handlers/workspacePrefsHandlers.js";
import {
  emitQueueChanged,
  onThreadQueueAppend,
  onThreadQueueClear,
  onThreadQueueList,
  onThreadQueueMove,
  onThreadQueuePause,
  onThreadQueueRemove,
  onThreadQueueResume,
  type ThreadQueueKickAdapter,
} from "./handleThreadQueueRequest.js";
import type { SendIdempotencyCache } from "./sendIdempotencyCache.js";
import { waitForPostReconcileEventDurability } from "./rollbackEvidenceFence.js";
import { logger } from "../logger.js";
import { summarizeImageInputs } from "../diagnostics/imageInputDiagnostics.js";
import type { WsSendJsonResult } from "../transport/wsTransport.js";
import type { ScheduledTaskScheduler } from "../scheduled-tasks/scheduledTaskScheduler.js";
import {
  interruptTurnBestEffort,
  canInterruptRuntimeTurnWithoutDatabase,
  retryPendingTurnTerminal,
  settleManualTurnTerminalOnce,
  settleTurnTerminalOnce,
} from "./turnInterrupt.js";
import {
  handleOrchIntakesList,
  handleOrchIntakesCreate,
  handleOrchIntakesDelete,
  handleOrchIntakesUpsert,
  handleOrchPendingMineList,
  handleOrchRequirementAnalysisCreateIntakes,
  handleOrchRequirementAnalysisMessagesSend,
  handleOrchRequirementAnalysisSessionsArchive,
  handleOrchRequirementAnalysisSessionsCreate,
  handleOrchRequirementAnalysisSessionsGet,
  handleOrchRequirementAnalysisSessionsList,
  handleOrchAssetDraftsApply,
  handleOrchAssetBundlesExport,
  handleOrchAssetBundlesImport,
  handleOrchAssetsCopy,
  handleOrchAssetDraftsGenerate,
  handleOrchAssetDraftsGet,
  handleOrchAssetDraftsReject,
  handleOrchAssetDraftJobsDelete,
  handleOrchAssetDraftJobsGet,
  handleOrchAssetDraftJobsList,
  handleOrchAssetDraftJobsResume,
  handleOrchAssetGroupsAssign,
  handleOrchAssetGroupsCreate,
  handleOrchAssetGroupsDelete,
  handleOrchAssetGroupsList,
  handleOrchAssetGroupsRename,
  handleOrchRolesList, handleOrchRolesUpsert, handleOrchRolesDelete,
  handleOrchWorkflowsList, handleOrchWorkflowsUpsert, handleOrchWorkflowsDelete,
  handleOrchAssigneeTemplatesList, handleOrchAssigneeTemplatesUpsert, handleOrchAssigneeTemplatesDelete,
  handleOrchWorkflowExecutionDefaultsGet, handleOrchWorkflowExecutionDefaultsUpsert, handleOrchWorkflowExecutionDefaultsDelete,
  handleOrchToolsetsList, handleOrchToolsetsUpsert, handleOrchToolsetsDelete,
  handleOrchSkillsList, handleOrchSkillsUpsert, handleOrchSkillsDelete,
  handleOrchSkillsInstallStatus, handleOrchSkillsInstall, handleOrchSkillsUninstall,
  handleOrchKnowledgeBundlesList, handleOrchKnowledgeBundlesUpsert, handleOrchKnowledgeBundlesDelete,
  handleOrchProposalsList, handleOrchProposalsGet, handleOrchProposalsCreate, handleOrchProposalsConfirm,
  handleOrchInstancesList, handleOrchInstancesGet, handleOrchInstancesRuntimePatch, handleOrchInstancesReassignNode, handleOrchArtifactsList, handleOrchArtifactGet, handleOrchArtifactFilesList, handleOrchArtifactRevise,
  handleOrchEventsList, handleOrchRuntimeEvidenceGet, handleOrchPromptSnapshotsList, handleOrchPromptSnapshotGet, handleOrchInstancesStart,
  handleOrchNodeWorkItemsList, handleOrchNodeWorkItemEventsList,
  handleOrchInstancesPause, handleOrchInstancesResume, handleOrchInstancesCancel,
  handleOrchNodesCancel, handleOrchNodesSkip, handleOrchNodesStart,
  handleOrchInstancesFeedback,
  handleOrchInstancesRerunFromNode,
  handleOrchInstancesEnsureDiscussionThread,
} from "./handlers/orchestrationHandlers.js";
import { handleOrchMetricsCollect } from "./handlers/orchMetricsHandlers.js";
import { handleLocalScheduledTaskRequest, handleScheduledTaskRunNow, handleAccountScheduledTaskConfigRequest } from "./handlers/scheduledTaskHandlers.js";
import {
  handleControlledExperimentFreeze,
  handleControlledExperimentRunCancel,
  handleControlledExperimentRunStart,
  handleControlledExperimentRunStatus,
} from "./handlers/controlledExperimentHandlers.js";
import type { ControlledExperimentExecutor } from "../experiments/controlledExperimentExecutor.js";
import {
  WorkspaceOperationGateError,
  type WorkspaceOperationGate,
} from "../workspace-migration/workspaceOperationGate.js";
import type { WorkspaceMigrationIndexCoordinatorService } from "../workspace-migration/workspaceMigrationIndexCoordinator.js";
import type { WorkspaceMigrationActivityInspector } from "../workspace-migration/workspaceMigrationActivityInspector.js";
import type { WorkspaceMigrationService } from "../workspace-migration/workspaceMigrationService.js";
import {
  handleWorkspaceMigrationCancel,
  handleWorkspaceMigrationExecuteStart,
  handleWorkspaceMigrationFenceStart,
  handleWorkspaceMigrationGet,
  handleWorkspaceMigrationPrepare,
  handleWorkspaceMigrationPrepareStart,
  handleWorkspaceMigrationRecover,
} from "./handlers/workspaceMigrationHandlers.js";

export type ApiRequestMessage = Extract<ServerToClientMessage, { t: "api.req" }>;

const THREAD_OPERATION_UNTRACKED_METHODS = new Set([
  "threads.clear", "threads.rollback", "approvals.respond",
  "threads.messages.delete",
  "threads.summary",
  "threads.load",
  "threads.presentation",
  "threads.process",
  "threads.prefs",
  "threads.latestPrefs",
  "threads.draft.get",
  "threads.inputActions.list",
  "threads.queue.list",
  "threads.events",
  "threads.managedServices.list",
  "threads.delete",
  "threads.fileChanges.list",
  "threads.fileChanges.diff",
  "threads.rollback.preview",
]);
const REQUIREMENT_ANALYSIS_THREAD_OPERATION_METHODS = new Set([
  "orch.requirementAnalysis.sessions.archive",
  "orch.requirementAnalysis.messages.send",
  "orch.requirementAnalysis.createIntakes",
]);
const WORKSPACE_MIGRATION_GATED_API_METHODS = new Set([
  "workspaces.upsert",
  "workspaces.delete",
  "skills.install",
  "skills.uninstall",
  "mcp.install",
  "mcp.enable",
  "mcp.update",
  "mcp.test",
  "mcp.import",
  "mcp.uninstall",
  "mcp.configure",
  "mcp.unconfigure",
  "scheduledTasks.runNow",
  "threads.sendMessage",
  "threads.compact",
  "threads.restartCodexAppServer",
  "threads.fileChanges.accept",
  "threads.fileChanges.undo",
  "threads.rollback",
  "terminal.actions.save",
  "orch.requirementAnalysis.messages.send",
  "orch.requirementAnalysis.createIntakes",
  "orch.assetDrafts.generate",
  "orch.assetDraftJobs.resume",
  "orch.assetDrafts.apply",
  "orch.assetBundles.export",
  "orch.assetBundles.import",
  "orch.assets.copy",
  "orch.roles.upsert",
  "orch.roles.delete",
  "orch.workflows.upsert",
  "orch.workflows.delete",
  "orch.assigneeTemplates.upsert",
  "orch.assigneeTemplates.delete",
  "orch.workflowExecutionDefaults.upsert",
  "orch.workflowExecutionDefaults.delete",
  "orch.toolsets.upsert",
  "orch.toolsets.delete",
  "orch.skills.upsert",
  "orch.skills.delete",
  "orch.skills.install",
  "orch.skills.uninstall",
  "orch.knowledgeBundles.upsert",
  "orch.knowledgeBundles.delete",
  "orch.proposals.create",
  "orch.proposals.confirm",
  "orch.instances.start",
  "orch.instances.resume",
  "orch.instances.feedback",
  "orch.instances.rerunFromNode",
  "orch.instances.discussionThread.ensure",
  "orch.nodes.start",
  "orch.nodes.skip",
  "orch.experiments.freeze",
  "orch.experiments.run.start",
  "orch.artifacts.revise",
  "fs.reindex",
  "fs.uploadBegin",
  "fs.uploadChunk",
  "fs.uploadComplete",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "git.codeAttribution.collect",
  "git.branch.create",
  "git.branch.switch",
  "git.branch.delete",
]);

export type ApiHandlerContext = {
  /** 新执行沿真实派发边界复验固定来源；在途回合收尾不调用此入口。 */
  assertAssetExecution?: (input: {
    workspaceId: WorkspaceId; threadId?: ThreadId; root?: OrchAssetRuntimeRoot;
    authorization?: OrchAssetExecutionAuthorization | null; toolContext?: SharedWorkspaceToolExecutionContext | null;
  }) => void;
  /** 桌面关联与内置凭据由 Client 可信运行时装配，不接受请求方声明 owner。 */
  desktopCloudAccount?: import("../runtime/desktopCloudAccount.js").DesktopCloudAccount;
  builtInRelayCredentials?: import("../security/builtInRelayCredentialService.js").BuiltInRelayCredentialService;
  /** 只读取桌面生命周期的单一暂停事实，不改变业务暂停原因。 */
  isTaskAdmissionPaused?: () => boolean;
  /** 请求所属边界已记录失败；桌面适配器仅补记无 owner 的失败响应。 */
  onApiFailureLogged?: () => void;
  /** 仅可信入口装配，需求正文不能指定或变更持久归属。 */
  intakeWorkspaceScope?: NodeExecutionProfileScope;
  /** 共享命令可信诊断信息，只用于原文件错误边界关联请求。 */
  sharedFileRequestContext?: { requestId: string; routeEventId: string; sharedWorkspaceId: string; actorUserId: string; hostBindingId: string };
  /** 仅由桌面 Host 固定：本地历史列表和偏好查询排除共享会话。 */
  localWorkspaceOnly?: boolean;
  db: ClientDb;
  /** 需求列表专用只读连接；缺失或失败时禁止回退主线程同步 SQL。 */
  orchIntakeListReader?: OrchIntakeListReader;
  /** Client DB 大表分批清理任务及空间统计。 */
  dbCleanup?: ClientDbCleanupService;
  workspaces: Map<WorkspaceId, string>;
  serverWsUrl?: string;
  /** 读取随包本地内置资产，供目录展示与历史孤儿检查。 */
  loadServerDefaultBundles?: () => Promise<readonly import("@codeflowai/shared").OrchAssetBundle[]>;
  /** 本机 clientId（用于给 workspaceId 加前缀）。 */
  clientId: string;
  /** 仅桌面 Host 装配的真实设备身份；Server 请求上下文不授予本机任务入口。 */
  deviceId?: string;
  /** Client 本地 workspace 文件路径索引；fs.search 优先使用该索引加速普通关键词搜索。 */
  workspacePathIndex?: WorkspacePathIndex;
  /** 目录迁移索引协调器；手工重建时负责替换持久化 generation。 */
  workspaceMigrationIndexCoordinator?: Pick<WorkspaceMigrationIndexCoordinatorService, "rebuildWorkspace">;
  /** Client 目录迁移事实服务；由生产启动装配后供 API handler 调用。 */
  workspaceMigrationService?: Pick<
    WorkspaceMigrationService,
    "prepare" | "prepareStartAttempt" | "executeStart" | "fenceStartAttempt" | "cancel" | "recover"
  >;
  /** 读取当前工作区活动资源，生成迁移 operation 的 blockers 投影。 */
  workspaceMigrationActivityInspector?: WorkspaceMigrationActivityInspector;
  /** 工作区变更后通知 Server；迁移只刷新路径，不在独占期重新准备资产。 */
  onWorkspacesChanged?: (reason?: "create" | "update" | "delete" | "migration") => void | Promise<void>;
  timeoutPolicy: TurnTimeoutPolicy;
  threads: ThreadStore;
  sessions: ThreadSessionManager;
  controlledExperiments: ControlledExperimentExecutor;
  /** Host 本机终端管理器；共享工作区远程 terminal route 复用同一安全边界。 */
  terminalManager?: TerminalManager;
  /** 本机未登录模式的终端事件发布边界；由桌面 Host 可信装配，事件归属已由 Client 注入。 */
  publishTerminalEvent?: (event: import("@codeflowai/shared").DesktopTerminalEvent) => void;
  orchEngine: OrchestrationEngine;
  /** 在工作区事务中读取本地内置与自定义资产。 */
  orchAssetRuntimeRead?: OrchAssetAuthorityRuntimeReadService;
  /** 启动前从单一权威会话解析完整资产图。 */
  orchAssetLaunchSnapshot?: OrchAssetLaunchSnapshotService;
  /** 控制响应可以被本地截取；转发消息时必须透传传输层接收结果。 */
  send: (msg: ClientToServerMessage) => WsSendJsonResult | void;
  /** 认证的指标请求临时驱动该工作区归因同步，完成或取消后释放需求。 */
  syncCodeAttribution?: (workspaceId: WorkspaceId, roundId?: string) => Promise<void>;
  /** 等待本范围已准入事件完成正文和索引；启动provider及终态不得越过此屏障。 */
  flushLocalEvents?: (workspaceId: WorkspaceId, threadId?: ThreadId) => Promise<void>;
  /** 从唯一终态owner读取收尾失败，供重连查询展示，不能把失败保持为无限draining。 */
  getTurnFinalizationFailure?: (input: { workspaceId: WorkspaceId; threadId: ThreadId }) => { turnId: TurnId; errorCode: string } | null;
  /** 旧仓储只在短同步许可内访问，回调不得跨越异步副作用。 */
  withDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  /** 控制响应提前返回后，原运行时owner继续持有并消费完整API尾链。 */
  trackApiTail?: (work: Promise<void>, context: { requestId: string; method: string; workspaceId: WorkspaceId | null; threadId: ThreadId | null }) => void;
  /** 发送编排事件到 Server；定时任务等 API 内部启动流程时复用。 */
  emitOrchestration?: (workspaceId: WorkspaceId, event: OrchestrationEventRecord) => void;
  requestShutdown?: (reason?: string) => void;
  onBeforeEmitConversationEvent?: (event: ConversationEventInput) => void;
  takeApiResponseDispatch?: (id: string) => WsSendJsonResult | null;
  /** 运行中输入队列调度器；P0-2 注入。未注入时 resume handler 仅写状态，不触发消费。 */
  queueDispatcher?: ThreadQueueKickAdapter;
  /** Client 定时任务调度器；用于处理 Server 手动运行请求。 */
  scheduledTaskScheduler?: ScheduledTaskScheduler;
  /** 工作区目录迁移独占门禁；工作区写入口必须复用该实例。 */
  workspaceOperationGate?: WorkspaceOperationGate;
  /** Send 路径的幂等 LRU；命中时返回原 turnId 不二次发起。可选注入。 */
  sendIdempotencyCache?: SendIdempotencyCache;
  /** 读取 thread 当前活跃 turn；优先由运行时索引提供，重启恢复时可回退 DB。 */
  getActiveThreadTurn?: (input: { workspaceId?: WorkspaceId | null; threadId: ThreadId; includeDb?: boolean }) => {
    turnId: TurnId;
    startedAt?: number | null;
    source?: "runtime" | "db";
    execution?: TurnExecutionOptionsSnapshot | null;
  } | null;
  /** 标记指定 turn 已终态，用于队列终态后立即消费下一条前清理运行时索引。 */
  clearActiveThreadTurn?: (input: { threadId: ThreadId; turnId: TurnId }) => void;
  /** 回滚读取证据前冲刷 canonical/raw ACK 队列，等待保持在数据库许可外。 */
  flushRollbackEvidence?: () => void | Promise<void>;
  /** 会话删除或历史清理前排空事件与thread touch缓冲，调用方必须等待。 */
  flushEventPersistence?: () => void | Promise<void>;
  /** 按可信W检查原持久化owner失败，失败时禁止继续请求副作用。 */
  assertWorkspacePersistenceAvailable?: (workspaceId: WorkspaceId) => void;
  /** 等待 Server 确认此前上行事件，并返回其全局 seq 高水位。 */
  fenceRollbackEvidence?: (input: { workspaceId: WorkspaceId; threadId: ThreadId; engine: EngineType }) => Promise<number>;
};

type ManagedServiceToolRegistry = NonNullable<ReturnType<OrchestrationEngine["buildManagedServiceToolRegistry"]>>;
type ThreadExecutionProfileContext = {
  scope: WorkspaceExecutionProfileScope;
  userId: string;
};
const ORCH_API_SLOW_MS = 1000;

/** provider mutation 只由 live session/runtime 阻断；DB started 仅供展示、Stop 与启动对账。 */
function hasActiveThreadTurn(ctx: ApiHandlerContext, input: { workspaceId?: WorkspaceId | null; threadId: ThreadId }): boolean {
  if (ctx.sessions.hasActiveTurn(input.threadId)) return true;
  return Boolean(ctx.getActiveThreadTurn?.({ ...input, includeDb: false }));
}

/** 识别删除门禁或旧 runtime 冲突，供 turn 入口统一返回 409。 */
function threadAvailabilityErrorCode(error: unknown): string | null {
  const descriptor = error !== null && (typeof error === "object" || typeof error === "function")
    ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
  const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return code === THREAD_DELETION_IN_PROGRESS_CODE
    || code === THREAD_OPERATION_IN_PROGRESS_CODE
    || code === THREAD_RUNTIME_STALE_CODE
    ? code
    : null;
}

/** 写请求统一解析真实运行 threadId；需求分析请求从 session 绑定反查。 */
function resolveThreadOperationId(ctx: ApiHandlerContext, req: ApiRequestMessage): ThreadId | null {
  if (THREAD_OPERATION_UNTRACKED_METHODS.has(req.method)) return null;
  const threadId = String((req.body as any)?.threadId ?? "").trim();
  if (threadId) return threadId as ThreadId;
  if (!REQUIREMENT_ANALYSIS_THREAD_OPERATION_METHODS.has(req.method)) return null;
  const sessionId = String((req.body as any)?.sessionId ?? "").trim();
  if (!sessionId) return null;
  const session = ctx.db.orchRequirementAnalysisSessions.get(sessionId as any);
  const runtimeThreadId = String(session?.runtimeThreadId ?? session?.id ?? "").trim();
  return runtimeThreadId ? runtimeThreadId as ThreadId : null;
}

type RollbackReconciliationResult = NonNullable<Awaited<ReturnType<typeof reconcileUnresolvedRollbackBeforeMutation>>>;
type RollbackApiResponseMetadata = {
  rollbackReconciled: boolean;
  rollbackEventSeqBarrier: number | null;
};

/** 提取本次自动回滚核对的事件屏障；旧 audit 未持久化该字段时返回 null。 */
function resolveRollbackEventSeqBarrier(...reconciliations: RollbackReconciliationResult[]): number | null {
  let barrier: number | null = null;
  for (const reconciliation of reconciliations) {
    if (reconciliation.kind !== "success") continue;
    const value = reconciliation.recoveryPlan?.rollbackEventSeqBarrier;
    if (value == null) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`自动回滚事件屏障非法：${String(value)}`);
    }
    barrier = Math.max(barrier ?? 0, value);
  }
  return barrier;
}

/** 汇总本次请求已完成的自动回滚信息；barrier 始终保持 pre-commit 高水位。 */
function resolveRollbackApiResponseMetadata(
  ...reconciliations: RollbackReconciliationResult[]
): RollbackApiResponseMetadata {
  return {
    rollbackReconciled: reconciliations.some((reconciliation) => reconciliation.kind === "success"),
    rollbackEventSeqBarrier: resolveRollbackEventSeqBarrier(...reconciliations),
  };
}

/** 合并后续 reconcile 结果，供同一请求的所有响应统一透传。 */
function mergeRollbackApiResponseMetadata(
  target: RollbackApiResponseMetadata,
  ...reconciliations: RollbackReconciliationResult[]
): void {
  const next = resolveRollbackApiResponseMetadata(...reconciliations);
  target.rollbackReconciled ||= next.rollbackReconciled;
  target.rollbackEventSeqBarrier = Math.max(
    target.rollbackEventSeqBarrier ?? 0,
    next.rollbackEventSeqBarrier ?? 0,
  ) || null;
}

/** 装饰当前请求本身，确保处理器和外层异常响应都携带已提交的回滚元数据。 */
function withRollbackApiResponseMetadata(
  ctx: ApiHandlerContext,
  requestId: string,
  metadata: RollbackApiResponseMetadata,
): ApiHandlerContext {
  const send = ctx.send;
  ctx.send = (message) => {
    if (message.t !== "api.res" || message.id !== requestId || !metadata.rollbackReconciled) {
      return send(message);
    }
    if (!message.body || typeof message.body !== "object" || Array.isArray(message.body)) {
      throw new Error(`自动回滚后的 API 响应体必须是对象：requestId=${requestId}`);
    }
    return send({
      ...message,
      body: {
        ...(message.body as Record<string, unknown>),
        rollbackReconciled: true,
        ...(metadata.rollbackEventSeqBarrier != null
          ? { rollbackEventSeqBarrier: metadata.rollbackEventSeqBarrier }
          : {}),
      },
    });
  };
  return ctx;
}

/** 需求分析业务终态只通知一次，通知失败交原执行owner，禁止重写成业务error。 */
function notifyRequirementAnalysisQueueTerminal(
  ctx: ApiHandlerContext,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    outcome: "completed" | "error";
    terminationKind?: "manual_interrupt" | "transient_cleanup" | "error";
    errorCode?: string | null;
  },
): void {
  ctx.queueDispatcher?.notifyTurnTerminal({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      source: "user_send",
      queueItemId: null,
      outcome: input.outcome,
      terminationKind: input.terminationKind,
      errorCode: input.errorCode,
  });
}

const UPDATE_TASK_START_METHODS = new Set([
  "threads.sendMessage", "threads.queue.append", "threads.queue.resume", "threads.compact", "threads.restartCodexAppServer",
  "orch.requirementAnalysis.messages.send", "orch.instances.start", "orch.instances.resume", "orch.instances.rerunFromNode",
  "orch.instances.feedback", "orch.nodes.start", "orch.nodes.skip", "orch.experiments.run.start",
  "knowledge.assets.generate", "knowledge.assets.run.start", "knowledge.assets.update.run",
  "orch.assetDrafts.generate", "orch.assetDraftJobs.resume", "scheduledTasks.runNow", "scheduledTasks.local.runNow",
  "clientDb.cleanup.start", "workspaceDirectoryMigration.prepare", "workspaceDirectoryMigration.prepareStart", "workspaceDirectoryMigration.executeStart",
  "threads.rollback",
]);

/** 副作用前及异步准备后复查；自然意图归一后的动作复用此入口，停止和读取继续。 */
export function rejectPausedTaskAdmission(ctx: ApiHandlerContext, req: ApiRequestMessage): boolean {
  const body = req.body as { action?: unknown; feedbackAction?: unknown } | null;
  const feedback = req.method === "orch.instances.feedback" ? body?.action
    : req.method === "orch.chat.action" && body?.action === "feedback" ? body.feedbackAction : null;
  if (feedback === "cancel" || feedback === "abort") return false;
  const startsTask = UPDATE_TASK_START_METHODS.has(req.method) || req.method === "orch.chat.action"
    && ["start", "resume", "feedback", "confirm_rework", "dismiss"].includes(String((req.body as any)?.action ?? ""));
  if (!startsTask || !ctx.isTaskAdmissionPaused?.()) return false;
  const message = "桌面正在准备更新，暂时不能启动新任务";
  logger.warn("desktop-update", "new task rejected while desktop update owns admission", {
    code: "DESKTOP_UPDATE_TASKS_PAUSED", requestId: req.id, method: req.method,
    workspaceId: String((req.body as any)?.workspaceId ?? "").trim() || null,
    threadId: String((req.body as any)?.threadId ?? "").trim() || null,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null, rootCause: message,
  });
  ctx.onApiFailureLogged?.();
  ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, code: "DESKTOP_UPDATE_TASKS_PAUSED", message } });
  return true;
}

/** 仅停止、故障摘要与已有恢复入口延后检查；业务历史仍须通过持久化屏障。 */
export function isWorkspacePersistenceRecoveryApiRequest(method: string): boolean {
  return method === "turns.interrupt" || method === "threads.summary"
    || method === "threads.rollback" || method === "threads.rollback.preview" || method === "threads.delete";
}

/** 固定已承载 W；历史只读请求不构建写入服务，显式恢复入口可延后持久化检查。 */
export function scopeApiHandlerContext(ctx: ApiHandlerContext, workspaceId: WorkspaceId,
  options?: { deferPersistenceCheck?: boolean; readonly?: boolean }): ApiHandlerContext {
  if (!ctx.workspaces.has(workspaceId)) throw new Error("WORKSPACE_API_SCOPE_NOT_HOSTED");
  if (!options?.deferPersistenceCheck) ctx.assertWorkspacePersistenceAvailable?.(workspaceId);
  return {
    ...ctx,
    db: ctx.db.forWorkspace(workspaceId, { readonly: options?.readonly }),
    ...(!options?.readonly && ctx.orchEngine ? { orchEngine: ctx.orchEngine.forWorkspace(workspaceId) } : {}),
    ...(!options?.readonly && ctx.queueDispatcher?.forWorkspace ? { queueDispatcher: ctx.queueDispatcher.forWorkspace(workspaceId) } : {}),
  };
}

/** 会话目录、分组、历史和过程共用只读路由，包含桌面参数校验阶段。 */
export function isThreadHistoryReadApiRequest(method: string): boolean {
  return method === "threads.list" || method === "threads.groups.list" || method === "threads.load"
    || method === "threads.events" || method === "threads.presentation" || method === "threads.process";
}

/** 只有运行事实消费者需要核心仓储；Profile、Git和文件请求保留各自原owner。 */
export function isWorkspaceCoreApiRequest(method: string): boolean {
  return ["threads.", "turns.", "approvals.", "userInput.", "orch.", "reminders.", "knowledge."].some(prefix => method.startsWith(prefix));
}

export type WorkspaceApiRequestFailureDetails = { code: string; requestId: string; workspaceId: WorkspaceId | null; method: string;
  responseAttempted?: boolean; responseDelivered?: boolean };
type WorkspaceApiRequestFailureSnapshot = WorkspaceApiRequestFailureDetails & { responseAttempted: boolean; responseDelivered: boolean };

/** 原请求的诊断、投递或清理失败；保留原值及发生顺序，不替代业务事实。 */
export class WorkspaceApiRequestFailure extends AggregateError {
  readonly code: string;
  readonly #details: WorkspaceApiRequestFailureSnapshot;

  /** 输入首因同时作为cause；私有品牌供最终owner安全识别，不读取未知getter。 */
  constructor(errors: unknown[], details: WorkspaceApiRequestFailureDetails) {
    super(errors, details.code, { cause: errors[0] });
    this.code = details.code;
    this.#details = { ...details, responseAttempted: details.responseAttempted === true, responseDelivered: details.responseDelivered === true };
  }

  /** 只读自产私有字段，未知对象及Proxy不会触发反射或属性访问。 */
  static details(error: unknown): WorkspaceApiRequestFailureSnapshot | null {
    return error !== null && typeof error === "object" && #details in error ? { ...error.#details } : null;
  }
}

/** 最终消息边界只识别自产聚合，不根据任意异常code猜测已处理状态。 */
export function isWorkspaceApiRequestFailure(error: unknown): error is WorkspaceApiRequestFailure {
  return WorkspaceApiRequestFailure.details(error) !== null;
}

/** 返回不可被外部code/getter替换的安全请求关联，未识别异常返回null。 */
export function getWorkspaceApiRequestFailureDetails(error: unknown): WorkspaceApiRequestFailureSnapshot | null {
  return WorkspaceApiRequestFailure.details(error);
}

/** 仅描述自有data字段；正文只参与指纹，反射失败交调用者与原因一起保留。 */
export function describeWorkspaceApiFailure(error: unknown): { message: string; code?: string; rootCause: Record<string, unknown> } {
  const type = error === null ? "null" : typeof error;
  const own = (key: string): unknown => {
    if (error === null || type !== "object" && type !== "function") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const value = own("message"), rawCode = own("code");
  const text = typeof value === "string" ? value : ["string", "number", "boolean", "undefined", "bigint", "symbol"].includes(type) ? String(error) : "API 请求失败";
  const code = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(rawCode) ? rawCode : undefined;
  return { message: redactClientStartupText(text).slice(0, 1_000), code,
    rootCause: { type, ...(code ? { code } : {}), fingerprint: crypto.createHash("sha256").update(text).digest("hex") } };
}

/** 已核工作区的回合诊断固定落原W；保所有原因，日志失败禁止继续副作用。 */
async function writeWorkspaceTurnLog(
  ctx: ApiHandlerContext, level: "error" | "warn" | "info", tag: string, message: string,
  data: Record<string, unknown> & { workspaceId: WorkspaceId; requestId: string }, original?: { errors: unknown[] },
): Promise<void> {
  try {
    const safeData = { ...data };
    for (const key of ["rootCause", "error", "mismatch"]) {
      if (key in safeData) safeData[key] = describeWorkspaceApiFailure(safeData[key]).rootCause;
    }
    await withApiDatabase(ctx, data.requestId, () => ctx.db.writeWorkspaceLog(data.workspaceId, { level, tag, message, data: { ...safeData,
      event: { category: "ordinary-turn", action: message, outcome: level === "error" ? "fail" : "success" },
      ...(original ? { rootCause: original.errors.map(error => describeWorkspaceApiFailure(error).rootCause) } : {}) } }));
  } catch (failure) { throw new WorkspaceApiRequestFailure(original ? [...original.errors, failure] : [failure], {
    code: "WORKSPACE_API_REQUEST_LOG_FAILED", workspaceId: data.workspaceId, requestId: data.requestId,
    method: typeof data.method === "string" ? data.method : "threads.sendMessage",
    responseAttempted: data.responseAttempted === true, responseDelivered: data.responseDelivered === true,
  }); }
}

/** 旧仓储仅在同步短段准入；调用者不得将provider或网络Promise放入回调。 */
async function withApiDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : operation();
}

/** 分发白名单API；可信本机精确停止先走控制入口，其他请求先验数据库归属，异常由原finally收口。 */
export async function handleApiRequest(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  /** 只包纯同步数据库段，provider/网络等待必须在许可外。 */
  const database = <T>(operation: () => T): Promise<T> => withApiDatabase(ctx, req.id, operation);
  if (req.method !== "turns.interrupt" && await database(() => rejectPausedTaskAdmission(ctx, req))) return;
  const requestedWorkspace = String((req.body as { workspaceId?: unknown } | null)?.workspaceId ?? "").trim() as WorkspaceId;
  let diagnosticWorkspace = ctx.workspaces.has(requestedWorkspace) ? requestedWorkspace : null;
  if (["fs.uploadChunk", "fs.uploadComplete", "fs.uploadCancel"].includes(req.method)) {
    const uploadPath = getUploadWorkspacePath(String((req.body as { uploadId?: unknown } | null)?.uploadId ?? ""));
    diagnosticWorkspace = Array.from(ctx.workspaces).find(([, workspacePath]) => workspacePath === uploadPath)?.[0] ?? null;
  }
  const requestDetails = { requestId: req.id, workspaceId: diagnosticWorkspace, method: req.method };
  const writeWorkspaceLog = ctx.db.writeWorkspaceLog.bind(ctx.db), send = ctx.send, markFailureLogged = ctx.onApiFailureLogged;
  let failureLogged = false, responseAttempted = false, responseDelivered = false;
  const requestState: { failure: { error: unknown } | null } = { failure: null };
  /** 错误创建时冻结响应事实，最终owner不可再次发送已经尝试过的响应。 */
  const failureDetails = (code: string): WorkspaceApiRequestFailureDetails => ({ ...requestDetails, code, responseAttempted, responseDelivered });
  /** 诊断先完成再标记，固定W写失败不得补应用同条或继续发送响应。 */
  const diagnostic = async (level: "debug" | "warn" | "error", tag: string, message: string, data: Record<string, unknown>, original?: { error: unknown }): Promise<void> => {
    try {
      if (diagnosticWorkspace) await database(() => writeWorkspaceLog(diagnosticWorkspace!, { level, tag, message, data: { ...data, ...requestDetails } }));
      else logger[level](tag, message, { ...data, ...requestDetails });
    } catch (failure) {
      throw new WorkspaceApiRequestFailure(original ? [original.error, failure] : [failure], failureDetails("WORKSPACE_API_REQUEST_LOG_FAILED"));
    }
  };
  ctx = { ...ctx,
    /** 沿原单次标记传递已落盘事实；失败的诊断不设置标记。 */
    onApiFailureLogged() { failureLogged = true; markFailureLogged?.(); },
    /** 一个请求只尝试一次响应；已提交副作用不因投递失败再执行或改送失败。 */
    send(message) {
      if (message.t !== "api.res" || message.id !== req.id) return send(message);
      if (responseAttempted) throw new WorkspaceApiRequestFailure([new Error("API_RESPONSE_ALREADY_ATTEMPTED")], failureDetails("WORKSPACE_API_RESPONSE_REPEATED"));
      responseAttempted = true;
      const dispatched = send(message);
      if (dispatched?.accepted === false) throw dispatched;
      responseDelivered = true;
      return dispatched;
    },
  };
  const startedAt = Date.now();
  if (isOrchMethod(req.method) && shouldTraceOrchApi()) {
    await diagnostic("debug", "orch-api", "received api.req", {
      id: req.id,
      method: req.method,
      workspaceId: String((req.body as any)?.workspaceId ?? "").trim() || null,
    });
  }
  const dispatch = async (): Promise<void> => {
    if (req.method === "engines.status") return await handleEnginesStatus(ctx, req);
    if (req.method === "workspaces.list") return await database(() => handleWorkspacesList(ctx, req));
    if (req.method === "workspaces.upsert") return await handleWorkspacesUpsert(ctx, req);
    if (req.method === "workspaces.delete") return await handleWorkspacesDelete(ctx, req);
    if (req.method === "workspaceDirectoryMigration.prepare") return await handleWorkspaceMigrationPrepare(ctx, req);
    if (req.method === "workspaceDirectoryMigration.get") return await database(() => handleWorkspaceMigrationGet(ctx, req));
    if (req.method === "workspaceDirectoryMigration.prepareStart") return await database(() => handleWorkspaceMigrationPrepareStart(ctx, req));
    if (req.method === "workspaceDirectoryMigration.executeStart") return await database(() => handleWorkspaceMigrationExecuteStart(ctx, req));
    if (req.method === "workspaceDirectoryMigration.fenceStart") return await database(() => handleWorkspaceMigrationFenceStart(ctx, req));
    if (req.method === "workspaceDirectoryMigration.cancel") return await handleWorkspaceMigrationCancel(ctx, req);
    if (req.method === "workspaceDirectoryMigration.recover") return await handleWorkspaceMigrationRecover(ctx, req);
    if (req.method === "workspaceExecutionProfile.get") return await database(() => handleWorkspaceExecutionProfileGet(ctx, req));
    if (req.method === "workspaceExecutionProfile.update") return await database(() => handleWorkspaceExecutionProfileUpdate(ctx, req));
    if (req.method === "workspaceExecutionProfile.status") return await database(() => handleWorkspaceExecutionProfileStatus(ctx, req));
    if (req.method === "approvals.respond") return await handleApprovalsRespond(ctx, req);
    if (req.method === "userInput.respond") return await handleUserInputRespond(ctx, req);
    if (req.method === "codeflowai.config.get") return await database(() => handleCodeflowaiConfigGet(ctx, req));
    if (req.method === "codeflowai.config.set") return await handleCodeflowaiConfigSet(ctx, req);
    if (req.method === "engines.config.get") return await database(() => handleEnginesConfigGet(ctx, req));
    if (req.method === "engines.config.set") return await handleEnginesConfigSet(ctx, req);
    if (req.method === "engineKeys.list") return await database(() => handleEngineKeysList(ctx, req));
    if (req.method === "engineKeys.upsert") return await handleEngineKeysUpsert(ctx, req);
    if (req.method === "engineKeys.delete") return await handleEngineKeysDelete(ctx, req);
    if (req.method === "engineKeys.activate") return await handleEngineKeysActivate(ctx, req);
    if (req.method === "engineKeys.deactivate") return await handleEngineKeysDeactivate(ctx, req);
    if (req.method === "engineKeys.test") return await handleEngineKeysTest(ctx, req);
    if (req.method === "engineCustomModels.list") return await database(() => handleEngineCustomModelsList(ctx, req));
    if (req.method === "engineCustomModels.upsert") return await database(() => handleEngineCustomModelsUpsert(ctx, req));
    if (req.method === "engineCustomModels.delete") return await database(() => handleEngineCustomModelsDelete(ctx, req));
    if (req.method === "skills.suites") return await handleSkillsSuites(ctx, req);
    if (req.method === "skills.install") return await handleSkillsInstall(ctx, req);
    if (req.method === "skills.uninstall") return await handleSkillsUninstall(ctx, req);
    if (req.method === "mcp.install") return await handleMcpInstall(ctx, req);
    if (req.method === "mcp.enable") return await handleMcpEnable(ctx, req);
    if (req.method === "mcp.update") return await handleMcpUpdate(ctx, req);
    if (req.method === "mcp.test") return await handleMcpTest(ctx, req);
    if (req.method === "mcp.import") return await handleMcpImport(ctx, req);
    if (req.method === "mcp.uninstall") return await handleMcpUninstall(ctx, req);
    if (req.method === "mcp.configure") return await handleMcpConfigure(ctx, req);
    if (req.method === "mcp.unconfigure") return await handleMcpUnconfigure(ctx, req);
    if (req.method === "software.update.status") return await handleSoftwareUpdateStatus(ctx, req);
    if (req.method === "software.npm.install") return await handleNpmInstall(ctx, req);
    if (req.method === "client.exit") return await handleClientExit(ctx, req);
    if (req.method === "client.upgrade") return await handleClientUpgrade(ctx, req);
    if (req.method === "client.logs.files") return await database(() => handleClientLogsFiles(ctx, req));
    if (req.method === "client.logs.tail") return await database(() => handleClientLogsTail(ctx, req));
    if (req.method === "client.logs.download") return await database(() => handleClientLogsDownload(ctx, req));
    if (req.method.startsWith("scheduledTasks.local.")) return await handleLocalScheduledTaskRequest(ctx, req);
    if (req.method.startsWith("scheduledTasks.account.")) return await handleAccountScheduledTaskConfigRequest(ctx, req);
    if (req.method === "scheduledTasks.runNow") return await handleScheduledTaskRunNow(ctx, req);
    if (req.method === "threads.create") return await database(() => handleThreadsCreate(ctx, req));
    if (req.method === "threads.list") return await database(() => handleThreadsList(ctx, req));
    if (req.method === "threads.groups.list") return await database(() => handleThreadGroupsList(ctx, req));
    if (req.method === "threads.groups.create") return await database(() => handleThreadGroupsCreate(ctx, req));
    if (req.method === "threads.groups.rename") return await database(() => handleThreadGroupsRename(ctx, req));
    if (req.method === "threads.groups.delete") return await database(() => handleThreadGroupsDelete(ctx, req));
    if (req.method === "threads.group.assign") return await database(() => handleThreadGroupAssign(ctx, req));
    if (req.method === "threads.summary") return await database(() => handleThreadsSummary(ctx, req));
    if (req.method === "threads.load") return await handleThreadsLoad(ctx, req);
    if (req.method === "threads.presentation" || req.method === "threads.process") return await handleThreadsPresentation(ctx, req);
    if (req.method === "threads.messages.delete") return await handleThreadMessageDelete(ctx, req);
    if (req.method === "threads.prefs") return await database(() => handleThreadsPrefs(ctx, req));
    if (req.method === "threads.draft.get") return await database(() => handleThreadsDraftGet(ctx, req));
    if (req.method === "threads.draft.save") return await database(() => handleThreadsDraftSave(ctx, req));
    if (req.method === "threads.draft.clear") return await database(() => handleThreadsDraftClear(ctx, req));
    if (req.method === "threads.inputActions.list") return await onThreadsInputActionsList(ctx, req);
    if (req.method === "threads.queue.append") return await onThreadQueueAppend(ctx, req);
    if (req.method === "threads.queue.list") return await onThreadQueueList(ctx, req);
    if (req.method === "threads.queue.move") return await onThreadQueueMove(ctx, req);
    if (req.method === "threads.queue.remove") return await onThreadQueueRemove(ctx, req);
    if (req.method === "threads.queue.clear") return await onThreadQueueClear(ctx, req);
    if (req.method === "threads.queue.resume") return await onThreadQueueResume(ctx, req);
    if (req.method === "threads.queue.pause") return await onThreadQueuePause(ctx, req);
    if (req.method === "threads.events") return await database(() => handleThreadsEvents(ctx, req));
    if (req.method === "threads.managedServices.list") return await database(() => handleThreadsManagedServicesList(ctx, req));
    if (req.method === "threads.managedServices.stop") return await handleThreadsManagedServicesStop(ctx, req);
    if (req.method === "threads.restartCodexAppServer") return await handleThreadsRestartCodexAppServer(ctx, req);
    if (req.method === "threads.rename") return await database(() => handleThreadsRename(ctx, req));
    if (req.method === "threads.archive") return await database(() => handleThreadsArchive(ctx, req));
    if (req.method === "threads.pin") return await database(() => handleThreadsPin(ctx, req));
    if (req.method === "threads.delete") return await handleThreadsDelete(ctx, req);
    if (req.method === "threads.clear") return await handleThreadsClear(ctx, req);
    if (req.method === "threads.compact") return await onThreadsCompact(ctx, req);
    if (req.method === "threads.updatePrefs") return await handleThreadsUpdatePrefs(ctx, req);
    if (req.method === "threads.latestPrefs") return await database(() => handleThreadsLatestPrefs(ctx, req));
    if (req.method === "clientDb.cleanup.status") return await handleClientDbCleanupStatus(ctx, req);
    if (req.method === "clientDb.cleanup.start") return await handleClientDbCleanupStart(ctx, req);
    if (req.method === "reminders.workspaceSummaries") return await database(() => handleReminderWorkspaceSummaries(ctx, req));
    if (req.method === "reminders.items") return await database(() => handleReminderItemsList(ctx, req));
    if (req.method === "reminders.markRead") return await database(() => handleReminderMarkRead(ctx, req));
    if (req.method === "reminders.ignore") return await database(() => handleReminderIgnoreItems(ctx, req));
    if (req.method === "reminders.metricReviews.scan") return await database(() => handleReminderMetricReviewScan(ctx, req));
    if (req.method === "threads.sendMessage") return await onThreadsSendMessage(ctx, req);
    if (req.method === "threads.fileChanges.list") return await database(() => handleThreadsFileChangesList(ctx, req));
    if (req.method === "threads.fileChanges.diff") return await database(() => handleThreadsFileChangesDiff(ctx, req));
    if (req.method === "threads.fileChanges.accept") return await database(() => handleThreadsFileChangesAccept(ctx, req));
    if (req.method === "threads.fileChanges.undo") return await database(() => handleThreadsFileChangesUndo(ctx, req));
    if (req.method === "threads.rollback") return await handleThreadsRollback(ctx, req);
    if (req.method === "threads.rollback.preview") return await handleThreadsRollbackPreview(ctx, req);
    if (req.method === "turns.interrupt") return await onTurnsInterrupt(ctx, req);
    if (req.method === "terminal.shells.list") return await handleTerminalShellsList(ctx, req);
    if (req.method === "terminal.actions.list") return await database(() => handleTerminalActionsList(ctx, req));
    if (req.method === "terminal.actions.save") return await database(() => handleTerminalActionsSave(ctx, req));
    if (req.method === "workspacePrefs.get") return await database(() => handleWorkspacePrefsGet(ctx, req));
    if (req.method === "workspacePrefs.save") return await database(() => handleWorkspacePrefsSave(ctx, req));
    if (req.method.startsWith("knowledge.assets.")) return handleKnowledgeAssetRequest(ctx, req);
    if (req.method === "orch.intakes.list") return await handleOrchIntakesList(ctx, req);
    if (req.method === "orch.intakes.create") return await database(() => handleOrchIntakesCreate(ctx, req));
    if (req.method === "orch.intakes.delete") return await handleOrchIntakesDelete(ctx, req);
    if (req.method === "orch.intakes.upsert") return await database(() => handleOrchIntakesUpsert(ctx, req));
    if (req.method === "orch.pendingMine.list") return await database(() => handleOrchPendingMineList(ctx, req));
    if (req.method === "orch.requirementAnalysis.sessions.list") return await database(() => handleOrchRequirementAnalysisSessionsList(ctx, req));
    if (req.method === "orch.requirementAnalysis.sessions.create") return await database(() => handleOrchRequirementAnalysisSessionsCreate(ctx, req));
    if (req.method === "orch.requirementAnalysis.sessions.get") return await database(() => handleOrchRequirementAnalysisSessionsGet(ctx, req));
    if (req.method === "orch.requirementAnalysis.sessions.archive") return await database(() => handleOrchRequirementAnalysisSessionsArchive(ctx, req));
    if (req.method === "orch.requirementAnalysis.messages.send") return await handleOrchRequirementAnalysisMessagesSend(ctx, req);
    if (req.method === "orch.requirementAnalysis.createIntakes") return await database(() => handleOrchRequirementAnalysisCreateIntakes(ctx, req));
    if (req.method === "orch.assetDrafts.generate") return await handleOrchAssetDraftsGenerate(ctx, req);
    if (req.method === "orch.assetDraftJobs.list") return await database(() => handleOrchAssetDraftJobsList(ctx, req));
    if (req.method === "orch.assetDraftJobs.get") return await database(() => handleOrchAssetDraftJobsGet(ctx, req));
    if (req.method === "orch.assetDraftJobs.delete") return await handleOrchAssetDraftJobsDelete(ctx, req);
    if (req.method === "orch.assetDraftJobs.resume") return await handleOrchAssetDraftJobsResume(ctx, req);
    if (req.method === "orch.assetDrafts.get") return await database(() => handleOrchAssetDraftsGet(ctx, req));
    if (req.method === "orch.assetDrafts.apply") return await database(() => handleOrchAssetDraftsApply(ctx, req));
    if (req.method === "orch.assetDrafts.reject") return await database(() => handleOrchAssetDraftsReject(ctx, req));
    if (req.method === "orch.assetBundles.export") return await database(() => handleOrchAssetBundlesExport(ctx, req));
    if (req.method === "orch.assetBundles.import") return await database(() => handleOrchAssetBundlesImport(ctx, req));
    if (req.method === "orch.assets.copy") return database(() => handleOrchAssetsCopy(ctx, req));
    if (req.method === "orch.assetGroups.list") return await database(() => handleOrchAssetGroupsList(ctx, req));
    if (req.method === "orch.assetGroups.create") return await database(() => handleOrchAssetGroupsCreate(ctx, req));
    if (req.method === "orch.assetGroups.rename") return await database(() => handleOrchAssetGroupsRename(ctx, req));
    if (req.method === "orch.assetGroups.delete") return await database(() => handleOrchAssetGroupsDelete(ctx, req));
    if (req.method === "orch.assetGroups.assign") return await database(() => handleOrchAssetGroupsAssign(ctx, req));
    if (req.method === "orch.roles.list") return await database(() => handleOrchRolesList(ctx, req));
    if (req.method === "orch.roles.upsert") return await database(() => handleOrchRolesUpsert(ctx, req));
    if (req.method === "orch.roles.delete") return await database(() => handleOrchRolesDelete(ctx, req));
    if (req.method === "orch.workflows.list") return await database(() => handleOrchWorkflowsList(ctx, req));
    if (req.method === "orch.workflows.upsert") return await database(() => handleOrchWorkflowsUpsert(ctx, req));
    if (req.method === "orch.workflows.delete") return await database(() => handleOrchWorkflowsDelete(ctx, req));
    if (req.method === "orch.assigneeTemplates.list") return await database(() => handleOrchAssigneeTemplatesList(ctx, req));
    if (req.method === "orch.assigneeTemplates.upsert") return await database(() => handleOrchAssigneeTemplatesUpsert(ctx, req));
    if (req.method === "orch.assigneeTemplates.delete") return await database(() => handleOrchAssigneeTemplatesDelete(ctx, req));
    if (req.method === "orch.workflowExecutionDefaults.get") return await database(() => handleOrchWorkflowExecutionDefaultsGet(ctx, req));
    if (req.method === "orch.workflowExecutionDefaults.upsert") return await database(() => handleOrchWorkflowExecutionDefaultsUpsert(ctx, req));
    if (req.method === "orch.workflowExecutionDefaults.delete") return await database(() => handleOrchWorkflowExecutionDefaultsDelete(ctx, req));
    if (req.method === "orch.toolsets.list") return await database(() => handleOrchToolsetsList(ctx, req));
    if (req.method === "orch.toolsets.upsert") return await database(() => handleOrchToolsetsUpsert(ctx, req));
    if (req.method === "orch.toolsets.delete") return await database(() => handleOrchToolsetsDelete(ctx, req));
    if (req.method === "orch.skills.list") return await database(() => handleOrchSkillsList(ctx, req));
    if (req.method === "orch.skills.upsert") return await database(() => handleOrchSkillsUpsert(ctx, req));
    if (req.method === "orch.skills.delete") return await database(() => handleOrchSkillsDelete(ctx, req));
    if (req.method === "orch.skills.installStatus") return await database(() => handleOrchSkillsInstallStatus(ctx, req));
    if (req.method === "orch.skills.install") return await handleOrchSkillsInstall(ctx, req);
    if (req.method === "orch.skills.uninstall") return await handleOrchSkillsUninstall(ctx, req);
    if (req.method === "orch.knowledgeBundles.list") return await database(() => handleOrchKnowledgeBundlesList(ctx, req));
    if (req.method === "orch.knowledgeBundles.upsert") return await database(() => handleOrchKnowledgeBundlesUpsert(ctx, req));
    if (req.method === "orch.knowledgeBundles.delete") return await handleOrchKnowledgeBundlesDelete(ctx, req);
    if (req.method === "orch.proposals.list") return await database(() => handleOrchProposalsList(ctx, req));
    if (req.method === "orch.proposals.get") return await database(() => handleOrchProposalsGet(ctx, req));
    if (req.method === "orch.proposals.create") return await database(() => handleOrchProposalsCreate(ctx, req));
    if (req.method === "orch.proposals.confirm") return await database(() => handleOrchProposalsConfirm(ctx, req));
    if (req.method.startsWith("orch.chat.")) return await handleChatWorkflowRequest(ctx, req);
    if (req.method === "orch.instances.list") return await database(() => handleOrchInstancesList(ctx, req));
    if (req.method === "orch.instances.get") return await database(() => handleOrchInstancesGet(ctx, req));
    if (req.method === "orch.instances.runtimePatch") return await database(() => handleOrchInstancesRuntimePatch(ctx, req));
    if (req.method === "orch.instances.reassignNode") return await database(() => handleOrchInstancesReassignNode(ctx, req));
    if (req.method === "orch.artifacts.list") return await database(() => handleOrchArtifactsList(ctx, req));
    if (req.method === "orch.artifacts.get") return await database(() => handleOrchArtifactGet(ctx, req));
    if (req.method === "orch.artifactFiles.list") return await database(() => handleOrchArtifactFilesList(ctx, req));
    if (req.method === "orch.artifacts.revise") return await handleOrchArtifactRevise(ctx, req);
    if (req.method === "orch.events.list") return await database(() => handleOrchEventsList(ctx, req));
    if (req.method === "orch.nodeWorkItems.list") return await database(() => handleOrchNodeWorkItemsList(ctx, req));
    if (req.method === "orch.nodeWorkItemEvents.list") return await database(() => handleOrchNodeWorkItemEventsList(ctx, req));
    if (req.method === "orch.runtimeEvidence.get") return await database(() => handleOrchRuntimeEvidenceGet(ctx, req));
    if (req.method === "orch.promptSnapshots.list") return await database(() => handleOrchPromptSnapshotsList(ctx, req));
    if (req.method === "orch.promptSnapshots.get") return await database(() => handleOrchPromptSnapshotGet(ctx, req));
    if (req.method === "orch.instances.start") return await handleOrchInstancesStart(ctx, req);
    if (req.method === "orch.instances.pause") return await handleOrchInstancesPause(ctx, req);
    if (req.method === "orch.instances.resume") return await handleOrchInstancesResume(ctx, req);
    if (req.method === "orch.instances.cancel") return await handleOrchInstancesCancel(ctx, req);
    if (req.method === "orch.nodes.start") return await handleOrchNodesStart(ctx, req);
    if (req.method === "orch.nodes.skip") return await handleOrchNodesSkip(ctx, req);
    if (req.method === "orch.nodes.cancel") return await handleOrchNodesCancel(ctx, req);
    if (req.method === "orch.instances.feedback") return await handleOrchInstancesFeedback(ctx, req);
    if (req.method === "orch.instances.rerunFromNode") return await handleOrchInstancesRerunFromNode(ctx, req);
    if (req.method === "orch.instances.discussionThread.ensure") return await database(() => handleOrchInstancesEnsureDiscussionThread(ctx, req));
    if (req.method === "orch.metrics.collect") {
      if ((req.body as { syncCodeAttribution?: boolean } | null)?.syncCodeAttribution === true) return await handleOrchMetricsCollect(ctx, req);
      await ctx.flushLocalEvents?.(requestedWorkspace);
      return await database(() => handleOrchMetricsCollect(ctx, req));
    }
    if (req.method === "orch.experiments.freeze") return await handleControlledExperimentFreeze(ctx, req);
    if (req.method === "orch.experiments.run.start") return await handleControlledExperimentRunStart(ctx, req);
    if (req.method === "orch.experiments.run.status") return await handleControlledExperimentRunStatus(ctx, req);
    if (req.method === "orch.experiments.run.cancel") return await handleControlledExperimentRunCancel(ctx, req);
    if (req.method === "fs.tree") return await handleFsTree(ctx, req);
    if (req.method === "fs.search") return await database(() => handleFsSearch(ctx, req));
    if (req.method === "fs.reindex") return await handleFsReindex(ctx, req);
    if (req.method === "fs.readFile") return await handleFsReadFile(ctx, req);
    if (req.method === "fs.downloadFile") return await database(() => handleFsDownloadFile(ctx, req));
    if (req.method === "fs.uploadBegin") return await database(() => handleFsUploadBegin(ctx, req));
    if (req.method === "fs.uploadChunk") return await database(() => handleFsUploadChunk(ctx, req));
    if (req.method === "fs.uploadComplete") return await database(() => handleFsUploadComplete(ctx, req));
    if (req.method === "fs.uploadCancel") return await database(() => handleFsUploadCancel(ctx, req));
    if (req.method === "fs.downloadStat") return await database(() => handleFsDownloadStat(ctx, req));
    if (req.method === "fs.downloadChunk") return await database(() => handleFsDownloadChunk(ctx, req));
    if (req.method === "fs.spreadsheetPreview") return await database(() => handleFsSpreadsheetPreview(ctx, req));
    if (req.method === "fs.documentPreview") return await database(() => handleFsDocumentPreview(ctx, req));
    if (req.method === "fs.extractAttachment") return await handleFsExtractAttachment(ctx, req);
    if (req.method === "fs.stat") return await database(() => handleFsStat(ctx, req));
    if (req.method === "clientFs.directoryTree") return await handleClientDirectoryTree(ctx, req);
    if (req.method === "git.status") return await handleGitStatus(ctx, req);
    if (req.method === "git.diff") return await handleGitDiff(ctx, req);
    if (req.method === "git.diffFiles") return await handleGitDiffFiles(ctx, req);
    if (req.method === "git.stage") return await handleGitStage(ctx, req);
    if (req.method === "git.unstage") return await handleGitUnstage(ctx, req);
    if (req.method === "git.discard") return await handleGitDiscard(ctx, req);
    if (req.method === "git.commit") return await handleGitCommit(ctx, req);
    if (req.method === "git.codeAttribution.collect") return await handleGitCodeAttributionCollect(ctx, req);
    if (req.method === "git.log") return await handleGitLog(ctx, req);
    if (req.method === "git.show") return await handleGitShow(ctx, req);
    if (req.method === "git.showFileDiff") return await handleGitShowFileDiff(ctx, req);
    if (req.method === "git.branch.list") return await handleGitBranchList(ctx, req);
    if (req.method === "git.branch.create") return await handleGitBranchCreate(ctx, req);
    if (req.method === "git.branch.switch") return await handleGitBranchSwitch(ctx, req);
    if (req.method === "git.branch.delete") return await handleGitBranchDelete(ctx, req);
    logger.warn("client-api", "unknown api.req method", {
      id: req.id,
      method: req.method,
      path: req.path,
      workspaceId: String((req.body as any)?.workspaceId ?? "").trim() || null,
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 404,
      body: { ok: false, code: "UNKNOWN_METHOD", method: req.method, message: "未知方法" },
    });
  };

  let finishThreadOperation = (): void => {};
  let finishWorkspaceWrite = (): void => {};
  try {
    if (req.method === "turns.interrupt" && ctx.localWorkspaceOnly === true
      && canInterruptRuntimeTurnWithoutDatabase(ctx, (req.body ?? {}) as Record<string, unknown>)) {
      finishThreadOperation = ctx.sessions.beginThreadOperation((req.body as { threadId: ThreadId }).threadId);
      await dispatch();
      return;
    }
    if (ctx.workspaces.has(requestedWorkspace) && isWorkspaceCoreApiRequest(req.method)) {
      ctx = await database(() => scopeApiHandlerContext(ctx, requestedWorkspace, {
        deferPersistenceCheck: isWorkspacePersistenceRecoveryApiRequest(req.method),
        readonly: isThreadHistoryReadApiRequest(req.method),
      }));
    }
    // 仅已有线程方法先验权威；创建中的可信 threadId 尚未持久化。
    const existingThreadRequest = req.method.startsWith("threads.") && req.method !== "threads.create"
      || req.method === "turns.interrupt" || req.method === "approvals.respond" || req.method === "userInput.respond";
    if (ctx.localWorkspaceOnly === true && existingThreadRequest && (req.body as { threadId?: unknown } | null)?.threadId != null) {
      const threadId = String((req.body as { threadId: unknown }).threadId) as ThreadId;
      const localThread = await database(() => {
        // 标记保留原物理域，允许删除重试进入唯一状态处理入口。
        const deletion = req.method === "threads.delete" ? ctx.db.threads.getDeletion(threadId) : null;
        return deletion?.workspaceId === requestedWorkspace && deletion.sharedWorkspaceId === null
          || isDesktopLocalThreadAssetExecution(ctx.clientId, ctx.workspaces, ctx.db, threadId);
      });
      if (!localThread) {
        ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "本机本地会话不存在" } });
        return;
      }
    }
    const writeWorkspaceId = resolveWorkspaceMigrationWriteId(req);
    if (writeWorkspaceId) finishWorkspaceWrite = ctx.workspaceOperationGate?.beginWrite(writeWorkspaceId) ?? (() => {});
    const operationThreadId = await database(() => resolveThreadOperationId(ctx, req));
    if (operationThreadId) finishThreadOperation = ctx.sessions.beginThreadOperation(operationThreadId);
    if (await database(() => rejectPausedTaskAdmission(ctx, req))) return;
    await dispatch();
    const responseDispatch = ctx.takeApiResponseDispatch?.(req.id) ?? null;
    if (isOrchMethod(req.method)) {
      const ms = Date.now() - startedAt;
      const payload = {
        id: req.id,
        method: req.method,
        workspaceId: String((req.body as any)?.workspaceId ?? "").trim() || null,
        ms,
        apiResponseDispatch: summarizeWsSendResult(responseDispatch),
      };
      if (responseDispatch?.accepted === false) {
        throw new WorkspaceApiRequestFailure([responseDispatch], failureDetails("WORKSPACE_API_RESPONSE_FAILED"));
      } else if (ms >= ORCH_API_SLOW_MS) {
        await diagnostic("warn", "orch-api", "handled slow api.req", payload);
      } else if (shouldTraceOrchApi()) {
        await diagnostic("debug", "orch-api", "handled api.req", payload);
      }
    }
  } catch (e) {
    requestState.failure = { error: e };
    try {
    if (isEngineWorkspaceLogFailure(e)) throw new WorkspaceApiRequestFailure([e], failureDetails("WORKSPACE_API_REQUEST_LOG_FAILED"));
    if (isWorkspaceApiRequestFailure(e)) {
      const details = getWorkspaceApiRequestFailureDetails(e)!;
      if (details.code.startsWith("WORKSPACE_API_RESPONSE_")) {
        await diagnostic("error", "api", "API response delivery failed", { errorCode: details.code,
          event: { category: "api", action: req.method, outcome: "fail" }, rootCause: describeWorkspaceApiFailure(e).rootCause }, { error: e });
        ctx.onApiFailureLogged?.();
      }
      throw e;
    }
    if ((req.method === "workspacePrefs.get" || req.method === "workspacePrefs.save")
      && e instanceof AggregateError && (e as { code?: unknown }).code === "WORKSPACE_PREFS_FAILURE_LOG_FAILED") throw e;
    // 仅可信桌面本机任务已知日志双错交原请求 owner 保全两因。
    if (ctx.localWorkspaceOnly === true && (req.method.startsWith("scheduledTasks.local.") || req.method.startsWith("scheduledTasks.account.")) && e instanceof AggregateError) {
      const code = Object.getOwnPropertyDescriptor(e, "code");
      if (code && "value" in code && ["SCHEDULED_TASK_REQUEST_LOG_FAILED", "SCHEDULED_TASK_TRANSACTION_LOG_FAILED", "SCHEDULED_TASK_EXECUTION_LOG_FAILED"].includes(code.value)) throw e;
    }
    // 仅可信桌面三读取的已知日志/响应聚合交原请求 owner 保因。
    if (ctx.localWorkspaceOnly === true && ["git.status", "git.diff", "git.diffFiles"].includes(req.method) && e instanceof AggregateError) {
      const code = Object.getOwnPropertyDescriptor(e, "code");
      if (code && "value" in code && ["GIT_STATUS_METADATA_LOG_FAILED", "GIT_READ_REQUEST_LOG_FAILED", "GIT_READ_RESPONSE_FAILED"].includes(code.value)) throw e;
    }
    let description: ReturnType<typeof describeWorkspaceApiFailure>;
    try { description = describeWorkspaceApiFailure(e); }
    catch (failure) { throw new WorkspaceApiRequestFailure([e, failure], failureDetails("WORKSPACE_API_REQUEST_LOG_FAILED")); }
    const message = description.message;
    const projectionError = e instanceof OrchInstanceSummaryProjectionError ? e : null;
    const intakeError = e instanceof OrchIntakeRepoError ? e : null;
    const frozenScopeError = e instanceof OrchProposalScopeError || e instanceof OrchInstanceScopeError ? e : null;
    const requirementAnalysisError = e instanceof OrchRequirementAnalysisSessionRepoError || e instanceof RequirementAnalysisServiceError ? e : null;
    const requirementAnalysisScopeConflict = requirementAnalysisError?.code === "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT";
    const workspaceId = String(
      frozenScopeError?.details.workspaceId
      ?? requirementAnalysisError?.details.workspaceId
      ?? (req.body as any)?.workspaceId
      ?? projectionError?.details.workspaceId
      ?? intakeError?.details?.workspaceId
      ?? "",
    ).trim() || null;
    if (req.method.startsWith("workspaceExecutionProfile.") && !(e instanceof WorkspaceOperationGateError)) {
      // 整个 Profile 请求仍由此处记录；固定日志失败保留原业务错且不发送伪响应。
      try {
        const code = String((e as { code?: unknown })?.code ?? "WORKSPACE_EXECUTION_PROFILE_REQUEST_FAILED");
        await database(() => ctx.db.writeWorkspaceLog(workspaceId as WorkspaceId, { level: "error", tag: "workspace-profile", message: "workspace Profile request failed", data: {
        code, errorCode: code, event: { category: "workspace-profile", action: req.method, outcome: "fail" },
        requestId: req.id, method: req.method, workspaceId,
        userId: String((req.body as any)?.userId ?? "").trim() || null,
        scopeType: (req.body as any)?.profileScopeType ?? null,
        scopeId: (req.body as any)?.profileScopeId ?? workspaceId,
        rootCause: describeWorkspaceProfileFailure(e),
      } })); } catch (logError) { throw new WorkspaceApiRequestFailure([e, logError], failureDetails("WORKSPACE_PROFILE_FAILURE_LOG_FAILED")); }
      ctx.onApiFailureLogged?.();
    }
    if (!failureLogged && req.method.startsWith("mcp.")) {
      await diagnostic("error", "mcp", "MCP API 请求异常", {
        event: { category: "mcp", action: req.method, outcome: "fail" },
        requestId: req.id,
        method: req.method,
        workspaceId,
        mcpId: String((req.body as any)?.mcpId ?? "").trim() || null,
        instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
        errorCode: description.code ?? "MCP_API_REQUEST_FAILED",
        rootCause: description.rootCause,
      }, { error: e });
      ctx.onApiFailureLogged?.();
    }
    if (!failureLogged && !(e instanceof WorkspaceOperationGateError) && (isOrchMethod(req.method) || requirementAnalysisError || frozenScopeError)) {
      await diagnostic("error", "orch-api", "failed api.req", {
        id: req.id,
        requestId: req.id,
        event: { category: "orch-api", action: req.method, outcome: "fail" },
        code: frozenScopeError?.code ?? requirementAnalysisError?.code ?? intakeError?.code ?? projectionError?.code ?? (req.method.startsWith("reminders.") ? "REMINDER_API_REQUEST_FAILED" : "ORCH_API_REQUEST_FAILED"),
        errorCode: frozenScopeError?.code ?? requirementAnalysisError?.code ?? intakeError?.code ?? projectionError?.code ?? (req.method.startsWith("reminders.") ? "REMINDER_API_REQUEST_FAILED" : "ORCH_API_REQUEST_FAILED"),
        ...(frozenScopeError ? { field: frozenScopeError.details.field, reason: frozenScopeError.details.reason,
          ...(frozenScopeError instanceof OrchProposalScopeError ? { proposalId: frozenScopeError.details.proposalId } : {}) } : {}),
        ...(requirementAnalysisError ? { sessionId: requirementAnalysisError.details.sessionId } : {}),
        method: req.method,
        workspaceId,
        intakeId: frozenScopeError ? frozenScopeError instanceof OrchProposalScopeError ? frozenScopeError.details.intakeId : null : requirementAnalysisError ? null : String(intakeError?.details?.intakeId ?? projectionError?.details.intakeId ?? (req.body as any)?.intakeId ?? "").trim() || null,
        instanceId: frozenScopeError ? frozenScopeError instanceof OrchInstanceScopeError ? frozenScopeError.details.instanceId : null : requirementAnalysisError ? null : String(projectionError?.details.instanceId ?? (req.body as any)?.instanceId ?? "").trim() || null,
        ms: Date.now() - startedAt,
        rootCause: description.rootCause,
      }, { error: e });
      ctx.onApiFailureLogged?.();
    }
    const availabilityCode = e instanceof WorkspaceOperationGateError ? e.code : threadAvailabilityErrorCode(e);
    const responseCode = availabilityCode
      ?? (description.code === "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED" ? "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED" : null)
      ?? projectionError?.code
      ?? (requirementAnalysisScopeConflict ? "FORBIDDEN" : intakeError || requirementAnalysisError || frozenScopeError ? "INTERNAL_ERROR" : null)
      ?? (e instanceof ThreadInputContractError ? e.code : null);
    if (e instanceof WorkspaceOperationGateError) {
      // 迁移控制诊断留在应用级，不能再次申请已被同一迁移阻断的工作区writer。
      try { logger.warn("workspace-migration", "workspace api write rejected by migration gate", {
        code: e.code,
        errorCode: e.code,
        event: { category: "workspace-migration", action: req.method, outcome: "fail" },
        requestId: req.id,
        method: req.method,
        workspaceId: e.details.workspaceId ?? null,
        operationId: e.details.operationId ?? null,
        ...(req.method.startsWith("workspaceExecutionProfile.") ? { userId: (req.body as any)?.userId ?? null,
          scopeType: (req.body as any)?.profileScopeType ?? null, scopeId: (req.body as any)?.profileScopeId ?? workspaceId } : {}),
        rootCause: description.rootCause,
      }); } catch (failure) {
        throw new WorkspaceApiRequestFailure([e, failure], failureDetails("WORKSPACE_API_REQUEST_LOG_FAILED"));
      }
      ctx.onApiFailureLogged?.();
    }
    if (!failureLogged) {
      await diagnostic("error", "api", "API request failed", { errorCode: responseCode ?? "API_REQUEST_FAILED",
        event: { category: "api", action: req.method, outcome: "fail" }, rootCause: description.rootCause }, { error: e });
      ctx.onApiFailureLogged?.();
    }
    if (responseAttempted) throw new WorkspaceApiRequestFailure([e], failureDetails("WORKSPACE_API_RESPONSE_FAILED"));
    const responseMessage = req.method.startsWith("mcp.")
      ? sanitizeMcpRequestError(e, req.body)
      : message;
    ctx.send({
      t: "api.res",
      id: req.id,
      status: availabilityCode ? 409 : requirementAnalysisScopeConflict ? 403 : 500,
      body: { ok: false, ...(responseCode ? { code: responseCode } : {}), message: responseMessage },
    });
    const responseDispatch = ctx.takeApiResponseDispatch?.(req.id) ?? null;
    if (isOrchMethod(req.method) && responseDispatch?.accepted === false) {
      throw new WorkspaceApiRequestFailure([e, responseDispatch], failureDetails("WORKSPACE_API_RESPONSE_FAILED"));
    }
    } catch (failure) {
      const finalFailure = isWorkspaceApiRequestFailure(failure) || failure === e ? failure
        : new WorkspaceApiRequestFailure([e, failure], failureDetails("WORKSPACE_API_REQUEST_TRANSLATION_FAILED"));
      requestState.failure = { error: finalFailure };
      throw finalFailure;
    }
  } finally {
    const failures: unknown[] = [];
    try { finishThreadOperation(); } catch (failure) { failures.push(failure); }
    try { finishWorkspaceWrite(); } catch (failure) { failures.push(failure); }
    if (failures.length) {
      const failure = new WorkspaceApiRequestFailure(requestState.failure ? [requestState.failure.error, ...failures] : failures,
        failureDetails("WORKSPACE_API_REQUEST_CLEANUP_FAILED"));
      await diagnostic("error", "api", "API request cleanup failed", { errorCode: "WORKSPACE_API_REQUEST_CLEANUP_FAILED",
        event: { category: "api", action: req.method, outcome: "fail" }, rootCause: describeWorkspaceApiFailure(failure).rootCause,
        failureCount: failures.length }, { error: failure });
      throw failure;
    }
  }
}

/** MCP 异常日志只保留可检索错误上下文，替换请求中可能出现的凭据值。 */
export function sanitizeMcpRequestError(error: unknown, body: unknown): string {
  let message = describeWorkspaceApiFailure(error).message;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const inputs = (body as Record<string, unknown>).credentialInputs;
    if (Array.isArray(inputs)) {
      for (const input of inputs) {
        if (!input || typeof input !== "object") continue;
        const value = (input as Record<string, unknown>).value;
        if (typeof value === "string" && value) message = message.split(value).join("[REDACTED]");
      }
    }
  }
  return message.length > 1_000 ? `${message.slice(0, 1_000)}...` : message;
}

/** 仅为会启动运行时或改写工作区文件的 API 提取短写门禁 workspaceId。 */
function resolveWorkspaceMigrationWriteId(req: ApiRequestMessage): WorkspaceId | null {
  if (!WORKSPACE_MIGRATION_GATED_API_METHODS.has(req.method)) return null;
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim();
  return workspaceId ? workspaceId as WorkspaceId : null;
}

function isOrchMethod(method: string): boolean {
  const normalized = String(method ?? "");
  return normalized.startsWith("orch.") || normalized.startsWith("reminders.");
}

/** 读取普通聊天线程的输入动作目录；Claude 查询不得隐式启动 Provider 进程。 */
async function onThreadsInputActionsList(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = req.body as Record<string, unknown> | null;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  const trigger = body?.trigger;
  if (!workspaceId || !threadId || (trigger !== "/" && trigger !== "$")) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, code: "BAD_REQUEST", message: "输入动作目录参数无效" },
    });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const persisted = await withApiDatabase(ctx, req.id, () => ctx.db.threads.get(threadId));
  if (!persisted) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (persisted.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }
  if (persisted.threadSubtype != null || persisted.threadType === "orchestration") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, code: "PROVIDER_SLASH_CONFLICT", message: "输入动作仅支持普通聊天会话" },
    });
    return;
  }

  let thread = ctx.threads.get(threadId);
  if (!thread) {
    thread = ctx.threads.create({
      threadId: persisted.id,
      workspaceId: persisted.workspaceId,
      engine: persisted.engine,
      title: persisted.title,
      sessionId: persisted.sessionId,
      sessionCapabilities: persisted.sessionCapabilities,
    });
  }

  if (thread.engine === "codex" && trigger === "/") {
    let runningTurnId: string | null = null;
    let queueLength = 0;
    let hasConversationHistory = false;
    try {
      runningTurnId = hasActiveThreadTurn(ctx, { workspaceId, threadId }) ? "active" : null;
      ({ queueLength, hasConversationHistory } = await withApiDatabase(ctx, req.id, () => ({
        queueLength: ctx.db.threadMessageQueue.hasActiveByThread(threadId) ? 1 : 0,
        hasConversationHistory: ctx.db.conversationEvents.getLatestSeqByThread(threadId) > 0,
      })));
    } catch (error) {
      await writeWorkspaceTurnLog(ctx, "error", "api", "thread input action history lookup failed", {
        code: "THREAD_INPUT_ACTION_CATALOG_FAILED",
        requestId: req.id, method: req.method,
        workspaceId,
        threadId,
        engine: thread.engine,
        trigger,
      }, { errors: [error] });
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 503,
        body: { ok: false, code: "THREAD_INPUT_ACTION_CATALOG_FAILED", message: "输入动作目录读取失败" },
      });
      return;
    }
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        engine: "codex",
        actions: buildCodexCliSlashInputActions({
          hasConversationHistory,
          runningTurnId,
          queueLength,
        }),
        providerCatalog: { state: "ready", observedAt: null },
      },
    });
    return;
  }
  if (thread.engine !== "codex" && trigger === "$" || thread.engine === "codex" && trigger !== "$") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        engine: thread.engine,
        actions: [],
        providerCatalog: { state: "ready", observedAt: null },
      },
    });
    return;
  }

  try {
    const session = thread.engine === "codex"
      ? await withApiDatabase(ctx, req.id, () => ctx.sessions.getOrCreate(thread))
      : ctx.sessions.getExisting(threadId);
    if (!session?.listInputActions) {
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 200,
        body: {
          engine: thread.engine,
          actions: [],
          providerCatalog: {
            state: "unavailable",
            observedAt: null,
            message: thread.engine === "claude" ? "尚无会话目录" : "当前 Client 不支持输入动作目录",
          },
        },
      });
      return;
    }
    const result = await session.listInputActions(trigger);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: result });
  } catch (error) {
    if (isWorkspaceApiRequestFailure(error)) throw error;
    await writeWorkspaceTurnLog(ctx, "error", "api", "thread input action catalog failed", {
      code: "THREAD_INPUT_ACTION_CATALOG_FAILED",
      requestId: req.id, method: req.method,
      workspaceId,
      threadId,
      engine: thread.engine,
      trigger,
    }, { errors: [error] });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 503,
      body: { ok: false, code: "THREAD_INPUT_ACTION_CATALOG_FAILED", message: "输入动作目录读取失败" },
    });
  }
}

/** 默认不记录每个编排 Host 请求，避免 runtimePatch 轮询刷日志。 */
function shouldTraceOrchApi(): boolean {
  const raw = String(process.env.CODEFLOWAI_ORCH_API_TRACE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function summarizeWsSendResult(result: WsSendJsonResult | null): Record<string, unknown> | null {
  if (!result) return null;
  return {
    accepted: result.accepted,
    messageType: result.messageType,
    readyState: result.readyState,
    bufferedAmount: result.bufferedAmount,
    bytes: result.bytes,
    reason: result.reason,
    callbackError: result.callbackError,
  };
}

/** 读取 Server 或桌面可信入口注入的 Profile 上下文，发送和队列沿用同一合同。 */
export function readThreadExecutionProfileContext(body: Record<string, unknown> | null | undefined): ThreadExecutionProfileContext | null {
  const userId = String(body?.executionProfileUserId ?? "").trim();
  const scopeType = String(body?.executionProfileScopeType ?? "").trim();
  const scopeId = String(body?.executionProfileScopeId ?? "").trim();
  const hasAny = Boolean(userId || scopeType || scopeId);
  if (!hasAny) return null;
  if (!userId || !scopeType || !scopeId) {
    throw new Error("参数错误：executionProfileUserId/executionProfileScopeType/executionProfileScopeId");
  }
  if (scopeType !== "local_workspace" && scopeType !== "shared_workspace") {
    throw new Error("参数错误：executionProfileScopeType");
  }
  return {
    userId,
    scope: { scopeType, scopeId },
  };
}

/** 构造普通会话系统提示词中的当前用户工作区 Profile 片段。 */
function buildThreadExecutionProfileSystemRule(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  context: ThreadExecutionProfileContext | null | undefined,
): string | null {
  if (!context) return null;
  const profile = ctx.db.withWorkspaceExecutionProfiles(workspaceId, repo => repo.get(context.scope, context.userId));
  const profileText = String(profile?.profileText ?? "").trim();
  if (!profileText) return null;
  return [
    "当前用户的工作区执行 Profile（普通会话自动注入）：",
    `userId: ${context.userId}`,
    `scope: ${context.scope.scopeType}/${context.scope.scopeId}`,
    "Profile 内容：",
    profileText,
  ].join("\n");
}

/** 节点线程只有一个输入入口：旧 send 调用也转入持久队列，不创建普通聊天 turn。 */
async function enqueueNodeThreadSendMessage(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    text: string;
    images: string[];
    files: unknown[];
    pathReferences: unknown[];
    workMode: "general" | null;
    planMode: boolean;
    accessMode: AccessMode | null;
    model: string | null;
    effort: string | null;
    contextWindow: number | null;
    autoCompactPct: number | null;
    serviceTier: CodexServiceTier | null;
    clientItemId: string | null;
  },
): Promise<void> {
  let failureLogged = false;
  /** 转发与异常可能连续失败；同一请求只在本处理边界记录一次根因。 */
  const logFailureOnce = async (rootCause: unknown): Promise<void> => {
    if (failureLogged) return;
    failureLogged = true;
    await writeWorkspaceTurnLog(ctx, "error", "api", "node thread queue append failed", {
      code: "node_thread_queue_append_failed",
      requestId: req.id,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    }, { errors: [rootCause] });
    ctx.onApiFailureLogged?.();
  };
  const queueRequest: ApiRequestMessage = {
    ...req,
    method: "threads.queue.append",
    path: "/threads/queue/append",
    body: {
      ...((req.body && typeof req.body === "object") ? req.body as Record<string, unknown> : {}),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      text: input.text,
      images: input.images.map((raw, index) => {
        const dataUrl = String(raw ?? "");
        return {
          id: `img_${index}`,
          name: `图片 ${index + 1}`,
          dataUrl,
          size: estimateBinaryBytesFromDataUrl(dataUrl) ?? 0,
        };
      }),
      files: input.files,
      pathReferences: input.pathReferences,
      sendOptions: {
        workMode: input.workMode ?? "general",
        roleId: null,
        planMode: input.planMode,
        accessMode: input.accessMode,
        model: input.model,
        effort: input.effort,
        contextWindow: input.contextWindow,
        autoCompactPct: input.autoCompactPct,
        serviceTier: input.serviceTier,
      },
      clientItemId: input.clientItemId,
    },
  };
  const send = ctx.send;
  let queueResponse: Extract<ClientToServerMessage, { t: "api.res" }> | undefined;
  const queueCtx: ApiHandlerContext = {
    ...ctx,
    /** 队列原 owner 已记录时，外层发送与桌面补日志沿用同一请求事实。 */
    onApiFailureLogged() {
      failureLogged = true;
      ctx.onApiFailureLogged?.();
    },
    send(message) {
      if (message.t !== "api.res" || message.id !== req.id) {
        return send(message);
      }
      if (queueResponse) throw new Error(`节点输入入队重复响应：requestId=${req.id}`);
      queueResponse = message;
    },
  };
  try {
    await onThreadQueueAppend(queueCtx, queueRequest);
    if (!queueResponse) throw new Error(`节点输入入队缺少响应：requestId=${req.id}`);
    if (queueResponse.status !== 200) {
      const body = queueResponse.body && typeof queueResponse.body === "object" && !Array.isArray(queueResponse.body)
        ? queueResponse.body as Record<string, unknown> : null;
      await logFailureOnce(body?.message ?? body?.code ?? `queue append returned HTTP ${queueResponse.status}`);
      send(queueResponse);
    } else {
      if (!queueResponse.body || typeof queueResponse.body !== "object" || Array.isArray(queueResponse.body)) {
        throw new Error(`节点输入入队成功响应体必须是对象：requestId=${req.id}`);
      }
      send({ ...queueResponse, body: { ...(queueResponse.body as Record<string, unknown>), dispatchMode: "orchestration_feedback" } });
    }
  } catch (error) {
    if (isWorkspaceApiRequestFailure(error)) throw error;
    await logFailureOnce(error);
    throw error;
  }
}

/**
 * 会话因用户中断（user_stop）暂停队列后，用户再次发送普通消息即视为要继续执行：
 * 解除该暂停并把待投递项交给调度器，避免新消息与遗留的待投递项一起继续排队。
 *
 * 只处理 user_stop：用户显式暂停（user_pause）、失败类暂停（send_failed / session_invalidated）
 * 以及编排节点、需求分析会话都保持原样——它们的暂停来自明确指令或需要人工动作的状态。
 */
async function resumeInterruptedQueueForNewInput(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
): Promise<void> {
  const resumed = await withApiDatabase(ctx, `queue-resume:${input.threadId}`, () => {
    const thread = ctx.db.threads.get(input.threadId);
    if (!thread) return;
    if (thread.threadSubtype != null && thread.threadSubtype !== "node-discussion") return;
    const state = ctx.db.threadQueueStates.getState(input.threadId);
    if (!state.paused || state.pausedReason !== "user_stop") return;
    ctx.db.threadQueueStates.resume(input.threadId, input.workspaceId);
    return true;
  });
  if (!resumed) return;
  await writeWorkspaceTurnLog(ctx, "info", "queue", "queue resumed by new user input after interrupt", {
    requestId: `queue-resume:${input.threadId}`,
    category: "thread_queue",
    action: "resume_on_new_input",
    outcome: "success",
    workspaceId: input.workspaceId,
    threadId: String(input.threadId),
  });
  await withApiDatabase(ctx, `queue-resume:${input.threadId}`, () => emitQueueChanged(ctx, input.workspaceId, input.threadId, "resumed"));
  ctx.queueDispatcher?.kickIfIdle(input.threadId);
}

/** 处理普通会话发送请求，完成入参校验、事件落库和异步引擎发送。 */
async function onThreadsSendMessage(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = req.body as any;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  const requestedTurnId = String(body?.turnId ?? "").trim();
  const clientItemId = typeof body?.clientItemId === "string" && body.clientItemId.trim() ? body.clientItemId.trim() : null;
  const turnId = (requestedTurnId || `turn_${crypto.randomUUID()}`) as TurnId;
  const text = String(body?.text ?? "");
  let inputContract: ReturnType<typeof normalizeThreadInputContract>;
  let displayInput: ReturnType<typeof normalizeClientThreadDisplayInput>;
  try {
    inputContract = normalizeThreadInputContract(body, text);
    displayInput = normalizeClientThreadDisplayInput({
      text,
      ...inputContract,
    });
  } catch (error) {
    const metadata = extractTurnErrorMetadata(error);
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, code: metadata.code ?? "BAD_REQUEST", message: metadata.message },
    });
    return;
  }
  const displayText = displayInput.text;
  inputContract = {
    ...(inputContract.inputKind ? { inputKind: inputContract.inputKind } : {}),
    ...(displayInput.skillMentions ? { skillMentions: displayInput.skillMentions } : {}),
  };
  const workMode = parseWorkMode(body?.workMode);
  const roleId = parseRoleId(body?.roleId);
  const planMode = Boolean(body?.planMode ?? false);
  const accessMode = parseAccessMode(body?.accessMode);
  const model: string | null = typeof body?.model === "string" ? body.model.trim() || null : null;
  const effort: string | null = typeof body?.effort === "string" ? body.effort.trim() || null : null;
  const serviceTier = parseServiceTier(body?.serviceTier);
  const rawContextWindow = body?.contextWindow;
  const contextWindow = typeof rawContextWindow === "number" && rawContextWindow > 0 ? Math.round(rawContextWindow) : null;
  const rawAutoCompactPct = body?.autoCompactPct;
  const autoCompactPct = typeof rawAutoCompactPct === "number" && rawAutoCompactPct >= 50 && rawAutoCompactPct <= 99 ? rawAutoCompactPct : null;
  const images = Array.isArray(body?.images) ? (body.images as string[]) : [];
  const files = Array.isArray(body?.files) ? (body.files as unknown[]) : [];
  const rawPathReferences = Array.isArray(body?.pathReferences) ? body.pathReferences : [];
  const sharedWorkspaceToolContext = readSharedWorkspaceToolExecutionContext(body);
  let executionProfileContext: ThreadExecutionProfileContext | null;
  try {
    executionProfileContext = readThreadExecutionProfileContext(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: msg } });
    return;
  }
  if (!workspaceId || !threadId || (!text.trim() && images.length === 0 && files.length === 0 && rawPathReferences.length === 0)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/text" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  await withApiDatabase(ctx, req.id, () => createRequirementAnalysisService(ctx).assertThreadWorkspaceScope(workspaceId, threadId));
  let thread = ctx.threads.get(threadId);
  if (!thread) {
    const fromDb = await withApiDatabase(ctx, req.id, () => ctx.db.threads.get(threadId));
    if (!fromDb) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
      return;
    }
    thread = ctx.threads.create({
      threadId: fromDb.id,
      workspaceId: fromDb.workspaceId,
      engine: fromDb.engine,
      title: fromDb.title,
      sessionId: fromDb.sessionId,
      sessionCapabilities: fromDb.sessionCapabilities,
    });
  }
  if (thread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }
  if (images.length > 0) {
    await writeWorkspaceTurnLog(ctx, "info", "api", "thread image input received", {
      code: "thread_image_input_received", requestId: req.id, workspaceId, threadId,
      ...summarizeImageInputs(images),
    });
  }
  const engine = thread.engine;
  const persistedThread = await withApiDatabase(ctx, req.id, () => ctx.db.threads.get(threadId));
  const explicitInputContract = hasExplicitThreadInputContract(body);
  const isOrdinaryChatThread = persistedThread?.threadSubtype == null
    && persistedThread?.threadType !== "orchestration";
  const isKnowledgeChatThread = persistedThread?.threadSubtype === "knowledge-conversation";
  const isKnowledgeExecutionThread = persistedThread?.threadSubtype === "knowledge-assets";
  const isKnowledgeTextInput = (isKnowledgeChatThread || isKnowledgeExecutionThread) && inputContract.inputKind !== "provider-slash" && !inputContract.skillMentions?.length;
  if (explicitInputContract && !isOrdinaryChatThread && !isKnowledgeTextInput) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "PROVIDER_SLASH_CONFLICT",
        message: "输入动作仅支持普通聊天会话",
      },
    });
    return;
  }
  if (inputContract.inputKind === "provider-slash") {
    const hasActiveTurn = hasActiveThreadTurn(ctx, { workspaceId, threadId });
    const hasQueuedInput = await withApiDatabase(ctx, req.id, () => ctx.db.threadMessageQueue.hasActiveByThread(threadId));
    const conflict = resolveProviderSlashPreflightConflict({
      engine,
      rawText: text,
      hasRole: Boolean(roleId),
      imageCount: images.length,
      fileCount: files.length,
      pathReferenceCount: rawPathReferences.length,
      hasActiveTurn,
      hasQueuedInput,
    });
    if (conflict) {
      await writeWorkspaceTurnLog(ctx, "error", "api", "provider slash preflight rejected", {
        code: "PROVIDER_SLASH_CONFLICT",
        requestId: req.id,
        workspaceId,
        threadId,
        engine,
        command: extractSafeClaudeSlashCommandName(text),
        hasActiveTurn,
        hasQueuedInput,
        rootCause: conflict,
      });
      ctx.onApiFailureLogged?.();
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: { ok: false, code: "PROVIDER_SLASH_CONFLICT", message: conflict },
      });
      return;
    }
  }
  if (inputContract.skillMentions?.length && engine !== "codex") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, code: "CODEX_SKILL_BINDING_INVALID", message: "Skill binding 仅支持 Codex" },
    });
    return;
  }
  try {
    await withApiDatabase(ctx, req.id, () => assertClientReasoningEffortSupported(
      ctx.db,
      engine,
      model ?? persistedThread?.model ?? null,
      body?.effort,
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  const initialRollbackReconciliation = await reconcileUnresolvedRollbackBeforeMutation(ctx, req, { workspaceId, threadId });
  if (!initialRollbackReconciliation) return;
  const rollbackResponseMetadata = resolveRollbackApiResponseMetadata(initialRollbackReconciliation);
  ctx = withRollbackApiResponseMetadata(ctx, req.id, rollbackResponseMetadata);
  const initialRollbackEventSeqBarrier = rollbackResponseMetadata.rollbackEventSeqBarrier;
  if (persistedThread?.threadSubtype === "node") {
    let normalizedFiles: ReturnType<typeof normalizeTextFiles>;
    let pathReferences: WorkspacePathReference[];
    try {
      normalizedFiles = normalizeTextFiles(files);
      pathReferences = normalizePathReferencesForSend(rawPathReferences);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
      return;
    }
    const payloadBudget = validateInlineThreadPayload(
      { text, images, files: normalizedFiles, pathReferences },
      { contextLabel: "节点输入" },
    );
    if (!payloadBudget.ok) {
      ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: payloadBudget.message } });
      return;
    }
    await enqueueNodeThreadSendMessage(ctx, req, {
      workspaceId,
      threadId,
      text,
      images,
      files: normalizedFiles,
      pathReferences,
      workMode,
      planMode,
      accessMode,
      model,
      effort,
      contextWindow,
      autoCompactPct,
      serviceTier,
      clientItemId,
    });
    return;
  }
  // 幂等重试也必须先收口未决回滚，避免返回已经被裁剪的旧 turn。
  if (clientItemId && ctx.sendIdempotencyCache) {
    const cachedTurnId = ctx.sendIdempotencyCache.lookup(threadId, clientItemId);
    const reconciledRollbackRemovedCachedTurn = Boolean(cachedTurnId)
      && initialRollbackReconciliation.kind === "success"
      && !await withApiDatabase(ctx, req.id, () => ctx.db.turns.get(cachedTurnId as TurnId));
    if (cachedTurnId && !reconciledRollbackRemovedCachedTurn) {
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 200,
        body: {
          ok: true,
          turnId: cachedTurnId,
          dispatchMode: "chat_turn",
          idempotent: true,
          ...(initialRollbackReconciliation.kind === "success" ? { rollbackReconciled: true } : {}),
          ...(initialRollbackEventSeqBarrier != null ? { rollbackEventSeqBarrier: initialRollbackEventSeqBarrier } : {}),
        },
      });
      return;
    }
  }
  if (!await retryPendingTerminalBeforeNewTurn(ctx, req, { workspaceId, threadId })) return;
  const postTerminalRollbackReconciliation = await reconcileUnresolvedRollbackBeforeMutation(ctx, req, { workspaceId, threadId });
  if (!postTerminalRollbackReconciliation) return;
  mergeRollbackApiResponseMetadata(rollbackResponseMetadata, postTerminalRollbackReconciliation);
  const rollbackReconciled = rollbackResponseMetadata.rollbackReconciled;
  const rollbackEventSeqBarrier = rollbackResponseMetadata.rollbackEventSeqBarrier;
  if (hasActiveThreadTurn(ctx, { workspaceId, threadId })) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: ACTIVE_TURN_CONFLICT_MESSAGE } });
    return;
  }
  // 无运行中的 turn 才轮到"用户主动发送 = 继续会话"：解除中断带来的队列暂停并投递待发送项。
  await resumeInterruptedQueueForNewInput(ctx, { workspaceId, threadId });
  let normalizedFiles: ReturnType<typeof normalizeTextFiles>;
  try {
    normalizedFiles = normalizeTextFiles(files);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: msg } });
    return;
  }
  let pathReferences: WorkspacePathReference[];
  try {
    pathReferences = normalizePathReferencesForSend(rawPathReferences);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: msg } });
    return;
  }

  const effectivePlanMode = persistedThread?.threadSubtype === "node-discussion" || isKnowledgeChatThread || isKnowledgeExecutionThread ? false : planMode;
  let effectiveAccessMode = persistedThread?.threadSubtype === "node-discussion" || isKnowledgeChatThread || isKnowledgeExecutionThread
    ? "read-only"
    : (accessMode ?? persistedThread?.accessMode ?? null);
  if (persistedThread?.threadType === "chat" && !persistedThread.threadSubtype) {
    const workflow = new ChatWorkflowService(ctx);
    if (await withApiDatabase(ctx, req.id, () => workflow.repo.list(threadId).some(task => task.state === "recommended" || task.state === "starting"))) effectiveAccessMode = "read-only";
    await withApiDatabase(ctx, req.id, () => assertChatDirectoryAvailable(ctx, workspaceId, threadId));
  }
  const effectiveRoleId = persistedThread && persistedThread.threadSubtype == null && persistedThread.threadType !== "orchestration"
    ? roleId
    : null;

  if (persistedThread?.threadSubtype === "requirement-analysis") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        turnId,
        dispatchMode: "chat_turn",
        ...(rollbackReconciled ? { rollbackReconciled: true } : {}),
        ...(rollbackEventSeqBarrier != null ? { rollbackEventSeqBarrier } : {}),
      },
    });
    trackOrdinaryTurnExecution(ctx.sessions, { workspaceId, threadId, turnId, localWorkspaceOnly: ctx.localWorkspaceOnly === true }, async execution => {
      try {
        execution.markProviderDispatch();
        await createRequirementAnalysisService(ctx).sendMessage({
          workspaceId,
          sessionId: threadId as any,
          text,
          turnId,
          planMode: effectivePlanMode,
          accessMode: effectiveAccessMode,
          model,
          effort,
          contextWindow,
          images,
          files: normalizedFiles,
          pathReferences,
          autoCompactPct,
          serviceTier,
        });
      } catch (e) {
        if (isWorkspaceApiRequestFailure(e)) throw e;
        const metadata = extractTurnErrorMetadata(e);
        await writeWorkspaceTurnLog(ctx, "error", "api", "requirementAnalysis thread send failed", {
          code: metadata.code ?? "REQUIREMENT_ANALYSIS_SEND_FAILED", requestId: req.id, threadId, workspaceId, turnId,
          responseAttempted: true, responseDelivered: true,
        }, { errors: [e] });
        try {
          notifyRequirementAnalysisQueueTerminal(ctx, {
            workspaceId,
            threadId,
            turnId,
            outcome: "error",
            terminationKind: metadata.terminationKind,
            errorCode: metadata.code ?? null,
          });
        } catch (noticeError) {
          await writeWorkspaceTurnLog(ctx, "error", "queue", "requirement analysis failure notification failed", {
            code: "REQUIREMENT_ANALYSIS_NOTIFICATION_FAILED", requestId: req.id, workspaceId, threadId, turnId,
            responseAttempted: true, responseDelivered: true,
          }, { errors: [e, noticeError] });
          throw aggregateOrdinaryTurnFailures([e, noticeError], "REQUIREMENT_ANALYSIS_NOTIFICATION_FAILED");
        }
        throw e;
      }
      try { notifyRequirementAnalysisQueueTerminal(ctx, { workspaceId, threadId, turnId, outcome: "completed" }); }
      catch (noticeError) {
        if (isWorkspaceApiRequestFailure(noticeError)) throw noticeError;
        await writeWorkspaceTurnLog(ctx, "error", "queue", "requirement analysis completion notification failed", {
          code: "REQUIREMENT_ANALYSIS_NOTIFICATION_FAILED", requestId: req.id, workspaceId, threadId, turnId,
          responseAttempted: true, responseDelivered: true,
        }, { errors: [noticeError] });
        throw noticeError;
      }
    });
    return;
  }

  if (persistedThread?.threadSubtype === "asset-draft") {
    if (images.length > 0) {
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 400,
        body: { ok: false, message: "助手草案会话暂不支持直接附带图片，请改用文本、文件或路径引用补充。" },
      });
      return;
    }
    const draftJob = await withApiDatabase(ctx, req.id, () => ctx.db.orchAssetGenerationJobs.findLatestByThreadId(workspaceId, threadId));
    if (!draftJob) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "未找到当前助手草案任务" } });
      return;
    }
    const canRetryFailure = draftJob.status === "failed" && draftJob.failure?.retryable === true;
    if (draftJob.status !== "awaiting_input" && draftJob.status !== "awaiting_review" && draftJob.status !== "applied" && !canRetryFailure) {
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: { ok: false, message: `当前助手草案状态不允许继续补充：${draftJob.status}` },
      });
      return;
    }
    const feedback = buildPromptText({ text: text.trim(), files: normalizedFiles, pathReferences }).trim();
    try {
      const result = await createAssetDraftService(ctx).resumeAssetDraftJob({
        workspaceId,
        jobId: draftJob.id,
        prompt: feedback,
        selectedPaths: pathReferences.map((ref) => ref.path),
        targetThreadId: threadId,
        enginePreference: {
          engine: persistedThread.engine,
          model,
          effort,
          contextWindow,
          autoCompactPct,
          serviceTier,
        },
      });
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 200,
        body: {
          ok: true,
          dispatchMode: "orchestration_feedback",
          ...(rollbackReconciled ? { rollbackReconciled: true } : {}),
          ...(rollbackEventSeqBarrier != null ? { rollbackEventSeqBarrier } : {}),
          result: {
            jobId: result.job.id,
            status: result.job.status,
            threadId: result.job.threadId,
          },
        },
      });
    } catch (error) {
      sendAssetDraftThreadSendError(ctx, req, error);
    }
    return;
  }

  const lifecycleVersion = thread.lifecycleVersion;
  const isThreadLifecycleCurrent = () => {
    const latest = ctx.threads.get(threadId);
    return Boolean(latest && latest.lifecycleVersion === lifecycleVersion);
  };

  // 来自 dispatcher 自动消费时，body 会带 __queueSource；用于 turn 终态后回写队列项状态
  const queueSource = (() => {
    const raw = (body as Record<string, unknown>).__queueSource;
    if (!raw || typeof raw !== "object") return null;
    const queueItemId = String((raw as Record<string, unknown>).queueItemId ?? "").trim();
    return queueItemId ? { queueItemId } : null;
  })();

  const userItemId = `item_user_${crypto.randomUUID()}` as ItemId;
  const assistantItemId = `item_assistant_${crypto.randomUUID()}`;
  const reasoningItemId = `item_reasoning_${crypto.randomUUID()}`;

  const promptText = buildClientThreadPromptText({
    text: displayText,
    inputKind: inputContract.inputKind,
    files: normalizedFiles,
    pathReferences,
  });

  try {
    ctx.sessions.assertThreadAvailable?.(threadId, thread);
  } catch (error) {
    const code = threadAvailabilityErrorCode(error);
    if (!code) throw error;
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
  let resolveApi!: () => void, rejectApi!: (error: unknown) => void;
  let apiSettled = false;
  const apiReady = new Promise<void>((resolve, reject) => {
    resolveApi = () => { apiSettled = true; resolve(); };
    rejectApi = error => { apiSettled = true; reject(error); };
  });
  /** API 只等原准备及受理，完整执行和清理继续由同一 owner 持有。 */
  const prepareAndExecute = async (execution: OrdinaryTurnExecutionControl): Promise<void> => {
    execution.assertNotCancelled();
    let session: ThreadEngineSession | null = null;
    let preparedInputActions: PreparedCodexSkillInput | null = null;
    if (inputContract.skillMentions?.length) {
      try {
        session = await withApiDatabase(ctx, req.id, () => ctx.sessions.getOrCreate(thread));
        if (!session.prepareInputActions) {
          throw Object.assign(new Error("当前 Codex 会话不支持 Skill binding"), {
            code: "CODEX_SKILL_BINDING_INVALID",
          });
        }
        preparedInputActions = await session.prepareInputActions({
          turnId,
          userItemId,
          text: displayText,
          skillMentions: inputContract.skillMentions,
        });
      } catch (error) {
        const metadata = extractTurnErrorMetadata(error);
        const code = metadata.code ?? "CODEX_SKILL_BINDING_INVALID";
        const status = code === "active_turn_conflict"
          ? 409
          : code === "THREAD_INPUT_ACTION_CATALOG_FAILED"
            ? 503
            : 400;
        await writeWorkspaceTurnLog(ctx, "error", "api", "thread input action prepare failed", {
          code,
          requestId: req.id,
          workspaceId,
          threadId,
          turnId,
          queueItemId: queueSource?.queueItemId ?? null,
        }, { errors: [error] });
        ctx.onApiFailureLogged?.();
        ctx.send({
          t: "api.res",
          id: req.id,
          status,
          body: { ok: false, code, message: metadata.message },
        });
        resolveApi();
        throw error;
      }
    }

    try {
      execution.assertNotCancelled();
      // 两个事件仍分别耐久提交，只复用同步连接，不把受理及模型执行包进事务。
      const emitAcceptedEvents = (): void => {
        emitConversation(ctx, {
          ts: Date.now(),
          workspaceId,
          threadId,
          engine,
          type: "turn.started",
          payload: {
            turnId,
            execution: buildTurnExecutionOptionsSnapshot({ model, effort, contextWindow, autoCompactPct, serviceTier }),
          },
        });
        emitConversation(ctx, {
          ts: Date.now(),
          workspaceId,
          threadId,
          engine,
          type: "item.userMessage.created",
          payload: {
            turnId,
            itemId: userItemId,
            text: displayText,
            ...(inputContract.inputKind ? { inputKind: inputContract.inputKind } : {}),
            ...(inputContract.skillMentions ? { skillMentions: inputContract.skillMentions } : {}),
            images: images.length ? images : undefined,
            files: normalizedFiles.length ? normalizedFiles : undefined,
            pathReferences: pathReferences.length ? pathReferences : undefined,
          },
        });
      };
      if (ctx.localWorkspaceOnly === true && !ctx.withDatabase) ctx.db.withWorkspaceCoreRepos(workspaceId, emitAcceptedEvents);
      else emitAcceptedEvents();
      await ctx.flushLocalEvents?.(workspaceId, threadId);
    } catch (error) {
      try { if (preparedInputActions) session?.releasePreparedInputActions?.(preparedInputActions); }
      catch (cleanupError) { throw aggregateOrdinaryTurnFailures([error, cleanupError], "ORDINARY_TURN_CLEANUP_FAILED"); }
      throw error;
    }

    try {
      session ??= await withApiDatabase(ctx, req.id, () => ctx.sessions.getOrCreate(thread));
    } catch (e) {
      try { if (preparedInputActions) session?.releasePreparedInputActions?.(preparedInputActions); }
      catch (cleanupError) { throw aggregateOrdinaryTurnFailures([e, cleanupError], "ORDINARY_TURN_CLEANUP_FAILED"); }
      const metadata = extractTurnErrorMetadata(e);
      const code = threadAvailabilityErrorCode(e);
      await writeWorkspaceTurnLog(ctx, "error", "api", "ordinary turn session preparation failed", {
        code: code ?? "ORDINARY_TURN_PREPARATION_FAILED", requestId: req.id, workspaceId, threadId, turnId,
      }, { errors: [e] });
      ctx.onApiFailureLogged?.();
      if (code) {
        ctx.send({
          t: "api.res",
          id: req.id,
          status: 409,
          body: { ok: false, code, message: metadata.message },
        });
        resolveApi();
        throw e;
      }
      emitConversation(ctx, createTurnErrorEventInputFromError({
        ts: Date.now(),
        workspaceId,
        threadId,
        engine,
        turnId,
        error: e,
      }));
      ctx.send({ t: "api.res", id: req.id, status: 501, body: { ok: false, message: metadata.message } });
      resolveApi();
      throw e;
    }

    try {
      await waitForPostReconcileEventDurability({
        rollbackReconciled,
        scope: { workspaceId, threadId, engine },
        fence: ctx.fenceRollbackEvidence,
        flush: ctx.flushRollbackEvidence,
      });
    } catch (cause) {
      try { if (preparedInputActions) session.releasePreparedInputActions?.(preparedInputActions); }
      catch (cleanupError) { throw aggregateOrdinaryTurnFailures([cause, cleanupError], "ORDINARY_TURN_CLEANUP_FAILED"); }
      await failPostReconcileTurnStart(ctx, req, {
        workspaceId,
        threadId,
        turnId,
        engine,
        queueSource,
      }, cause);
      resolveApi();
      throw cause;
    }

    // 先 ACK，让 HTTP 返回；事件流走 WS（turn.completed/turn.error 由异步任务回写）
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 200,
      body: {
        ok: true,
        turnId,
        dispatchMode: "chat_turn",
        ...(rollbackReconciled ? { rollbackReconciled: true } : {}),
        ...(rollbackEventSeqBarrier != null ? { rollbackEventSeqBarrier } : {}),
      },
    });
    resolveApi();
    // 记录幂等 LRU：30 秒 TTL 内同 clientItemId 重发会命中并复用此 turnId
    if (clientItemId && ctx.sendIdempotencyCache) {
      ctx.sendIdempotencyCache.remember(threadId, clientItemId, turnId);
    }

    // 先交还事件循环发送受理回包，后续准备仍由原 owner 持有并复核精确取消。
    await new Promise<void>(resolve => setImmediate(resolve));

    /** 提示失败也显式失败，同时保留本轮已发生的所有原始错误。 */
    const reportFailureNotice = async (failures: unknown[], notify: () => unknown): Promise<void> => {
      try { await notify(); } catch (noticeError) {
        if (isWorkspaceApiRequestFailure(noticeError)) {
          const details = getWorkspaceApiRequestFailureDetails(noticeError)!;
          throw new WorkspaceApiRequestFailure([...failures.filter(error => !noticeError.errors.includes(error)), ...noticeError.errors], details);
        }
        const causes = [...failures, noticeError];
        await writeWorkspaceTurnLog(ctx, "error", "api", "ordinary turn failure notice failed", {
          code: "ORDINARY_TURN_FAILURE_NOTICE_FAILED", requestId: req.id, workspaceId, threadId, turnId,
          responseAttempted: true, responseDelivered: true,
        }, { errors: causes });
        throw aggregateOrdinaryTurnFailures(causes, "ORDINARY_TURN_FAILURE_NOTICE_FAILED");
      }
    };
    const executeTurn = () => continueThreadTurnWithManagedServices(ctx, {
      requestId: req.id,
      workspaceId,
      workspacePath,
      threadId,
      turnId,
      engine,
      session,
      userItemId,
      assistantItemId,
      reasoningItemId,
      promptText,
      displayText,
      specificationPaths: pathReferences.map(reference => reference.path),
      inputKind: inputContract.inputKind,
      preparedInputActions,
      roleId: effectiveRoleId,
      images,
      workMode,
      planMode: effectivePlanMode,
      accessMode: effectiveAccessMode ?? "current",
      model,
      effort,
      serviceTier,
      contextWindow,
      autoCompactPct,
      sharedWorkspaceToolContext,
      knowledgeConversationActor: readKnowledgeConversationActor(body.knowledgeConversationActorContext),
      executionProfileContext,
      isThreadLifecycleCurrent,
      execution,
    })
      .then(async (result) => {
        await ctx.flushLocalEvents?.(workspaceId, threadId);
        if (!isThreadLifecycleCurrent() || !await withApiDatabase(ctx, req.id, () => isTurnStillStarted(ctx, turnId))) return;
        try {
          await settleTurnTerminalOnce(ctx, {
            workspaceId,
            threadId,
            turnId,
            status: "completed",
          }, {
            buildTerminalEvents: async () => {
              const terminalEvents: ConversationEventInput[] = [];
              await emitTurnTerminalWithAssistantReconcile({
                session,
                turnId,
                outcome: "completed",
                emitConversation: (event) => {
                  terminalEvents.push(event);
                },
                buildTerminalEvent: (latestAssistantText) => ({
                  ts: Date.now(),
                  workspaceId,
                  threadId,
                  engine,
                  type: "turn.completed",
                  payload: {
                    turnId,
                    result: {
                      ...result,
                      responseText: latestAssistantText ?? String(result.responseText ?? ""),
                    },
                  },
                }),
              });
              return terminalEvents;
            },
            notifyQueue: () => ctx.queueDispatcher?.notifyTurnTerminal({
              workspaceId,
              threadId,
              turnId,
              source: queueSource ? "queue_consume" : "user_send",
              queueItemId: queueSource?.queueItemId ?? null,
              outcome: "completed",
            }),
          });
        } catch (settlementError) {
          await reportFailureNotice([settlementError], () => reportTurnTerminalSettlementFailure(ctx, {
            requestId: req.id,
            workspaceId,
            threadId,
            turnId,
            engine,
            outcome: "completed",
            error: settlementError,
          }));
          throw settlementError;
        }
      }, async (e) => {
        const skillDiagnostic = isSkillRuntimeDiagnosticFailure(e);
        const skillMaterialize = e instanceof Error && Object.getOwnPropertyDescriptor(e, "code")?.value === "SKILL_RUNTIME_PACKAGE_INVALID"
          && Object.getOwnPropertyDescriptor(e, "phase")?.value === "materialize";
        const metadata = extractTurnErrorMetadata(e);
        const manualInterrupt = metadata.code === MANUAL_TURN_INTERRUPT_CODE && metadata.terminationKind === "manual_interrupt";
        if (!manualInterrupt && !skillDiagnostic && !skillMaterialize) {
          if (isWorkspaceApiRequestFailure(e)) throw e;
          const profileFailure = metadata.code === "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED";
          const data = {
          code: metadata.code ?? "ORDINARY_TURN_EXECUTION_FAILED", requestId: req.id, workspaceId, threadId, turnId,
          ...(profileFailure ? { errorCode: metadata.code, event: { category: "workspace-profile", action: "ordinary-turn.execute", outcome: "fail" }, userId: executionProfileContext?.userId ?? null,
            scopeType: executionProfileContext?.scope.scopeType ?? null, scopeId: executionProfileContext?.scope.scopeId ?? null } : {}),
          preserveRunningState: shouldPreserveTurnRunningState(e), responseAttempted: true, responseDelivered: true,
          };
          await writeWorkspaceTurnLog(ctx, "error", "api", "ordinary turn execution failed", data, { errors: [e] });
        }
        await ctx.flushLocalEvents?.(workspaceId, threadId);
        if (!isThreadLifecycleCurrent() || !await withApiDatabase(ctx, req.id, () => isTurnStillStarted(ctx, turnId))) {
          if (manualInterrupt) return;
          throw e;
        }
        if (shouldPreserveTurnRunningState(e)) {
          throw e;
        }
        const message = metadata.message;
        const code = metadata.code;

        if (code === "session_invalidated" && engine !== "codex") {
          await reportFailureNotice([e], () => emitConversation(ctx, {
            ts: Date.now(), workspaceId, threadId, engine,
            type: "system.notice",
            payload: {
              level: "error",
              text: "会话已失效：引擎上下文已丢失，此会话无法继续。请创建新会话。",
              action: "session.invalidated" as const,
            },
          } satisfies ConversationEventInput));
        }

        if (manualInterrupt) {
          try {
            await settleManualTurnTerminalOnce(ctx, {
              workspaceId,
              threadId,
              turnId,
              engine,
              session,
            });
          } catch (settlementError) {
            await writeWorkspaceTurnLog(ctx, "error", "api", "manual turn terminal settlement failed", {
              code: "ORDINARY_TURN_TERMINAL_FAILED",
              requestId: req.id,
              workspaceId,
              threadId,
              turnId,
              responseAttempted: true, responseDelivered: true,
            }, { errors: [e, settlementError] });
            await reportFailureNotice([e, settlementError], () => emitConversation(ctx, {
              ts: Date.now(),
              workspaceId,
              threadId,
              engine,
              type: "system.notice",
              payload: {
                level: "error",
                text: "停止回合时终态同步失败，请重试停止；若仍失败，请查看客户端日志。",
              },
            } satisfies ConversationEventInput));
            throw new AggregateError([e, settlementError], "ORDINARY_TURN_TERMINAL_FAILED");
          }
          return;
        }

        try {
          await settleTurnTerminalOnce(ctx, {
            workspaceId,
            threadId,
            turnId,
            status: "error",
          }, {
            buildTerminalEvents: async () => {
              const terminalEvents: ConversationEventInput[] = [];
              await emitTurnTerminalWithAssistantReconcile({
                session,
                turnId,
                outcome: "error",
                emitConversation: (event) => {
                  terminalEvents.push(event);
                },
                buildTerminalEvent: () => createTurnErrorEventInput({
                  ts: Date.now(),
                  workspaceId,
                  threadId,
                  engine,
                  turnId,
                  error: message,
                  code,
                  requestMethod: metadata.requestMethod,
                  additionalDetails: metadata.additionalDetails,
                  providerThreadId: metadata.providerThreadId,
                  recoveryReason: metadata.recoveryReason,
                  preserveBinding: metadata.preserveBinding,
                  userChoiceRequired: metadata.userChoiceRequired,
                  recoveryStrategies: metadata.recoveryStrategies,
                  terminationKind: metadata.terminationKind,
                }),
              });
              return terminalEvents;
            },
            notifyQueue: () => ctx.queueDispatcher?.notifyTurnTerminal({
              workspaceId,
              threadId,
              turnId,
              source: queueSource ? "queue_consume" : "user_send",
              queueItemId: queueSource?.queueItemId ?? null,
              outcome: "error",
              terminationKind: metadata.terminationKind,
              errorCode: code ?? null,
            }),
          });
        } catch (settlementError) {
          await reportFailureNotice([e, settlementError], () => reportTurnTerminalSettlementFailure(ctx, {
            requestId: req.id,
            workspaceId,
            threadId,
            turnId,
            engine,
            outcome: "error",
            error: settlementError,
          }));
          throw aggregateOrdinaryTurnFailures([e, settlementError], "ORDINARY_TURN_TERMINAL_FAILED");
        }
        throw e;
      });
    await executeTurn();
  };
  const finishTurnOperation = ctx.sessions.beginThreadOperation(threadId);
  try {
    trackOrdinaryTurnExecution(ctx.sessions, { workspaceId, threadId, turnId, localWorkspaceOnly: ctx.localWorkspaceOnly === true }, async execution => {
      const state: { failure?: { error: unknown } } = {};
      try { await prepareAndExecute(execution); }
      catch (error) {
        try {
          if (!isSkillRuntimeDiagnosticFailure(error) && execution.isCancellation(error)) {
            if (!apiSettled) ctx.send({ t: "api.res", id: req.id, status: 409,
              body: { ok: false, code: MANUAL_TURN_INTERRUPT_CODE, message: "普通回合已中断" } });
            resolveApi();
          } else {
            if (!apiSettled && !isWorkspaceApiRequestFailure(error)) {
              await writeWorkspaceTurnLog(ctx, "error", "api", "ordinary turn preparation failed", {
                code: "ORDINARY_TURN_PREPARATION_FAILED", requestId: req.id, workspaceId, threadId, turnId,
              }, { errors: [error] });
              ctx.onApiFailureLogged?.();
            }
            state.failure = { error }; rejectApi(error); throw error;
          }
        } catch (reported) { state.failure = { error: reported }; rejectApi(reported); throw reported; }
      }
      finally {
        try { finishTurnOperation(); }
        catch (cleanupError) {
          const failures = state.failure ? [state.failure.error, cleanupError] : [cleanupError];
          await writeWorkspaceTurnLog(ctx, "error", "api", "ordinary turn operation release failed", {
            code: "ORDINARY_TURN_OPERATION_RELEASE_FAILED", requestId: req.id, workspaceId, threadId, turnId,
            responseAttempted: apiSettled, responseDelivered: apiSettled,
          }, { errors: failures });
          if (failures.length > 1) throw aggregateOrdinaryTurnFailures(failures, "ORDINARY_TURN_OPERATION_RELEASE_FAILED");
          rejectApi(cleanupError);
          throw cleanupError;
        }
        resolveApi();
      }
    });
  } catch (error) { finishTurnOperation(); throw error; }
  await apiReady;
}

/** 压缩沿用 provider 上下文，目录准入只信任最新持久化模型。 */
/** 压缩先耐久受理，再在数据库许可外执行provider并复验原回合终态。 */
async function onThreadsCompact(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = req.body as any;
  const workspaceId = String(body?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String(body?.threadId ?? "").trim() as ThreadId;
  const requestedTurnId = String(body?.turnId ?? "").trim();
  const turnId = (requestedTurnId || `turn_${crypto.randomUUID()}`) as TurnId;
  const accessMode = parseAccessMode(body?.accessMode);
  const serviceTier = parseServiceTier(body?.serviceTier);
  const rawContextWindow = body?.contextWindow;
  const contextWindow = typeof rawContextWindow === "number" && rawContextWindow > 0 ? Math.round(rawContextWindow) : null;
  const rawAutoCompactPct = body?.autoCompactPct;
  const autoCompactPct = typeof rawAutoCompactPct === "number" && rawAutoCompactPct >= 50 && rawAutoCompactPct <= 99 ? rawAutoCompactPct : null;
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const persistedThread = await withApiDatabase(ctx, req.id, () => ctx.db.threads.get(threadId));
  let thread = ctx.threads.get(threadId);
  if (!thread && !persistedThread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if ((thread && thread.workspaceId !== workspaceId)
    || (persistedThread && persistedThread.workspaceId !== workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }

  if (!thread) {
    const fromDb = persistedThread!;
    thread = ctx.threads.create({
      threadId: fromDb.id,
      workspaceId: fromDb.workspaceId,
      engine: fromDb.engine,
      title: fromDb.title,
      sessionId: fromDb.sessionId,
      sessionCapabilities: fromDb.sessionCapabilities,
    });
  }
  if (thread.engine !== "codex") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, message: "当前专用会话压缩接口仅支持 Codex；Claude 请继续使用 /compact。" },
    });
    return;
  }
  const initialRollbackReconciliation = await reconcileUnresolvedRollbackBeforeMutation(ctx, req, { workspaceId, threadId });
  if (!initialRollbackReconciliation) return;
  const rollbackResponseMetadata = resolveRollbackApiResponseMetadata(initialRollbackReconciliation);
  ctx = withRollbackApiResponseMetadata(ctx, req.id, rollbackResponseMetadata);
  if (!await retryPendingTerminalBeforeNewTurn(ctx, req, { workspaceId, threadId })) return;
  const postTerminalRollbackReconciliation = await reconcileUnresolvedRollbackBeforeMutation(ctx, req, { workspaceId, threadId });
  if (!postTerminalRollbackReconciliation) return;
  mergeRollbackApiResponseMetadata(rollbackResponseMetadata, postTerminalRollbackReconciliation);
  const rollbackReconciled = rollbackResponseMetadata.rollbackReconciled;
  const rollbackEventSeqBarrier = rollbackResponseMetadata.rollbackEventSeqBarrier;
  if (hasActiveThreadTurn(ctx, { workspaceId, threadId })) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: ACTIVE_TURN_CONFLICT_MESSAGE } });
    return;
  }

  const waitingFeedbackBinding = persistedThread?.threadSubtype === "node"
    ? await withApiDatabase(ctx, req.id, () => findWaitingFeedbackNodeBinding(ctx, threadId, { includeExecution: false }))
    : null;
  if (waitingFeedbackBinding) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, message: "当前节点线程只接受编排反馈，暂不支持手动压缩。" },
    });
    return;
  }

  const activeNodeBinding = persistedThread?.threadSubtype === "node"
    ? await withApiDatabase(ctx, req.id, () => findActiveOrchestrationNodeBinding(ctx, threadId))
    : null;
  if (activeNodeBinding) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, message: "当前节点正在执行，暂时不能手动压缩。" },
    });
    return;
  }

  if (persistedThread?.threadSubtype === "requirement-analysis") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: { ok: false, message: "当前会话暂时不能手动压缩。" },
    });
    return;
  }

  const effectiveAccessMode = persistedThread?.threadSubtype === "node-discussion"
    ? "read-only"
    : (accessMode ?? persistedThread?.accessMode ?? null);
  const lifecycleVersion = thread.lifecycleVersion;
  const isThreadLifecycleCurrent = () => {
    const latest = ctx.threads.get(threadId);
    return Boolean(latest && latest.lifecycleVersion === lifecycleVersion);
  };

  try {
    await waitForPostReconcileEventDurability({
      rollbackReconciled,
      scope: { workspaceId, threadId, engine: "codex" },
      fence: ctx.fenceRollbackEvidence,
      flush: ctx.flushRollbackEvidence,
    });
  } catch (cause) {
    await failPostReconcileTurnStart(ctx, req, {
      workspaceId,
      threadId,
      turnId,
      engine: "codex",
      queueSource: null,
    }, cause);
    return;
  }
  if (!isThreadLifecycleCurrent() || hasActiveThreadTurn(ctx, { workspaceId, threadId })) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: ACTIVE_TURN_CONFLICT_MESSAGE } });
    return;
  }
  const latestPersistedThread = await withApiDatabase(ctx, req.id, () => ctx.db.threads.get(threadId));
  if (!latestPersistedThread || latestPersistedThread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "thread 在压缩前已变化，请刷新后重试。" } });
    return;
  }
  let session;
  try {
    session = await withApiDatabase(ctx, req.id, () => ctx.sessions.getOrCreate(thread));
  } catch (e) {
    const metadata = extractTurnErrorMetadata(e);
    const code = threadAvailabilityErrorCode(e);
    if (code) {
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: { ok: false, code, message: metadata.message },
      });
      return;
    }
    emitConversation(ctx, createTurnErrorEventInputFromError({
      ts: Date.now(),
      workspaceId,
      threadId,
      engine: thread.engine,
      turnId,
      error: e,
    }));
    ctx.send({ t: "api.res", id: req.id, status: 501, body: { ok: false, message: metadata.message } });
    return;
  }

  if (!hasCompactThreadCapability(session)) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 501,
      body: { ok: false, message: "当前线程未启用 Codex app-server 会话压缩能力。" },
    });
    return;
  }

  emitConversation(ctx, { ts: Date.now(), workspaceId, threadId, engine: "codex", type: "turn.started", payload: { turnId } });
  await ctx.flushLocalEvents?.(workspaceId, threadId);

  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: {
      ok: true,
      turnId,
      ...(rollbackReconciled ? { rollbackReconciled: true } : {}),
      ...(rollbackEventSeqBarrier != null ? { rollbackEventSeqBarrier } : {}),
    },
  });

  trackOrdinaryTurnExecution(ctx.sessions, { workspaceId, threadId, turnId, localWorkspaceOnly: ctx.localWorkspaceOnly === true }, async execution => {
    await Promise.resolve().then(async () => {
      ctx.assertAssetExecution?.({ workspaceId, threadId, toolContext: readSharedWorkspaceToolExecutionContext(body) });
      const sources = ctx.assertAssetExecution
        ? await withApiDatabase(ctx, req.id, () => ctx.db.turns.getAssetExecutionAuthorizations(threadId, session.getSessionId?.() ?? latestPersistedThread.sessionId)) : [];
      for (const authorization of sources) ctx.assertAssetExecution!({ workspaceId, threadId, authorization });
      const authorization = sources[0];
      const sharedWorkspaceToolContext: SharedWorkspaceToolExecutionContext | null = authorization
        ? { sharedWorkspaceId: authorization.sharedWorkspaceId, operationId: turnId as SharedWorkspaceToolExecutionContext["operationId"],
          operationKey: "ai.thread.send.personal", toolPolicyKey: "ai.personal.readonly" } : null;
      execution.markProviderDispatch();
      return session.compactThread(
        {
          turnId,
          catalogModel: latestPersistedThread.model,
          accessMode: authorization ? "read-only" : effectiveAccessMode,
          sharedWorkspaceToolContext,
          contextWindow,
          autoCompactPct,
          serviceTier,
          timeoutPolicy: ctx.timeoutPolicy,
        },
        {
          flush: () => ctx.flushLocalEvents?.(workspaceId, threadId) ?? Promise.resolve(),
          conversation: (event) => {
            if (!isThreadLifecycleCurrent()) return;
            emitConversation(ctx, event, () => isRuntimeTurnCurrent(ctx, { workspaceId, threadId, turnId }));
          },
          raw: (event) => {
            if (!isThreadLifecycleCurrent()) return;
            emitRaw(ctx, event);
          },
        },
      );
    })
    .then(async () => {
      await ctx.flushLocalEvents?.(workspaceId, threadId);
      if (!isThreadLifecycleCurrent() || !await withApiDatabase(ctx, req.id, () => isTurnStillStarted(ctx, turnId))) return;
      try {
        await settleTurnTerminalOnce(ctx, {
          workspaceId,
          threadId,
          turnId,
          status: "completed",
        }, {
          buildTerminalEvents: async () => [{
            ts: Date.now(),
            workspaceId,
            threadId,
            engine: "codex",
            type: "turn.completed",
            payload: {
              turnId,
              result: {
                compacted: true,
              },
            },
          } satisfies ConversationEventInput],
          notifyQueue: () => {},
        });
      } catch (settlementError) {
        await reportTurnTerminalSettlementFailure(ctx, {
          requestId: req.id, method: req.method,
          workspaceId,
          threadId,
          turnId,
          engine: "codex",
          outcome: "completed",
          error: settlementError,
        });
        throw settlementError;
      }
    }, async (e) => {
      if (isWorkspaceApiRequestFailure(e)) throw e;
      await writeWorkspaceTurnLog(ctx, "error", "api", "compact execution failed", {
        code: "COMPACT_EXECUTION_FAILED", requestId: req.id, method: req.method, workspaceId, threadId, turnId,
        responseAttempted: true, responseDelivered: true,
      }, { errors: [e] });
      await ctx.flushLocalEvents?.(workspaceId, threadId);
      if (!isThreadLifecycleCurrent() || !await withApiDatabase(ctx, req.id, () => isTurnStillStarted(ctx, turnId))) throw e;
      if (shouldPreserveTurnRunningState(e)) {
        throw e;
      }
      const metadata = extractTurnErrorMetadata(e);
      try {
        if (metadata.terminationKind === "manual_interrupt") {
          await settleManualTurnTerminalOnce(ctx, {
            workspaceId,
            threadId,
            turnId,
            engine: "codex",
            session,
          });
        } else {
          await settleTurnTerminalOnce(ctx, {
            workspaceId,
            threadId,
            turnId,
            status: "error",
          }, {
            buildTerminalEvents: async () => [createTurnErrorEventInput({
              ts: Date.now(),
              workspaceId,
              threadId,
              engine: "codex",
              turnId,
              error: metadata.message,
              code: metadata.code,
              requestMethod: metadata.requestMethod,
              providerThreadId: metadata.providerThreadId,
              recoveryReason: metadata.recoveryReason,
              preserveBinding: metadata.preserveBinding,
              userChoiceRequired: metadata.userChoiceRequired,
              recoveryStrategies: metadata.recoveryStrategies,
              terminationKind: metadata.terminationKind,
            })],
            notifyQueue: () => {},
          });
        }
      } catch (settlementError) {
        await reportTurnTerminalSettlementFailure(ctx, {
          requestId: req.id, method: req.method,
          workspaceId,
          threadId,
          turnId,
          engine: "codex",
          outcome: "error",
          error: aggregateOrdinaryTurnFailures([e, settlementError], "COMPACT_TERMINAL_FAILED"),
        });
        throw aggregateOrdinaryTurnFailures([e, settlementError], "COMPACT_TERMINAL_FAILED");
      }
      throw e;
    });
  });
}

/** 判断当前 Codex 会话是否支持真实 compact turn。 */
function hasCompactThreadCapability(
  session: ThreadEngineSession,
): session is ThreadEngineSession & { compactThread: NonNullable<ThreadEngineSession["compactThread"]> } {
  return typeof session.compactThread === "function";
}

/** 已受理回合可逆等待更新准入；失效或缺失的精确 turn 沿原手动中断结束。 */
async function waitForOrdinaryTurnDispatch(
  ctx: Pick<ApiHandlerContext, "db" | "withDatabase" | "isTaskAdmissionPaused" | "assertAssetExecution">,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId; isThreadLifecycleCurrent: () => boolean; execution: OrdinaryTurnExecutionControl;
    roleId?: RoleId | null; executionAuthorization?: OrchAssetExecutionAuthorization; sharedWorkspaceToolContext?: SharedWorkspaceToolExecutionContext | null },
): Promise<void> {
  while (true) {
    input.execution.assertNotCancelled();
    const turn = await withApiDatabase(ctx, `ordinary-dispatch:${input.turnId}`, () => ctx.db.turns.get(input.turnId));
    if (!input.isThreadLifecycleCurrent() || !turn || turn.status !== "started"
      || turn.workspaceId !== input.workspaceId || turn.threadId !== input.threadId || turn.turnId !== input.turnId) {
      throw Object.assign(new Error("普通回合已中断"), { code: MANUAL_TURN_INTERRUPT_CODE,
        terminationKind: "manual_interrupt", workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId });
    }
    if (!ctx.isTaskAdmissionPaused?.()) {
      await withApiDatabase(ctx, `ordinary-dispatch:${input.turnId}`, () => ctx.assertAssetExecution?.({ workspaceId: input.workspaceId, threadId: input.threadId,
        ...(input.roleId ? { root: { assetType: "role", assetId: input.roleId } } : {}),
        ...(input.executionAuthorization ? { authorization: input.executionAuthorization } : {}), toolContext: input.sharedWorkspaceToolContext }));
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

/** 继续普通会话 turn；开启知识库时必须注册真实工具，再注入对应提示词。 */
async function continueThreadTurnWithManagedServices(
  ctx: ApiHandlerContext,
  input: {
    requestId: string;
    workspaceId: WorkspaceId;
    workspacePath: string;
    threadId: ThreadId;
    turnId: TurnId;
    engine: EngineType;
    session: ThreadEngineSession;
    userItemId: ItemId;
    assistantItemId: string;
    reasoningItemId: string;
    promptText: string;
    displayText: string;
    specificationPaths?: string[];
    inputKind?: ThreadInputKind;
    preparedInputActions: PreparedCodexSkillInput | null;
    roleId: RoleId | null;
    images: string[];
    workMode: "general" | null;
    planMode: boolean;
    accessMode: AccessMode;
    model: string | null;
    effort: string | null;
    contextWindow: number | null;
    autoCompactPct: number | null;
    serviceTier: CodexServiceTier | null;
    executionAuthorization?: OrchAssetExecutionAuthorization;
    sharedWorkspaceToolContext?: SharedWorkspaceToolExecutionContext | null;
    knowledgeConversationActor?: KnowledgeConversationActor | null;
    executionProfileContext?: ThreadExecutionProfileContext | null;
    isThreadLifecycleCurrent: () => boolean;
    execution: OrdinaryTurnExecutionControl;
  },
): Promise<{ responseText: string }> {
  let knowledgeTurn: ReturnType<typeof createKnowledgeConversationTurn> = null;
  let releaseWorkflowDirectory: (() => void) | null = null;
  let executionFailure: { error: unknown } | null = null;
  let knowledgeTerminalEvent: ConversationEventInput | undefined;
  try {
    await waitForOrdinaryTurnDispatch(ctx, input);
    const thread = await withApiDatabase(ctx, input.requestId, () => ctx.db.threads.get(input.threadId));
    const roleRuntime = await withApiDatabase(ctx, input.requestId, () => resolveChatRoleRuntime({
      db: ctx.db, requestId: input.requestId, threadId: input.threadId, turnId: input.turnId,
      assetRuntimeRead: ctx.orchAssetRuntimeRead,
      workspaceId: thread?.workspaceId ?? input.workspaceId,
      workspacePath: input.workspacePath,
      roleId: input.roleId,
      userMessage: input.promptText,
      engine: input.engine,
    }));
    const historicalSources = ctx.assertAssetExecution
      ? await withApiDatabase(ctx, input.requestId, () => ctx.db.turns.getAssetExecutionAuthorizations(input.threadId, input.session.getSessionId?.() ?? thread?.sessionId ?? null)) : [];
    for (const authorization of historicalSources) ctx.assertAssetExecution!({ workspaceId: input.workspaceId, threadId: input.threadId, authorization,
      toolContext: input.sharedWorkspaceToolContext });
    if (thread?.threadType === "chat" && !thread.threadSubtype) {
      releaseWorkflowDirectory = await withApiDatabase(ctx, input.requestId, () => reserveChatWorkflowDirectory(
        ctx,
        input.workspaceId,
        input.threadId,
        input.accessMode === "read-only",
      ));
    }
    const managedServiceToolRegistry = thread?.threadSubtype === "knowledge-conversation"
      ? null
      : await withApiDatabase(ctx, input.requestId, () => ctx.orchEngine.buildManagedServiceToolRegistry(input.accessMode, { includeWhenReadOnly: input.session.engine === "codex" }));
    const roleSkills = await prepareChatRoleSkills(input.workspacePath, roleRuntime, input.engine);
    await waitForOrdinaryTurnDispatch(ctx, input);
    knowledgeTurn = await withApiDatabase(ctx, input.requestId, () => createKnowledgeConversationTurn({
      db: ctx.db,
      store: new KnowledgeAssetStore(input.workspacePath),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      engine: input.engine,
      model: input.model,
      effort: input.effort,
      prompt: input.displayText,
      sharedContext: input.sharedWorkspaceToolContext,
      trustedActor: input.knowledgeConversationActor,
      isActive: () => input.isThreadLifecycleCurrent() && isRuntimeTurnCurrent(ctx, input),
    }));
    const chatWorkflowEnabled = thread?.threadType === "chat" && !thread.threadSubtype;
    const workflowService = chatWorkflowEnabled ? new ChatWorkflowService(ctx) : null;
    const workflowSnapshot = await withApiDatabase(ctx, input.requestId, () => workflowService?.snapshot(
      input.workspaceId,
      input.threadId,
      input.executionProfileContext?.userId ?? "",
    ));
    const workspaceKnowledge = knowledgeTurn
      ? { systemRule: null, requiredWorkspaceSkills: [], knowledgeAssetTools: null, specifications: undefined }
      : resolveWorkspaceKnowledgeChatContext({
        workspacePath: input.workspacePath,
        engine: input.engine,
        enabled: thread?.knowledgeEnabled === true,
        paths: input.specificationPaths,
      });
    const toolRegistry = mergeExecutableToolRegistries(
      roleRuntime?.toolRegistry,
      managedServiceToolRegistry,
      knowledgeTurn?.registry ?? workspaceKnowledge.knowledgeAssetTools ?? null,
      chatWorkflowEnabled ? buildChatWorkflowToolRegistry() : null,
    );
    const platformToolTransportRequirement = roleRuntime?.requiresRoleToolTransport || knowledgeTurn || workspaceKnowledge.knowledgeAssetTools ? "required" : "optional";
    const specificationTurn = workspaceKnowledge.specifications ? createKnowledgeSpecificationTurn({
      store: new KnowledgeAssetStore(input.workspacePath), specifications: workspaceKnowledge.specifications,
      workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId, engine: input.engine,
      userRequirements: await withApiDatabase(ctx, input.requestId, () => [input.promptText, ...ctx.db.conversationEvents.listByThreadType(input.threadId, "item.userMessage.created", { limit: 100 }).map(event => (event.payload as { text?: string }).text ?? "")].join("\n\n")),
      isActive: () => input.isThreadLifecycleCurrent() && isRuntimeTurnCurrent(ctx, input),
      emit: event => emitConversation(ctx, event),
    }) : null;
    const suggestions = createKnowledgeSuggestionTurn({
      store: new KnowledgeAssetStore(input.workspacePath),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      engine: input.engine,
      origin: "chat",
      canPropose: Boolean(input.knowledgeConversationActor),
      specificationTurn,
      isActive: () => input.isThreadLifecycleCurrent() && isRuntimeTurnCurrent(ctx, input),
      emit: event => emitConversation(ctx, event),
    });
    const toolTransport = await withApiDatabase(ctx, input.requestId, () =>
      input.session.resolvePlatformToolTransport(toolRegistry, platformToolTransportRequirement));
    if (knowledgeTurn && toolTransport !== "native-dynamic") throw new Error("当前会话不支持知识提交工具，请切换支持平台工具的引擎会话。");
    if (workspaceKnowledge.knowledgeAssetTools && toolTransport !== "native-dynamic") {
      throw new KnowledgeAssetError("KNOWLEDGE_TOOL_TRANSPORT_UNAVAILABLE", "当前引擎会话不支持知识库工具，请切换支持平台工具的引擎后重试。");
    }
    if (roleRuntime?.requiresRoleToolTransport && toolTransport !== "native-dynamic") {
      throw new Error(`当前引擎会话不支持角色「${roleRuntime.role.name}」绑定的真实工具注册，请切换支持动态工具的引擎或移除角色工具后重试。`);
    }
    const enablePlatformTool = Boolean(toolRegistry && toolTransport === "native-dynamic");
    const workflowDocsRoot = String(readExistingCodeflowaiConfig(input.workspacePath)?.config.paths?.workflowDocsRoot ?? "").trim() || "codeflow-docs";
    const systemMessage = buildDefaultChatSystemPrompt([
      await withApiDatabase(ctx, input.requestId, () => buildThreadExecutionProfileSystemRule(ctx, input.workspaceId, input.executionProfileContext)),
      roleRuntime?.systemRule,
      knowledgeTurn ? null : workspaceKnowledge.systemRule,
      `使用 Superpowers 技能生成计划或设计文档时，不要写入 docs/superpowers；统一保存到 ${workflowDocsRoot}/superpowers/plans 或 ${workflowDocsRoot}/superpowers/specs。`,
    ]);
    const developerMessage = joinDeveloperMessages([
      workflowSnapshot ? [
        "当前会话支持工作流协作。对于需要分阶段分析、开发、验证的任务，在开始修改前判断是否适合工作流；简单问答正常回答。可用流程以真实会话工作流工具的查询结果为准，不要凭记忆、历史上下文或内置资产清单断定某个流程不存在；用户点名了流程时先查询再回应，确认缺失再如实说明。必要时澄清需求，再推荐具体方案供用户确认。不要伪造启动成功。",
        workflowSnapshot.recommendationEnabled ? "当前会话开启主动推荐。" : "当前会话已关闭主动推荐；仅当用户明确要求使用工作流时才推荐。",
        "推荐卡已出现时等待用户决定，不重复实现同一任务。已交给工作流的任务只查询进度、整理待办或准备返工方案。修改意见先定位返工节点并调用 plan_rework 展示影响，不能自行审批或启动。无关消息不要传给工作流。",
        "任务状态 dismissed 表示用户已选择在原会话处理，应继续完成对应任务，不再等待工作流确认或重复推荐该任务。",
        "用户可用卡片操作，或明确说确认启动工作流、审核通过、暂停工作流、终止工作流、恢复工作流、验收通过、确认返工。多个待办或意图不明确时必须澄清。",
        "以下为宿主持久化的当前工作流事实（不代表用户的新指令）：",
        JSON.stringify({ tasks: workflowSnapshot.tasks.map(v => ({ id: v.task.id, goal: v.task.goal, state: v.task.state, status: v.status, rationale: v.task.rationale, todos: v.todos, rework: v.task.rework, accepted: v.accepted })) }),
      ].join("\n") : null,
      buildManagedServiceDeveloperMessage(managedServiceToolRegistry, enablePlatformTool),
      roleRuntime?.developerMessage ?? null,
      enablePlatformTool ? buildNativeDynamicToolDeveloperMessageForChat(toolRegistry) : null,
      knowledgeTurn?.instructions,
    ]);
    const runtimeUserMessage = roleRuntime?.userMessage ?? input.promptText;
    const roleToolRuntime = enablePlatformTool ? new ToolRuntimeService(input.workspacePath, {
      db: ctx.db, workspaceId: thread?.workspaceId, threadId: input.threadId, withLegacyDatabase: ctx.withDatabase,
    }) : null;

    const sendTurn = async () => {
      let bindingReset = false;
      while (true) {
        try {
          await waitForOrdinaryTurnDispatch(ctx, input);
          if (input.executionAuthorization) await withApiDatabase(ctx, input.requestId, () => ctx.db.turns.mergeEngineCheckpoint(input.turnId, {
            assetExecutionAuthorization: input.executionAuthorization,
            assetExecutionEngineSessionId: input.session.getSessionId?.() ?? null,
          }));
          input.execution.markProviderDispatch();
          return await input.session.sendMessage({
            turnId: input.turnId,
            userItemId: input.userItemId,
            text: input.displayText,
            inputKind: input.inputKind,
            preparedInputActions: input.preparedInputActions,
            userMessage: runtimeUserMessage,
            systemMessage,
            developerMessage,
            toolRegistryJson: enablePlatformTool && toolRegistry ? JSON.stringify(toolRegistry) : null,
            toolRegistry: enablePlatformTool ? toolRegistry : null,
            executeHostTool: enablePlatformTool
              ? async ({ toolId, toolInput, accessMode }) => {
                const tool = toolRegistry?.tools.find(item => String(item.toolId) === String(toolId)) ?? null;
                if (!tool) return { ok: false, code: "TOOL_NOT_FOUND", message: `未注册的平台工具：${toolId}`, output: { code: "TOOL_NOT_FOUND", toolId }, durationMs: 0 };
                const decision = evaluateSharedWorkspaceHostToolPolicy({ context: input.sharedWorkspaceToolContext, tool, toolInput });
                if (!decision.allowed) return sharedWorkspaceToolDeniedResult(decision);
                if (String(tool.toolId) === CHAT_WORKFLOW_TOOL_ID) {
                  return await withApiDatabase(ctx, input.requestId, () => executeChatWorkflowTool(ctx, { workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId, actorUserId: input.executionProfileContext?.userId ?? "" }, toolInput));
                }
                if (String(tool.toolId) === MANAGED_SERVICE_TOOL_ID) {
                  return toHostToolExecutionResult(await ctx.orchEngine.executeManagedServiceToolForThread({ threadId: input.threadId, workspacePath: input.workspacePath, toolId, toolInput, accessMode }));
                }
                if (String(tool.toolId).startsWith("knowledge.")) {
                  try { return await withApiDatabase(ctx, input.requestId, () => knowledgeTurn ? knowledgeTurn.execute(String(tool.toolId), toolInput) : suggestions.execute(String(tool.toolId), toolInput)); }
                  catch (error) {
                    await writeWorkspaceTurnLog(ctx, "error", "knowledge-assets", "ordinary chat project knowledge tool failed", { code: knowledgeFailure(error).code, requestId: input.requestId, workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId, toolId: String(tool.toolId), responseAttempted: true, responseDelivered: true }, { errors: [error] });
                    return { ok: false, ...knowledgeFailure(error), output: { requestId: input.turnId } };
                  }
                }
                if (!roleToolRuntime) return { ok: false, code: "TOOL_RUNTIME_UNAVAILABLE", message: `当前会话未启用角色工具运行时：${toolId}`, output: { code: "TOOL_RUNTIME_UNAVAILABLE", toolId }, durationMs: 0 };
                return toRoleToolHostResult(await roleToolRuntime.execute(tool, toolInput, accessMode, { requestId: input.requestId, turnId: input.turnId }));
              }
              : null,
            sharedWorkspaceToolContext: input.sharedWorkspaceToolContext ?? null,
            platformToolTransportRequirement,
            responseFormat: "text",
            providerNativeToolPolicy: "allow",
            requiredWorkspaceSkills: [...workspaceKnowledge.requiredWorkspaceSkills, ...roleSkills],
            conversationProfile: knowledgeTurn?.conversationProfile ?? "default",
            workMode: input.workMode,
            planMode: input.planMode,
            images: input.images,
            accessMode: input.accessMode,
            model: input.model,
            effort: input.effort,
            contextWindow: input.contextWindow,
            autoCompactPct: input.autoCompactPct,
            serviceTier: input.serviceTier,
            assistantItemId: input.assistantItemId,
            reasoningItemId: input.reasoningItemId,
            timeoutPolicy: ctx.timeoutPolicy,
          }, {
            flush: () => ctx.flushLocalEvents?.(input.workspaceId, input.threadId) ?? Promise.resolve(),
            conversation: event => {
              if (!input.isThreadLifecycleCurrent()) return;
              emitConversation(ctx, event, () => {
                if (!isRuntimeTurnCurrent(ctx, input)) return false;
                specificationTurn?.observe(event);
                if (event.type === "turn.completed" || event.type === "turn.error") knowledgeTerminalEvent = event;
                return true;
              });
            },
            raw: event => {
              if (!input.isThreadLifecycleCurrent()) return;
              emitRaw(ctx, event);
            },
          });
        } catch (error) {
          if (!knowledgeTurn && workspaceKnowledge.knowledgeAssetTools && input.engine === "codex" && String((error as { code?: unknown } | null)?.code ?? "").trim() === "codex_thread_capability_incompatible") {
            const providerThreadId = input.session.getSessionId();
            await writeWorkspaceTurnLog(ctx, "error", "knowledge-assets", "ordinary chat knowledge tools require a new provider session", {
              code: "KNOWLEDGE_TOOLS_REQUIRE_NEW_SESSION", requestId: input.requestId,
              workspaceId: input.workspaceId, threadId: input.threadId, providerThreadId,
              turnId: input.turnId, responseAttempted: true, responseDelivered: true,
            }, { errors: [error] });
            throw Object.assign(new KnowledgeAssetError("KNOWLEDGE_TOOLS_REQUIRE_NEW_SESSION", "当前 Codex 会话无法追加本轮知识库工具，请新建会话后重试。"), { cause: error, providerThreadId, preserveBinding: true });
          }
          if (!knowledgeTurn || bindingReset || input.engine !== "codex" || String((error as { code?: unknown } | null)?.code ?? "").trim() !== "codex_thread_capability_incompatible") throw error;
          await waitForOrdinaryTurnDispatch(ctx, input);
          const staleProviderThreadId = input.session.getSessionId();
          let rotated = false;
          try { rotated = input.session.resetDynamicToolBinding?.() === true; }
          catch (rotationError) {
            await writeWorkspaceTurnLog(ctx, "error", "knowledge-assets", "interactive Codex dynamic tool binding rotation failed", { code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_FAILED", requestId: input.requestId, workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId, providerThreadId: staleProviderThreadId, activeTurnId: input.session.getActiveTurnId?.() ?? null, responseAttempted: true, responseDelivered: true }, { errors: [error, rotationError] });
            throw rotationError;
          }
          if (!rotated) {
            await writeWorkspaceTurnLog(ctx, "error", "knowledge-assets", "interactive Codex dynamic tool binding cannot be rotated safely", { code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_REJECTED", requestId: input.requestId, workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId, providerThreadId: staleProviderThreadId, activeTurnId: input.session.getActiveTurnId?.() ?? null, responseAttempted: true, responseDelivered: true }, { errors: [error] });
            throw error;
          }
          bindingReset = true;
          await writeWorkspaceTurnLog(ctx, "warn", "knowledge-assets", "stale Codex dynamic tool binding rotated for interactive knowledge turn", { code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATED", requestId: input.requestId, workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId, providerThreadId: staleProviderThreadId, responseAttempted: true, responseDelivered: true }, { errors: [error] });
        }
      }
    };
    const result = await sendTurn();
    specificationTurn?.provided();
    await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);
    if (!input.isThreadLifecycleCurrent() || !await withApiDatabase(ctx, input.requestId, () => isTurnStillStarted(ctx, input.turnId))) {
      throw Object.assign(new Error("普通回合已中断"), { code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt",
        workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId });
    }
    return { responseText: String(result.responseText ?? "").trim() };
  } catch (error) {
    executionFailure = { error };
    throw error;
  } finally {
    const failures: unknown[] = [];
    try { await withApiDatabase(ctx, input.requestId, () => {
      if (knowledgeTerminalEvent) settleKnowledgeConversationEvent(knowledgeTurn, input.turnId, knowledgeTerminalEvent);
      else knowledgeTurn?.finish(executionFailure?.error, !input.isThreadLifecycleCurrent() || !isTurnStillStarted(ctx, input.turnId));
    }); }
    catch (error) { failures.push(error); }
    if (executionFailure && input.preparedInputActions) {
      try { input.session.releasePreparedInputActions?.(input.preparedInputActions); } catch (error) { failures.push(error); }
    }
    try { releaseWorkflowDirectory?.(); } catch (error) { failures.push(error); }
    if (failures.length) {
      if (executionFailure) failures.unshift(executionFailure.error);
      if (failures.length === 1) throw failures[0];
      throw aggregateOrdinaryTurnFailures(failures, "ORDINARY_TURN_CLEANUP_FAILED");
    }
  }
}

/** 聚合保留原错误值与执行根因的未知 provider 标记，禁止清理失败制造终态。 */
function aggregateOrdinaryTurnFailures(failures: unknown[], code: string): AggregateError {
  return Object.assign(new AggregateError(failures, code, { cause: failures[0] }),
    isSkillRuntimeDiagnosticFailure(failures[0]) ? { code: "SKILL_RUNTIME_FAILURE_LOG_FAILED", retryable: false } : {},
    shouldPreserveTurnRunningState(failures[0]) ? { preserveRunningState: true } : {});
}

/** 只识别本片自有 data code，未知 getter 不参与分流。 */
function isSkillRuntimeDiagnosticFailure(error: unknown): boolean {
  if (!(error instanceof AggregateError)) return false;
  const code = Object.getOwnPropertyDescriptor(error, "code");
  return Boolean(code && "value" in code && code.value === "SKILL_RUNTIME_FAILURE_LOG_FAILED");
}

/** 合并多段 developer 提示，保留真实消息层，不塞进 user message。 */
function joinDeveloperMessages(messages: Array<string | null | undefined>): string | null {
  const text = messages.map((item) => String(item ?? "").trim()).filter(Boolean).join("\n\n");
  return text || null;
}

function buildManagedServiceDeveloperMessage(
  toolRegistry: ManagedServiceToolRegistry | null,
  enablePlatformTool: boolean,
): string | null {
  if (!toolRegistry?.tools.length) return null;
  const tool = toolRegistry.tools[0]!;
  if (enablePlatformTool) {
    return [
      "当前会话额外提供一个平台动作，用来管理当前聊天窗口里持续存活的进程。",
      "一次性命令、读取文件、搜索代码这类普通动作，继续优先使用引擎原生能力。",
      "如果某个持续存活的本地进程需要被页面里的“进程”区统一查看、停止、跨刷新保留，或者用户明确要求使用页面里的“进程”能力，必须直接调用下面这个已注册的平台动作。",
      "如果只是当前回合内部的临时后台终端，不要求纳入页面“进程”区统一管理，也不要求平台托管保活，可以继续使用引擎原生终端/命令能力。",
      `已注册动作: ${tool.toolId}`,
      `显示名称: ${tool.alias || tool.name}`,
      `说明: ${tool.description}`,
      String(tool.usageGuidance ?? "").trim() ? `使用边界: ${String(tool.usageGuidance ?? "").trim()}` : "",
      String(tool.invocationHint ?? "").trim() ? `调用提示:\n${String(tool.invocationHint ?? "").trim()}` : "",
      "如果需要这项平台能力，请直接调用已注册真实工具；不要通过 assistant 文本输出任何 JSON 协议。",
    ].filter(Boolean).join("\n\n");
  }
  return [
    "当前 provider 尚未启用这项平台托管进程能力。",
    "您仍可继续完成普通聊天、读文件、搜索代码和一次性命令等通用动作。",
    `如果用户明确要求使用页面里的“进程”能力，请直接说明当前会话无法调用真实工具 ${tool.toolId}，不要伪造平台动作，也不要输出任何 assistant 文本 JSON 协议。`,
  ].join("\n\n");
}

function toHostToolExecutionResult(result: Awaited<ReturnType<OrchestrationEngine["executeManagedServiceToolForThread"]>>): HostToolExecutionResult {
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

/** 转换角色工具运行结果为引擎会话统一的 host tool 返回值。 */
function toRoleToolHostResult(result: ToolExecutionResult): HostToolExecutionResult {
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
      stage: result.stage,
      retryable: result.retryable,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
      exitCode: result.exitCode ?? null,
    },
    durationMs: result.durationMs ?? null,
  };
}

function findWaitingFeedbackNodeBinding(
  ctx: ApiHandlerContext,
  threadId: ThreadId,
  options?: { includeExecution?: boolean },
): { instanceId: OrchestrationId; nodeId: string } | null {
  const binding = resolveOrchestrationNodeQueueBinding(ctx, threadId, (candidate) => {
    if (candidate.status !== "waiting-feedback") return false;
    const isExecutionBinding = candidate.humanActionSource === "execution";
    if (!options?.includeExecution && isExecutionBinding) return false;
    return true;
  });
  if (!binding) return null;
  return {
    instanceId: binding.instanceId,
    nodeId: binding.nodeId,
  };
}

function findActiveOrchestrationNodeBinding(
  ctx: ApiHandlerContext,
  threadId: ThreadId,
): { instanceId: OrchestrationId; nodeId: string } | null {
  const binding = resolveOrchestrationNodeQueueBinding(ctx, threadId, (candidate) => isOrdinaryChatBlockedNodeStatus(candidate.status));
  if (!binding) return null;
  return {
    instanceId: binding.instanceId,
    nodeId: binding.nodeId,
  };
}

function isOrdinaryChatBlockedNodeStatus(status: unknown): boolean {
  const normalized = String(status ?? "").trim();
  return normalized === "pending"
    || normalized === "ready"
    || normalized === "queued"
    || normalized === "running"
    || normalized === "result-submitted"
    || normalized === "finalizing"
    || normalized === "artifact-writing"
    || normalized === "gate-checking"
    || normalized === "waiting-start"
    || normalized === "waiting-approval";
}

/** 规范化 @ 路径引用；引用是可选上下文提示，不在发送入口校验文件是否仍存在。 */
function normalizePathReferencesForSend(raw: unknown): WorkspacePathReference[] {
  return normalizeWorkspacePathReferenceList(raw).map((ref) => createWorkspacePathReference(ref));
}

/** 停止证明先回draining，原请求仍等待保存尾链；已响应后失败不可再发第二个响应。 */
async function onTurnsInterrupt(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const turnId = String((req.body as any)?.turnId ?? "").trim();
  if (!workspaceId || !threadId || !turnId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/turnId" } });
    return;
  }
  let responded = false;
  try {
    const result = await interruptTurnBestEffort(
      ctx,
      { workspaceId, threadId, turnId: turnId as TurnId },
      { ensureTerminalEvent: true, onStopConfirmed() {
        if (responded) return;
        const active = ctx.getActiveThreadTurn?.({ workspaceId, threadId, includeDb: false });
        ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, phase: "draining", running: {
          runningTurnId: turnId, runningTurnStartedAt: active?.startedAt ?? Date.now(), runningSource: "runtime", phase: "draining",
        } } });
        responded = true;
      } },
    );
    if (!responded) ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result, phase: "completed" } });
  } catch (error) {
    await writeWorkspaceTurnLog(ctx, "error", "api", "turn interrupt request failed", {
      errorCode: "TURN_INTERRUPT_REQUEST_FAILED",
      requestId: req.id, method: req.method,
      workspaceId,
      threadId,
      turnId,
    }, { errors: [error] });
    ctx.onApiFailureLogged?.();
    if (responded) throw new WorkspaceApiRequestFailure([error], { code: "TURN_INTERRUPT_FINALIZATION_FAILED", requestId: req.id,
      workspaceId, method: req.method, responseAttempted: true, responseDelivered: true });
    throw error;
  }
}

/** 判断 turn 是否仍可写终态；手动中断可能已经先行补齐 terminal。 */
function isTurnStillStarted(ctx: Pick<ApiHandlerContext, "db">, turnId: TurnId): boolean {
  const existing = ctx.db.turns.get(turnId);
  return !existing || existing.status === "started";
}

/** provider同步回调只读原运行态；终态判定另在flush后经数据库许可复验。 */
function isRuntimeTurnCurrent(ctx: Pick<ApiHandlerContext, "db" | "withDatabase" | "getActiveThreadTurn">,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId }): boolean {
  if (!ctx.withDatabase) return isTurnStillStarted(ctx, input.turnId);
  if (!ctx.getActiveThreadTurn) throw new Error("ORDINARY_TURN_RUNTIME_OWNER_REQUIRED");
  return ctx.getActiveThreadTurn({ workspaceId: input.workspaceId, threadId: input.threadId, includeDb: false })?.turnId === input.turnId;
}

/** 新 turn 启动前重试上个回合固定的终态阶段，失败时明确终止当前 API。 */
async function retryPendingTerminalBeforeNewTurn(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
): Promise<boolean> {
  try {
    await retryPendingTurnTerminal(ctx, input);
    return true;
  } catch (error) {
    await writeWorkspaceTurnLog(ctx, "error", "api", "pending turn terminal retry failed; rejecting new turn", {
      code: "ORDINARY_TURN_TERMINAL_RETRY_FAILED",
      requestId: req.id, method: req.method,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
    }, { errors: [error] });
    ctx.onApiFailureLogged?.();
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: {
        ok: false,
        message: `上个回合的终态同步重试失败：${error instanceof Error ? error.message : String(error)}`,
      },
    });
    return false;
  }
}

/** 记录终态阶段失败并保留可自动重试的 pending 状态。 */
async function reportTurnTerminalSettlementFailure(
  ctx: ApiHandlerContext,
  input: {
    requestId: string;
    method?: string;
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    engine: EngineType;
    outcome: "completed" | "error";
    error: unknown;
  },
): Promise<void> {
  await writeWorkspaceTurnLog(ctx, "error", "api", "turn terminal settlement failed; keeping pending retry state", {
    code: "ORDINARY_TURN_TERMINAL_FAILED",
    requestId: input.requestId, method: input.method,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    outcome: input.outcome,
    responseAttempted: true, responseDelivered: true,
  }, { errors: [input.error] });
  emitConversation(ctx, {
    ts: Date.now(),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: input.engine,
    type: "system.notice",
    payload: {
      level: "error",
      text: "回合终态同步未完成；下一次发送或压缩前会自动重试。若持续失败，请查看客户端日志。",
    },
  } satisfies ConversationEventInput);
}

/** 自动回滚后的启动事件无法耐久化时，显式终结本地 turn 且禁止启动 provider。 */
async function failPostReconcileTurnStart(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  input: {
    workspaceId: WorkspaceId;
    threadId: ThreadId;
    turnId: TurnId;
    engine: EngineType;
    queueSource: { queueItemId: string } | null;
  },
  cause: unknown,
): Promise<void> {
  const reason = describeWorkspaceApiFailure(cause).message;
  const code = "rollback_reconcile_event_durability_failed";
  await writeWorkspaceTurnLog(ctx, "error", "api", "post-reconcile turn start durability failed", {
    code,
    requestId: req.id, method: req.method,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
  }, { errors: [cause] });
  try {
    await settleTurnTerminalOnce(ctx, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      status: "error",
    }, {
      buildTerminalEvents: async () => [createTurnErrorEventInput({
        ts: Date.now(),
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engine: input.engine,
        turnId: input.turnId,
        error: `自动回滚后新回合事件持久化失败：${reason}`,
        code,
        terminationKind: "error",
      })],
      afterTerminalEvents: async () => {
        await waitForPostReconcileEventDurability({
          rollbackReconciled: true,
          scope: {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            engine: input.engine,
          },
          fence: ctx.fenceRollbackEvidence,
          flush: ctx.flushRollbackEvidence,
        });
      },
      notifyQueue: () => {
        // queue consume 的非 200 响应由 executeQueueSend 唯一收口，避免重复 failed 广播。
        if (input.queueSource) return;
        ctx.queueDispatcher?.notifyTurnTerminal({
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          turnId: input.turnId,
          source: "user_send",
          queueItemId: null,
          outcome: "error",
          terminationKind: "error",
          errorCode: code,
        });
      },
    });
  } catch (settlementError) {
    await reportTurnTerminalSettlementFailure(ctx, {
      requestId: req.id, method: req.method,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      engine: input.engine,
      outcome: "error",
      error: aggregateOrdinaryTurnFailures([cause, settlementError], "ORDINARY_TURN_START_TERMINAL_FAILED"),
    });
    throw aggregateOrdinaryTurnFailures([cause, settlementError], "ORDINARY_TURN_START_TERMINAL_FAILED");
  }
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 503,
    body: {
      ok: false,
      code,
      message: `自动回滚已完成，但新回合启动事件未能持久化，AI 回合未启动：${reason}`,
    },
  });
}

/** 识别 provider 启动结果未知的失败；此类错误不得伪造本地 terminal。 */
function shouldPreserveTurnRunningState(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as any).preserveRunningState === true);
}

/** 本机事件准入、索引与发送复用同步连接；拒绝准入后停止后续副作用。 */
function emitConversation(ctx: ApiHandlerContext, event: ConversationEventInput, beforeEmit?: () => boolean): WsSendJsonResult | void {
  const emit = (): WsSendJsonResult | void => {
    if (beforeEmit && !beforeEmit()) return;
    if (ctx.onBeforeEmitConversationEvent) ctx.onBeforeEmitConversationEvent(event);
    return ctx.send({ t: "conversation.event", event }) as unknown as WsSendJsonResult | void;
  };
  return ctx.localWorkspaceOnly === true && !ctx.withDatabase ? ctx.db.withWorkspaceCoreRepos(event.workspaceId, emit) : emit();
}

function emitRaw(ctx: ApiHandlerContext, event: RawEngineEventInput): void {
  ctx.send({ t: "raw.event", event });
}

/** 按可信入口装配服务，沿原 emitConversation 保留通知投递结果。 */
function createRequirementAnalysisService(ctx: ApiHandlerContext): RequirementAnalysisService {
  return new RequirementAnalysisService({
    db: ctx.db,
    intakeWorkspaceScope: ctx.intakeWorkspaceScope,
    withLegacyDatabase: ctx.withDatabase,
    orchAssetRuntimeRead: ctx.orchAssetRuntimeRead,
    threads: ctx.threads,
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    timeoutPolicy: ctx.timeoutPolicy,
    emitConversation: (event) => emitConversation(ctx, event),
    emitRaw: (event) => emitRaw(ctx, event),
  });
}

/** 创建资产草案服务，复用当前 API 上下文的真实会话事件出口。 */
function createAssetDraftService(ctx: ApiHandlerContext): AssetDraftService {
  return new AssetDraftService({
    db: ctx.db,
    withLegacyDatabase: ctx.withDatabase,
    flushLocalEvents: ctx.flushLocalEvents,
    workspaces: ctx.workspaces,
    threads: ctx.threads,
    sessions: ctx.sessions,
    timeoutPolicy: ctx.timeoutPolicy,
    emitConversation: (event) => emitConversation(ctx, event),
    emitRaw: (event) => emitRaw(ctx, event),
  });
}

/** 将草案会话续写错误返回给统一 sendMessage 调用方。 */
function sendAssetDraftThreadSendError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): void {
  if (error instanceof AssetDraftServiceError) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: error.status,
      body: error.details === undefined
        ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, code: "INTERNAL_ERROR", message } });
}

function parseAccessMode(v: unknown): AccessMode | null {
  const s = String(v ?? "").trim();
  if (s === "read-only" || s === "current" || s === "full-access") return s;
  return null;
}

function parseWorkMode(v: unknown): "general" | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s === "general") return s;
  return null;
}

/** 只接受产品开放的 Codex Fast 档位；其它值按标准档处理。 */
function parseServiceTier(v: unknown): CodexServiceTier | null {
  return v === "fast" ? "fast" : null;
}

/** 归一化普通聊天角色 ID；空值表示本轮不启用角色注入。 */
function parseRoleId(v: unknown): RoleId | null {
  const text = String(v ?? "").trim();
  return text ? (text as RoleId) : null;
}

