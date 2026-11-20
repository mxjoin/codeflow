import path from "node:path";
import crypto from "node:crypto";
import { readPendingRelease, savePendingRelease, clearPendingRelease, markPendingDatabaseMigration, type PendingRelease } from "./pendingRelease.js";
import { createReleaseDatabaseBackup } from "./releaseDatabaseBackup.js";
import { assertReleaseBundleManifest, assertShellReleaseManifest, compareNumericVersion, snapshotDesktopStartupMode, snapshotDesktopStartupReady, type DesktopApiRequest, type DesktopStartupMode, type DesktopEvent, type DesktopUpdateDiagnostics, type DesktopUpdateState, type DesktopUpdateDetails, type DesktopBundleVersion, type DesktopUpdateNotice, type DesktopUpdateNoticeDismissAction, type DesktopUpdateProgress, type DesktopUpdateClientErrorReport } from "@codeflowai/shared";
import { toUpdateDiagnosticCause, toShellUpdateDiagnosticCause } from "@codeflowai/shared/desktop-update-failure";

import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "./deviceIdentity.js";
import type { LegacyClientMigration } from "./legacyClientMigration.js";
import type { StartupStatus } from "./webLoader.js";
import { createClientRuntime, type ClientCliRuntime, type ClientRuntime, type ClientRuntimeExpectation, type ClientRuntimeSnapshot } from "./clientRuntime.js";
import { createDesktopBridge } from "./preload.js";
import type { DesktopBridgeApi } from "./contracts.js";
import { createReleaseBundleCoordinator, DesktopUpdatePostponed, readActivePointer, resolveActiveRelease, resolveBaselineRelease, clearIncompatibleActiveRelease, type ActiveRelease, type PreparedRelease } from "./releaseBundleCoordinator.js";
import { createDesktopUpdateReceipt, type DesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import type { TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";
import { createDesktopUpdateTransport } from "./updateTransport.js";
import { createUpdateReceiptJournal } from "./updateReceiptJournal.js";
import { createUpdateReceiptDelivery } from "./updateReceiptDelivery.js";
import { createUpdateFailureJournal } from "./updateFailureJournal.js";
import { deliverDesktopUpdateFailures } from "./updateFailureDelivery.js";
import type { CrashReportJournal } from "./crashReportJournal.js";
import { deliverDesktopCrashReports } from "./crashReportDelivery.js";
import { downloadReleaseBundle, verifyDownloadManifest, type DownloadOptions } from "./releaseBundleDownload.js";
import { createUpdateNetworkRetry, type UpdateNetworkRetry } from "./updateNetworkRetry.js";
import { runShellUpdateOperation, type ShellUpdateHostFacts, type ShellUpdateOperationBoundary, type ShellUpdateHelperOwner } from "./shellUpdateOperation.js";
import type { ShellDiscovery } from "./shellUpdateNetwork.js";
import { retireShellUpdateAttempt } from "./shellHandoff.js";
import { createUpdateNoticeController, type PreparedUpdateNotice } from "./updateNotice.js";

type ApplicationDownloadOptions = Omit<DownloadOptions, "transport" | "rootDir" | "trustedReleaseKeys" | "receivedReporter">;
type ApplicationDiscoveryOptions = { requestId?: string; signal?: AbortSignal };
type DownloadedRelease = Awaited<ReturnType<typeof downloadReleaseBundle>>;
type CombinedUpdateDiscovery = { resource: { manifest: DownloadedRelease['manifest']; manifestBytes: Uint8Array } | null;
  shell: ShellDiscovery; resourceError?: Error; shellError?: Error };
type DesktopWindow = {
  show(): void;
  focus(): void;
  hide(): void;
  destroy(): void;
  isMinimized?(): boolean;
  restore?(): void;
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
};

export type DesktopHost = {
  createWindow(): DesktopWindow;
  /** 可选壳内静态启动页；不能读取待验证资源或开放业务桥。 */
  loadStartup?(window: DesktopWindow): Promise<void>;
  /** 页面先导航展示，本地启动任务收口后再开始页面就绪预算。 */
  loadWeb(window: DesktopWindow, releaseDir: string, options?: { beforeReady?: () => Promise<void> }): Promise<void>;
  /** 启动页阶段进度；提示失败只记录，不改变启动或更新结果。 */
  updateStartupStatus?(window: DesktopWindow, status: StartupStatus): Promise<void> | void;
  createTray(open: () => void, exit: () => Promise<void>, checkForUpdates?: () => void): { destroy(): void };
  registerBridge(bridge: DesktopBridgeApi, window: DesktopWindow): () => void;
  /** 仅在存在运行中会话时确认是否中断并更新。 */
  confirmUpdate?(window: DesktopWindow, signal?: AbortSignal): Promise<boolean>;
  /** 后台失败由主进程展示或记录；logOnly仅预记首错，不提前展示UI。 */
  onUpdateError?(error: unknown, context: { requestId: string; deviceId: string; logOnly?: boolean }): void;
  /** 启动或迁移窗口退出失败保留进程 owner，由宿主显式展示错误。 */
  onMigrationError?(error: unknown): void;
  onUpdateRetry?(context: { requestId: string; deviceId: string; retry: number; delayMs: number; error: unknown }): void;
  /** 下载完成提醒；宿主负责唤起窗口并推送到渲染进程。 */
  onUpdateNotice?(notice: DesktopUpdateNotice): void;
  /** 应用资源下载进度；宿主推送到渲染进程，null 表示离开下载阶段。 */
  onUpdateProgress?(progress: DesktopUpdateProgress): void;
  /** 本次启动已应用待更新资源；仅用于完成提示，不改变启动结果。 */
  onUpdateApplied?(facts: { version: string }): void;
  quit(): void;
  /** 正常退出完成清理后登记下一次启动；不立即强制退出。 */
  relaunch?(): void;
};

export type DesktopStartupReadyFacts = {
  client: ClientRuntimeSnapshot; baseline: Awaited<ReturnType<typeof resolveBaselineRelease>>; active: ActiveRelease | null;
  web: { loaded: true; releaseDir: string };
  /** 关联本次应用层continue操作，不是ClientRuntime内部native IPC请求ID。 */
  continueRequestId: string;
};

/** 仅此失败表示仍需保留进程管理权，不能直接退出主进程。 */
export class DesktopStartupCleanupError extends AggregateError {
  /** 同时保留启动根因与 Client 或迁移 Worker 未完成清理的原因。 */
  constructor(startupError: unknown, cleanupError: unknown) {
    super([startupError, cleanupError], "DESKTOP_STARTUP_CLEANUP_FAILED");
  }
}

/** 管理壳的单一生命周期；Electron 适配与业务运行时分别由现有边界承接。 */
export function createDesktopApplication(input: {
  dataDir: string;
  initialReleaseDir: string;
  /** 签名基线目录；dev 可指向测试发布资源，缺省与 initialReleaseDir 相同。 */
  baselineReleaseDir?: string;
  /** 正式完整安装必须携带签名基线，开发夹具可显式保持无基线。 */
  requireBaseline?: boolean;
  /** 桌面私有 CLI 运行时绝对路径；缺失时 Client 沿用系统安装 CLI。 */
  cliRuntime?: ClientCliRuntime | ((releaseDir: string) => ClientCliRuntime | undefined);
  shellVersion?: string;
  trustedReleaseKeys?: TrustedReleaseKeys;
  host: DesktopHost;
  /** 可选阶段回执边界；未注入时保持离线且不联网。 */
  reportReceipt?: (receipt: DesktopUpdateReceipt) => Promise<void>;
  /** 固定 Server origin；缺失时保持本地运行但禁用网络更新。 */
  configuredServerOrigin?: string;
  /** 壳崩溃证据日志；仅在下次启动补报，不在运行中主动上传。 */
  crashJournal?: CrashReportJournal;
  /** 运行时版本和身份就绪后更新后续崩溃报告上下文。 */
  onRuntimeFacts?: (facts: { deviceId: string; versions: { webVersion: string; clientVersion: string; releaseId: string } }) => void;
  /** Client 子进程退出观察；主动停止由 expected 标记。 */
  onClientExit?: (facts: { exitCode: number | null; signal: string | null; expected: boolean }) => void;
  /** 主动销毁窗口和运行时前通知崩溃捕获，避免退出期误报。 */
  onShutdown?: () => void;
  startupContinuation?: { continuationId: string; authorizeReady(facts: DesktopStartupReadyFacts): Promise<void> };
  /** 宿主提供实际profile与main事实；未接宿主时不创建第二更新入口。 */
  shellUpdate?: { facts: ShellUpdateHostFacts; boundary?: Partial<ShellUpdateOperationBoundary>; timeoutMs?: number };
  createRuntime?: (entry: string, expectedRelease?: ClientRuntimeExpectation, startup?: DesktopStartupMode) => ClientRuntime;
  /** 固定资源选择完成后创建迁移 owner；换壳接续不改变原授权路径。 */
  createMigration?: (facts: { releaseDir: string; identity: DeviceIdentity }) => LegacyClientMigration | undefined;
}) {
  const baselineReleaseDir = input.baselineReleaseDir ?? input.initialReleaseDir;
  const continuationInput = input.startupContinuation;
  let continuation: typeof continuationInput;
  if (continuationInput !== undefined) {
    const descriptors = Object.getOwnPropertyDescriptors(continuationInput);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(continuationInput)) || Reflect.ownKeys(continuationInput).length !== 2
      || !descriptors.continuationId || !("value" in descriptors.continuationId) || !descriptors.authorizeReady || !("value" in descriptors.authorizeReady)
      || typeof descriptors.authorizeReady.value !== "function") throw new Error("DESKTOP_STARTUP_INPUT_INVALID");
    const mode = snapshotDesktopStartupMode({ mode: "held", continuationId: descriptors.continuationId.value });
    if (mode.mode !== "held") throw new Error("DESKTOP_STARTUP_INPUT_INVALID");
    continuation = { continuationId: mode.continuationId, authorizeReady: descriptors.authorizeReady.value };
  }
  let initialStartup: DesktopStartupMode = continuation ? { mode: "held", continuationId: continuation.continuationId } : { mode: "automatic" };
  const createRuntime = input.createRuntime ?? ((entry, expectedRelease, startup) => createClientRuntime({ entry, expectedRelease, startup, dataDir: input.dataDir,
    cliRuntime: typeof input.cliRuntime === "function" ? input.cliRuntime(path.resolve(entry, "../../..")) : input.cliRuntime,
    onExit: facts => input.onClientExit?.(facts) }));
  /** Client 保持现有完整 npm 包结构，以复用原生依赖与 worker 相对路径。 */
  const clientEntry = (releaseDir: string): string => path.join(releaseDir, "client", "dist", "index.cjs");
  let runtime = createRuntime(clientEntry(input.initialReleaseDir), undefined, initialStartup);
  let window: DesktopWindow | null = null;
  let tray: { destroy(): void } | null = null;
  let unregister: (() => void) | null = null;
  let unsubscribeRuntime: (() => void) | null = null;
  const eventListeners = new Set<(event: DesktopEvent) => void>();
  let operation: "idle" | "starting" | "exiting" | "checking" | "updating" | "downloading" | "flushing" = "idle";
  let automaticUpdates = false;
  let updatesSuppressed = false;
  let stoppingUpdates = false;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  let presenceTransport: ReturnType<typeof createDesktopUpdateTransport> | undefined;
  let telemetryTimer: ReturnType<typeof setTimeout> | undefined;
  let telemetryFlight: Promise<void> | undefined;
  let updateFlight: Promise<ActiveRelease | null> | undefined;
  /** 手动检查复用进行中的自动轮次时，结束后仍需按“已查看”刷新提醒节流。 */
  let updateFlightManualRequested = false;
  let updateSettled: Promise<void> | undefined;
  let updateController: AbortController | undefined;
  let networkContext: { signal: AbortSignal; retry: UpdateNetworkRetry } | undefined;
  let checkDiscoveries: Map<string, Promise<CombinedUpdateDiscovery>> | undefined;
  let pendingUpdate: { requestId: string; manifest: DownloadedRelease["manifest"]; manifestBytes: Uint8Array; downloaded?: DownloadedRelease } | undefined;
  let preparedUpdate: PreparedRelease | undefined;
  let restartRequested = false;
  let startupHeldId: string | undefined;
  const databaseBackup = createReleaseDatabaseBackup(input.dataDir);
  let switchCommitted = false;
  let updateCheckFailure: { requestId: string; error: unknown } | null = null;
  let shellUpdateFailure: { requestId: string; error: unknown } | null = null;
  let shellOwner: ShellUpdateHelperOwner | undefined;
  let shellDrainedRuntime: ClientRuntime | undefined;
  const updateStopReason = new Error("DESKTOP_UPDATE_STOPPED");
  let initialExpectation: ClientRuntimeExpectation | undefined;
  let identity: DeviceIdentity | undefined;
  let cloudLinkPreparation: AbortController | undefined;
  /** 只撤销尚在准备的云关联；已转交 Client 的账号资格仍由原连接 owner 管理。 */
  const cancelCloudLinkPreparation = (): void => {
    cloudLinkPreparation?.abort(Object.assign(new Error("DESKTOP_CLOUD_LINK_CANCELLED"), { code: "DESKTOP_CLOUD_LINK_CANCELLED" }));
    cloudLinkPreparation = undefined;
  };
  /** 先撤销旧账号并向目标 Server 登记签名身份，确认后才允许 Client 关联和同步任务。 */
  const linkCloudAccount = async (request: DesktopApiRequest) => {
    const body = request.body;
    if (typeof body?.serverOrigin !== "string" || !URL.canParse(body.serverOrigin)) throw new Error("DESKTOP_CLOUD_ORIGIN_INVALID");
    if (Object.keys(body).some(key => key !== "serverOrigin" && key !== "sessionToken")) throw new Error("DESKTOP_API_REQUEST_INVALID");
    const url = new URL(body.serverOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("DESKTOP_CLOUD_ORIGIN_INVALID");
    if (typeof body.sessionToken !== "string" || !body.sessionToken.trim() || /[\r\n]/u.test(body.sessionToken)) throw new Error("DESKTOP_CLOUD_SESSION_INVALID");
    const link: DesktopApiRequest = { method: "runtime.cloudAccount.link", body: { serverOrigin: url.origin, sessionToken: body.sessionToken } };
    cancelCloudLinkPreparation();
    const controller = new AbortController(), targetRuntime = runtime;
    cloudLinkPreparation = controller;
    /** 每次等待后核对同一准备请求和 Client；退出或资源切换不接受迟到登记。 */
    const assertCurrent = (): void => {
      controller.signal.throwIfAborted();
      if (!window || stoppingUpdates || operation === "exiting" || runtime !== targetRuntime) {
        controller.abort(Object.assign(new Error("DESKTOP_CLOUD_LINK_CANCELLED"), { code: "DESKTOP_CLOUD_LINK_CANCELLED" }));
        controller.signal.throwIfAborted();
      }
    };
    try {
      const unlinked = await targetRuntime.request({ method: "runtime.cloudAccount.unlink" });
      assertCurrent();
      const result = unlinked.body as { ok?: unknown; account?: { status?: unknown } } | null;
      if (unlinked.status >= 400 || result?.ok === false) return unlinked;
      if (result?.ok !== true || result.account?.status !== "unlinked") throw new Error("DESKTOP_CLOUD_ACCOUNT_STATE_INVALID");
      const registrationRequestId = crypto.randomUUID();
      try {
        await createDesktopUpdateTransport({ dataDir: input.dataDir, identity: identity!, configuredServerOrigin: url.origin,
          allowHttpRegistration: true, getVersions: presenceVersions }).register({ signal: controller.signal, requestId: registrationRequestId });
      } catch (error) {
        // 原 IPC 边界只记录一次，保留设备及签名请求关联，不附加账号凭据或响应正文。
        if (error instanceof Error) Object.assign(error, { deviceId: identity!.deviceId, registrationRequestId });
        throw error;
      }
      assertCurrent();
      return await targetRuntime.request(link);
    } finally {
      if (cloudLinkPreparation === controller) cloudLinkPreparation = undefined;
    }
  };
  let migration: LegacyClientMigration | undefined;
  let startupExitRequested = false;
  let startupExitFlight: Promise<void> | undefined;
  let exitFlight: Promise<void> | undefined;
  let currentReleaseId = "installation";
  let currentArchiveSha256: string | undefined;
  let currentVersion = "unknown";
  let currentClientVersion = "unknown";
  /** 设备心跳版本事实；运行时就绪前使用 unknown，避免伪造版本。 */
  const presenceVersions = () => ({
    shellVersion: input.shellVersion ?? "unknown",
    webVersion: currentVersion,
    clientVersion: currentClientVersion,
    releaseId: currentReleaseId,
  });
  /** 启动及每 6 小时上报设备版本与活跃时间；独立无重试连接，失败只记录，不阻断启动或更新。 */
  const reportDevicePresence = (): void => {
    if (!identity || !input.configuredServerOrigin) return;
    presenceTransport ??= createDesktopUpdateTransport({ dataDir: input.dataDir, identity,
      configuredServerOrigin: input.configuredServerOrigin, getVersions: presenceVersions });
    void presenceTransport.register({ requestId: `device-presence:${crypto.randomUUID()}` })
      .catch(error => input.host.onUpdateError?.(error, { requestId: "device-presence", deviceId: identity!.deviceId, logOnly: true }));
  };
  let currentBundleVersion: DesktopBundleVersion | null = null;
  let bundleDetails: DesktopUpdateDetails["bundle"] = { requestId: null, target: null, phase: null, result: "unknown", failure: null };
  /** 提醒状态读写失败交给宿主记录，不阻断更新轮次。 */
  const updateNotice = createUpdateNoticeController({
    noticeFile: path.join(input.dataDir, "update-notice.json"),
    onStateError: (error, context) => {
      input.host.onUpdateError?.(error, { requestId: `update-notice:${context.operation}`, deviceId: identity?.deviceId ?? "unknown", logOnly: true });
    },
  });
  /** 当前可提醒的已下载候选；资源优先，macOS 壳按手动安装提示。 */
  const currentPreparedNotice = (): PreparedUpdateNotice | null => {
    if (preparedUpdate) {
      return { releaseId: preparedUpdate.manifest.releaseId, version: preparedUpdate.manifest.version,
        currentVersion: currentVersion === "unknown" ? null : currentVersion, shellOnly: false };
    }
    if (shellDetails.result === "prepared" && shellDetails.target) {
      return { releaseId: shellDetails.target.shellId, version: shellDetails.target.version,
        currentVersion: input.shellVersion ?? null, shellOnly: process.platform === "darwin" };
    }
    return null;
  };
  /** 自动轮次按 24 小时节流提醒；手动检查只刷新节流，避免刚查看就再弹窗。 */
  const notifyPreparedUpdate = async (manual: boolean): Promise<void> => {
    try {
      const prepared = currentPreparedNotice();
      if (!prepared) { await updateNotice.evaluate(null); return; }
      if (manual) { await updateNotice.markSeen(prepared); return; }
      const notice = await updateNotice.evaluate(prepared);
      if (notice) input.host.onUpdateNotice?.(notice);
    } catch (error) {
      input.host.onUpdateError?.(error, { requestId: "update-notice:notify", deviceId: identity?.deviceId ?? "unknown", logOnly: true });
    }
  };
  // 壳自动更新仅 Windows 完整安装可用；macOS 在详情中明确标记需人工处理。
  let shellDetails: DesktopUpdateDetails["shell"] = { requestId: null, target: null, phase: null,
    result: input.shellUpdate || process.platform !== "darwin" ? "unknown" : "manual_required", failure: null };
  let receiptJournal: ReturnType<typeof createUpdateReceiptJournal> | undefined;
  let receiptDelivery: ReturnType<typeof createUpdateReceiptDelivery> | undefined;
  let failureJournal: ReturnType<typeof createUpdateFailureJournal> | undefined;
  let transport: ReturnType<typeof createDesktopUpdateTransport> | undefined;
  let receiptDeliveryFailure: { errorCode: string; requestId: string } | null = null;
  let failureDeliveryFailure: { errorCode: string; requestId: string; deviceId: string } | null = null;
  let crashDeliveryFailure: { errorCode: string; requestId: string; deviceId: string } | null = null;
  let unsettledReceipt: { receipt: DesktopUpdateReceipt; following: DesktopUpdateReceipt } | undefined;
  /** 仅本应用主动停机的同一原因可正常收口，清理失败和其他取消继续失败。 */
  const isAutomaticStop = (error: unknown): boolean => {
    const seen = new Set<unknown>();
    let cause = error;
    while (cause instanceof Error && !seen.has(cause)) {
      if (cause === updateStopReason) return true;
      if (cause instanceof AggregateError) return false;
      const code = (cause as { code?: unknown }).code;
      if (typeof code !== "string" || !["DESKTOP_UPDATE_TRANSPORT_FAILED", "DESKTOP_UPDATE_RESPONSE_INVALID", "DESKTOP_UPDATE_HTTP_FAILED",
        "DESKTOP_RELEASE_DOWNLOAD_CANCELLED", "DESKTOP_RELEASE_DOWNLOAD_FAILED", "DESKTOP_UPDATE_RECEIPT_SEND_FAILED",
        "DESKTOP_UPDATE_FAILURE_DELIVERY_FAILED", "DESKTOP_SHELL_OPERATION_FAILED", "DESKTOP_SHELL_INSTALLER_PROCESS_FAILED",
        "DESKTOP_SHELL_INSTALLER_CANCELLED"].includes(code)) return false;
      seen.add(cause);
      cause = cause.cause;
    }
    return false;
  };
  /** 真实阶段先落单份日志；已完成的后续事实一并落盘，网络失败不丢健康事实。 */
  const reportReceiptInternal = async (receipt: DesktopUpdateReceipt, following?: DesktopUpdateReceipt): Promise<void> => {
    if (identity && receipt.deviceId !== identity.deviceId) throw new Error("DESKTOP_UPDATE_RECEIPT_DEVICE_MISMATCH");
    if (!receiptJournal) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
    try {
      if (receipt.stage === "verified" || receipt.stage === "prepared") {
        const existing = await receiptJournal.find(receipt.deviceId, receipt.requestId, receipt.stage);
        if (existing) {
          if (existing.releaseId !== receipt.releaseId || existing.archiveSha256 !== receipt.archiveSha256) {
            throw new Error("DESKTOP_UPDATE_RECEIPT_CONFLICT");
          }
          receipt = existing;
        }
      }
      if (following) unsettledReceipt = { receipt, following };
      await receiptJournal.record(receipt);
      if (following) {
        if (following.deviceId !== receipt.deviceId || following.requestId !== receipt.requestId
          || following.releaseId !== receipt.releaseId || following.archiveSha256 !== receipt.archiveSha256
          || receipt.stage !== "switched" || following.stage !== "healthy") throw new Error("DESKTOP_UPDATE_RECEIPT_CONFLICT");
        await receiptJournal.record(following);
        unsettledReceipt = undefined;
      }
      // 已批准隔离：本地回执是更新事实，远端交付另行重试，不参与文件提交。
      scheduleTelemetry();
    } catch (error) {
      receiptDeliveryFailure = { errorCode: readReceiptErrorCode(error), requestId: readReceiptErrorRequestId(error) ?? receipt.requestId };
      throw error;
    }
  };
  /** 公开回执入口受生命周期互斥保护；内部更新阶段使用内部 reporter 避免自锁。 */
  const reportReceipt = async (receipt: DesktopUpdateReceipt): Promise<void> => {
    if (operation !== "idle") throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
    operation = "flushing";
    try {
      await reportReceiptInternal(receipt);
      if (input.reportReceipt && !input.configuredServerOrigin) await input.reportReceipt(receipt);
      else if (receiptDelivery) await receiptDelivery.flush();
      else throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
      receiptDeliveryFailure = null;
    }
    catch (error) {
      receiptDeliveryFailure = { errorCode: readReceiptErrorCode(error), requestId: readReceiptErrorRequestId(error) ?? receipt.requestId };
      throw error;
    }
    finally { operation = "idle"; }
  };
  /** 诊断只读真实身份的原日志；错误保留根因和设备，交原 IPC 边界记录。 */
  const getUpdateDiagnostics = async (): Promise<DesktopUpdateDiagnostics> => {
    try {
      if (!identity || !failureJournal) throw Object.assign(new Error("DESKTOP_DEVICE_IDENTITY_NOT_READY"), { code: "DESKTOP_DEVICE_IDENTITY_NOT_READY" });
      return { deviceId: identity.deviceId, failures: failureJournal.diagnostics(identity.deviceId) };
    } catch (cause) {
      throw Object.assign(new Error("DESKTOP_UPDATE_DIAGNOSTICS_FAILED", { cause }), {
        code: "DESKTOP_UPDATE_DIAGNOSTICS_FAILED", deviceId: identity?.deviceId,
      });
    }
  };
  /** 仅读原闭包事实；不进入锁、网络、磁盘、Client或恢复控制。 */
  const getUpdateState = async (): Promise<DesktopUpdateState> => {
    try {
      if (!identity) throw Object.assign(new Error("DESKTOP_DEVICE_IDENTITY_NOT_READY"), { code: "DESKTOP_DEVICE_IDENTITY_NOT_READY" });
      return { deviceId: identity.deviceId, operation, checking: updateFlight !== undefined, transportConfigured: transport !== undefined,
        automaticUpdates, updatesSuppressed, stoppingUpdates, shellOwned: shellOwner !== undefined,
        updateCheckFailure: snapshotUpdateStateFailure(updateCheckFailure),
        shellUpdateFailure: snapshotUpdateStateFailure(shellUpdateFailure, true),
        updateReceiptFailure: snapshotUpdateStateFailure(receiptDeliveryFailure),
        updateFailureFailure: snapshotUpdateStateFailure(failureDeliveryFailure) };
    } catch (cause) {
      throw Object.assign(new Error("DESKTOP_UPDATE_STATE_FAILED", { cause }), { code: "DESKTOP_UPDATE_STATE_FAILED", deviceId: identity?.deviceId });
    }
  };
  /** 仅复制本宿主已观察的事实；不读磁盘、网络、壳 owner 或恢复控制。 */
  const getUpdateDetails = async (): Promise<DesktopUpdateDetails> => {
    try {
      if (!identity) throw Object.assign(new Error("DESKTOP_DEVICE_IDENTITY_NOT_READY"), { code: "DESKTOP_DEVICE_IDENTITY_NOT_READY" });
      return structuredClone({ deviceId: identity.deviceId,
        current: { shellVersion: input.shellVersion ?? null, bundle: currentBundleVersion,
          clientVersion: currentBundleVersion?.clientVersion ?? (currentClientVersion === "unknown" ? null : currentClientVersion) },
        bundle: { ...bundleDetails, failure: snapshotUpdateStateFailure(updateCheckFailure) },
        shell: { ...shellDetails, failure: snapshotUpdateStateFailure(shellUpdateFailure, true) } });
    } catch (cause) {
      throw Object.assign(new Error("DESKTOP_UPDATE_DETAILS_FAILED", { cause }), { code: "DESKTOP_UPDATE_DETAILS_FAILED", deviceId: identity?.deviceId });
    }
  };
  /** 全部更新阶段沿当前身份及运行版本记证据，失败目标不能覆盖当前版本。 */
  const getFailureContext = () => {
    if (!identity) throw new Error("DESKTOP_DEVICE_IDENTITY_NOT_READY");
    return { deviceId: identity.deviceId, shellVersion: input.shellVersion ?? "unknown",
      currentReleaseId, webVersion: currentVersion, clientVersion: currentClientVersion };
  };
  const coordinator = createReleaseBundleCoordinator({ rootDir: input.dataDir, trustedReleaseKeys: input.trustedReleaseKeys,
    reportReceipt: input.configuredServerOrigin || input.reportReceipt ? reportReceiptInternal : undefined,
    getFailureContext, isCancellation: isAutomaticStop,
    /** 原协调器只报告阶段及本地结果，不由展示观察决定后续动作。 */
    onProgress(observation) {
      if (bundleDetails.requestId !== observation.requestId) {
        bundleDetails = { requestId: observation.requestId, target: null, phase: null, result: "unknown", failure: null };
      }
      bundleDetails.requestId = observation.requestId;
      bundleDetails.phase = observation.phase;
      if (observation.target) bundleDetails.target = { ...observation.target };
      if (observation.result) bundleDetails.result = observation.result;
      if (observation.result === "healthy" && bundleDetails.target) currentBundleVersion = { ...bundleDetails.target };
    },
  });

  /** 绑定包已成为活动版本后同步错误日志使用的当前版本事实。 */
  const syncActiveRelease = (active: Pick<ActiveRelease, "releaseId" | "manifest">): void => {
    currentReleaseId = active.releaseId;
    currentArchiveSha256 = active.manifest.archiveSha256;
    currentVersion = active.manifest.webVersion;
    currentClientVersion = active.manifest.clientVersion;
    currentBundleVersion = snapshotBundleVersion(active.manifest);
  };

  /** 安装基线与在线更新共用资源数字版本口径，不接受通用比较器的文本回退。 */
  const compareResourceVersions = (candidate: string, current: string, requestId?: string): number => {
    if (!/^\d+(?:\.\d+){2,3}$/u.test(candidate) || !/^\d+(?:\.\d+){2,3}$/u.test(current)) {
      throw Object.assign(new Error("DESKTOP_RESOURCE_VERSION_INVALID"), { code: "DESKTOP_RESOURCE_VERSION_INVALID", requestId,
        candidateVersion: candidate, currentVersion: current });
    }
    return compareNumericVersion(candidate, current);
  };

  /** 资源只比较包版本；同一发布的摘要冲突仍作为完整性错误拒绝。 */
  const isCurrentRelease = (manifest: DownloadedRelease["manifest"], requestId: string): boolean => {
    if (manifest.releaseId === currentReleaseId && currentArchiveSha256 !== undefined && manifest.archiveSha256 !== currentArchiveSha256) {
      throw Object.assign(new Error("DESKTOP_RELEASE_CACHE_CONFLICT"), { code: "DESKTOP_RELEASE_CACHE_CONFLICT", requestId });
    }
    const current = currentBundleVersion?.version;
    if (!current) return false;
    return compareResourceVersions(manifest.version, current, requestId) <= 0;
  };

  /** 壳只维护当前运行时的一条订阅，事件不在此缓存或重放。 */
  const bindRuntimeEvents = (): void => {
    unsubscribeRuntime?.();
    unsubscribeRuntime = runtime.onEvent((event) => {
      for (const listener of [...eventListeners]) listener(event);
    });
  };

  /** 确认旧进程已清理后才交接运行时引用，防止遗留失控子进程。 */
  const restartClient = async (releaseDir: string, expectedRelease?: ClientRuntimeExpectation): Promise<void> => {
    if (shellDrainedRuntime !== runtime) await runtime.drain();
    unsubscribeRuntime?.();
    unsubscribeRuntime = null;
    runtime = createRuntime(clientEntry(releaseDir), expectedRelease, startupHeldId ? { mode: "held", continuationId: startupHeldId } : undefined);
    shellDrainedRuntime = undefined;
    bindRuntimeEvents();
    await runtime.start();
    await runtime.waitReady();
  };

  /** 壳失败独立于hot事实；主进程边界按原请求/设备记录，调用者仍收到拒绝。 */
  const reportShellFailure = (error: unknown, requestId: string, options: { logOnly?: boolean } = {}): unknown => {
    if (error instanceof Error) {
      const owner = Object.getOwnPropertyDescriptor(error, "helperOwner");
      if (owner && "value" in owner && owner.value) shellOwner = owner.value as ShellUpdateHelperOwner;
    }
    let failure = error;
    try {
      if (!failureJournal || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
      const details: PropertyDescriptorMap = error instanceof Error ? Object.getOwnPropertyDescriptors(error) : {};
      if (details.code?.value !== "DESKTOP_SHELL_OPERATION_FAILED" || details.requestId?.value !== requestId
        || details.deviceId?.value !== identity.deviceId || !details.failurePhase || !details.recovery) throw new Error("DESKTOP_SHELL_FAILURE_CONTEXT_INVALID");
      failureJournal.recordShell({ ...getFailureContext(), requestId, shellId: details.shellId?.value ?? null,
        phase: details.failurePhase.value, recovery: details.recovery.value, error });
    } catch (additional) { failure = new AggregateError([error, additional], "DESKTOP_SHELL_FAILURE_RECORD_FAILED"); }
    try { input.host.onUpdateError?.(failure, { requestId, deviceId: identity!.deviceId,
      ...(options.logOnly ? { logOnly: true } : {}) }); }
    catch (additional) { failure = new AggregateError([failure, additional], "DESKTOP_SHELL_ERROR_REPORT_FAILED"); }
    shellUpdateFailure = { requestId, error: failure }; return failure;
  };

  /** hot与壳共用原D09响应门禁；故障不当作空闲或已恢复。 */
  const controlUpdate = async (currentRuntime: ClientRuntime, method: "runtime.update.prepare" | "runtime.update.cancel" | "runtime.update.interrupt") => {
    const response = await currentRuntime.request({ method }), body = response.body as { ok?: unknown; code?: unknown; hasRunningSessions?: unknown } | null;
    if (response.status !== 200 || body?.ok !== true) throw new Error(typeof body?.code === "string" ? body.code : "DESKTOP_UPDATE_CONTROL_FAILED");
    return body;
  };

  /** 同一checking轮次使用原D09控制；稍后cancel，interrupt后由原Client重启入口恢复。 */
  const checkShellInternal = async (requestId: string, signal: AbortSignal, manual: boolean, allowRestart = false): Promise<void> => {
    const config = input.shellUpdate;
    if (!config) return;
    const currentRuntime = runtime;
    const nativeUpdate = !config.boundary?.spawnHelper;
    let active: ActiveRelease | null;
    try {
      const discovered = await discoverUpdatesInternal({ requestId, signal });
      if (discovered.shellError) throw discovered.shellError;
      active = nativeUpdate ? null : await resolveActiveRelease(input.dataDir, { trustedReleaseKeys: input.trustedReleaseKeys });
    }
    catch (cause) { throw Object.assign(new Error("DESKTOP_SHELL_OPERATION_FAILED", { cause }), { code: "DESKTOP_SHELL_OPERATION_FAILED",
      requestId, deviceId: identity!.deviceId, shellId: null, failurePhase: "prepare", recovery: "not_needed" }); }
    const releaseDir = active?.releaseDir ?? input.initialReleaseDir, expectation = active?.manifest ?? initialExpectation;
    /** 壳目标或无更新决策落盘后收口资源标记，须早于 helper 接管生命周期。 */
    const finishResourcePending = async (): Promise<void> => {
      const pending = await readPendingRelease(input.dataDir);
      if (pending && pending.releaseId === active?.releaseId) await clearPendingRelease(input.dataDir);
    };
    let interrupted = false;
    const result = await runShellUpdateOperation({ shellVersion: input.shellVersion, dataDir: input.dataDir, initialReleaseDir: input.initialReleaseDir, identity: identity!,
      configuredServerOrigin: input.configuredServerOrigin!, trustedKeys: input.trustedReleaseKeys ?? {}, requestId, signal,
      facts: config.facts, boundary: config.boundary, timeoutMs: config.timeoutMs, getClient: () => runtime.snapshot(),
      discovery: async discoveryRequestId => (await discoverUpdatesInternal({ requestId: discoveryRequestId, signal })).shell,
      manual,
      /** 仅原日志的真实历史可授权人工新周期，ACK过的旧证据仍须存在。 */
      getFailureEvidence(failedRequestId, shellId) {
        if (!failureJournal || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
        const failure = failureJournal.shellFailures(identity.deviceId, failedRequestId).reverse().find(record =>
          record.shellId === shellId && record.phase === (shellId === null ? "prepare" : "download") && record.recovery === "not_needed");
        if (!failure) throw new Error("DESKTOP_SHELL_FAILURE_EVIDENCE_REQUIRED");
        return failure;
      },
      /** 恢复等待前只交原日志边界，不提前发布失败状态或转移helper管理权。 */
      onFailure(error) { input.host.onUpdateError?.(error, { requestId: readReceiptErrorRequestId(error) ?? requestId, deviceId: identity!.deviceId, logOnly: true }); },
      onRetry: async context => {
        if (!input.host.onUpdateRetry) throw new Error("DESKTOP_UPDATE_RETRY_REPORTER_UNAVAILABLE");
        input.host.onUpdateRetry({ ...context, requestId: readReceiptErrorRequestId(context.error) ?? requestId, deviceId: identity!.deviceId });
      },
      /** 原壳 owner 已核事实才更新观察，不读取或修改持久 attempt。 */
      onProgress(observation) {
        shellDetails.requestId = observation.requestId;
        shellDetails.phase = observation.phase;
        if (observation.target) shellDetails.target = { shellId: observation.target.shellId, version: observation.target.version };
        if (observation.result) shellDetails.result = observation.result;
      }, hooks: {
        /** 在helper创建前确认，稍后保持同一schema2可继续。 */
        async prepare() {
          if (!allowRestart) return false;
          if (nativeUpdate && currentRuntime.snapshot().status !== "ready") return true;
          if (startupHeldId) { await finishResourcePending(); return true; }
          signal.throwIfAborted(); const activity = await controlUpdate(currentRuntime, "runtime.update.prepare");
          if (typeof activity.hasRunningSessions !== "boolean") throw new Error("DESKTOP_UPDATE_ACTIVITY_INVALID");
          if (activity.hasRunningSessions) {
            if (!input.host.confirmUpdate) throw new Error("DESKTOP_UPDATE_CONFIRMATION_UNAVAILABLE");
            const confirmed = await input.host.confirmUpdate(window!, signal); signal.throwIfAborted();
            if (!confirmed) {
              if (!config.boundary?.spawnHelper) await controlUpdate(currentRuntime, "runtime.update.cancel");
              updatesSuppressed = true; return false;
            }
          }
          signal.throwIfAborted(); await finishResourcePending(); return true;
        },
        /** accepted后不可再由外部abort取消持久交接；真实drain成功才记录本轮事实。 */
        async drain() {
          if (!startupHeldId && (!nativeUpdate || currentRuntime.snapshot().status === "ready")) await controlUpdate(currentRuntime, "runtime.update.interrupt");
          interrupted = true;
          await currentRuntime.drain(); shellDrainedRuntime = currentRuntime;
        },
        /** 原生失败重启同一运行时，保留实际资源、schema 和启动参数，不退回首装基线。 */
        async resume() {
          if (!allowRestart) return;
          if (interrupted) {
            if (nativeUpdate) {
              if (runtime !== currentRuntime) throw new Error("DESKTOP_SHELL_RUNTIME_CHANGED");
              if (shellDrainedRuntime !== currentRuntime) await currentRuntime.drain();
              shellDrainedRuntime = undefined;
              await currentRuntime.start();
              await currentRuntime.waitReady();
            } else await restartClient(releaseDir, expectation);
            interrupted = false;
          }
          else if (!startupHeldId && (!nativeUpdate || currentRuntime.snapshot().status === "ready")) await controlUpdate(currentRuntime, "runtime.update.cancel");
        },
        /** 与hot相同的退出等待边界，accepted后退出只等待交接结果。 */
        committed() { switchCommitted = true; },
      } });
    if (result.status === "handoff") shellOwner = result.owner;
    if (allowRestart && result.status === "no-update") await finishResourcePending();
    if (result.status === "postponed" && !allowRestart) shellDetails.result = "prepared";
  };
  /** 使用同一窗口切换 Web 资源根，可等待本地启动任务；失败向上传递。 */
  const reloadWeb = async (releaseDir: string, options?: { beforeReady?: () => Promise<void> }): Promise<void> => {
    if (!window) throw new Error("DESKTOP_WINDOW_NOT_READY");
    await input.host.loadWeb(window, releaseDir, options);
  };
  /** 启动取消后禁止迟到任务创建 Client、加载业务页或重显窗口。 */
  const assertStartupRunning = (): void => {
    if (startupExitRequested) {
      const code = migration ? "MIGRATION_STOPPED" : "DESKTOP_STARTUP_STOPPED";
      throw Object.assign(new Error(code), { code });
    }
  };
  /** 复用唯一窗口；业务桥注册前关闭沿原退出入口取消启动。 */
  const ensureWindow = (): DesktopWindow => {
    if (window) return window;
    window = input.host.createWindow();
    window.on("close", event => {
      event.preventDefault();
      if (operation === "starting" && !continuation || startupExitRequested || migration && migration.snapshot().status !== "ready") {
        void application.exit().catch(error => {
          if (!input.host.onMigrationError) throw error;
          input.host.onMigrationError(error);
        });
        return;
      }
      window?.hide();
    });
    return window;
  };
  /** 清理已创建的壳资源，必须在 Client 成功收口后调用。 */
  const destroyShell = (): void => {
    cancelCloudLinkPreparation();
    input.onShutdown?.();
    unregister?.();
    unregister = null;
    unsubscribeRuntime?.();
    unsubscribeRuntime = null;
    eventListeners.clear();
    tray?.destroy();
    tray = null;
    window?.destroy();
    window = null;
  };

  /** 补报已有错误证据；启动阶段失败保留本地待报并由主边界显式反馈。 */
  const flushFailures = async (allowInternal = false, detached = false): Promise<void> => {
    if (!detached && operation !== "idle" && !(allowInternal && (operation === "starting" || operation === "checking"))) throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
    if (!failureJournal || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
    const pending = failureJournal.pending(identity.deviceId);
    if (!transport) {
      const requestId = pending[0]?.requestId ?? "unknown";
      const failure = Object.assign(new Error("DESKTOP_UPDATE_UNAVAILABLE"), { code: "DESKTOP_UPDATE_UNAVAILABLE", requestId });
      failureDeliveryFailure = { errorCode: failure.code, requestId, deviceId: identity.deviceId };
      throw failure;
    }
    if (!pending.length) return;
    const previousOperation = operation;
    if (!detached && operation !== "checking") operation = "flushing";
    try {
      await deliverDesktopUpdateFailures({ journal: failureJournal, deviceId: identity.deviceId, transport,
        signal: AbortSignal.timeout(30_000) });
      failureDeliveryFailure = null;
    } catch (error) {
      const requestId = readFailureErrorRequestId(error) ?? pending[0]!.requestId;
      failureDeliveryFailure = { errorCode: readFailureErrorCode(error), requestId, deviceId: identity.deviceId };
      throw error;
    } finally {
      if (!detached) operation = previousOperation;
    }
  };

  /** 仅启动完成后的下一轮补报；失败保留待报并交主进程边界记录。 */
  const flushCrashReports = async (): Promise<void> => {
    if (!input.crashJournal || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
    let pending: ReturnType<CrashReportJournal["pending"]>;
    try { pending = input.crashJournal.pending(identity.deviceId); }
    catch (error) {
      const failure = Object.assign(error instanceof Error ? error : new Error("DESKTOP_CRASH_JOURNAL_INVALID"),
        { code: "DESKTOP_CRASH_JOURNAL_INVALID", requestId: identity.deviceId });
      crashDeliveryFailure = { errorCode: failure.code, requestId: failure.requestId, deviceId: identity.deviceId };
      throw failure;
    }
    if (!pending.length) { crashDeliveryFailure = null; return; }
    if (!transport) {
      const requestId = pending[0]!.reportId;
      const failure = Object.assign(new Error("DESKTOP_UPDATE_UNAVAILABLE"), { code: "DESKTOP_UPDATE_UNAVAILABLE", requestId });
      crashDeliveryFailure = { errorCode: failure.code, requestId, deviceId: identity.deviceId };
      throw failure;
    }
    try {
      await deliverDesktopCrashReports({ journal: input.crashJournal, deviceId: identity.deviceId, transport, signal: AbortSignal.timeout(30_000) });
      crashDeliveryFailure = null;
    } catch (error) {
      const requestId = readFailureErrorRequestId(error) ?? pending[0]!.reportId;
      crashDeliveryFailure = { errorCode: readFailureErrorCode(error), requestId, deviceId: identity.deviceId };
      throw error;
    }
  };

  /** 已批准的交付隔离：失败保留本地待报和可查询状态，后台交付不占业务生命周期。 */
  function scheduleTelemetry(): void {
    if (telemetryTimer || telemetryFlight || stoppingUpdates || !input.configuredServerOrigin) return;
    telemetryTimer = setTimeout(() => {
      telemetryTimer = undefined;
      if (stoppingUpdates || operation === "exiting") return;
      const report = async (action: () => Promise<void>, code: string): Promise<void> => {
        try { await action(); }
        catch (error) {
          // 本操作允许交付失败；证据仍在原日志，下次检查/启动重试，失败明确发布到更新诊断。
          const requestId = readReceiptErrorRequestId(error) ?? identity?.deviceId ?? "telemetry";
          try { input.host.onUpdateError?.(error, { requestId, deviceId: identity!.deviceId, logOnly: true }); }
          catch (reportError) { updateCheckFailure = { requestId, error: new AggregateError([error, reportError], code) }; }
        }
      };
      telemetryFlight = (async () => {
        if (receiptDelivery) await report(async () => {
          try { await receiptDelivery!.flush(); receiptDeliveryFailure = null; }
          catch (error) {
            receiptDeliveryFailure = { errorCode: readReceiptErrorCode(error), requestId: readReceiptErrorRequestId(error) ?? "telemetry" }; throw error;
          }
        }, "DESKTOP_RECEIPT_REPORT_FAILED");
        if (failureJournal && identity) await report(() => flushFailures(true, true), "DESKTOP_FAILURE_REPORT_FAILED");
        if (input.crashJournal && identity) await report(flushCrashReports, "DESKTOP_CRASH_REPORT_FAILED");
      })().finally(() => { telemetryFlight = undefined; });
    }, 1000);
    telemetryTimer.unref?.();
  }

  /** 两个下载入口复用同一落盘和 received 事实，不重复安装状态或回执副本。 */
  const downloadReleaseInternal = async (options: ApplicationDownloadOptions) => {
    return await downloadReleaseBundle({ ...options, rootDir: input.dataDir, transport: transport!, trustedReleaseKeys: input.trustedReleaseKeys ?? {},
      networkRetry: networkContext?.retry,
      /** 下载与摘要校验沿下载器真实边界，不能用 received 推测校验中。 */
      onPhase(phase) { bundleDetails.requestId = options.requestId ?? null; bundleDetails.phase = phase; if (phase !== "download") input.host.onUpdateProgress?.(null); },
      /** 字节进度只供弹框展示，不改变下载、校验或重试判定。 */
      onProgress(received, total) { input.host.onUpdateProgress?.({ received, total }); },
      receivedReporter: async received => {
        const existing = await receiptJournal!.find(identity!.deviceId, received.requestId, "received");
        if (existing && (existing.releaseId !== received.manifest.releaseId || existing.archiveSha256 !== received.manifest.archiveSha256)) {
          throw new Error("DESKTOP_UPDATE_RECEIPT_CONFLICT");
        }
        await reportReceiptInternal(existing ?? createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity!.deviceId, requestId: received.requestId,
          releaseId: received.manifest.releaseId, archiveSha256: received.manifest.archiveSha256, stage: "received",
          at: new Date().toISOString(), errorCode: null, errorId: null }));
      },
    });
  };

  /** 同轮按真实尝试标识缓存组合响应；历史壳恢复使用原标识复查，绝不改写授权信封。 */
  const discoverUpdatesInternal = (options: { requestId: string; signal?: AbortSignal }): Promise<CombinedUpdateDiscovery> => {
    const cached = checkDiscoveries?.get(options.requestId);
    if (cached) return cached;
    const flight = (async (): Promise<CombinedUpdateDiscovery> => {
      await transport!.register(options);
      const response = await transport!.requestJson<Record<string, unknown>>({ method: 'GET', path: '/api/software/desktop/update-availability', ...options });
      /** 合同错误绑定原检查请求，禁止继续任一工件下载。 */
      const invalid = (): never => { throw Object.assign(new Error('DESKTOP_UPDATE_RESPONSE_INVALID'), { code: 'DESKTOP_UPDATE_RESPONSE_INVALID', requestId: options.requestId }); };
      const fields = ['ok', 'deviceId', 'requestId', 'resource', 'shell'];
      if (response.ok !== true || response.deviceId !== identity!.deviceId || response.requestId !== options.requestId
        || Object.keys(response).length !== fields.length || Object.keys(response).some(field => !fields.includes(field))) invalid();
      /** 每个通道明确表达是否可用；不可用不得携带不可信或陈旧清单。 */
      const availability = (value: unknown, channel: "resource" | "shell"): { available: boolean; manifest?: unknown; error?: Error } => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
        const item = value as Record<string, unknown>, fields = ['available', ...(item.available === true ? ['manifest'] : Object.hasOwn(item, 'error') ? ['error'] : [])];
        if (typeof item.available !== 'boolean' || Object.keys(item).length !== fields.length || Object.keys(item).some(field => !fields.includes(field))) return invalid();
        if (Object.hasOwn(item, 'error')) {
          const error = item.error as { code?: unknown; requestId?: unknown } | null;
          if (!error || typeof error !== 'object' || Array.isArray(error) || Object.keys(error).length !== 2
            || typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code) || error.requestId !== options.requestId) return invalid();
          return { available: false, error: Object.assign(new Error(error.code), { code: error.code, requestId: options.requestId, updateChannel: channel }) };
        }
        return item as { available: boolean; manifest?: unknown };
      };
      const resource = availability(response.resource, 'resource'), shell = availability(response.shell, 'shell');
      const manifest = resource.available ? assertReleaseBundleManifest(resource.manifest) : null;
      return { resource: manifest ? { manifest, manifestBytes: Buffer.from(JSON.stringify(manifest), 'utf8') } : null,
        shell: shell.available ? { ok: true, available: true, deviceId: identity!.deviceId, requestId: options.requestId,
          manifest: assertShellReleaseManifest(shell.manifest) } : { ok: true, available: false, deviceId: identity!.deviceId, requestId: options.requestId },
        ...(resource.error ? { resourceError: resource.error } : {}), ...(shell.error ? { shellError: shell.error } : {}) };
    })();
    checkDiscoveries?.set(options.requestId, flight);
    return flight;
  };

  /** 检查轮次复用组合响应；独立下载入口保留原发现合同和原始清单字节。 */
  const discoverReleaseInternal = async (options: { requestId: string; signal?: AbortSignal }, conditional: boolean, excludeReleaseId?: string) => {
    bundleDetails.requestId = options.requestId;
    bundleDetails.phase = "discovery";
    if (conditional && operation === 'checking') {
      const response = await discoverUpdatesInternal(options);
      if (response.resourceError) throw response.resourceError;
      const discovered = response.resource;
      if (!discovered || discovered.manifest.releaseId === excludeReleaseId) { bundleDetails.result = 'none'; bundleDetails.target = null; return null; }
      return discovered;
    }
    await transport!.register(options);
    let manifestBytes: Uint8Array;
    if (conditional) {
      const response = await transport!.requestJson<Record<string, unknown>>({ method: "GET",
        path: "/api/software/desktop/release-availability" + (excludeReleaseId ? `?excludeReleaseId=${encodeURIComponent(excludeReleaseId)}` : ""), ...options });
      const fields = ["ok", "available", "deviceId", "requestId", ...(response.available === true ? ["manifest"] : [])];
      if (typeof response.available !== "boolean" || Object.keys(response).length !== fields.length
        || Object.keys(response).some(field => !fields.includes(field))
        || response.deviceId !== identity!.deviceId || response.requestId !== options.requestId) {
        throw Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID"), { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId: options.requestId });
      }
      if (!response.available) { bundleDetails.result = "none"; bundleDetails.target = null; return null; }
      manifestBytes = Buffer.from(JSON.stringify(response.manifest), "utf8");
    } else {
      const response = await transport!.request({ method: "GET", path: "/api/software/desktop/release", ...options });
      manifestBytes = new Uint8Array(await response.arrayBuffer());
    }
    try {
      const manifest = assertReleaseBundleManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)));
      return { manifest, manifestBytes };
    } catch {
      throw Object.assign(new Error("DESKTOP_RELEASE_MANIFEST_INVALID"), { code: "DESKTOP_RELEASE_MANIFEST_INVALID", requestId: options.requestId });
    }
  };

  /** 复用原切换资格合同；否定结果只表示当前无许可，故障仍显式失败。 */
  const authorizeReleaseSwitch = async (manifest: DownloadedRelease["manifest"], requestId: string, signal?: AbortSignal): Promise<boolean> => {
    if (!transport || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
    const authorization = await transport.requestJson<Record<string, unknown>>({ method: "GET",
      path: `/api/software/desktop/releases/${manifest.releaseId}/switch-authorization`, requestId, signal });
    signal?.throwIfAborted();
    const fields = ["ok", "authorized", "deviceId", "requestId", "releaseId",
      ...(authorization.authorized === true ? ["archiveSha256"] : [])];
    if (typeof authorization.authorized !== "boolean" || Object.keys(authorization).length !== fields.length
      || Object.keys(authorization).some(field => !fields.includes(field))
      || authorization.deviceId !== identity.deviceId || authorization.requestId !== requestId
      || authorization.releaseId !== manifest.releaseId
      || (authorization.authorized && authorization.archiveSha256 !== manifest.archiveSha256)) {
      throw Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID"), { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId });
    }
    if (!authorization.authorized) bundleDetails.result = "revoked";
    return authorization.authorized;
  };

  /** 两种发现共用一次生命周期锁、下载与失败日志；只有窄入口允许正常空结果。 */
  async function downloadDiscoveredReleaseInternal(options: ApplicationDiscoveryOptions, conditional: false): Promise<DownloadedRelease>;
  async function downloadDiscoveredReleaseInternal(options: ApplicationDiscoveryOptions, conditional: true): Promise<DownloadedRelease | null>;
  async function downloadDiscoveredReleaseInternal(options: ApplicationDiscoveryOptions, conditional: boolean): Promise<DownloadedRelease | null> {
    if (!transport || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
    let requestId = options.requestId ?? crypto.randomUUID();
    // received 的幂等键只接受 UUID v4，必须在首次网络副作用前拒绝非法重试标识。
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) {
      throw Object.assign(new Error("DESKTOP_UPDATE_RECEIPT_INVALID"), { code: "DESKTOP_UPDATE_RECEIPT_INVALID", requestId });
    }
    let releaseId = "unknown";
    let phase = "discovery";
    try {
      let discovered: Awaited<ReturnType<typeof discoverReleaseInternal>>;
      const retained = conditional && operation === "checking" ? pendingUpdate : undefined;
      if (retained) {
        requestId = retained.requestId;
        releaseId = retained.manifest.releaseId;
        if (await authorizeReleaseSwitch(retained.manifest, requestId, options.signal)) {
          discovered = { manifest: retained.manifest, manifestBytes: retained.manifestBytes };
        } else {
          requestId = options.requestId ?? crypto.randomUUID();
          releaseId = "unknown";
          discovered = await discoverReleaseInternal({ requestId, signal: options.signal }, true, retained.manifest.releaseId);
        }
      } else discovered = await discoverReleaseInternal({ requestId, signal: options.signal }, conditional);
      if (conditional) options.signal?.throwIfAborted();
      if (!discovered) return null;
      const { manifest, manifestBytes } = discovered;
      releaseId = manifest.releaseId;
      phase = "download";
      if (conditional) {
        bundleDetails.phase = "verify";
        const verified = verifyDownloadManifest({ manifestBytes, trustedReleaseKeys: input.trustedReleaseKeys ?? {}, requestId });
        bundleDetails.requestId = requestId;
        bundleDetails.target = snapshotBundleVersion(verified);
        bundleDetails.result = "unknown";
        options.signal?.throwIfAborted();
        if (retained && requestId !== retained.requestId && manifest.releaseId === retained.manifest.releaseId) {
          if (manifest.archiveSha256 !== retained.manifest.archiveSha256) {
            throw Object.assign(new Error("DESKTOP_RELEASE_CACHE_CONFLICT"), { code: "DESKTOP_RELEASE_CACHE_CONFLICT", requestId });
          }
          requestId = retained.requestId;
          if (!await authorizeReleaseSwitch(retained.manifest, requestId, options.signal)) return null;
        }
        if (isCurrentRelease(manifest, requestId)) {
          if (operation === "checking") pendingUpdate = undefined;
          bundleDetails.result = "same";
          return null;
        }
        if (operation === "checking") {
          if (retained?.requestId === requestId && retained.downloaded) return retained.downloaded;
          pendingUpdate = { requestId, manifest, manifestBytes };
        }
      }
      const downloaded = await downloadReleaseInternal({ manifestBytes, archivePath: `/api/software/desktop/releases/${manifest.releaseId}/archive`,
        requestId, signal: options.signal });
      if (operation === "checking" && pendingUpdate?.requestId === requestId) pendingUpdate.downloaded = downloaded;
      return downloaded;
    } catch (cause) {
      if (isAutomaticStop(cause)) throw cause;
      const failure = readReceiptErrorRequestId(cause) === requestId ? cause
        : Object.assign(new Error("DESKTOP_RELEASE_DISCOVERY_FAILED", { cause }), { code: "DESKTOP_RELEASE_DISCOVERY_FAILED", requestId });
      try {
        failureJournal!.record({ ...getFailureContext(), requestId, releaseId, phase, recovery: "not_needed", error: failure });
      } catch (logError) {
        throw Object.assign(new AggregateError([failure, logError], "DESKTOP_UPDATE_FAILURE_LOG_FAILED"), { code: "DESKTOP_UPDATE_FAILURE_LOG_FAILED", requestId });
      }
      throw failure;
    }
  }

  /** 外部发现入口独占生命周期；自动轮直接调用内部方法，避免重入锁。 */
  async function downloadDiscoveredRelease(options: ApplicationDiscoveryOptions, conditional: false): Promise<DownloadedRelease>;
  async function downloadDiscoveredRelease(options: ApplicationDiscoveryOptions, conditional: true): Promise<DownloadedRelease | null>;
  async function downloadDiscoveredRelease(options: ApplicationDiscoveryOptions, conditional: boolean): Promise<DownloadedRelease | null> {
    if (operation !== "idle" || !window) throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
    operation = "downloading";
    try { return conditional ? await downloadDiscoveredReleaseInternal(options, true) : await downloadDiscoveredReleaseInternal(options, false); }
    finally { operation = "idle"; }
  }

  /** 内部切换不重入生命周期锁；已下载尝试继续沿原协调器、准入和回退入口。 */
  const applyReleaseInternal = async (packageDir: string, options: ApplicationDiscoveryOptions = {}): Promise<ActiveRelease | null> => {
    if (input.configuredServerOrigin && !options.requestId) throw new Error("DESKTOP_UPDATE_REQUEST_ID_REQUIRED");
    const prepared = await coordinator.prepare(packageDir, options);
    try {
      const active = await coordinator.switch(prepared, {
        /** 未建立数据库恢复点前只允许相同结构版本，拒绝后保留当前 Client。 */
        checkCompatibility: async manifest => {
          const current = runtime.snapshot();
          if (current.status !== "ready" || !current.health) throw new Error("DESKTOP_CURRENT_RUNTIME_NOT_HEALTHY");
          if (manifest.dbSchemaVersion !== current.health.dbSchemaVersion) throw new Error(
            `DESKTOP_DB_SCHEMA_UPDATE_UNSUPPORTED: current=${current.health.dbSchemaVersion}, target=${manifest.dbSchemaVersion}`,
          );
        },
        drain: async () => {
          const currentRuntime = runtime;
          try {
            options.signal?.throwIfAborted();
            const activity = await controlUpdate(currentRuntime, "runtime.update.prepare");
            if (typeof activity.hasRunningSessions !== "boolean") throw new Error("DESKTOP_UPDATE_ACTIVITY_INVALID");
            if (activity.hasRunningSessions) {
              if (!input.host.confirmUpdate) throw new Error("DESKTOP_UPDATE_CONFIRMATION_UNAVAILABLE");
              const confirmed = await input.host.confirmUpdate(window!, options.signal);
              options.signal?.throwIfAborted();
              if (!confirmed) {
                if (operation === "checking") updatesSuppressed = true;
                throw new DesktopUpdatePostponed();
              }
            }
            options.signal?.throwIfAborted();
            if (input.configuredServerOrigin) {
              if (!await authorizeReleaseSwitch(prepared.manifest, prepared.requestId, options.signal)) throw new DesktopUpdatePostponed();
              if (Date.parse(prepared.manifest.expiresAt) <= Date.now()) {
                throw Object.assign(new Error("DESKTOP_RELEASE_EXPIRED"), { code: "DESKTOP_RELEASE_EXPIRED", requestId: prepared.requestId });
              }
            }
            options.signal?.throwIfAborted();
            // 中断发出后退出只等待切换/回退，不能再取消已开始的运行时交接。
            if (operation === "checking") switchCommitted = true;
            await controlUpdate(currentRuntime, "runtime.update.interrupt");
            options.signal?.throwIfAborted();
          } catch (error) {
            try { await controlUpdate(currentRuntime, "runtime.update.cancel"); }
            catch (resumeError) { throw new AggregateError([error, resumeError], "DESKTOP_UPDATE_ADMISSION_RESUME_FAILED"); }
            throw error;
          }
          await currentRuntime.drain();
        }, restartClient, reloadWeb,
        waitHealthy: async () => runtime.snapshot().status === "ready",
        restoreInitialRelease: async () => {
          if (input.requireBaseline) await resolveBaselineRelease(baselineReleaseDir, { trustedReleaseKeys: input.trustedReleaseKeys });
          await restartClient(input.initialReleaseDir, initialExpectation);
          await reloadWeb(input.initialReleaseDir);
        },
      });
      syncActiveRelease(active);
      return active;
    } catch (error) {
      if (error instanceof DesktopUpdatePostponed) {
        if (bundleDetails.result !== "revoked") bundleDetails.result = "postponed";
        return null;
      }
      const activeReleaseId = await readActivePointer(input.dataDir);
      if (activeReleaseId === prepared.manifest.releaseId) syncActiveRelease({ releaseId: prepared.manifest.releaseId, manifest: prepared.manifest });
      throw error;
    }
  };

  /** held Client 与配套 Web 均已就绪后，只放行一次原有任务恢复入口。 */
  const continueHeldRuntime = async (continuationId: string): Promise<void> => {
    snapshotDesktopStartupReady(runtime.snapshot().startup, continuationId);
    const response = await runtime.request({ method: "runtime.startup.continue", body: { continuationId } });
    const body = response.body, ok = body && typeof body === "object" ? Object.getOwnPropertyDescriptor(body, "ok") : undefined;
    if (response.status !== 200 || !body || typeof body !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
      || Reflect.ownKeys(body).length !== 1 || !ok || !("value" in ok) || ok.value !== true) throw new Error("DESKTOP_STARTUP_CONTINUATION_FAILED");
  };

  /** 启动时独立提交资源候选；本地事实完成才清 pending，远端交付不延长本地事务。 */
  const activatePendingAtStartup = async (pending: PendingRelease, activeAtStartup: ActiveRelease | null): Promise<void> => {
    let candidate: PreparedRelease | undefined;
    const committedAtStartup = activeAtStartup?.releaseId === pending.releaseId;
    try {
      // 活动版本沿启动时已验签的安装事实恢复，不再套用新候选的下载有效期。
      candidate = committedAtStartup
        ? { requestId: pending.requestId, stagingDir: activeAtStartup!.releaseDir, manifest: activeAtStartup!.manifest }
        : await coordinator.resume(pending, currentArchiveSha256 === undefined ? undefined
          : { releaseId: currentReleaseId, archiveSha256: currentArchiveSha256 });
      bundleDetails = { requestId: pending.requestId, target: snapshotBundleVersion(candidate.manifest), phase: "prepare", result: "prepared", failure: null };
      // 完整安装已包含候选时只收口旧标记，不能伪造资源切换和健康回执。
      if (!committedAtStartup && isCurrentRelease(candidate.manifest, pending.requestId)) {
        await clearPendingRelease(input.dataDir);
        preparedUpdate = undefined;
        pendingUpdate = undefined;
        bundleDetails.result = "same";
        return;
      }
      if (committedAtStartup) {
        const current = runtime.snapshot();
        if (current.status !== "ready" || current.health?.database !== "ready") throw new Error("DESKTOP_CURRENT_RUNTIME_NOT_HEALTHY");
        snapshotDesktopStartupReady(current.startup, startupHeldId!);
        bundleDetails.phase = "activate";
        bundleDetails.result = "healthy";
        if (input.configuredServerOrigin || input.reportReceipt) {
          const receipts: DesktopUpdateReceipt[] = [];
          for (const stage of ["switched", "healthy"] as const) {
            const existing = await receiptJournal!.find(identity!.deviceId, pending.requestId, stage);
            if (existing && (existing.releaseId !== candidate.manifest.releaseId || existing.archiveSha256 !== candidate.manifest.archiveSha256)) {
              throw new Error("DESKTOP_UPDATE_RECEIPT_CONFLICT");
            }
            // 提交后可能尚未落盘；仅在本次 Client/Web 再次健康确认后补齐缺失事实。
            receipts.push(existing ?? createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity!.deviceId,
              requestId: pending.requestId, releaseId: candidate.manifest.releaseId, archiveSha256: candidate.manifest.archiveSha256,
              stage, at: new Date().toISOString(), errorCode: null, errorId: null }));
          }
          await reportReceiptInternal(receipts[0]!, receipts[1]!);
          await reportReceiptInternal(receipts[1]!);
        }
        await clearPendingRelease(input.dataDir);
        pendingUpdate = undefined;
        return;
      }
      preparedUpdate = candidate;
      // 未获切换资格时不得保留会被检查或重启复用的陈旧候选；待更新标记仍留给下次启动重试。
      if (!await authorizeReleaseSwitch(candidate.manifest, pending.requestId, AbortSignal.timeout(30_000))) {
        preparedUpdate = undefined;
        return;
      }
      let databaseMigration = false, candidateStarted = false;
      const active = await coordinator.switch(candidate, {
        /** 原库只向前迁移；同结构可回退资源，跨结构失败保留原库并停止。 */
        async checkCompatibility(manifest) {
          const current = runtime.snapshot();
          if (current.status !== "ready" || !current.health) throw new Error("DESKTOP_CURRENT_RUNTIME_NOT_HEALTHY");
          if (manifest.dbSchemaVersion < current.health.dbSchemaVersion) throw new Error("DESKTOP_DB_SCHEMA_DOWNGRADE_FORBIDDEN");
          databaseMigration = manifest.dbSchemaVersion > current.health.dbSchemaVersion;
          snapshotDesktopStartupReady(current.startup, startupHeldId!);
        },
        /** 跨结构围栏先落盘；停旧 Client 后收口壳绑定，收口失败恢复旧 Client 并保留原错。 */
        async drain() {
          if (!await authorizeReleaseSwitch(candidate!.manifest, pending.requestId, AbortSignal.timeout(30_000))) throw new DesktopUpdatePostponed();
          if (databaseMigration) await markPendingDatabaseMigration(input.dataDir, pending, candidate!.manifest.dbSchemaVersion);
          await runtime.drain();
          try {
            if (input.shellUpdate) {
              const facts = input.shellUpdate.facts;
              await retireShellUpdateAttempt({ ...facts, dataDir: input.dataDir, executablePath: facts.main.executable,
                pid: facts.main.pid, parentPid: facts.main.parentPid, argv: [], trustedKeys: input.trustedReleaseKeys,
                snapshot: input.shellUpdate.boundary?.snapshot });
            }
          } catch (error) {
            // 候选尚未启动，原库未迁移；协调器的 drain 尚未完成，恢复由此边界负责。
            try { await restartClient(activeAtStartup?.releaseDir ?? baselineReleaseDir, activeAtStartup?.manifest ?? initialExpectation); }
            catch (recovery) { throw new AggregateError([error, recovery], "DESKTOP_RELEASE_DRAIN_RECOVERY_FAILED"); }
            throw error;
          }
        },
        /** 启动调用即可能迁移数据库；不能仅凭未收到 ready 推断原库未变。 */
        async restartClient(releaseDir, manifest) { candidateStarted = true; await restartClient(releaseDir, manifest); },
        reloadWeb,
        /** 不能将下载或进程存在当健康；候选仍持有启动围栏。 */
        async waitHealthy() {
          const current = runtime.snapshot();
          snapshotDesktopStartupReady(current.startup, startupHeldId!);
          return current.status === "ready" && current.health?.database === "ready";
        },
        /** 停候选后保留当前数据库；跨结构失败显式阻止旧 Client 自动回退。 */
        async beforeRestore() {
          await runtime.drain();
          if (databaseMigration && candidateStarted) throw Object.assign(new Error("DESKTOP_DB_SCHEMA_FORWARD_ONLY"),
            { code: "DESKTOP_DB_SCHEMA_FORWARD_ONLY", requestId: pending.requestId, releaseId: pending.releaseId });
        },
        /** 首次资源升级失败恢复安装包自身的已核验资源。 */
        async restoreInitialRelease() {
          if (input.requireBaseline) await resolveBaselineRelease(baselineReleaseDir, { trustedReleaseKeys: input.trustedReleaseKeys });
          await restartClient(input.initialReleaseDir, initialExpectation); await reloadWeb(input.initialReleaseDir);
        },
      });
      syncActiveRelease(active);
      await databaseBackup.recover(active.releaseId);
      await clearPendingRelease(input.dataDir);
      preparedUpdate = undefined;
      pendingUpdate = undefined;
    } catch (error) {
      if (error instanceof DesktopUpdatePostponed) return;
      const activeReleaseId = await readActivePointer(input.dataDir);
      if (committedAtStartup) {
        try {
          failureJournal!.record({ ...getFailureContext(), requestId: pending.requestId, releaseId: pending.releaseId,
            phase: "activate", recovery: "not_needed", error });
        } catch (logError) { throw new AggregateError([error, logError], "DESKTOP_UPDATE_RECOVERY_LOG_FAILED"); }
      } else if (candidate && activeReleaseId === candidate.manifest.releaseId && bundleDetails.result === "healthy") {
        syncActiveRelease({ releaseId: activeReleaseId, manifest: candidate.manifest });
        await databaseBackup.recover(activeReleaseId);
        preparedUpdate = undefined;
      } else if (bundleDetails.result === "restored") {
        await clearPendingRelease(input.dataDir);
        preparedUpdate = undefined;
      }
      updateCheckFailure = { requestId: pending.requestId, error };
      if (!["healthy", "restored", "unavailable"].includes(bundleDetails.result)) bundleDetails.result = "failure";
      input.host.onUpdateError?.(error, { requestId: pending.requestId, deviceId: identity!.deviceId });
      // 用户已确认：更新失败可恢复当前可用版；本次失败在状态、日志和宿主提示中保留。
      if (bundleDetails.result === "unavailable" || runtime.snapshot().status !== "ready") throw error;
    }
  };

  /** 成功空轮次后安排下一次检查；稍后、故障和退出都停止自动调度。 */
  const scheduleUpdateCheck = (): void => {
    if (!automaticUpdates || updatesSuppressed || stoppingUpdates || updateCheckFailure || shellUpdateFailure || shellOwner) return;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      if (operation !== "idle") { scheduleUpdateCheck(); return; }
      beginUpdateCheck(false);
    }, 30 * 60 * 1000);
    updateTimer.unref?.();
  };

  /** 每轮独占原 operation；手动消费者复用同一 Promise，网络预算不跨轮次。 */
  const beginUpdateCheck = (manual: boolean, allowRestart = false): Promise<ActiveRelease | null> => {
    if (updateFlight) {
      if (manual) updateFlightManualRequested = true;
      return updateFlight;
    }
    if (operation !== "idle" || !window || stoppingUpdates || shellOwner) return Promise.reject(new Error("DESKTOP_OPERATION_IN_PROGRESS"));
    if (!transport || !identity || !receiptDelivery) return Promise.reject(new Error("DESKTOP_UPDATE_UNAVAILABLE"));
    if (manual) updatesSuppressed = false;
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = undefined;
    updateCheckFailure = null;
    shellUpdateFailure = null;
    operation = "checking";
    switchCommitted = false;
    updateController = new AbortController();
    const signal = updateController.signal;
    const requestId = crypto.randomUUID();
    checkDiscoveries = new Map();
    const deviceId = identity.deviceId;
    bundleDetails = { requestId, target: null, phase: null, result: "unknown", failure: null };
    shellDetails = { requestId: null, target: null, phase: null,
      result: input.shellUpdate || process.platform !== "darwin" ? "unknown" : "manual_required", failure: null };
    let checkingShell = false;
    let resourceFailure: unknown;
    networkContext = { signal, retry: createUpdateNetworkRetry({ signal,
      onExhausted() {
        if (!["healthy", "restored", "unavailable"].includes(bundleDetails.result)) bundleDetails.result = "manual_required";
      }, onRetry: context => {
      if (!input.host.onUpdateRetry) throw new Error("DESKTOP_UPDATE_RETRY_REPORTER_UNAVAILABLE");
      input.host.onUpdateRetry({ ...context, requestId: readReceiptErrorRequestId(context.error) ?? pendingUpdate?.requestId ?? requestId, deviceId });
    } }) };
    const flight = (async (): Promise<ActiveRelease | null> => {
      let failure: unknown;
      let active: ActiveRelease | null = null;
      try {
        if (unsettledReceipt) await reportReceiptInternal(unsettledReceipt.receipt, unsettledReceipt.following);
        signal.throwIfAborted();
        scheduleTelemetry();
        let downloaded: DownloadedRelease | null = null;
        if (preparedUpdate) {
          bundleDetails = { requestId: preparedUpdate.requestId, target: snapshotBundleVersion(preparedUpdate.manifest), phase: "prepare", result: "prepared", failure: null };
          if (!await authorizeReleaseSwitch(preparedUpdate.manifest, preparedUpdate.requestId, signal)) {
            // 授权拒绝只作废当前候选；后续发现结果按服务器真实情况保留，不能一律标成撤回。
            preparedUpdate = undefined;
            downloaded = await downloadDiscoveredReleaseInternal({ requestId, signal }, true);
          }
        } else downloaded = await downloadDiscoveredReleaseInternal({ requestId, signal }, true);
        if (downloaded) {
          const prepared = await coordinator.prepare(downloaded.directory, { requestId: downloaded.requestId, signal });
          await savePendingRelease(input.dataDir, { requestId: prepared.requestId, releaseId: prepared.manifest.releaseId, stagingDir: prepared.stagingDir });
          preparedUpdate = prepared;
          bundleDetails.result = "prepared";
        }
      } catch (error) {
        failure = error;
        // 用户已批准逐通道失败；资源错误保留给调用者，仍准备独立可用的壳。
        if ((error as { updateChannel?: unknown } | null)?.updateChannel !== "resource") throw error;
        resourceFailure = error;
        bundleDetails.result = "failure";
        updateCheckFailure = { requestId, error };
        input.host.onUpdateError?.(error, { requestId, deviceId, ...(manual ? {} : { logOnly: true }) });
      }
      finally {
        if (pendingUpdate) {
          try {
            for (const stage of ["healthy", "rolled_back", "unavailable"] as const) {
              if (await receiptJournal!.find(deviceId, pendingUpdate.requestId, stage)) { pendingUpdate = undefined; break; }
            }
          } catch (error) {
            throw failure === undefined ? error : new AggregateError([failure, error], "DESKTOP_UPDATE_ATTEMPT_STATE_FAILED");
          }
        }
      }
      if (updatesSuppressed) return active;
      // 优先完成已准备的资源；同轮创建壳绑定会在下次资源激活后失效。
      if (preparedUpdate) {
        const discovered = checkDiscoveries?.get(requestId);
        if (discovered && (await discovered).shellError) {
          checkingShell = true;
          await checkShellInternal(requestId, signal, manual, allowRestart);
        }
        if (!input.shellUpdate || input.shellUpdate.boundary?.spawnHelper) return active;
      }
      switchCommitted = false;
      signal.throwIfAborted();
      checkingShell = Boolean(input.shellUpdate);
      await checkShellInternal(requestId, signal, manual, allowRestart);
      return active;
    })().catch(error => {
      if (isAutomaticStop(error)) {
        if (checkingShell) shellDetails.result = "cancelled";
        else bundleDetails.result = "cancelled";
        throw error;
      }
      const failedRequestId = readReceiptErrorRequestId(error) ?? pendingUpdate?.requestId ?? requestId;
      // 自动检查失败仅记录并保留在更新设置中；只有手动检查才展示失败弹框。
      const logOnly = !(manual || updateFlightManualRequested);
      if (checkingShell) {
        if (shellDetails.result === "unknown") shellDetails.result = "failure";
        throw reportShellFailure(error, failedRequestId, { logOnly });
      }
      if (bundleDetails.result === "unknown") bundleDetails.result = "failure";
      let failure = error;
      try { input.host.onUpdateError?.(failure, { requestId: failedRequestId, deviceId, ...(logOnly ? { logOnly: true } : {}) }); }
      catch (reportError) { failure = new AggregateError([error, reportError], "DESKTOP_UPDATE_ERROR_REPORT_FAILED"); }
      updateCheckFailure = { requestId: failedRequestId, error: failure };
      throw failure;
    }).finally(() => {
      updateFlight = undefined;
      updateController = undefined;
      networkContext = undefined;
      checkDiscoveries = undefined;
      switchCommitted = false;
      operation = stoppingUpdates ? "exiting" : "idle";
      scheduleUpdateCheck();
    }).then(async active => {
      // 原flight先释放，再从唯一退出入口交出main，避免等待自身。
      const seenInManualCheck = manual || updateFlightManualRequested;
      updateFlightManualRequested = false;
      void notifyPreparedUpdate(seenInManualCheck);
      if (shellOwner && !stoppingUpdates) await application.exit();
      if (resourceFailure !== undefined) throw resourceFailure;
      return active;
    });
    updateFlightManualRequested = false;
    updateFlight = flight;
    // 失败已由所属边界发布并保留；该 Promise 仅用于退出等待，不改变调用者的拒绝结果。
    updateSettled = flight.then(() => undefined, error => {
      if (!isAutomaticStop(error) && !checkingShell) updateCheckFailure = { requestId: updateCheckFailure?.requestId ?? requestId, error };
    });
    return flight;
  };

  const application = {
    /** 仅供宿主存储/生命周期校验读取真实健康；页面getState继续遵守启动围栏。 */
    getRuntimeState(): ClientRuntimeSnapshot { return runtime.snapshot(); },
    /** 退出前读取运行中回合；Client 未就绪或读取失败时标记不可用，由宿主决定是否提示。 */
    async getActivity(): Promise<{
      available: boolean;
      runningTurns: Array<{ workspaceId: string; threadId: string; title: string; engine: string; turnId: string | null }>;
    }> {
      try {
        // 退出确认不等待慢 Client：短超时后按“不可确认”交宿主提示。
        const response = await runtime.request({ method: "runtime.activity" }, 2_000);
        const body = response.body as { ok?: boolean; activity?: { runningTurns?: unknown } } | null;
        if (response.status !== 200 || body?.ok !== true || !Array.isArray(body.activity?.runningTurns)) {
          // 响应非法与网络失败同样属于退出确认不可用，保留状态码便于排障。
          console.warn(JSON.stringify({ code: "DESKTOP_QUIT_ACTIVITY_INVALID", requestId: crypto.randomUUID(), status: response.status }));
          return { available: false, runningTurns: [] };
        }
        return { available: true, runningTurns: body.activity.runningTurns as Array<{ workspaceId: string; threadId: string; title: string; engine: string; turnId: string | null }> };
      } catch (error) {
        console.warn(JSON.stringify({ code: "DESKTOP_QUIT_ACTIVITY_READ_FAILED", requestId: crypto.randomUUID(),
          rootCause: error instanceof Error ? error.message : String(error) }));
        return { available: false, runningTurns: [] };
      }
    },
    /** 固定 origin 装配完成后才暴露网络更新可用性。 */
    get updateAvailable(): boolean { return transport !== undefined; },
    /** 最近一次补报失败的固定诊断信息；不暴露远端正文或凭据。 */
    get updateReceiptFailure(): { errorCode: string; requestId: string } | null { return receiptDeliveryFailure; },
    /** 最近一次错误日志补报失败的固定诊断信息和设备归属。 */
    get updateFailureFailure(): { errorCode: string; requestId: string; deviceId: string } | null { return failureDeliveryFailure; },
    get crashDeliveryFailure(): { errorCode: string; requestId: string; deviceId: string } | null { return crashDeliveryFailure; },
    /** 自动检查失败保留给主进程和手动重试，不改变本地运行时状态。 */
    get updateCheckFailure(): { requestId: string; error: unknown } | null { return updateCheckFailure; },
    /** 壳检查独立失败保持可见，不覆盖hot下载/回执失败事实。 */
    get shellUpdateFailure(): { requestId: string; error: unknown } | null { return shellUpdateFailure; },
    getUpdateDiagnostics,
    getUpdateState,
    getUpdateDetails,
    /** 页面启动补查待展示提醒；无提醒返回 null。 */
    getUpdateNotice(): Promise<DesktopUpdateNotice | null> { return updateNotice.peek(); },
    /** 关闭提醒；动作由桥接层固定白名单校验。 */
    dismissUpdateNotice(action: DesktopUpdateNoticeDismissAction): Promise<void> { return updateNotice.dismiss(action); },
    /** 本地启动成功后立即开启一次后台轮次；离线配置不启动调度。 */
    startAutomaticUpdates(): void {
      if (!transport) return;
      if (automaticUpdates) return;
      if (!window || operation !== "idle" || stoppingUpdates) throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
      if (!input.host.onUpdateError) throw new Error("DESKTOP_UPDATE_ERROR_REPORTER_UNAVAILABLE");
      automaticUpdates = true;
      // 上次运行已下载但未更新的候选，启动后再按 24 小时节流提醒。
      void notifyPreparedUpdate(false);
      beginUpdateCheck(false);
    },
    /** 手动恢复自动提醒并共享已有后台轮次，失败仍由调用者收到拒绝。 */
    checkForUpdates(): Promise<ActiveRelease | null> { return beginUpdateCheck(true); },
    /** 兼容原宿主调用；普通启动不执行壳更新，已准备工件只由显式重启消费。 */
    async resumeStartupUpdate(): Promise<boolean> {
      return false;
    },
    /** 同次显式重启先交出已准备原生壳，待更新资源由新壳冷启动消费。 */
    async restartForUpdate(): Promise<void> {
      if (operation !== "idle" || !window || !input.host.relaunch) throw new Error("DESKTOP_RESTART_UNAVAILABLE");
      if (!preparedUpdate && shellDetails.result !== "prepared") throw new Error("DESKTOP_UPDATE_NOT_PREPARED");
      const nativeUpdate = input.shellUpdate && !input.shellUpdate.boundary?.spawnHelper;
      let shellRestartFailure: unknown;
      if (nativeUpdate) {
        try { await beginUpdateCheck(true, true); }
        catch (error) {
          // 已批准通道隔离：壳失败显式保留，只允许仍可信的待更新资源独立重启。
          if (!preparedUpdate || updateCheckFailure || !shellUpdateFailure || shellOwner || !window) throw error;
          shellRestartFailure = error;
        }
        if (!window || shellOwner || updatesSuppressed) return;
      }
      if (!preparedUpdate) {
        if (nativeUpdate) return;
        await beginUpdateCheck(true, true);
        if (preparedUpdate && window && !shellOwner) await application.restartForUpdate();
        return;
      }
      /** 用户明确重启更新仍先确认运行中会话，不能静默终止回合。 */
      const activity = await controlUpdate(runtime, "runtime.update.prepare");
      if (typeof activity.hasRunningSessions !== "boolean") throw new Error("DESKTOP_UPDATE_ACTIVITY_INVALID");
      if (activity.hasRunningSessions) {
        if (!input.host.confirmUpdate) throw new Error("DESKTOP_UPDATE_CONFIRMATION_UNAVAILABLE");
        if (!await input.host.confirmUpdate(window, undefined)) return;
      }
      restartRequested = !shellOwner;
      try { await application.exit(); }
      finally { restartRequested = false; }
      if (shellRestartFailure !== undefined) throw shellRestartFailure;
    },
    /** 页面侧更新操作失败写入同一失败日志；原因码走宿主既有白名单，正文只保留为因果链。 */
    reportUpdateError(input: DesktopUpdateClientErrorReport): void {
      if (!failureJournal || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
      const error = new Error(input.code);
      if (input.message) error.cause = new Error(input.message.slice(0, 1000));
      const base = { ...getFailureContext(), requestId: input.requestId ?? crypto.randomUUID(), recovery: "not_needed" as const, error };
      if (input.target === "shell") failureJournal.recordShell({ ...base, shellId: input.shellId ?? null,
        phase: input.phase as Parameters<typeof failureJournal.recordShell>[0]["phase"] });
      else failureJournal.record({ ...base, releaseId: input.releaseId ?? "unknown", phase: input.phase });
    },
    /** 仅在身份和回执边界就绪后接受真实阶段事实。 */
    reportReceipt,
    /** 显式补报既有待报证据；未配置 origin 时明确拒绝。 */
    async flushReceipts(): Promise<void> {
      if (operation !== "idle") throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
      if (!receiptDelivery) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
      operation = "flushing";
      let requestId = "unknown";
      try {
        requestId = (await receiptJournal!.pending(identity!.deviceId))[0]?.requestId ?? requestId;
        await receiptDelivery.flush();
        receiptDeliveryFailure = null;
      } catch (error) {
        receiptDeliveryFailure = { errorCode: readReceiptErrorCode(error), requestId: readReceiptErrorRequestId(error) ?? requestId };
        throw error;
      } finally {
        operation = "idle";
      }
    },
    /** 显式补报已有错误日志；缺少 Server origin 时失败且不改变本地证据。 */
    async flushFailures(): Promise<void> {
      await flushFailures();
    },
    /** 用固定传输下载归档，received 仅在下载器确认落盘后生成。 */
    async downloadReleaseBundle(options: ApplicationDownloadOptions): Promise<Awaited<ReturnType<typeof downloadReleaseBundle>>> {
      if (operation !== "idle" || !window) throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
      if (!transport || !identity) throw new Error("DESKTOP_UPDATE_UNAVAILABLE");
      operation = "downloading";
      try {
        return await downloadReleaseInternal(options);
      } finally {
        operation = "idle";
      }
    },
    /** 自行发现唯一授权清单并下载；下载器完成验签前不会请求归档或写暂存。 */
    async downloadAvailableReleaseBundle(options: ApplicationDiscoveryOptions = {}): Promise<DownloadedRelease> {
      return await downloadDiscoveredRelease(options, false);
    },
    /** 正常无资格或可信活动同包返回空；新目标继续沿原下载及阶段回执入口。 */
    async downloadReleaseUpdateIfAvailable(options: ApplicationDiscoveryOptions = {}): Promise<DownloadedRelease | null> {
      return await downloadDiscoveredRelease(options, true);
    },
    /** 核验工件后沿迁移或 held 门禁启动；主动停止单独返回，真实故障不降级。 */
    async start(): Promise<void> {
      if (operation !== "idle" || window) throw new Error("DESKTOP_ALREADY_STARTED");
      operation = "starting";
      try {
        /** 启动页进度只做展示；held 续接尚无窗口时跳过。 */
        const reportStartup = async (label: string): Promise<void> => {
          if (!window) return;
          await input.host.updateStartupStatus?.(window, { label });
        };
        if (!continuation && input.host.loadStartup) {
          await input.host.loadStartup(ensureWindow());
          assertStartupRunning();
          window!.show();
          await reportStartup("正在读取本地版本信息…");
        }
        identity = await loadOrCreateDeviceIdentity(input.dataDir);
        assertStartupRunning();
        // 身份一旦可用即归属崩溃证据，避免启动早期异常只能留在本地。
        input.onRuntimeFacts?.({ deviceId: identity.deviceId, versions: {
          webVersion: currentVersion, clientVersion: currentClientVersion, releaseId: currentReleaseId } });
        receiptJournal = createUpdateReceiptJournal(input.dataDir);
        failureJournal = createUpdateFailureJournal(input.dataDir);
        if (input.configuredServerOrigin) {
          transport = createDesktopUpdateTransport({ dataDir: input.dataDir, identity, configuredServerOrigin: input.configuredServerOrigin,
            getVersions: presenceVersions, getNetworkContext: () => networkContext });
          receiptDelivery = createUpdateReceiptDelivery({ journal: receiptJournal, deviceId: identity.deviceId, transport });
        }
        const recoveredDatabase = await databaseBackup.recover(await readActivePointer(input.dataDir));
        assertStartupRunning();
        // pending 同时持有原库的迁移围栏；所有启动入口必须读取，损坏时禁止启动旧版。
        const recordedPending = await readPendingRelease(input.dataDir);
        // 资源先激活；已有壳准备记录在停旧 Client 后归档，再绑定新活动资源。
        let pending = !continuation ? recordedPending : null;
        let startupUpdateError: { requestId: string; error: unknown } | undefined;
        assertStartupRunning();
        const releaseTrust = { trustedReleaseKeys: input.trustedReleaseKeys, requireHeldStartup: Boolean(continuation),
          verification: !continuation && !pending && !startupUpdateError && !recoveredDatabase ? "startup" as const : "full" as const };
        await reportStartup("正在校验当前版本…");
        const activeRelease = await resolveActiveRelease(input.dataDir, releaseTrust);
        await reportStartup("正在校验安装资源…");
        const needsRepairBaseline = recordedPending?.databaseSchemaVersion !== undefined
          && (activeRelease?.manifest.dbSchemaVersion ?? 0) < recordedPending.databaseSchemaVersion;
        // 完整安装存在基线时参与选择；可信 active 的普通启动仍允许安装基线缺失。
        const baselineRelease = input.requireBaseline || continuation || needsRepairBaseline || !activeRelease && pending
          ? await resolveBaselineRelease(baselineReleaseDir, releaseTrust).catch((error: unknown) => {
            const failure = error as { code?: unknown; path?: unknown };
            const missing = failure.code === "DESKTOP_RELEASE_BASELINE_MISSING" || failure.code === "ENOENT"
              && failure.path === path.resolve(baselineReleaseDir);
            // 延续 active 独立启动；只接受根目录或证明缺失，资源缺文件和验签失败仍原样抛出。
            if (activeRelease && !continuation && !needsRepairBaseline && missing) return null;
            throw error;
          }) : null;
        assertStartupRunning();
        // 已验签修复基线可接管不兼容旧活动包；磁盘指针等真实健康后再清理。
        const repairingDatabase = Boolean(recordedPending?.databaseSchemaVersion && baselineRelease
          && baselineRelease.manifest.dbSchemaVersion >= recordedPending.databaseSchemaVersion
          && (!activeRelease || activeRelease.manifest.dbSchemaVersion < recordedPending.databaseSchemaVersion));
        // 壳接续只消费原授权绑定；普通完整安装按资源版本接管，不能降低已知数据库结构。
        const newerBaseline = Boolean(!continuation && input.requireBaseline && baselineRelease && activeRelease
          && compareResourceVersions(baselineRelease.manifest.version, activeRelease.manifest.version) > 0);
        if (newerBaseline && baselineRelease && activeRelease && baselineRelease.manifest.dbSchemaVersion < activeRelease.manifest.dbSchemaVersion) {
          throw Object.assign(new Error("DESKTOP_DB_SCHEMA_DOWNGRADE_FORBIDDEN"), { code: "DESKTOP_DB_SCHEMA_DOWNGRADE_FORBIDDEN",
            releaseId: baselineRelease.manifest.releaseId, activeReleaseId: activeRelease.releaseId,
            databaseSchemaVersion: activeRelease.manifest.dbSchemaVersion, targetDatabaseSchemaVersion: baselineRelease.manifest.dbSchemaVersion });
        }
        const startupActiveRelease = repairingDatabase || newerBaseline ? null : activeRelease;
        const currentSchema = startupActiveRelease?.manifest.dbSchemaVersion ?? baselineRelease?.manifest.dbSchemaVersion;
        // 修复安装先独立完成，不能改变壳交接已绑定的旧活动资源身份。
        if (recordedPending?.databaseSchemaVersion && (currentSchema === undefined || currentSchema < recordedPending.databaseSchemaVersion
          || (repairingDatabase && continuation))) {
          throw Object.assign(new Error("DESKTOP_DB_SCHEMA_FORWARD_ONLY：数据库可能已升级，已停止旧版本启动，请使用支持该数据结构的修复版本。"),
            { code: "DESKTOP_DB_SCHEMA_FORWARD_ONLY", requestId: recordedPending.requestId, releaseId: recordedPending.releaseId,
              databaseSchemaVersion: recordedPending.databaseSchemaVersion });
        }
        if (repairingDatabase) {
          // 修复包也可能继续向前迁移；先延续原记录的最低版本，再启动其 Client。
          await markPendingDatabaseMigration(input.dataDir, recordedPending!, baselineRelease!.manifest.dbSchemaVersion);
          pending = null;
        }
        if (pending) {
          try {
            await reportStartup("正在确认更新兼容性…");
            // 上方已完整核验依赖；这里只复核即将启动的核心文件与 held marker。
            await resolveBaselineRelease(baselineReleaseDir, { ...releaseTrust, verification: "startup", requireHeldStartup: true });
            if (startupActiveRelease) await resolveActiveRelease(input.dataDir, { ...releaseTrust, verification: "startup", requireHeldStartup: true });
            startupHeldId = crypto.randomUUID();
            initialStartup = { mode: "held", continuationId: startupHeldId };
          } catch (error) {
            startupUpdateError = { requestId: pending.requestId, error };
            pending = null;
          }
        }
        assertStartupRunning();
        const applyingUpdate = Boolean(pending);
        await reportStartup(applyingUpdate ? "正在准备更新…" : "正在启动…");
        const startupArtifacts = continuation ? JSON.stringify([baselineRelease, activeRelease]) : undefined;
        const releaseDir = startupActiveRelease?.releaseDir ?? baselineRelease?.releaseDir ?? input.initialReleaseDir;
        if (startupActiveRelease || baselineRelease || pending) runtime = createRuntime(clientEntry(releaseDir), startupActiveRelease?.manifest ?? baselineRelease?.manifest, initialStartup);
        bindRuntimeEvents();
        // 托盘入口始终可用；更新源未配置时由渲染器弹框明确提示，而不是把菜单项置灰。
        tray = input.host.createTray(application.openWindow, application.exit, () => {});
        migration = !continuation ? input.createMigration?.({ releaseDir, identity }) : undefined;
        /** 迁移屏障内不启动 Client；就绪后按已验签的实际资源登记发布身份。 */
        const startRuntime = async (): Promise<void> => {
          assertStartupRunning();
          await runtime.start();
          assertStartupRunning();
          await runtime.waitReady();
          assertStartupRunning();
          if (continuation) snapshotDesktopStartupReady(runtime.snapshot().startup, continuation.continuationId);
          if (startupHeldId) snapshotDesktopStartupReady(runtime.snapshot().startup, startupHeldId);
          const health = runtime.snapshot().health;
          currentReleaseId = startupActiveRelease?.releaseId ?? baselineRelease?.manifest.releaseId ?? "installation";
          currentArchiveSha256 = startupActiveRelease?.manifest.archiveSha256 ?? baselineRelease?.manifest.archiveSha256;
          currentVersion = startupActiveRelease?.manifest.webVersion ?? baselineRelease?.manifest.webVersion ?? health?.clientVersion ?? "unknown";
          currentClientVersion = health?.clientVersion ?? "unknown";
          currentBundleVersion = startupActiveRelease ? snapshotBundleVersion(startupActiveRelease.manifest)
            : baselineRelease ? snapshotBundleVersion(baselineRelease.manifest) : null;
          input.onRuntimeFacts?.({ deviceId: identity!.deviceId, versions: {
            webVersion: currentVersion, clientVersion: currentClientVersion, releaseId: currentReleaseId } });
          if (startupActiveRelease) syncActiveRelease(startupActiveRelease);
          if (!startupActiveRelease && health) initialExpectation = baselineRelease?.manifest ?? {
            releaseId: "installation", clientVersion: health.clientVersion, protocolVersion: health.protocolVersion, dbSchemaVersion: health.dbSchemaVersion,
          };
          reportDevicePresence();
          if (transport && !presenceTimer) {
            presenceTimer = setInterval(reportDevicePresence, 6 * 60 * 60 * 1000);
            presenceTimer.unref?.();
          }
        };
        await reportStartup("正在启动本地服务…");
        if (!migration) await startRuntime();
        window = ensureWindow();
        await reportStartup("正在加载工作台…");
        const bridge = createDesktopBridge({
          /** Client健康与业务放行分开；页面仅在原启动围栏解除后执行首次业务初始化。 */
          getState: () => {
            const state = runtime.snapshot();
            return state.status === "ready" && (operation === "starting" || startupHeldId) ? { ...state, status: "starting" as const } : state;
          }, openWindow: application.openWindow, exit: application.exit,
          platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
          /** preload固定暴露能力；无迁移的held启动也必须提供明确的就绪事实。 */
          getMigrationState: async () => migration?.snapshot() ?? { status: "ready", migrationId: null, candidateId: null, workspaceCount: 0,
            stage: "not_needed", completed: 0, total: null, errorCode: null, message: null,
            account: { status: "not_requested", errorCode: null, message: null } },
          startMigration: async (candidateId: string) => { if (!migration) throw new Error("MIGRATION_UNAVAILABLE"); await migration.start(candidateId); },
          deferMigration: async () => { if (!migration) throw new Error("MIGRATION_UNAVAILABLE"); await migration.defer(); },
          retryMigrationAccount: async () => { if (!migration) throw new Error("MIGRATION_UNAVAILABLE"); await migration.retryAccount(); },
          /** 无迁移即无来源凭据或待交付会话；取消无需创建记录。 */
          takeMigrationAccount: async () => migration ? await migration.takeAccount() : null,
          acknowledgeMigrationAccount: async () => { if (migration) await migration.acknowledgeAccount(); },
          cancelMigrationAccount: async () => { if (migration) await migration.cancelAccount(); },
          onMigrationState: (listener: Parameters<LegacyClientMigration["subscribe"]>[0]) => migration ? migration.subscribe(listener) : () => {},
          getUpdateDiagnostics,
          getUpdateState,
          getUpdateDetails,
          getUpdateNotice: application.getUpdateNotice,
          dismissUpdateNotice: application.dismissUpdateNotice,
          restartForUpdate: application.restartForUpdate,
          reportUpdateError: async input => { application.reportUpdateError(input); },
          /** 页面只等待原检查，关联本次原失败，保根因与本机上下文，不返回ActiveRelease。 */
          checkForUpdates: async () => {
            try { await application.checkForUpdates(); }
            catch (cause) {
              throw Object.assign(new Error("DESKTOP_UPDATE_CHECK_FAILED", { cause }), {
                code: "DESKTOP_UPDATE_CHECK_FAILED", deviceId: identity?.deviceId,
                updateRequestId: updateCheckFailure?.error === cause ? updateCheckFailure?.requestId
                  : shellUpdateFailure?.error === cause ? shellUpdateFailure?.requestId : undefined,
              });
            }
          },
          /** 业务请求沿同一运行时；生命周期围栏以结构化失败交给原IPC边界。 */
          request: async (request) => {
            if (migration && migration.snapshot().status !== "ready") {
              throw Object.assign(new Error("DESKTOP_MIGRATION_IN_PROGRESS"), { code: "DESKTOP_MIGRATION_IN_PROGRESS" });
            }
            if (String(request?.method).startsWith("runtime.update.")) throw new Error("DESKTOP_UPDATE_CONTROL_FORBIDDEN");
            if (String(request?.method).startsWith("runtime.startup.")) throw new Error("DESKTOP_STARTUP_CONTROL_FORBIDDEN");
            if (startupHeldId || continuation && operation === "starting") throw new Error("DESKTOP_STARTUP_HELD");
            // 退出中返回结构化状态，让渲染进程识别为正常收尾而不是弹出 IPC 错误。
            if (operation === "exiting") {
              return { status: 503, body: { ok: false, code: "APP_SHUTTING_DOWN", message: "CodeFlow 正在退出" } };
            }
            if (shellOwner || ((operation === "updating" || operation === "checking")
              && ["workspaces.upsert", "workspaces.delete", "workspaceExecutionProfile.update"].includes(request?.method))) {
              throw Object.assign(new Error('DESKTOP_OPERATION_IN_PROGRESS'), { code: 'DESKTOP_OPERATION_IN_PROGRESS', operation });
            }
            if (request.method === "runtime.cloudAccount.unlink") cancelCloudLinkPreparation();
            if (request.method === "runtime.cloudAccount.link") return await linkCloudAccount(request);
            return await runtime.request(request);
          },
          /** 消费者跨绑定包更新继续订阅，退出销毁时统一清理。 */
          onEvent: (listener) => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
        });
        unregister = input.host.registerBridge(bridge, window);
        if (migration) {
          window.show();
          const owner = migration;
          /** 发现与页面互相提供进度；并行等待真实就绪，任一失败先停止迁移再收妥在途任务。 */
          const ready = (async () => { await owner.prepare(); await startRuntime(); await owner.runtimeReady(); })();
          const web = reloadWeb(releaseDir, {
            /** 选择与失败页可独立交互；自动启动等待迁移和账号恢复收口后再计时。 */
            beforeReady: async () => {
              await owner.whenDiscovered();
              const status = owner.snapshot().status;
              if (status !== "available" && status !== "failed") await ready;
            },
          });
          try { await Promise.all([ready, web]); }
          catch (error) {
            try { await owner.stop(); }
            catch (cleanupError) { throw new DesktopStartupCleanupError(error, cleanupError); }
            const settled = await Promise.allSettled([ready, web]);
            // stop触发的配套取消属于清理结果；保留原失败及所有独立故障，不遗留迁移续体。
            const failures = [error, ...settled.filter((result): result is PromiseRejectedResult => result.status === "rejected")
              .map(result => result.reason).filter(cause => cause !== error && (cause as { code?: string } | null)?.code !== "MIGRATION_STOPPED")];
            if (failures.length > 1) throw new AggregateError(failures, "DESKTOP_MIGRATION_STARTUP_FAILED");
            throw error;
          }
        } else {
          await reportStartup("正在加载工作台…");
          await reloadWeb(releaseDir);
        }
        assertStartupRunning();
        if (repairingDatabase || newerBaseline) {
          const current = runtime.snapshot();
          if (current.status !== "ready" || current.health?.database !== "ready") throw new Error("DESKTOP_CURRENT_RUNTIME_NOT_HEALTHY");
          // 基线和页面健康后再清旧指针，使后续更新及其恢复都以当前安装资源为准。
          await clearIncompatibleActiveRelease(input.dataDir, activeRelease?.releaseId ?? null);
        }
        if (pending) {
          await activatePendingAtStartup(pending, startupActiveRelease);
          if (bundleDetails.result === "healthy" && !updateCheckFailure) {
            input.host.onUpdateApplied?.({ version: currentVersion });
          }
        }
        if (startupUpdateError) {
          updateCheckFailure = startupUpdateError;
          bundleDetails = { requestId: startupUpdateError.requestId, target: null, phase: "prepare", result: "failure", failure: null };
          failureJournal.record({ ...getFailureContext(), requestId: startupUpdateError.requestId, releaseId: "unknown",
            phase: "prepare", recovery: "not_needed", error: startupUpdateError.error });
          input.host.onUpdateError?.(startupUpdateError.error, { requestId: startupUpdateError.requestId, deviceId: identity.deviceId });
          // 已确认更新故障可保留当前完整版本；损坏的待更新事实不改变当前资源和数据库。
        }
        if (startupHeldId) {
          await continueHeldRuntime(startupHeldId);
          startupHeldId = undefined;
        }
        if (continuation) {
          const baselineBeforeAuthorization = await resolveBaselineRelease(baselineReleaseDir, releaseTrust);
          const activeBeforeAuthorization = await resolveActiveRelease(input.dataDir, releaseTrust);
          if (JSON.stringify([baselineBeforeAuthorization, activeBeforeAuthorization]) !== startupArtifacts) throw new Error("DESKTOP_STARTUP_ARTIFACT_CHANGED");
          const client = runtime.snapshot();
          if (client.status !== "ready" || !client.health) throw new Error("CLIENT_NOT_READY");
          snapshotDesktopStartupReady(client.startup, continuation.continuationId);
          await continuation.authorizeReady({ client, baseline: structuredClone(baselineBeforeAuthorization!), active: structuredClone(activeBeforeAuthorization),
            web: { loaded: true, releaseDir }, continueRequestId: crypto.randomUUID() });
          const baselineAfterAuthorization = await resolveBaselineRelease(baselineReleaseDir, releaseTrust);
          const activeAfterAuthorization = await resolveActiveRelease(input.dataDir, releaseTrust);
          if (JSON.stringify([baselineAfterAuthorization, activeAfterAuthorization]) !== startupArtifacts) throw new Error("DESKTOP_STARTUP_ARTIFACT_CHANGED");
          const current = runtime.snapshot();
          if (current.status !== "ready" || current.requestId !== client.requestId || current.pid !== client.pid) throw new Error("DESKTOP_STARTUP_CLIENT_CHANGED");
          snapshotDesktopStartupReady(current.startup, continuation.continuationId);
          await continueHeldRuntime(continuation.continuationId);
        }
        if (repairingDatabase) {
          await clearPendingRelease(input.dataDir);
        }
        window.show();
        scheduleTelemetry();
      } catch (error) {
        if (startupExitRequested) {
          try { await startupExitFlight; }
          catch (cleanupError) { throw new DesktopStartupCleanupError(error, cleanupError); }
          // 只翻译 Runtime 明确的主动停止；真实启动与退出清理错误继续向上失败。
          if (["CLIENT_STARTUP_STOPPED", "ERR_ABORTED"].includes(String((error as { code?: unknown } | null)?.code))) {
            const code = migration ? "MIGRATION_STOPPED" : "DESKTOP_STARTUP_STOPPED";
            throw Object.assign(new Error(code, { cause: error }), { code });
          }
          throw error;
        }
        if (error instanceof DesktopStartupCleanupError) throw error;
        try {
          await runtime.drain();
          destroyShell();
        } catch (cleanupError) {
          throw new DesktopStartupCleanupError(error, cleanupError);
        }
        throw error;
      } finally {
        if (!startupExitRequested) operation = "idle";
      }
    },
    /** 托盘、Dock 或第二实例唤醒当前窗口；最小化状态先恢复再聚焦。 */
    openWindow(): void {
      if (window?.isMinimized?.()) window.restore?.();
      window?.show();
      window?.focus();
    },
    /** 显式退出有界等待 Client；失败保留窗口和托盘以便重试。 */
    async exit(): Promise<void> {
      if (exitFlight) return await exitFlight;
      if (operation !== "idle" && operation !== "checking" && !(operation === "starting" && (migration || window)) || stoppingUpdates) throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
      stoppingUpdates = true;
      if (telemetryTimer) clearTimeout(telemetryTimer);
      telemetryTimer = undefined;
      cancelCloudLinkPreparation();
      if (operation === "starting") startupExitRequested = true;
      automaticUpdates = false;
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = undefined;
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = undefined;
      presenceTransport = undefined;
      /** 启动取消与启动失败共享这一退出结果，清理失败不能被 STOPPED 掩盖。 */
      const closing = (async (): Promise<void> => {
        try {
          if (shellOwner && shellUpdateFailure) throw shellUpdateFailure.error;
          if (updateFlight) {
            if (!switchCommitted) updateController?.abort(updateStopReason);
            await updateSettled;
            if (updateCheckFailure) throw updateCheckFailure.error;
            if (shellUpdateFailure) throw shellUpdateFailure.error;
          }
          operation = "exiting";
          await migration?.stop();
          shellOwner?.check();
          if (shellDrainedRuntime !== runtime) await runtime.drain();
          destroyShell();
          if (restartRequested) input.host.relaunch!();
          input.host.quit();
          shellOwner?.release();
          shellOwner = undefined;
        } catch (cause) {
          if (!shellOwner) throw cause;
          const failure = await shellOwner.recover(cause, Boolean(window));
          throw reportShellFailure(failure, readReceiptErrorRequestId(failure) ?? shellUpdateFailure?.requestId ?? "unknown");
        } finally {
          stoppingUpdates = false;
          operation = "idle";
        }
      })();
      if (startupExitRequested) startupExitFlight = closing;
      exitFlight = closing;
      try {
        await closing;
      } finally {
        exitFlight = undefined;
      }
    },
    /** 串行切换整组资源，首次更新失败时恢复安装包中的整组版本。 */
    async applyRelease(packageDir: string, options: { requestId?: string; signal?: AbortSignal } = {}): Promise<ActiveRelease | null> {
      if (operation !== "idle" || !window) throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
      if (input.configuredServerOrigin && !options.requestId) throw new Error("DESKTOP_UPDATE_REQUEST_ID_REQUIRED");
      operation = "updating";
      try {
        return await applyReleaseInternal(packageDir, options);
      } finally {
        operation = "idle";
      }
    },
  };
  return application;
}

