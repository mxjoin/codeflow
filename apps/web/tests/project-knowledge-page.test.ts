import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const apiSource = readFileSync(new URL("../src/api/projectKnowledge/index.ts", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../src/router/index.ts", import.meta.url), "utf8");
const topbarSource = readFileSync(
  new URL("../src/components/app-shell/app-topbar.vue", import.meta.url),
  "utf8",
);
const pageSource = readFileSync(
  new URL("../src/features/project-knowledge/components/project-knowledge-page.vue", import.meta.url),
  "utf8",
);
const reviewReportSource = readFileSync(
  new URL("../src/features/project-knowledge/components/knowledge-review-report.vue", import.meta.url),
  "utf8",
);
const changeInboxSource = readFileSync(
  new URL("../src/features/project-knowledge/components/knowledge-change-inbox.vue", import.meta.url),
  "utf8",
);
const buildPreviewSource = readFileSync(
  new URL("../src/features/project-knowledge/components/knowledge-build-preview.vue", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../src/features/composer/components/chat-composer.vue", import.meta.url),
  "utf8",
);

// 页面布局、交互和会话绑定由 project-knowledge.spec.ts 的真实 DOM 回归覆盖。

test("项目知识 API 只允许 GET 读取和 POST 写入，并使用共享响应契约", () => {
  assert.match(apiSource, /method === "GET"/u);
  assert.match(apiSource, /method === "POST"/u);
  assert.match(apiSource, /KnowledgeAssetResponses/u);
  assert.match(apiSource, /\/api\/knowledge\/assets\/\$\{encodeURIComponent\(action\)\}/u);
});

test("项目知识 GET 请求不会把空范围序列化成 null 节点", () => {
  assert.match(apiSource, /value === undefined \|\| \(method === "GET" && value === null\)/u);
});

test("知识库页面搜索包含待采用文档，并能取消迟到结果", () => {
  assert.match(pageSource, /includeDrafts: true/u);
  assert.match(pageSource, /function closeSearchResults\(\)/u);
  assert.match(pageSource, /searchRequestEpoch/u);
  assert.match(pageSource, /class="search-results-close" @click\.stop="closeSearchResults"/u);
  assert.match(pageSource, /function selectTreeNode\(id: string\): void \{\s*closeSearchResults\(\)/u);
});

test("项目知识页面继续作为统一工作区入口开放", () => {
  assert.match(routerSource, /path: "\/knowledge"/u);
  assert.match(routerSource, /name: "project-knowledge"/u);
  assert.match(routerSource, /mainView: "knowledge"/u);
  assert.match(topbarSource, /规格库/u);
});

test("批量生成提供并发配置，页面保留状态并按需刷新", () => {
  assert.match(pageSource, /批次并发数/u);
  assert.match(pageSource, /type="number" min="1" :max="MAX_BATCH_CONCURRENCY"/u);
  assert.doesNotMatch(pageSource, /batchConcurrencyOptions/u);
  assert.match(pageSource, /knowledge-page-state/u);
  assert.match(pageSource, /const KNOWLEDGE_RUN_POLL_INTERVAL_MS = 5000;/u);
  assert.match(pageSource, /document\.visibilityState !== "visible"/u);
  assert.match(pageSource, /async function stopGeneration/u);
});

test("常用操作收敛到顶部，左树仍复用多选生成状态", () => {
  assert.match(pageSource, /@click="openSpecificationConversation">规格对话/u);
  assert.match(pageSource, /@click="openUpdates\(null\)">待确认更新/u);
  assert.match(pageSource, />完善规格<\/a-button>/u);
  assert.match(pageSource, /data-testid="tree-batch-actions"/u);
  assert.match(pageSource, /生成选中 \$\{checkedIds\.length\} 项/u);
  assert.match(pageSource, /startBuild\(checkedIds.length \? checkedIds/u);
  assert.match(pageSource, /KnowledgeUpdates/u);
  assert.doesNotMatch(pageSource, /revision\.adopt\.batch/u);
  assert.match(pageSource, /selectionResetKey/u);
});

test("批量生成允许独立选择执行引擎，并在切换时清理模型配置", () => {
  assert.match(pageSource, /aria-label="批量生成引擎"/u);
  assert.match(pageSource, /changeBatchEngineEvent/u);
  assert.match(pageSource, /batchEngine\.value = value as EngineType/u);
  assert.match(pageSource, /引擎、模型和思考强度只作用于本次批量任务/u);
});

test("复检支持配置最大轮次和发现问题后的自动修订", () => {
  assert.match(pageSource, /aria-label="最大复检轮次"/u);
  assert.match(pageSource, /aria-label="发现问题后自动修订"/u);
  assert.match(pageSource, /autoRepair: batchReviewAutoRepair\.value/u);
});

test("知识会话摘要进入主会话列表，页面恢复期间不会把目录状态写成空值", () => {
  assert.match(pageSource, /upsertKnowledgeThreadSummary/u);
  assert.match(pageSource, /hydratingPageState = true/u);
  assert.match(pageSource, /hydratingPageState = false/u);
  assert.match(pageSource, /treeStorageKey/u);
  assert.match(pageSource, /!snapshot\.value/u);
  assert.match(pageSource, /const treeProjectionReady = computed/u);
  assert.doesNotMatch(pageSource, /knowledge-tree-snapshot/u);
  assert.doesNotMatch(pageSource, /readCachedTreeSnapshot|persistTreeSnapshot/u);
});

test("刷新恢复任务只补齐后台状态，不把已选资产切换成生成结果", () => {
  assert.match(pageSource, /receiveRun\(initialRun\)/u);
  assert.match(pageSource, /receiveReviews\(runList\)/u);
  assert.match(pageSource, /const treeProjectionReady = computed/u);
  assert.match(pageSource, /const treeLoading = computed/u);
  assert.match(pageSource, /taskList\.value\.length > 0 \|\| visibleTreeNodes\.value\.length > 0/u);
  assert.doesNotMatch(pageSource, /autoOpen/u);
  assert.doesNotMatch(pageSource, /aria-label="知识库主视图"/u);
  assert.doesNotMatch(pageSource, /<div v-if="reviewRun" class="result-nav">/u);
});

test("文件会话映射到右侧，历史复检仍可打开", () => {
  assert.match(pageSource, /openExecutionSession/u);
  assert.doesNotMatch(pageSource, /knowledge-execution-drawer/u);
  assert.match(pageSource, /knowledgeDocumentSession/u);
  assert.match(pageSource, /知识工作会话/u);
  assert.doesNotMatch(pageSource, /:composer-disabled="true"/u);
});

test("打开旧资产执行会话会按任务快照修复模型偏好", () => {
  assert.match(pageSource, /updateThreadPrefs/u);
  assert.match(pageSource, /KNOWLEDGE_EXECUTION_SESSION_READ_FAILED/u);
  assert.match(pageSource, /expectedPrefs = \{/u);
  assert.match(pageSource, /model: knownConfig\.model/u);
});

test("复检问题可以把报告带回资产工作会话", () => {
  assert.match(pageSource, /returnToGeneration/u);
  assert.match(reviewReportSource, /回知识工作会话修订/u);
  assert.match(pageSource, /复检报告发现以下问题/u);
});

test("复检问题支持一键修复，直接发送到对应工作会话并自动执行", () => {
  assert.match(reviewReportSource, /@click="emit\('repairIssue', report, issue\)">一键修复/u);
  assert.match(pageSource, /async function repairIssue\(report: KnowledgeReviewReportView, issue: KnowledgeReviewIssue\)/u);
  assert.match(pageSource, /kind: "send-text"/u);
  assert.match(composerSource, /async function sendExternalText\(value: string\): Promise<boolean>/u);
  assert.match(composerSource, /sendExternalText,/u);
  assert.match(buildPreviewSource, /@repair-issue="\(report, issue\) => emit\('repairIssue', report, issue\)"/u);
});

test("重新复检只避开正被处理的知识，不被其他活动任务阻塞", () => {
  assert.match(pageSource, /const activelyProcessedNodeIds = computed/u);
  assert.match(pageSource, /batchMode\.value === "review" && batchTargets\.value\.some/u);
  assert.match(reviewReportSource, /const restartDisabled = computed\(\(\) => props\.restartBusy \?\? props\.busy\)/u);
  assert.match(buildPreviewSource, /const restartReviewBusy = computed/u);
});

test("知识修改审批默认展示真实差异，并保留完整文档视图", () => {
  assert.match(changeInboxSource, /import DiffViewer from "\.\.\/\.\.\/chat\/components\/diff-viewer\.vue"/u);
  assert.match(changeInboxSource, /const comparisonMode = ref<"diff" \| "document">\("diff"\)/u);
  assert.match(changeInboxSource, /data-testid="knowledge-change-diff"/u);
  assert.match(changeInboxSource, /comparisonMode === 'diff'.*变更对比/u);
  assert.match(changeInboxSource, /comparisonMode === 'document'.*完整文档/u);
  assert.match(changeInboxSource, /显示全文对比/u);
  assert.match(changeInboxSource, /diffInline = !diffInline/u);
  assert.match(changeInboxSource, /goToDiff\('previous'\)/u);
  assert.match(changeInboxSource, /goToDiff\('next'\)/u);
  assert.match(changeInboxSource, /detail\.baseContent.*detail\.content/u);
});
