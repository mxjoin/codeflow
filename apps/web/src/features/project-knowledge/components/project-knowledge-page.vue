<script setup lang="ts">
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_MAX_REVIEW_ROUNDS, resolveEngineModelProvider, resolveThreadPrefsWithCatalogDefaults, type KnowledgeCategory } from "@codeflowai/shared";
import type {
  ApiResult, EngineType, KnowledgeAssetDetail, KnowledgeAssetNode, KnowledgeAssetsSnapshot, KnowledgeAssetSearchHit, KnowledgeChangeDetail,
  KnowledgeGenerationRunView, KnowledgeConversationSummary, KnowledgeAssetDocument, KnowledgeReviewIssue, KnowledgeReviewReportView, KnowledgePendingChangeNode, ThreadId, ThreadSummary, WorkspaceId,
} from "@codeflowai/shared";
import { message, Modal } from "ant-design-vue";
import { FileTextOutlined, FolderOutlined, RightOutlined, UploadOutlined } from "@ant-design/icons-vue";
import dayjs from "dayjs";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter, type LocationQueryRaw } from "vue-router";
import { requestKnowledgeAsset, type KnowledgeAssetInput } from "../../../api/projectKnowledge";
import { uploadWorkspaceFile } from "../../../api/fs";
import { updateThreadPrefs } from "../../../api/threads";
import { createApiResultError, isApiResultError, type ApiRequestContext } from "../../../api/request";
import { useChatStore } from "../../../store/chat";
import { useComposerStore } from "../../../store/composer";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { useUiStore, type PreviewWindow } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isDesktopWorkspace } from "../../../services/desktop";
import { loadWorkspaceFilePreview } from "../../explorer/workspaceFilePreview";
import { buildModelSelectOptionGroups } from "../../../composables/modelSelectOptions";
import DesktopPanelResizeHandle from "../../../components/layout/desktop-panel-resize-handle.vue";
import ChatPanel from "../../chat/components/chat-panel.vue";
import MarkdownContent from "../../markdown/MarkdownContent.vue";
import KnowledgeAssetTree from "./knowledge-asset-tree.vue";
import KnowledgeReviewReport from "./knowledge-review-report.vue";
import KnowledgeUpdateSettings from "./knowledge-update-settings.vue";
import KnowledgeManagementPolicy from "./knowledge-management-policy.vue";
import KnowledgeUpdates from "./knowledge-updates.vue";
import KnowledgeOverview from "./knowledge-overview.vue";
import KnowledgeChangeInbox from "./knowledge-change-inbox.vue";
import { knowledgeNodeHasBody, knowledgeSelectedNodes } from "../knowledgeTreeModel";
import { knowledgeDocumentSession, knowledgeLibraryTree, type KnowledgeDocumentContext } from "../knowledgeWorkTreeModel";
import { knowledgeDocumentReviewActivity, knowledgeItemNeedsReview, knowledgeItemNeedsRunWork, knowledgeReviewLabel } from "../knowledgeReviewModel";
import { clearKnowledgePageCache, readKnowledgeNode, readKnowledgeSnapshot, rememberKnowledgeNode, rememberKnowledgeSnapshot } from "../knowledgePageCache";

defineOptions({ name: "ProjectKnowledgePage" });

const config = useConfigStore();
const chat = useChatStore();
const composer = useComposerStore();
const engines = useEngineStore();
const ui = useUiStore();
const workspaces = useWorkspacesStore();
const route = useRoute();
const router = useRouter();
// 审批提示链接携带所属工作区，避免当前选择另一个项目时误读或误审批。
watch(() => route.query.workspaceId, value => {
  if (route.name === "project-knowledge" && typeof value === "string" && value && value !== config.workspaceId) config.switchWorkspace(value, { reloadPage: false, preservePrimaryThreadUrl: true });
}, { immediate: true });
const requestedThreadId = computed(() => route.name === "project-knowledge" && typeof route.query.threadId === "string" ? route.query.threadId.trim() : "");
const requestedExecutionThreadId = computed(() => route.name === "project-knowledge" && typeof route.query.executionThreadId === "string" ? route.query.executionThreadId.trim() : "");
const workspaceId = computed(() => String(config.workspaceId ?? "").trim() as WorkspaceId);
const desktopWorkspace = computed(() => isDesktopWorkspace(config, workspaceId.value));
const conversationActorId = computed(() => desktopWorkspace.value
  ? config.desktopCloudAccount?.status === "linked" ? config.desktopCloudAccount.userSummary?.userId : `local:${config.desktopClient!.clientId}`
  : config.userSummary?.userId);
/** 快照和正文缓存按桌面/Server、账号与工作区隔离，权限变化不复用旧内容。 */
function knowledgeCacheScopeKey(): string {
  return JSON.stringify([desktopWorkspace.value ? "desktop" : config.serverWsOrigin, conversationActorId.value ?? "", workspaceId.value]);
}
function knowledgeNodeCacheKey(nodeId: string): string {
  return JSON.stringify([knowledgeCacheScopeKey(), nodeId]);
}
const workspaceName = computed(() => workspaces.byId.get(workspaceId.value)?.title ?? workspaceId.value);
// 资产树是不可变的整棵快照；避免 Vue 为大树的每个节点建立深层响应式代理。
const snapshot = shallowRef<KnowledgeAssetsSnapshot | null>(null);
const detail = ref<KnowledgeAssetDetail | null>(null);
const selectedId = ref<string | null>(null);
const overviewOpen = ref(true);
const changeHistoryOpen = ref(false);
type KnowledgeUpdateTarget = { scopeNodeId: string | null; changeId?: string | null; focusId?: string | null; report?: boolean; recoveryRunId?: string };
const updatesTarget = shallowRef<KnowledgeUpdateTarget | null>(null);
const updatesBusy = ref(false);
const approvalRouteNodeId = ref<string | null>(null);
let adoptedTransitionNodeId: string | null = null;
const maintenanceRunId = ref<string | null>(null);
const suppressAutoPreview = ref<string | null>(null);
const pendingEditDecision = shallowRef<((choice: "save" | "discard" | "stay") => void) | null>(null);
/** 用户最后一次明确选择的节点；异步快照短暂不完整时也不能把它覆盖成概览。 */
const selectedNodeIntent = ref<string | null>(null);
let selectedNodeIntentWorkspace: WorkspaceId | null = null;
const checkedIds = ref<string[]>([]);
const selectionResetKey = ref(0);
const conversations = ref<KnowledgeConversationSummary[]>([]);
const batchOpen = ref(false), batchIncludeDescendants = ref(true), batchPrompt = ref("");
const batchStrategy = ref<"missing" | "all">("all");
const batchSelectedIds = ref<string[]>([]);
const batchEngine = ref<EngineType>("codex");
const batchModelId = ref("");
const batchEffort = ref("");
const batchConcurrency = ref(2);
const MAX_BATCH_CONCURRENCY = 16;
const batchError = ref<string | null>(null);
const batchMode = ref<"batch" | "review">("batch");
const batchReviewEnabled = ref(true), batchReviewAutoRepair = ref(true), batchReviewModelId = ref(""), batchReviewEffort = ref(""), batchReviewMaxRounds = ref(2);
const buildStarting = ref(false);
type PendingGeneration = { input: KnowledgeAssetInput<"generate">; runId: string | null };
const pendingBuild = shallowRef<PendingGeneration | null>(null), pendingBatch = shallowRef<PendingGeneration | null>(null);
const batchRevisionRunId = ref<string | null>(null);
const batchLocked = computed(() => busy.value || !buildSettingsMode.value && Boolean(pendingBatch.value));
const buildSettingsMode = ref(false);
const pendingBuildIds = ref<string[] | null>(null);
type KnowledgeBuildPrefs = { engine: EngineType; model: string | null; effort: string | null };
const KNOWLEDGE_BUILD_PREFS_KEY = "codeflow:knowledge-build-prefs";

/** 构建设置按工作区持久化：一键生成不打开设置弹窗时也要沿用上次选的引擎与模型。 */
function readKnowledgeBuildPrefs(workspaceId: string): KnowledgeBuildPrefs | null {
  if (!workspaceId || typeof window === "undefined") return null;
  const parsed = JSON.parse(window.localStorage.getItem(`${KNOWLEDGE_BUILD_PREFS_KEY}:${workspaceId}`) ?? "null") as Partial<KnowledgeBuildPrefs> | null;
  if (parsed === null) return null;
  if ((parsed.engine !== "codex" && parsed.engine !== "claude") || (parsed.model != null && typeof parsed.model !== "string") || (parsed.effort != null && typeof parsed.effort !== "string")) throw new Error("项目模型配置格式无效，请重新保存构建设置");
  return { engine: parsed.engine, model: parsed.model ?? null, effort: parsed.effort ?? null };
}

/** 记住本次构建设置，供后续一键生成直接沿用。 */
function writeKnowledgeBuildPrefs(workspaceId: string, prefs: KnowledgeBuildPrefs): void {
  if (!workspaceId || typeof window === "undefined") return;
  window.localStorage.setItem(`${KNOWLEDGE_BUILD_PREFS_KEY}:${workspaceId}`, JSON.stringify(prefs));
}

const buildPrefs = ref<KnowledgeBuildPrefs | null>(null);
const buildPrefsError = ref<string | null>(null);
const batchRepairReports = ref<Array<{ nodeId: string; reportId: string }>>([]);
const previewRevisionId = ref<string | null>(null);
const previewDocument = ref<KnowledgeAssetDocument | null>(null);
const revisionLoading = ref(false), reportsLoading = ref(false);
const reportsReadError = ref<string | null>(null);
const nodeReports = ref<KnowledgeReviewReportView[]>([]);
// 任务结果体积可能很大（批量资产会携带每项复检状态）；结果列表本身只按整批替换，
// 不需要让 Vue 为每个运行项建立深层响应式代理。
const taskList = shallowRef<KnowledgeGenerationRunView[]>([]);
const viewTab = ref<"node" | "sources" | "review">("node");
const activeRun = ref<KnowledgeGenerationRunView | null>(null);
const executionSession = ref<{ threadId: ThreadId; title: string; kind: "知识工作会话" | "复检会话" } | null>(null);
const executionSessionLoading = ref(false);
const executionSessionError = ref<string | null>(null);
const hydratedExecutionThreadId = ref<string | null>(null);
const updatePreview = shallowRef<KnowledgeDocumentContext | null>(null);
const showProjectConversation = ref(false);
const updateSettingsOpen = ref(false);
const policyOpen = ref(false);
const importCategory = ref<KnowledgeCategory>("product");
const importAppliesTo = ref("");
const searchQuery = ref("");
const searchResults = shallowRef<KnowledgeAssetSearchHit[]>([]);
const searchFocus = shallowRef<KnowledgeAssetSearchHit | null>(null);
const searchLocationElement = ref<HTMLElement | null>(null);
const searchLoading = ref(false);
const searchError = ref<string | null>(null);
const searchVisible = ref(false);
const resultsLoading = ref(false);
const resultsLoadError = ref<string | null>(null);
const selectedChangeId = ref<string | null>(null);
const pendingChangeNodes = shallowRef<KnowledgePendingChangeNode[]>([]);
const loading = ref(false);
/** 缓存命中后首屏快照仍在后台刷新；用于延迟深链会话处理。 */
const initialSnapshotRefreshing = ref(false);
const nodeLoading = ref(false);
const documentReadError = ref<{ message: string; revisionId: string | null } | null>(null);
const snapshotStatesError = ref<string | null>(null);
const busy = ref(false);
const errorText = ref<string | null>(null);
const errorDiagnostics = ref<{ code: string; requestId: string | null; operation: string | null; rootCause: string | null } | null>(null);
const treeOpen = ref(true);
const assistantOpen = ref(false);
const sessionMenuOpen = ref(false);
const editing = ref(false);
const editContent = ref("");
const assistantThreadId = ref<ThreadId | null>(null);
const assistantPanel = ref<InstanceType<typeof ChatPanel> | null>(null);
const boundNodeId = ref<string | null>(null);
const bindingReady = ref(false);
const binding = ref(false);
/** 会话历史在资产树之后后台恢复，避免大段聊天回放阻塞知识页首屏。 */
const conversationLoading = ref(false);
const bindingError = ref<string | null>(null);
const initialEngine = ref<EngineType>("claude");
const batchEngineOptions = computed(() => ([
  { value: "codex" as EngineType, label: "Codex" },
  { value: "claude" as EngineType, label: "Claude" },
]));
const narrowQuery = typeof window === "undefined" ? null : window.matchMedia("(max-width: 1100px)");
const narrowScreen = ref(narrowQuery?.matches ?? false);
const layoutElement = ref<HTMLElement | null>(null);
const treeElement = ref<HTMLElement | null>(null);
const assistantContainer = ref<HTMLElement | null>(null);
const assistantWidth = ref<number | null>(null);
const assistantPreviewWidth = ref<number | null>(null);
const assistantRenderedWidth = ref(360);
const assistantMinWidth = 320;
const assistantMaxWidth = ref(700);
let panelResizeObserver: ResizeObserver | null = null;
const assistantEffectiveWidth = computed(() => Math.min(assistantMaxWidth.value, assistantPreviewWidth.value ?? assistantWidth.value ?? assistantRenderedWidth.value));
const assistantLayoutStyle = computed(() => {
  const width = assistantPreviewWidth.value ?? assistantWidth.value;
  return width === null || !assistantOpen.value || narrowScreen.value ? {} : { "--assistant-width": `${assistantEffectiveWidth.value}px` };
});

/** 按实际容器限制会话宽度，至少为正文保留 360px。 */
function measureAssistantLayout(): void {
  if (!layoutElement.value || narrowScreen.value) return;
  assistantMaxWidth.value = Math.max(assistantMinWidth, Math.min(700, layoutElement.value.clientWidth - (treeElement.value?.offsetWidth ?? 0) - 360));
  if (assistantOpen.value && assistantContainer.value) assistantRenderedWidth.value = assistantContainer.value.getBoundingClientRect().width;
}

/** 拖动期间只预览宽度，取消时恢复已确认的宽度。 */
function startAssistantResize(): void {
  measureAssistantLayout();
  assistantPreviewWidth.value = assistantRenderedWidth.value;
}

/** 保存确认的宽度，收起再展开时继续沿用。 */
function commitAssistantResize(width: number): void {
  assistantWidth.value = width;
  assistantPreviewWidth.value = null;
}

onMounted(() => {
  measureAssistantLayout();
  panelResizeObserver = new ResizeObserver(measureAssistantLayout);
  if (layoutElement.value) panelResizeObserver.observe(layoutElement.value);
  if (assistantContainer.value) panelResizeObserver.observe(assistantContainer.value);
});
onBeforeUnmount(() => panelResizeObserver?.disconnect());
if (narrowScreen.value) { treeOpen.value = false; assistantOpen.value = false; }
/** 屏幕变窄时收起侧栏，恢复宽屏不替用户打开聊天。 */
function syncViewport(event: MediaQueryListEvent): void {
  narrowScreen.value = event.matches;
  if (event.matches) { treeOpen.value = false; assistantOpen.value = false; }
  else { treeOpen.value = true; }
}
narrowQuery?.addEventListener("change", syncViewport);

type ImportItem = { path: string; title: string; contentHash: string };
const importOpen = ref(false);
const importItems = ref<ImportItem[]>([]);
const importDirectories = ref<string[]>([]);
const importDirectory = ref("");
const importDirectoryInput = ref("");
const importError = ref<string | null>(null);
const importSubmitError = ref<string | null>(null);
const selectedImportPaths = ref<string[]>([]);
const importLoading = ref(false);
const importNextOffset = ref<number | null>(null);
/** 导入位置与实际提交共用同一口径，来源目录不决定知识分类。 */
const importDestination = computed(() => {
  const category = KNOWLEDGE_CATEGORIES.find(item => item.category === importCategory.value)!;
  const node = snapshot.value?.tree.nodes.find(item => item.id === selectedId.value);
  const parent = node?.contentMode === "directory" && ancestors(node)[0]?.category === importCategory.value ? node : null;
  return { parentId: parent?.id ?? null, title: parent ? pathTitle(parent) : category.title };
});
/** 分类说明强调原文用途；规格引用会直接参与对应范围的规则读取。 */
const importCategoryHint = computed(() => ({
  specifications: "已确认、长期有效的开发要求。导入后作为所选范围的规格规则生效。",
  architecture: "与当前实现一致的架构设计、核心流程和关键机制说明。",
  product: "产品需求、业务说明、使用手册等原始资料，供检索与引用。",
})[importCategory.value]);
const canWrite = computed(() => snapshot.value?.canWrite === true);
const snapshotStatesReady = computed(() => {
  const current = snapshot.value;
  return Boolean(current && (current.tree.nodes.length === 0 || current.states.length === current.tree.nodes.length));
});
const visibleWorkTree = computed(() => knowledgeLibraryTree(snapshot.value?.tree.nodes ?? [], snapshot.value?.states ?? [], taskList.value, pendingChangeNodes.value));
const visibleTreeNodes = computed(() => visibleWorkTree.value.nodes);
const nodeMap = computed(() => new Map(visibleTreeNodes.value.map(item => [item.id, item])));
const selectedNode = computed(() => selectedId.value ? nodeMap.value.get(selectedId.value) ?? null : null);
const readingNodeId = computed(() => selectedId.value);
const node = computed(() => readingNodeId.value ? nodeMap.value.get(readingNodeId.value) ?? null : null);
const specificationPaths = computed(() => node.value && ancestors(node.value)[0]?.category === "specifications"
  ? [...ancestors(node.value)].reverse().find(parent => parent.appliesTo !== undefined)?.appliesTo ?? [] : null);
const nodeCount = computed(() => snapshot.value?.tree.nodes.filter(item => !item.archived).length ?? 0);
const statesById = computed(() => new Map(snapshot.value?.states.map(state => [state.nodeId, state]) ?? []));
/**
 * 左树只依赖结构投影，不能因为权限、节点状态或任务列表仍在同步而重新进入骨架。
 * 结果页在权威 snapshot 尚未返回时，也可以直接用本轮已收到的任务投影绘制待处理路径。
 */
const treeProjectionReady = computed(() => Boolean(snapshot.value) || taskList.value.length > 0 || visibleTreeNodes.value.length > 0);
const treeLoading = computed(() => !treeProjectionReady.value && loading.value);
const treeEmptyText = computed(() => snapshot.value || loading.value ? undefined : "规格库目录读取失败");
const treeTitle = "规格知识库";
const visibleTreeCount = computed(() => visibleTreeNodes.value.length);
const currentUpdatesCount = computed(() => readingNodeId.value ? visibleWorkTree.value.updates.filter(update => update.nodeId === readingNodeId.value).length + (pendingChangeNodes.value.find(item => item.nodeId === readingNodeId.value)?.count ?? 0) : 0);
const autoPreview = computed(() => Boolean(!editing.value && !documentReadError.value && node.value && node.value.contentMode !== "directory" && !detail.value?.reference && !nodeLoading.value && !detail.value?.current && currentUpdatesCount.value && suppressAutoPreview.value !== readingNodeId.value));
const showUpdates = computed(() => Boolean(updatesTarget.value) || autoPreview.value);
const fileConversationMode = computed(() => !showProjectConversation.value && Boolean(executionSession.value || showUpdates.value || node.value && node.value.contentMode !== "directory"));
const documentSession = computed(() => {
  if (showUpdates.value) return updatePreview.value?.runId ? knowledgeDocumentSession(taskList.value, updatePreview.value) : null;
  if (!readingNodeId.value || documentLoading.value) return null;
  const revision = previewDocument.value?.revision;
  const currentManual = revision?.origin === "manual" && revision.id === detail.value?.current?.revision.id;
  return knowledgeDocumentSession(taskList.value, { nodeId: readingNodeId.value, revisionId: revision?.id ?? previewRevisionId.value,
    runId: currentManual ? null : revision?.runId ?? null, sourceRevision: currentManual ? detail.value?.sourceRevision : null });
});
const displayedExecutionSession = computed(() => executionSession.value ?? documentSession.value);
const executionThreadRunning = computed(() => Boolean(chat.threadDisplayRunningStateForThread(displayedExecutionSession.value?.threadId ?? null)?.runningTurnId));
/** 正文或实时引用就绪即结束文档加载展示，复检报告仍按原入口独立读取。 */
const documentLoading = computed(() => !documentReadError.value && (nodeLoading.value || revisionLoading.value) && !previewDocument.value && !detail.value?.reference);
const executionRunActive = computed(() => Boolean(displayedExecutionSession.value && taskList.value.some(run => run.active && run.items.some(item =>
  item.executionThreadId === displayedExecutionSession.value!.threadId || item.review?.executionThreadId === displayedExecutionSession.value!.threadId
  || run.mode === "conversation" && run.threadId === displayedExecutionSession.value!.threadId))));
/** 独立正文就绪即展示；任务候选仍沿原入口等待节点判定，避免闪现普通正文页。 */
const readingPending = computed(() => nodeLoading.value && !detail.value?.current && !detail.value?.reference && (!previewDocument.value || currentUpdatesCount.value > 0)
  || (!selectedId.value || selectedNode.value?.contentMode === "directory") && (loading.value || resultsLoading.value || snapshot.value && !snapshotStatesReady.value && !snapshotStatesError.value));
const summaryRun = computed(() => taskList.value.find(run => run.active) ?? taskList.value.find(run => run.error || ["partial", "interrupted", "failed"].includes(run.phase ?? "")
  || run.items.some(item => item.status === "failed" || item.reviewConfig?.enabled !== false && (item.review?.stale || ["issues", "failed"].includes(item.review?.status ?? "")))
  || run.id === maintenanceRunId.value || run.adoptions?.some(receipt => !receipt.completed && !receipt.cancelled)) ?? null);
const summaryIssue = computed(() => summaryRun.value?.error?.message ?? summaryRun.value?.items.find(item => item.error || item.review?.error)?.error?.message
  ?? summaryRun.value?.items.find(item => item.review?.error)?.review?.error?.message
  ?? (summaryRun.value?.items.some(item => item.reviewConfig?.enabled !== false && (item.review?.stale || item.review?.status === "issues")) ? "复检发现问题或已失效，请查看对应文档的复检报告" : null));
/** 优先调整未交付正文；仅剩复检时只允许修改复检配置。 */
function adjustableRunItems(run: KnowledgeGenerationRunView): KnowledgeGenerationRunView["items"] {
  const nodes = run.proposedTree?.nodes ?? snapshot.value?.tree.nodes ?? [];
  const ids = new Set(nodes.filter(node => !node.archived && knowledgeNodeHasBody(node)).map(node => node.id));
  const pending = run.items.filter(item => ids.has(item.nodeId) && item.status !== "completed");
  if (pending.length) return pending;
  return run.items.filter(item => ids.has(item.nodeId) && item.status === "completed"
    && (item.reviewConfig ?? run.reviewConfig)?.enabled !== false
    && (item.review?.status === "pending" || item.review?.status === "failed"
      || knowledgeItemNeedsRunWork(item, run.mode as "batch" | "review" | "build", run.reviewConfig)));
}
/** 仅对可续跑的批任务展示恢复动作，已完成版本不重复执行。 */
const summaryUnfinished = computed(() => summaryRun.value && ["batch", "review", "build"].includes(summaryRun.value.mode) && !summaryRun.value.active
  && (["planned", "partial", "interrupted", "failed"].includes(summaryRun.value.phase ?? "")
    || summaryRun.value.items.some(item => knowledgeItemNeedsRunWork(item, summaryRun.value!.mode as "batch" | "review" | "build", summaryRun.value!.reviewConfig))));
