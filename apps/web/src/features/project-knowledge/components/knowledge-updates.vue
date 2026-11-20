<script setup lang="ts">
import type { KnowledgeAssetNode, KnowledgeChangeDetail, KnowledgeChangeSummary, KnowledgeGenerationPreview, KnowledgeGenerationRunView, KnowledgeGenerationSelection, KnowledgeReviewIssue, KnowledgeReviewReportView } from "@codeflowai/shared";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Modal } from "ant-design-vue";
import { requestKnowledgeAsset } from "../../../api/projectKnowledge";
import { createApiResultError, type ApiRequestContext } from "../../../api/request";
import { knowledgeAdoptionSelection, knowledgeSelectedNodes } from "../knowledgeTreeModel";
import { knowledgeDocumentReviewActivity } from "../knowledgeReviewModel";
import type { KnowledgeDocumentContext, KnowledgeLibraryUpdate } from "../knowledgeWorkTreeModel";
import KnowledgeBuildPreview from "./knowledge-build-preview.vue";
import KnowledgeChangeInbox from "./knowledge-change-inbox.vue";

const props = defineProps<{ workspaceId: string; context: ApiRequestContext; nodes: KnowledgeAssetNode[]; formalNodes: KnowledgeAssetNode[]; runs: KnowledgeGenerationRunView[]; updates: KnowledgeLibraryUpdate[]; scopeNodeId: string | null; canWrite: boolean; actionsBusy?: boolean; changeId?: string | null; focusId?: string | null; focusReport?: boolean; recoveryRunId?: string; afterApply: (context: KnowledgeDocumentContext, count: number) => Promise<boolean> }>();
const emit = defineEmits<{ changed: [run?: KnowledgeGenerationRunView]; focus: [id: string]; preview: [context: KnowledgeDocumentContext | null]; close: []; openFile: [path: string]; recheck: [change: KnowledgeChangeDetail]; review: [nodeId: string]; resumeReview: [context: KnowledgeDocumentContext]; repair: [report: KnowledgeReviewReportView]; repairIssue: [report: KnowledgeReviewReportView, issue: KnowledgeReviewIssue]; returnToGeneration: [report: KnowledgeReviewReportView, runId: string]; busy: [value: boolean]; error: [cause: unknown, context: Record<string, unknown>] }>();
type Row = { id: string; nodeId: string; title: string; body: boolean; structure: boolean; generating: boolean; runId: string | null; revisionId: string | null; changeId: string | null; source: string; createdAt: string; reason: string | null; canApply: boolean };
const previews = shallowRef(new Map<string, KnowledgeGenerationPreview>());
const changes = shallowRef<KnowledgeChangeSummary[]>([]);
const validatedChanges = shallowRef(new Map<string, { hash: string; stale: boolean; reason: string }>());
const selected = ref<string[]>([]), activeId = ref<string | null>(null);
const touchedNodes = new Set<string>();
const loading = ref(false), saving = ref(false), errorText = ref("");
const childBusy = ref(false);
const locked = computed(() => saving.value || childBusy.value);
const outcome = ref("");
const completed = ref<string[]>([]);
const operationRow = shallowRef<Row | null>(null), operationRun = shallowRef<KnowledgeGenerationRunView | null>(null);
const buildRef = ref<InstanceType<typeof KnowledgeBuildPreview> | null>(null);
const changeRef = ref<InstanceType<typeof KnowledgeChangeInbox> | null>(null);
let epoch = 0;
let controller = new AbortController();
const runMap = computed(() => new Map(props.runs.map(run => [run.id, run])));
const scopeIds = computed(() => props.scopeNodeId ? new Set([props.scopeNodeId, ...knowledgeSelectedNodes(props.nodes, [props.scopeNodeId], true).map(node => node.id)]) : null);
const scopeIsFile = computed(() => props.nodes.find(node => node.id === props.scopeNodeId)?.contentMode !== "directory" && Boolean(props.scopeNodeId));
const rows = computed<Row[]>(() => {
  const generated = props.updates.filter(update => (!props.recoveryRunId || update.runId === props.recoveryRunId) && (!scopeIds.value || scopeIds.value.has(update.nodeId))).map(update => {
    const run = runMap.value.get(update.runId), preview = previews.value.get(update.runId);
    const item = preview?.items.find(item => item.nodeId === update.nodeId);
    const node = props.nodes.find(node => node.id === update.nodeId) ?? preview?.tree.nodes.find(node => node.id === update.nodeId);
    const legacyPlan = run && ["tree", "conversation"].includes(run.mode) && Boolean(run.proposedTree);
    const pending = run?.adoptions?.some(receipt => !receipt.completed && !receipt.cancelled);
    const reviewActivity = knowledgeDocumentReviewActivity(props.runs, update.nodeId, update.revisionId);
    return { ...update, id: `${update.id}:${update.revisionId ?? 'structure'}`, title: node?.title ?? update.nodeId,
      changeId: null, source: run?.maintenance ? "自动维护" : run?.mode === "conversation" ? "规格协作" : "生成修订", createdAt: run?.createdAt ? new Date(run.createdAt).toLocaleString() : "",
      reason: pending ? "有未完成采用，请恢复原清单或终止" : reviewActivity ?? (run?.active ? update.generating ? "生成中" : "当前任务尚未完成" : legacyPlan ? "历史目录计划，请重新构建" : item?.applied ? update.structure ? "正文已采用，结构变化需要重新构建" : "已采用" : item?.dismissed ? "本次不采用" : item?.reason ?? (!preview ? "正在核对采用条件" : null)),
      canApply: Boolean(!pending && !legacyPlan && !run?.active && !reviewActivity && item?.canApply && !item.applied && !item.dismissed) };
  }).filter(row => row.reason !== "已采用" && row.reason !== "本次不采用");
  const proposals = changes.value.filter(change => !props.recoveryRunId && (!scopeIds.value || scopeIds.value.has(change.nodeId))).map(change => {
    const check = validatedChanges.value.get(change.id);
    return { id: `change:${change.id}`, nodeId: change.nodeId, title: change.title, body: true, structure: false, generating: false, runId: null, revisionId: null,
      changeId: change.id, source: change.origin === "workflow" ? "流程会话" : "普通会话", createdAt: new Date(change.createdAt).toLocaleString(),
      reason: !check ? "查看内容后核对采用条件" : check.stale ? check.reason : null, canApply: Boolean(check && !check.stale) };
  });
  return [...generated, ...proposals];
});
const active = computed(() => operationRow.value ?? rows.value.find(row => row.id === activeId.value));
const allGenerating = computed(() => rows.value.length > 0 && rows.value.every(row => row.generating));
const activeRun = computed(() => operationRun.value ?? (active.value?.runId ? runMap.value.get(active.value.runId) : props.recoveryRunId ? runMap.value.get(props.recoveryRunId) : null));
const activeReviewActivity = computed(() => active.value ? knowledgeDocumentReviewActivity(props.runs, active.value.nodeId, active.value.revisionId) : null);
const activeIdentity = computed(() => active.value ? JSON.stringify([active.value.nodeId, active.value.revisionId]) : null);
const activeFocus = computed(() => { const identity = activeIdentity.value ? JSON.parse(activeIdentity.value) as [string, string | null] : null; return identity ? { nodeId: identity[0], revisionId: identity[1], report: Boolean(props.focusReport), selectOnly: true } : null; });
const chosen = computed(() => rows.value.filter(row => selected.value.includes(row.id)));
const documentCount = computed(() => new Set(rows.value.filter(row => row.body && !row.generating).map(row => row.nodeId)).size);
const generatingCount = computed(() => new Set(rows.value.filter(row => row.body && row.generating).map(row => row.nodeId)).size);
const structureCount = computed(() => new Set(rows.value.filter(row => row.structure && !row.generating).map(row => row.nodeId)).size);
const multiple = computed(() => active.value && rows.value.filter(row => row.nodeId === active.value!.nodeId).length > 1);
/** 自动选中与显式切换均通知父页，右侧会话必须对应正在展示的确切候选。 */
watch(() => JSON.stringify(active.value ? [active.value.nodeId, active.value.runId, active.value.revisionId] : null), () => {
  emit("preview", active.value ? { nodeId: active.value.nodeId, runId: active.value.runId, revisionId: active.value.revisionId } : null);
}, { immediate: true, flush: "sync" });

