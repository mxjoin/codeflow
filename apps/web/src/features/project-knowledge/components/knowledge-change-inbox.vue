<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { KnowledgeChangeSummary, KnowledgeChangeDetail, KnowledgePendingChangeNode } from "@codeflowai/shared";
import { message } from "ant-design-vue";
import { requestKnowledgeAsset } from "../../../api/projectKnowledge";
import { createApiResultError, type ApiRequestContext } from "../../../api/request";
import MarkdownContent from "../../markdown/MarkdownContent.vue";
import DiffViewer from "../../chat/components/diff-viewer.vue";

const props = defineProps<{ workspaceId: string; canWrite: boolean; context: ApiRequestContext; embedded?: boolean; changeId?: string | null; nodeId?: string | null; nodeTitle?: string }>();
const emit = defineEmits<{ changed: []; index: [nodes: KnowledgePendingChangeNode[]]; loading: [value: boolean]; recheck: [change: KnowledgeChangeDetail]; selected: [change: { id: string; nodeId: string; hash: string; stale: boolean; reason: string }] }>();
const items = ref<KnowledgeChangeSummary[]>([]);
const detail = ref<KnowledgeChangeDetail | null>(null);
const selectedId = ref<string | null>(null);
const loading = ref(false), reading = ref(false), busy = ref(false);
const error = ref(""), note = ref("");
const nextOffset = ref<number | null>(null);
const filter = ref("pending");
const comparisonMode = ref<"diff" | "document">("diff");
const diffShowUnchanged = ref(false);
const diffInline = ref(false);
const diffViewerRef = ref<InstanceType<typeof DiffViewer> | null>(null);
let epoch = 0, readEpoch = 0;
let controller = new AbortController();
let ready: Promise<void> = Promise.resolve();
const labels = { pending: "待审批", approved: "已采用", rejected: "已拒绝" };
const options = computed(() => detail.value && !items.value.some(item => item.id === detail.value?.id) ? [detail.value, ...items.value] : items.value);
/** 审核边界保留建议、节点和请求标识，失败明确留在当前内容。 */
function failed(cause: unknown, code: string): void {
  error.value = cause instanceof Error ? cause.message : "读取知识修改建议失败";
  console.error("[knowledge-approval]", { code, workspaceId: props.workspaceId, changeId: selectedId.value, nodeId: detail.value?.nodeId ?? props.nodeId,
    requestId: cause && typeof cause === "object" && "requestId" in cause ? cause.requestId : null, rootCause: error.value });
}
async function load(more = false): Promise<void> {
  const current = epoch, scope = props.workspaceId;
  if (!scope || loading.value) return;
  loading.value = true; emit("loading", true); error.value = "";
  try {
    const result = await requestKnowledgeAsset(props.context, "changes", { workspaceId: scope, offset: more ? nextOffset.value ?? 0 : 0, status: filter.value, ...(props.nodeId ? { nodeId: props.nodeId } : {}) }, { signal: controller.signal });
    if (epoch !== current) return;
    if (!result.ok) throw createApiResultError(result);
    items.value = more ? [...new Map([...items.value, ...result.data.items].map(item => [item.id, item])).values()] : result.data.items;
    nextOffset.value = result.data.nextOffset;
    emit("index", result.data.pendingNodes);
    if (!selectedId.value && items.value[0]) void select(items.value[0].id);
  } catch (cause) { if (epoch === current && !controller.signal.aborted) failed(cause, "KNOWLEDGE_CHANGES_READ_FAILED"); }
  finally { if (epoch === current) { loading.value = false; emit("loading", false); } }
}
async function select(id: string): Promise<void> {
  if (!id || selectedId.value === id && (reading.value || detail.value?.id === id)) return;
  const current = epoch, ticket = ++readEpoch;
  selectedId.value = id; detail.value = null; reading.value = true; note.value = ""; error.value = "";
  comparisonMode.value = "diff";
  diffShowUnchanged.value = false;
  diffInline.value = false;
  try {
    const result = await requestKnowledgeAsset(props.context, "change", { workspaceId: props.workspaceId, changeId: id }, { signal: controller.signal });
    if (epoch !== current || ticket !== readEpoch) return;
    if (!result.ok) throw createApiResultError(result);
    detail.value = result.data;
    emit("selected", { id: result.data.id, nodeId: result.data.nodeId, hash: result.data.hash, stale: result.data.stale, reason: result.data.staleReasons.join('；') });
  } catch (cause) { if (epoch === current && ticket === readEpoch && !controller.signal.aborted) failed(cause, "KNOWLEDGE_CHANGE_READ_FAILED"); }
  finally { if (epoch === current && ticket === readEpoch) reading.value = false; }
}
/** 单篇和集中确认共用审核入口，返回真实结果供集中处理失败即停止。 */
async function review(decision: "approve" | "reject"): Promise<boolean> {
  if (!detail.value || busy.value || !props.canWrite) return false;
  const current = epoch, proposal = detail.value, scope = props.workspaceId;
  busy.value = true; error.value = "";
  try {
    const result = await requestKnowledgeAsset(props.context, "change.review", { workspaceId: scope, changeId: proposal.id, expectedHash: proposal.hash, decision, note: note.value }, { method: "POST" });
    if (epoch !== current) return false;
    if (!result.ok) throw createApiResultError(result);
    if (selectedId.value === proposal.id) detail.value = result.data;
    emit("changed");
    message.success(decision === "approve" ? "知识修改已批准并采用" : "已拒绝，正式文档保持不变");
    if (!props.embedded) await load();
    return true;
  } catch (cause) { if (epoch === current) failed(cause, "KNOWLEDGE_CHANGE_REVIEW_FAILED"); }
  finally { if (epoch === current) busy.value = false; }
  return false;
}