/** 调整入口仅面向原任务中确实存在的未完成知识。 */
const summaryAdjustable = computed(() => Boolean(summaryRun.value && summaryUnfinished.value && adjustableRunItems(summaryRun.value).length));
const summaryFailed = computed(() => summaryRun.value?.items.some(item => item.status === "failed" || item.review?.status === "failed") ?? false);
const readyCount = computed(() => snapshot.value?.tree.nodes.filter(item => !item.archived && (statesById.value.get(item.id)?.revisionId || item.contentMode === "reference")).length ?? 0);
const draftCount = computed(() => visibleWorkTree.value.pendingCount);
const emptyCount = computed(() => {
  const generatingIds = new Set(visibleWorkTree.value.generatingIds);
  return snapshot.value?.tree.nodes.filter(item => !item.archived && knowledgeNodeHasBody(item)
    && !statesById.value.get(item.id)?.revisionId && !statesById.value.get(item.id)?.draftCount
    && !generatingIds.has(item.id)).length ?? 0;
});
const documentText = computed(() => detail.value?.reference?.content ?? previewDocument.value?.content ?? "");
/** 按指纹和行号定位原文；超长单行用原文中的命中摘要截取有限上下文。 */
const searchLocation = computed(() => {
  const hit = searchFocus.value;
  if (!hit || hit.nodeId !== selectedId.value || !detail.value || !hit.startLine || !hit.endLine) return null;
  const changed = !hit.contentHash || hit.contentHash !== (detail.value.reference?.contentHash ?? previewDocument.value?.revision.contentHash);
  if (changed) return { hit, warning: "原文或版本已变化，请重新搜索定位", content: "" };
  let content = documentText.value.replace(/\r\n/g, "\n").split("\n").slice(hit.startLine - 1, hit.endLine).join("\n");
  if (content.length > 4000) {
    const position = hit.excerpt ? content.indexOf(hit.excerpt) : -1;
    if (position < 0) return { hit, warning: "命中片段无法定位，请重新搜索", content: "" };
    let start = Math.max(0, position - 120), end = Math.min(content.length, start + 2000);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start]!)) start--;
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    content = content.slice(start, end);
  }
  return { hit, warning: null, content };
});
const referenceReadAt = computed(() => detail.value?.reference ? new Date(detail.value.reference.readAt).toLocaleString() : "");
const previewIsDraft = computed(() => Boolean(previewRevisionId.value && previewRevisionId.value !== detail.value?.current?.revision.id));
const previewReports = computed(() => nodeReports.value.filter(report => report.revisionId === previewRevisionId.value).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const previewReviewItem = computed(() => [activeRun.value, ...taskList.value].flatMap(run => run?.items ?? []).find(item => item.nodeId === readingNodeId.value && item.revisionId === previewRevisionId.value && item.review));
/** 活动任务正在处理的节点；重新复检只避开这些节点，不整个阻塞。 */
const activelyProcessedNodeIds = computed(() => {
  const ids = new Set<string>();
  for (const run of [activeRun.value, ...taskList.value]) {
    if (!run?.active) continue;
    for (const item of run.items) {
      if (run.activeItemId === item.id || run.activeItemIds?.includes(item.id)) ids.add(item.nodeId);
    }
  }
  return ids;
});
/** 当前阅读版本是否正被任务处理，用于单独放行「重新复检」。 */
const readingReviewActivity = computed(() => readingNodeId.value ? knowledgeDocumentReviewActivity(taskList.value, readingNodeId.value, previewRevisionId.value) : null);
const previewReviewStatus = computed(() => {
  if (reportsReadError.value) return "报告读取失败";
  const report = previewReports.value[0];
  return report ? report.stale ? "复检已失效" : report.outcome === "passed" ? "复检通过" : report.outcome === "passed_with_warnings" ? "复检通过（有提醒）" : "发现问题" : previewReviewItem.value ? knowledgeReviewLabel(previewReviewItem.value) : "未复检";
});
const statusLabel = computed(() => node.value?.contentMode === "directory" ? "目录" : node.value?.contentMode === "reference" ? "实时引用" : detail.value?.drafts.length ? "有待采用版本" : detail.value?.current ? "已确认采用" : "待生成");
/** 已入库启用用绿色标识；其余状态沿用默认标签样式。 */
const statusColor = computed(() => statusLabel.value === "已确认采用" ? "green" : undefined);
const thread = computed(() => assistantThreadId.value ? chat.threadSummaryById(assistantThreadId.value) : null);
const threadRunning = computed(() => Boolean(chat.threadDisplayRunningStateForThread(assistantThreadId.value)?.runningTurnId));
const knowledgeConversation = computed(() => conversations.value.find(c => c.threadId === assistantThreadId.value));
const modelSettingsBlocked = computed(() => !canWrite.value || binding.value || busy.value || updatesBusy.value || buildStarting.value || threadRunning.value || Boolean(activeRun.value?.active));
/** 已连接会话的真实配置用于后续构建；未开始对话时沿用已保存选择。 */
const knowledgeModelPrefs = computed<KnowledgeBuildPrefs>(() => {
  const current = knowledgeConversation.value;
  if (current && bindingReady.value) {
    const prefs = chat.threadPrefsByThreadId[current.threadId];
    const selected = { model: prefs?.model !== undefined ? prefs.model : current.model, effort: prefs?.effort !== undefined ? prefs.effort : current.effort };
    const models = engines.byTypeForWorkspace(workspaceId.value).get(current.engine)?.models ?? [];
    const resolved = models.length ? resolveThreadPrefsWithCatalogDefaults(current.engine, selected, models) : selected;
    return { engine: current.engine, model: resolved.model, effort: resolved.effort };
  }
  return buildPrefs.value ?? { engine: initialEngine.value, ...knowledgeConversationCreatePrefs(initialEngine.value) };
});
const sortedConversations = computed(() => [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.threadId.localeCompare(b.threadId)));
const conversationOptions = computed(() => sortedConversations.value.map(c => ({ value: c.threadId, label: c.title, description: conversationDescription(c) })));
const startNodeId = computed(() => null);
const recentConversation = computed(() => latestConversation(startNodeId.value));
const batchTargets = computed(() => {
  const revisionRun = batchRevisionRunId.value ? taskList.value.find(run => run.id === batchRevisionRunId.value) : null;
  const nodes = revisionRun?.proposedTree?.nodes ?? snapshot.value?.tree.nodes ?? [];
  return knowledgeSelectedNodes(nodes, batchSelectedIds.value, batchIncludeDescendants.value).filter(n => {
    if (!knowledgeNodeHasBody(n)) return false;
    if (batchMode.value !== "review" && ancestors(n)[0]?.category === "product") return false;
    const state = statesById.value.get(n.id);
    return batchMode.value === "review" ? Boolean(state?.revisionId || state?.draftCount || revisionRun?.items.some(item => item.nodeId === n.id && item.revisionId))
      : batchStrategy.value === "all" || !state?.revisionId && !state?.draftCount;
  });
});
const batchHasGeneration = computed(() => batchMode.value === "batch");
const batchModel = computed(() => ({ engine: batchEngine.value, model: batchModelId.value || null, effort: batchEffort.value || null }));
const batchEngineStatus = computed(() => engines.byTypeForWorkspace(workspaceId.value).get(batchEngine.value));
const batchModelGroups = computed(() => buildModelSelectOptionGroups(batchEngineStatus.value?.models ?? [], batchModelId.value));
const batchModelInfo = computed(() => {
  const models = batchEngineStatus.value?.models ?? [];
  return batchModelId.value ? models.find(model => model.id === batchModelId.value) : models.find(model => model.isDefault);
});
const batchEffortOptions = computed(() => {
  const info = batchModelInfo.value;
  const options: Array<{ value: string; label: string }> = (info?.supportedReasoningEfforts ?? []).map(option => ({
    value: option.reasoningEffort,
    label: option.reasoningEffort === info?.defaultReasoningEffort ? `${option.reasoningEffort}（默认）` : option.reasoningEffort,
  }));
  if (!info && batchEffort.value) options.unshift({ value: batchEffort.value, label: `${batchEffort.value}（当前值）` });
  return options;
});
const batchCatalog = computed(() => engines.byWorkspaceId[workspaceId.value]);
const batchIncludesProduct = computed(() => batchTargets.value.some(node => ancestors(node)[0]?.category === "product"));
const batchReviewConfig = computed(() => ({ enabled: batchMode.value === "review" || batchReviewEnabled.value, model: batchReviewModelId.value || null, effort: batchReviewEffort.value || null, autoRepair: batchReviewAutoRepair.value && !batchIncludesProduct.value, maxRounds: batchReviewMaxRounds.value }));
const batchReviewModelGroups = computed(() => buildModelSelectOptionGroups(batchEngineStatus.value?.models ?? [], batchReviewModelId.value));
const batchReviewModelInfo = computed(() => {
  const models = batchEngineStatus.value?.models ?? [];
  return batchReviewModelId.value ? models.find(model => model.id === batchReviewModelId.value) : batchModelInfo.value;
});
const batchReviewEffortOptions = computed(() => {
  const info = batchReviewModelInfo.value;
  const options: Array<{ value: string; label: string }> = (info?.supportedReasoningEfforts ?? []).map(option => ({ value: option.reasoningEffort, label: option.reasoningEffort === info?.defaultReasoningEffort ? `${option.reasoningEffort}（默认）` : option.reasoningEffort }));
  if (!info && batchReviewEffort.value) options.unshift({ value: batchReviewEffort.value, label: `${batchReviewEffort.value}（当前值）` });
  return options;
});
watch([batchModelInfo, batchOpen], () => {
  if (!batchOpen.value || !batchModelInfo.value || !batchEffort.value) return;
  const info = batchModelInfo.value;
  if (!info.supportedReasoningEfforts?.some(option => option.reasoningEffort === batchEffort.value)) {
    batchEffort.value = info.defaultReasoningEffort ?? "";
  }
});
watch([batchReviewModelInfo, batchOpen], () => {
  if (!batchOpen.value || !batchReviewModelInfo.value || !batchReviewEffort.value) return;
  const info = batchReviewModelInfo.value;
  if (!info.supportedReasoningEfforts?.some(option => option.reasoningEffort === batchReviewEffort.value)) batchReviewEffort.value = info.defaultReasoningEffort ?? "";
});
const boundScopeTitle = computed(() => pathTitle(snapshot.value?.tree.nodes.find(item => item.id === boundNodeId.value) ?? null));
/** 统一任务记录显示和结果判断，讨论记录不冒充可交付结果。 */
function taskHasResult(run: KnowledgeGenerationRunView | null): boolean {
  return Boolean(run && (run.mode === "build" || run.proposedTree || run.appliedTreeHash || run.items.length || run.error || run.phase === "interrupted" || run.phase === "partial" || run.phase === "failed"));
}
/** 批任务草稿走统一预览，独立讨论沿用正文采用接口。 */
function usesUnifiedPreview(run: KnowledgeGenerationRunView): boolean { return ["build", "batch", "review"].includes(run.mode); }


let scopeEpoch = 0;
let executionSessionEpoch = 0;
let nodeEpoch = 0;
let revisionEpoch = 0;
let importEpoch = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
let runRequestVersion = 0;
// run.start 之前会先等待绑定原知识会话；这段等待期间 busy 还没来得及更新，
// 连续点击会让两个请求同时进入 Client。动作令牌在第一次 await 前同步占位，
// 并且只允许持有当前令牌的 finally 释放 busy，避免旧请求覆盖新动作状态。
let knowledgeActionFlight = 0;
let snapshotStatesTimer: ReturnType<typeof setTimeout> | null = null;
let readController: AbortController | null = null;
let searchController: AbortController | null = null;
let searchRequestEpoch = 0;
let pendingRouteThreadId: string | null = null;
let hydratingPageState = false;


/** 本机规格库请求直接进入 Client；共享工作区仍由请求层选择 Server。 */
function ctx(): ApiRequestContext {
  return { desktopClientId: config.desktopClient?.clientId, serverWsOrigin: config.serverWsOrigin, sessionToken: config.sessionToken, webSessionId: config.webSessionId,
    ensureSession: signal => config.ensureSession(signal), clearSession: () => config.expireCurrentSession() };
}
function unwrap<T>(result: ApiResult<{ data: T }>): T {
  if (!result.ok) throw createApiResultError(result);
  return result.data;
}
/** 检索整个规格库，结果不受左侧目录选择影响。 */
async function runKnowledgeSearch(): Promise<void> {
  const query = searchQuery.value.trim();
  if (!query) {
    closeSearchResults();
    return;
  }
  const requestEpoch = ++searchRequestEpoch;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  searchLoading.value = true;
  searchError.value = null;
  searchVisible.value = true;
  try {
    const result = unwrap(await requestKnowledgeAsset(ctx(), "search", {
      workspaceId: workspaceId.value,
      query,
      includeDrafts: true,
    }, { signal: controller.signal }));
    if (controller.signal.aborted || requestEpoch !== searchRequestEpoch) return;
    searchResults.value = result.items;
    searchError.value = result.issues.length ? result.issues.map(item => `${item.nodeId}：${item.message}`).join("；") : null;
  } catch (error) {
    if (!isAborted(error) && !controller.signal.aborted && requestEpoch === searchRequestEpoch) searchError.value = reportError(error, "KNOWLEDGE_SEARCH_FAILED");
  } finally {
    if (searchController === controller && requestEpoch === searchRequestEpoch) {
      searchController = null;
      searchLoading.value = false;
    }
  }
}
/** 关闭搜索结果并使迟到响应失效，避免结果重新出现或继续占用页面交互。 */
function closeSearchResults(): void {
  searchRequestEpoch += 1;
  searchController?.abort();
  searchController = null;
  searchLoading.value = false;
  searchResults.value = [];
  searchError.value = null;
  searchVisible.value = false;
}
/** 打开命中的正式或草稿版本，并保留章节行段定位；切换项目或节点后忽略迟到结果。 */
async function openSearchResult(item: KnowledgeAssetSearchHit): Promise<void> {
  if (!await guardEdits()) return;
  const scope = workspaceId.value, epoch = scopeEpoch;
  closeSearchResults();
  updatesTarget.value = null;
  const selectionEpoch = searchRequestEpoch;
  if (!await selectNode(item.nodeId) || !isCurrent(epoch, scope) || selectionEpoch !== searchRequestEpoch) return;
  const revision = [detail.value?.current?.revision, ...(detail.value?.drafts ?? [])].find(revision => revision?.contentHash === item.contentHash);
  if (revision && previewRevisionId.value !== revision.id) await viewRevision(revision.id);
  if (isCurrent(epoch, scope) && selectionEpoch === searchRequestEpoch && selectedId.value === item.nodeId) {
    searchFocus.value = item;
    await nextTick();
    if (searchFocus.value === item) searchLocationElement.value?.scrollIntoView({ block: "nearest" });
  }
}
/** 复用工作区文件预览窗口，原文及相对资源沿真实项目路径打开。 */
async function openWorkspaceFile(filePath: string): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  try {
    const result = await loadWorkspaceFilePreview(ctx(), scope, filePath);
    if (!isCurrent(epoch, scope)) return;
    const win: PreviewWindow = { id: crypto.randomUUID(), workspaceId: scope, filePath, type: "file", previewType: result.previewType,
      content: result.preview?.content ?? null, base64: result.preview?.base64 ?? null, mimeType: result.preview?.mimeType ?? result.spreadsheet?.mimeType ?? null,
      spreadsheet: result.spreadsheet ?? null, diffOriginal: null, diffModified: null, diffStaged: false, diffVersionOld: null, diffVersionNew: null,
      cascadeIndex: ui.explorerPreviewWindows.length, zIndex: 0 };
    if (window.innerWidth <= 767) ui.pushMobilePage({ type: "explorer-preview", context: { win } });
    else ui.openPreviewWindow(win);
  } catch (error) { if (isCurrent(epoch, scope)) errorText.value = reportError(error, "KNOWLEDGE_SOURCE_PREVIEW_FAILED", { filePath }); }
}
/** 保留接口错误原因，无明确信息时展示所属模块的失败提示。 */
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "规格知识库请求失败"; }
/** 记录知识库请求失败；background 用于首屏/轮询读取，失败态已在对应区域展示，不占用顶部横幅。 */
function reportError(error: unknown, code: string, extras: Record<string, unknown> = {}, options: { background?: boolean } = {}): string {
  const text = errorMessage(error);
  const apiDetails = isApiResultError(error) && error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : null;
  const requestId = String(apiDetails?.requestId ?? (error && typeof error === "object" && "requestId" in error ? (error as { requestId?: unknown }).requestId : "") ?? "").trim() || null;
  const operation = String(apiDetails?.operation ?? "").trim() || null;
  const rootCause = String(apiDetails?.rootCause ?? "").trim() || null;
  if (!options.background) errorDiagnostics.value = { code: isApiResultError(error) ? error.code : code, requestId, operation, rootCause };
  console.error("[knowledge-page]", { code, workspaceId: workspaceId.value, nodeId: selectedId.value,
    requestId, runId: activeRun.value?.id ?? null, threadId: assistantThreadId.value, rootCause: rootCause || text, ...extras });
  return requestId ? `${text}（请求 ID：${requestId}）` : text;
}
function dismissError(): void { errorText.value = null; errorDiagnostics.value = null; }
async function copyErrorDiagnostics(): Promise<void> {
  const diagnostics = errorDiagnostics.value;
  if (!diagnostics) return;
  const text = [
    `code=${diagnostics.code}`,
    diagnostics.requestId ? `requestId=${diagnostics.requestId}` : "",
    diagnostics.operation ? `operation=${diagnostics.operation}` : "",
    diagnostics.rootCause ? `rootCause=${diagnostics.rootCause}` : "",
  ].filter(Boolean).join("\n");
  try {
    await navigator.clipboard?.writeText(text);
    message.success("错误诊断已复制");
  } catch {
    message.info(text);
  }
}
/** 异步结果必须同时属于当前页面、工作区和 URL 指定的项目。 */
function isCurrent(epoch: number, scope: WorkspaceId): boolean { return epoch === scopeEpoch && scope === workspaceId.value && (!route.query.workspaceId || route.query.workspaceId === scope); }
function isAborted(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
function ancestors(item: KnowledgeAssetNode): KnowledgeAssetNode[] {
  const result: KnowledgeAssetNode[] = [];
  const seen = new Set<string>();
  let current: KnowledgeAssetNode | undefined = item;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); result.unshift(current);
    const parentId: string | null = current.parentId;
    current = parentId ? nodeMap.value.get(parentId) : undefined;
  }
  return result;
}
function pathTitle(item: KnowledgeAssetNode | null): string { return item ? ancestors(item).map(parent => parent.title).join(" / ") : "整个项目"; }
function conversationDescription(item: KnowledgeConversationSummary): string {
  const scope = item.nodeId ? pathTitle(snapshot.value?.tree.nodes.find(n => n.id === item.nodeId) ?? null) : "整个项目";
  return `${scope} · ${item.engine === "codex" ? "Codex" : "Claude"} · ${new Date(item.updatedAt).toLocaleString("zh-CN", { hour12: false })}`;
}
/** 将知识接口返回的会话摘要同步进会话列表，创建后无需等待下一次列表轮询。 */
function upsertKnowledgeThreadSummary(item: KnowledgeConversationSummary): void {
  chat.upsertThreadSummary({
    id: item.threadId,
    title: item.title,
    threadType: "chat",
    threadSubtype: "knowledge-conversation",
    archived: false,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    engine: item.engine,
  } satisfies ThreadSummary);
}
/** 文件工作会话进入规格分类，列表点击后由规格库右侧打开。 */
function upsertKnowledgeExecutionThreadSummary(input: { threadId: string; title: string; engine: EngineType; createdAt: number; updatedAt: number }): void {
  chat.upsertThreadSummary({
    id: input.threadId as ThreadId,
    title: input.title,
    threadType: "orchestration",
    threadSubtype: "knowledge-assets",
    archived: false,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    engine: input.engine,
  } satisfies ThreadSummary);
}
/** 同步文件工作会话；新复检子任务不再创建独立列表入口。 */
function syncKnowledgeExecutionThreadSummaries(runs: KnowledgeGenerationRunView[]): void {
  for (const run of runs) {
    const timestamp = Date.parse(run.createdAt) || Date.now();
    for (const item of run.items) {
      if (item.executionThreadId) upsertKnowledgeExecutionThreadSummary({ threadId: item.executionThreadId, title: `[知识工作] ${item.title}`, engine: run.engine, createdAt: timestamp, updatedAt: timestamp });
      if (item.review?.executionThreadId && !item.review.parentThreadId) upsertKnowledgeExecutionThreadSummary({ threadId: item.review.executionThreadId, title: `[知识复检] ${item.title}`, engine: run.engine, createdAt: timestamp, updatedAt: timestamp });
    }
  }
}
function executionSessionInfo(runs: KnowledgeGenerationRunView[], threadId: string): { title: string; kind: "知识工作会话" | "复检会话"; model?: string; effort?: string } | null {
  for (const run of runs) for (const item of run.items) {
    if (item.executionThreadId === threadId) {
      const config = item.executionConfig ?? run;
      return { title: item.title, kind: "知识工作会话", ...(config.model ? { model: config.model } : {}), ...(config.effort ? { effort: config.effort } : {}) };
    }
    if (item.review?.executionThreadId === threadId) {
      const config = item.reviewConfig ?? run.reviewConfig ?? run;
      return { title: item.title, kind: "复检会话", ...(config.model ? { model: config.model } : {}), ...(config.effort ? { effort: config.effort } : {}) };
    }
  }
  return null;
}
/** 恢复本人的同范围会话；已保存模型时只推荐配置一致的会话。 */
function latestConversation(nodeId: string | null): KnowledgeConversationSummary | undefined {
  const owned = (conversation: KnowledgeConversationSummary) => conversation.engine === (buildPrefs.value?.engine ?? initialEngine.value)
    && (!buildPrefs.value?.model || conversation.model === buildPrefs.value.model) && conversation.createdByUserId === conversationActorId.value;
  return sortedConversations.value.find(c => c.nodeId === nodeId && owned(c))
    ?? (nodeId !== null ? sortedConversations.value.find(c => c.nodeId === null && owned(c)) : undefined);
}
async function startConversation(nodeId: string | null = startNodeId.value): Promise<void> {
  const recent = latestConversation(nodeId);
  if (recent) await connectConversation(recent.threadId);
  else await createConversation(nodeId);
}
/** 会话链接保留当前阅读视图，避免切换讨论时覆盖正文或概览意图。 */
async function syncConversationRoute(threadId: string | null): Promise<void> {
  if (route.name !== "project-knowledge" || requestedThreadId.value === (threadId ?? "")) return;
  const query: LocationQueryRaw = { ...route.query };
  if (threadId) query.threadId = threadId; else delete query.threadId;
  try { await router.replace({ name: "project-knowledge", query }); }
  catch (error) { reportError(error, "KNOWLEDGE_CONVERSATION_ROUTE_FAILED", { targetThreadId: threadId }); }
}
/** 恢复链接指定的规格会话，任务运行时显式阻止切换。 */
async function connectRequestedConversation(id: string): Promise<void> {
  if (id === assistantThreadId.value && bindingReady.value) { showProjectConversation.value = true; assistantOpen.value = true; return; }
  if (binding.value || threadRunning.value || activeRun.value?.active) {
    message.warning("请先停止当前任务，再切换规格会话");
    await syncConversationRoute(assistantThreadId.value); return;
  }
  const target = conversations.value.find(c => c.threadId === id);
  if (!target || !canWrite.value) {
    bindingError.value = reportError(new Error("当前项目中没有可访问的规格会话；请检查账号、工作区或会话是否已归档。"), "KNOWLEDGE_CONVERSATION_UNAVAILABLE", { targetThreadId: id });
    assistantOpen.value = true;
    return;
  }
  const scope = workspaceId.value, epoch = scopeEpoch;
  await connectConversation(id);
  if (!isCurrent(epoch, scope) || !bindingReady.value || assistantThreadId.value !== id) return;
  // 会话范围和当前阅读资产是两件事；刷新时不得用一级会话范围覆盖用户已选的子资产。
  if (!selectedNodeIntent.value && !selectedId.value && target.nodeId && snapshot.value?.tree.nodes.some(n => n.id === target.nodeId)) await selectNode(target.nodeId);
  if (!isCurrent(epoch, scope) || assistantThreadId.value !== id) return;
  // 显式讨论深链应打开原讨论，阅读文件的自动映射不能抢走该选择。
  showProjectConversation.value = true;
  assistantOpen.value = true;
  if (narrowScreen.value) treeOpen.value = false;
}
/** 首屏、缓存刷新或会话恢复未完成时，深链会话必须排队而不是误判为不存在。 */
function shouldDeferRouteThread(): boolean {
  return loading.value || initialSnapshotRefreshing.value || conversationLoading.value || binding.value;
}
async function drainRequestedConversation(): Promise<void> {
  if (shouldDeferRouteThread()) return;
  const target = pendingRouteThreadId;
  pendingRouteThreadId = null;
  if (target && target === requestedThreadId.value && target !== assistantThreadId.value) await connectRequestedConversation(target);
}
/** 目录与首次进入共用阅读优先级：正式正文、引用、候选；空文档保留在左树。 */
function preferredDocument(scopeId: string | null): KnowledgeAssetNode | null {
  const documents = (scopeId ? knowledgeSelectedNodes(visibleTreeNodes.value, [scopeId], true) : visibleTreeNodes.value).filter(item => !item.archived && item.contentMode !== "directory");
  return documents.find(item => statesById.value.get(item.id)?.revisionId || item.contentMode === "reference" && snapshot.value?.tree.nodes.some(node => node.id === item.id))
    ?? documents.find(item => statesById.value.get(item.id)?.draftCount || visibleWorkTree.value.counts[item.id]) ?? null;
}
/** 缓存与首屏共用同一选择恢复顺序；当前用户意图优先于刷新前的旧选择。 */
function restoreSelectedNode(targetSnapshot: KnowledgeAssetsSnapshot, restored: KnowledgePageState | null, scope: WorkspaceId): void {
  const routeNodeId = typeof route.query.nodeId === "string" ? route.query.nodeId : null;
  const candidateNodeId = route.query.view === "overview" ? null : routeNodeId ?? selectedNodeIntent.value ?? restored?.selectedId ?? null;
  const restoredNode = candidateNodeId && targetSnapshot.tree.nodes.some(item => item.id === candidateNodeId && !item.archived) ? candidateNodeId : null;
  selectedNodeIntent.value = candidateNodeId;
  selectedNodeIntentWorkspace = restoredNode ? scope : null;
  selectedId.value = restoredNode;
  overviewOpen.value = route.query.view === "overview" || !candidateNodeId && !updatesTarget.value && !requestedExecutionThreadId.value && !requestedThreadId.value && route.query.view !== "assets";
  if (restoredNode && targetSnapshot.tree.nodes.find(item => item.id === restoredNode)?.contentMode === "directory") {
    const legacyFile = restored?.directoryPreviewId && knowledgeSelectedNodes(visibleTreeNodes.value, [restoredNode], true).find(item => item.id === restored.directoryPreviewId && item.contentMode !== "directory");
    selectedId.value = legacyFile ? legacyFile.id : preferredDocument(restoredNode)?.id ?? restoredNode;
    selectedNodeIntent.value = selectedId.value;
  }
  viewTab.value = restored?.viewTab ?? "node";
}
/** 本机会话按可信 actor 隔离，Server 地址变化不丢失单机选择。 */
function conversationStorageKey(): string {
  return `knowledge-active-session:${encodeURIComponent(JSON.stringify([desktopWorkspace.value ? "desktop" : config.serverWsOrigin, conversationActorId.value ?? "", workspaceId.value]))}`;
}
/** 本机目录展开只跟随项目，避免 Server 或认证变化重置选择。 */
function treeStorageKey(): string {
  return `knowledge-tree:${encodeURIComponent(JSON.stringify([desktopWorkspace.value ? "desktop" : config.serverWsOrigin, workspaceId.value]))}`;
}
/** 生成当前工作区的页面状态键；会话级状态不依赖可变的 Server 地址。 */
function pageStateKey(): string {
  return `knowledge-page-state:v2:${encodeURIComponent(workspaceId.value)}`;
}
/** 读取旧版本按 Server 地址和工作区分隔的状态键，仅用于迁移已有页面选择。 */
function previousPageStateKey(): string {
  return `knowledge-page-state:${encodeURIComponent(JSON.stringify([config.serverWsOrigin, workspaceId.value]))}`;
}
/** 读取更早版本按账号分隔的状态键，仅用于迁移已有页面选择。 */
function legacyPageStateKey(): string {
  return `knowledge-page-state:${encodeURIComponent(JSON.stringify([config.serverWsOrigin, config.userSummary?.userId ?? "", workspaceId.value]))}`;
}
type KnowledgePageState = { selectedId: string | null; overviewOpen?: boolean; directoryPreviewId?: string | null; viewTab: "node" | "sources" | "review"; assistantOpen: boolean; selectedChangeId: string | null; updatesTarget: KnowledgeUpdateTarget | null };
/** 读取本标签页上次的目录、面板和文档视图状态；损坏数据按空状态处理并记录错误。 */
function restorePageState(): KnowledgePageState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = [pageStateKey(), previousPageStateKey(), legacyPageStateKey()]
      .map(key => window.sessionStorage.getItem(key))
      .find(value => value !== null) ?? null;
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    const viewTab = ["node", "sources", "review"].includes(String(value.viewTab)) ? value.viewTab as KnowledgePageState["viewTab"] : "node";
    const legacyNode = value.pageView === "results" ? value.resultNodeId : value.pageView === "approvals" ? value.approvalNodeId : value.selectedId;
    const target = value.updatesTarget && typeof value.updatesTarget === "object" ? value.updatesTarget as Record<string, unknown> : null;
    return { selectedId: typeof legacyNode === "string" ? legacyNode : typeof value.selectedId === "string" ? value.selectedId : null,
      directoryPreviewId: typeof value.directoryPreviewId === "string" ? value.directoryPreviewId : null,
      viewTab, overviewOpen: value.overviewOpen === true, assistantOpen: value.assistantOpen === true,
      selectedChangeId: typeof value.selectedChangeId === "string" ? value.selectedChangeId : null,
      updatesTarget: target ? { scopeNodeId: typeof target.scopeNodeId === "string" ? target.scopeNodeId : null, changeId: typeof target.changeId === "string" ? target.changeId : null, focusId: typeof target.focusId === "string" ? target.focusId : null, report: target.report === true, recoveryRunId: typeof target.recoveryRunId === "string" ? target.recoveryRunId : undefined }
        : value.updatesOpen === true || value.pageView === "results" || value.pageView === "approvals" ? { scopeNodeId: typeof legacyNode === "string" ? legacyNode : null } : null };
  } catch (error) { reportError(error, "KNOWLEDGE_PAGE_STATE_RESTORE_FAILED"); return null; }
}
/** 保存页面视图状态，不保存正文或会话凭据。 */
function persistPageState(): void {
  if (typeof window === "undefined" || hydratingPageState || !snapshot.value) return;
  try {
    // 后台快照不能清空用户已选节点，正文选择与左树保持一致。
    const persistedSelectedId = selectedId.value ?? selectedNodeIntent.value;
    window.sessionStorage.setItem(pageStateKey(), JSON.stringify({ selectedId: overviewOpen.value ? null : persistedSelectedId, overviewOpen: overviewOpen.value, viewTab: viewTab.value, assistantOpen: assistantOpen.value, selectedChangeId: selectedChangeId.value, updatesTarget: updatesTarget.value } satisfies KnowledgePageState));
  }
  catch (error) { reportError(error, "KNOWLEDGE_PAGE_STATE_SAVE_FAILED"); }
}