/** 汇总失败保留真实已生效范围，具体接口错误仍由原预览或审核边界记录。 */
function fail(cause: unknown, context: Record<string, unknown> = {}): void {
  errorText.value = cause instanceof Error ? cause.message : String(cause);
  emit("error", cause, context);
}

/** 目录只限定清单；多个同文件候选不自动选择最新版本。 */
function defaults(): void {
  const previous = new Set(selected.value);
  const counts = new Map<string, number>();
  for (const row of rows.value) counts.set(row.nodeId, (counts.get(row.nodeId) ?? 0) + 1);
  selected.value = rows.value.filter(row => row.canApply && counts.get(row.nodeId) === 1
    && (!touchedNodes.has(row.nodeId) || previous.has(row.id))
    && (row.body || !row.structure || Boolean(row.runId && runMap.value.get(row.runId)?.baseTree?.nodes.some(node => node.id === row.nodeId))))
    .map(row => row.id);
}

/** 从已有摘要定位确切候选，正文读取不等待整批采用校验。 */
function focusCandidate(): void {
  if (activeId.value && rows.value.some(row => row.id === activeId.value)) return;
  const requested = props.changeId ? rows.value.find(row => row.changeId === props.changeId) : rows.value.find(row => row.id === props.focusId);
  const first = rows.value[0];
  activeId.value = props.changeId || props.focusId ? requested?.id ?? null : first && rows.value.filter(row => row.nodeId === first.nodeId).length === 1 ? first.id : null;
}

