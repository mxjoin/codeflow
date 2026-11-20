import type { AccountRole } from "./account.js";

/** 项目知识按用途分三类，正文与引用沿用同一资产协议。 */
export const KNOWLEDGE_ASSETS_ROOT = "codeflow-docs/规格知识库";
export const KNOWLEDGE_ASSETS_SCHEMA = 3;
/** 八份规格文档固定提供节点与职责，正文只保存有依据的项目要求。 */
export const KNOWLEDGE_SPECIFICATION_DOCUMENTS = [
  { id: "knowledge-spec-project", title: "项目约定", summary: "项目特有的开发原则、变更边界、依赖引入要求，以及用户确认的长期约定。" },
  { id: "knowledge-spec-coding", title: "编码规范", summary: "分层要求、错误处理、日志、异步处理等容易写错的项目规则。" },
  { id: "knowledge-spec-ui", title: "界面规范", summary: "配色与明暗主题、字体与字号、间距、圆角与阴影，以及组件复用、布局、交互、空态、响应式与无障碍要求。" },
  { id: "knowledge-spec-api", title: "接口规范", summary: "参数校验、响应与错误约定、接口兼容要求。" },
  { id: "knowledge-spec-data", title: "数据规范", summary: "数据库设计、迁移、事务、数据归属及一致性要求。" },
  { id: "knowledge-spec-business", title: "业务约束", summary: "不允许破坏的业务条件，例如订单状态转换、金额精度和重复结算限制。" },
  { id: "knowledge-spec-security", title: "安全规范", summary: "权限隔离、敏感信息处理、生产操作授权边界。" },
  { id: "knowledge-spec-delivery", title: "交付规范", summary: "修改后必须执行的验证、验收条件、文档和提交要求。" },
] as const;
/** 架构默认文档共用名称与内容边界，其他专题由用户按需创建。 */
export const KNOWLEDGE_ARCHITECTURE_DOCUMENTS = [
  { id: "knowledge-architecture-overview", title: "架构总览", summary: "结合代码和现行文档梳理系统用途、核心模块职责与依赖、运行与部署关系、通信方式、主要存储和关键源码入口；用架构图说明系统如何组成。" },
  { id: "knowledge-architecture-core-flows", title: "核心流程", summary: "从代码和文档发现最重要的几条流程，沿真实调用链核对触发入口、跨模块执行、关键状态变化、持久化位置及成功和失败结果；复杂链路用流程图说明。" },
  { id: "knowledge-architecture-key-mechanisms", title: "关键机制", summary: "深入核对代码和文档中实际存在且容易误改的权限隔离、并发与锁、事务与一致性、异步任务、重试和恢复机制；说明生效条件、实现边界及修改注意点。" },
] as const;
/** 默认文档共用节点身份和归属，空节点不代表已生成正文。 */
export const KNOWLEDGE_DEFAULT_DOCUMENTS = [
  ...KNOWLEDGE_SPECIFICATION_DOCUMENTS.map((document, index) => ({ ...document, parentId: "knowledge-specifications", orderKey: String(index) })),
  ...KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map((document, index) => ({ ...document, parentId: "knowledge-architecture", orderKey: String(index) })),
];
export const KNOWLEDGE_CATEGORIES = [
  { category: "specifications", id: "knowledge-specifications", title: "规格约束", summary: "修改项目时需要遵守的已确认要求。", contents: KNOWLEDGE_SPECIFICATION_DOCUMENTS.map(document => document.title) },
  { category: "architecture", id: "knowledge-architecture", title: "系统架构", summary: "跨文件理解后才能掌握、修改时容易破坏的稳定机制。", contents: KNOWLEDGE_ARCHITECTURE_DOCUMENTS.map(document => document.title) },
  { category: "product", id: "knowledge-product", title: "产品文档", summary: "保留原始资料，按问题检索并引用原文。", contents: ["产品与需求说明", "业务规则与领域知识", "操作与使用手册", "接口与集成资料"] },
] as const;
export type KnowledgeCategory = typeof KNOWLEDGE_CATEGORIES[number]["category"];

/** 实际提供给引擎的正式规格；引用正文以当次读取指纹为准。 */
export type KnowledgeSpecificationRules = {
  paths?: string[];
  rules: Array<{ nodeId: string; title: string; appliesTo: string[]; content: string; path: string; contentHash: string; revisionId: string | null }>;
  scoped: Array<{ nodeId: string; title: string; appliesTo: string[] }>;
};

