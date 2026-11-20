<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { Modal, message, type TourProps } from "ant-design-vue";
import { DownOutlined, FolderOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import type { WorkspaceId, WorkspaceSummary } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useReminderStore } from "../../../store/reminders";
import { useWorkspacesStore } from "../../../store/workspaces";
import { getSharedWorkspaceOwnerLabel, getWorkspaceDisplayTitle, getWorkspaceKindLabel } from "../../../utils/workspaceDisplay";
import CreateWorkspaceModal from "./create-workspace-modal.vue";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "WorkspaceSelector" });

type Props = {
  dense?: boolean;
  /** 顶栏紧凑模式：展示显式的工作区入口，在弹层里完成切换与管理。 */
  compact?: boolean;
};

const props = defineProps<Props>();

const config = useConfigStore();
const workspaces = useWorkspacesStore();
const presence = usePresenceStore();
const reminders = useReminderStore();
const { ctx } = useApiContext();

const createOpen = ref(false);
const saving = ref(false);
const refreshing = ref(false);
const refreshError = ref<string | null>(null);
const compactOpen = ref(false);
const compactQuery = ref("");
const modalMode = ref<"create" | "edit">("create");
const modalInitial = ref<{ workspaceId?: WorkspaceId; title: string; path: string; clientId?: string } | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
const createRef = ref<HTMLElement | null>(null);
const tourOpen = ref(false);
const route = useRoute();
const WORKSPACE_TOUR_SEEN_KEY = "codeflowai.workspace-onboarding.v2";
const workspaceTourSteps = ref<NonNullable<TourProps["steps"]>>([]);
let tourTimer: number | undefined;
let authWaitAttempts = 0;
let threadWaitAttempts = 0;

/** 进入会话页后首次引导工作区切换、新建工作区和新建会话，关闭或完成只记录一次。 */
function scheduleWorkspaceTour(): void {
  if (!props.compact || !config.isDesktop || tourOpen.value
    || localStorage.getItem(WORKSPACE_TOUR_SEEN_KEY) === "1" || route.name !== "chat") return;
  if (tourTimer !== undefined) return;
  authWaitAttempts = 0;
  threadWaitAttempts = 0;
  tourTimer = window.setTimeout(tryOpenWorkspaceTour, 900);
}

/** 线程列表可能晚于顶栏挂载，短轮询等待“新建会话”入口后再展示完整三步。 */
function tryOpenWorkspaceTour(): void {
  tourTimer = undefined;
  if (!triggerRef.value || !createRef.value) return;
  // 登录提醒优先展示；等用户关闭或完成登录后再继续工作区引导。
  if (document.querySelector(".desktop-auth-modal-host")) {
    if (authWaitAttempts >= 40) return;
    authWaitAttempts += 1;
    tourTimer = window.setTimeout(tryOpenWorkspaceTour, 500);
    return;
  }
  const threadTarget = document.querySelector<HTMLElement>('[data-workspace-tour="new-thread"]');
  if (!threadTarget && threadWaitAttempts < 10) {
    threadWaitAttempts += 1;
    tourTimer = window.setTimeout(tryOpenWorkspaceTour, 250);
    return;
  }
  const steps: NonNullable<TourProps["steps"]> = [
    {
      title: "切换工作区",
      description: "点击这里查看已有工作区，可在本地和远程工作区之间切换。",
      target: () => triggerRef.value!,
      placement: "bottomLeft",
      nextButtonProps: { children: () => "下一步" },
    },
    {
      title: "新建工作区",
      description: "点击 + 创建一个新工作区，并选择它所在的目录。",
      target: () => createRef.value!,
      placement: "bottom",
      prevButtonProps: { children: () => "上一步" },
      nextButtonProps: { children: () => threadTarget ? "下一步" : "完成引导" },
    },
  ];
  if (threadTarget) {
    steps.push({
      title: "新建会话",
      description: "点击这里在当前工作区创建一个新会话。",
      target: () => threadTarget,
      placement: "right",
      prevButtonProps: { children: () => "上一步" },
      nextButtonProps: { children: () => "完成引导" },
    });
  }
  workspaceTourSteps.value = steps;
  tourOpen.value = true;
}