function restoreConversation(): { threadId: ThreadId; nodeId: string | null } | null {
  try {
    const raw = window.sessionStorage.getItem(conversationStorageKey());
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || !("threadId" in saved) || typeof saved.threadId !== "string" || !saved.threadId) return null;
    return { threadId: saved.threadId as ThreadId, nodeId: "nodeId" in saved && typeof saved.nodeId === "string" ? saved.nodeId : null };
  } catch (error) { reportError(error, "KNOWLEDGE_CONVERSATION_RESTORE_FAILED"); return null; }
}
function rememberConversation(threadId: ThreadId | null, nodeId: string | null = null): void {
  try {
    if (threadId) window.sessionStorage.setItem(conversationStorageKey(), JSON.stringify({ threadId, nodeId }));
    else window.sessionStorage.removeItem(conversationStorageKey());
  } catch (error) { reportError(error, "KNOWLEDGE_CONVERSATION_MEMORY_FAILED"); }
}
function discardUnavailableConversation(): void {
  rememberConversation(null);
  assistantThreadId.value = null; bindingReady.value = false; boundNodeId.value = null;

}
function isUnavailableConversation(error: unknown): boolean {
  if (!isApiResultError(error)) return false;
  return /(?:NOT_FOUND|PERMISSION_DENIED|FORBIDDEN)$/u.test(error.code)
    || (error.code === "KNOWLEDGE_ASSET_CONFLICT" && error.message === "请选择未归档的普通会话");
}
/** 读取失败保留当前目标供重试；采用后优先正式版本，目录与引用不加载正文复检。 */
async function readNode(id: string, preferCurrent = false): Promise<boolean> {
  const scope = workspaceId.value, epoch = scopeEpoch, requestEpoch = ++nodeEpoch;
  if (detail.value?.node.contentMode === "reference") detail.value = null;
  if (documentReadError.value && errorText.value === documentReadError.value.message) dismissError();
  documentReadError.value = null;
  nodeLoading.value = true;
  try {
    if (!snapshot.value?.tree.nodes.some(node => node.id === id)) { detail.value = null; return false; }
    const loaded = unwrap(await requestKnowledgeAsset(ctx(), "node", { workspaceId: scope, nodeId: id }));
    if (!isCurrent(epoch, scope) || requestEpoch !== nodeEpoch || readingNodeId.value !== id || editing.value) return false;
    detail.value = loaded;
    if (!knowledgeNodeHasBody(loaded.node)) { previewDocument.value = null; previewRevisionId.value = null; nodeReports.value = []; return true; }
    const revisions = [loaded.current?.revision, ...loaded.drafts].filter(item => item != null);
    const target = preferCurrent ? loaded.current?.revision.id ?? null : revisions.some(item => item.id === previewRevisionId.value) ? previewRevisionId.value : loaded.current?.revision.id ?? (loaded.drafts.length === 1 ? loaded.drafts[0]!.id : null);
    await Promise.all([viewRevision(target, false), readReports(id)]);
    return isCurrent(epoch, scope) && requestEpoch === nodeEpoch && readingNodeId.value === id && !reportsReadError.value && (!target || previewDocument.value?.revision.id === target);
  } catch (error) {
    if (isCurrent(epoch, scope) && requestEpoch === nodeEpoch && readingNodeId.value === id && !isAborted(error)) {
      const failure = reportError(error, "KNOWLEDGE_NODE_READ_FAILED", { nodeId: id });
      documentReadError.value = { message: failure, revisionId: null };
      errorText.value = failure;
    }
    return false;
  } finally { if (requestEpoch === nodeEpoch) nodeLoading.value = false; }
}
/** 用户切版本先保护编辑；已确认的内部重读可跳过离开检查，同版本正文保持 DOM。 */
async function viewRevision(id: string | null, protectEdits = true): Promise<void> {
  if (protectEdits && id !== previewRevisionId.value && !await guardEdits()) return;
  const scope = workspaceId.value, epoch = scopeEpoch, requestEpoch = ++revisionEpoch, nodeId = readingNodeId.value;
  if (id === previewRevisionId.value && previewDocument.value) return;
  if (documentReadError.value && errorText.value === documentReadError.value.message) dismissError();
  documentReadError.value = null;
  previewRevisionId.value = id; editing.value = false;
  if (!id || !nodeId) return;
  if (detail.value?.current?.revision.id === id) { previewDocument.value = detail.value.current; editContent.value = detail.value.current.content; return; }
  previewDocument.value = null;
  revisionLoading.value = true;
  try {
    const document = unwrap(await requestKnowledgeAsset(ctx(), "revision", { workspaceId: scope, nodeId, revisionId: id }));
    if (!isCurrent(epoch, scope) || requestEpoch !== revisionEpoch || nodeId !== readingNodeId.value) return;
    previewDocument.value = document; editContent.value = document.content;
  } catch (error) {
    if (isCurrent(epoch, scope) && requestEpoch === revisionEpoch && nodeId === readingNodeId.value) {
      const failure = reportError(error, "KNOWLEDGE_REVISION_READ_FAILED", { nodeId, revisionId: id });
      documentReadError.value = { message: failure, revisionId: id };
      errorText.value = failure;
    }
  }
  finally { if (requestEpoch === revisionEpoch) revisionLoading.value = false; }
}
/** 按失败请求重读节点或确切版本，不根据上次成功的正文猜测重试目标。 */
async function retryReadDocument(): Promise<void> {
  if (!readingNodeId.value || !documentReadError.value || busy.value || updatesBusy.value) return;
  if (documentReadError.value.revisionId) await viewRevision(documentReadError.value.revisionId, false);
  else await readNode(readingNodeId.value);
}
/** 报告与当前阅读文件及请求代次绑定，失败显示明确原因。 */
async function readReports(nodeId: string): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch, requestEpoch = nodeEpoch;
  reportsLoading.value = true; reportsReadError.value = null;
  try {
    const reports = unwrap(await requestKnowledgeAsset(ctx(), "reviews", { workspaceId: scope, nodeId }));
    if (isCurrent(epoch, scope) && readingNodeId.value === nodeId && requestEpoch === nodeEpoch) nodeReports.value = reports;
  } catch (error) {
    if (isCurrent(epoch, scope) && readingNodeId.value === nodeId && requestEpoch === nodeEpoch) {
      nodeReports.value = [];
      reportsReadError.value = `复检报告读取失败：${reportError(error, "KNOWLEDGE_REVIEW_READ_FAILED")}`;
      errorText.value = reportsReadError.value;
    }
  }
  finally { if (isCurrent(epoch, scope) && requestEpoch === nodeEpoch) reportsLoading.value = false; }
}
/** 左树统一切换正文；内部恢复保留会话深链，目录优先打开可读后代。 */
async function selectNode(id: string, preserveLink = false): Promise<boolean> {
  if (!await guardEdits()) return false;
  const targetId = nodeMap.value.get(id)?.contentMode === "directory" ? preferredDocument(id)?.id ?? id : id;
  if (!preserveLink && !await clearApprovalRoute(targetId)) return false;
  if (!preserveLink) closeExecutionSession();
  const scope = workspaceId.value, epoch = scopeEpoch;
  overviewOpen.value = false;
  searchFocus.value = null;
  if (documentReadError.value && errorText.value === documentReadError.value.message) dismissError();
  selectedNodeIntent.value = targetId;
  selectedNodeIntentWorkspace = workspaceId.value || null;
  selectedId.value = targetId; updatesTarget.value = null; suppressAutoPreview.value = null;
  detail.value = null; previewDocument.value = null; previewRevisionId.value = null; documentReadError.value = null; nodeReports.value = []; reportsReadError.value = null; editing.value = false; viewTab.value = "node";
  if (narrowScreen.value) treeOpen.value = false;
  const reading = node.value?.contentMode !== "directory" && readingNodeId.value ? readNode(readingNodeId.value) : null;
  const ticket = nodeEpoch;
  await reading;
  return isCurrent(epoch, scope) && selectedId.value === targetId && ticket === nodeEpoch;
}

/** 返回项目概览时清理文档定位，保留现有会话与后台任务。 */
async function openOverview(): Promise<void> {
  if (!await guardEdits()) return;
  const query: LocationQueryRaw = { ...route.query, view: "overview" };
  delete query.nodeId; delete query.changeId; delete query.executionThreadId;
  try {
    if (router.resolve({ name: "project-knowledge", query }).fullPath !== route.fullPath) {
      const failure = await router.replace({ name: "project-knowledge", query });
      if (failure) throw failure;
    }
  } catch (error) { errorText.value = reportError(error, "KNOWLEDGE_OVERVIEW_ROUTE_FAILED"); return; }
  closeExecutionSession(); closeSearchResults();
  selectedId.value = null; selectedNodeIntent.value = null; updatesTarget.value = null; selectedChangeId.value = null;
  detail.value = null; previewDocument.value = null; previewRevisionId.value = null;
  overviewOpen.value = true;
  if (narrowScreen.value) treeOpen.value = false;
  persistPageState();
}

/** 常用对话入口复用原会话；编辑等待期间切换工作区时不操作新页面。 */
async function openSpecificationConversation(): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  if (!await guardEdits() || !isCurrent(epoch, scope)) return;
  assistantOpen.value = true; showProjectConversation.value = true;
  if (narrowScreen.value) treeOpen.value = false;
  if (!bindingReady.value) await startConversation();
}

/** 重新核对原提案前后复核工作区与会话；迟到结果不能预填其他项目。 */
async function recheckKnowledgeChange(change: KnowledgeChangeDetail): Promise<void> {
  if (!canWrite.value || busy.value || binding.value || threadRunning.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch;
  await openSpecificationConversation();
  if (!isCurrent(epoch, scope)) return;
  if (bindingReady.value && boundNodeId.value !== null) await startConversation(null);
  if (!isCurrent(epoch, scope)) return;
  if (!bindingReady.value || !assistantThreadId.value || boundNodeId.value !== null) {
    bindingError.value = bindingError.value || reportError(new Error("项目范围规格会话尚未就绪，原提案未发送，请重试连接"), "KNOWLEDGE_CHANGE_RECHECK_SCOPE_UNAVAILABLE", { nodeId: change.nodeId, changeId: change.id });
    return;
  }
  const prompt = [
    "请对照最新正式正文重新核对以下已过期的规格修改建议，保留用户原始要求和其他人的正确修改。",
    `节点：${change.nodeId}；原提案：${change.id}；摘要：${change.summary}`,
    `过期原因：${change.staleReasons.join("；")}`,
    "先读取当前节点与直接来源，逐项判断原建议是否仍需要；冲突指出影响并询问，不能自动选择优先级。需要修订时提交新的待确认建议，旧提案保持可追溯，不直接修改正式文档。",
    "原建议正文：", change.content,
  ].join("\n\n");
  composer.enqueueExternalAction({ workspaceId: scope, threadId: assistantThreadId.value, kind: "append-text", text: prompt });
}

/** 概览重试沿用已有状态与任务读取边界，失败仍在各自入口显示。 */
async function retryOverview(): Promise<void> {
  await refreshSnapshotStates(workspaceId.value, scopeEpoch, snapshot.value?.treeHash ?? null);
  await refreshRuns();
}

/** 未保存编辑离开时提供保存、放弃和继续编辑，写入失败不会继续导航。 */
async function guardEdits(): Promise<boolean> {
  if (updatesBusy.value || busy.value) return false;
  if (!editing.value || editContent.value === documentText.value) return true;
  if (pendingEditDecision.value) return false;
  const choice = await new Promise<"save" | "discard" | "stay">(resolve => { pendingEditDecision.value = resolve; });
  pendingEditDecision.value = null;
  if (choice === "stay") return false;
  if (choice === "save") { await saveManual(); return !editing.value; }
  editing.value = false; editContent.value = documentText.value;
  return true;
}

/** 来源和复检属于当前正文的次级查看，切换前同样保护未保存编辑。 */
async function setContentView(value: "node" | "sources" | "review"): Promise<void> {
  if (await guardEdits()) viewTab.value = value;
}

/** 更新确认复用主阅读区；返回是否成功切换，取消编辑保护时停止后续定位。 */
async function openUpdates(scopeNodeId: string | null = selectedId.value): Promise<boolean> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  if (!await guardEdits() || !isCurrent(epoch, scope)) return false;
  const query: LocationQueryRaw = { ...route.query, view: "results" };
  delete query.changeId; delete query.executionThreadId;
  try {
    if (router.resolve({ name: "project-knowledge", query }).fullPath !== route.fullPath) {
      const failure = await router.replace({ name: "project-knowledge", query });
      if (failure) throw failure;
    }
  } catch (error) { errorText.value = reportError(error, "KNOWLEDGE_UPDATES_ROUTE_FAILED"); return false; }
  if (!isCurrent(epoch, scope)) return false;
  closeExecutionSession();
  overviewOpen.value = false;
  updatesTarget.value = { scopeNodeId }; selectedChangeId.value = null;
  if (narrowScreen.value) { treeOpen.value = false; assistantOpen.value = false; }
  return true;
}

/** 返回正式内容，空文件保留可见占位，不自动再次打开候选。 */
function closeUpdates(): void {
  if (updatesBusy.value) return;
  closeExecutionSession();
  updatesTarget.value = null; selectedChangeId.value = null; suppressAutoPreview.value = readingNodeId.value;
  overviewOpen.value = route.query.view === "overview" || route.query.view !== "assets" && !readingNodeId.value;
  clearApprovalRoute();
}

/** 采用或不采用后刷新事实和索引，不改变文件、版本、会话选择。 */
async function updatesChanged(run?: KnowledgeGenerationRunView): Promise<void> {
  if (run) receiveRun(run);
  try { await refreshSnapshot(); await refreshPendingChanges(workspaceId.value, scopeEpoch); }
  catch (error) { errorText.value = reportError(error, "KNOWLEDGE_UPDATES_REFRESH_FAILED"); }
}

/** 历史建议采用后同步正式快照和正在阅读的正文，不只刷新后台任务。 */
async function historyChangeReviewed(): Promise<void> {
  await updatesChanged();
  if (readingNodeId.value) await readNode(readingNodeId.value);
}

/** 成功采用后重读正式事实；批量仍有待办时保留清单，否则交付当前正文。 */
async function afterApply(context: KnowledgeDocumentContext, count: number): Promise<boolean> {
  const scope = workspaceId.value, epoch = scopeEpoch, target = updatesTarget.value;
  const scopeNodeId = target?.scopeNodeId ?? (target ? null : readingNodeId.value);
  await refreshSnapshot();
  if (!isCurrent(epoch, scope)) return true;
  const refreshed = await refreshPendingChanges(scope, epoch);
  if (!isCurrent(epoch, scope)) return true;
  if (!refreshed) throw new Error("内容已采用，但待确认更新读取失败，请重试。");
  const ids = scopeNodeId ? new Set(knowledgeSelectedNodes(visibleTreeNodes.value, [scopeNodeId], true).map(node => node.id)) : null;
  const remaining = visibleWorkTree.value.updates.some(update => !ids || ids.has(update.nodeId)) || pendingChangeNodes.value.some(change => !ids || ids.has(change.nodeId));
  if ((!scopeNodeId || nodeMap.value.get(scopeNodeId)?.contentMode === "directory") && remaining) {
    message.success(`已采用 ${count} 项更新`);
    return false;
  }
  const adoptedNode = nodeMap.value.get(context.nodeId);
  const nodeId = adoptedNode?.contentMode === "directory"
    ? knowledgeSelectedNodes(snapshot.value?.tree.nodes ?? [], [adoptedNode.id], true).find(node => node.contentMode === "reference" || snapshot.value?.states.some(state => state.nodeId === node.id && state.revisionId))?.id ?? context.nodeId
    : context.nodeId;
  if (!nodeMap.value.has(nodeId)) throw new Error("内容已采用，但正式目录尚未同步，请重试。");
  selectedNodeIntent.value = nodeId; selectedNodeIntentWorkspace = scope;
  selectedId.value = nodeId;
  executionSession.value = knowledgeDocumentSession(taskList.value, context);
  if (nodeMap.value.get(nodeId)?.contentMode === "directory") {
    detail.value = null; previewDocument.value = null; previewRevisionId.value = null; nodeReports.value = [];
  } else {
    const loaded = await readNode(nodeId, true);
    if (!isCurrent(epoch, scope)) return true;
    if (!loaded) throw new Error("内容已采用，但正式正文读取失败，请重新选择该文件重试。");
  }
  if (knowledgeNodeHasBody(nodeMap.value.get(nodeId)!) && !detail.value?.current && !detail.value?.reference) throw new Error("内容已采用，但未能读取正式版本，请重新选择该文件重试。");
  const readEpoch = nodeEpoch;
  approvalRouteNodeId.value = nodeId;
  try {
    if (!await clearApprovalRoute(nodeId)) throw new Error("内容已采用，但页面定位更新失败，请重试。");
  } finally { approvalRouteNodeId.value = null; }
  if (!isCurrent(epoch, scope) || selectedId.value !== nodeId || readEpoch !== nodeEpoch) return true;
  viewTab.value = "node"; editing.value = false; searchFocus.value = null;
  suppressAutoPreview.value = nodeId; selectedChangeId.value = null;
  showProjectConversation.value = false;
  executionSession.value = knowledgeDocumentSession(taskList.value, { nodeId, runId: null, revisionId: previewRevisionId.value });
  adoptedTransitionNodeId = nodeId;
  message.success(`已采用 ${count} 项更新`);
  return true;
}

/** 自动候选进入写入阶段后固定确认上下文，避免正式版本出现时卸载采用组件。 */
async function handleUpdatesBusy(value: boolean): Promise<void> {
  const previous = updatesBusy.value;
  if (value && autoPreview.value && !updatesTarget.value) updatesTarget.value = { scopeNodeId: readingNodeId.value };
  updatesBusy.value = value;
  if (previous && !value) {
    if (adoptedTransitionNodeId && selectedId.value === adoptedTransitionNodeId) updatesTarget.value = null;
    adoptedTransitionNodeId = null;
    try { await refreshMaintenanceRecovery(taskList.value, workspaceId.value, scopeEpoch); }
    catch (error) { errorText.value = reportError(error, "KNOWLEDGE_MAINTENANCE_RECOVERY_READ_FAILED"); }
  }
}