/** 只审核用户实际预览的建议指纹，拒绝在等待加载期间替换正文。 */
async function confirm(decision: "approve" | "reject", expectedHash: string): Promise<void> {
  await ready;
  if (!detail.value || detail.value.id !== props.changeId || detail.value.hash !== expectedHash) throw new Error("建议内容已变化，请重新查看更新");
  if (!await review(decision)) throw new Error(error.value || "建议审核未完成");
}
/** 在差异视图中定位上一处或下一处修改，保持审批人留在当前对比上下文。 */
function goToDiff(direction: "previous" | "next"): void {
  if (direction === "previous") diffViewerRef.value?.goToPrevDiff();
  else diffViewerRef.value?.goToNextDiff();
}
watch(() => [props.workspaceId, props.nodeId, filter.value] as const, (value, previous) => {
  epoch++; readEpoch++; controller.abort(); controller = new AbortController();
  items.value = []; detail.value = null; selectedId.value = null;
  loading.value = false; busy.value = false; reading.value = false; nextOffset.value = null;
  if (!previous || value[0] !== previous[0]) { emit("index", []); if (props.changeId) ready = select(props.changeId); }
  if (!props.embedded) void load();
}, { immediate: true });
watch(() => props.changeId, id => { if (id) ready = select(id); });
onBeforeUnmount(() => { epoch++; controller.abort(); emit("loading", false); });
defineExpose({ confirm });
</script>

<template>
  <section class="change-inbox" data-testid="knowledge-change-inbox">
    <div v-if="!embedded" class="change-toolbar">
      <strong :title="nodeTitle || '全部修改建议'">{{ nodeTitle || '全部修改建议' }}</strong>
      <select v-model="filter" aria-label="筛选审批状态"><option value="pending">待审批</option><option value="all">全部记录</option><option value="approved">已采用</option><option value="rejected">已拒绝</option></select>
    </div>
    <div v-if="!embedded && options.length" class="change-picker">
      <label for="knowledge-change-choice">修改建议</label>
      <select id="knowledge-change-choice" aria-label="选择修改建议" :value="selectedId ?? ''" @change="select(($event.target as HTMLSelectElement).value)">
        <option v-for="item in options" :key="item.id" :value="item.id">{{ item.title }} · {{ labels[item.status] }} · {{ item.createdAt.replace('T', ' ').slice(0, 16) }} · {{ item.summary }}</option>
      </select>
      <a-button v-if="nextOffset !== null" size="small" :loading="loading" @click="load(true)">加载更多建议</a-button>
    </div>
    <div v-if="error" class="inbox-error" role="alert">{{ error }}</div>
    <section class="change-detail">
      <div v-if="reading || loading && !detail" class="inbox-empty" role="status"><a-spin /><p>正在读取修改建议…</p></div>
      <template v-else-if="detail">
        <div v-if="detail.stale && detail.status === 'pending'" class="stale-warning">依据已变化，无法直接批准：{{ detail.staleReasons.join('；') }}。<a-button size="small" :disabled="!canWrite || busy" @click="emit('recheck', detail)">对照最新正文重新整理</a-button></div>
        <div class="comparison-toolbar">
          <div class="detail-heading" :title="`${detail.origin === 'workflow' ? '流程会话' : '普通会话'}提出 · ${detail.createdAt.replace('T', ' ').slice(0, 16)}`"><h2>{{ detail.title }}</h2><p :title="detail.summary">{{ detail.summary }}</p></div>
          <div class="comparison-actions">
            <a-button size="small" :type="comparisonMode === 'diff' ? 'primary' : 'default'" @click="comparisonMode = 'diff'">变更对比</a-button>
            <a-button size="small" :type="comparisonMode === 'document' ? 'primary' : 'default'" @click="comparisonMode = 'document'">完整文档</a-button>
            <a-dropdown v-if="comparisonMode === 'diff'" :trigger="['click']"><a-button size="small">对比设置</a-button><template #overlay><a-menu>
              <a-menu-item data-testid="knowledge-diff-toggle-lines" @click="diffShowUnchanged = !diffShowUnchanged">{{ diffShowUnchanged ? '仅看变更' : '显示全文对比' }}</a-menu-item>
              <a-menu-item data-testid="knowledge-diff-toggle-layout" @click="diffInline = !diffInline">{{ diffInline ? '并排对比' : '内联对比' }}</a-menu-item>
              <a-menu-item aria-label="上一处差异" @click="goToDiff('previous')">上一处</a-menu-item>
              <a-menu-item aria-label="下一处差异" @click="goToDiff('next')">下一处</a-menu-item>
            </a-menu></template></a-dropdown>
          </div>
        </div>
        <div v-if="comparisonMode === 'diff'" class="comparison-diff" data-testid="knowledge-change-diff">
          <DiffViewer ref="diffViewerRef" :original="detail.baseContent" :modified="detail.content" file-path="knowledge-asset.md" :inline="diffInline" :hide-unchanged="!diffShowUnchanged" />
        </div>
        <div v-else class="comparison">
          <section><h4>{{ detail.status === 'approved' ? '修改前' : '提交时的正式文档' }}</h4><div class="comparison-scroll"><MarkdownContent v-if="detail.baseContent" :text="detail.baseContent" :workspace-id="workspaceId" /><p v-else class="muted">此知识原本没有正文</p></div></section>
          <section><h4>建议修改后</h4><div class="comparison-scroll"><MarkdownContent :text="detail.content" :workspace-id="workspaceId" /></div></section>
        </div>
        <details class="source-details"><summary>来源依据 · {{ detail.sources.length }} 项</summary><p v-for="(source, index) in detail.sources" :key="index"><code>{{ source.path || '已确认需求' }}</code><br>{{ source.relation }}<span v-if="source.requirement">：{{ source.requirement }}</span></p></details>
        <footer v-if="!embedded && detail.status === 'pending'"><a-input v-model:value="note" placeholder="审核意见（可选）" aria-label="审核意见" :maxlength="4000" /><div><a-button :disabled="!canWrite || busy" @click="review('reject')">拒绝修改</a-button><a-button type="primary" :disabled="!canWrite || busy || detail.stale" @click="review('approve')">批准并采用</a-button></div></footer>
        <footer v-else-if="detail.status !== 'pending'"><span>{{ labels[detail.status] }} · {{ detail.reviewedAt?.replace('T', ' ').slice(0, 16) }} {{ detail.reviewNote }}</span></footer>
      </template>
      <div v-else class="inbox-empty"><h2>{{ filter === 'pending' ? '暂无待审批的修改' : '暂无符合条件的修改记录' }}</h2><p>从左侧选择知识查看建议，批准后才会更新正式知识。</p></div>
    </section>
  </section>