onMounted(scheduleWorkspaceTour);

watch(() => route.name, name => {
  if (name !== "chat") {
    if (tourTimer !== undefined) window.clearTimeout(tourTimer);
    tourTimer = undefined;
    return;
  }
  scheduleWorkspaceTour();
});

onUnmounted(() => {
  if (tourTimer !== undefined) window.clearTimeout(tourTimer);
});

/** 关闭、跳过或完成都视为已读，避免每次启动重复打断。 */
function markWorkspaceTourSeen(): void {
  tourOpen.value = false;
  localStorage.setItem(WORKSPACE_TOUR_SEEN_KEY, "1");
}

const canOperate = computed(() => config.canManageWorkspaces);
const createClients = computed(() => presence.availableClients);

/** 截取路径末尾 2-3 级目录用于显示 */
const shortenPath = (path: string | undefined): string => {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 3 ? parts.join("/") : ".../" + parts.slice(-3).join("/");
};

/** 获取工作区归属的在线 Client 信息；保留数组形态供展示逻辑复用。 */
const getOnlineClients = (workspaceId: string) => {
  const client = presence.clientForWorkspace(workspaceId);
  return client ? [{ clientId: client.clientId, version: client.version, name: client.name }] : [];
};

/** 紧凑下拉项展示 client 名称，缺失名称时回退为 clientId。 */
const formatClientNames = (clients: Array<{ clientId: string; name?: string | null }>): string =>
  clients
    .map((client) => String(client.name ?? "").trim() || client.clientId)
    .join("、");

const isSharedWorkspace = (workspace: WorkspaceSummary | null | undefined): boolean =>
  workspace?.kind === "shared" || Boolean(workspace?.shared);

const hasSharedWorkspaceMarker = (workspace: WorkspaceSummary | null | undefined): boolean =>
  isSharedWorkspace(workspace) || Boolean(workspace?.hostedShared);

const roleLabel = (workspace: WorkspaceSummary): string => {
  const role = workspace.shared?.effectiveAssetRole ?? workspace.shared?.currentUserRole;
  if (role === "enterprise_admin") return "企业管理员";
  if (role === "workspace_admin") return "工作区管理员";
  if (role === "member") return "成员";
  return "共享";
};

const sharedStatusLabel = (workspace: WorkspaceSummary): string => {
  if (workspace.hostMaintenance?.active || workspace.shared?.hostMaintenance?.active) return "Host 迁移维护中";
  const status = workspace.entryStatus;
  if (status === "available") return "Host 在线";
  if (status === "host_offline") return "Host 离线";
  if (status === "host_unbound") return "Host 待绑定";
  if (status === "forbidden") return "无权进入";
  return "Host 状态未知";
};

const sharedCapabilityText = (workspace: WorkspaceSummary): string => {
  if (workspace.capabilities?.canMaintainAssets) return "可维护全部共享资产，维护动作会审计";
  if (workspace.capabilities?.canUseAssets) return "可使用共享资产参与流程，不能维护定义";
  return workspace.disabledReason ?? "共享能力不可用";
};