/** 先读正文再核对采用条件；恢复操作只读取原任务，失败时保持采用禁用。 */
async function load(): Promise<void> {
  if (locked.value) return;
  const ticket = ++epoch;
  controller.abort(); controller = new AbortController();
  loading.value = true; errorText.value = "";
  previews.value = new Map();
  focusCandidate();
  try {
    await nextTick();
    await buildRef.value?.whenReady();
    if (ticket !== epoch) return;
    const ids = [...new Set(props.updates.filter(update => (!props.recoveryRunId || update.runId === props.recoveryRunId) && (!scopeIds.value || scopeIds.value.has(update.nodeId))).map(update => update.runId))];
    const plans = await Promise.all(ids.filter(id => !runMap.value.get(id)?.active).map(async id => {
      const result = await requestKnowledgeAsset(props.context, "run.preview", { workspaceId: props.workspaceId, runId: id }, { signal: controller.signal });
      if (!result.ok) throw createApiResultError(result);
      return [id, result.data] as const;
    }));
    const proposals: KnowledgeChangeSummary[] = [];
    let offset: number | null = props.recoveryRunId ? null : 0;
    while (offset !== null) {
      const result: Awaited<ReturnType<typeof requestKnowledgeAsset<"changes">>> = await requestKnowledgeAsset(props.context, "changes", { workspaceId: props.workspaceId, status: "pending", offset, ...(props.scopeNodeId ? { nodeId: props.scopeNodeId } : {}) }, { signal: controller.signal });
      if (!result.ok) throw createApiResultError(result);
      proposals.push(...result.data.items); offset = result.data.nextOffset;
    }
    if (ticket !== epoch) return;
    previews.value = new Map(plans); changes.value = proposals;
    defaults();
    focusCandidate();
  } catch (cause) { if (ticket === epoch && !controller.signal.aborted) fail(cause, { operation: "updates.read" }); }
  finally { if (ticket === epoch) loading.value = false; }
}

/** 同一文件只选一个候选，选择内容不会自动提交任何写操作。 */
function toggle(row: Row, checked: boolean, explicit = true): void {
  if (!row.canApply || locked.value) return;
  if (explicit) { touchedNodes.add(row.nodeId); operationRow.value = null; operationRun.value = null; activeId.value = row.id; emit("focus", row.id); }
  selected.value = selected.value.filter(id => !rows.value.some(item => item.id === id && item.nodeId === row.nodeId));
  if (checked) selected.value.push(row.id);
}

