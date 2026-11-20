<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { Alert, Button, ConfigProvider, Progress, Space } from "ant-design-vue";
import type { DesktopMigrationState } from "@codeflowai/shared";
import { getDesktopBridge } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { desktopAuthModalOpen } from "../../account/desktopAuthPromptState";

const emit = defineEmits<{ ready: []; interactive: [value: boolean] }>();
const props = defineProps<{ startupLabel?: string }>();
const WORKBENCH_READY_KEY = "codeflow:desktop-workbench-ready";
const workbenchReady = inject<Ref<boolean>>(WORKBENCH_READY_KEY, ref(true));
const bridge = getDesktopBridge();
const config = useConfigStore();
const state = ref<DesktopMigrationState | null>(null);
const actionError = ref<string | null>(null);
const busy = ref(false);
const localReady = ref(false);
const accountNoticeDismissed = ref(false);
const canDeferDiscovery = computed(() => state.value?.status === "failed" && state.value.canDefer === true && Boolean(bridge?.deferMigration));
const deferredMigrationNotice = computed(() => localReady.value && state.value?.status === "ready"
  && state.value.errorCode === "SOURCE_ACCOUNT_UNRESOLVED" ? state.value.message : null);
/** 已有有效登录时不再提醒恢复；保存失败仍明确展示，关闭只影响本次界面。 */
const showAccountNotice = computed(() => localReady.value && !accountNoticeDismissed.value
  && (Boolean(actionError.value) || Boolean(deferredMigrationNotice.value)
    || state.value?.account.status === "failed" && !(config.isAccountSession && config.hasActiveSession)));
// 启动页先于主应用挂载，按钮直接复用 CSS 主题变量，避免依赖主应用的主题容器。
const startupTheme = { components: { Button: {
  colorPrimary: "var(--app-accent)", colorPrimaryHover: "var(--app-accent)", colorPrimaryActive: "var(--app-accent)",
  colorText: "var(--app-muted)", colorBgTextHover: "var(--app-sidebar-hover-bg)", colorBgTextActive: "var(--app-sidebar-active-bg)",
} } };
let unsubscribe: (() => void) | undefined;
let applying = false;
let accountEpoch = 0;
let stateRevision = 0;
const percent = computed(() => state.value?.total ? Math.min(99, Math.floor(state.value.completed * 100 / state.value.total)) : undefined);
// 启动与迁移共用入口，尚未拿到状态时不提前显示迁移文案。
const stageLabel = computed(() => ({ discover: "正在检查本地数据", quiesce: "正在停止旧 Client", snapshot: "正在备份旧数据",
  convert: "正在迁移工作区与会话", verify: "正在校验数据", publish: "正在保存迁移结果",
  runtime_starting: props.startupLabel || "正在启动本地服务", completed: props.startupLabel || "正在加载工作台" }[state.value?.stage ?? ""]
  ?? (state.value?.status === "running" ? "正在迁移本地数据" : props.startupLabel || "正在连接本地工作台")));
// 只有已确认的迁移选择/失败处理页可独立就绪，自动启动仍等待实际工作台挂载。
watch(() => !localReady.value && (state.value?.status === "available" || state.value?.status === "failed"),
  value => emit("interactive", value), { flush: "sync" });

/** 每次启动只交付一次账号，业务关联等待宿主放行原 Runtime。 */
async function accept(value: DesktopMigrationState): Promise<void> {
  state.value = value;
  if (value.account.status === "cancelled") {
    accountEpoch++; actionError.value = null;
    if (value.status === "ready" && !localReady.value) { localReady.value = true; emit("ready"); }
    return;
  }
  if (value.status !== "ready" || value.account.status === "restoring" || applying || localReady.value) return;
  applying = true;
  const epoch = accountEpoch;
  let expectedScope = JSON.stringify([config.serverWsOrigin, config.sessionToken, config.userSummary?.userId, config.logoutInProgress]);
  /** 主动登出/切换是预期取消，迟到桥响应不能覆盖用户的新账号。 */
  const isCurrent = () => epoch === accountEpoch && state.value?.account.status !== "cancelled"
    && expectedScope === JSON.stringify([config.serverWsOrigin, config.sessionToken, config.userSummary?.userId, config.logoutInProgress]);
  try {
    const restored = await bridge?.takeMigrationAccount?.();
    if (!isCurrent()) return;
    if (restored) {
      const origin = new URL(restored.serverOrigin);
      origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
      config.serverWsOrigin = origin.origin;
      config.setAccountSession(restored.session);
      expectedScope = JSON.stringify([config.serverWsOrigin, config.sessionToken, config.userSummary?.userId, config.logoutInProgress]);
      config.persistAccountSession();
      await bridge?.acknowledgeMigrationAccount?.();
      if (!isCurrent()) return;
      await config.refreshDesktopRuntime();
      if (!isCurrent()) return;
      if (config.localRuntimeReady) await config.syncDesktopCloudAccount();
      if (!isCurrent()) return;
    }
    localReady.value = true;
    emit("ready");
  } catch (error) {
    if (!isCurrent()) return;
    const code = (error as { code?: unknown })?.code === "ACCOUNT_SESSION_PERSIST_FAILED" ? "ACCOUNT_SESSION_PERSIST_FAILED" : "MIGRATION_ACCOUNT_APPLY_FAILED";
    actionError.value = code === "ACCOUNT_SESSION_PERSIST_FAILED" ? "账号会话保存失败，请重新登录。" : "账号登录恢复失败，请重新登录。";
    console.error("[LEGACY_MIGRATION_ACCOUNT_APPLY_FAILED]", { migrationId: value.migrationId, requestId: value.migrationId,
      userId: config.userSummary?.userId, errorCode: code, rootCause: code === "ACCOUNT_SESSION_PERSIST_FAILED" ? "账号持久状态未通过读回校验" : "迁移账号交付或关联失败" });
    localReady.value = true;
    emit("ready");
  } finally { applying = false; }
}