const options = computed(() =>
  workspaces.workspaces.map((w) => {
    const clients = getOnlineClients(w.id);
    const reminder = reminders.workspaceSummaryById(w.id);
    const shared = isSharedWorkspace(w);
    const sharedMarker = hasSharedWorkspaceMarker(w);
    const displayLabel = getWorkspaceDisplayTitle(w);
    const kindLabel = getWorkspaceKindLabel(w);
    const sharedName = String(w.shared?.displayName ?? w.hostedShared?.displayName ?? "").trim();
    const hostMaintenance = w.hostMaintenance ?? w.shared?.hostMaintenance ?? null;
    const displayPath = shared && sharedName ? `共享空间：${sharedName}` : w.path;
    const maintenanceReason = shared && hostMaintenance?.active ? "Host 正在迁移本地目录，当前入口暂时维护" : null;
    return {
      label: displayLabel,
      rawLabel: w.title,
      displayLabel,
      kindLabel,
      kindClass: shared ? "shared" : "local",
      value: w.id,
      path: w.path,
      displayPath,
      clients,
      shared,
      sharedMarker,
      sharedName,
      hostOwnerLabel: shared ? getSharedWorkspaceOwnerLabel(w) : "",
      roleLabel: shared ? roleLabel(w) : "",
      statusLabel: shared ? sharedStatusLabel(w) : "",
      disabledReason: maintenanceReason ?? w.disabledReason ?? null,
      capabilityText: shared ? sharedCapabilityText(w) : "",
      online: shared ? w.entryStatus === "available" : clients.length > 0,
      disabled: shared && (w.entryStatus !== "available" || Boolean(hostMaintenance?.active)),
      hostMaintenance,
      pendingActionCount: reminder?.pendingActionCount ?? 0,
      pendingReceiptCount: reminder?.pendingReceiptCount ?? 0,
    };
  }),
);

const selectedPath = computed(() => workspaces.byId.get(config.workspaceId as WorkspaceId)?.path ?? null);
const selectedWorkspace = computed(() => workspaces.byId.get(config.workspaceId as WorkspaceId) ?? null);
const selectedWorkspaceValue = computed(() => selectedWorkspace.value?.id);
const otherWorkspaceReminderSummary = computed(() =>
  options.value
    .filter((option) => option.value !== selectedWorkspaceValue.value)
    .reduce(
      (acc, option) => ({
        pendingActionCount: acc.pendingActionCount + option.pendingActionCount,
        pendingReceiptCount: acc.pendingReceiptCount + option.pendingReceiptCount,
      }),
      { pendingActionCount: 0, pendingReceiptCount: 0 },
    ),
);
const filteredOptions = computed(() => {
  const query = compactQuery.value.trim().toLowerCase();
  const entries = options.value.slice().sort((left, right) => {
    const leftActive = left.value === selectedWorkspaceValue.value;
    const rightActive = right.value === selectedWorkspaceValue.value;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    if (left.online !== right.online) return left.online ? -1 : 1;
    return left.displayLabel.localeCompare(right.displayLabel, "zh-Hans-CN");
  });
  if (!query) return entries;
  return entries.filter((option) =>
    option.label.toLowerCase().includes(query)
    || option.rawLabel.toLowerCase().includes(query)
    || option.displayLabel.toLowerCase().includes(query)
    || option.path.toLowerCase().includes(query)
    || option.displayPath.toLowerCase().includes(query)
    || option.hostOwnerLabel.toLowerCase().includes(query)
    || option.sharedName.toLowerCase().includes(query)
    || option.roleLabel.toLowerCase().includes(query)
    || option.statusLabel.toLowerCase().includes(query)
    || option.capabilityText.toLowerCase().includes(query)
    || option.kindLabel.toLowerCase().includes(query)
    || (option.sharedMarker && "共享工作区".includes(query))
    || (!option.shared && "本地工作区".includes(query))
    || shortenPath(option.path).toLowerCase().includes(query),
  );
});
const showActions = computed(() => !props.compact);

/** 复用统一目录刷新在线状态；保留缓存，重复点击不并发，失败明确留在当前入口。 */
const refresh = async (): Promise<boolean> => {
  if (!config.canManageWorkspaces || refreshing.value) return false;
  refreshing.value = true;
  refreshError.value = null;
  try {
    await workspaces.refresh(ctx.value, { silent: true });
    if (config.connected || config.localRuntimeReady) await reminders.refreshWorkspaceSummaries(ctx.value);
    return true;
  } catch (e) {
    refreshError.value = e instanceof Error ? e.message : String(e);
    if (!props.compact) message.error(refreshError.value);
    return false;
  } finally {
    refreshing.value = false;
  }
};

/** 用户主动切换工作区：先保存草稿，再应用内切换，避免整页刷新造成白屏。 */
const switchWorkspaceFromUserAction = (workspaceId: string): void => {
  const target = workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
  trackProductEvent("workspace_switch", { source: "workspace_selector", status: "started", workspace_type: isSharedWorkspace(target) ? "shared" : "local" });
  config.switchWorkspace(workspaceId, { flushDrafts: true, source: "workspace_selector" });
};