/** 阅读建议后以真实指纹启用采用；失效建议保留原因且不可选。 */
function validateChange(change: { id: string; nodeId: string; hash?: string; stale?: boolean; reason?: string }): void {
  if (!change.hash) return;
  validatedChanges.value = new Map(validatedChanges.value).set(change.id, { hash: change.hash, stale: Boolean(change.stale), reason: change.reason ?? "依据已变化" });
  const row = rows.value.find(row => row.changeId === change.id);
  if (row && row.canApply && !touchedNodes.has(row.nodeId) && rows.value.filter(candidate => candidate.nodeId === row.nodeId).length === 1 && !locked.value) toggle(row, true, false);
}

/** 显式选择才离开失败恢复上下文，保持当前草稿和采用回执可见。 */
function selectRow(row: Row): void {
  if (locked.value) return;
  operationRow.value = null; operationRun.value = null; activeId.value = row.id; emit("focus", row.id);
}

/** 比较用户确认的节点及必要祖先；前一组写入仅使无关树指纹变化时允许继续。 */
function structureSignature(plan: KnowledgeGenerationPreview, ids: string[]): string {
  const nodes = new Map(plan.tree.nodes.map(node => [node.id, node]));
  const included = new Set<string>();
  for (const id of ids) {
    let node = nodes.get(id);
    while (node && !included.has(node.id)) { included.add(node.id); node = node.parentId ? nodes.get(node.parentId) : undefined; }
  }
  return JSON.stringify([...included].sort().map(id => nodes.get(id)));
}