/** 复用桌面登录窗口，提交登录时由原账号入口取消旧凭据恢复。 */
function openAccountLogin(): void {
  desktopAuthModalOpen.value = true;
}

/** 收起本次提醒，保留迁移与账号失败事实以供排障。 */
function dismissAccountNotice(): void {
  accountNoticeDismissed.value = true;
}

/** 操作失败留在页面展示，宿主已负责记录迁移阶段和根因。 */
async function perform(action: "start" | "defer"): Promise<void> {
  if (!bridge || busy.value) return;
  busy.value = true; actionError.value = null;
  try {
    if (action === "start") await bridge.startMigration!(state.value!.candidateId!);
    else if (action === "defer") await bridge.deferMigration!();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "操作失败，请重试";
  } finally { busy.value = false; }
}

onMounted(async () => {
  if (!bridge?.getMigrationState) { localReady.value = true; emit("ready"); return; }
  unsubscribe = bridge.onMigrationState?.(value => { stateRevision++; void accept(value); });
  const revision = stateRevision;
  try {
    const initial = await bridge.getMigrationState();
    if (revision === stateRevision) await accept(initial);
  }
  catch { actionError.value = "无法读取迁移状态，请关闭应用后重试。"; }
});
onBeforeUnmount(() => { unsubscribe?.(); });
</script>

<template>
  <ConfigProvider :theme="startupTheme">
    <aside v-if="showAccountNotice" class="desktop-migration__account" aria-live="polite">
      <Alert type="warning" show-icon closable close-text="关闭"
        :message="actionError || deferredMigrationNotice || '本地数据已迁移，账号未登录。'" @close="dismissAccountNotice">
        <template #action><Button size="small" @click="openAccountLogin">去登录</Button></template>
      </Alert>
    </aside>
    <main v-else-if="!workbenchReady" class="desktop-migration" :aria-busy="!state || state.status === 'checking' || state.status === 'running'">
      <section class="desktop-migration__content">
        <div class="desktop-migration__brand" aria-label="CodeFlow Desktop">
          <img class="desktop-migration__logo" src="/favicon.svg" alt="" />
          <span>CodeFlow<span class="desktop-migration__edition">DESKTOP</span></span>
        </div>
        <div class="desktop-migration__heading" aria-live="polite">
          <h1>{{ state?.status === 'available' ? '把工作带到新桌面' : state?.status === 'failed' ? '迁移暂未完成' : '正在准备您的工作台' }}</h1>
          <p v-if="state?.status === 'available'">发现旧版 Client 数据，迁移后即可继续工作。</p>
          <p v-else-if="canDeferDiscovery">旧数据保持原样，可稍后再迁移。</p>
          <p v-else-if="state?.status === 'failed'">请查看下方信息，然后重试迁移。</p>
        </div>
        <template v-if="state?.status === 'available'">
          <div class="desktop-migration__summary">
            <span class="desktop-migration__workspace-count">{{ state.workspaceCount }}<span>个工作区</span></span>
            <p>一并迁移会话与本地配置</p>
          </div>
          <p class="desktop-migration__note">迁移期间请稍候，完成后请使用桌面版。</p>
          <Space :size="12" wrap class="desktop-migration__actions">
            <Button type="primary" size="large" :loading="busy" @click="perform('start')">开始迁移</Button>
            <Button type="text" size="large" :disabled="busy" @click="perform('defer')">稍后再说</Button>
          </Space>
        </template>
        <template v-else-if="state?.status === 'failed'">
          <Alert v-if="!canDeferDiscovery" class="desktop-migration__error" type="error" show-icon :message="state.message || '迁移失败，原数据保留'" />
          <Space :size="12" wrap class="desktop-migration__actions">
            <Button v-if="state.candidateId" type="primary" size="large" :loading="busy" @click="perform('start')">重试迁移</Button>
            <Button v-if="canDeferDiscovery" type="primary" size="large" :loading="busy" @click="perform('defer')">暂不迁移，进入新桌面</Button>
          </Space>
        </template>
        <template v-else>
          <div class="desktop-migration__progress">
            <div class="desktop-migration__meter">
              <div v-if="percent === undefined" class="desktop-migration__track" role="progressbar" aria-label="正在准备工作台">
                <span class="desktop-migration__flow" />
              </div>
              <Progress v-else :percent="percent" :show-info="false" :stroke-width="3" stroke-color="var(--app-accent)" trail-color="var(--app-divider)" />
            </div>
            <div class="desktop-migration__status" role="status">
              <span v-if="stageLabel">{{ stageLabel }}</span>
              <span v-if="state?.total !== null && state?.total !== undefined" class="desktop-migration__count">{{ state.completed }} / {{ state.total }}</span>
            </div>
          </div>
        </template>
        <Alert v-if="actionError" class="desktop-migration__error desktop-migration__actions" type="error" show-icon :message="actionError" />
      </section>
      <footer class="desktop-migration__footer">CodeFlow · 你的 AI 开发工作台</footer>
    </main>
  </ConfigProvider>