/** 桌面直接选择本机创建，其他环境沿现有在线 Client 选择。 */
const openCreate = () => {
  if (!config.canManageWorkspaces) {
    message.warning(config.isDesktop ? "本地运行时尚未就绪" : "请先连接 Server");
    return;
  }
  if (!createClients.value.length) {
    message.warning("请先让至少一个 Client 在线");
    return;
  }
  modalMode.value = "create";
  modalInitial.value = { title: "", path: "", clientId: resolveDefaultCreateClientId() ?? undefined };
  createOpen.value = true;
};

/** 编辑当前本地工作区，共享关系继续由共享入口维护。 */
const openEdit = () => {
  if (!config.canManageWorkspaces) return;
  const w = selectedWorkspace.value;
  if (!w) {
    message.warning("请先选择工作区");
    return;
  }
  if (isSharedWorkspace(w)) {
    message.info("共享工作区请在共享空间设置中维护共享关系，不能作为本地工作区编辑");
    return;
  }
  modalMode.value = "edit";
  modalInitial.value = {
    workspaceId: w.id,
    title: w.title,
    path: w.path,
    clientId: presence.clientForWorkspace(w.id)?.clientId ?? undefined,
  };
  createOpen.value = true;
};

/** 离线也可移除账号入口；失败保留确认框并展示原因。 */
const confirmDelete = () => {
  if (!config.canManageWorkspaces) return;
  const w = selectedWorkspace.value;
  if (!w) {
    message.warning("请先选择工作区");
    return;
  }
  if (isSharedWorkspace(w)) {
    message.info("共享工作区请在共享空间设置中维护共享关系，不能作为本地工作区移除");
    return;
  }
  Modal.confirm({
    title: "移除工作区",
    content: config.isDesktop
      ? "将从本机列表移除该工作区。历史会话与元数据保留，重新添加同一目录可恢复。"
      : "将从账号列表移除该工作区，Client 离线时也可移除。本地历史会话与元数据保留，主动重新添加同一工作区可恢复。",
    okText: "移除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      try {
        await workspaces.delete(ctx.value, w.id);
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (config.workspaceId === w.id) {
        switchWorkspaceFromUserAction(workspaces.workspaces.length ? workspaces.workspaces[0]!.id : "");
      }
      message.success("已移除");
    },
  });
};