/** 严格清单已由原 owner 校验；只复制四个版本字段。 */
function snapshotBundleVersion(manifest: Pick<DownloadedRelease["manifest"], "releaseId" | "version" | "webVersion" | "clientVersion">): DesktopBundleVersion {
  return { releaseId: manifest.releaseId, version: manifest.version, webVersion: manifest.webVersion, clientVersion: manifest.clientVersion };
}

/** 仅读错误数据描述符，再复用公开映射；访问器与任意扩展属性不执行或传播。 */
function snapshotUpdateDiagnostic(value: unknown, shell = false): ReturnType<typeof toUpdateDiagnosticCause> {
  /** 有界复制原错误因果数据，避免既有映射求值不可信getter。 */
  const copy = (input: unknown, depth: number): Error | undefined => {
    if (!(input instanceof Error)) return undefined;
    const fields = Object.getOwnPropertyDescriptors(input);
    /** 访问器不属于可投影数据，交原诊断映射归为未知。 */
    const read = (key: string): unknown => fields[key] && "value" in fields[key]! ? fields[key]!.value : undefined;
    const message = read("message"), code = read("code"), cause = read("cause"), errors = read("errors");
    const children = depth < 3 && input instanceof AggregateError && Array.isArray(errors)
      ? Object.keys(errors).filter(key => /^(0|[1-9][0-9]*)$/u.test(key)).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(errors, key);
        return descriptor && "value" in descriptor ? copy(descriptor.value, depth + 1) : undefined;
      }) : [];
    const result = input instanceof AggregateError ? new AggregateError(children, typeof message === "string" ? message : "")
      : input instanceof SyntaxError ? new SyntaxError(typeof message === "string" ? message : "") : new Error(typeof message === "string" ? message : "");
    const name = fields.name ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "name");
    if (name && "value" in name && typeof name.value === "string") result.name = name.value;
    if (typeof code === "string") Object.assign(result, { code });
    if (depth < 3 && cause !== undefined && !(input instanceof AggregateError)) result.cause = copy(cause, depth + 1);
    return result;
  };
  return (shell ? toShellUpdateDiagnosticCause : toUpdateDiagnosticCause)(copy(value, 0));
}