</template>

<style scoped>
.desktop-migration {
  /* 清除静态启动页导航后残留的原生拖拽区域，保证按钮接收点击。 */
  -webkit-app-region: no-drag;
  height: 100vh;
  height: 100dvh;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--app-bg);
  color: var(--app-text);
  padding: 32px 24px 24px;
  box-sizing: border-box;
}
.desktop-migration__content {
  width: min(100%, 480px);
  max-height: 100%;
  min-height: 0;
  justify-self: center;
  align-self: center;
  overflow: auto;
  padding: 32px 20px 48px;
  text-align: center;
}
.desktop-migration__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-bottom: 44px;
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -1px;
}
.desktop-migration__logo { width: 62px; height: 36px; object-fit: contain; }
.desktop-migration__edition {
  display: block;
  margin-top: 8px;
  color: var(--app-muted);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 3px;
}
.desktop-migration__heading h1 { margin: 0; font-size: 24px; font-weight: 550; line-height: 1.5; letter-spacing: 0.5px; }
.desktop-migration__heading p { margin: 12px 0 0; color: var(--app-muted); font-size: 14px; line-height: 1.8; }
.desktop-migration__progress { width: min(100%, 300px); margin: 34px auto 0; }
.desktop-migration__meter { display: flex; align-items: center; height: 3px; }
.desktop-migration__track { width: 100%; height: 3px; overflow: hidden; border-radius: 3px; background: var(--app-divider); }
.desktop-migration__flow {
  display: block;
  width: 38%;
  height: 100%;
  border-radius: inherit;
  background: var(--app-accent);
  animation: desktop-startup-flow 1.8s ease-in-out infinite;
}
.desktop-migration__status { display: flex; justify-content: center; flex-wrap: wrap; gap: 6px 16px; margin-top: 14px; color: var(--app-muted); font-size: 12px; line-height: 1.8; }
.desktop-migration__count { font-variant-numeric: tabular-nums; }
.desktop-migration__summary { margin: 28px 0 0; padding: 22px; border: 1px solid var(--app-divider); border-radius: 16px; background: var(--app-panel-bg); }
.desktop-migration__workspace-count { display: inline-flex; align-items: baseline; gap: 8px; font-size: 28px; font-weight: 600; line-height: 1.4; font-variant-numeric: tabular-nums; }
.desktop-migration__workspace-count > span { font-size: 14px; font-weight: 400; }
.desktop-migration__summary p { margin: 6px 0 0; color: var(--app-muted); font-size: 13px; }
.desktop-migration__note { margin: 18px 0 0; color: var(--app-muted); font-size: 12px; line-height: 1.8; }
.desktop-migration__actions { margin-top: 24px; }
.desktop-migration__error { margin-top: 24px; text-align: left; overflow-wrap: anywhere; }
.desktop-migration__footer { padding-top: 16px; text-align: center; color: var(--app-muted); font-size: 11px; letter-spacing: 1px; }
.desktop-migration__account { position: fixed; right: 20px; bottom: 20px; width: min(480px, calc(100vw - 40px)); z-index: 1500; }
@keyframes desktop-startup-flow {
  0% { transform: translateX(-105%); }
  100% { transform: translateX(365%); }
}
@media (prefers-reduced-motion: reduce) {
  .desktop-migration__flow { animation: none; width: 100%; opacity: 0.6; }
}
@media (max-width: 480px) {
  .desktop-migration { padding: 20px 16px; }
  .desktop-migration__content { padding: 24px 8px; }
  .desktop-migration__brand { margin-bottom: 32px; }
  .desktop-migration__heading h1 { font-size: 21px; }
}
</style>