/** 保存工作区后切到该工作区，由应用内切换重建当前工作区上下文。 */
const onModalConfirm = async (payload: { workspaceId?: WorkspaceId; title: string; path: string; clientId?: string }) => {
  if (!config.canManageWorkspaces) return;
  saving.value = true;
  try {
    const w = await workspaces.upsert(ctx.value, payload);
    switchWorkspaceFromUserAction(w.id);
    createOpen.value = false;
    message.success("工作区已保存");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
};

/** 桌面新工作区默认归本机，避免要求用户理解 Client 归属。 */
const resolveDefaultCreateClientId = (): string | null => {
  if (config.localRuntimeReady) return config.desktopClient!.clientId;
  const currentClientId = presence.clientForWorkspace(config.workspaceId)?.clientId ?? null;
  if (currentClientId) return currentClientId;
  return createClients.value.length === 1 ? createClients.value[0]!.clientId : null;
};

/** 每次展开重新读取 Host 状态，关闭时只清空搜索。 */
const handleCompactOpenChange = (nextOpen: boolean): void => {
  compactOpen.value = nextOpen;
  if (nextOpen) void refresh();
  else compactQuery.value = "";
};

/** 紧凑入口选择工作区后关闭弹层；应用内切换负责后续上下文重建。 */
const handleCompactSelect = (workspaceId: string) => {
  const option = options.value.find((item) => item.value === workspaceId);
  if (option?.disabled) {
    message.warning(option.disabledReason || "共享工作区当前不可进入");
    return;
  }
  switchWorkspaceFromUserAction(workspaceId);
  compactOpen.value = false;
  compactQuery.value = "";
};

</script>

<template>
  <div v-if="props.compact" class="ws-compact-actions">
  <a-popover
    :open="compactOpen"
    placement="bottomLeft"
    trigger="click"
    @update:open="handleCompactOpenChange"
  >
    <template #content>
      <div class="ws-compact-panel">
        <div class="ws-compact-panel__header">
          <div class="ws-compact-panel__title">切换工作区</div>
          <a-button type="text" size="small" :loading="refreshing" :disabled="!canOperate" aria-label="刷新工作区列表" @click.stop="refresh">
            <template #icon><ReloadOutlined /></template>
            刷新
          </a-button>
        </div>
        <a-alert v-if="refreshError" type="error" :message="refreshError" show-icon />
        <a-input
          v-model:value="compactQuery"
          allow-clear
          placeholder="搜索工作区名称、目录或共享工作区"
        />
        <div class="ws-compact-panel__list">
          <button
            v-for="option in filteredOptions"
            :key="option.value"
            type="button"
            :disabled="option.disabled"
            class="ws-compact-option"
            :class="{ 'ws-compact-option--active': option.value === selectedWorkspaceValue, 'ws-compact-option--disabled': option.disabled }"
            @click="handleCompactSelect(option.value)"
          >
            <div class="ws-compact-option__top">
              <div class="ws-compact-option__title">
                <span class="ws-compact-option__name" :title="option.rawLabel || option.label">{{ option.displayLabel }}</span>
                <span
                  class="ws-compact-option__kind"
                  :class="option.kindClass === 'shared' ? 'ws-compact-option__kind--shared' : 'ws-compact-option__kind--local'"
                >
                  {{ option.kindLabel }}
                </span>
              </div>
              <div class="ws-compact-option__source">
                <span
                  v-if="option.hostOwnerLabel"
                  class="ws-compact-option__host"
                  :title="`Host 所属人：${option.hostOwnerLabel}`"
                >
                  Host {{ option.hostOwnerLabel }}
                </span>
                <span
                  v-else-if="!option.shared && option.clients.length"
                  class="ws-compact-option__client-inline"
                  :title="formatClientNames(option.clients)"
                >
                  · {{ formatClientNames(option.clients) }}
                </span>
              </div>
              <div class="ws-compact-option__badges">
                <span v-if="option.hostMaintenance?.active" class="ws-compact-option__status ws-compact-option__status--maintenance">维护中</span>
                <span
                  class="ws-compact-option__status"
                  :class="option.online ? 'ws-compact-option__status--online' : 'ws-compact-option__status--offline'"
                >
                  {{ option.shared ? option.statusLabel : option.online ? "在线" : "离线" }}
                </span>
                <span v-if="option.pendingActionCount > 0" class="ws-compact-option__reminder ws-compact-option__reminder--action">
                  {{ option.pendingActionCount }} 待处理
                </span>
                <span v-if="option.pendingReceiptCount > 0" class="ws-compact-option__reminder ws-compact-option__reminder--receipt">
                  {{ option.pendingReceiptCount }} 待查收
                </span>
                <span v-if="option.value === selectedWorkspaceValue" class="ws-compact-option__current">当前</span>
              </div>
            </div>
            <div class="ws-compact-option__path" :title="option.path">{{ option.displayPath }}</div>
            <div v-if="option.disabledReason" class="ws-compact-option__hint">
              {{ option.disabledReason }}
            </div>
          </button>
          <div v-if="!filteredOptions.length" class="ws-compact-panel__empty">没有匹配的工作区</div>
        </div>
      </div>
    </template>
    <button
      ref="triggerRef"
      type="button"
      class="ws-compact-trigger"
      :disabled="!config.canManageWorkspaces"
      title="点击切换工作区"
      :aria-label="selectedWorkspace ? `切换工作区，当前 ${getWorkspaceDisplayTitle(selectedWorkspace)}` : '切换工作区'"
    >
      <FolderOutlined class="ws-compact-trigger__icon" aria-hidden="true" />
      <span class="ws-compact-trigger__main">
        <span class="ws-compact-trigger__title">{{ selectedWorkspace ? getWorkspaceDisplayTitle(selectedWorkspace) : "选择工作区" }}</span>
      </span>
      <span v-if="otherWorkspaceReminderSummary.pendingActionCount > 0" class="ws-compact-trigger__reminder ws-compact-trigger__reminder--action">
        {{ otherWorkspaceReminderSummary.pendingActionCount }}
      </span>
      <DownOutlined
        class="ws-compact-trigger__switch"
        :class="{ 'ws-compact-trigger__switch--open': compactOpen }"
        aria-hidden="true"
      />
    </button>
  </a-popover>
  <button
    ref="createRef"
    type="button"
    class="ws-compact-create"
    :class="{ 'ws-compact-create--desktop': config.isDesktop }"
    :disabled="!canOperate"
    title="新建工作区"
    aria-label="新建工作区"
    @click="openCreate"
  >
    <PlusOutlined />
  </button>
  </div>

  <div v-else :style="props.dense ? { display: 'grid', gap: '10px' } : { display: 'inline-flex', gap: '8px', alignItems: 'center' }">
    <a-select
      :value="selectedWorkspaceValue"
      :style="props.dense ? { width: '100%' } : { minWidth: '320px' }"
      :options="options"
      :disabled="!config.canManageWorkspaces || !workspaces.workspaces.length"
      placeholder="选择工作区"
      @change="switchWorkspaceFromUserAction"
    >
      <template #option="{ label, displayLabel, path, displayPath, clients, online, shared, kindLabel, kindClass, hostOwnerLabel, statusLabel, disabledReason, pendingActionCount, pendingReceiptCount, hostMaintenance }">
        <a-tooltip :title="path" placement="right">
          <div class="ws-option">
            <div class="ws-option__title">
              <span class="ws-option__name">{{ displayLabel }}</span>
              <a-tag :color="kindClass === 'shared' ? 'blue' : 'default'">{{ kindLabel }}</a-tag>
              <a-tag v-if="hostOwnerLabel">Host {{ hostOwnerLabel }}</a-tag>
              <a-tag v-if="hostMaintenance?.active" color="orange">维护中</a-tag>
              <template v-if="!shared && clients.length">
                <span v-for="ci in clients" :key="ci.clientId" class="ws-option__client ws-option__client--online" :title="ci.clientId">{{ ci.name || ci.clientId }}</span>
              </template>
              <span v-else class="ws-option__client ws-option__client--offline">{{ shared ? statusLabel : "离线" }}</span>
              <span v-if="pendingActionCount > 0" class="ws-option__reminder ws-option__reminder--action">{{ pendingActionCount }} 待处理</span>
              <span v-if="pendingReceiptCount > 0" class="ws-option__reminder ws-option__reminder--receipt">{{ pendingReceiptCount }} 待查收</span>
            </div>
            <div class="ws-option__path">{{ shared ? displayPath : shortenPath(path) }}</div>
            <div v-if="disabledReason" class="ws-option__hint">{{ disabledReason }}</div>
          </div>
        </a-tooltip>
      </template>
    </a-select>
    <a-space v-if="showActions">
      <a-tooltip v-if="selectedPath" :title="selectedPath">
        <a-tag color="blue">path</a-tag>
      </a-tooltip>
      <a-button size="small" :loading="refreshing" :disabled="!config.canManageWorkspaces" @click="refresh">刷新</a-button>
      <a-button size="small" type="primary" :disabled="!canOperate" @click="openCreate">新增</a-button>
      <a-dropdown :trigger="['click']">
        <a-button size="small" :disabled="!config.canManageWorkspaces || !selectedWorkspace" @click.stop>管理</a-button>
        <template #overlay>
          <a-menu>
            <a-menu-item @click="openEdit">编辑</a-menu-item>
            <a-menu-item @click="confirmDelete">移除</a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
    </a-space>
  </div>

  <a-tour
    v-if="props.compact"
    :open="tourOpen"
    :steps="workspaceTourSteps"
    @close="markWorkspaceTourSeen"
    @finish="markWorkspaceTourSeen"
  />

  <CreateWorkspaceModal
    v-model:open="createOpen"
    :saving="saving"
    :mode="modalMode"
    :initial="modalInitial"
    :clients="createClients"
    :local-runtime="config.isDesktop"
    @confirm="onModalConfirm"
  />
</template>

<style scoped>
.ws-compact-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ws-compact-create {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--app-accent) 18%, var(--app-divider));
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  color: var(--app-accent);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.ws-compact-create:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ws-compact-create:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--app-accent) 46%, transparent);
  background: color-mix(in srgb, var(--app-accent) 10%, var(--app-panel-bg));
  color: var(--app-accent);
}