/** 故障关联仅接受原短ID；补报错误码仍经同一公开诊断映射。 */
function snapshotUpdateStateFailure(value: { requestId: string; error?: unknown; errorCode?: string } | null, shell = false): DesktopUpdateState["updateCheckFailure"] {
  if (value === null) return null;
  const fields = Object.getOwnPropertyDescriptors(value), requestId = fields.requestId?.value;
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u.test(requestId)) {
    throw Object.assign(new Error("DESKTOP_UPDATE_STATE_INVALID"), { code: "DESKTOP_UPDATE_STATE_INVALID" });
  }
  const error = fields.error ? fields.error.value : Object.assign(new Error(typeof fields.errorCode?.value === "string" ? fields.errorCode.value : ""), { code: fields.errorCode?.value });
  return { requestId, rootCause: snapshotUpdateDiagnostic(error, shell) };
}

/** 提取固定错误码和实际失败回执 requestId，避免旧待报覆盖当前失败上下文。 */
function readReceiptErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") return (cause as { code: string }).code;
    if (typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  }
  return "DESKTOP_UPDATE_RECEIPT_FAILED";
}

/** 从 Journal/Transport 包装错误读取失败条目的 requestId。 */
function readReceiptErrorRequestId(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { requestId?: unknown }).requestId === "string"
    ? (error as { requestId: string }).requestId : undefined;
}

/** 提取错误补报失败的固定错误码，优先保留传输边界提供的公开码。 */
function readFailureErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") return (cause as { code: string }).code;
    if (typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  }
  return "DESKTOP_UPDATE_FAILURE_DELIVERY_FAILED";
}

/** 提取错误补报失败条目实际使用的 requestId，不回显远端正文。 */
function readFailureErrorRequestId(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { requestId?: unknown }).requestId === "string"
    ? (error as { requestId: string }).requestId : undefined;
}
