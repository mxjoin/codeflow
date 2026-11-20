<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined, CheckCircleFilled, SyncOutlined, ClockCircleOutlined, CloseCircleFilled } from "@ant-design/icons-vue";
import type { ConversationTool, ConversationDiff } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useUiStore } from "../../../../store/ui";
import KnowledgeExecutionRecord from "../../../project-knowledge/components/knowledge-execution-record.vue";

defineOptions({ name: "ToolItem" });

type Props = {
  item: ConversationTool;
  /** 关联的 diff（由 messages-list 在 tool 后紧跟 diff 时注入）。 */
  diff?: ConversationDiff | null;
};

const props = defineProps<Props>();
const ui = useUiStore();
/** 规格记录的完成只表示保存成功，不能显示为业务验收绿勾。 */
const isKnowledgeRecord = computed(() => ["项目规格已提供", "规格验证依据"].includes(props.item.toolType));

type TodoListRow = {
  step: string;
  status: string;
  statusLabel: string;
  statusColor: "green" | "blue" | "default";
};

/** 将 item.todolistItems 转换为带 UI 格式化信息的行列表（纯 UI 逻辑，不解析 JSON）。 */
const todoListView = computed<{ explanation: string; rows: TodoListRow[] } | null>(() => {
  if (!isTodoListToolItem.value) return null;
  const items = props.item.todolistItems;
  if (!items?.length) return null;
  const rows: TodoListRow[] = items
    .filter(({ step }) => Boolean(step))
    .map(({ step, status }) => ({ step, status, ...formatTodoListStatus(status) }));
  return rows.length ? { explanation: props.item.summary ?? "", rows } : null;
});

const todoListSummary = computed(() => {
  const view = todoListView.value;
  if (!view) return "";
  const completed = view.rows.filter((r) => r.statusColor === "green").length;
  return `${completed}/${view.rows.length}`;
});

/** summary 行预览文字：todolist 显示进行中步骤（UI 派生），其余使用适配器填充的 item.summary。 */
const summaryPreview = computed(() => {
  if (isTodoListToolItem.value) {
    // 从 todolistItems 中找进行中步骤作为单行预览（纯 UI 逻辑）。
    const inProgressItem = props.item.todolistItems?.find(({ status }) => {
      const s = status.toLowerCase();
      return s === "in_progress" || s === "inprogress" || s === "in-progress" || s === "doing" || s === "running";
    });
    return inProgressItem?.step ?? "";
  }
  return props.item.summary ?? "";
});

/** 是否为 todolist 类工具（由 reducer 通过 isTodolist 字段标记，此处加 toolType 兜底保证向后兼容）。 */
const isTodoListToolItem = computed(() => {
  if (props.item.isTodolist != null) return props.item.isTodolist;
  const t = (props.item.toolType ?? "").toLowerCase();
  return t === "update_plan" || t === "todowrite";
});

function formatTodoListStatus(statusRaw: string): Pick<TodoListRow, "statusLabel" | "statusColor"> {
  /** 将 todolist 的状态映射为展示用的 label + 颜色。 */
  const s = String(statusRaw ?? "").trim().toLowerCase();
  if (s === "completed" || s === "done") return { statusLabel: "已完成", statusColor: "green" };
  if (s === "in_progress" || s === "inprogress" || s === "in-progress" || s === "in progress" || s === "doing" || s === "running")
    return { statusLabel: "进行中", statusColor: "blue" };
  if (s === "pending" || s === "todo") return { statusLabel: "未开始", statusColor: "default" };
  return { statusLabel: statusRaw || "unknown", statusColor: "default" };
}

/* ---- 完整参数 ---- */
const detailsOpen = ref(false);
const copyingDetails = ref(false);

async function copyDetails(): Promise<void> {
  if (copyingDetails.value) return;
  copyingDetails.value = true;
  try {
    await copyToClipboard(JSON.stringify(props.item, null, 2));
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingDetails.value = false;
  }
}

/* ---- diff 相关 ---- */
const diffLines = computed(() => {
  const raw = props.diff?.diff ?? "";
  return raw ? raw.split(/\r?\n/g) : [];
});

const copyingDiff = ref(false);

async function copyDiff(): Promise<void> {
  if (copyingDiff.value) return;
  copyingDiff.value = true;
  try {
    await copyToClipboard(props.diff?.diff ?? "");
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingDiff.value = false;
  }
}