/* 无边框桌面顶栏使用品牌橙底，新建入口改为轻量半透明幽灵按钮。 */
.ws-compact-create--desktop {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.82);
  box-shadow: none;
}

.ws-compact-create--desktop:hover:not(:disabled),
.ws-compact-create--desktop:focus,
.ws-compact-create--desktop:focus-visible,
.ws-compact-create--desktop:active {
  border-color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}

.ws-compact-trigger {
  width: clamp(160px, 18vw, 220px);
  height: 32px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--app-accent) 18%, var(--app-divider));
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  cursor: pointer;
  transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}

.ws-compact-trigger:hover {
  border-color: color-mix(in srgb, var(--app-accent) 46%, transparent);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);
}

.ws-compact-trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 18%, transparent);
}

.ws-compact-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.68;
  transform: none;
}

.ws-compact-trigger__main {
  flex: 1;
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.ws-compact-trigger__title {
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
}

.ws-compact-trigger__icon {
  flex: 0 0 auto;
  font-size: 14px;
  color: var(--app-accent);
}

.ws-compact-trigger__switch {
  flex: 0 0 auto;
  margin-top: 1px;
  font-size: 10px;
  color: color-mix(in srgb, var(--app-muted) 82%, transparent);
  transition: transform 0.18s ease, color 0.18s ease;
}

.ws-compact-trigger:hover:not(:disabled) .ws-compact-trigger__switch {
  color: var(--app-accent);
}

.ws-compact-trigger__switch--open {
  color: var(--app-accent);
  transform: rotate(180deg);
}

.ws-compact-trigger__reminder {
  flex: 0 0 auto;
  min-width: 8px;
  min-height: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}

.ws-compact-trigger__reminder--action {
  color: #cf1322;
  background: #fff1f0;
  border: 1px solid #ffa39e;
}

.ws-compact-panel {
  --ws-compact-source-column: 116px;
  --ws-compact-badges-column: 208px;
  width: min(540px, calc(100vw - 48px));
  display: grid;
  gap: 10px;
}

.ws-compact-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ws-compact-panel__title {
  font-size: 14px;
  font-weight: 700;
  color: var(--app-text);
}

.ws-compact-panel__list {
  max-height: min(52vh, 360px);
  overflow: auto;
  display: grid;
  gap: 2px;
  padding-right: 2px;
}

.ws-compact-panel__empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--app-muted);
  border: 1px dashed var(--app-divider);
  border-radius: 10px;
}