export const KNOWLEDGE_ASSET_ERROR_CODES = [
  "KNOWLEDGE_ASSET_CONFLICT",
  "KNOWLEDGE_ASSET_ENGINE_FAILED",
  "KNOWLEDGE_ASSET_ENGINE_UNSUPPORTED",
  "KNOWLEDGE_ASSET_FILE_INVALID",
  "KNOWLEDGE_ASSET_INPUT_INVALID",
  "KNOWLEDGE_ASSET_INPUT_REQUIRED",
  "KNOWLEDGE_ASSET_INTERRUPT_FAILED",
  "KNOWLEDGE_ASSET_INTERRUPTED",
  "KNOWLEDGE_ASSET_IO_FAILED",
  "KNOWLEDGE_ASSET_READ_LIMIT_REACHED",
  "KNOWLEDGE_ASSET_LOCKED",
  "KNOWLEDGE_ASSET_NO_SUBMISSION",
  "KNOWLEDGE_ASSET_NOT_FOUND",
  "KNOWLEDGE_ASSET_PATH_INVALID",
  "KNOWLEDGE_ASSET_PERMISSION_DENIED",
  "KNOWLEDGE_ASSET_RATE_LIMITED",
  "KNOWLEDGE_ASSET_SCOPE_INVALID",
  "KNOWLEDGE_ASSET_SOURCE_CHANGED",
  "KNOWLEDGE_ASSET_TOOL_UNKNOWN",
  "KNOWLEDGE_ASSET_TREE_INVALID",
  "KNOWLEDGE_ASSET_VERSION_UNSUPPORTED",
  "KNOWLEDGE_SEARCH_INDEX_FAILED",
  "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED",
] as const;
export type KnowledgeAssetErrorCode = (typeof KNOWLEDGE_ASSET_ERROR_CODES)[number];

/** Server 写入并由 Client 校验的账号与共享工作区身份。 */
export type KnowledgeAssetActorContext = {
  userId: string;
  accountRole: AccountRole;
  enterpriseId: string | null;
  requestId: string;
  permissionScope: "account" | "shared_member" | "shared_asset_admin";
};

/** 新项目资产知识运行模式。 */
export type KnowledgeAssetRuntimeMode = "project_assets_v1";

export type KnowledgeAssetNode = {
  id: string;
  parentId: string | null;
  title: string;
  orderKey: string;
  summary: string;
  tags: string[];
  instructions: string;
  /** 项目内候选来源与维护线索，不是代码和文档的读取白名单。 */
  sourceScope: string[];
  /** 仅一级目录声明用途；子节点继承分类。 */
  category?: KnowledgeCategory;
  /** 规格约束适用的项目相对文件或目录；空数组表示整个项目，省略则继承。 */
  appliesTo?: string[];
  /** 旧节点省略时沿用正文语义；新规划必须明确用途。 */
  contentMode?: "directory" | "reference" | "generated";
  reference?: { path: string; adoptedContentHash: string };
  archived?: boolean;
};
export type KnowledgeAssetTree = {
  schemaVersion: 1 | 2 | 3;
  instructions: string;
  nodes: KnowledgeAssetNode[];
};

/** 旧分类与默认文档名仅作显示兼容，保留节点身份、版本和文件指纹。 */
export function normalizeKnowledgeCategoryNode(node: KnowledgeAssetNode): KnowledgeAssetNode {
  if (node.parentId === "knowledge-architecture" && node.contentMode !== "directory" && node.title === "核心业务流程") {
    return { ...node, title: "核心流程" };
  }
  return node.id === "knowledge-architecture" && node.parentId === null && node.category === "architecture"
    && node.contentMode === "directory" && node.title === "架构机制"
    ? { ...node, title: KNOWLEDGE_CATEGORIES.find(category => category.category === "architecture")!.title } : node;
}