/** 逐组采用后等待页面衔接；失败保留预览，后续组不再提交。 */
async function applyRows(targets: Row[]): Promise<void> {
  if (locked.value || !props.canWrite || !targets.length) return;
  const ticket = epoch;
  const frozen = targets.map(row => ({ ...row }));
  const anchor = frozen.find(row => row.id === activeId.value && row.body) ?? frozen.find(row => row.body) ?? frozen.find(row => row.id === activeId.value) ?? frozen[0]!;
  const attempted: Row[] = [];
  saving.value = true; emit("busy", true); errorText.value = ""; outcome.value = ""; completed.value = [];
  try {
    const groups = new Map<string, Row[]>();
    for (const row of frozen) {
      if (!row.canApply) throw new Error(`${row.title}：${row.reason || '尚不可采用'}`);
      const run = row.runId ? runMap.value.get(row.runId) : null;
      const key = run?.mode === "conversation" && !run.proposedTree ? `draft:${row.id}` : row.runId ?? `change:${row.changeId}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      if (ticket !== epoch) throw new Error("页面范围已变化，后续内容尚未提交");
      operationRow.value = group[0]!; operationRun.value = group[0]!.runId ? runMap.value.get(group[0]!.runId) ?? null : null;
      activeId.value = group[0]!.id;
      await nextTick();
      if (group[0]!.runId) {
        const key = group[0]!.runId;
        const before = previews.value.get(key);
        if (!before) throw new Error("缺少已经确认的任务预览，请重新读取更新");
        const result = await requestKnowledgeAsset(props.context, "run.preview", { workspaceId: props.workspaceId, runId: key });
        if (!result.ok) throw createApiResultError(result);
        const after = result.data;
        const ids = group.map(row => row.nodeId);
        if (structureSignature(before, ids) !== structureSignature(after, ids)) throw new Error("候选结构或适用范围已变化，请重新查看更新");
        for (const row of group) if (!after.items.some(item => item.nodeId === row.nodeId && item.revisionId === row.revisionId && item.canApply)) throw new Error(`${row.title}：版本或采用条件已变化，请重新核对`);
        const applicable = new Set(after.items.filter(item => item.canApply && !item.applied && !item.dismissed).map(item => item.nodeId));
        const selectionIds = ids.reduce((value, id) => knowledgeAdoptionSelection(after.tree.nodes, value, id, true, applicable), [] as string[]);
        const selections: KnowledgeGenerationSelection[] = selectionIds.map(nodeId => {
          const item = after.items.find(item => item.nodeId === nodeId)!;
          return { nodeId, revisionId: item.revisionId };
        });
        for (const selection of selections) {
          if (selection.revisionId && !frozen.some(row => row.nodeId === selection.nodeId && row.revisionId === selection.revisionId)) throw new Error("所选文档依赖另一个尚未采用的上层正文，请明确选择该版本后再采用");
          const other = frozen.find(row => row.nodeId === selection.nodeId && row.runId && row.runId !== key);
          if (other && JSON.stringify(previews.value.get(other.runId!)?.tree.nodes.find(node => node.id === other.nodeId)) !== JSON.stringify(after.tree.nodes.find(node => node.id === other.nodeId))) throw new Error("所选更新依赖不同的目录候选，请先统一目录版本");
        }
        if (runMap.value.get(key)?.adoptions?.some(receipt => !receipt.completed && !receipt.cancelled)) throw new Error("此任务有未完成采用，请先恢复原清单或终止");
        previews.value = new Map(previews.value).set(key, after);
        await nextTick();
        if (!buildRef.value) throw new Error("生成预览尚未就绪");
        attempted.push(...group);
        await buildRef.value.applyConfirmed({ requestId: crypto.randomUUID(), treeHash: after.treeHash, planHash: after.planHash, selections });
      } else {
        const row = group[0]!, check = validatedChanges.value.get(row.changeId!);
        if (!check || !changeRef.value) throw new Error("请先查看会话建议并核对采用条件");
        attempted.push(row);
        await changeRef.value.confirm("approve", check.hash);
      }
      completed.value.push(...group.map(row => row.title));
      selected.value = selected.value.filter(id => !group.some(row => row.id === id));
    }
    operationRow.value = { ...anchor, canApply: false, reason: "已采用" };
    operationRun.value = anchor.runId ? runMap.value.get(anchor.runId) ?? null : null;
    if (await props.afterApply({ nodeId: anchor.nodeId, runId: anchor.runId, revisionId: anchor.revisionId }, completed.value.length)) return;
    operationRow.value = null; operationRun.value = null; activeId.value = null;
    saving.value = false;
    await load();
  } catch (cause) {
    if (completed.value.length === frozen.length) {
      outcome.value = `已采用 ${completed.value.length} 项更新，页面读取失败，请重新选择文件重试。`;
      fail(cause, { operation: "updates.open-adopted", nodeId: anchor.nodeId, runId: anchor.runId, revisionId: anchor.revisionId });
      return;
    }
    try {
      if (attempted.some(row => row.runId)) {
        const actual = await requestKnowledgeAsset(props.context, "snapshot", { workspaceId: props.workspaceId });
        if (!actual.ok) throw createApiResultError(actual);
        const applied = attempted.filter(row => row.runId && (row.revisionId
          ? actual.data.states.some(state => state.nodeId === row.nodeId && state.revisionId === row.revisionId)
          : JSON.stringify(actual.data.tree.nodes.find(node => node.id === row.nodeId)) === JSON.stringify(previews.value.get(row.runId)?.tree.nodes.find(node => node.id === row.nodeId))));
        completed.value = [...new Set([...completed.value, ...applied.map(row => row.title)])];
      }
      for (const row of attempted.filter(row => row.changeId)) {
        const actual = await requestKnowledgeAsset(props.context, "change", { workspaceId: props.workspaceId, changeId: row.changeId });
        if (!actual.ok) throw createApiResultError(actual);
        if (actual.data.id !== row.changeId || actual.data.nodeId !== row.nodeId) throw new Error("返回的审核记录与所选建议不一致");
        if (actual.data.status === "approved") {
          if (!actual.data.revisionId) throw new Error("建议已批准，但缺少采用版本记录");
          completed.value = [...new Set([...completed.value, row.title])];
        }
      }
      outcome.value = `已完成 ${completed.value.length} 项${completed.value.length ? `：${completed.value.join('、')}` : ''}；后续组尚未提交。当前失败项可检查原任务或重新核对。`;
    } catch (readCause) {
      fail(readCause, { operation: "updates.verify-applied", candidateId: activeId.value, nodeId: operationRow.value?.nodeId, runId: operationRow.value?.runId, changeId: operationRow.value?.changeId });
      outcome.value = `已确认完成 ${completed.value.length} 项，当前组的生效状态未知，读取失败：${errorText.value}。请重新打开更新核实后再操作；后续组尚未提交。`;
    }
    fail(cause, { operation: "updates.apply", candidateId: activeId.value, completed: completed.value });
    emit("changed");
  } finally { saving.value = false; emit("busy", childBusy.value); }
}

/** 不采用绑定确切候选，保留正式知识、默认空节点和其他来源的待办。 */
function dismiss(): void {
  const row = active.value;
  if (!row || saving.value || !props.canWrite) return;
  const ticket = epoch, workspaceId = props.workspaceId;
  const plan = row.runId ? previews.value.get(row.runId) : null;
  const directory = plan?.tree.nodes.find(node => node.id === row.nodeId)?.contentMode === "directory";
  const descendants = directory && plan ? new Set(knowledgeSelectedNodes(plan.tree.nodes, [row.nodeId], true).map(node => node.id)) : new Set([row.nodeId]);
  const affected = plan ? plan.items.filter(item => descendants.has(item.nodeId) && !item.applied && !item.dismissed).map(item => plan.tree.nodes.find(node => node.id === item.nodeId)?.title ?? item.nodeId) : [row.title];
  Modal.confirm({ title: "本次不采用此更新？", content: `本次处理 ${affected.length} 项：${affected.join('、')}。正式知识及其他任务候选保留。`, okText: "本次不采用", cancelText: "返回", onOk: async () => {
    if (ticket !== epoch || workspaceId !== props.workspaceId) throw new Error("知识范围已变化，请重新确认");
    saving.value = true; emit("busy", true); errorText.value = "";
    try {
      if (row.changeId) {
        const check = validatedChanges.value.get(row.changeId);
        if (!check || !changeRef.value) throw new Error("请先查看具体更新");
        await changeRef.value.confirm("reject", check.hash);
      } else {
        const plan = previews.value.get(row.runId!);
        if (!plan) throw new Error("候选预览尚未就绪");
        const result = await requestKnowledgeAsset(props.context, "revision.dismiss", { workspaceId: props.workspaceId, runId: row.runId!, nodeId: row.nodeId, revisionId: row.revisionId, planHash: plan.planHash }, { method: "POST" });
        if (!result.ok) throw createApiResultError(result);
        emit("changed", result.data);
      }
      emit("changed"); operationRow.value = null; operationRun.value = null; activeId.value = null; saving.value = false; await load();
    } catch (cause) { fail(cause, { operation: "updates.dismiss", nodeId: row.nodeId, runId: row.runId, changeId: row.changeId }); }
    finally { saving.value = false; emit("busy", false); }
  } });
}

/** 子预览只同步数据，父页刷新不会抢走用户正在阅读的候选。 */
function receiveRun(run: KnowledgeGenerationRunView): void { emit("changed", run); }
/** 子预览恢复采用、终止和维护重试也锁定统一页面，防止切换中断原请求。 */
async function childLock(value: boolean): Promise<void> {
  if (value) {
    if (!operationRow.value && active.value) operationRow.value = { ...active.value };
    const run = activeRun.value;
    operationRun.value = run ? { ...run, adoptions: buildRef.value?.adoptionReceipts() ?? run.adoptions } : null;
  }
  childBusy.value = value;
  if (value || saving.value || buildRef.value?.hasRecovery()) { emit("busy", saving.value || value); return; }
  const run = activeRun.value, ticket = epoch;
  saving.value = true; emit("busy", true);
  try {
    if (run) {
      const result = await requestKnowledgeAsset(props.context, "run", { workspaceId: props.workspaceId, runId: run.id });
      if (!result.ok) throw createApiResultError(result);
      if (ticket !== epoch) return;
      const previous = run.adoptions?.find(receipt => !receipt.completed && !receipt.cancelled);
      const receipt = previous ? result.data.adoptions?.find(receipt => receipt.requestId === previous.requestId)
        : result.data.adoptions?.slice().reverse().find(receipt => receipt.completed && !receipt.cancelled);
      if (receipt?.completed && !receipt.cancelled) {
        emit("changed", result.data);
        const anchor = receipt.selections.find(item => item.nodeId === operationRow.value?.nodeId && operationRow.value.body)
          ?? receipt.selections.find(item => item.revisionId)
          ?? receipt.selections.find(item => props.nodes.find(node => node.id === item.nodeId)?.contentMode !== "directory")
          ?? receipt.selections[0];
        if (!anchor) throw new Error("采用回执缺少所选内容，无法打开正式正文");
        if (operationRow.value) operationRow.value = { ...operationRow.value, canApply: false, reason: "已采用" };
        if (await props.afterApply({ ...anchor, runId: run.id }, receipt.selections.length)) return;
      }
    }
    operationRow.value = null; operationRun.value = null; activeId.value = null;
    saving.value = false;
    await load();
  } catch (cause) { fail(cause, { operation: "updates.open-recovered", runId: run?.id }); }
  finally { saving.value = false; emit("busy", childBusy.value); }
}
watch(() => [props.workspaceId, props.scopeNodeId, props.changeId, props.recoveryRunId], () => { activeId.value = null; selected.value = []; touchedNodes.clear(); validatedChanges.value = new Map(); void load(); }, { immediate: true });
/** 同文件复用组件时仍响应任务的确切版本定位，后台加载完成后保留新的显式选择。 */
watch(() => props.focusId, id => {
  if (locked.value || !id || id === activeId.value) return;
  operationRow.value = null; operationRun.value = null;
  activeId.value = rows.value.find(row => row.id === id)?.id ?? null;
});
/** 独立复检开始或结束时重新核对资格，阶段变化不打断当前正文。 */
watch(() => JSON.stringify(props.updates.map(update => [update.id, update.revisionId, update.body, update.structure, update.generating, runMap.value.get(update.runId)?.active, Boolean(knowledgeDocumentReviewActivity(props.runs, update.nodeId, update.revisionId))])), () => { if (!saving.value) void load(); });
onBeforeUnmount(() => { epoch++; controller.abort(); });
</script>

<template>
  <section class="knowledge-updates" data-testid="knowledge-updates">
    <header class="updates-heading"><div><strong>{{ recoveryRunId ? '恢复未完成操作' : allGenerating ? '生成中' : '待确认更新' }}</strong><span v-if="documentCount">{{ documentCount }} 篇文档</span><span v-if="generatingCount">{{ generatingCount }} 篇文档生成中</span><span v-if="structureCount">另含 {{ structureCount }} 项结构调整</span><span v-if="active" class="candidate-status" :class="{ generating: active.generating }">{{ active.generating ? '生成中' : active.reason === '已采用' ? '已采用，已生效' : '尚未采用，未生效' }}{{ multiple ? ' · 请选择候选版本' : '' }}</span></div></header>
    <a-alert v-if="errorText" type="error" show-icon :message="errorText" />
    <a-alert v-if="outcome" :type="errorText ? 'warning' : 'success'" show-icon :message="outcome" />
    <a-spin v-if="loading && !active" class="updates-loading" />
    <div v-else class="updates-layout" :class="{ 'single-file': !rows.length || scopeIsFile && rows.length === 1 }">
      <aside v-if="rows.length && (!scopeIsFile || rows.length !== 1)" class="update-list" aria-label="待确认更新清单">
        <label v-for="row in rows" :key="row.id" class="update-row" :class="{ selected: activeId === row.id }"><input type="checkbox" :aria-label="`采用 ${row.title} · ${row.source} · ${row.createdAt}`" :checked="selected.includes(row.id)" :disabled="!canWrite || locked || !row.canApply" @change="toggle(row, ($event.target as HTMLInputElement).checked)"><button type="button" :disabled="locked" @click="selectRow(row)"><strong>{{ row.title }}</strong><small>{{ row.source }} · {{ row.createdAt }} · {{ row.generating ? '生成中' : row.structure ? row.body ? '正文与结构调整' : '结构调整' : '尚未采用' }}</small><span v-if="row.reason" class="row-reason" :class="{ generating: row.generating }">{{ row.reason }}</span></button></label>
      </aside>
      <div class="update-content">
        <KnowledgeBuildPreview v-if="activeRun && (!activeRun.active || activeReviewActivity || active?.revisionId && !active.generating)" :key="active?.id ?? activeRun.id" ref="buildRef" embedded :recovery-only="!active" :workspace-id="workspaceId" :context="context" :run="activeRun" :runs="runs" :nodes="nodes" :supplied-preview="previews.get(activeRun.id)" :can-write="canWrite" :actions-busy="locked || actionsBusy" :can-start-task="formalNodes.some(node => node.id === active?.nodeId)" :scope-node-id="active?.nodeId" :focus="activeFocus" @busy="childLock" @changed="receiveRun" @open-file="emit('openFile', $event)" @review="emit('review', $event)" @resume-review="emit('resumeReview', $event)" @repair="emit('repair', $event)" @repair-issue="(report, issue) => emit('repairIssue', report, issue)" @return-to-generation="(report, runId) => emit('returnToGeneration', report, runId)" @error="(cause, context) => fail(cause, context)" />
        <KnowledgeChangeInbox v-else-if="active?.changeId" :key="active.changeId" ref="changeRef" embedded :workspace-id="workspaceId" :context="context" :can-write="canWrite" :change-id="active.changeId" @recheck="emit('recheck', $event)" @selected="validateChange" @changed="emit('changed')" />
        <div v-else-if="active && activeRun?.active" class="updates-processing" role="status" aria-live="polite" aria-busy="true"><a-spin size="large" aria-hidden="true" /><span>{{ active.reason }}</span></div>
        <p v-else class="updates-empty">{{ active?.reason || '选择具体更新查看内容与对比。多个版本不会自动取最新。' }}</p>
      </div>
    </div>
    <footer v-if="rows.length"><span>已选 {{ chosen.length }} 项<span v-if="rows.some(row => row.reason)"> · 不可采用项已注明原因</span></span><div><a-button :disabled="!canWrite || !active || loading || locked" @click="dismiss">本次不采用</a-button><a-button v-if="scopeIsFile" type="primary" :disabled="!canWrite || !active?.canApply || loading || locked" @click="active && applyRows([active])">采用此版本</a-button><a-button v-else type="primary" :disabled="!canWrite || !chosen.length || loading || locked" :loading="saving" @click="applyRows(chosen)">采用所选内容</a-button></div></footer>
  </section>
</template>

<style scoped>
.knowledge-updates { display: flex; flex: 1 1 0; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.updates-heading, footer { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--app-divider); flex-wrap: wrap; }
.updates-heading > div { flex: 1; display: flex; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.updates-heading span, footer > span { color: var(--app-muted); font-size: 12px; }
.updates-layout { display: grid; grid-template-columns: clamp(140px, 22%, 200px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); flex: 1 1 0; min-height: 0; overflow: hidden; }
.updates-layout.single-file { grid-template-columns: minmax(0, 1fr); }
.update-list { min-height: 0; overflow: auto; border-right: 1px solid var(--app-divider); }
.update-row { display: flex; gap: 8px; padding: 10px 12px; align-items: flex-start; border-bottom: 1px solid var(--app-divider); }
.update-row.selected { background: var(--app-sidebar-active-bg); }
.update-row input { margin-top: 4px; accent-color: var(--app-accent); }
.update-row button { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 4px; text-align: left; border: 0; padding: 0; background: none; color: var(--app-text); cursor: pointer; overflow-wrap: anywhere; }
.update-row strong { font-size: 12px; }.update-row small { color: var(--app-muted); font-size: 10px; }.row-reason { color: var(--app-warning); font-size: 11px; }
.update-content { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; }
.updates-heading .candidate-status { color: var(--app-warning); }
.updates-heading .candidate-status.generating, .row-reason.generating { color: var(--app-accent); }
.updates-processing { display: flex; flex-direction: column; align-items: center; gap: 16px; margin: auto; padding: 24px; color: var(--app-text); font-size: 16px; font-weight: 500; line-height: 1.6; text-align: center; }
.updates-empty { margin: auto; padding: 20px; color: var(--app-muted); font-size: 12px; line-height: 1.7; }.updates-loading { margin: auto; }
footer { justify-content: space-between; border-top: 1px solid var(--app-divider); border-bottom: 0; }footer > div { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 640px) { .updates-heading > div { flex-basis: 100%; gap: 4px 8px; }.updates-heading strong { white-space: nowrap; }.updates-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(100px, 30%) minmax(0, 1fr); }.updates-layout.single-file { grid-template-rows: minmax(0, 1fr); }.update-list { border-right: 0; border-bottom: 1px solid var(--app-divider); } }
</style>