/** 仅记住用户明确点开的候选，页面刷新不把旧版本替换成最新版本。 */
async function rememberUpdateFocus(focusId: string): Promise<void> {
  closeExecutionSession();
  const scope = workspaceId.value, epoch = scopeEpoch;
  const target = updatesTarget.value ?? { scopeNodeId: readingNodeId.value };
  if (route.query.changeId) {
    const query: LocationQueryRaw = { ...route.query, view: "results" }; delete query.changeId;
    try { await router.replace({ name: "project-knowledge", query }); }
    catch (error) { errorText.value = reportError(error, "KNOWLEDGE_UPDATE_FOCUS_ROUTE_FAILED", { focusId }); return; }
  }
  if (!isCurrent(epoch, scope)) return;
  selectedChangeId.value = null;
  const next = { ...target, focusId, report: false }; delete next.changeId;
  updatesTarget.value = next;
}
/** 讨论进度按原会话归属恢复；后台构建进度由独立构建卡展示。 */
function chooseRun(runs: KnowledgeGenerationRunView[]): KnowledgeGenerationRunView | null {
  const scoped = runs.filter(run => (run.ownerThreadId ?? run.threadId) === assistantThreadId.value);
  return scoped.find(run => run.active) ?? scoped[0] ?? null;
}
/** 保留原始任务身份，候选目录投影在使用处单独去重。 */
function receiveReviews(runs: KnowledgeGenerationRunView[]): void {
  taskList.value = runs.filter(taskHasResult);
  // 结果树的目录筛选可能暂时引用旧节点；任务投影已经可用时仍应先展示任务正文，
  // 等快照回来后再按目录范围收窄，不能因此把主区渲染成空加载态。
}
/** 左树仅切换阅读目标，保持统一目录导航。 */
function selectTreeNode(id: string): void {
  closeSearchResults();
  void selectNode(id);
}
/** 清除旧审批链接；采用后同步已有文件深链，路由失败则中止导航。 */
async function clearApprovalRoute(nodeId?: string): Promise<boolean> {
  if (!route.query.changeId && !route.query.view && (!nodeId || !route.query.nodeId || route.query.nodeId === nodeId)) return true;
  const query = { ...route.query }; delete query.changeId; delete query.view;
  if (nodeId && route.query.nodeId) query.nodeId = nodeId;
  try {
    const failure = await router.replace({ name: "project-knowledge", query });
    if (failure) throw failure;
    return true;
  }
  catch (error) { errorText.value = reportError(error, "KNOWLEDGE_VIEW_ROUTE_FAILED"); return false; }
}
/** 按所属会话同步活动任务，交付结果统一加入任务索引。 */
function receiveRun(run: KnowledgeGenerationRunView | null): void {
  if (!run || (run.ownerThreadId ?? run.threadId) === assistantThreadId.value) activeRun.value = run;
  if (run && taskHasResult(run)) receiveReviews([run, ...taskList.value.filter(item => item.id !== run.id)]);
}
/** 定时更新结果直接在主页面展示，优先定位本次任务的候选。 */
async function openUpdateResult(run: KnowledgeGenerationRunView): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  receiveRun(run);
  const candidate = visibleWorkTree.value.updates.find(update => update.runId === run.id);
  if (!await openUpdates(candidate?.nodeId ?? null) || !isCurrent(epoch, scope)) return;
  if (candidate && updatesTarget.value) updatesTarget.value = { ...updatesTarget.value, focusId: `${candidate.id}:${candidate.revisionId ?? 'structure'}` };
}
/** 主页面沿原回执恢复采用或维护保存，不重新建立任务。 */
async function openRecovery(run: KnowledgeGenerationRunView): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  if (!await openUpdates(null) || !isCurrent(epoch, scope)) return;
  if (updatesTarget.value) updatesTarget.value = { ...updatesTarget.value, recoveryRunId: run.id };
}
/** 将显式会话入口映射到右侧；内部复检链接也回到父工作会话。 */
async function openExecutionSession(threadId: string, title: string, kind: "知识工作会话" | "复检会话", prompt?: string): Promise<ThreadId | null> {
  let id = String(threadId ?? "").trim();
  if (!id || updatesBusy.value) return null;
  const parent = taskList.value.flatMap(run => run.items).find(item => item.review?.executionThreadId === id)?.review?.parentThreadId;
  if (parent) { id = parent; kind = "知识工作会话"; }
  executionSession.value = { threadId: id as ThreadId, title, kind };
  showProjectConversation.value = false;
  assistantOpen.value = true;
  if (prompt) composer.enqueueExternalAction({ workspaceId: workspaceId.value, threadId: id as ThreadId, kind: "append-text", text: prompt });
  return id as ThreadId;
}
/** 按阅读目标加载会话；每次切换撤销旧请求的展示资格，不阻塞正文。 */
async function hydrateExecutionSession(): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  const id = displayedExecutionSession.value?.threadId;
  const ticket = ++executionSessionEpoch;
  hydratedExecutionThreadId.value = null;
  executionSessionError.value = null;
  executionSessionLoading.value = Boolean(id && assistantOpen.value && fileConversationMode.value);
  if (!executionSessionLoading.value || !id) return;
  const current = () => isCurrent(epoch, scope) && ticket === executionSessionEpoch;
  const knownConfig = executionSessionInfo(
    [activeRun.value, ...taskList.value].filter((run): run is KnowledgeGenerationRunView => Boolean(run)),
    id,
  );
  try {
    await chat.ensureThreadHydrated(ctx(), { workspaceId: scope, threadId: id as ThreadId });
    if (!current()) return;
    // 旧执行线程可能保存过错误的默认配置；任务快照才是本次资产执行的冻结配置。
    if (knownConfig?.model || knownConfig?.effort) {
      const expectedPrefs = {
        model: knownConfig.model ?? null,
        effort: knownConfig.effort ?? null,
        accessMode: "read-only" as const,
        planMode: false,
      };
      const currentPrefs = chat.threadPrefsByThreadId[id] ?? {};
      const needsRepair = currentPrefs.model !== expectedPrefs.model
        || currentPrefs.effort !== expectedPrefs.effort
        || currentPrefs.accessMode !== expectedPrefs.accessMode
        || currentPrefs.planMode !== expectedPrefs.planMode;
      if (needsRepair && canWrite.value) {
        const result = await updateThreadPrefs(ctx(), { workspaceId: scope, threadId: id as ThreadId, prefs: expectedPrefs });
        if (!result.ok) throw createApiResultError(result);
      }
      if (!current()) return;
      chat.setThreadPrefs(id as ThreadId, expectedPrefs);
    }
    if (current()) hydratedExecutionThreadId.value = id;
  } catch (error) {
    const failure = reportError(error, "KNOWLEDGE_EXECUTION_SESSION_READ_FAILED", { executionThreadId: id });
    if (current()) executionSessionError.value = failure;
  } finally {
    if (current()) executionSessionLoading.value = false;
  }
}
/** 清理显式会话选择与深链；自动映射仍由当前阅读文件决定。 */
function closeExecutionSession(): void {
  executionSession.value = null;
  showProjectConversation.value = false;
  if (!requestedExecutionThreadId.value || route.name !== "project-knowledge") return;
  const query = { ...route.query };
  delete query.executionThreadId;
  void router.replace({ name: "project-knowledge", query }).catch(error => { errorText.value = reportError(error, "KNOWLEDGE_EXECUTION_ROUTE_FAILED"); });
}
/** 状态补齐请求可能晚于树请求返回旧快照；保留当前树和选中节点，只合并可用状态。 */
function preserveSelectedTree(current: KnowledgeAssetsSnapshot | null, loaded: KnowledgeAssetsSnapshot): KnowledgeAssetsSnapshot | null {
  const intent = selectedNodeIntent.value;
  if (!current || current.root !== loaded.root || !intent || !current.tree.nodes.some(item => item.id === intent && !item.archived) || loaded.tree.nodes.some(item => item.id === intent && !item.archived)) return null;
  const loadedStates = new Map(loaded.states.map(state => [state.nodeId, state]));
  const currentStates = new Map(current.states.map(state => [state.nodeId, state]));
  return { ...current, canWrite: loaded.canWrite, states: current.tree.nodes.map(item => loadedStates.get(item.id) ?? currentStates.get(item.id) ?? { nodeId: item.id, revisionId: null, draftCount: 0, error: null }) };
}
/** 更新项目快照；只有选中资产的版本状态变化时才重读正文，避免轮询清空预览。 */
async function refreshSnapshot(): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  const loaded = unwrap(await requestKnowledgeAsset(ctx(), "snapshot", { workspaceId: scope }));
  if (!isCurrent(epoch, scope)) return;
  snapshotStatesError.value = null;
  const previousState = readingNodeId.value ? snapshot.value?.states.find(state => state.nodeId === readingNodeId.value) : null;
  const nextState = readingNodeId.value ? loaded.states.find(state => state.nodeId === readingNodeId.value) : null;
  const nodeStateChanged = JSON.stringify(previousState ?? null) !== JSON.stringify(nextState ?? null);
  if (snapshot.value && snapshot.value.root === loaded.root && snapshot.value.treeHash === loaded.treeHash && snapshot.value.canWrite === loaded.canWrite && JSON.stringify(snapshot.value.states) === JSON.stringify(loaded.states)) return;
  const preserved = preserveSelectedTree(snapshot.value, loaded);
  if (preserved) { snapshot.value = preserved; return; }
  snapshot.value = loaded;
  if (selectedId.value && !loaded.tree.nodes.some(item => item.id === selectedId.value)) {
    // 轮询或任务写入期间可能读到短暂的旧树；保留用户选择，避免页面跳回一级概览。
    if (selectedNodeIntent.value !== selectedId.value) { selectedId.value = null; detail.value = null; }
  }
  if (!selectedId.value && selectedNodeIntent.value && loaded.tree.nodes.some(item => item.id === selectedNodeIntent.value && !item.archived)) {
    selectedId.value = selectedNodeIntent.value;
    void readNode(selectedNodeIntent.value);
  }
  if (readingNodeId.value && !editing.value && !showUpdates.value && nodeStateChanged) await readNode(readingNodeId.value);
}
/** 后台补齐节点状态；失败结束加载并保留目录，用户可沿原入口重试。 */
async function refreshSnapshotStates(scope: WorkspaceId, epoch: number, expectedTreeHash: string | null): Promise<void> {
  // 任务执行期间状态会随每项提交变化；此时全量扫描所有 revision 只会抢占 Client
  // 事件循环，任务面板已经提供实时进度，等任务结束再补权威快照。
  if (activeRun.value?.active || pollInFlight) return;
  snapshotStatesError.value = null;
  try {
    const loaded = unwrap(await requestKnowledgeAsset(ctx(), "snapshot", { workspaceId: scope, includeStates: true }));
    if (!isCurrent(epoch, scope) || !snapshot.value) return;
    if (loaded.treeHash === expectedTreeHash) snapshot.value = { ...snapshot.value, states: loaded.states, canWrite: loaded.canWrite };
    else {
      const preserved = preserveSelectedTree(snapshot.value, loaded);
      if (preserved) { snapshot.value = preserved; return; }
      snapshot.value = loaded;
      if (selectedId.value && !loaded.tree.nodes.some(item => item.id === selectedId.value)) {
        // 状态补齐不应改变用户当前阅读的资产；下一次完整加载再确认节点是否已被移除。
        if (selectedNodeIntent.value !== selectedId.value) { selectedId.value = null; detail.value = null; previewDocument.value = null; }
      }
    }
    if (!selectedId.value && selectedNodeIntent.value && loaded.tree.nodes.some(item => item.id === selectedNodeIntent.value && !item.archived)) {
      selectedId.value = selectedNodeIntent.value;
      void readNode(selectedNodeIntent.value);
    }
  } catch (error) {
    if (isCurrent(epoch, scope) && !isAborted(error)) snapshotStatesError.value = reportError(error, "KNOWLEDGE_ASSET_STATES_REFRESH_FAILED");
  }
}
/** 后台更新任务与待确认索引，完成后补齐正式状态，不抢占阅读选区。 */
async function refreshRuns(): Promise<void> {
  if (pollInFlight || !workspaceId.value) return;
  pollInFlight = true;
  const requestVersion = ++runRequestVersion;
  const scope = workspaceId.value, epoch = scopeEpoch;
  try {
    const runs = unwrap(await requestKnowledgeAsset(ctx(), "runs", { workspaceId: scope }));
    if (!isCurrent(epoch, scope)) return;
    syncKnowledgeExecutionThreadSummaries(runs);
    const previous = activeRun.value;
    const completedBackground = runs.some(run => !run.active && taskList.value.some(previousRun => previousRun.id === run.id && previousRun.active));
    const next = chooseRun(runs);
    receiveRun(next);
    receiveReviews(runs);
    await refreshPendingChanges(scope, epoch);
    resultsLoadError.value = null;
    const runChanged = next && (previous?.id !== next.id || previous.phase !== next.phase || JSON.stringify(previous.items.map(item => [item.status, item.review])) !== JSON.stringify(next.items.map(item => [item.status, item.review])));
    // 运行中只更新任务投影；每 5 秒再读整棵资产树会把 Client 的同步文件扫描叠加到引擎 RPC。
    // 任务结束后再读取一次权威状态，保证树上的文档计数最终一致。
    if (completedBackground || runChanged && next && !next.active) await refreshSnapshot();
  } catch (error) {
    if (isCurrent(epoch, scope) && !isAborted(error)) {
      resultsLoadError.value = errorMessage(error);
      errorText.value = reportError(error, "KNOWLEDGE_RUN_REFRESH_FAILED");
    }
  } finally {
    if (requestVersion === runRequestVersion) pollInFlight = false;
    if (isCurrent(epoch, scope) && requestVersion === runRequestVersion && snapshot.value && !activeRun.value?.active && !snapshotStatesReady.value) scheduleSnapshotStates(scope, epoch, snapshot.value.treeHash);
  }
}
/** 任务索引不阻塞资产树首屏，后台补齐进度、候选和执行会话。 */
async function restoreRunsInBackground(scope: WorkspaceId, epoch: number): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  const requestVersion = ++runRequestVersion;
  resultsLoading.value = true;
  try {
    const runList = unwrap(await requestKnowledgeAsset(ctx(), "runs", { workspaceId: scope }));
    if (!isCurrent(epoch, scope)) return;
    syncKnowledgeExecutionThreadSummaries(runList);
    const initialRun = chooseRun(runList);
    // 恢复历史任务只补齐后台状态，不能把用户已经恢复的资产视图切换成“生成结果”。
    receiveRun(initialRun);
    receiveReviews(runList);
    await refreshMaintenanceRecovery(runList, scope, epoch);
    resultsLoadError.value = null;
    if (requestedExecutionThreadId.value) {
      const info = executionSessionInfo(runList, requestedExecutionThreadId.value);
      void openExecutionSession(requestedExecutionThreadId.value, info?.title ?? "规格执行", info?.kind ?? "知识工作会话");
    }
    if (runList.some(run => run.active)) poll();
  } catch (error) {
    if (isCurrent(epoch, scope) && !isAborted(error)) {
      // 保留当前页面已经收到的结果，避免一次暂时性的 Client/Server 错误把结果树误显示成空目录。
      resultsLoadError.value = errorMessage(error);
      errorText.value = reportError(error, "KNOWLEDGE_RUN_INITIAL_LOAD_FAILED");
    }
  } finally {
    if (requestVersion === runRequestVersion) pollInFlight = false;
    if (isCurrent(epoch, scope) && requestVersion === runRequestVersion) resultsLoading.value = false;
    if (isCurrent(epoch, scope) && requestVersion === runRequestVersion && snapshot.value && !activeRun.value?.active) scheduleSnapshotStates(scope, epoch, snapshot.value.treeHash);
  }
}
/** 内容采用回执与项目计划共同决定维护恢复入口，页面刷新后仍可仅重试计划。 */
async function refreshMaintenanceRecovery(runs: KnowledgeGenerationRunView[], scope: WorkspaceId, epoch: number): Promise<void> {
  const adopted = runs.find(run => run.adoptions?.some(receipt => receipt.completed));
  if (!adopted) { maintenanceRunId.value = null; return; }
  const result = unwrap(await requestKnowledgeAsset(ctx(), "update.schedule", { workspaceId: scope }));
  if (isCurrent(epoch, scope)) maintenanceRunId.value = result.schedule ? null : adopted.id;
}
/** 只加载建议摘要索引，返回是否成功以阻止采用后的错误跳转。 */
async function refreshPendingChanges(scope: WorkspaceId, epoch: number): Promise<boolean> {
  try {
    const changes = unwrap(await requestKnowledgeAsset(ctx(), "changes", { workspaceId: scope, status: "pending", offset: 0 }));
    if (isCurrent(epoch, scope)) pendingChangeNodes.value = changes.pendingNodes;
    return isCurrent(epoch, scope);
  } catch (error) {
    // 建议索引是轮询读取的次要信息，失败只记录日志，避免每轮刷新都弹顶部横幅。
    if (isCurrent(epoch, scope) && !isAborted(error)) reportError(error, "KNOWLEDGE_PENDING_INDEX_FAILED", {}, { background: true });
    return false;
  }
}
/** 新 Server 支持树/状态分阶段读取；旧运行进程拒绝可选参数时只回退本次请求。 */
async function requestInitialSnapshot(scope: WorkspaceId, signal: AbortSignal): Promise<ReturnType<typeof requestKnowledgeAsset<"snapshot">>> {
  const fast = await requestKnowledgeAsset(ctx(), "snapshot", { workspaceId: scope, includeStates: false }, { signal });
  if (fast.ok || fast.code !== "BAD_REQUEST") return fast;
  return requestKnowledgeAsset(ctx(), "snapshot", { workspaceId: scope }, { signal });
}
/** 活动任务沿原入口刷新；空闲时仅更新轻量建议索引，不重读正文或任务历史。 */
const KNOWLEDGE_RUN_POLL_INTERVAL_MS = 5000;
/** 页面可见时更新任务摘要，轮询不重读正在预览的正文。 */
function poll(): void {
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (threadRunning.value || taskList.value.some(run => run.active)) void refreshRuns();
      else void refreshPendingChanges(workspaceId.value, scopeEpoch);
    }, KNOWLEDGE_RUN_POLL_INTERVAL_MS);
  }
}
function stopPoll(): void { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
/** 状态点是次要信息，延后读取，避免首次绘制与 runs/会话恢复争抢 Client 中继。 */
function scheduleSnapshotStates(scope: WorkspaceId, epoch: number, expectedTreeHash: string | null): void {
  if (snapshotStatesTimer) clearTimeout(snapshotStatesTimer);
  snapshotStatesTimer = setTimeout(() => {
    snapshotStatesTimer = null;
    if (isCurrent(epoch, scope)) void refreshSnapshotStates(scope, epoch, expectedTreeHash);
  }, 250);
}
/**
 * 会话列表和历史回放不参与资产页首屏门禁。
 * 知识页先展示项目资产，随后再恢复上次会话；失败只影响会话区，不影响资产浏览。
 */
async function restoreKnowledgeConversationInBackground(scope: WorkspaceId, epoch: number): Promise<void> {
  try {
    const availableConversations = unwrap(await requestKnowledgeAsset(ctx(), "conversation.list", { workspaceId: scope }));
    if (!isCurrent(epoch, scope)) return;
    conversations.value = availableConversations;
    for (const conversation of availableConversations) upsertKnowledgeThreadSummary(conversation);
    if (requestedExecutionThreadId.value) return;
    if (requestedThreadId.value) await connectRequestedConversation(requestedThreadId.value);
    else {
      const restored = restoreConversation();
      const previous = conversations.value.find(c => c.threadId === restored?.threadId && c.active)
        ?? sortedConversations.value.find(c => c.nodeId === null && c.active && c.createdByUserId === conversationActorId.value);
      if (previous) await connectConversation(previous.threadId, false);
    }
  } catch (error) {
    if (isCurrent(epoch, scope) && !isAborted(error)) {
      bindingError.value = reportError(error, "KNOWLEDGE_CONVERSATION_RESTORE_FAILED");
      assistantOpen.value = true;
    }
  } finally {
    if (isCurrent(epoch, scope)) { conversationLoading.value = false; await drainRequestedConversation(); }
  }
}
/** 按工作区重建页面状态，隔离旧目录、选择和异步读取结果。 */
async function load(): Promise<void> {
  const scope = workspaceId.value, epoch = ++scopeEpoch;
  const cachedSnapshot = readKnowledgeSnapshot(knowledgeCacheScopeKey());
  closeSearchResults(); searchQuery.value = ""; searchFocus.value = null;
  if (scope && selectedNodeIntentWorkspace && selectedNodeIntentWorkspace !== scope) selectedNodeIntent.value = null;
  hydratingPageState = true;
  const restoredPage = restorePageState();
  pendingRouteThreadId = null;
  readController?.abort(); stopPoll(); if (snapshotStatesTimer) clearTimeout(snapshotStatesTimer); snapshotStatesTimer = null; runRequestVersion += 1; pollInFlight = false; nodeEpoch += 1; revisionEpoch += 1; importEpoch += 1;
  snapshot.value = null; snapshotStatesError.value = null; detail.value = null; selectedId.value = null; activeRun.value = null;
  executionSessionEpoch++; executionSession.value = null; executionSessionLoading.value = false; executionSessionError.value = null; hydratedExecutionThreadId.value = null; updatePreview.value = null; showProjectConversation.value = false;
  previewDocument.value = null; previewRevisionId.value = null; documentReadError.value = null; nodeReports.value = []; reportsReadError.value = null; revisionLoading.value = false; reportsLoading.value = false;
  assistantThreadId.value = null; bindingReady.value = false; boundNodeId.value = null; bindingError.value = null;
  conversationLoading.value = false;
  buildStarting.value = false; pendingBuild.value = null; pendingBatch.value = null;
  editing.value = false; editContent.value = ""; errorText.value = null; errorDiagnostics.value = null;
  const explicitContentView = route.query.view === "overview" || route.query.view === "assets";
  const restoreUpdates = !explicitContentView && (route.query.view === "results" || route.query.view === "approvals" || typeof route.query.changeId === "string" || Boolean(restoredPage?.updatesTarget));
  updatesTarget.value = explicitContentView ? null : typeof route.query.changeId === "string" ? { scopeNodeId: null, changeId: route.query.changeId }
    : restoredPage?.updatesTarget ?? (restoreUpdates ? { scopeNodeId: null } : null);
  suppressAutoPreview.value = null; maintenanceRunId.value = null;
  selectedChangeId.value = explicitContentView ? null : typeof route.query.changeId === "string" ? route.query.changeId : restoredPage?.selectedChangeId ?? null;
  pendingChangeNodes.value = [];
  checkedIds.value = []; conversations.value = []; taskList.value = []; resultsLoadError.value = null; batchOpen.value = false; sessionMenuOpen.value = false;
  busy.value = false; binding.value = false; nodeLoading.value = false; loading.value = false;
  importOpen.value = false; importLoading.value = false; importItems.value = []; importDirectories.value = [];
  importCategory.value = "product"; importAppliesTo.value = "";
  importNextOffset.value = null; selectedImportPaths.value = []; importDirectory.value = ""; importDirectoryInput.value = ""; importError.value = null; importSubmitError.value = null;
  if (restoredPage && !narrowScreen.value) assistantOpen.value = restoredPage.assistantOpen;
  if (!scope) { hydratingPageState = false; return; }
  // 有缓存时先交付目录和上次正文，首屏快照与状态补齐继续在后台进行。
  if (cachedSnapshot) {
    snapshot.value = cachedSnapshot;
    restoreSelectedNode(cachedSnapshot, restoredPage, scope);
    const cachedRestoredNode = selectedId.value;
    if (cachedRestoredNode) {
      const cachedNode = readKnowledgeNode(knowledgeNodeCacheKey(cachedRestoredNode));
      if (cachedNode && cachedNode.detail.node.id === cachedRestoredNode) {
        detail.value = cachedNode.detail;
        previewDocument.value = cachedNode.previewDocument;
        previewRevisionId.value = cachedNode.previewRevisionId;
        nodeReports.value = [...cachedNode.reports];
      } else if (cachedSnapshot.tree.nodes.find(item => item.id === cachedRestoredNode)?.contentMode !== "directory") {
        // 未缓存正文时立即读取，避免把“尚未缓存”渲染成“没有内容”。
        nodeLoading.value = true;
        void readNode(cachedRestoredNode);
      }
    }
  }
  // 结果页只显示本次 Client 返回的任务事实，读取期间保持固定加载态。
  resultsLoading.value = Boolean(restoreUpdates);
  loading.value = !cachedSnapshot; readController = new AbortController();
  initialSnapshotRefreshing.value = true;
  const restoreResultsInParallel = Boolean(restoreUpdates);
  try {
    // 裸地址补齐项目；主动切项目时清理上一项目深链，后续刷新沿用明确范围。
    if (route.name === "project-knowledge" && route.query.workspaceId !== scope) {
      const query: LocationQueryRaw = { ...route.query, workspaceId: scope };
      if (route.query.workspaceId) { delete query.threadId; delete query.executionThreadId; delete query.changeId; delete query.nodeId; }
      await router.replace({ name: "project-knowledge", query });
      if (!isCurrent(epoch, scope)) return;
    }
    if (restoreResultsInParallel) void restoreRunsInBackground(scope, epoch);
    const loaded = await requestInitialSnapshot(scope, readController.signal);
    if (!isCurrent(epoch, scope)) return;
    snapshot.value = unwrap(loaded);
    void refreshPendingChanges(scope, epoch);
    scheduleSnapshotStates(scope, epoch, snapshot.value.treeHash);
    restoreSelectedNode(snapshot.value, restoredPage, scope);
    // 正文与报告在后台读取，先交付左树；目录等待状态补齐后再选择可读文档。
    if (readingNodeId.value && node.value?.contentMode !== "directory") void readNode(readingNodeId.value);
    // 结果页已与首屏快照并发恢复任务；其他视图继续后台补齐，避免影响资产树首屏。
    if (!restoreResultsInParallel) void restoreRunsInBackground(scope, epoch);
    // 会话列表和整段历史回放放到后台；页面先交付可浏览的资产树。
    if (canWrite.value) {
      conversationLoading.value = true;
      void restoreKnowledgeConversationInBackground(scope, epoch);
    }

  } catch (error) {
    // 有缓存时顶栏必须提示刷新失败；权限错误同时丢弃旧权限内容。
    if (isCurrent(epoch, scope) && !isAborted(error)) {
      const failure = reportError(error, "KNOWLEDGE_LOAD_FAILED", {}, { background: !cachedSnapshot });
      if (cachedSnapshot) {
        if (isApiResultError(error) && /(?:FORBIDDEN|PERMISSION_DENIED|NOT_FOUND)$/u.test(error.code)) {
          snapshot.value = null; selectedId.value = null; selectedNodeIntent.value = null;
          detail.value = null; previewDocument.value = null; previewRevisionId.value = null; nodeReports.value = [];
          clearKnowledgePageCache();
        }
        errorText.value = failure;
      }
    }
  }
  finally {
    if (isCurrent(epoch, scope)) {
      loading.value = false;
      initialSnapshotRefreshing.value = false;
      poll();
      hydratingPageState = false;
      persistPageState();
      // 会话清单仍在后台读取时，不能用空清单提前判定深链会话不存在。
      if (!conversationLoading.value) await drainRequestedConversation();
    }
  }
}
/** 主动连接才切换讨论面板；后台恢复只准备会话，不抢正文工作会话。 */
async function activateConversation(value: KnowledgeConversationSummary, epoch: number, scope: WorkspaceId, requestedId: string, revealDiscussion: boolean): Promise<void> {
  if (!isCurrent(epoch, scope) || requestedThreadId.value !== requestedId) return;
  await chat.ensureThreadHydrated(ctx(), { workspaceId: scope, threadId: value.threadId as ThreadId });
  if (!isCurrent(epoch, scope) || requestedThreadId.value !== requestedId) return;
  upsertKnowledgeThreadSummary(value);
  conversations.value = [value, ...conversations.value.filter(c => c.threadId !== value.threadId)]; sessionMenuOpen.value = false;
  assistantThreadId.value = value.threadId as ThreadId; boundNodeId.value = value.nodeId; initialEngine.value = value.engine;
  bindingReady.value = true; rememberConversation(value.threadId as ThreadId, value.nodeId);
  if (revealDiscussion) { showProjectConversation.value = true; assistantOpen.value = true; }
  await refreshRuns();
  if (revealDiscussion && isCurrent(epoch, scope) && requestedThreadId.value === requestedId) await syncConversationRoute(value.threadId);
  if (revealDiscussion && isCurrent(epoch, scope) && assistantThreadId.value === value.threadId && requestedThreadId.value === value.threadId) {
    showProjectConversation.value = true; assistantOpen.value = true;
  }
}
/** 复用原连接鉴权，后台调用通过 revealDiscussion 保留当前阅读面板。 */
async function connectConversation(id?: string, revealDiscussion = true): Promise<void> {
  if (binding.value || !canWrite.value || threadRunning.value || activeRun.value?.active) return;
  const target = id ?? assistantThreadId.value;
  if (!target) { await startConversation(); return; }
  const scope = workspaceId.value, epoch = scopeEpoch, requestedId = requestedThreadId.value;
  binding.value = true; bindingReady.value = false; bindingError.value = null;
  try {
    const value = unwrap(await requestKnowledgeAsset(ctx(), "conversation.connect", { workspaceId: scope, threadId: target }, { method: "POST" }));
    await activateConversation(value, epoch, scope, requestedId, revealDiscussion);
  } catch (error) {
    if (isCurrent(epoch, scope) && requestedThreadId.value === requestedId) {
      bindingError.value = reportError(error, "KNOWLEDGE_CONVERSATION_CONNECT_FAILED");
      assistantOpen.value = true;
      if (isUnavailableConversation(error)) {
        conversations.value = conversations.value.filter(c => c.threadId !== target);
        discardUnavailableConversation();
        await syncConversationRoute(null);
      }
    }
  }
  finally { if (isCurrent(epoch, scope)) { binding.value = false; await drainRequestedConversation(); } }
}
/** 从紧凑会话菜单切换独立知识会话，并在切换后关闭菜单。 */
async function selectConversation(id: string): Promise<void> {
  sessionMenuOpen.value = false;
  await connectConversation(id);
}
/** 新会话优先项目偏好，再沿用本人最近同引擎知识会话，最后参考本项目研发会话。 */
function knowledgeConversationCreatePrefs(engine: EngineType): { model: string | null; effort: string | null } {
  if (buildPrefs.value?.engine === engine) return { model: buildPrefs.value.model, effort: buildPrefs.value.effort };
  const recent = sortedConversations.value.find(item => item.engine === engine && item.createdByUserId === conversationActorId.value);
  for (const candidate of [knowledgeConversation.value, recent]) {
    if (candidate?.engine !== engine) continue;
    const prefs = chat.threadPrefsByThreadId[candidate.threadId];
    return { model: prefs?.model !== undefined ? prefs.model : candidate.model, effort: prefs?.effort !== undefined ? prefs.effort : candidate.effort };
  }
  const selectedId = chat.workspaceActivation.workspaceId === workspaceId.value ? chat.selectedThreadId : null;
  if (selectedId && chat.threadSummaryById(selectedId)?.engine === engine) {
    const prefs = chat.threadPrefsByThreadId[selectedId];
    if (prefs) return { model: prefs.model ?? null, effort: prefs.effort ?? null };
  }
  return { model: null, effort: null };
}
/** 新会话统一归属项目；创建失败恢复原会话就绪状态，允许继续修复模型配置。 */
async function createConversation(nodeId: string | null): Promise<void> {
  if (binding.value || !canWrite.value || threadRunning.value || activeRun.value?.active) return;
  const scope = workspaceId.value, epoch = scopeEpoch, requestedId = requestedThreadId.value;
  const previousThreadId = assistantThreadId.value, previousReady = bindingReady.value;
  binding.value = true; bindingReady.value = false; bindingError.value = null;
  try {
    if (buildPrefsError.value) throw new Error(buildPrefsError.value);
    const engine = buildPrefs.value?.engine ?? initialEngine.value;
    const prefs = knowledgeConversationCreatePrefs(engine);
    await engines.refresh(ctx(), scope, { shouldApply: () => isCurrent(epoch, scope) });
    if (!isCurrent(epoch, scope)) return;
    const issue = engines.byWorkspaceId[scope]?.lastError || buildEngineIssue(engine, prefs.model);
    if (issue) { await openBuildSettings(); throw new Error(`${issue}，请保存构建设置后重试`); }
    const value = unwrap(await requestKnowledgeAsset(ctx(), "conversation.create", {
      workspaceId: scope,
      nodeId,
      engine,
      model: prefs.model,
      effort: prefs.effort,
    }, { method: "POST" }));
    await activateConversation(value, epoch, scope, requestedId, true);
  } catch (error) {
    if (isCurrent(epoch, scope) && requestedThreadId.value === requestedId) {
      if (assistantThreadId.value === previousThreadId) bindingReady.value = previousReady;
      bindingError.value = reportError(error, "KNOWLEDGE_CONVERSATION_CREATE_FAILED");
    }
  }
  finally { if (isCurrent(epoch, scope)) { binding.value = false; await drainRequestedConversation(); } }
}
/** 为本次后台任务创建项目会话，不改变当前讨论或自动打开聊天面板。 */
async function createTaskConversation(engine: EngineType, model: string | null, effort: string | null, scope: WorkspaceId): Promise<KnowledgeConversationSummary> {
  return unwrap(await requestKnowledgeAsset(ctx(), "conversation.create", { workspaceId: scope, nodeId: null, engine, model, effort }, { method: "POST" }));
}
/** 续跑历史任务先连接原归属会话，交由现有权限边界校验。 */
async function ensureRunConversation(run: KnowledgeGenerationRunView): Promise<boolean> {
  const ownerId = run.ownerThreadId ?? run.threadId;
  if (!ownerId) throw new Error("此任务缺少所属规格会话，无法继续生成或复检");
  if (ownerId === assistantThreadId.value && bindingReady.value) return true;
  if (binding.value || threadRunning.value || activeRun.value?.active) throw new Error("请先停止当前会话的任务，再继续这份历史任务");
  const scope = workspaceId.value, epoch = scopeEpoch;
  await connectConversation(ownerId, false);
  if (!isCurrent(epoch, scope)) return false;
  if (!bindingReady.value || assistantThreadId.value !== ownerId) throw new Error(bindingError.value || "原规格会话未连接，请稍后重试");
  return true;
}
/** 构建前只检查已有引擎状态，缺少必要配置时先展示设置，不创建会话或任务。 */
function buildEngineIssue(engine: EngineType, model: string | null): string | null {
  const status = engines.byTypeForWorkspace(workspaceId.value).get(engine);
  if (!status?.installed) return `${engine === "claude" ? "Claude" : "Codex"} 尚未就绪，请选择已配置的引擎`;
  if (status.credentialStatus?.available === false && !status.providerCredentialStatus?.some(provider => provider.available)) return status.credentialStatus.message || "当前引擎缺少可用凭据，请先配置大模型 Key 或本机登录";
  if (status.providerCredentialStatus?.length && !status.providerCredentialStatus.some(provider => provider.available)) return "当前引擎没有可用模型凭据，请先配置大模型 Key 或本机登录";
  if (!model) return "请确认本次使用的具体模型";
  const modelInfo = status.models.find(item => item.id === model);
  if (!modelInfo) return "所选模型不在当前引擎目录中，请重新选择";
  const provider = status.providerCredentialStatus?.find(item => item.providerId === resolveEngineModelProvider(modelInfo).providerId);
  if (provider?.available === false) return provider.message || "所选模型缺少可用凭据，请先配置大模型 Key 或本机登录";
  return null;
}
/** 复用现有模型控件，供首次配置和配置故障时修复。 */
async function openBuildSettings(resumeIds: string[] | null = null): Promise<void> {
  if (!canWrite.value || busy.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch;
  buildSettingsMode.value = true; pendingBuildIds.value = resumeIds ? [...resumeIds] : null;
  batchMode.value = "batch"; batchError.value = null; batchOpen.value = true;
  const preferred = knowledgeModelPrefs.value;
  batchEngine.value = preferred.engine; batchModelId.value = preferred.model ?? ""; batchEffort.value = preferred.effort ?? "";
  if (!await refreshBatchModels()) return;
  if (!isCurrent(epoch, scope) || !batchOpen.value || !buildSettingsMode.value) return;
  if (batchCatalog.value?.lastError) { batchError.value = batchCatalog.value.lastError; return; }
  batchError.value = buildPrefsError.value || buildEngineIssue(batchEngine.value, batchModelId.value || null);
}
/** 保存主动选择的配置；存储失败阻止后续构建并保留明确错误。 */
function rememberKnowledgeModelPrefs(prefs: KnowledgeBuildPrefs): void {
  try { writeKnowledgeBuildPrefs(workspaceId.value, prefs); }
  catch (error) {
    buildPrefsError.value = `${assistantThreadId.value ? "会话配置已更新，但默认模型配置" : "模型配置"}保存失败：${error instanceof Error ? error.message : String(error)}。请重新保存模型设置后重试`;
    throw new Error(buildPrefsError.value, { cause: error });
  }
  buildPrefs.value = prefs; buildPrefsError.value = null; initialEngine.value = prefs.engine;
}
/** 输入工具栏沿用现有偏好保存机制，只同步用户主动修改到项目默认值。 */
function rememberConversationPrefs(prefs: { model: string | null; effort: string | null }): void {
  const current = knowledgeConversation.value;
  if (!current || !bindingReady.value || binding.value) return;
  try { rememberKnowledgeModelPrefs({ engine: current.engine, ...prefs }); }
  catch (error) { bindingError.value = reportError(error, "KNOWLEDGE_MODEL_PREFS_SAVE_FAILED", { engine: current.engine, model: prefs.model }); }
}
/** 跨引擎复制草稿到新会话，同引擎更新偏好；校验、草稿或创建失败时保留原会话。 */
async function applyKnowledgeModelPrefs(engine: EngineType, selected?: { model: string | null; effort: string | null }): Promise<boolean> {
  if (modelSettingsBlocked.value) return false;
  const scope = workspaceId.value, epoch = scopeEpoch, requestedId = requestedThreadId.value;
  const oldId = assistantThreadId.value, draftScope = chat.captureThreadDraftWorkspaceScopeToken();
  const draftTask = oldId ? assistantPanel.value?.prepareThreadSwitch() : null;
  if (oldId && !draftTask) throw new Error("会话输入尚未就绪，请稍后重试");
  binding.value = true; bindingError.value = null;
  try {
    const draft = await draftTask;
    if (!isCurrent(epoch, scope) || requestedThreadId.value !== requestedId) return false;
    await engines.refresh(ctx(), scope, { shouldApply: () => isCurrent(epoch, scope) });
    if (!isCurrent(epoch, scope) || requestedThreadId.value !== requestedId) return false;
    const available = engines.byTypeForWorkspace(scope).get(engine)?.models ?? [];
    const prefs = resolveThreadPrefsWithCatalogDefaults(engine, selected ?? knowledgeConversationCreatePrefs(engine), available);
    const issue = engines.byWorkspaceId[scope]?.lastError || buildEngineIssue(engine, prefs.model);
    if (issue) throw new Error(issue);
    if (oldId && knowledgeConversation.value?.engine !== engine) {
      const value = await createTaskConversation(engine, prefs.model, prefs.effort, scope);
      if (!isCurrent(epoch, scope) || requestedThreadId.value !== requestedId) return false;
      if (draft && chat.setPendingLocalThreadDraft(value.threadId as ThreadId, draft, { workspaceScopeToken: draftScope }) === null) throw new Error("工作区已变化，未切换规格会话");
      await activateConversation(value, epoch, scope, requestedId, true);
      if (!isCurrent(epoch, scope) || assistantThreadId.value !== value.threadId) return false;
    } else if (oldId) {
      const patch = { model: prefs.model, effort: prefs.effort };
      const result = await updateThreadPrefs(ctx(), { workspaceId: scope, threadId: oldId, prefs: patch });
      if (!result.ok) throw createApiResultError(result);
      if (!isCurrent(epoch, scope) || requestedThreadId.value !== requestedId) return false;
      chat.setThreadPrefs(oldId, { ...chat.threadPrefsByThreadId[oldId], ...patch }, { updateBase: true });
    }
    rememberKnowledgeModelPrefs({ engine, model: prefs.model, effort: prefs.effort });
    return true;
  } finally { if (isCurrent(epoch, scope)) { binding.value = false; await drainRequestedConversation(); } }
}
/** 工具栏切换引擎时优先沿用该引擎已保存模型，不修改旧会话历史。 */
async function changeKnowledgeEngine(engine: EngineType): Promise<void> {
  if (engine === knowledgeConversation.value?.engine) return;
  const scope = workspaceId.value, epoch = scopeEpoch;
  try { await applyKnowledgeModelPrefs(engine); }
  catch (error) { if (isCurrent(epoch, scope)) bindingError.value = reportError(error, "KNOWLEDGE_ENGINE_SWITCH_FAILED", { engine }); }
}
/** 保存后同步当前会话；仅在用户已点击构建时继续原来的冻结选区。 */
async function saveBuildSettings(): Promise<void> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  try { if (!await applyKnowledgeModelPrefs(batchEngine.value, batchModel.value)) return; }
  catch (error) { if (isCurrent(epoch, scope)) batchError.value = reportError(error, "KNOWLEDGE_BUILD_PREFS_SAVE_FAILED"); return; }
  if (!isCurrent(epoch, scope)) return;
  const ids = pendingBuildIds.value;
  pendingBuildIds.value = null; batchOpen.value = false; buildSettingsMode.value = false;
  if (ids) await startBuild(ids);
}
/** 一次点击串联价值筛选、候选目录、正文生成和复检，正式内容最后采用。 */
async function startBuild(ids: string[] = []): Promise<void> {
  if (!canWrite.value || !snapshot.value || buildStarting.value || busy.value || updatesBusy.value || binding.value || assistantThreadId.value && !bindingReady.value || taskList.value.some(run => run.active && run.mode === "build")) return;
  const scope = workspaceId.value, epoch = scopeEpoch;
  const treeHash = snapshot.value.treeHash, selectedNodeIds = [...ids];
  const execution = { ...knowledgeModelPrefs.value };
  buildStarting.value = true;
  dismissError();
  try {
    if (pendingBuild.value) {
      const started = await startPreparedGeneration(pendingBuild.value, epoch, scope);
      if (!started) return;
      pendingBuild.value = null; receiveRun(started); poll();
      message.success("已恢复原构建任务");
      return;
    }
    if (buildPrefsError.value) { await openBuildSettings(selectedNodeIds); return; }
    await engines.refresh(ctx(), scope, { shouldApply: () => isCurrent(epoch, scope) });
    if (!isCurrent(epoch, scope)) return;
    if (engines.byWorkspaceId[scope]?.lastError) throw new Error(engines.byWorkspaceId[scope].lastError!);
    const { engine, ...prefs } = execution;
    if (buildEngineIssue(engine, prefs.model)) {
      await openBuildSettings(selectedNodeIds);
      if (isCurrent(epoch, scope) && !batchError.value) batchError.value = "请确认本次构建使用的引擎和模型，保存后开始生成";
      return;
    }
    const owner = await createTaskConversation(engine, prefs.model, prefs.effort, scope);
    if (!isCurrent(epoch, scope)) return;
    conversations.value = [owner, ...conversations.value.filter(item => item.threadId !== owner.threadId)];
    upsertKnowledgeThreadSummary(owner);
    pendingBuild.value = { runId: null, input: { workspaceId: scope, requestId: crypto.randomUUID(), mode: "build", ownerThreadId: owner.threadId,
      selectedNodeIds, includeDescendants: true, strategy: "all", prompt: "", treeHash, engine, ...prefs,
      reviewConfig: { enabled: true, autoRepair: true, maxRounds: 2, model: prefs.model, effort: prefs.effort } } };
    const started = await startPreparedGeneration(pendingBuild.value, epoch, scope);
    if (!started) return;
    pendingBuild.value = null;
    receiveRun(started); poll();
    message.success("已开始构建，完成后统一预览并采用");
  } catch (error) { if (isCurrent(epoch, scope)) errorText.value = reportError(error, "KNOWLEDGE_BUILD_START_FAILED"); }
  finally { if (isCurrent(epoch, scope)) buildStarting.value = false; }
}
/** 保存原请求及已创建任务，传输或启动失败后只恢复同一任务，不重复创建。 */
async function startPreparedGeneration(pending: PendingGeneration, epoch: number, scope: WorkspaceId): Promise<KnowledgeGenerationRunView | null> {
  const context = ctx();
  if (!pending.runId) {
    const planned = unwrap(await requestKnowledgeAsset(context, "generate", pending.input, { method: "POST" }));
    if (!isCurrent(epoch, scope)) return null;
    pending.runId = planned.id; receiveRun(planned);
  }
  const started = unwrap(await requestKnowledgeAsset(context, "run.start", { workspaceId: scope, runId: pending.runId }, { method: "POST" }));
  return isCurrent(epoch, scope) ? started : null;
}
/** 明确放弃旧请求恢复后刷新项目事实；保留已有任务与产物，再允许重新配置。 */
async function resetPendingGeneration(kind: "build" | "batch"): Promise<void> {
  if (busy.value || buildStarting.value) return;
  const epoch = scopeEpoch, scope = workspaceId.value;
  busy.value = true;
  dismissError();
  try {
    await refreshSnapshot();
    if (!isCurrent(epoch, scope)) return;
    await refreshRuns();
    if (!isCurrent(epoch, scope)) return;
    if (resultsLoadError.value || errorText.value) return;
    if (kind === "build") pendingBuild.value = null;
    else pendingBatch.value = null;
    dismissError(); batchError.value = null;
  } catch (error) { if (isCurrent(epoch, scope)) errorText.value = reportError(error, "KNOWLEDGE_GENERATION_RECOVERY_RESET_FAILED"); }
  finally { if (isCurrent(epoch, scope)) busy.value = false; }
}
/** 先停止所属任务再结束协作，保留知识结果和其他会话历史。 */
async function disconnectConversation(): Promise<void> {
  if (!assistantThreadId.value || binding.value) return;
  const id = assistantThreadId.value, scope = workspaceId.value, epoch = scopeEpoch;
  binding.value = true;
  try {
    if (!await stopTask()) return;
    if (!isCurrent(epoch, scope) || assistantThreadId.value !== id) return;
    const value = unwrap(await requestKnowledgeAsset(ctx(), "conversation.end", { workspaceId: scope, threadId: id }, { method: "POST" }));
    if (!isCurrent(epoch, scope)) return;
    conversations.value = conversations.value.map(c => c.threadId === id ? value : c);
    assistantThreadId.value = null; boundNodeId.value = null; bindingReady.value = false; bindingError.value = null; sessionMenuOpen.value = false;
    activeRun.value = null; rememberConversation(null);
    await syncConversationRoute(null);
    message.success("已结束规格协作，可以选择历史会话继续");
  } catch (error) { if (isCurrent(epoch, scope)) bindingError.value = reportError(error, "KNOWLEDGE_CONVERSATION_END_FAILED"); }
  finally { if (isCurrent(epoch, scope)) binding.value = false; }
}
/** 高级任务复用选区和模型控件，确认前不建立或切换知识会话。 */
async function openBatch(ids = checkedIds.value.length ? checkedIds.value : selectedId.value ? [selectedId.value] : snapshot.value?.tree.nodes.filter(n => n.parentId === null && !n.archived).map(n => n.id) ?? [], includeDescendants = true, mode: "batch" | "review" = "batch"): Promise<void> {
  if (updatesBusy.value || executionThreadRunning.value) return;
  batchRevisionRunId.value = null;
  if (pendingBatch.value) {
    const input = pendingBatch.value.input, review = input.reviewConfig as typeof batchReviewConfig.value;
    batchMode.value = input.mode as "batch" | "review";
    batchEngine.value = input.engine as EngineType; batchModelId.value = input.model as string ?? ""; batchEffort.value = input.effort as string ?? "";
    batchSelectedIds.value = [...input.selectedNodeIds as string[]]; batchIncludeDescendants.value = input.includeDescendants as boolean;
    batchStrategy.value = input.strategy as "all" | "missing"; batchPrompt.value = input.prompt as string; batchConcurrency.value = input.concurrency as number;
    batchReviewEnabled.value = review.enabled; batchReviewModelId.value = review.model ?? ""; batchReviewEffort.value = review.effort ?? "";
    batchReviewAutoRepair.value = review.autoRepair ?? true; batchReviewMaxRounds.value = review.maxRounds ?? 2;
    batchRepairReports.value = (input.repairReports as typeof batchRepairReports.value | undefined)?.map(report => ({ ...report })) ?? [];
    buildSettingsMode.value = false; batchOpen.value = true;
    return;
  }
  const scope = workspaceId.value, epoch = scopeEpoch;
  if (!snapshotStatesReady.value) {
    message.info("正在读取知识状态，请稍候再批量处理");
    return;
  }
  if (!isCurrent(epoch, scope) || !ids.length) return;
  buildSettingsMode.value = false;
  const prefs = assistantThreadId.value ? chat.threadPrefsByThreadId[String(assistantThreadId.value)] : null;
  batchEngine.value = knowledgeConversation.value?.engine ?? initialEngine.value;
  batchModelId.value = (prefs?.model !== undefined ? prefs.model : knowledgeConversation.value?.model) ?? "";
  batchEffort.value = (prefs?.effort !== undefined ? prefs.effort : knowledgeConversation.value?.effort) ?? "";
  batchConcurrency.value = Math.max(1, Math.min(activeRun.value?.concurrency ?? activeRun.value?.scheduler?.limit ?? 5, MAX_BATCH_CONCURRENCY));
  batchMode.value = mode; batchReviewEnabled.value = true; batchReviewAutoRepair.value = mode === "batch"; batchReviewModelId.value = batchModelId.value; batchReviewEffort.value = batchEffort.value; batchReviewMaxRounds.value = 2; batchRepairReports.value = [];
  batchSelectedIds.value = [...ids]; batchIncludeDescendants.value = includeDescendants; batchStrategy.value = "all"; batchPrompt.value = ""; batchError.value = null; batchOpen.value = true;
  if (!batchEngineStatus.value && !batchCatalog.value?.loading) void refreshBatchModels();
}
/** 调整原任务尚未完成项的配置，保存时仍使用原任务和冻结选区。 */
async function reviseBatch(run: KnowledgeGenerationRunView): Promise<void> {
  if (!summaryAdjustable.value || busy.value || updatesBusy.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch;
  try {
    if (!await ensureRunConversation(run) || !isCurrent(epoch, scope)) return;
    const unfinished = adjustableRunItems(run);
    const first = unfinished[0], execution = first?.executionConfig ?? run, review = first?.reviewConfig ?? run.reviewConfig;
    batchEngine.value = run.engine; batchModelId.value = execution.model ?? ""; batchEffort.value = execution.effort ?? "";
    batchConcurrency.value = Math.max(1, Math.min(run.concurrency ?? run.scheduler?.limit ?? 5, MAX_BATCH_CONCURRENCY));
    batchMode.value = run.mode === "review" || unfinished.every(item => item.status === "completed") ? "review" : "batch";
    batchReviewEnabled.value = review?.enabled ?? true; batchReviewAutoRepair.value = review?.autoRepair ?? run.mode === "batch";
    batchReviewModelId.value = review?.model ?? ""; batchReviewEffort.value = review?.effort ?? "";
    batchReviewMaxRounds.value = review?.maxRounds ?? first?.review?.maxRounds ?? KNOWLEDGE_MAX_REVIEW_ROUNDS;
    batchRepairReports.value = []; batchSelectedIds.value = unfinished.map(item => item.nodeId);
    batchIncludeDescendants.value = false; batchStrategy.value = "all"; batchPrompt.value = "";
    batchRevisionRunId.value = run.id; buildSettingsMode.value = false; batchError.value = null; batchOpen.value = true;
    if (!batchEngineStatus.value && !batchCatalog.value?.loading) void refreshBatchModels();
  } catch (error) { if (isCurrent(epoch, scope)) errorText.value = reportError(error, "KNOWLEDGE_BATCH_REVISE_FAILED", { runId: run.id }); }
}
/** 切换批任务引擎时清空不兼容的模型/思考强度，配置只作用于本批次。 */
function changeBatchEngine(value: string): void {
  if (value !== "codex" && value !== "claude") return;
  batchEngine.value = value as EngineType;
  batchModelId.value = "";
  batchEffort.value = "";
  batchReviewModelId.value = "";
  batchReviewEffort.value = "";
  if (!batchEngineStatus.value && !batchCatalog.value?.loading) void refreshBatchModels();
}
/** 将原生 select 事件收窄为引擎值，避免模板把事件对象传入任务配置。 */
function changeBatchEngineEvent(event: Event): void {
  changeBatchEngine((event.target as HTMLSelectElement | null)?.value ?? "");
}
/** 复用现有确认面板，复检范围与所选知识一致。 */
async function openReview(ids?: string[], includeDescendants = true): Promise<void> { await openBatch(ids, includeDescendants, "review"); }
/** 修订绑定报告版本，活动任务或恢复中的原请求不能被新修订覆盖。 */
async function repairReport(report: KnowledgeReviewReportView): Promise<void> {
  if (report.stale || !report.issues.length || !canWrite.value || busy.value || updatesBusy.value || threadRunning.value || executionThreadRunning.value || activeRun.value?.active || pendingBatch.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch;
  await openBatch([report.nodeId], false);
  if (!isCurrent(epoch, scope) || !batchOpen.value) return;
  batchStrategy.value = "all"; batchRepairReports.value = [{ nodeId: report.nodeId, reportId: report.id }];
}
/** 一键修复：把单条问题的修复建议发到对应知识工作会话并直接开始执行。 */
async function repairIssue(report: KnowledgeReviewReportView, issue: KnowledgeReviewIssue): Promise<void> {
  if (report.stale || !canWrite.value || busy.value || updatesBusy.value || executionThreadRunning.value) return;
  const item = [activeRun.value, ...taskList.value]
    .filter((run): run is KnowledgeGenerationRunView => Boolean(run))
    .flatMap(run => run.items)
    .find(candidate => candidate.nodeId === report.nodeId && candidate.revisionId === report.revisionId && candidate.executionThreadId);
  if (!item?.executionThreadId) {
    message.info("找不到这份知识对应的工作会话，请通过规格协作继续讨论");
    return;
  }
  const prompt = [
    "复检报告发现以下问题，请读取当前知识和项目证据，在本知识工作会话中修订并提交新的待采用版本。",
    "",
    `问题：${issue.title}`,
    `说明：${issue.detail}`,
    `修复建议：${issue.suggestion}`,
  ].join("\n");
  const targetThreadId = await openExecutionSession(item.executionThreadId, item.title, "知识工作会话");
  if (targetThreadId) composer.enqueueExternalAction({ workspaceId: workspaceId.value, threadId: targetThreadId, kind: "send-text", text: prompt });
}
/** 根据报告的确切正文版本打开原工作会话，只预填修订要求，由用户发送。 */
async function returnToGeneration(report: KnowledgeReviewReportView, runId?: string): Promise<void> {
  if (!canWrite.value || busy.value || updatesBusy.value || executionThreadRunning.value) return;
  const item = [activeRun.value, ...taskList.value]
    .filter((run): run is KnowledgeGenerationRunView => Boolean(run))
    .filter(run => !runId || run.id === runId)
    .flatMap(run => run.items)
    .find(candidate => candidate.nodeId === report.nodeId && candidate.revisionId === report.revisionId && candidate.executionThreadId);
  if (!item?.executionThreadId) {
    message.info("找不到这份知识对应的工作会话，请通过规格协作继续讨论");
    return;
  }
  const issueText = report.issues.map((issue, index) => `${index + 1}. ${issue.title}：${issue.detail}\n修改建议：${issue.suggestion}`).join("\n\n");
  await openExecutionSession(item.executionThreadId, item.title, "知识工作会话", `复检报告发现以下问题，请读取当前知识和项目证据，在本知识工作会话中修订并提交新的待采用版本：\n\n${issueText}`);
}
/** 只恢复预览中这份候选的原任务复检，不把同批其他文件一并续跑。 */
async function resumeCandidateReview(context: KnowledgeDocumentContext): Promise<void> {
  const run = taskList.value.find(run => run.id === context.runId);
  const item = run?.items.find(item => item.nodeId === context.nodeId && item.revisionId === context.revisionId);
  if (!run || !item || !knowledgeItemNeedsReview(item)) { message.info("此候选的复检状态已变化，请重新打开待确认更新"); return; }
  await resumeGeneration(run, false, [item.nodeId]);
}
/** 模型读取失败沿批任务错误区域显式失败，调用方据返回值停止后续配置。 */
async function refreshBatchModels(): Promise<boolean> {
  const scope = workspaceId.value, epoch = scopeEpoch;
  batchError.value = null;
  try {
    await engines.refresh(ctx(), scope, { shouldApply: () => isCurrent(epoch, scope) });
    return isCurrent(epoch, scope);
  } catch (error) {
    if (isCurrent(epoch, scope)) batchError.value = reportError(error, "KNOWLEDGE_MODEL_CATALOG_FAILED");
    return false;
  }
}
function normalizeBatchConcurrency(): number | null {
  const value = Number(batchConcurrency.value);
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_CONCURRENCY) {
    batchError.value = `批次并发数请输入 1 到 ${MAX_BATCH_CONCURRENCY} 的整数`;
    return null;
  }
  batchConcurrency.value = value;
  return value;
}
/** 批量生成和复检后台创建项目会话，启动失败沿原请求重试。 */
async function submitBatch(): Promise<void> {
  if (!batchTargets.value.length || busy.value || !canWrite.value || threadRunning.value) return;
  // 复检只避开正被处理的知识；其他模式仍不允许与活动任务并行。
  const reviewTargetBusy = batchMode.value === "review" && batchTargets.value.some(node => activelyProcessedNodeIds.value.has(node.id));
  if (reviewTargetBusy || (batchMode.value !== "review" && activeRun.value?.active)) {
    message.warning("所选知识正在被当前任务处理，请等这一步完成后再操作");
    return;
  }
  const scope = workspaceId.value, epoch = scopeEpoch; busy.value = true; batchError.value = null;
  try {
    const concurrency = normalizeBatchConcurrency();
    if (concurrency === null) return;
    let run: KnowledgeGenerationRunView;
    if (pendingBatch.value) {
      const started = await startPreparedGeneration(pendingBatch.value, epoch, scope);
      if (!started) return;
      run = started; pendingBatch.value = null;
    } else if (batchRevisionRunId.value) {
      run = unwrap(await requestKnowledgeAsset(ctx(), "run.start", { workspaceId: scope, runId: batchRevisionRunId.value,
        nodeIds: batchTargets.value.map(node => node.id), concurrency,
        ...(batchHasGeneration.value ? { prompt: batchPrompt.value, model: batchModel.value.model, effort: batchModel.value.effort } : {}),
        reviewConfig: batchReviewConfig.value }, { method: "POST" }));
    } else {
      const frozen = { workspaceId: scope, requestId: crypto.randomUUID(), mode: batchMode.value, selectedNodeIds: [...batchSelectedIds.value], includeDescendants: batchIncludeDescendants.value, strategy: batchMode.value === "review" ? "all" : batchStrategy.value, prompt: batchPrompt.value, treeHash: snapshot.value?.treeHash ?? null, concurrency, ...batchModel.value, reviewConfig: { ...batchReviewConfig.value }, ...(batchRepairReports.value.length ? { repairReports: batchRepairReports.value.map(report => ({ ...report })) } : {}) };
      const owner = await createTaskConversation(batchEngine.value, frozen.model, frozen.effort, scope);
      if (!isCurrent(epoch, scope)) return;
      pendingBatch.value = { runId: null, input: { ...frozen, ownerThreadId: owner.threadId } };
      const started = await startPreparedGeneration(pendingBatch.value, epoch, scope);
      if (!started) return;
      run = started; pendingBatch.value = null;
    }
    if (!isCurrent(epoch, scope)) return;
    receiveRun(run); batchOpen.value = false; batchRevisionRunId.value = null; poll(); await refreshRuns();
    if (isCurrent(epoch, scope)) message.success("任务已开始，完成后可在主页面查看结果");
  } catch (error) { if (isCurrent(epoch, scope)) batchError.value = reportError(error, "KNOWLEDGE_BATCH_START_FAILED"); }
  finally { if (isCurrent(epoch, scope)) busy.value = false; }
}
/** 继续或重试使用原任务 ID；指定节点时仅恢复该范围，失败保留结果与重试入口。 */
async function resumeGeneration(run: KnowledgeGenerationRunView, retryFailed = false, nodeIds?: string[]): Promise<void> {
  if (!canWrite.value || busy.value || updatesBusy.value || run.active || threadRunning.value || executionThreadRunning.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch, flight = ++knowledgeActionFlight;
  busy.value = true;
  try {
    if (!await ensureRunConversation(run) || !isCurrent(epoch, scope)) return;
    const started = unwrap(await requestKnowledgeAsset(ctx(), "run.start", { workspaceId: scope, runId: run.id, ...(retryFailed ? { retryFailed: true } : {}), ...(nodeIds ? { nodeIds } : {}) }, { method: "POST" }));
    if (isCurrent(epoch, scope)) { receiveRun(started); poll(); }
  } catch (error) { if (isCurrent(epoch, scope)) errorText.value = reportError(error, retryFailed ? "KNOWLEDGE_BATCH_RETRY_FAILED" : "KNOWLEDGE_RUN_RESUME_FAILED", { runId: run.id }); }
  finally { if (flight === knowledgeActionFlight && isCurrent(epoch, scope)) busy.value = false; }
}
/** 主页面停止指定任务；失败返回明确结果，阻止结束协作继续执行。 */
async function stopGeneration(targetRun: KnowledgeGenerationRunView | null = activeRun.value): Promise<boolean> {
  if (!canWrite.value || !targetRun || busy.value) return false;
  const scope = workspaceId.value, epoch = scopeEpoch;
  const flight = ++knowledgeActionFlight;
  busy.value = true;
  try {
    const run = unwrap(await requestKnowledgeAsset(ctx(), "run.stop", { workspaceId: scope, runId: targetRun.id }, { method: "POST" }));
    if (!isCurrent(epoch, scope)) return false;
    receiveRun(run);
    await refreshSnapshot();
    if (!isCurrent(epoch, scope)) return false;
    if (run.active) poll();
    return true;
  } catch (error) {
    if (isCurrent(epoch, scope)) errorText.value = reportError(error, "KNOWLEDGE_RUN_ACTION_FAILED", { action: "run.stop", runId: targetRun.id });
    return false;
  }
  finally { if (flight === knowledgeActionFlight && isCurrent(epoch, scope)) busy.value = false; }
}
/** 停止当前归属任务及讨论轮次，不扩大历史会话权限。 */
async function stopTask(): Promise<boolean> {
  const scope = workspaceId.value, epoch = scopeEpoch, threadId = assistantThreadId.value;
  const turnId = chat.threadDisplayRunningStateForThread(threadId)?.runningTurnId;
  try {
    if (activeRun.value?.active && ["batch", "review", "build"].includes(activeRun.value.mode) && !await stopGeneration()) return false;
    if (!isCurrent(epoch, scope) || assistantThreadId.value !== threadId) return false;
    if (threadId && turnId) await chat.interruptTurn(ctx(), { workspaceId: scope, threadId, turnId });
    return true;
  }
  catch (error) { if (isCurrent(epoch, scope)) errorText.value = reportError(error, "KNOWLEDGE_CONVERSATION_STOP_FAILED"); return false; }
}
/** 批任务草稿经编辑保护后进入版本绑定预览，独立修订保留原采用入口。 */
async function adopt(id: string, confirmed = false): Promise<void> {
  if (!canWrite.value || !readingNodeId.value || reportsLoading.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch, nodeId = readingNodeId.value;
  const revision = [detail.value?.current?.revision, ...(detail.value?.drafts ?? [])].find(item => item?.id === id);
  if (revision?.runId) {
    try {
      const run = taskList.value.find(item => item.id === revision.runId) ?? unwrap(await requestKnowledgeAsset(ctx(), "run", { workspaceId: scope, runId: revision.runId }));
      if (!isCurrent(epoch, scope) || readingNodeId.value !== nodeId) return;
      if (usesUnifiedPreview(run)) {
        if (!run.items.some(item => item.nodeId === nodeId && item.revisionId === id)) throw new Error("此版本已被后续修订替代，请重新打开对应文档的待确认更新");
        receiveRun(run);
        if (!await openUpdates(nodeId) || !isCurrent(epoch, scope)) return;
        if (updatesTarget.value) updatesTarget.value = { ...updatesTarget.value, focusId: `${run.id}:${nodeId}:${id}` };
        return;
      }
    } catch (error) { if (isCurrent(epoch, scope)) errorText.value = reportError(error, "KNOWLEDGE_REVISION_PREVIEW_FAILED", { nodeId, revisionId: id, runId: revision.runId }); return; }
  }
  const report = nodeReports.value.filter(item => item.revisionId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!confirmed && (!report || report.stale || report.outcome === "issues")) {
    Modal.confirm({ title: "确认采用这个版本？", content: report?.stale ? "复检依据已经变化，这份报告已失效。采用后该版本会成为正式文档。" : report?.outcome === "issues" ? `复检发现 ${report.issues.length} 个阻断问题。采用后该版本会成为正式文档。` : "这份文档尚未通过复检。采用后该版本会成为正式文档。", okText: "仍然采用", cancelText: "返回检查", onOk: () => { if (isCurrent(epoch, scope) && readingNodeId.value === nodeId) return adopt(id, true); } });
    return;
  }
  const expectedHash = detail.value?.currentHash ?? null;
  busy.value = true;
  try {
    const adopted = unwrap(await requestKnowledgeAsset(ctx(), "revision.adopt", { workspaceId: scope, nodeId, revisionId: id, expectedHash }, { method: "POST" }));
    if (!isCurrent(epoch, scope)) return;
    if (readingNodeId.value === nodeId) detail.value = adopted;
    await refreshSnapshot();
  } catch (error) {
    const text = reportError(error, "KNOWLEDGE_REVISION_ADOPT_FAILED", { workspaceId: scope, nodeId });
    if (isCurrent(epoch, scope)) errorText.value = text;
  }
  finally { if (isCurrent(epoch, scope)) busy.value = false; }
}
/** 人工编辑仍以当前阅读文件和正式指纹保存，失败保留编辑内容。 */
async function saveManual(): Promise<void> {
  if (!canWrite.value || !readingNodeId.value || !detail.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch, nodeId = readingNodeId.value;
  const body = { workspaceId: scope, nodeId, content: editContent.value,
    sources: detail.value.current?.sources ?? [{ kind: "requirement", requirement: "人工编辑项目知识", relation: "人工编辑" }],
    expectedHash: detail.value.currentHash, summary: "人工编辑知识" };
  busy.value = true;
  try {
    const saved = unwrap(await requestKnowledgeAsset(ctx(), "document.save", body, { method: "POST" }));
    if (!isCurrent(epoch, scope)) return;
    if (readingNodeId.value === nodeId) { editing.value = false; previewRevisionId.value = saved.id; previewDocument.value = null; }
    await refreshSnapshot();
    if (isCurrent(epoch, scope) && readingNodeId.value === nodeId && !previewDocument.value) await readNode(nodeId);
    if (isCurrent(epoch, scope)) message.success("知识文档已保存到项目工作区");
  } catch (error) {
    const text = reportError(error, "KNOWLEDGE_DOCUMENT_SAVE_FAILED", { workspaceId: scope, nodeId });
    if (isCurrent(epoch, scope)) errorText.value = text;
  }
  finally { if (isCurrent(epoch, scope)) busy.value = false; }
}
/** 上级导航以已加载的来源目录为准，不使用未提交的路径输入。 */
function parentImportDirectory(): string {
  const parts = importDirectory.value.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}
/** 选择当前来源中的文档，保留同目录分页选择。 */
function toggleImport(path: string, event: unknown): void {
  const checked = (event as { target?: { checked?: boolean } })?.target?.checked === true;
  selectedImportPaths.value = checked ? [...new Set([...selectedImportPaths.value, path])] : selectedImportPaths.value.filter(item => item !== path);
}
/** 从项目根或指定目录读取候选文档；失败保留在弹窗内，不能显示成空目录。 */
async function openImport(directory = importDirectoryInput.value): Promise<void> {
  if (!canWrite.value || busy.value || updatesBusy.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch, requestEpoch = ++importEpoch;
  directory = directory.trim().replace(/\\/g, "/");
  importDirectory.value = directory; importDirectoryInput.value = directory; selectedImportPaths.value = []; importOpen.value = true; importLoading.value = true;
  importItems.value = []; importDirectories.value = []; importNextOffset.value = null; importError.value = null; importSubmitError.value = null;
  try {
    const result = unwrap(await requestKnowledgeAsset(ctx(), "imports", { workspaceId: scope, directory, offset: 0 }));
    if (!isCurrent(epoch, scope) || requestEpoch !== importEpoch) return;
    importItems.value = result.files; importDirectories.value = result.directories; importNextOffset.value = result.nextOffset;
  } catch (error) {
    if (isCurrent(epoch, scope) && requestEpoch === importEpoch) {
      importError.value = reportError(error, "KNOWLEDGE_IMPORT_LIST_FAILED", { workspaceId: scope, directory });
    }
  }
  finally { if (isCurrent(epoch, scope) && requestEpoch === importEpoch) importLoading.value = false; }
}
/** 追加同目录的下一页并保留多选；分页失败显式提示，可重试当前游标。 */
async function loadMoreImports(): Promise<void> {
  if (!canWrite.value || importLoading.value || importNextOffset.value === null) return;
  const scope = workspaceId.value, epoch = scopeEpoch, requestEpoch = importEpoch;
  const directory = importDirectory.value, offset = importNextOffset.value;
  importLoading.value = true; importError.value = null;
  try {
    const result = unwrap(await requestKnowledgeAsset(ctx(), "imports", { workspaceId: scope, directory, offset }));
    if (!isCurrent(epoch, scope) || requestEpoch !== importEpoch || directory !== importDirectory.value) return;
    importItems.value = [...new Map([...importItems.value, ...result.files].map(item => [item.path, item])).values()];
    importDirectories.value = [...new Set([...importDirectories.value, ...result.directories])];
    importNextOffset.value = result.nextOffset;
  } catch (error) {
    if (isCurrent(epoch, scope) && requestEpoch === importEpoch) {
      importError.value = reportError(error, "KNOWLEDGE_IMPORT_LIST_FAILED", { workspaceId: scope, directory, offset });
    }
  }
  finally { if (isCurrent(epoch, scope) && requestEpoch === importEpoch) importLoading.value = false; }
}
/** 顺序提交；首次失败即停止，成功项移出选择，失败及未提交项留在弹窗内重试。 */
async function importSelected(): Promise<void> {
  const items = importItems.value.filter(item => selectedImportPaths.value.includes(item.path));
  if (!canWrite.value || !items.length || busy.value || updatesBusy.value || importLoading.value || importError.value) return;
  const scope = workspaceId.value, epoch = scopeEpoch, requestContext = ctx(), requestEpoch = importEpoch;
  const { parentId } = importDestination.value;
  let treeHash = snapshot.value?.treeHash ?? null;
  busy.value = true;
  importSubmitError.value = null;
  let importedCount = 0;
  try {
    for (const item of items) {
      if (!isCurrent(epoch, scope) || requestEpoch !== importEpoch) return;
      try {
        const imported = unwrap(await requestKnowledgeAsset(requestContext, "import", { workspaceId: scope, path: item.path, contentHash: item.contentHash,
          parentId, treeHash, category: importCategory.value,
          ...(importCategory.value === "specifications" ? { appliesTo: importAppliesTo.value.split("\n").map(path => path.trim()).filter(Boolean) } : {}) }, { method: "POST" }));
        if (!isCurrent(epoch, scope) || requestEpoch !== importEpoch) return;
        snapshot.value = imported; treeHash = imported.treeHash;
        importedCount += 1;
        selectedImportPaths.value = selectedImportPaths.value.filter(path => path !== item.path);
      } catch (error) {
        const text = reportError(error, "KNOWLEDGE_IMPORT_FAILED", { workspaceId: scope, path: item.path, nodeId: parentId });
        if (isCurrent(epoch, scope) && requestEpoch === importEpoch) {
          importSubmitError.value = `已导入 ${importedCount} 个文档；${item.path} 导入失败，后续文档尚未提交。${text}`;
          await refreshSnapshot();
        }
        return;
      }
    }
    if (!isCurrent(epoch, scope)) return;
    message.success(`已导入 ${items.length} 个文档到规格知识库`);
    selectedImportPaths.value = []; importOpen.value = false;
  } catch (error) {
    const text = reportError(error, "KNOWLEDGE_IMPORT_REFRESH_FAILED", { workspaceId: scope, nodeId: parentId });
    if (isCurrent(epoch, scope) && requestEpoch === importEpoch) importSubmitError.value = `${importSubmitError.value ?? ""} 刷新知识状态失败：${text}`;
  } finally { if (isCurrent(epoch, scope)) busy.value = false; }
}
/** 上传复用现有文件权限和审计入口，上传后由用户选择分类并确认引用。 */
async function uploadKnowledgeDocument(file: File): Promise<boolean> {
  if (!canWrite.value || busy.value || importLoading.value || importError.value) return false;
  if (!/\.(md|mdx|txt|rst|adoc)$/i.test(file.name)) { message.error("请上传 Markdown、TXT、RST 或 AsciiDoc 文本；其他文档请先转换。"); return false; }
  const scope = workspaceId.value, epoch = scopeEpoch;
  busy.value = true; importSubmitError.value = null;
  try {
    const result = await uploadWorkspaceFile(ctx(), { workspaceId: scope, targetDir: importDirectory.value || null, file, overwrite: false });
    if (!result.ok) throw createApiResultError(result);
    if (!isCurrent(epoch, scope)) return false;
    busy.value = false;
    await openImport(importDirectory.value);
    if (isCurrent(epoch, scope) && !importError.value) message.success("原文件已上传，请选择分类并确认导入");
    else if (isCurrent(epoch, scope)) importSubmitError.value = "原文件已上传，但来源目录读取失败，请重试读取目录后再确认导入。";
  } catch (error) {
    if (isCurrent(epoch, scope)) importSubmitError.value = reportError(error, "KNOWLEDGE_DOCUMENT_UPLOAD_FAILED", { workspaceId: scope, path: file.name });
  } finally { if (isCurrent(epoch, scope)) busy.value = false; }
  return false;
}
function openMobilePanel(panel: "tree" | "assistant"): void {
  if (panel === "tree") { treeOpen.value = !treeOpen.value; assistantOpen.value = false; }
  else { assistantOpen.value = !assistantOpen.value; treeOpen.value = false; }
}
watch(threadRunning, running => {
  if (running) poll();
  if (assistantThreadId.value) void refreshRuns();
});
watch(requestedThreadId, id => {
  if (!id || id === assistantThreadId.value) return;
  if (shouldDeferRouteThread()) pendingRouteThreadId = id;
  else void connectRequestedConversation(id);
});
watch([selectedId, overviewOpen, viewTab, assistantOpen, updatesTarget, selectedChangeId], persistPageState);
watch(requestedExecutionThreadId, id => {
  if (!snapshot.value) return;
  if (!id) { closeExecutionSession(); return; }
  const info = executionSessionInfo(taskList.value, id);
  void openExecutionSession(id, info?.title ?? "规格执行", info?.kind ?? "知识工作会话");
});
/** 会话页的文档入口显式定位节点，同页跳转也沿用编辑离开检查。 */
watch(() => route.query.nodeId, id => {
  if (route.name === "project-knowledge" && typeof id === "string" && id !== selectedId.value && snapshot.value?.tree.nodes.some(node => node.id === id && !node.archived)) void selectNode(id, true);
});
/** 切文件或候选时取消显式会话固定，保留各线程自己的输入草稿。 */
watch([readingNodeId, () => updatePreview.value?.runId, () => updatePreview.value?.revisionId], () => {
  if (!loading.value && !requestedExecutionThreadId.value) executionSession.value = null;
  if (!requestedThreadId.value) showProjectConversation.value = false;
}, { flush: "sync" });
/** 候选范围改变时立即清除旧预览身份，等待子组件报告实际选中的版本。 */
watch([showUpdates, () => updatesTarget.value?.scopeNodeId, readingNodeId], () => { updatePreview.value = null; }, { flush: "sync" });
watch([() => displayedExecutionSession.value?.threadId, assistantOpen, fileConversationMode], () => { void hydrateExecutionSession(); }, { flush: "sync" });
watch(() => [route.query.view, route.query.changeId], ([view, changeId], previous) => {
  if (typeof changeId === "string") { selectedChangeId.value = changeId; updatesTarget.value = { scopeNodeId: null, changeId }; }
  else if (view === "results" || view === "approvals") { selectedChangeId.value = null; updatesTarget.value = { scopeNodeId: null }; }
  else if (view === "assets" || view === "overview") {
    closeExecutionSession(); updatesTarget.value = null; selectedChangeId.value = null;
    suppressAutoPreview.value = readingNodeId.value; overviewOpen.value = view === "overview";
  } else if (previous?.some(value => value != null)) closeUpdates();
});
onBeforeRouteLeave(() => guardEdits());
/** 采用完成时只允许本次内部文件定位通过，其他导航继续等待子组件解锁。 */
onBeforeRouteUpdate((next, previous) => {
  if (approvalRouteNodeId.value) {
    const query = { ...previous.query }; delete query.changeId; delete query.view;
    if (previous.query.nodeId) query.nodeId = approvalRouteNodeId.value;
    if (next.fullPath === router.resolve({ name: "project-knowledge", query }).fullPath) return true;
  }
  return next.fullPath !== previous.fullPath ? guardEdits() : true;
});
/** 首次进入与迟到目录共用左树选择；后台状态不抢占已打开的文件或审批。 */
watch([visibleTreeNodes, snapshotStatesReady, resultsLoading, loading], () => {
  if (loading.value || updatesTarget.value || updatesBusy.value || editing.value || overviewOpen.value) return;
  if (!selectedId.value && selectedNodeIntent.value && nodeMap.value.has(selectedNodeIntent.value)) { void selectNode(selectedNodeIntent.value, true); return; }
  if (!snapshotStatesReady.value || resultsLoading.value || selectedNode.value && selectedNode.value.contentMode !== "directory") return;
  const target = preferredDocument(selectedId.value);
  if (target) void selectNode(target.id, true);
  else if (!selectedId.value && visibleTreeNodes.value[0]) void selectNode(visibleTreeNodes.value[0].id, true);
});

// 工作区/Server 变化才需要重载整页；账号摘要在握手后补齐时不应再次清空左树。
// 若首个请求早于账号会话完成而失败，再由 userId 变化触发一次重试。
/** 存储损坏必须阻止按其他模型执行，用户重新保存后才能继续。 */
watch(workspaceId, id => {
  buildPrefs.value = null; buildPrefsError.value = null;
  try { buildPrefs.value = readKnowledgeBuildPrefs(id); }
  catch (error) { buildPrefsError.value = reportError(error, "KNOWLEDGE_BUILD_PREFS_READ_FAILED"); }
}, { immediate: true });
watch(() => [workspaceId.value, desktopWorkspace.value ? "desktop" : config.serverWsOrigin, desktopWorkspace.value], load, { immediate: true });
watch(conversationActorId, (next, previous) => {
  if (next === previous) return;
  // 账号或权限身份变化后不再保留旧账号的目录与正文。
  clearKnowledgePageCache();
  if (!snapshot.value || previous !== undefined) void load();
});
/** 状态补齐后的快照才写入缓存，避免恢复时因缺少状态再次显示加载态。 */
watch(snapshot, value => {
  if (!value || !snapshotStatesReady.value) return;
  rememberKnowledgeSnapshot(knowledgeCacheScopeKey(), value);
});
/** 当前正文、版本和复检报告随详情变化写入缓存；只接受与选中节点一致的详情。 */
watch([detail, previewDocument, previewRevisionId, nodeReports, selectedId], () => {
  const id = selectedId.value;
  if (!id || !detail.value || detail.value.node.id !== id) return;
  rememberKnowledgeNode(knowledgeNodeCacheKey(id), {
    detail: detail.value, previewDocument: previewDocument.value, previewRevisionId: previewRevisionId.value,
    reports: [...nodeReports.value],
  });
});
onBeforeUnmount(() => { scopeEpoch += 1; nodeEpoch += 1; readController?.abort(); searchController?.abort(); stopPoll(); if (snapshotStatesTimer) clearTimeout(snapshotStatesTimer); narrowQuery?.removeEventListener("change", syncViewport); });
</script>

<template>
  <div class="knowledge-page">
    <header class="page-header">
      <div class="page-nav">
        <a-tag :title="workspaceId" aria-label="规格库所属项目">{{ workspaceName }}</a-tag>
      </div>
      <div class="knowledge-search" role="search" data-testid="knowledge-search">
        <a-input-search v-model:value="searchQuery" size="middle" placeholder="搜索规格与文档" enter-button="搜索" :loading="searchLoading" @search="runKnowledgeSearch" />
      </div>
      <div class="header-actions">
        <a-tag v-if="snapshot && !canWrite">只读</a-tag>
        <a-button :size="narrowScreen ? 'small' : 'middle'" :disabled="!canWrite || busy || updatesBusy || binding || conversationLoading" @click="openSpecificationConversation">规格对话</a-button>
        <a-button :size="narrowScreen ? 'small' : 'middle'" :disabled="busy || updatesBusy" @click="openUpdates(null)">待确认更新 <span v-if="visibleWorkTree.targetCount">{{ visibleWorkTree.targetCount }}</span></a-button>
        <a-button :size="narrowScreen ? 'small' : 'middle'" type="primary" :loading="buildStarting" :disabled="!canWrite || busy || updatesBusy || !snapshotStatesReady || taskList.some(run => run.active)" @click="startBuild(checkedIds.length ? checkedIds : [])">完善规格</a-button>
        <a-dropdown :trigger="['click']"><a-button :size="narrowScreen ? 'small' : 'middle'" aria-label="规格库更多操作">更多</a-button><template #overlay><a-menu><a-menu-item :disabled="!canWrite || busy || updatesBusy" @click="openImport(importDirectory)">导入文档</a-menu-item><a-menu-item @click="changeHistoryOpen = true">修改建议记录</a-menu-item><a-menu-item @click="policyOpen = true">管理策略</a-menu-item><a-menu-item :disabled="!canWrite || !nodeCount" @click="updateSettingsOpen = true">定时更新</a-menu-item><a-menu-divider /><a-menu-item :disabled="!canWrite || busy || updatesBusy || !nodeCount" @click="openBatch()">高级生成</a-menu-item><a-menu-item :disabled="!canWrite || busy || updatesBusy || !nodeCount" @click="openReview()">复检所选知识</a-menu-item></a-menu></template></a-dropdown>
      </div>
    </header>
    <nav class="mobile-panels" aria-label="规格库面板"><button type="button" aria-label="规格库目录" :aria-expanded="treeOpen" @click="openMobilePanel('tree')">{{ treeTitle }} <span>{{ visibleTreeCount }}</span></button><button type="button" aria-label="AI 对话" :aria-expanded="assistantOpen" @click="openMobilePanel('assistant')">✦ AI 对话 <span v-if="threadRunning || activeRun?.active" class="working-indicator" /></button></nav>
    <div v-if="errorText && errorDiagnostics?.code !== 'CLIENT_OFFLINE'" class="page-error" role="alert">
      <div class="page-error-content">
        <span>{{ errorText }}</span>
        <div v-if="errorDiagnostics" class="page-error-diagnostics">
          <span v-if="errorDiagnostics.requestId">请求 ID：{{ errorDiagnostics.requestId }}</span>
          <span v-if="errorDiagnostics.operation">操作：{{ errorDiagnostics.operation }}</span>
          <span v-if="errorDiagnostics.rootCause">Client 根因：{{ errorDiagnostics.rootCause }}</span>
          <a-button size="small" type="text" @click="copyErrorDiagnostics">复制诊断</a-button>
        </div>
      </div>
      <a-button v-if="pendingBuild" size="small" :disabled="busy || buildStarting" @click="resetPendingGeneration('build')">放弃本次恢复</a-button>
      <a-button v-if="pendingBuild" size="small" :disabled="busy || buildStarting || !canWrite" @click="startBuild()">恢复生成</a-button>
      <a-button size="small" type="text" @click="dismissError">关闭</a-button>
    </div>
    <section v-if="searchVisible" class="search-results-popover" aria-label="规格库搜索结果" data-testid="knowledge-search-results" @mousedown.stop>
      <div class="search-results-heading"><strong>{{ searchQuery ? `搜索“${searchQuery}”` : '规格库搜索' }}</strong><span>全部规格与文档</span><button type="button" class="search-results-close" @click.stop="closeSearchResults">关闭</button></div>
      <p v-if="searchError" class="search-results-error">{{ searchError }}</p>
      <a-spin v-else-if="searchLoading" size="small" />
      <a-empty v-else-if="!searchResults.length" :image="null" description="没有找到匹配的规格或文档" />
      <template v-else>
        <button v-for="item in searchResults" :key="`${item.nodeId}:${item.chunkId ?? ''}`" type="button" class="search-result" :disabled="busy || updatesBusy" @click="openSearchResult(item)">
          <span class="search-result-main"><strong>{{ item.title }}</strong><small>{{ item.excerpt || '暂无摘要' }}</small><small v-if="item.startLine">{{ item.path }} · {{ item.heading }} · 第 {{ item.startLine }}–{{ item.endLine }} 行</small></span>
          <span class="search-result-meta">{{ item.matchMode === 'hybrid' ? '关键词 + 语义' : item.matchMode === 'keyword' ? '关键词' : '语义' }} · {{ item.score.toFixed(2) }}</span>
        </button>
      </template>
    </section>
    <div ref="layoutElement" class="layout" :class="{ 'assistant-collapsed': !assistantOpen, 'layout--resizing': assistantPreviewWidth !== null }" :style="assistantLayoutStyle">
      <button v-if="narrowScreen && (treeOpen || assistantOpen)" type="button" class="panel-backdrop" aria-label="关闭侧面板" @click="treeOpen = false; assistantOpen = false" />
      <aside ref="treeElement" class="tree" :class="{ open: treeOpen }" aria-label="规格库目录" data-testid="knowledge-tree">
        <div class="tree-head">
          <div class="panel-heading">
            <h2 :title="`${treeTitle} · ${visibleTreeCount} 个节点`">{{ treeTitle }} <small class="node-count">{{ visibleTreeCount }} 个节点</small></h2>
            <section class="tree-batch-actions" aria-label="文档生成" data-testid="tree-batch-actions">
              <a-button class="tree-batch-button tree-batch-button-primary" type="primary" size="small" :aria-label="checkedIds.length ? `生成选中 ${checkedIds.length} 项` : '一键生成'" :disabled="!canWrite || busy || buildStarting || taskList.some(run => run.active) || !snapshotStatesReady" @click="startBuild(checkedIds.length ? checkedIds : [])">{{ buildStarting || taskList.some(run => run.active) ? '生成中' : checkedIds.length ? '生成所选知识' : '一键生成' }}</a-button>
            </section>
          </div>
        </div>
        <a-button class="overview-link" type="text" :aria-pressed="overviewOpen" :disabled="busy || updatesBusy" @click="openOverview">项目概览</a-button>
        <a-skeleton v-if="treeLoading" active :paragraph="{ rows: 7 }" />
        <KnowledgeAssetTree v-else :nodes="visibleTreeNodes" :states="snapshot?.states ?? []" :selected-id="selectedId" :workspace-key="treeStorageKey()" :legacy-workspace-key="conversationStorageKey()" :can-write="canWrite && !busy && !updatesBusy" :busy="busy || updatesBusy" :counts="visibleWorkTree.documentCounts" :structure-counts="visibleWorkTree.structureCounts" :generating-counts="visibleWorkTree.generatingCounts" :new-node-ids="visibleWorkTree.newIds" :empty-text="treeEmptyText" :selection-reset-key="selectionResetKey" @select="selectTreeNode" @checked-change="checkedIds = $event" @generate="startBuild([$event])" @review="openReview([$event], true)" @updates="openUpdates($event)" />
        <footer aria-label="规格库统计"><a-button v-if="snapshotStatesError" type="text" size="small" :disabled="resultsLoading || Boolean(activeRun?.active)" :title="snapshotStatesError" @click="refreshSnapshotStates(workspaceId, scopeEpoch, snapshot?.treeHash ?? null)">状态读取失败，重试</a-button><a-spin v-else-if="snapshot && !snapshotStatesReady" size="small" /><template v-else><span><i class="legend-dot ready" />已有 {{ readyCount }}</span><span><i class="legend-dot" />待生成 {{ emptyCount }}</span><span v-if="visibleWorkTree.generatingCount"><i class="legend-dot generating" />生成中 {{ visibleWorkTree.generatingCount }}</span><span><i class="legend-dot draft" />待确认 {{ draftCount }}</span></template></footer>
      </aside>

      <main class="main">
        <div v-if="summaryRun && ((!selectedId && !showUpdates && !readingPending) || summaryRun.active || summaryUnfinished || summaryRun.id === maintenanceRunId || summaryRun.adoptions?.some(receipt => !receipt.completed && !receipt.cancelled))" class="task-summary" role="status">
          <div><strong>{{ summaryRun.active ? '文档生成中' : summaryRun.id === maintenanceRunId ? '内容已采用，维护设置尚未保存' : summaryRun.adoptions?.some(receipt => !receipt.completed && !receipt.cancelled) ? '有未完成采用，需恢复或终止' : '文档生成需要处理' }}</strong><span>{{ summaryIssue ?? (summaryRun.mode === 'conversation' ? `已交付 ${summaryRun.items.filter(item => item.status === 'completed').length} 份文档` : `已保存 ${summaryRun.items.filter(item => item.status === 'completed').length} / ${summaryRun.items.length} 篇`) }}</span></div>
          <a-button v-if="summaryRun.id === maintenanceRunId || summaryRun.adoptions?.some(receipt => !receipt.completed && !receipt.cancelled)" size="small" :disabled="busy || updatesBusy" @click="openRecovery(summaryRun)">恢复未完成操作</a-button>
          <template v-else-if="summaryUnfinished"><a-button v-if="summaryAdjustable" size="small" :disabled="!canWrite || busy || updatesBusy || threadRunning" @click="reviseBatch(summaryRun)">调整未完成项要求</a-button><a-button v-if="summaryFailed" size="small" :disabled="!canWrite || busy || updatesBusy || threadRunning" @click="resumeGeneration(summaryRun, true)">重试失败项</a-button><a-button size="small" type="primary" :disabled="!canWrite || busy || updatesBusy || threadRunning" @click="resumeGeneration(summaryRun)">继续未完成项</a-button></template>
          <a-button v-if="summaryRun.active" size="small" :disabled="busy || !canWrite" @click="stopGeneration(summaryRun)">停止</a-button>
        </div>
        <div v-if="visibleWorkTree.targetCount && !selectedId && !showUpdates && !readingPending" class="updates-summary"><span>{{ visibleWorkTree.documentCount }} 篇文档有待确认更新<span v-if="visibleWorkTree.structureCount">，另含 {{ visibleWorkTree.structureCount }} 项结构调整</span></span><a-button size="small" @click="openUpdates(null)">查看更新</a-button></div>
        <div class="reading-layout">
          <section class="reading-document">
        <!-- 采用至结果定位完成前持续加载，保留组件执行请求和失败恢复。 -->
        <div v-if="showUpdates && updatesBusy" class="node-loading" role="status" aria-live="polite" aria-busy="true"><a-spin aria-hidden="true" /><span>加载中</span></div>
        <KnowledgeUpdates v-if="showUpdates" v-show="!updatesBusy" :workspace-id="workspaceId" :context="ctx()" :nodes="visibleTreeNodes" :formal-nodes="snapshot?.tree.nodes ?? []" :runs="taskList" :updates="visibleWorkTree.updates" :scope-node-id="updatesTarget?.scopeNodeId ?? (updatesTarget ? null : readingNodeId)" :change-id="updatesTarget?.changeId" :focus-id="updatesTarget?.focusId" :focus-report="updatesTarget?.report" :recovery-run-id="updatesTarget?.recoveryRunId" :after-apply="afterApply" @focus="rememberUpdateFocus" @preview="updatePreview = $event" :can-write="canWrite" :actions-busy="busy || threadRunning || executionThreadRunning || Boolean(activeRun?.active) || Boolean(pendingBatch)" @recheck="recheckKnowledgeChange" @review="openReview([$event], false)" @resume-review="resumeCandidateReview" @repair="repairReport" @repair-issue="repairIssue" @return-to-generation="returnToGeneration" @close="closeUpdates" @changed="updatesChanged" @open-file="openWorkspaceFile" @busy="handleUpdatesBusy" @error="(cause, context) => errorText = reportError(cause, 'KNOWLEDGE_UPDATES_FAILED', context)" />
        <KnowledgeOverview v-else-if="overviewOpen" :snapshot="snapshot" :runs="taskList" :changes="pendingChangeNodes" :loading="loading || Boolean(snapshot && !snapshotStatesReady && !snapshotStatesError)" :state-error="snapshotStatesError" :run-error="resultsLoadError" :can-write="canWrite" :busy="busy || updatesBusy || buildStarting || binding || conversationLoading || taskList.some(run => run.active)" @improve="startBuild([])" @discuss="openSpecificationConversation" @updates="openUpdates(null)" @select="selectTreeNode" @retry="retryOverview" />
        <!-- 尚未确定正式正文或候选预览时保持加载，避免先渲染普通正文页。 -->
        <div v-else-if="documentReadError" class="empty" role="alert"><h3>文档读取失败</h3><p>{{ documentReadError.message }}</p><a-button :disabled="busy || updatesBusy" @click="retryReadDocument">重新读取文档</a-button></div>
        <div v-else-if="readingPending" class="node-loading" role="status" aria-live="polite" aria-busy="true"><a-spin aria-hidden="true" /><span>加载中</span></div>
        <div v-else-if="snapshotStatesError && !snapshotStatesReady && (!node || node.contentMode === 'directory')" class="empty" role="alert"><h3>知识状态读取失败</h3><p>{{ snapshotStatesError }}</p><a-button :disabled="resultsLoading || Boolean(activeRun?.active)" @click="refreshSnapshotStates(workspaceId, scopeEpoch, snapshot?.treeHash ?? null)">重新读取状态</a-button></div>
        <template v-else-if="node">
          <div class="main-head">
            <div class="document-title"><h2 :title="pathTitle(node)">{{ pathTitle(node) }}</h2><a-tag :color="statusColor">{{ statusLabel }}</a-tag><small v-if="specificationPaths?.length" :title="specificationPaths.join('、')">适用：{{ specificationPaths.join('、') }}</small></div>
            <div class="file-tools">
              <template v-if="viewTab === 'node' && documentText && node.contentMode !== 'reference'">
                <a-button v-if="!editing && !previewIsDraft" size="small" :disabled="!canWrite" @click="editing = true">编辑文档</a-button>
                <template v-else-if="editing"><a-button size="small" @click="editing = false; editContent = documentText">取消</a-button><a-button size="small" type="primary" :loading="busy" :disabled="!canWrite" @click="saveManual">保存到项目</a-button></template>
              </template>
              <a-button v-if="currentUpdatesCount" size="small" @click="openUpdates(node.id)">查看更新 {{ currentUpdatesCount }}</a-button><a-button v-if="viewTab !== 'node'" size="small" @click="setContentView('node')">返回文档</a-button><a-dropdown :trigger="['click']"><a-button size="small" :aria-label="`${node.title}更多操作`">更多</a-button><template #overlay><a-menu><a-menu-item :disabled="!canWrite || busy" @click="startBuild([node!.id])">重新生成此文档</a-menu-item><a-menu-item :disabled="!canWrite || busy" @click="openReview([node!.id], false)">复检此文档</a-menu-item><a-menu-item @click="setContentView('sources')">来源依据</a-menu-item><a-menu-item @click="setContentView('review')">复检报告</a-menu-item></a-menu></template></a-dropdown>
            </div>
          </div>
          <div class="content" :class="{ 'editing-content': editing && viewTab === 'node', 'document-loading': documentLoading }">
            <div v-if="documentLoading" class="node-loading" role="status" aria-live="polite" aria-busy="true"><a-spin aria-hidden="true" /><span>加载中</span></div>
            <template v-else>
            <div v-if="detail?.drafts.length && !currentUpdatesCount" class="revision-bar">
              <label><span>查看版本</span><select :value="previewRevisionId ?? ''" aria-label="选择知识版本" :disabled="revisionLoading" @change="viewRevision(($event.target as HTMLSelectElement).value)"><option v-if="detail.current" :value="detail.current.revision.id">正式文档</option><option v-for="draft in detail.drafts" :key="draft.id" :value="draft.id">待采用 · {{ dayjs(draft.createdAt).format('YYYY-MM-DD HH:mm:ss') }}</option></select></label>
              <span class="revision-review-status">{{ previewReviewStatus }}</span>
              <a-button v-if="previewIsDraft" size="small" :disabled="!canWrite || busy || revisionLoading || reportsLoading" @click="adopt(previewRevisionId!)">采用此版本</a-button>
            </div>
            <div v-if="viewTab === 'node' && node.contentMode === 'directory'" class="empty node-empty"><h3>此目录暂无内容</h3><p>从项目代码和文档中整理此目录的规格与知识。</p><a-button :disabled="!canWrite || busy || !snapshotStatesReady" @click="startBuild([node.id])">生成此目录知识</a-button></div>
            <div v-else-if="viewTab === 'node' && (documentText || detail?.reference)" class="document" :class="{ 'document-editing': editing }">
              <div v-if="node.contentMode === 'reference'" class="reference-status"><strong>实时引用 · {{ detail?.reference?.state === 'changed' ? '原文已变化' : '原文未变化' }}</strong><a-button type="link" size="small" @click="openWorkspaceFile(node.reference!.path)">打开原文</a-button><code>{{ node.reference?.path }}</code><span>读取时间：{{ referenceReadAt }}</span><a-button size="small" :loading="nodeLoading" @click="readNode(node.id)">重新读取原文</a-button></div>
              <div v-if="searchLocation && !editing" ref="searchLocationElement">
                <a-alert data-testid="knowledge-search-location" :type="searchLocation.warning ? 'warning' : 'info'" :message="searchLocation.warning || `命中章节：${searchLocation.hit.heading || node.title} · 第 ${searchLocation.hit.startLine}–${searchLocation.hit.endLine} 行`" show-icon>
                  <template #description><code>{{ searchLocation.hit.path }}</code><pre v-if="!searchLocation.warning" class="search-hit-preview">{{ searchLocation.content }}</pre></template>
                </a-alert>
              </div>
              <a-textarea v-if="editing" v-model:value="editContent" class="document-editor" :rows="1" :auto-size="false" aria-label="知识正文" />
              <MarkdownContent v-else :text="documentText" :workspace-id="workspaceId" :resource-file-path="detail?.reference?.path" @open-workspace-file="openWorkspaceFile" />
            </div>
            <div v-else-if="viewTab === 'node' && !nodeLoading && !revisionLoading" class="empty node-empty">
              <span class="empty-symbol" aria-hidden="true">▤</span>
              <h3>{{ node.contentMode === 'reference' ? '实时原文不可用' : '这份知识还没有内容' }}</h3>
              <p>{{ node.contentMode === 'reference' ? '原文读取失败，请检查错误信息后重试。' : '生成前会先判断内容价值，已有资料足够时直接引用。' }}</p>
              <div class="quick-actions"><a-button v-if="node.contentMode === 'reference'" @click="readNode(node.id)">重新读取</a-button><a-button v-else :disabled="!canWrite || !snapshotStatesReady" @click="startBuild([node.id])">生成这份知识</a-button></div>
            </div>
            <KnowledgeReviewReport v-else-if="viewTab === 'review'" :reports="previewReports" :loading="reportsLoading" :busy="busy || Boolean(activeRun?.active)" :restart-busy="busy || Boolean(readingReviewActivity) || reportsLoading || Boolean(reportsReadError)" :can-write="canWrite && Boolean(previewDocument)" :can-repair="ancestors(node)[0]?.category !== 'product'" :pending="Boolean(previewReviewItem && knowledgeItemNeedsReview(previewReviewItem) && previewReviewItem.review?.status === 'pending')" :failure="reportsReadError ?? (previewReviewItem?.reviewConfig?.enabled === false ? null : previewReviewItem?.review?.error?.message)" :generation-thread-id="previewReviewItem?.executionThreadId ?? null" :generation-title="node.title" @review="openReview([node.id], false)" @repair="repairReport" @repair-issue="repairIssue" @return-to-generation="returnToGeneration" />
            <div v-else class="sources">
              <div v-for="(source, index) in previewDocument?.sources" :key="index" class="source">
                <code>{{ source.path ?? '项目要求' }}</code><p>{{ source.relation }}</p>
                <small v-if="source.startLine">第 {{ source.startLine }}{{ source.endLine ? `–${source.endLine}` : '' }} 行</small>
              </div>
              <div v-if="!previewDocument?.sources.length" class="empty">文档生成后会在这里列出代码和文档来源。</div>
            </div>
            </template>
          </div>
        </template>
        <div v-else class="empty page-empty">
          <span class="empty-symbol" aria-hidden="true">✦</span>
          <h2>{{ selectedNode ? '此目录暂无内容' : '建立规格知识库' }}</h2>
          <p>先明确规格约束，再实现与验证。点击“一键生成”整理规格及支撑文档，确认采用后，在研发会话中开启 Spec 使用。</p>
        </div>
          </section>
        </div>
      </main>

      <button v-if="!assistantOpen" class="collapsed-rail assistant-rail" type="button" aria-label="展开 AI 对话" @click="assistantOpen = true">‹ AI 对话</button>
      <div ref="assistantContainer" class="assistant-container" :class="{ open: assistantOpen }">
        <DesktopPanelResizeHandle
          v-if="assistantOpen && !narrowScreen"
          side="left"
          :value="assistantEffectiveWidth"
          :min="assistantMinWidth"
          :max="assistantMaxWidth"
          aria-label="调整 AI 对话宽度"
          data-testid="knowledge-assistant-resize-handle"
          @resize-start="startAssistantResize"
          @resize-preview="assistantPreviewWidth = $event"
          @resize-commit="commitAssistantResize"
          @resize-cancel="assistantPreviewWidth = null"
        />
      <aside class="assistant" :class="{ open: assistantOpen, 'active-conversation': fileConversationMode ? displayedExecutionSession : assistantThreadId }" aria-label="AI 规格助手" data-testid="knowledge-assistant">
        <div class="assistant-head">
          <div class="panel-heading"><div class="assistant-title"><h2 :title="fileConversationMode ? '生成、复检与修订集中在文件工作会话；切换文件自动定位对应记录。' : '项目讨论不改变已创建任务的配置。'">{{ fileConversationMode ? displayedExecutionSession ? `${displayedExecutionSession.kind} · ${displayedExecutionSession.title}` : '文件工作会话' : '✦ 规格协作' }}</h2><span v-if="bindingReady && !fileConversationMode" class="assistant-scope" :title="boundScopeTitle">{{ boundScopeTitle }}</span></div><div class="assistant-heading-actions">
            <a-button v-if="fileConversationMode" size="small" @click="showProjectConversation = true">项目讨论</a-button>
            <a-button v-else-if="showProjectConversation" size="small" @click="showProjectConversation = false">文件会话</a-button>
            <a-popover v-if="assistantThreadId && !fileConversationMode" v-model:open="sessionMenuOpen" trigger="click" placement="bottomRight" :arrow="false">
              <template #content>
                <div class="session-popover">
                  <div class="session-popover-title"><strong>规格会话</strong><span>{{ boundScopeTitle }}</span></div>
                  <a-select v-if="conversations.length" :value="assistantThreadId ?? undefined" :options="conversationOptions" placeholder="选择规格会话" aria-label="选择规格会话" class="conversation-picker" :disabled="binding || threadRunning || Boolean(activeRun?.active)" @change="selectConversation(String($event))"><template #option="option"><div class="conversation-option"><strong>{{ option.label }}</strong><small>{{ option.description }}</small></div></template></a-select>
                  <p v-if="buildPrefs?.model">新建会话模型：{{ buildPrefs.model }}</p>
                  <div class="session-popover-actions"><a-button size="small" :disabled="modelSettingsBlocked" @click="createConversation(null)">新建规格会话</a-button><a-button size="small" :disabled="modelSettingsBlocked" @click="sessionMenuOpen = false; openBuildSettings()">模型设置</a-button></div>
                  <p>会话用于讨论规格与维护文档，正式内容需确认采用并保存在规格知识库。</p>
                </div>
              </template>
              <a-button size="small" aria-label="管理规格会话" :disabled="binding">会话</a-button>
            </a-popover>
            <a-button v-if="assistantThreadId && !fileConversationMode" size="small" :loading="binding" :disabled="!canWrite" @click="disconnectConversation">结束协作</a-button>
            <a-button type="text" size="small" aria-label="收起" title="收起 AI 对话" @click="assistantOpen = false"><template #icon><RightOutlined aria-hidden="true" /></template></a-button>
          </div></div>
        </div>

        <div v-if="bindingError && !fileConversationMode" class="binding-error" role="alert" data-testid="knowledge-conversation-binding"><span>{{ bindingError }}</span><a-button v-if="assistantThreadId" size="small" @click="connectConversation()">重新连接</a-button></div>
        <div class="assistant-body">
          <template v-if="fileConversationMode">
            <div v-if="executionSessionLoading || documentLoading || resultsLoading && !displayedExecutionSession" class="conversation-start conversation-start--loading"><a-spin size="small" /><span>正在加载文件会话…</span></div>
            <div v-else-if="executionSessionError" class="binding-error" role="alert"><span>{{ executionSessionError }}</span><a-button size="small" @click="hydrateExecutionSession">重试</a-button></div>
            <ChatPanel v-else-if="displayedExecutionSession && hydratedExecutionThreadId === displayedExecutionSession.threadId" :key="displayedExecutionSession.threadId" :workspace-id="workspaceId" :thread-id="displayedExecutionSession.threadId as ThreadId" :interaction-active="assistantOpen" assistant-mode :allow-queue="false" :composer-disabled="!canWrite || executionRunActive || busy || updatesBusy" preserve-draft-on-disable />
            <div v-else class="conversation-start"><p>{{ showUpdates && !updatePreview ? '请选择一个候选版本，查看对应工作会话。' : '当前文件版本尚无可用的生成会话记录。' }}</p></div>
          </template>
          <ChatPanel v-else-if="assistantThreadId" ref="assistantPanel" :workspace-id="workspaceId" :thread-id="assistantThreadId" :interaction-active="assistantOpen" assistant-mode preserve-draft-on-disable :allow-queue="false" :composer-disabled="!canWrite || !bindingReady || binding" @model-prefs-change="rememberConversationPrefs">
            <template #toolbar-before-model="{ disabled }">
              <a-select :value="knowledgeConversation?.engine ?? initialEngine" :options="batchEngineOptions" aria-label="规格会话引擎" title="切换引擎会新建会话，并保留当前草稿" size="small" :bordered="false" :dropdown-match-select-width="false" placement="topLeft" :disabled="disabled || modelSettingsBlocked" @change="changeKnowledgeEngine($event as EngineType)" />
            </template>
          </ChatPanel>
          <div v-else-if="conversationLoading" class="conversation-start conversation-start--loading">
            <a-spin size="small" />
            <span>正在恢复规格会话…</span>
          </div>
          <div v-else class="conversation-start">
            <div class="conversation-welcome">
              <div class="conversation-intro"><span aria-hidden="true">✦</span><h3>和 AI 一起明确规格</h3><p>确认约束，整理架构与产品文档。<br>采用后在研发会话中开启 Spec 使用。</p></div>
              <div v-if="canWrite" class="conversation-start-form">
                <p class="scope-description">围绕项目规格与支撑文档交流，目录与多选只限定本次任务。</p>
                <p v-if="buildPrefs?.model">新建会话模型：{{ buildPrefs.model }}</p>
                <div class="conversation-connect"><a-select v-if="!buildPrefs" v-model:value="initialEngine" aria-label="会话引擎" :options="batchEngineOptions" /><a-button type="primary" :loading="binding" :disabled="loading || Boolean(buildPrefsError)" @click="startConversation()">{{ recentConversation ? '继续最近会话' : '开始规格对话' }}</a-button><a-button :disabled="modelSettingsBlocked" @click="openBuildSettings()">模型设置</a-button></div>
                <p v-if="buildPrefsError" role="alert">{{ buildPrefsError }}</p>
                <div v-if="recentConversation" class="recent-conversation"><span :title="conversationDescription(recentConversation)">{{ recentConversation.title }}</span><a-button type="text" size="small" :disabled="binding || loading" @click="createConversation(startNodeId)">新建独立会话</a-button></div>
                <div v-if="conversations.length" class="conversation-history"><div class="history-heading"><span class="start-label">历史会话</span></div><a-select :options="conversationOptions" placeholder="选择规格会话" aria-label="选择历史规格会话" class="conversation-picker" :disabled="binding" @change="connectConversation(String($event))"><template #option="option"><div class="conversation-option"><strong>{{ option.label }}</strong><small>{{ option.description }}</small></div></template></a-select></div>
              </div>
              <p v-else class="read-only-note">你可以浏览规格知识库，生成和修改需要写入权限。</p>
            </div>
          </div>
        </div>
      </aside>
      </div>
    </div>

    <KnowledgeUpdateSettings v-model:open="updateSettingsOpen" :workspace-id="workspaceId" :context="ctx()" :snapshot="snapshot" :selected-node-ids="checkedIds" :initial-engine="knowledgeModelPrefs.engine" :initial-model="knowledgeModelPrefs.model" :initial-effort="knowledgeModelPrefs.effort" @view-run="openUpdateResult" />
    <a-modal v-model:open="batchOpen" :title="buildSettingsMode ? '规格库构建设置' : batchMode === 'review' ? '复检已有文档' : batchRepairReports.length ? '根据报告生成修订版' : '确认批量生成'" :z-index="1100" :closable="!busy && !binding" :mask-closable="!busy && !binding" :keyboard="!busy && !binding" :footer="null" width="640px" :style="{ top: '24px' }">
      <div class="batch-scroll">
      <p v-if="buildSettingsMode" class="batch-explanation">目标项目：{{ workspaceName }}</p>
      <p class="batch-explanation">{{ buildSettingsMode ? '保存后同步规格协作及后续构建配置；切换引擎会新建会话并保留草稿。已创建任务保留原配置。默认自动复检最多 2 轮，结果统一预览后采用。' : '本次任务在后台执行，无需打开或切换规格会话。' }}</p>
      <details class="batch-advanced" :open="buildSettingsMode || batchMode === 'review'"><summary>引擎、模型与复检设置</summary>
      <section class="batch-model-settings" aria-label="本批次引擎配置">
        <div class="batch-model-heading"><strong>执行引擎</strong></div>
        <label class="batch-engine-field"><span>引擎</span><select v-model="batchEngine" aria-label="批量生成引擎" :disabled="batchLocked" @change="changeBatchEngineEvent">
          <option v-for="option in batchEngineOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select></label>
        <p class="batch-model-note">{{ buildSettingsMode ? '当前规格会话与后续一键生成共用此配置。切换引擎会保留旧会话历史。' : '引擎、模型和思考强度只作用于本次批量任务，不会修改当前规格会话的配置。' }}</p>
      </section>
      <section v-if="batchHasGeneration" class="batch-model-settings" aria-label="本批次模型配置">
        <div class="batch-model-heading"><strong>生成配置</strong></div>
        <div class="batch-model-fields">
          <label><span>模型</span><select v-model="batchModelId" aria-label="批量生成模型" :disabled="batchLocked || batchCatalog?.loading">
            <option value="">{{ buildSettingsMode && batchEngineStatus?.models.find(model => model.isDefault) ? `默认模型：${batchEngineStatus.models.find(model => model.isDefault)!.displayName}` : '引擎默认' }}</option>
            <optgroup v-for="group in batchModelGroups" :key="group.label" :label="group.label"><option v-for="option in group.options" :key="option.value" :value="option.value">{{ option.label }}</option></optgroup>
          </select></label>
          <label><span>思考强度</span><select v-model="batchEffort" aria-label="批量思考强度" :disabled="batchLocked || batchCatalog?.loading || !batchEffortOptions.length">
            <option value="">{{ batchModelInfo && !batchEffortOptions.length ? '模型不支持配置' : '模型默认' }}</option>
            <option v-for="option in batchEffortOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select></label>
        </div>
        <p class="batch-model-note">{{ buildSettingsMode ? '保存时确定具体模型，后续生成沿用此选择。' : '仅用于本次生成，对话中的模型设置保持不变。' }}</p>
        <p v-if="batchCatalog?.loading" class="batch-model-note" role="status">正在读取模型列表…</p>
        <p v-else-if="batchCatalog?.lastError" class="batch-model-note" role="alert">模型列表读取失败：{{ batchCatalog.lastError }} <a-button type="link" size="small" @click="refreshBatchModels">重试</a-button></p>
      </section>
      <section v-if="!buildSettingsMode" class="batch-model-settings" aria-label="本批次复检配置">
        <div class="batch-model-heading"><strong>{{ batchMode === 'review' ? '复检配置' : '生成后复检' }}</strong><a-switch v-if="batchMode === 'batch'" v-model:checked="batchReviewEnabled" aria-label="生成后复检" :disabled="batchLocked" /></div>
        <div v-if="batchReviewEnabled || batchMode === 'review'" class="batch-model-fields">
          <label><span>复检模型</span><select v-model="batchReviewModelId" aria-label="复检模型" :disabled="batchLocked || batchCatalog?.loading"><option value="">沿用生成模型</option><optgroup v-for="group in batchReviewModelGroups" :key="group.label" :label="group.label"><option v-for="option in group.options" :key="option.value" :value="option.value">{{ option.label }}</option></optgroup></select></label>
           <label><span>复检思考强度</span><select v-model="batchReviewEffort" aria-label="复检思考强度" :disabled="batchLocked || batchCatalog?.loading || !batchReviewEffortOptions.length"><option value="">{{ batchReviewModelInfo && !batchReviewEffortOptions.length ? '模型不支持配置' : '模型默认' }}</option><option v-for="option in batchReviewEffortOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
           <label><span>发现问题后最多复检</span><select v-model.number="batchReviewMaxRounds" aria-label="最大复检轮次" :disabled="batchLocked"><option v-for="round in KNOWLEDGE_MAX_REVIEW_ROUNDS" :key="round" :value="round">{{ round }} 轮</option></select></label>
        </div>
        <label v-if="batchReviewEnabled || batchMode === 'review'" class="review-auto-repair"><span><strong>发现问题后自动修订</strong><small>{{ batchIncludesProduct ? '所选范围含产品文档，本次只复检并报告问题；请修改原始资料。' : '复检指出问题后，AI 会回到该规格会话修订，再继续复检，直到通过或达到轮次上限。' }}</small></span><a-switch :checked="batchReviewAutoRepair && !batchIncludesProduct" aria-label="发现问题后自动修订" :disabled="batchLocked || batchIncludesProduct" @update:checked="batchReviewAutoRepair = $event" /></label>
        <p class="batch-model-note">{{ batchMode === 'review' ? '在文件工作会话中运行复检子任务，优先检查最新待采用版本，其次为正式文档；空白知识跳过。' : batchReviewEnabled ? '文档生成后保存为待采用版本，在同一工作会话中由子任务独立核对代码与要求；确认后由你采用。' : '本批次跳过复检，生成内容仍可随后单独复检。' }}</p>
        <p v-if="batchMode === 'review' && batchCatalog?.lastError" class="batch-model-note" role="alert">模型列表读取失败：{{ batchCatalog.lastError }} <a-button type="link" size="small" @click="refreshBatchModels">重试</a-button></p>
      </section>
      <div v-if="!buildSettingsMode" class="batch-settings">
        <label><span>包含所选目录的后代</span><a-switch v-model:checked="batchIncludeDescendants" :disabled="batchLocked" aria-label="包含所选目录的后代" /></label>
        <a-radio-group v-if="batchMode === 'batch' && !batchRepairReports.length" v-model:value="batchStrategy" :disabled="batchLocked"><a-radio value="all">按要求处理选中知识</a-radio><a-radio value="missing">只补齐空白</a-radio></a-radio-group>
        <label><span>同时处理知识</span><input v-model.number="batchConcurrency" type="number" min="1" :max="MAX_BATCH_CONCURRENCY" step="1" inputmode="numeric" aria-label="批次并发数" :disabled="batchLocked" @change="normalizeBatchConcurrency" /></label>
        <p class="batch-model-note">可填写 1 到 {{ MAX_BATCH_CONCURRENCY }}。这是本批次实际并发目标；Client 当前全局上限为 {{ activeRun?.scheduler?.limit ?? 5 }}，达到目标后才会排队。</p>
      </div>
      </details>
      <p v-if="!buildSettingsMode" class="batch-explanation">本次处理 {{ batchTargets.length }} 项。{{ batchMode === 'review' ? '仅复检，不重新生成文档。' : batchRepairReports.length ? '读取报告中的问题和证据生成修订草稿，保留现有版本。' : batchStrategy === 'all' ? '按当前要求逐项判断：已有知识修改或补充，没有知识生成；目录结构调整通过右侧规格会话提交计划。' : '只补齐没有正文的知识，已有内容保持不变。' }}</p>
      <div v-if="!buildSettingsMode" class="batch-preview">
        <div v-for="item in batchTargets" :key="item.id">{{ pathTitle(item) }}</div>
      </div>
      <a-textarea v-if="!buildSettingsMode && !(batchRevisionRunId && batchMode === 'review')" v-model:value="batchPrompt" :disabled="batchLocked" :rows="3" :placeholder="batchMode === 'review' ? '本次复检重点；自动对照项目和目录要求' : '告诉 AI 目标即可：已有知识会修改补充，没有知识会生成；目录调整会先形成计划'" aria-label="批量生成要求" />
      <p v-if="batchError" class="page-error" role="alert">{{ batchError }}</p>
      <p v-if="pendingBatch" class="batch-model-note">重试沿用原请求；需要调整时可放弃本次恢复，已有任务与产物保留在任务记录中。<a-button size="small" :disabled="busy" @click="resetPendingGeneration('batch')">重新配置</a-button></p>
      </div>
      <div class="batch-submit"><a-button :disabled="busy || binding" @click="batchOpen = false">取消</a-button><a-button v-if="buildSettingsMode" type="primary" :loading="binding" :disabled="modelSettingsBlocked || batchCatalog?.loading" @click="saveBuildSettings">{{ pendingBuildIds ? '保存并开始生成' : '保存构建设置' }}</a-button><a-button v-else type="primary" :loading="busy" :disabled="!batchTargets.length || !canWrite || threadRunning || Boolean(activeRun?.active) || batchCatalog?.loading" @click="submitBatch">{{ pendingBatch ? '重试原任务' : batchMode === 'review' ? '开始复检' : batchRepairReports.length ? '开始生成修订版' : '开始生成' }}</a-button></div>
    </a-modal>

    <a-drawer v-model:open="changeHistoryOpen" title="修改建议记录" width="min(1100px, 96vw)" :body-style="{ padding: 0, display: 'flex', minHeight: 0 }">
      <KnowledgeChangeInbox v-if="changeHistoryOpen" :workspace-id="workspaceId" :context="ctx()" :can-write="canWrite" @recheck="changeHistoryOpen = false; recheckKnowledgeChange($event)" @changed="historyChangeReviewed" />
    </a-drawer>
    <KnowledgeManagementPolicy v-model:open="policyOpen" />
    <a-modal :open="Boolean(pendingEditDecision)" title="这份文档还有未保存修改" :footer="null" @cancel="pendingEditDecision?.('stay')"><p>保存后继续、放弃修改，或留在当前文档继续编辑。</p><div class="quick-actions"><a-button @click="pendingEditDecision?.('stay')">继续编辑</a-button><a-button danger @click="pendingEditDecision?.('discard')">放弃修改</a-button><a-button type="primary" @click="pendingEditDecision?.('save')">保存并继续</a-button></div></a-modal>
    <a-modal v-model:open="importOpen" title="选择项目文档导入" wrap-class-name="knowledge-import-modal" :closable="!busy" :mask-closable="!busy" :keyboard="!busy" width="min(880px, calc(100vw - 32px))" :style="{ top: '24px' }" :body-style="{ paddingTop: '12px' }">
      <div class="import-layout">
        <aside class="import-settings" aria-label="导入归类设置">
          <div>
            <h3>归入分类</h3>
            <a-radio-group v-model:value="importCategory" class="import-categories" :disabled="busy" aria-label="导入知识分类"><a-radio v-for="category in KNOWLEDGE_CATEGORIES" :key="category.category" :value="category.category">{{ category.title }}</a-radio></a-radio-group>
            <p class="import-hint">{{ importCategoryHint }}</p>
          </div>
          <a-collapse v-if="importCategory === 'specifications'" class="import-scope" ghost expand-icon-position="end"><a-collapse-panel key="scope" :header="`适用范围：${importAppliesTo.trim() ? '指定路径' : '整个项目'}`">
            <a-textarea v-model:value="importAppliesTo" :disabled="busy" :rows="2" aria-label="规格适用范围" placeholder="例如 apps/web，每行一个路径" />
            <p class="import-hint">填写项目相对文件或目录，留空适用于整个项目。</p>
            <p class="import-hint">包含多个专题的综合规则文件，建议通过一键生成提取到对应规格文档。</p>
          </a-collapse-panel></a-collapse>
          <div class="import-destination"><span>导入位置</span><strong>{{ importDestination.title }}</strong></div>
          <p class="import-description">导入后直接引用原文，按章节检索；原文更新时读取最新内容。</p>
        </aside>
        <section class="import-browser" aria-label="选择来源文档">
          <div class="import-browser-heading"><h3>选择文档</h3><a-upload :show-upload-list="false" :before-upload="uploadKnowledgeDocument" accept=".md,.mdx,.txt,.rst,.adoc" :disabled="busy || importLoading || Boolean(importError)"><a-button :loading="busy" :disabled="importLoading || Boolean(importError)" :title="`上传到：${importDirectory || '项目根目录'}`"><template #icon><UploadOutlined aria-hidden="true" /></template>上传本地文档</a-button></a-upload></div>
          <p class="import-hint">引用原文，支持 Markdown、TXT、RST、AsciiDoc。</p>
          <div class="import-path"><a-input v-model:value="importDirectoryInput" :disabled="busy || importLoading" aria-label="导入来源目录" placeholder="项目相对目录，留空浏览项目根目录" @press-enter="openImport()" /><a-button :loading="importLoading" :disabled="busy" @click="openImport()">读取目录</a-button></div>
          <div class="import-nav"><a-button size="small" :disabled="busy || importLoading || !importDirectory" @click="openImport(parentImportDirectory())">上级目录</a-button><a-button v-if="importDirectory" size="small" :disabled="busy || importLoading" @click="openImport('')">返回项目根目录</a-button><code :title="importDirectory || '项目根目录'">{{ importDirectory ? `${importDirectory}/` : '项目根目录' }}</code></div>
          <div class="import-scroll" :aria-busy="importLoading">
            <a-alert v-if="importError" type="error" show-icon :message="importError" />
            <a-alert v-if="importSubmitError" type="error" show-icon :message="importSubmitError" />
            <button v-for="directory in importDirectories" :key="directory" type="button" class="import-folder" :disabled="busy || importLoading" @click="openImport(directory)"><FolderOutlined aria-hidden="true" /><span>{{ directory.split('/').at(-1) }}/</span><RightOutlined aria-hidden="true" /></button>
            <div v-for="item in importItems" :key="item.path" class="import-row" :class="{ 'is-selected': selectedImportPaths.includes(item.path) }"><a-checkbox :checked="selectedImportPaths.includes(item.path)" :disabled="busy || importLoading" @change="toggleImport(item.path, $event)"><span class="import-file"><FileTextOutlined aria-hidden="true" /><span><strong>{{ item.title }}</strong><small>{{ item.path }}</small></span></span></a-checkbox></div>
            <div v-if="importLoading" class="import-loading" role="status"><a-spin /><span>正在读取目录…</span></div>
            <a-button v-if="importNextOffset !== null" class="import-more" block :loading="importLoading" :disabled="busy" @click="loadMoreImports">加载更多文档和目录</a-button>
            <a-empty v-if="!importLoading && !importError && !importItems.length && !importDirectories.length && importNextOffset === null" description="当前目录没有可导入的文档" />
          </div>
        </section>
      </div>
      <template #footer><div class="import-footer"><span>已选 <strong>{{ selectedImportPaths.length }}</strong> 个文档</span><div><a-button :disabled="busy" @click="importOpen = false">取消</a-button><a-button type="primary" :disabled="!selectedImportPaths.length || importLoading || Boolean(importError)" :loading="busy" @click="importSelected">导入选中的 {{ selectedImportPaths.length }} 个文档</a-button></div></div></template>
    </a-modal>
  </div>
</template>

<style scoped>
.knowledge-page { position: relative; height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--app-bg); color: var(--app-text); }
.page-header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--app-divider); min-height: 42px; box-sizing: border-box; }
.node-count { font-size: 11px; color: var(--app-muted); }
.header-actions { min-width: 0; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding-block: 4px; }
.knowledge-search { display: flex; align-items: center; gap: 6px; min-width: 260px; max-width: 460px; flex: 1 1 320px; }
.knowledge-search :deep(.ant-input-search) { min-width: 0; flex: 1; }
.search-results-popover { position: absolute; z-index: 20; top: 60px; left: 50%; width: min(680px, calc(100% - 44px)); max-height: min(58vh, 520px); overflow: auto; transform: translateX(-50%); padding: 10px 12px; border: 1px solid var(--app-border); border-radius: 10px; background: var(--app-panel-bg); box-shadow: var(--app-shadow); }
.search-results-heading { display: flex; align-items: center; gap: 8px; padding: 2px 2px 8px; border-bottom: 1px solid var(--app-divider); font-size: 12px; }
.search-results-heading strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-results-heading span { color: var(--app-muted); font-size: 11px; }
.search-results-close { margin-left: auto; flex: 0 0 auto; padding: 2px 4px; border: 0; background: transparent; color: var(--app-muted); font: inherit; font-size: 11px; cursor: pointer; }
.search-results-close:hover { color: var(--app-accent); }
.search-results-error { margin: 10px 2px; color: var(--app-danger); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.search-result { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; width: 100%; padding: 10px 2px; border: 0; border-bottom: 1px solid var(--app-divider); background: transparent; color: var(--app-text); text-align: left; cursor: pointer; }
.search-result:hover { background: var(--app-sidebar-hover-bg); }
.search-result-main { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.search-result-main strong { font-size: 12px; }
.search-result-main small { color: var(--app-muted); font-size: 11px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-result-meta { flex: 0 0 auto; color: var(--app-muted); font-size: 10px; white-space: nowrap; }
.mobile-panels { display: none; }
.page-error { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 8px 22px; color: var(--app-danger); background: color-mix(in srgb, var(--app-danger) 7%, var(--app-bg)); font-size: 12px; overflow-wrap: anywhere; }
.page-error-content { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.page-error-diagnostics { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--app-muted); font-size: 11px; }
.layout { --tree-width: clamp(220px, 17vw, 260px); --assistant-width: clamp(360px, 31vw, 480px); flex: 1; min-height: 0; min-width: 0; display: grid; grid-template-columns: var(--tree-width) minmax(0, 1fr) var(--assistant-width); overflow: hidden; }
.layout.assistant-collapsed { --assistant-width: 40px; }
.layout--resizing { cursor: col-resize; user-select: none; }
.assistant-container { position: relative; display: flex; min-width: 0; min-height: 0; }
.tree, .assistant, .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.tree { background: var(--app-bg); border-right: 1px solid var(--app-divider); }
.assistant { flex: 1; border-left: 1px solid var(--app-divider); background: var(--app-bg); }
.assistant-collapsed > .assistant-container { display: none; }
.tree-head { flex: 0 0 auto; padding: 12px 12px 10px; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.panel-heading h2 { margin: 0; font-size: 14px; font-weight: 650; }
.panel-heading .ant-btn { flex-shrink: 0; }
.panel-heading .ant-btn:not(.ant-btn-primary) { color: var(--app-muted); }
.tree-head .panel-heading { gap: 6px; }
.tree-head h2 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-link.ant-btn { flex: 0 0 auto; margin: 0 10px 8px; text-align: left; color: var(--app-muted); }
.overview-link[aria-pressed="true"] { color: var(--app-accent); background: var(--app-sidebar-hover-bg); }
.tree-batch-actions { display: flex; flex: 0 0 auto; }
.tree-batch-button.ant-btn { min-width: 0; height: 26px; min-height: 26px; padding: 2px 7px; overflow: hidden; border-radius: 5px; font-size: 11px; line-height: 20px; }
.all-work-link { padding: 0; color: var(--app-muted); }
.tree footer { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 8px; border-top: 1px solid var(--app-divider); padding: 8px 12px; color: var(--app-muted); font-size: 12px; }
.tree footer > span { display: flex; align-items: center; gap: 5px; }
.legend-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--app-muted); }
.legend-dot.ready { background: var(--app-success); }
.legend-dot.generating { background: var(--app-accent); }
.legend-dot.draft { background: var(--app-warning); }
.collapsed-rail { border: 0; margin: 0; padding: 14px 8px; height: 100%; min-width: 0; writing-mode: vertical-rl; text-align: start; letter-spacing: 2px; background: var(--app-sidebar-bg); color: var(--app-muted); cursor: pointer; }
.collapsed-rail:hover { background: var(--app-sidebar-hover-bg); color: var(--app-accent); }
.assistant-rail { border-left: 1px solid var(--app-divider); }
.main { background: var(--app-bg); }
.task-summary, .updates-summary { display: flex; flex: 0 0 auto; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 6px 12px; border-bottom: 1px solid var(--app-divider); font-size: 12px; }
.task-summary > div { display: flex; flex: 1; flex-wrap: wrap; gap: 8px; }.task-summary span { color: var(--app-muted); }
.updates-summary > span { flex: 1; }.updates-summary { background: color-mix(in srgb, var(--app-warning) 5%, var(--app-bg)); }
.reading-layout { flex: 1 1 0; display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; min-width: 0; overflow: hidden; }
.reading-document { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
.node-loading { display: flex; flex: 1 1 0; min-height: 0; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--app-muted); font-size: 12px; }
.file-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.reference-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 8px; font-size: 12px; }
.reference-status code { min-width: 0; overflow-wrap: anywhere; }
.reference-status span { color: var(--app-muted); }
.search-hit-preview { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
.page-nav { display: flex; align-items: center; align-self: stretch; gap: 24px; flex: 0 0 auto; min-width: 0; background: var(--app-bg); }
.main-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 8px 16px; border-bottom: 1px solid var(--app-divider); flex: 0 0 auto; min-width: 0; }
.document-title { display: flex; flex: 1; align-items: center; gap: 8px; min-width: 160px; }
.document-title h2 { margin: 0; min-width: 0; font-size: 16px; line-height: 1.5; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-title small { min-width: 0; color: var(--app-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-title .ant-tag { flex-shrink: 0; }
.content { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 12px 16px; }
.editing-content { display: flex; flex-direction: column; overflow: hidden; }
.content.document-loading { display: flex; flex-direction: column; }
.document { width: 100%; max-width: none; min-width: 0; overflow-wrap: anywhere; }
.document.document-editing { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }
.document-editor { flex: 1; min-height: 0; resize: none; }
.revision-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 8px; font-size: 12px; }
.revision-bar label { display: flex; align-items: center; flex: 1 1 180px; gap: 8px; min-width: 0; }
.revision-bar label > span { flex-shrink: 0; color: var(--app-muted); }
.revision-bar select { box-sizing: border-box; min-width: 0; max-width: 100%; flex: 1; padding: 6px 8px; border: 1px solid var(--app-border); border-radius: 6px; color: var(--app-text); background: var(--app-bg); }
.revision-review-status { color: var(--app-muted); }
.draft-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px; margin-bottom: 20px; border: 1px solid color-mix(in srgb, var(--app-warning) 25%, var(--app-border)); background: color-mix(in srgb, var(--app-warning) 6%, var(--app-bg)); border-radius: 8px; font-size: 12px; }
.draft-banner > div { flex: 1; min-width: 160px; }
.draft-banner p { margin: 5px 0 0; color: var(--app-muted); }
.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--app-muted); text-align: center; min-width: 0; }
.page-empty { flex: 1; min-height: 0; overflow: auto; padding: 32px; justify-content: safe center; }
.result-empty { flex: 1; min-height: 0; overflow: auto; padding: 48px 28px; justify-content: safe center; }
.page-empty > * { flex-shrink: 0; }
.node-empty { padding: 54px 12px; }
.empty-symbol { display: grid; place-items: center; width: 50px; height: 50px; border: 1px solid var(--app-border); background: var(--app-panel-bg); border-radius: 14px; color: var(--app-accent); font-size: 26px; margin-bottom: 6px; }
.empty h2, .empty h3 { margin: 0; color: var(--app-text); font-size: 20px; font-weight: 600; }
.empty h3 { font-size: 17px; }
.empty p { margin: 0 0 8px; max-width: 390px; font-size: 13px; line-height: 1.8; }
.empty-steps { display: flex; flex-wrap: wrap; justify-content: center; gap: 16px; margin-top: 24px; font-size: 11px; }
.quick-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.source { border-bottom: 1px solid var(--app-divider); padding: 14px 0; overflow-wrap: anywhere; }
.source code { font-size: 12px; }
.source p, .source small { color: var(--app-muted); font-size: 12px; margin: 5px 0 0; }
.assistant-head { flex: 0 0 auto; padding: 6px 12px; border-bottom: 1px solid var(--app-divider); min-width: 0; }
.assistant-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.assistant-title h2 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-scope { min-width: 0; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--app-muted); font-size: 10px; }
.scope-notice, .binding-error { padding: 10px 16px; background: color-mix(in srgb, var(--app-warning) 7%, var(--app-bg)); color: var(--app-muted); font-size: 12px; overflow-wrap: anywhere; line-height: 1.6; }
.binding-error { color: var(--app-danger); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.conversation-start--loading { align-items: center; justify-content: center; gap: 8px; color: var(--app-muted); font-size: 12px; }
.progress-row { display: flex; align-items: center; gap: 12px; margin-top: 9px; min-width: 0; }
.progress-row > span { flex: 0 0 auto; font-size: 10px; color: var(--app-muted); }
.run-progress { flex: 1; min-width: 0; height: 3px; border-radius: 4px; background: var(--app-border); overflow: hidden; }
.run-progress i { display: block; height: 100%; background: var(--app-accent); transition: width .2s ease; }
.assistant-body { flex: 1; min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.assistant-body :deep(.chat-panel), .assistant-body :deep(.chat-panel__body), .assistant-body :deep(.chat-panel__messages), .assistant-body :deep(.chat-panel__composer) { min-width: 0; }
.assistant-body :deep(.chat-panel__messages) { padding-inline: 14px; }
.assistant-body :deep(.chat-panel__composer) { padding-inline: 10px; }
.assistant-heading-actions { display: flex; gap: 6px; flex: 0 0 auto; }
.session-popover { width: min(300px, calc(100vw - 32px)); display: flex; flex-direction: column; gap: 10px; }
.session-popover-title { display: flex; flex-direction: column; gap: 3px; }
.session-popover-title span { color: var(--app-muted); font-size: 11px; overflow-wrap: anywhere; }
.session-popover-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.session-popover p { margin: 0; color: var(--app-muted); font-size: 11px; line-height: 1.6; }
.conversation-picker { width: 100%; min-width: 0; }
.task-controls { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 8px; }
.batch-explanation { color: var(--app-muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.batch-advanced > summary { cursor: pointer; color: var(--app-muted); font-size: 12px; padding-block: 8px; }
.batch-scroll { max-height: calc(100dvh - 180px); min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 3px; }
.batch-model-settings { padding-block: 8px; border-block: 1px solid var(--app-divider); margin-block: 8px; }
.batch-model-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 13px; color: var(--app-text); }
.batch-model-heading > span { color: var(--app-muted); font-size: 12px; }
.batch-engine-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--app-muted); font-size: 12px; }
.batch-engine-field select { box-sizing: border-box; width: min(240px, 100%); height: 36px; padding: 6px 10px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-bg); color: var(--app-text); font: inherit; font-size: 13px; }
.batch-engine-field select:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
.batch-engine-field select:disabled { opacity: .6; cursor: not-allowed; }
.batch-model-fields { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 10px; }
.batch-model-fields label { display: flex; flex-direction: column; gap: 7px; min-width: 0; color: var(--app-muted); font-size: 12px; }
.batch-model-fields select { box-sizing: border-box; width: 100%; min-width: 0; height: 36px; padding: 6px 10px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-bg); color: var(--app-text); font: inherit; font-size: 13px; text-overflow: ellipsis; }
.batch-model-fields select:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
.batch-model-fields select:disabled { opacity: .6; cursor: not-allowed; }
.review-auto-repair { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 14px; padding: 10px 12px; border: 1px solid var(--app-divider); border-radius: 7px; background: color-mix(in srgb, var(--app-muted) 3%, var(--app-bg)); }
.review-auto-repair > span { display: flex; flex-direction: column; gap: 3px; min-width: 0; color: var(--app-text); font-size: 12px; }
.review-auto-repair strong { font-weight: 600; }
.review-auto-repair small { color: var(--app-muted); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.batch-model-note { margin: 6px 0 0; font-size: 12px; color: var(--app-muted); line-height: 1.7; overflow-wrap: anywhere; }
.batch-settings { display: flex; flex-direction: column; gap: 8px; margin-block: 10px; }
.batch-settings > label { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.batch-settings select, .batch-settings input[type="number"] { box-sizing: border-box; min-width: 92px; width: 112px; height: 30px; padding: 4px 8px; border: 1px solid var(--app-border); border-radius: 6px; background: var(--app-bg); color: var(--app-text); font: inherit; font-size: 12px; }
.batch-settings input[type="number"]:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
.batch-settings input[type="number"]:disabled { opacity: .6; cursor: not-allowed; }
.batch-preview { height: 190px; overflow: auto; border: 1px solid var(--app-divider); border-radius: 6px; padding: 10px; margin-bottom: 14px; }
.batch-preview > div, .batch-preview > label { display: flex; align-items: flex-start; gap: 8px; padding: 5px; overflow-wrap: anywhere; font-size: 12px; }
.batch-submit { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.conversation-start { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 24px; display: flex; flex-direction: column; }
.conversation-welcome { flex: 0 0 auto; width: 100%; max-width: 360px; margin: auto; display: flex; flex-direction: column; align-items: center; gap: 22px; text-align: center; }
.conversation-intro { width: 100%; min-width: 0; }
.conversation-intro > span { display: block; font-size: 30px; line-height: 1; color: var(--app-accent); }
.conversation-intro h3 { margin: 18px 0 10px; font-size: 18px; font-weight: 600; }
.conversation-intro p { margin: 0; font-size: 13px; color: var(--app-muted); line-height: 1.8; }
.conversation-start-form { width: 100%; display: flex; flex-direction: column; gap: 14px; text-align: left; }
.start-label { display: block; margin-bottom: 9px; color: var(--app-muted); font-size: 11px; }
.scope-description { margin: 8px 0 0; min-height: 18px; color: var(--app-muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.conversation-history { padding-top: 16px; margin-top: 4px; border-top: 1px solid var(--app-divider); }
.recent-conversation { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.recent-conversation > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--app-muted); }
.recent-conversation .ant-btn { flex-shrink: 0; color: var(--app-accent); font-size: 11px; }
.history-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
.history-heading .start-label { margin: 0; }
.history-heading select { max-width: 50%; border: 1px solid var(--app-border); border-radius: 5px; background: var(--app-bg); color: var(--app-muted); font-size: 11px; padding: 3px 6px; }
.conversation-option { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-block: 3px; }
.conversation-option strong { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.conversation-option small { font-size: 10px; color: var(--app-muted); white-space: normal; overflow-wrap: anywhere; }
.conversation-connect { width: 100%; display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 10px; }
.conversation-connect .ant-select { width: 105px; text-align: left; }
.conversation-connect > .ant-btn { flex: 1; }
.conversation-welcome .read-only-note { margin: 0; }
.read-only-note { font-size: 12px; line-height: 1.8; color: var(--app-muted); }
.import-layout { height: min(560px, calc(100dvh - 184px)); display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; min-height: 0; }
.import-settings { display: flex; flex-direction: column; gap: 20px; overflow: auto; min-height: 0; padding-right: 20px; border-right: 1px solid var(--app-divider); }
.import-layout h3 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
.import-categories { display: flex; flex-direction: column; gap: 12px; }
.import-hint, .import-description { margin: 10px 0 0; font-size: 12px; line-height: 1.7; color: var(--app-muted); overflow-wrap: anywhere; }
.import-description { margin: auto 0 0; }
.import-destination { display: flex; flex-direction: column; gap: 6px; padding: 12px; border: 1px solid var(--app-divider); border-radius: 8px; overflow-wrap: anywhere; }
.import-destination > span { font-size: 12px; color: var(--app-muted); }.import-destination strong { font-size: 13px; font-weight: 500; }
.import-browser { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.import-browser-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.import-browser-heading h3 { margin: 0; }
.import-browser > .import-hint { margin: 8px 0 16px; }
.import-path { display: flex; gap: 8px; margin-bottom: 10px; }.import-path > .ant-input { min-width: 0; }
.import-nav { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11px; color: var(--app-muted); margin-bottom: 10px; }
.import-nav code { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.import-scroll { flex: 1 1 0; min-height: 0; overflow: auto; border: 1px solid var(--app-divider); border-radius: 8px; }
.import-scroll > .ant-alert { margin: 10px; }.import-scroll > .ant-empty { margin: 40px 12px; }
.import-folder { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px; border: 0; border-bottom: 1px solid var(--app-divider); background: none; color: var(--app-text); text-align: left; cursor: pointer; }
.import-folder > span:not(.anticon) { flex: 1; min-width: 0; overflow-wrap: anywhere; }.import-folder > .anticon:first-child { color: var(--app-muted); }.import-folder > .anticon:last-child { color: var(--app-muted); font-size: 10px; }
.import-folder:hover, .import-row:hover { background: var(--app-sidebar-hover-bg); }.import-folder:disabled { cursor: default; opacity: .5; }
.import-row { padding: 12px; border-bottom: 1px solid var(--app-divider); }.import-row.is-selected { background: var(--app-sidebar-active-bg); }
.import-row :deep(.ant-checkbox-wrapper) { display: flex; align-items: center; min-width: 0; }
.import-row :deep(.ant-checkbox-wrapper > span:last-child) { flex: 1; min-width: 0; }
.import-file { display: flex; align-items: center; gap: 10px; }.import-file > .anticon { color: var(--app-muted); }.import-file > span:last-child { min-width: 0; }
.import-file strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }.import-file small { display: block; color: var(--app-muted); font-size: 11px; overflow-wrap: anywhere; margin-top: 3px; }
.import-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 32px 12px; color: var(--app-muted); font-size: 12px; }
.import-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 14px; border-top: 1px solid var(--app-divider); }.import-footer > span { color: var(--app-muted); font-size: 12px; }.import-footer > div { display: flex; gap: 8px; }
:global(.knowledge-import-modal .ant-modal-content) { padding: 20px; }
:global(.knowledge-import-modal .ant-modal-close) { top: 16px; right: 16px; }
@media (max-width: 720px) {
  .import-layout { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
  .import-settings { flex: 0 0 auto; padding: 0 0 12px; border-right: 0; border-bottom: 1px solid var(--app-divider); gap: 12px; overflow: visible; }
  .import-categories { flex-direction: row; flex-wrap: wrap; gap: 8px; }.import-layout h3 { margin-bottom: 8px; }
  .import-settings .import-hint { margin-top: 6px; }.import-destination { flex-direction: row; padding: 8px 10px; gap: 8px; }.import-description { display: none; }
  .import-browser { flex: 1 0 auto; }.import-browser > .import-hint { margin-bottom: 10px; }
  .import-scroll { flex: 0 0 auto; min-height: 160px; overflow: visible; }
  .import-footer { flex-wrap: wrap; gap: 8px; }.import-footer > div { margin-left: auto; }
}
@media (max-width: 1200px) {
  .layout { --tree-width: 200px; --assistant-width: 370px; }
  .layout.assistant-collapsed { --assistant-width: 40px; }
  .main-nav, .main-head, .content { padding-inline: 16px; }
}
@media (max-width: 1100px) {
  .layout { grid-template-columns: minmax(0, 1fr); position: relative; }
  .tree, .assistant-container { display: none; position: absolute; top: 0; bottom: 0; z-index: 5; width: min(440px, 100%); box-shadow: var(--app-shadow); }
  .tree { left: 0; }
  .assistant-container { right: 0; }
  .tree.open, .assistant-container.open { display: flex; }
  .collapsed-rail { display: none; }
  .panel-backdrop { position: absolute; inset: 0; z-index: 4; border: 0; background: color-mix(in srgb, var(--app-text) 15%, transparent); }
  .mobile-panels { display: flex; flex: 0 0 auto; padding: 2px 12px; gap: 8px; border-bottom: 1px solid var(--app-divider); }
  .mobile-panels button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 6px 10px; background: transparent; color: var(--app-muted); border: 0; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .mobile-panels button[aria-expanded="true"] { color: var(--app-accent); background: color-mix(in srgb, var(--app-accent) 8%, transparent); }
  .mobile-panels button span { font-size: 10px; }
  .working-indicator { width: 5px; height: 5px; border-radius: 50%; background: var(--app-accent); }
  .page-header { padding: 0 16px; gap: 10px; }
  .knowledge-search { min-width: 220px; }
}
@media (max-width: 560px) {
  .batch-model-fields { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .page-header { display: grid; grid-template-columns: minmax(0, 110px) minmax(0, 1fr); gap: 6px 8px; padding: 6px 12px; }
  .header-actions { grid-column: 1 / -1; padding: 0; justify-content: flex-end; }
  .page-nav { min-width: 0; }
  .page-nav .ant-tag { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .knowledge-search { grid-column: 2; grid-row: 1; width: 100%; max-width: none; min-width: 0; }
  .search-results-popover { top: 72px; width: calc(100% - 24px); }
  .conversation-start { padding: 24px; }
  .main-nav, .main-head, .content { padding-inline: 12px; }
  .page-empty { padding: 24px; }
  .page-empty h2 { font-size: 18px; }
}
@media (max-height: 560px) {
  .assistant.active-conversation { overflow-y: auto; }
  .assistant.active-conversation .assistant-body { flex: 1 0 260px; }
}
</style>