export type KnowledgeAssetSource = {
  kind: "code" | "document" | "requirement";
  path?: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  contentHash?: string;
  requirement?: string;
  relation: string;
};
export type KnowledgeAssetRevision = {
  schemaVersion: 1;
  id: string;
  nodeId: string;
  createdAt: string;
  origin: "ai" | "manual" | "import";
  instructions: string;
  summary: string;
  baseHash: string | null;
  /** 保存时的正式基版本身份，用于沿采用链追溯来源。 */
  baseRevisionId?: string | null;
  /** 生成版本保留剥离受信系统修订指令后的用户要求，供历史复检追溯。 */
  userInstructions?: string;
  contentHash: string;
  sourcesHash: string;
  runId: string | null;
};
export type KnowledgeAssetDocument = {
  revision: KnowledgeAssetRevision;
  content: string;
  sources: KnowledgeAssetSource[];
  path: string;
};
export type KnowledgeAssetSourceRead = { path: string; contentHash: string; startLine: number; endLine: number; totalLines: number; content: string };
export type KnowledgeAssetDirectoryEntry = { path: string; directory: boolean };
export type KnowledgeAssetDirectoryListing = { kind: "directory"; path: string; entries: KnowledgeAssetDirectoryEntry[]; nextOffset: number | null; nextAction: "knowledge.source.list" };
export type KnowledgeReviewConfig = { enabled: boolean; model: string | null; effort: string | null; /** 复检发现问题后是否自动修订并再次复检；批量生成默认开启，单独复检默认关闭。 */ autoRepair?: boolean; /** 自动修订最多执行的复检轮次，范围 1 至 KNOWLEDGE_MAX_REVIEW_ROUNDS。 */ maxRounds?: number };
/** 自动修订/复检闭环的固定上限，避免问题报告导致无限生成。 */
export const KNOWLEDGE_MAX_REVIEW_ROUNDS = 5;
export type KnowledgeReviewIssue = {
  id: string;
  severity: "error" | "warning";
  category: "factual" | "coverage" | "unsupported" | "contradiction";
  title: string;
  detail: string;
  documentStartLine: number;
  documentEndLine: number;
  sources: KnowledgeAssetSource[];
  suggestion: string;
};
export type KnowledgeReviewReport = {
  schemaVersion: 1;
  id: string;
  nodeId: string;
  revisionId: string;
  runId: string;
  createdAt: string;
  contentHash: string;
  sourcesHash: string;
  instructionsHash: string;
  sourceScopeHash: string;
  sourceHashes: Array<{ path: string; contentHash: string | null }>;
  engine: "codex" | "claude";
  model: string | null;
  effort: string | null;
  /** 无阻断问题为 passed；只有 warning 为 passed_with_warnings；存在 error 才是 issues。 */
  outcome: "passed" | "passed_with_warnings" | "issues";
  summary: string;
  issues: KnowledgeReviewIssue[];
  sources: KnowledgeAssetSource[];
};
export type KnowledgeReviewReportView = KnowledgeReviewReport & { stale: boolean; staleReasons: string[] };
export type KnowledgeAssetDetail = {
  node: KnowledgeAssetNode;
  current: KnowledgeAssetDocument | null;
  /** 当前人工版本沿正式版本链追溯到的生成版本。 */
  sourceRevision?: { runId: string; revisionId: string } | null;
  currentHash: string | null;
  drafts: KnowledgeAssetRevision[];
  effectiveInstructions: string;
  freshness: Array<{ path: string; state: "unchanged" | "changed" | "missing"; message?: string }>;
  reference?: { path: string; content: string; contentHash: string; readAt: number; state: "unchanged" | "changed" };
};
export type KnowledgeAssetNodeState = {
  nodeId: string;
  revisionId: string | null;
  draftCount: number;
  error: { code: string; message: string } | null;
};
export type KnowledgeAssetsSnapshot = {
  initialized: boolean;
  knowledgeId: string | null;
  root: string;
  tree: KnowledgeAssetTree;
  treeHash: string | null;
  states: KnowledgeAssetNodeState[];
  canWrite: boolean;
};
export type KnowledgeConversationSummary = {
  threadId: string;
  createdByUserId: string;
  title: string;
  nodeId: string | null;
  engine: "codex" | "claude";
  model: string | null;
  effort: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};