function lineClass(line: string): string {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) return "diff-line--meta";
  if (line.startsWith("@@")) return "diff-line--hunk";
  if (line.startsWith("+")) return "diff-line--add";
  if (line.startsWith("-")) return "diff-line--del";
  return "";
}
</script>

<template>
  <details class="msg msg--tool msg--collapsible">
    <summary class="msg__summary-row">
      <div class="msg__summary-left">
        <span class="msg__role">{{ isKnowledgeRecord ? '规格' : isTodoListToolItem ? '任务' : '工具' }}</span>
        <span v-if="!isTodoListToolItem" class="msg__title" style="margin: 0">{{ item.title }}</span>
        <span v-if="summaryPreview" class="msg__summary-preview">{{ summaryPreview }}</span>
      </div>
      <div class="msg__summary-right">
        <a-button v-if="diff" size="small" type="text" class="tool-item__copy-diff-btn" :loading="copyingDiff" @click.stop="copyDiff">复制 Diff</a-button>
        <span v-if="item.changes?.length" class="msg__hint-inline">{{ item.changes.length }} 个文件</span>
        <span v-if="item.durationMs != null" class="msg__hint-inline">{{ item.durationMs }}ms</span>
        <span v-if="todoListSummary" class="msg__hint-inline">{{ todoListSummary }}</span>
        <ClockCircleOutlined v-if="isKnowledgeRecord" class="msg__status-icon msg__status-icon--warning" />
        <CheckCircleFilled v-else-if="!isTodoListToolItem && item.status === 'completed'" class="msg__status-icon msg__status-icon--done" />
        <SyncOutlined v-else-if="!isTodoListToolItem && item.status === 'started'" class="msg__status-icon msg__status-icon--running" :spin="true" />
        <ClockCircleOutlined v-else-if="!isTodoListToolItem && item.status === 'incomplete'" class="msg__status-icon msg__status-icon--warning" />
        <CloseCircleFilled v-else-if="!isTodoListToolItem && item.status === 'failed'" class="msg__status-icon msg__status-icon--failed" />
      </div>
    </summary>

    <div class="msg__body">
      <KnowledgeExecutionRecord v-if="isKnowledgeRecord" :item="item" />
      <div v-if="todoListView" class="tool-todolist">
        <div v-if="todoListView.explanation" class="tool-todolist__explanation">{{ todoListView.explanation }}</div>
        <div class="tool-todolist__rows">
          <div v-for="row in todoListView.rows" :key="`${row.step}__${row.status}`" class="tool-todolist__row">
            <CheckCircleFilled v-if="row.statusColor === 'green'" class="tool-todolist__icon tool-todolist__icon--done" />
            <SyncOutlined v-else-if="row.statusColor === 'blue'" class="tool-todolist__icon tool-todolist__icon--progress" :spin="true" />
            <ClockCircleOutlined v-else class="tool-todolist__icon tool-todolist__icon--pending" />
            <div class="tool-todolist__step" :class="{ 'tool-todolist__step--done': row.statusColor === 'green' }">{{ row.step }}</div>
          </div>
        </div>
      </div>

      <pre v-if="!isKnowledgeRecord && !isTodoListToolItem && !diffLines.length && item.detail" class="msg__pre">{{ item.detail }}</pre>
      <pre v-if="!isKnowledgeRecord && !isTodoListToolItem && (!diffLines.length || item.status === 'failed') && item.output" class="msg__pre msg__pre--output">{{ item.output }}</pre>

      <!-- 内联 diff -->
      <div v-if="diffLines.length" class="diff-view">
        <div v-for="(line, idx) in diffLines" :key="`${idx}_${line}`" class="diff-line" :class="lineClass(line)">{{ line }}</div>
      </div>

      <!-- 完整参数（仅在调试侧栏开启时显示） -->
      <div v-if="ui.inspectorVisible" class="msg__approval-details">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <button type="button" class="msg__approval-details-toggle" @click="detailsOpen = !detailsOpen">
            <RightOutlined v-if="!detailsOpen" style="font-size: 10px" />
            <DownOutlined v-else style="font-size: 10px" />
            完整参数
          </button>
          <button v-show="detailsOpen" type="button" class="msg__mini-btn" @click.stop="copyDetails">
            {{ copyingDetails ? "..." : "复制 JSON" }}
          </button>
        </div>
        <pre v-show="detailsOpen" class="msg__approval-details-body">{{ JSON.stringify(item, null, 2) }}</pre>
      </div>
    </div>
  </details>
</template>