.ws-compact-option {
  width: 100%;
  padding: 6px 8px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}

.ws-compact-option:hover {
  border-color: color-mix(in srgb, var(--app-accent) 22%, transparent);
  background: color-mix(in srgb, var(--app-accent) 6%, var(--app-panel-bg));
}

.ws-compact-option--active {
  border-color: color-mix(in srgb, var(--app-accent) 46%, transparent);
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
  box-shadow: none;
}

.ws-compact-option--disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.ws-compact-option__top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--ws-compact-source-column) var(--ws-compact-badges-column);
  align-items: center;
  column-gap: 10px;
  row-gap: 3px;
}

.ws-compact-option__title {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}

.ws-compact-option__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
}

.ws-compact-option__source {
  min-width: 0;
  display: flex;
  justify-content: flex-start;
}

.ws-compact-option__client-inline {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-muted);
}

.ws-compact-option__host {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-muted);
}

.ws-compact-option__kind,
.ws-compact-option__role {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  border: 1px solid transparent;
}

.ws-compact-option__kind--shared {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--app-accent) 22%, transparent);
}

.ws-compact-option__kind--local {
  color: #595959;
  background: #fafafa;
  border-color: #d9d9d9;
}

.ws-compact-option__role {
  color: #595959;
  background: #fafafa;
  border-color: #d9d9d9;
}