export type KnowledgeGenerationMode = "tree" | "conversation" | "batch" | "review" | "build";
/** 采用绑定实际预览版本；目录和引用的 revisionId 为 null。 */
export type KnowledgeGenerationSelection = { nodeId: string; revisionId: string | null };
export type KnowledgeGenerationPreview = {
  runId: string; tree: KnowledgeAssetTree; treeHash: string | null; planHash: string;
  items: Array<KnowledgeGenerationSelection & { canApply: boolean; reason: string | null; applied: boolean; dismissed?: boolean }>;
};
export type KnowledgeGenerationApplyInput = { requestId: string; treeHash: string | null; planHash: string; selections: KnowledgeGenerationSelection[] };
/** 原任务中的采用清单先于正式写入保存，用于逐文件恢复。 */
export type KnowledgeGenerationAdoption = KnowledgeGenerationApplyInput & {
  targetTree: KnowledgeAssetTree; targetTreeHash: string; completed: boolean;
  error: { code: string; message: string } | null;
  appliedNodeIds?: string[];
  writtenNodeIds?: string[];
  /** 显式终止仅关闭未生效选择，保留实际已生效结果。 */
  cancelled?: boolean;
  cancelledAt?: number;
  cancelledBy?: string;
};
export type KnowledgeBatchStrategy = "missing" | "all";
export type KnowledgeGenerationItem = {
  id: string;
  nodeId: string;
  title: string;
  expectedHash: string | null;
  instructions: string;
  inheritedInstructions: string;
  /** 未单独调整时继承任务冻结参数；null 明确使用引擎默认。 */
  executionConfig?: { model: string | null; effort: string | null };
  reviewConfig?: KnowledgeReviewConfig;
  executionThreadId?: string | null;
  maintenanceFingerprint?: string;
  /** 按报告修订时读取该待修订版本，不能误用另一份已采用正文。 */
  repairRevisionId?: string;
  /** 自动复检闭环当前要求生成者处理的报告。 */
  repairReportId?: string;
  review?: {
    status: "pending" | "repairing" | "passed" | "passed_with_warnings" | "issues" | "failed";
    reportId: string | null;
    executionThreadId?: string | null;
    /** 复检子任务所属的文件工作会话；缺省表示历史独立复检。 */
    parentThreadId?: string | null;
    /** 已保存的复检报告轮次；首轮复检完成后为 1。 */
    round?: number;
    /** 自动修订最多执行的复检轮次，当前固定为 5。 */
    maxRounds?: number;
    error: { code: string; message: string } | null;
    stale?: boolean;
    staleReasons?: string[];
  };
  status: "pending" | "completed" | "failed";
  revisionId: string | null;
  error: { code: string; message: string } | null;
};
export type KnowledgeGenerationRun = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  mode: KnowledgeGenerationMode;
  nodeId: string | null;
  prompt: string;
  engine: "codex" | "claude";
  threadId?: string | null;
  /** 批量任务的讨论归属；资产执行使用各自的独立线程。 */
  ownerThreadId?: string;
  selectedNodeIds?: string[];
  includeDescendants?: boolean;
  strategy?: KnowledgeBatchStrategy;
  model: string | null;
  effort: string | null;
  /** 原始请求指纹独立于执行时解析的默认模型，保证响应丢失后的幂等重试。 */
  requestHash?: string;
  /** 本批次允许同时执行的资产数；Client 全局调度器仍提供最终上限。 */
  concurrency?: number;
  reviewConfig?: KnowledgeReviewConfig;
  repairReports?: Array<{ nodeId: string; reportId: string }>;
  treeHash: string | null;
  proposedTree: KnowledgeAssetTree | null;
  baseTree?: KnowledgeAssetTree;
  /** 来源变动只提示规划，不成为正文生成要求。 */
  changePaths?: string[];
  /** 自动维护遵守同一来源指纹下的不采用回执；人工构建允许重新评估。 */
  maintenance?: boolean;
  planningThreadId?: string | null;
  planningDecisions?: Array<{ nodeId: string; question: string; whyGenerate: string; sources: KnowledgeAssetSource[] }>;
  adoptions?: KnowledgeGenerationAdoption[];
  dismissals?: Array<{ nodeId: string; revisionId: string | null; baseHash: string | null; fingerprint: string; userId: string; createdAt: number }>;
  /** 目录已被采用的事实；普通讨论结束不会设置此字段。 */
  appliedTreeHash?: string | null;
  rationale: string;
  gaps: string[];
  items: KnowledgeGenerationItem[];
  phase: "planning" | "planned" | "generating" | "completed" | "partial" | "failed" | "interrupted";
  error: { code: string; message: string } | null;
};
export type KnowledgeGenerationStage = "queued" | "generating" | "reviewing";
export type KnowledgeGenerationRunView = KnowledgeGenerationRun & {
  active: boolean;
  activeItemId: string | null;
  /** 当前同时执行的资产，首项仍通过 activeItemId 提供旧 UI 的主展示。 */
  activeItemIds?: string[];
  activeStage?: KnowledgeGenerationStage | null;
  /** 每个活动资产当前阶段；用于区分排队、生成和复检。 */
  activeItemStages?: Array<{ itemId: string; stage: KnowledgeGenerationStage }>;
  scheduler?: { limit: number; running: number; queued: number };
};
export type KnowledgeAssetSearchHit = {
  nodeId: string;
  title: string;
  excerpt: string;
  path: string | null;
  keywordScore: number;
  vectorScore: number;
  score: number;
  matchMode: "keyword" | "vector" | "hybrid";
  contentHash?: string;
  readAt?: number;
  chunkId?: string;
  heading?: string;
  startLine?: number;
  endLine?: number;
};
export type KnowledgeAssetImportFile = { path: string; title: string; contentHash: string };
export type KnowledgeChange = {
  schemaVersion: 1; id: string; nodeId: string; title: string; summary: string;
  createdAt: string; updatedAt: string; status: "pending" | "approved" | "rejected";
  origin: "chat" | "workflow"; baseHash: string | null; baseContent: string;
  content: string; sources: KnowledgeAssetSource[]; instructions: string;
  reviewedAt: string | null; reviewedBy: string | null; reviewNote: string;
  revisionId: string | null;
};
export type KnowledgeChangeSummary = Omit<KnowledgeChange, "baseContent" | "content" | "sources" | "instructions">;
export type KnowledgePendingChangeNode = { nodeId: string; title: string; count: number };
export type KnowledgeChangeDetail = KnowledgeChange & { hash: string; currentContent: string; stale: boolean; staleReasons: string[] };
/** 定时计划随项目保存；执行身份每次由 Server 重新核验。 */
export type KnowledgeUpdateSchedule = {
  schemaVersion: 1; id: string; enabled: boolean; cronExpr: string; timezone: string;
  executorClientId: string; selectedWorkspaceId: string; updatedAt: number;
  selectedNodeIds: string[]; includeDescendants: boolean;
  engine: "codex" | "claude"; model: string | null; effort: string | null;
  concurrency: number; prompt: string; reviewConfig: KnowledgeReviewConfig;
};
export type KnowledgeUpdateCheck = {
  scheduledAt: number; checkedAt: number;
  outcome: "checking" | "started" | "unchanged" | "busy" | "failed";
  runId: string | null; selectedCount: number; deferredCount: number;
  error: { code: string; message: string } | null;
};
export type KnowledgeUpdateView = {
  schedule: KnowledgeUpdateSchedule | null; hash: string | null; currentClientId: string;
  nextRunAt: number | null; lastCheck: KnowledgeUpdateCheck | null; run: KnowledgeGenerationRunView | null;
  defaultTimezone: string;
};
export const KNOWLEDGE_ASSET_READ_ACTIONS = ["snapshot", "node", "revision", "reviews", "search", "runs", "run", "run.preview", "imports", "source", "conversation.list", "changes", "change", "update.schedule"] as const;
export const KNOWLEDGE_ASSET_WRITE_ACTIONS = ["tree.save", "document.save", "revision.adopt", "revision.adopt.batch", "revision.dismiss", "import", "generate", "run.apply", "run.cancelAdoption", "run.start", "run.stop", "conversation.create", "conversation.connect", "conversation.end", "change.review", "update.save", "update.run"] as const;
export type KnowledgeAssetAction = (typeof KNOWLEDGE_ASSET_READ_ACTIONS)[number] | (typeof KNOWLEDGE_ASSET_WRITE_ACTIONS)[number];
export type KnowledgeAssetResponses = {
  snapshot: KnowledgeAssetsSnapshot;
  node: KnowledgeAssetDetail;
  revision: KnowledgeAssetDocument;
  reviews: KnowledgeReviewReportView[];
  search: { backend: "hybrid_sqlite_fts5_vector"; vectorBackend: "local_feature_hash_v1"; items: KnowledgeAssetSearchHit[]; issues: Array<{ nodeId: string; code: string; message: string }> };
  runs: KnowledgeGenerationRunView[];
  run: KnowledgeGenerationRunView;
  "run.preview": KnowledgeGenerationPreview;
  imports: { files: KnowledgeAssetImportFile[]; directories: string[]; nextOffset: number | null };
  source: KnowledgeAssetSourceRead | KnowledgeAssetDirectoryListing;
  "tree.save": KnowledgeAssetsSnapshot;
  "document.save": KnowledgeAssetRevision;
  "revision.adopt": KnowledgeAssetDetail;
  "revision.adopt.batch": KnowledgeAssetsSnapshot;
  "revision.dismiss": KnowledgeGenerationRunView;
  import: KnowledgeAssetsSnapshot;
  generate: KnowledgeGenerationRunView;
  "run.apply": KnowledgeGenerationRunView;
  "run.cancelAdoption": KnowledgeGenerationRunView;
  "run.start": KnowledgeGenerationRunView;
  "run.stop": KnowledgeGenerationRunView;
  "conversation.list": KnowledgeConversationSummary[];
  "conversation.create": KnowledgeConversationSummary;
  "conversation.connect": KnowledgeConversationSummary;
  "conversation.end": KnowledgeConversationSummary;
  changes: { items: KnowledgeChangeSummary[]; nextOffset: number | null; pendingNodes: KnowledgePendingChangeNode[] };
  change: KnowledgeChangeDetail;
  "change.review": KnowledgeChangeDetail;
  "update.schedule": KnowledgeUpdateView;
  "update.save": KnowledgeUpdateView;
  "update.run": KnowledgeUpdateView;
};