</template>

<style scoped>
.change-inbox { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.change-toolbar, .change-picker { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--app-divider); min-width: 0; font-size: 12px; }
.change-toolbar strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
select { min-width: 0; padding: 6px 8px; border: 1px solid var(--app-border); background: var(--app-bg); color: var(--app-text); border-radius: 6px; }
.change-picker label { color: var(--app-muted); flex-shrink: 0; } .change-picker select { flex: 1; width: 0; }
.change-detail { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.detail-heading { flex: 1; min-width: 0; }
h2 { margin: 0; font-size: 14px; } .detail-heading h2, .detail-heading p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-heading p { margin: 2px 0 0; color: var(--app-muted); font-size: 11px; line-height: 1.5; }
.comparison-toolbar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 6px 12px; border-bottom: 1px solid var(--app-divider); min-width: 0; }
.comparison-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.comparison-diff { flex: 1; min-height: 0; min-width: 0; overflow: hidden; background: var(--app-bg); }
.comparison-diff :deep(.diff-viewer) { height: 100%; min-height: 0; }
.comparison { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; }
.comparison > section { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--app-divider); }
.comparison h4 { flex-shrink: 0; padding: 6px 12px; margin: 0; font-size: 12px; background: var(--app-panel-bg); color: var(--app-muted); }
.comparison-scroll { flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; overflow-wrap: anywhere; font-size: 12px; }
.source-details { flex: 0 0 auto; max-height: 22%; overflow: auto; border-top: 1px solid var(--app-divider); padding: 6px 12px; color: var(--app-muted); font-size: 11px; }
.source-details p { margin: 8px 0 0; line-height: 1.55; overflow-wrap: anywhere; }
summary { cursor: pointer; }
footer { flex-shrink: 0; display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--app-divider); align-items: center; font-size: 12px; }
footer > .ant-input { flex: 1; min-width: 0; } footer > div { display: flex; gap: 8px; flex-shrink: 0; }
.inbox-empty { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 24px; text-align: center; color: var(--app-muted); font-size: 12px; }
.inbox-error, .stale-warning { padding: 10px 20px; color: var(--app-danger); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; background: color-mix(in srgb, var(--app-danger) 6%, var(--app-bg)); }
.muted { color: var(--app-muted); }
@media (max-width: 560px) {
 .comparison-toolbar { flex-wrap: wrap; }
 .detail-heading { flex-basis: 100%; }
 .comparison-actions { width: 100%; justify-content: flex-start; }
 .comparison { grid-template-columns: minmax(0, 1fr); grid-template-rows: repeat(2, minmax(0, 1fr)); }
 footer { flex-wrap: wrap; } footer > .ant-input { flex-basis: 100%; } footer > div { margin-left: auto; }
}
</style>