.ws-compact-option__badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  min-width: 0;
  row-gap: 3px;
}

.ws-compact-option__status,
.ws-compact-option__current {
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  border: 1px solid transparent;
}

.ws-compact-option__status--online {
  color: #237804;
  background: #f6ffed;
  border-color: #b7eb8f;
}

.ws-compact-option__status--offline {
  color: #8c8c8c;
  background: #fafafa;
  border-color: #d9d9d9;
}

.ws-compact-option__status--maintenance {
  color: #ad6800;
  background: #fffbe6;
  border-color: #ffe58f;
}

.ws-compact-option__reminder {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
  border: 1px solid transparent;
}

.ws-compact-option__reminder--action {
  color: #cf1322;
  background: #fff1f0;
  border-color: #ffa39e;
}

.ws-compact-option__reminder--receipt {
  color: #237804;
  background: #f6ffed;
  border-color: #b7eb8f;
}

.ws-compact-option__current {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--app-accent) 24%, transparent);
}

.ws-compact-option__path {
  margin-top: 3px;
  padding-right: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-muted);
}

@media (max-width: 520px) {
  .ws-compact-panel {
    --ws-compact-badges-column: 118px;
  }

  .ws-compact-option__top {
    grid-template-columns: minmax(0, 1fr) var(--ws-compact-badges-column);
  }

  .ws-compact-option__source {
    grid-column: 1;
    grid-row: 2;
  }

  .ws-compact-option__badges {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
}

.ws-compact-option__hint,
.ws-option__hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--app-muted);
}

.ws-option__title {
  font-size: 14px;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ws-option__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-option__path {
  font-size: 12px;
  color: #999;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-left: 13px;
}

.ws-option__client {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 1.5;
}

.ws-option__client--online {
  background: #f6ffed;
  color: #52c41a;
  border: 1px solid #b7eb8f;
}

.ws-option__client--offline {
  background: #fff1f0;
  color: #ff4d4f;
  border: 1px solid #ffa39e;
}

.ws-option__reminder {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  line-height: 1.6;
}

.ws-option__reminder--action {
  color: #cf1322;
  background: #fff1f0;
  border: 1px solid #ffa39e;
}

.ws-option__reminder--receipt {
  color: #237804;
  background: #f6ffed;
  border: 1px solid #b7eb8f;
}

/* 深色模式：状态色块换为深底+柔和色字，避免浅底压暗整页 */
:root[data-theme="dark"] .ws-compact-trigger__reminder--action,
:root[data-theme="dark"] .ws-compact-option__reminder--action,
:root[data-theme="dark"] .ws-option__reminder--action,
:root[data-theme="dark"] .ws-option__client--offline {
  color: #fda29b;
  background: rgba(239, 68, 68, 0.16);
  border-color: rgba(239, 68, 68, 0.4);
}

:root[data-theme="dark"] .ws-compact-option__status--online,
:root[data-theme="dark"] .ws-compact-option__reminder--receipt,
:root[data-theme="dark"] .ws-option__client--online,
:root[data-theme="dark"] .ws-option__reminder--receipt {
  color: #86efac;
  background: rgba(34, 197, 94, 0.16);
  border-color: rgba(34, 197, 94, 0.4);
}

:root[data-theme="dark"] .ws-compact-option__role,
:root[data-theme="dark"] .ws-compact-option__kind--local,
:root[data-theme="dark"] .ws-compact-option__status--offline,
:root[data-theme="dark"] .ws-compact-option__status--maintenance {
  color: var(--app-muted);
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.12);
}

:root[data-theme="dark"] .ws-option__path {
  color: var(--app-muted);
}

</style>
