import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { describeUserFacingError } from "@codeflowai/shared";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, Tray, protocol, shell, session } from "electron";
import type { DesktopApiRequest, DesktopUpdateClientErrorReport } from "@codeflowai/shared";
import { assertTrustedReleaseKeys, type TrustedReleaseKeys } from "@codeflowai/shared/desktop-release-signing";

import { createDesktopApplication, DesktopStartupCleanupError } from "./desktopApplication.js";
import { resolveClientCliRuntime } from "./clientRuntime.js";
import { createLegacyClientMigration, resolveLegacyClientMigrationWorker, cancelLegacyMigrationAccountForUninstall } from "./legacyClientMigration.js";
import { createDesktopCrashCapture } from "./crashReportCapture.js";
import type { DesktopBridgeApi } from "./contracts.js";
import { loadWeb, loadStartupWeb, updateStartupWeb } from "./webLoader.js";
import { readInstalledUpdateOrigin } from './updateConfiguration.js';
import { bindMainFrameEvents } from "./mainFrameEvents.js";
import { resolveVersionedShellStartup } from "./shellLaunchState.js";
import { readCandidateShellHealthRequest, executeCandidateShellHealth, assertCandidateShellHealthEnvironment,
  reportCandidateShellHealthFailure, type CandidateShellHealthRequest } from "./candidateShellHealth.js";
import { DESKTOP_WEB_ENTRY, createDesktopWebHandler, isTrustedDesktopUrl, assertTrustedDesktopSender, resolveDesktopInitialEntry } from "./webProtocol.js";
import { readShellHandoffStartup, createShellHandoffContinuation, startShellRecoveryController, readShellUpdateHostFacts, retireShellUpdateAttempt,
  snapshotShellHandoffErrorContext, type ShellRecoveryControllerOwner } from "./shellHandoff.js";
import { abandonStalledShellUpdateRecovery } from "./shellUpdateRecoveryAbandon.js";
import { processSnapshot, type ProcessIdentity } from "./windowsProcessIdentity.js";
import { resolveDesktopStorageLocation, persistDesktopStorageLocation, completeDesktopStorageLocation,
  verifyDesktopStorageLocation, registerDesktopInstallation, appendDesktopStartupDiagnostic,
  rebindDesktopInstallRoot, type DesktopStorageLocation } from "./desktopStorageLocation.js";
import { completeDesktopReinstallLocation } from "./desktopStorageLocation.js";
import { assertDesktopMaintenanceStartup, DesktopMaintenanceStartupError, prepareDesktopReinstall, finishDesktopReinstall,
  beginDesktopMaintenance, authorizeDesktopMaintenance, completeDesktopMaintenance, readDesktopMaintenanceStartup, rebindDesktopKeepInstallation,
  type MaintenanceRecord } from "./desktopMaintenanceRecord.js";
import { loadOrCreateDeviceIdentity } from "./deviceIdentity.js";
import { resolveActiveRelease, resolveBaselineRelease } from "./releaseBundleCoordinator.js";
import { supersedeDesktopInstallationAttempt } from "./installationRepair.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/** 仅本地未签名 macOS 包携带该标记；它只跳过打包态基线要求，不参与签名或更新校验。 */
function readUnsignedLocalMarker(): boolean {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  const marker = path.join(process.resourcesPath, "desktop-unsigned-local.json");
  const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!stat) return false;
  const fail = (code: string): never => {
    throw Object.assign(new Error(code), { code });
  };
  if (!stat.isFile() || stat.isSymbolicLink()) fail("DESKTOP_UNSIGNED_LOCAL_MARKER_INVALID");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(marker))); }
  catch (cause) { throw Object.assign(new Error("DESKTOP_UNSIGNED_LOCAL_MARKER_INVALID", { cause }), { code: "DESKTOP_UNSIGNED_LOCAL_MARKER_INVALID" }); }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (record.schemaVersion !== 1 || record.reason !== "unsigned-local-package") fail("DESKTOP_UNSIGNED_LOCAL_MARKER_INVALID");
  return true;
}

/** 读取正在执行的壳包版本；开发启动也不使用Electron或工作目录的版本。 */
function readRunningShellVersion(): string {
  try {
    const metadata: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.resolve(currentDirectory, "../package.json"))));
    const version = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as { shellVersion?: unknown }).shellVersion ?? (metadata as { version?: unknown }).version : undefined;
    if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u.test(version)) throw new Error("Shell package version is missing or invalid");
    return version;
  } catch (cause) {
    throw Object.assign(new Error("DESKTOP_SHELL_VERSION_INVALID", { cause }), { code: "DESKTOP_SHELL_VERSION_INVALID" });
  }
}

// 仅成功预记录的同一错误对象可跳过后续重复日志，展示仍沿原入口。
const preloggedDesktopErrors = new WeakSet<Error>();
type DesktopErrorContext = {
  errorCode: string; requestId: string; deviceId?: string; retry?: number; delayMs?: number;
  shellAttemptRequestId?: string; continuationId?: string; shellId?: string; revision?: number; phase?: string;
  maintenanceRequestId?: string; clientId?: string | null; oldDeviceId?: string | null; nextDeviceId?: string; mode?: string; maintenancePhase?: string;
  startupDiagnostic?: boolean; maintenanceStage?: string;
  channel?: string; method?: string;
  updateRequestId?: string;
  registrationRequestId?: string;
};

/** 创建沙箱窗口，并将外部页面交给系统浏览器。 */
function createDefaultWindow(webEntry: string, onError: (error: unknown) => void): BrowserWindow {
  const created = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    // 首帧绘制前使用 Web 主题背景，避免无边框窗口启动时闪白。
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f1e1d" : "#faf9f5",
    // 打包后由可执行文件携带图标；本地运行时显式使用 CodeFlow 图标。
    ...(app.isPackaged ? {} : { icon: path.resolve(currentDirectory, "../build/icon.png") }),
    // macOS 保留原生红绿灯，其余平台使用无边框窗口与 Web 标题栏。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const openExternal = (url: string): void => {
    if (!/^https?:\/\//i.test(url)) return;
    void shell.openExternal(url).catch(onError);
  };
  created.webContents.on("will-navigate", (event, url) => {
    if (isTrustedDesktopUrl(url, webEntry)) return;
    event.preventDefault();
    openExternal(url);
  });
  created.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedDesktopUrl(url, webEntry)) event.preventDefault();
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  return created;
}

/** 托盘命令交给应用唯一 owner；失败保留应用并展示原因。 */
function createTray(open: () => void, exit: () => Promise<void>, onExitError: (error: unknown) => void, checkForUpdates?: () => void, openFeedback?: () => void,
  uninstall?: () => void): Tray {
  const iconPath = app.isPackaged ? path.join(process.resourcesPath, "shell-icon.png")
    : path.resolve(currentDirectory, "../build/icon.png");
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) throw new Error("DESKTOP_TRAY_ICON_INVALID");
  const icon = image.resize({ width: 16, height: 16 });
  // 菜单栏随系统明暗切换，按模板图渲染避免深色模式下不可见。
  if (process.platform === "darwin") icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip("CodeFlow");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开窗口", click: open },
    { label: "意见反馈", click: openFeedback ?? (() => {}) },
    { label: "检查更新", enabled: !!checkForUpdates, click: checkForUpdates },
    { type: "separator" },
    ...(uninstall ? [{ label: "卸载 CodeFlow…", click: uninstall }] : []),
    { label: "退出应用", click: () => { void exit().catch(onExitError); } },
  ]));
  tray.on("click", open);
  return tray;
}

/** 在唯一 IPC 边界校验窗口与主 frame，并把失败交给调用方。 */
function registerIpcHandlers(bridge: DesktopBridgeApi, window: BrowserWindow, webEntry: string,
  logError: (error: unknown, context?: DesktopErrorContext) => void,
  takeUpdateCheckRequest?: () => boolean,
  takeFeedbackRequest?: () => boolean,
  quitConfirmation?: { markReady: (ready: boolean) => void; respond: (confirmed: boolean) => void }): () => void {
  if (!bridge.onEvent) throw new Error("DESKTOP_EVENT_BRIDGE_REQUIRED");
  const operations: Record<string, (payload: unknown) => unknown> = {
    ...(quitConfirmation ? {
      "desktop:quitConfirmReady": () => { quitConfirmation.markReady(true); },
      "desktop:quitConfirmUnready": () => { quitConfirmation.markReady(false); },
      "desktop:respondQuitConfirm": (confirmed: unknown) => {
        if (typeof confirmed !== "boolean") throw Object.assign(new Error("DESKTOP_QUIT_CONFIRM_INVALID"), { code: "DESKTOP_QUIT_CONFIRM_INVALID" });
        quitConfirmation.respond(confirmed);
      },
    } : {}),
    ...(takeUpdateCheckRequest ? { "desktop:takeUpdateCheckRequest": () => takeUpdateCheckRequest() } : {}),
    ...(takeFeedbackRequest ? { "desktop:takeFeedbackRequest": () => takeFeedbackRequest() } : {}),
    "desktop:getState": bridge.getState, "desktop:openWindow": bridge.openWindow, "desktop:exit": bridge.exit,
    ...(bridge.getMigrationState ? {
      "desktop:getMigrationState": () => bridge.getMigrationState!(),
      "desktop:startMigration": async (candidateId: unknown) => {
        if (typeof candidateId !== "string" || !candidateId || candidateId.length > 256) throw new Error("MIGRATION_CANDIDATE_INVALID");
        await bridge.startMigration!(candidateId);
      },
      "desktop:deferMigration": () => bridge.deferMigration!(),
      "desktop:retryMigrationAccount": () => bridge.retryMigrationAccount!(),
      "desktop:takeMigrationAccount": () => bridge.takeMigrationAccount!(),
      "desktop:acknowledgeMigrationAccount": () => bridge.acknowledgeMigrationAccount!(),
      "desktop:cancelMigrationAccount": () => bridge.cancelMigrationAccount!(),
    } : {}),
    // 诊断不接受页面参数，沿原窗口和来源门禁执行。
    ...(bridge.getUpdateDiagnostics ? { "desktop:getUpdateDiagnostics": () => bridge.getUpdateDiagnostics!() } : {}),
    ...(bridge.getUpdateState ? { "desktop:getUpdateState": () => bridge.getUpdateState!() } : {}),
    ...(bridge.getUpdateDetails ? { "desktop:getUpdateDetails": () => bridge.getUpdateDetails!() } : {}),
    ...(bridge.getUpdateNotice ? { "desktop:getUpdateNotice": () => bridge.getUpdateNotice!() } : {}),
    ...(bridge.dismissUpdateNotice ? { "desktop:dismissUpdateNotice": (action: unknown) => {
      if (action !== "later" && action !== "session") throw Object.assign(new Error("DESKTOP_UPDATE_NOTICE_ACTION_INVALID"), { code: "DESKTOP_UPDATE_NOTICE_ACTION_INVALID" });
      return bridge.dismissUpdateNotice!(action);
    } } : {}),
    ...(bridge.checkForUpdates ? { "desktop:checkForUpdates": async () => { await bridge.checkForUpdates!(); } } : {}),
    ...(bridge.restartForUpdate ? { "desktop:restartForUpdate": async () => { await bridge.restartForUpdate!(); } } : {}),
    ...(bridge.reportUpdateError ? { "desktop:reportUpdateError": async (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Object.assign(new Error("DESKTOP_UPDATE_ERROR_INVALID"), { code: "DESKTOP_UPDATE_ERROR_INVALID" });
      const input = payload as Record<string, unknown>;
      const requestId = input.requestId, releaseId = input.releaseId, shellId = input.shellId, message = input.message, target = input.target;
      if (!["discovery", "download", "prepare", "read-active", "verify", "compatibility", "prepare-directory", "drain",
        "restart-client", "reload-web", "health", "activate", "install", "handoff", "admission-intent", "recovery"].includes(String(input.phase))
        || typeof input.code !== "string" || !/^[A-Z][A-Z0-9_]{1,99}$/u.test(input.code)
        || (target != null && target !== "bundle" && target !== "shell")
        || (requestId != null && (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u.test(requestId)))
        || (releaseId != null && (typeof releaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(releaseId)))
        || (shellId != null && (typeof shellId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u.test(shellId)))
        || (message != null && (typeof message !== "string" || message.length > 1000))) {
        throw Object.assign(new Error("DESKTOP_UPDATE_ERROR_INVALID"), { code: "DESKTOP_UPDATE_ERROR_INVALID" });
      }
      await bridge.reportUpdateError!({
        phase: input.phase as DesktopUpdateClientErrorReport["phase"], code: input.code,
        ...(target == null ? {} : { target: target as "bundle" | "shell" }),
        ...(shellId == null ? {} : { shellId: shellId as string }),
        ...(requestId == null ? {} : { requestId: requestId as string }),
        ...(releaseId == null ? {} : { releaseId: releaseId as string }),
        ...(message == null ? {} : { message: message as string }),
      });
    } } : {}),
    "desktop:request": (request: unknown) => bridge.request(request as DesktopApiRequest),
    /** 本机目录选择绑定当前窗口，页面只能提供初始目录，不能改变选择类型。 */
    "desktop:selectDirectory": async (initialPath: unknown) => {
      if (bridge.getMigrationState && (await bridge.getMigrationState()).status !== "ready") throw new Error("DESKTOP_MIGRATION_IN_PROGRESS");
      if (initialPath !== undefined && (typeof initialPath !== "string" || initialPath.includes("\0"))) {
        throw Object.assign(new Error("DESKTOP_DIRECTORY_PATH_INVALID"), { code: "DESKTOP_DIRECTORY_PATH_INVALID" });
      }
      const defaultPath = typeof initialPath === "string" ? initialPath.trim() : "";
      const result = await dialog.showOpenDialog(window, {
        title: "选择工作区目录",
        properties: ["openDirectory"],
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (result.canceled) return null;
      if (result.filePaths.length !== 1 || !result.filePaths[0]) {
        throw Object.assign(new Error("DESKTOP_DIRECTORY_SELECTION_INVALID"), { code: "DESKTOP_DIRECTORY_SELECTION_INVALID" });
      }
      return result.filePaths[0];
    },
    // 无边框窗口控制：关闭沿用原“隐藏到托盘”边界，不直接退出进程。
    "desktop:windowControl.minimize": () => { window.minimize(); },
    "desktop:windowControl.toggleMaximize": () => {
      if (window.isMaximized()) window.unmaximize(); else window.maximize();
      return { maximized: window.isMaximized() };
    },
    "desktop:windowControl.close": () => { window.close(); },
    "desktop:windowControl.state": () => ({ maximized: window.isMaximized() }),
  };
  for (const [channel, action] of Object.entries(operations)) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      const requestId = crypto.randomUUID();
      let trusted = false;
      try {
        assertTrustedDesktopSender({
          mainFrame: event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
          url: event.senderFrame?.url ?? "about:blank",
        }, webEntry);
        trusted = true;
        return await action(payload);
      } catch (error) {
        try {
          // 仅读自有数据字段，不求值 getter，不记录正文、查询或凭据。
          const descriptor = channel === 'desktop:request' && payload && typeof payload === 'object'
            ? Object.getOwnPropertyDescriptor(payload, 'method') : undefined;
          const method = descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
            && /^[A-Za-z][A-Za-z0-9._]{0,127}$/u.test(descriptor.value) ? descriptor.value as string : undefined;
          const cloudLink = channel === 'desktop:request' && method === 'runtime.cloudAccount.link';
          const device = (cloudLink || ['desktop:getUpdateDiagnostics', 'desktop:getUpdateState', 'desktop:getUpdateDetails', 'desktop:getUpdateNotice', 'desktop:checkForUpdates', 'desktop:restartForUpdate'].includes(channel)) && error && typeof error === 'object'
            ? Object.getOwnPropertyDescriptor(error, 'deviceId') : undefined;
          const deviceId = device && 'value' in device && typeof device.value === 'string'
            && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(device.value) ? device.value as string : undefined;
          const update = ['desktop:getUpdateState', 'desktop:getUpdateDetails', 'desktop:checkForUpdates', 'desktop:restartForUpdate'].includes(channel) && error && typeof error === 'object'
            ? Object.getOwnPropertyDescriptor(error, 'updateRequestId') : undefined;
          const updateRequestId = update && 'value' in update && typeof update.value === 'string'
            && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/u.test(update.value) ? update.value as string : undefined;
          const registration = cloudLink && error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'registrationRequestId') : undefined;
          const registrationRequestId = registration && 'value' in registration && typeof registration.value === 'string'
            && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(registration.value) ? registration.value as string : undefined;
          logError(error, { errorCode: readDesktopErrorCode(error, 'DESKTOP_IPC_REQUEST_FAILED'), requestId, channel, method, deviceId, updateRequestId, registrationRequestId });
          // Electron 丢失 Error 自定义字段；云关联显式返回失败数据，保留安全代码和请求关联。
          if (trusted && cloudLink) return { status: 500, body: { ok: false,
            code: readDesktopErrorCode(error, 'DESKTOP_CLOUD_ACCOUNT_FAILED'), requestId,
            message: describeUserFacingError({ code: readDesktopErrorCode(error, 'DESKTOP_CLOUD_ACCOUNT_FAILED') }, '桌面账号关联失败，请检查账号服务器地址和网络后重试。') } };
        } catch (diagnosticError) {
          throw new AggregateError([error, diagnosticError], 'DESKTOP_IPC_DIAGNOSTIC_FAILED', { cause: error });
        }
        throw error;
      }
    });
  }
  const unsubscribe = bindMainFrameEvents(window.webContents, webEntry, bridge.onEvent);
  const unsubscribeMigration = bridge.onMigrationState?.(state => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()
      && isTrustedDesktopUrl(window.webContents.mainFrame.url, webEntry)) window.webContents.send("desktop:migration-state", state);
  });
  const sendWindowState = (): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("desktop:window-state", { maximized: window.isMaximized() });
    }
  };
  window.on("maximize", sendWindowState);
  window.on("unmaximize", sendWindowState);
  return () => {
    unsubscribe();
    unsubscribeMigration?.();
    window.removeListener("maximize", sendWindowState);
    window.removeListener("unmaximize", sendWindowState);
    for (const channel of Object.keys(operations)) ipcMain.removeHandler(channel);
  };
}

/** 候选失败完成安全诊断后明确非零退出，诊断自身失败也保留固定失败事实。 */
async function exitCandidateFailure(request: CandidateShellHealthRequest | null, error: unknown, phase: "request" | "bootstrap", persist: boolean): Promise<void> {
  try { await reportCandidateShellHealthFailure(request, error, phase, persist); }
  catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(cause.code)
      ? cause.code : "UNKNOWN_ERROR";
    fs.writeSync(2, `${JSON.stringify({ errorCode: "DESKTOP_SHELL_HEALTH_DIAGNOSTIC_FAILED", requestId: request?.requestId ?? crypto.randomUUID(), rootCause: { code } })}\n`);
  } finally { app.exit(1); }
}

/** 普通重启保留真实 profile，移除已经结束的单次壳握手，避免重连失效执行器。 */
function relaunchDesktop(): void {
  app.relaunch({ args: process.argv.slice(1).filter(value => !value.startsWith("--codeflow-shell-ready=")) });
}

/** 更新候选仅以壳内置沙箱渲染成功确认就绪；普通启动不读取更新事务或业务数据。 */
async function confirmShellSwitchReady(argv: readonly string[]): Promise<void> {
  const requests = argv.filter(value => value.startsWith("--codeflow-shell-ready"));
  if (!requests.length) return;
  const requestId = requests[0]?.slice("--codeflow-shell-ready=".length);
  if (process.platform !== "win32" || requests.length !== 1 || requests[0] !== `--codeflow-shell-ready=${requestId}`
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId ?? "")) {
    throw new Error("DESKTOP_SHELL_READY_ARGUMENT_INVALID");
  }
  try {
    await app.whenReady();
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `codeflow-shell-ready-${requestId}` } });
    try {
      await window.loadURL("data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3ECodeFlow%20shell%3C%2Ftitle%3E");
      if (window.webContents.isDestroyed()) throw new Error("DESKTOP_SHELL_READY_WINDOW_INVALID");
      const fd = fs.openSync(`\\\\.\\pipe\\codeflow-shell-ready-${requestId}`, "r+");
      try {
        const ready = Buffer.from(`${requestId}:${process.pid}\r\n`, "ascii");
        if (fs.writeSync(fd, ready) !== ready.length) throw new Error("DESKTOP_SHELL_READY_WRITE_FAILED");
        const committed = Buffer.alloc(1);
        if (fs.readSync(fd, committed, 0, 1, null) !== 1 || committed[0] !== 1) throw new Error("DESKTOP_SHELL_READY_COMMIT_FAILED");
      } finally { fs.closeSync(fd); }
    } finally { window.destroy(); }
  } catch (cause) {
    throw Object.assign(new Error("DESKTOP_SHELL_READY_FAILED", { cause }), { code: "DESKTOP_SHELL_READY_FAILED", requestId });
  }
}

if (process.versions.electron) {
  // 候选壳只测自身窗口能力；独立临时profile，不读取账号、Client或业务库。
  if (process.argv.some(value => value.startsWith("--codeflow-shell-self-test"))) {
    void (async () => {
      if (process.argv.length !== 3 || process.argv[1] !== "--codeflow-shell-self-test") throw new Error("DESKTOP_SHELL_SELF_TEST_ARGUMENT_INVALID");
      const temporaryRoot = process.argv[2]!;
      if (!path.isAbsolute(temporaryRoot) || !path.basename(temporaryRoot).startsWith("cf-shell-selftest-")
        || fs.realpathSync.native(temporaryRoot) !== temporaryRoot || !fs.lstatSync(temporaryRoot).isDirectory()
        || fs.lstatSync(temporaryRoot).isSymbolicLink() || fs.readdirSync(temporaryRoot).length) throw new Error("DESKTOP_SHELL_SELF_TEST_PROFILE_INVALID");
      fs.mkdirSync(path.join(temporaryRoot, "user-data"));
      fs.mkdirSync(path.join(temporaryRoot, "session-data"));
      app.setPath("userData", path.join(temporaryRoot, "user-data"));
      app.setPath("sessionData", path.join(temporaryRoot, "session-data"));
      await app.whenReady();
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await window.loadURL("data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3ECodeFlow%20shell%3C%2Ftitle%3E");
        if (window.webContents.isDestroyed()) throw new Error("DESKTOP_SHELL_SELF_TEST_WINDOW_INVALID");
      } finally { window.destroy(); }
      app.exit(0);
    })().catch(error => {
      fs.writeSync(2, `${JSON.stringify({ code: "DESKTOP_SHELL_SELF_TEST_FAILED", rootCause: error instanceof Error ? error.message : "UNKNOWN" })}\n`);
      app.exit(1);
    });
  } else {
  let candidateRequest: CandidateShellHealthRequest | null = null;
  let candidateRequestFailed = false;
  try { candidateRequest = readCandidateShellHealthRequest(process.argv); }
  catch (error) {
    candidateRequestFailed = true;
    void exitCandidateFailure(null, error, "request", false);
  }
  if (!candidateRequestFailed && candidateRequest) {
    const request = candidateRequest;
    try {
      // 请求已严格校验；先隔离 profile，确保环境拒绝也不进入默认用户目录。
      app.setPath("userData", path.join(request.temporaryRoot, "user-data"));
      app.setPath("sessionData", path.join(request.temporaryRoot, "session-data"));
      assertCandidateShellHealthEnvironment(request);
      let executing = false;
      void app.whenReady().then(() => { executing = true; return executeCandidateShellHealth(request); }).then(() => app.exit(0), error => {
        void exitCandidateFailure(request, error, "bootstrap", !executing);
      });
    } catch (error) {
      void exitCandidateFailure(request, error, "bootstrap", true);
    }
  } else if (!candidateRequestFailed) {
  protocol.registerSchemesAsPrivileged([{ scheme: "codeflow", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
  // Electron 对 @scope/name 包名会生成混合分隔符路径，存储安全校验要求规范化路径。
  const userDataDir = path.resolve(app.getPath("userData"));
  const sessionDataDir = readShellSessionDataDirectory(process.argv) ?? path.resolve(app.getPath("sessionData"));
  app.setPath("userData", userDataDir);
  app.setPath("sessionData", sessionDataDir);
  let dataDir = path.join(userDataDir, "runtime");
  let currentLocation: DesktopStorageLocation | null = null;

  /** macOS 无安装器：由应用显式卸载并把自身移入废纸篓，默认工作区保留。 */
  async function uninstallMacOSApplication(): Promise<void> {
    if (process.platform !== "darwin" || !app.isPackaged || !currentLocation) return;
    const location = currentLocation;
    const confirmation = await dialog.showMessageBox({
      type: "warning", buttons: ["取消", "卸载"], defaultId: 0, cancelId: 0,
      title: "卸载 CodeFlow", message: "卸载 CodeFlow 并清理本地数据？",
      detail: `将删除 ${location.dataDir} 中 CodeFlow 生成的数据与缓存，默认工作区会保留；应用随后移入废纸篓。`,
    });
    if (confirmation.response !== 1) return;
    const helper = path.join(process.resourcesPath, "macosUninstallHelper.cjs");
    await fs.promises.access(helper);
    const logFile = path.join(app.getPath("logs"), "macos-uninstall.log");
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const logFd = fs.openSync(logFile, "a", 0o600);
    const requestId = crypto.randomUUID();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [helper, "--app-root", location.installRoot, "--data-dir", location.dataDir,
        "--user-data-dir", location.userDataDir, "--session-data-dir", sessionDataDir, "--log-file", logFile,
        "--request-id", requestId, "--wait-pid", String(process.pid)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: ["ignore", logFd, logFd] });
      // 等 spawn 成功再退出：失败会显式报错并保留应用，而不是丢给未处理 error 事件。
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      child.unref();
    } finally { fs.closeSync(logFd); }
    if (application) await application.exit(); else { quitAllowed = true; app.quit(); }
  }
  const webEntry = app.isPackaged ? DESKTOP_WEB_ENTRY : process.env.CODEFLOWAI_DESKTOP_WEB_ENTRY || "http://localhost:39281";
  let quitAllowed = false;
  let application: ReturnType<typeof createDesktopApplication> | undefined;
  let crashCapture: ReturnType<typeof createDesktopCrashCapture> | undefined;
  /** 预期退出前停用崩溃捕获，避免窗口和子进程销毁被误记。 */
  const exitApplication = (code: number): void => { crashCapture?.expectExit(); app.exit(code); };
  let recoveryOwner: ShellRecoveryControllerOwner | undefined;
  let maintenanceOwner: { released: boolean; closed: Promise<Error | undefined>; quitRequested?: boolean } | undefined;
  let maintenanceRecord: MaintenanceRecord | undefined;
  let lifecycleRunning = false;
  let maintenanceBrowserFlight: Promise<void> | undefined;
  let maintenanceBrowserTimeout: Error | undefined;
  let pendingOpen = false;
  const startupRequestId = crypto.randomUUID();
  let shellStartupContext: Pick<DesktopErrorContext, "shellAttemptRequestId" | "continuationId" | "shellId" | "revision" | "phase"> | undefined;
  const logError = (error: unknown, context?: DesktopErrorContext): void => recordDesktopError(dataDir, error, context);
  const showError = (error: unknown): void => showDesktopError(dataDir, "CodeFlow 操作失败", error);
  let quitDialogInFlight = false;
  let quitConfirmReady = false;
  let quitConfirmWindow: BrowserWindow | undefined;
  let pendingQuitConfirmation: ((confirmed: boolean) => void) | null = null;
  /** 页面未回传时按取消退出处理，避免退出确认永久挂起。 */
  const QUIT_CONFIRM_TIMEOUT_MS = 15_000;
  /** 有会话时优先由页面显示应用内确认；页面未就绪或窗口缺失时回退系统框。 */
  async function confirmQuitWithRunningTurns(): Promise<boolean> {
    const target = quitConfirmWindow;
    if (target && !target.isDestroyed() && !target.webContents.isDestroyed() && quitConfirmReady) {
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      const confirmed = await new Promise<boolean>(resolve => {
        const settle = (value: boolean): void => {
          clearTimeout(timer);
          if (pendingQuitConfirmation === settle) pendingQuitConfirmation = null;
          resolve(value);
        };
        const timer = setTimeout(() => {
          logError(Object.assign(new Error("DESKTOP_QUIT_CONFIRM_TIMEOUT"), { code: "DESKTOP_QUIT_CONFIRM_TIMEOUT" }),
            { errorCode: "DESKTOP_QUIT_CONFIRM_TIMEOUT", requestId: `quit:${process.pid}` });
          settle(false);
        }, QUIT_CONFIRM_TIMEOUT_MS);
        pendingQuitConfirmation = settle;
      });
      target.webContents.send("desktop:quit-confirm-requested");
      return confirmed;
    }
    const result = await dialog.showMessageBox({
      type: "warning", title: "退出 CodeFlow", message: "当前有会话在执行，退出将终止会话。",
      buttons: ["取消", "退出"], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  }
  /** 退出前确认运行中会话；无会话或无法确认时直接退出，失败保留应用并给出可定位原因。 */
  async function requestQuit(): Promise<void> {
    if (quitAllowed) { app.quit(); return; }
    if (quitDialogInFlight) return;
    quitDialogInFlight = true;
    try {
      if (!application) { quitAllowed = true; app.quit(); return; }
      const activity = await application.getActivity();
      if (!activity.available) {
        if (application.getRuntimeState().status === "ready") {
          // 已就绪但活动读取失败时无法排除会话，回退系统确认而不是静默终止。
          const result = await dialog.showMessageBox({
            type: "warning", title: "退出 CodeFlow", message: "无法确认是否有会话在执行，退出将终止本机运行环境。",
            buttons: ["取消", "退出"], defaultId: 0, cancelId: 0, noLink: true,
          });
          if (result.response !== 1) return;
        } else {
          // 环境未就绪时本机没有可终止的会话；直接退出并保留可检索原因。
          console.warn(JSON.stringify({ code: "DESKTOP_QUIT_ACTIVITY_UNAVAILABLE", requestId: `quit:${process.pid}` }));
        }
      } else if (activity.runningTurns.length > 0 && !await confirmQuitWithRunningTurns()) {
        return;
      }
      await application.exit();
    } catch (error) {
      showQuitError(error);
    } finally {
      quitDialogInFlight = false;
    }
  }
  /** 退出失败给出具体原因与日志位置，而不是通用运行环境错误。 */
  function showQuitError(error: unknown): void {
    const code = readDesktopErrorCode(error, "DESKTOP_EXIT_FAILED");
    try { recordDesktopError(dataDir, error, { errorCode: code, requestId: `quit:${process.pid}` }); }
    catch (logError) { console.error("[DESKTOP_QUIT_ERROR_LOG_FAILED]", logError); }
    const message = code === "DESKTOP_OPERATION_IN_PROGRESS"
      ? "CodeFlow 正在启动或更新，暂时无法退出。请等待完成后再从托盘退出。"
      : code.startsWith("CLIENT_") || code === "CLIENT_DRAIN_TIMEOUT"
        ? "停止本机会话超时，CodeFlow 未退出。请重试；若仍失败，可从任务管理器结束 CodeFlow。"
        : describeUserFacingError(error, "退出失败，请稍后重试。");
    dialog.showErrorBox("退出 CodeFlow 失败", `${message}\n错误码：${code}\n日志：${path.join(dataDir, "logs", "desktop-errors.jsonl")}`);
  }
  /** 系统通知失败只记录，不改变启动或更新结果；平台不支持通知时跳过。 */
  function notifyDesktopUpdate(title: string, body: string, dataDir: string): void {
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch (error) {
      try {
        recordDesktopError(dataDir, error, { errorCode: readDesktopErrorCode(error, "DESKTOP_UPDATE_NOTIFICATION_FAILED"),
          requestId: `update-notification:${Date.now()}` });
      } catch (logError) { console.error("[DESKTOP_UPDATE_NOTIFICATION_LOG_FAILED]", logError); }
    }
  }
  let lifecycleRequest: ReturnType<typeof readDesktopLifecycleRequest> = null, maintenanceRequestError: unknown;
  try { lifecycleRequest = readDesktopLifecycleRequest(process.argv, app.isPackaged, process.platform); }
  catch (cause) { maintenanceRequestError = cause; }
  const maintenanceRequest = lifecycleRequest?.kind === "maintenance" ? lifecycleRequest : null;
  let maintenanceStage = maintenanceRequest ? "startup" : undefined;
  if (maintenanceRequestError) {
    showDesktopError(userDataDir, "CodeFlow 维护失败", maintenanceRequestError,
      { startupDiagnostic: true, requestId: startupRequestId, errorCode: readDesktopErrorCode(maintenanceRequestError) });
    app.exit(1);
  } else if (!app.requestSingleInstanceLock()) {
    if (lifecycleRequest) {
      const code = maintenanceRequest ? "DESKTOP_UNINSTALL_APP_RUNNING" : "DESKTOP_INSTALL_APP_RUNNING";
      const error = Object.assign(new Error(code), { code });
      showDesktopError(userDataDir, "请先从托盘退出 CodeFlow", error,
        { startupDiagnostic: true, requestId: startupRequestId, maintenanceRequestId: maintenanceRequest?.requestId, mode: maintenanceRequest?.mode, errorCode: error.code });
      app.exit(1);
    } else {
      quitAllowed = true;
      app.quit();
    }
  } else {
    app.on("second-instance", (_event, argv) => {
      // 维护请求由新进程明确拒绝；既有业务实例不因卸载请求唤醒窗口。
      if (argv.some((argument: string) => argument.startsWith("--codeflow-uninstall-maintenance")
        || argument.startsWith('--codeflow-check-installation') || argument.startsWith("--codeflow-register-installation") || argument === "--delete-app-data")) return;
      if (application) application.openWindow(); else pendingOpen = true;
    });
    // Windows 通知按 AUMID 关联开始菜单快捷方式；必须在 ready 前固定。
    if (process.platform === "win32") app.setAppUserModelId("ai.codeflow.codeflowai");
    void app.whenReady().then(async () => {
      await confirmShellSwitchReady(process.argv);
      // 无边框窗口不需要原生菜单栏；macOS 保留最小系统菜单以维持 Cmd+Q/复制粘贴。
      if (process.platform === "darwin") {
        // 不挂载默认菜单：默认菜单会向用户暴露 Reload 与 DevTools。
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
      } else Menu.setApplicationMenu(null);
      // 这里只推导稳定安装根；版本布局准入仍由原 owner 在 handoff 后验证。
      const executableDirectory = path.dirname(process.execPath);
      // macOS 以 .app 包根为安装根；Windows shell 布局保持原推导。
      const installRoot = process.platform === "darwin" && path.basename(path.dirname(executableDirectory)) === "Contents"
        ? path.dirname(path.dirname(executableDirectory))
        : path.basename(path.dirname(executableDirectory)).toLowerCase() === "shells"
          ? path.dirname(path.dirname(executableDirectory)) : executableDirectory;
      const installationMarker = app.isPackaged && process.platform === "win32" && !lifecycleRequest
        ? readCompletedInstallation(installRoot) : null;
      if (lifecycleRequest) lifecycleRunning = true;
      if (lifecycleRequest?.kind === 'check') {
        // 兼容旧安装器预检；旧任务在新文件复制后的安装登记阶段接管。
        const location = await resolveDesktopStorageLocation({ userDataDir, installRoot });
        await assertNoDesktopClientProcess(location.dataDir, installRoot);
        lifecycleRunning = false; quitAllowed = true; app.exit(0); return;
      }
      if (lifecycleRequest?.kind === "installation") {
        // 安装登记不触发会生成认证材料的D13读取；安装根变化仅由保留重装授权处理。
        await resolveVersionedShellStartup(process.execPath);
        let registered = await registerDesktopInstallation({ userDataDir, installRoot, beforePersist: async location => {
          await assertNoDesktopClientProcess(location.dataDir, installRoot);
          if (location.clientId === null) await assertDesktopMaintenanceStartup({ userDataDir, location });
          else if (path.relative(location.installRoot, installRoot) === "") await rebindDesktopKeepInstallation({ userDataDir, location, installRoot });
        } });
        if (path.relative(registered.installRoot, installRoot) !== "") registered = await rebindDesktopKeepInstallation({ userDataDir, location: registered, installRoot });
        const repair = await supersedeDesktopInstallationAttempt({ userDataDir, installationDir: installRoot, requestId: lifecycleRequest.requestId });
        if (repair.outcome === "superseded") appendDesktopStartupDiagnostic(userDataDir, `${JSON.stringify({ at: new Date().toISOString(),
          errorCode: "DESKTOP_INSTALL_ATTEMPT_SUPERSEDED", requestId: lifecycleRequest.requestId, archive: repair.archive, sha256: repair.sha256 })}\n`);
        dataDir = registered.dataDir;
        lifecycleRunning = false; quitAllowed = true; app.exit(0); return;
      }
      // 授权删除的重入先于常规定位；已合法删除的DB或locator不能被重建。
      const maintenanceStartup = maintenanceRequest
        ? await readDesktopMaintenanceStartup({ userDataDir, installRoot, requestId: maintenanceRequest.requestId, mode: maintenanceRequest.mode,
          resumePending: maintenanceRequest.resumePending }) : null;
      if (maintenanceStartup && maintenanceRequest) {
        maintenanceRequest.requestId = maintenanceStartup.record.requestId;
        if (maintenanceStartup.kind !== "pending") maintenanceRecord = maintenanceStartup.record;
      }
      if (maintenanceStartup?.kind === "completed") {
        // 历史终态不恢复删除权；仍须证明没有同安装程序阻碍安装器移除文件。
        await assertNoDesktopClientProcess(maintenanceStartup.record.dataDir, installRoot);
        lifecycleRunning = false; quitAllowed = true; app.exit(0); return;
      }
      if (maintenanceRequest) maintenanceStage = "storage";
      let location = maintenanceStartup?.kind === "authorized" ? maintenanceStartup.location
        : await resolveDesktopStorageLocation({ userDataDir, installRoot,
          configuredDataDir: maintenanceRequest ? undefined : process.env.CODEFLOWAI_DESKTOP_DATA_DIR,
          allowInstallRootChange: process.platform === "darwin" || installationMarker !== null });
      // 移动或转译后的 .app 先写回定位安装根，后续归属校验仍按当前根进行。
      if (process.platform === "darwin" || installationMarker) await rebindDesktopInstallRoot(location);
      currentLocation = location;
      dataDir = location.dataDir;
      if (maintenanceStartup?.kind === "authorized") {
        await assertNoDesktopClientProcess(dataDir, installRoot);
        // 空认证目录的授权补完必须在本进程首次D13读取前，后续仍由原D13判准入。
        maintenanceRecord = await beginDesktopMaintenance({ userDataDir, location, requestId: maintenanceRequest!.requestId, mode: maintenanceRequest!.mode });
      }
      if (location.clientId === null) {
        // 双空身份先核唯一记录；从未运行维护由Record证明确空后跳过有写入的D13 reader。
        if (maintenanceRequest && !maintenanceRecord) {
          await assertNoDesktopClientProcess(dataDir, installRoot);
          maintenanceRecord = await beginDesktopMaintenance({ userDataDir, location, requestId: maintenanceRequest.requestId, mode: maintenanceRequest.mode });
        } else if (!maintenanceRequest) await assertDesktopMaintenanceStartup({ userDataDir, location });
      }
      if (quitAllowed) return;
      if (installationMarker) {
        await assertNoDesktopClientProcess(location.dataDir, installRoot);
        await supersedeDesktopInstallationAttempt({ userDataDir, installationDir: installRoot, requestId: installationMarker.requestId });
        const current = fs.lstatSync(installationMarker.file, { bigint: true });
        if (current.dev !== installationMarker.stat.dev || current.ino !== installationMarker.stat.ino
          || current.mtimeNs !== installationMarker.stat.mtimeNs || current.size !== installationMarker.stat.size) {
          throw new Error("DESKTOP_INSTALL_MARKER_CHANGED");
        }
        fs.unlinkSync(installationMarker.file);
      }
      // macOS 不使用 Windows 壳交接；其他入口仍先核对唯一 attempt。
      const handoffInput = { executablePath: process.execPath, pid: process.pid, parentPid: process.ppid, dataDir,
        userDataDir, sessionDataDir, argv: process.argv, channel: process };
      if (maintenanceRequest) maintenanceStage = "handoff";
      const nativeShellStartup = app.isPackaged && process.platform === "win32" && !maintenanceRequest
        && !process.argv.includes("--codeflow-shell-handoff")
        && fs.existsSync(path.join(executableDirectory, "resources", "shell-switch.exe"));
      let handoffStartup = process.platform === "darwin" || nativeShellStartup || maintenanceRequest && location.clientId === null
        ? { kind: "ordinary" as const } : await readShellHandoffStartup(handoffInput);
      if (maintenanceRequest && handoffStartup.kind !== "ordinary") throw new DesktopMaintenanceStartupError("DESKTOP_UNINSTALL_HANDOFF_PENDING");
      if (handoffStartup.kind === "held-candidate") {
        // 仅记录已核交接的诊断关联，不替换本次启动请求或重读推进中的attempt。
        const attempt = handoffStartup.attempt, safe = snapshotShellHandoffErrorContext(attempt);
        const target = snapshotShellHandoffErrorContext(Object.getOwnPropertyDescriptor(attempt, "target")?.value);
        const continuationId = Object.getOwnPropertyDescriptor(attempt, "continuationId")?.value;
        shellStartupContext = { shellAttemptRequestId: safe.requestId,
          continuationId: typeof continuationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(continuationId) ? continuationId : undefined,
          shellId: target.shellId, revision: safe.revision, phase: safe.phase };
      }
      if (handoffStartup.kind === "recovery-control") {
        // controller 不创建 application/Client；同 attempt 接管确认后沿正常退出释放单实例锁/profile。
        try {
          recoveryOwner = await startShellRecoveryController({ ...handoffInput, onOwned: owner => { recoveryOwner = owner; } });
          recoveryOwner.assertHealthy(); quitAllowed = true; app.quit(); return;
        } catch (error) {
          // 恢复连续失败时不再永久阻塞启动；安全条件不满足或归档失败仍按原错误退出。
          let abandon;
          try {
            abandon = await abandonStalledShellUpdateRecovery({ ...handoffInput,
              parentPid: process.ppid, ownerReleased: !recoveryOwner || recoveryOwner.released });
          } catch (abandonError) {
            throw new AggregateError([error, abandonError], "DESKTOP_SHELL_RECOVERY_ABANDON_FAILED");
          }
          if (!abandon?.abandoned) throw error;
          recoveryOwner = undefined;
          handoffStartup = { kind: "ordinary" };
          logError(Object.assign(new Error("DESKTOP_SHELL_RECOVERY_ABANDONED", { cause: error }), { code: "DESKTOP_SHELL_RECOVERY_ABANDONED" }),
            { errorCode: "DESKTOP_SHELL_RECOVERY_ABANDONED", requestId: abandon.requestId ?? startupRequestId });
        }
      }
      const startup = app.isPackaged && process.platform === "win32" ? await resolveVersionedShellStartup(process.execPath) : null;
      if (quitAllowed) return;
      // 仅未打包 dev 可指定已签名基线资源目录，供升级应用测试；打包态始终使用安装资源。
      const devReleaseResourcesDir = !app.isPackaged ? process.env.CODEFLOWAI_DESKTOP_INITIAL_RELEASE_DIR?.trim() : undefined;
      const releaseResourcesDir = app.isPackaged ? process.resourcesPath : devReleaseResourcesDir || path.resolve(currentDirectory, "..");
      const initialReleaseDir = startup?.initialReleaseDir ?? (app.isPackaged ? process.resourcesPath : path.resolve(currentDirectory, ".."));
      if (maintenanceRequest) {
        let record = maintenanceRecord;
        try {
          maintenanceStage = "prepare";
          if (!record) {
            await assertNoDesktopClientProcess(dataDir, installRoot);
            record = await beginDesktopMaintenance({ userDataDir, location, requestId: maintenanceRequest.requestId, mode: maintenanceRequest.mode });
            maintenanceRecord = record;
          }
          // 历史keep授权可能早于归档清理；只补清迁移数据，保持已封存的业务库字节。
          const migrationOnly = record.mode === "keep" && record.phase !== "started" && ["legacy-client-migration-journal.json", "legacy-client-migration"]
            .some(name => fs.lstatSync(path.join(dataDir, name), { throwIfNoEntry: false }));
          if (record.clientId !== null && record.oldDeviceId !== null && (record.phase === "started" || migrationOnly)) {
            maintenanceStage = "release";
            const trust = readInstalledReleaseTrust(app.isPackaged ? process.resourcesPath : path.resolve(currentDirectory, ".."));
            const active = await resolveActiveRelease(dataDir, { trustedReleaseKeys: trust });
            const release = active ?? await resolveBaselineRelease(initialReleaseDir, { trustedReleaseKeys: trust });
            maintenanceStage = "worker";
            const worker = startDesktopMaintenanceWorker(path.join(release.releaseDir, "client", "dist", "desktopUninstallWorker.cjs"), dataDir,
              { schemaVersion: 1, ...(migrationOnly ? { action: "migration_credentials" as const } : {}),
                requestId: record.requestId, dataDir, clientId: record.clientId, deviceId: record.oldDeviceId });
            maintenanceOwner = worker;
            await worker.done;
          }
          if (record.phase === "started") {
            maintenanceStage = "browser";
            cancelLegacyMigrationAccountForUninstall(dataDir);
            const browserFlight = Promise.resolve().then(async () => {
              await session.defaultSession.clearData();
              if (maintenanceBrowserTimeout) throw maintenanceBrowserTimeout;
              // 清理应用自定义 origin 的 DOM 存储；沿同一 flight 栅栏阻止授权继续。
              const desktopEntry = new URL(DESKTOP_WEB_ENTRY);
              await session.defaultSession.clearStorageData({ origin: `${desktopEntry.protocol}//${desktopEntry.host}` });
              if (maintenanceBrowserTimeout) throw maintenanceBrowserTimeout;
              await session.defaultSession.clearAuthCache();
            });
            maintenanceBrowserFlight = browserFlight;
            try { await awaitMaintenance(browserFlight, error => { maintenanceBrowserTimeout = error; }); }
            finally { if (!maintenanceBrowserTimeout) maintenanceBrowserFlight = undefined; }
            maintenanceStage = "authorize";
            record = await authorizeDesktopMaintenance({ userDataDir, location }, record);
            maintenanceRecord = record;
          } else if (record.mode === "keep") {
            maintenanceStage = "migration_account";
            cancelLegacyMigrationAccountForUninstall(dataDir);
          }
          maintenanceStage = "complete";
          await completeDesktopMaintenance({ userDataDir, location }, record);
          lifecycleRunning = false; quitAllowed = true; app.exit(0); return;
        } catch (cause) {
          if (!maintenanceBrowserFlight) lifecycleRunning = false;
          if (cause instanceof DesktopMaintenanceStartupError) throw cause;
          // 资源校验的摘要错误和系统errno统一给修复指引，原始原因保留在cause。
          const releaseFailure = maintenanceStage === "release";
          const code = readDesktopErrorCode(cause, releaseFailure ? "DESKTOP_UNINSTALL_RELEASE_INVALID" : "DESKTOP_UNINSTALL_MAINTENANCE_FAILED");
          throw new DesktopMaintenanceStartupError(releaseFailure && !code.startsWith("DESKTOP_") ? "DESKTOP_UNINSTALL_RELEASE_INVALID" : code, {
            maintenanceRequestId: maintenanceRequest.requestId, clientId: record ? record.clientId : location.clientId,
            oldDeviceId: record ? record.oldDeviceId : location.deviceId, mode: maintenanceRequest.mode, maintenancePhase: record?.phase ?? "started",
          }, cause);
        }
      }
      const reinstall = handoffStartup.kind === "ordinary" ? await prepareDesktopReinstall({ userDataDir, location }) : null;
      if (quitAllowed) return;
      if (reinstall) {
        try {
        cancelLegacyMigrationAccountForUninstall(dataDir);
        const trust = readInstalledReleaseTrust(releaseResourcesDir);
        const active = await resolveActiveRelease(dataDir, { trustedReleaseKeys: trust });
        const release = active ?? await resolveBaselineRelease(initialReleaseDir, { trustedReleaseKeys: trust });
        if (quitAllowed) return;
        await loadOrCreateDeviceIdentity(dataDir, { deviceId: reinstall.authorization.nextDeviceId, createdAt: reinstall.authorization.createdAt });
        if (quitAllowed) return;
        const worker = startDesktopMaintenanceWorker(path.join(release.releaseDir, "client", "dist", "desktopUninstallWorker.cjs"), dataDir,
          { schemaVersion: 1, action: "reinstall_local_tasks", requestId: reinstall.record.requestId, dataDir,
            clientId: reinstall.authorization.clientId, oldDeviceId: reinstall.authorization.oldDeviceId, nextDeviceId: reinstall.authorization.nextDeviceId });
        maintenanceOwner = worker;
        await worker.done;
        if (maintenanceOwner.quitRequested) { quitAllowed = true; app.quit(); return; }
        if (quitAllowed) return;
        location = await completeDesktopReinstallLocation(location, reinstall.authorization);
        await finishDesktopReinstall({ userDataDir, location }, reinstall);
        } catch (cause) {
          if (cause instanceof DesktopMaintenanceStartupError) throw cause;
          throw new DesktopMaintenanceStartupError(readDesktopErrorCode(cause, "DESKTOP_MAINTENANCE_REINSTALL_FAILED"), {
            maintenanceRequestId: reinstall.record.requestId, clientId: reinstall.authorization.clientId,
            oldDeviceId: reinstall.authorization.oldDeviceId, nextDeviceId: reinstall.authorization.nextDeviceId, mode: "keep", maintenancePhase: "reinstalling",
          }, cause);
        }
      }
      await assertDesktopMaintenanceStartup({ userDataDir, location });
      if (quitAllowed) return;
      if (handoffStartup.kind === "held-candidate") {
        if (location.clientId === null || location.deviceId === null) throw Object.assign(new Error("DESKTOP_STORAGE_HANDOFF_LOCATION_REQUIRED"), { code: "DESKTOP_STORAGE_HANDOFF_LOCATION_REQUIRED" });
        await verifyDesktopStorageLocation(location, process.env.CODEFLOWAI_CLIENT_ID);
      } else {
        if (location.clientId !== null) await verifyDesktopStorageLocation(location, process.env.CODEFLOWAI_CLIENT_ID);
        if (quitAllowed) return;
        await persistDesktopStorageLocation(location);
      }
      if (quitAllowed) return;
      const configuredServerOrigin = readInstalledUpdateOrigin(releaseResourcesDir, process.env.CODEFLOWAI_DESKTOP_SERVER_ORIGIN);
      const unsignedLocal = readUnsignedLocalMarker();
      if (unsignedLocal) console.warn(JSON.stringify({ code: "DESKTOP_UNSIGNED_LOCAL_BASELINE_SKIPPED", requestId: startupRequestId }));
      const shellVersion = readRunningShellVersion();
      const shellFacts = await readShellUpdateHostFacts({ packaged: app.isPackaged, platform: process.platform, configuredServerOrigin,
        executablePath: process.execPath, pid: process.pid, parentPid: process.ppid, userDataDir, sessionDataDir });
      // 存储位置确定后建立会话标记并安装崩溃钩子；补报只在本次启动完成后进行。
      const capture = createDesktopCrashCapture({
        dataDir, app, shellVersion,
        recordError: (error, context) => recordDesktopError(dataDir, error, { errorCode: context.errorCode, requestId: context.requestId }),
      });
      capture.initialize();
      crashCapture = capture;
      let webDir = path.join(initialReleaseDir, "web");
      let normalWindow: BrowserWindow | undefined, loadedFrame = false;
      let pendingUpdateCheck = false;
      /** 下载进度推送节流时间戳；进度事件高频，避免每条数据块都做窗口与来源校验。 */
      let lastUpdateProgressAt = 0;
      /** 托盘只唤醒窗口并通知渲染器；检查由 Web 弹框发起并展示结果。 */
      const requestRendererUpdateCheck = (): void => {
        pendingUpdateCheck = true;
        const window = normalWindow;
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
        const send = (): void => {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("desktop:update-check-requested");
        };
        if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
        else send();
      };
      let pendingFeedbackRequest = false;
      /** 托盘反馈请求与检查更新共用 pending + take，避免窗口未订阅时丢失。 */
      const requestRendererFeedback = (): void => {
        pendingFeedbackRequest = true;
        const window = normalWindow;
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
        const send = (): void => {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("desktop:feedback-requested");
        };
        if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
        else send();
      };
      const handoff = handoffStartup.kind === "held-candidate" ? createShellHandoffContinuation({ startup: handoffStartup,
        getMainFrame: () => ({ loaded: loadedFrame, trusted: !!normalWindow && !normalWindow.isDestroyed()
          && normalWindow.webContents.mainFrame.url === normalWindow.webContents.getURL() && isTrustedDesktopUrl(normalWindow.webContents.mainFrame.url, webEntry) }) }) : undefined;
      application = createDesktopApplication({
        dataDir, initialReleaseDir, shellVersion, requireBaseline: app.isPackaged && !unsignedLocal,
        ...(!app.isPackaged && devReleaseResourcesDir ? { baselineReleaseDir: devReleaseResourcesDir } : {}),
        cliRuntime: releaseDir => resolveClientCliRuntime({ releaseDir, dataDir, required: app.isPackaged }),
        startupContinuation: handoff?.continuation,
        createMigration: ({ releaseDir, identity }) => {
          const workerEntry = resolveLegacyClientMigrationWorker(releaseDir, dataDir);
          return workerEntry ? createLegacyClientMigration({ dataDir, identity, workerEntry }) : undefined;
        },
        configuredServerOrigin,
        crashJournal: capture.journal,
        onRuntimeFacts: facts => capture.updateRuntimeFacts(facts),
        onClientExit: facts => capture.reportClientExit(facts),
        onShutdown: () => capture.expectExit(),
        shellUpdate: shellFacts ? { facts: shellFacts } : undefined,
        trustedReleaseKeys: readInstalledReleaseTrust(releaseResourcesDir),
        host: {
          createWindow: () => { normalWindow = createDefaultWindow(webEntry, showError); return normalWindow; },
          /** 内置启动页与已验证的 Web 复用同一沙箱窗口。 */
          loadStartup: window => loadStartupWeb(window as BrowserWindow),
          /** 启动页进度失败只记录，不阻断启动或更新。 */
          updateStartupStatus: (window, status) => updateStartupWeb(window as BrowserWindow, status).catch(error => {
            logError(error, { errorCode: readDesktopErrorCode(error, "DESKTOP_STARTUP_STATUS_FAILED"), requestId: "startup-status" });
          }),
          onMigrationError: error => showDesktopError(dataDir, "CodeFlow 退出失败", error,
            { errorCode: readDesktopErrorCode(error, "DESKTOP_EXIT_FAILED"), requestId: startupRequestId }),
          /** 先导航展示页面，已有本地启动任务与页面资源使用各自的等待预算。 */
          loadWeb: async (window, releaseDir, options) => {
            loadedFrame = false;
            webDir = path.join(releaseDir, "web");
            await loadWeb(window as BrowserWindow, resolveDesktopInitialEntry(webEntry), { requireReady: true, ...options });
            loadedFrame = true;
          },
          createTray: (open, _exit, checkForUpdates) => createTray(open, () => requestQuit(), showQuitError, checkForUpdates
            ? () => { open(); requestRendererUpdateCheck(); }
            : undefined, () => { open(); requestRendererFeedback(); },
            process.platform === "darwin" && app.isPackaged ? () => { void uninstallMacOSApplication().catch(showError); } : undefined),
          /** 保留原状态读取，只有运行时ready后才固化安装身份与定位。 */
          registerBridge: (bridge, window) => {
            const target = window as BrowserWindow;
            quitConfirmWindow = target;
            /** 主 frame 导航、渲染进程退出或销毁时撤销旧确认能力，避免等待已不存在的页面。 */
            const resetQuitConfirmation = (): void => {
              quitConfirmReady = false;
              const resolve = pendingQuitConfirmation;
              pendingQuitConfirmation = null;
              resolve?.(false);
            };
            target.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
              if (isMainFrame) resetQuitConfirmation();
            });
            target.webContents.on("render-process-gone", resetQuitConfirmation);
            target.webContents.on("unresponsive", resetQuitConfirmation);
            target.webContents.on("destroyed", resetQuitConfirmation);
            return registerIpcHandlers(bridge, target, webEntry, logError, () => {
              const pending = pendingUpdateCheck;
              pendingUpdateCheck = false;
              return pending;
            }, () => {
              const pending = pendingFeedbackRequest;
              pendingFeedbackRequest = false;
              return pending;
            }, {
              markReady: ready => {
                if (ready) quitConfirmReady = true;
                else resetQuitConfirmation();
              },
              respond: confirmed => {
                const resolve = pendingQuitConfirmation;
                pendingQuitConfirmation = null;
                resolve?.(confirmed);
              },
            });
          },
          /** 确认即中断当前会话及其终端、托管服务；稍后继续当前工作。 */
          confirmUpdate: async (window, signal) => {
            signal?.throwIfAborted();
            const result = await dialog.showMessageBox(window as BrowserWindow, {
              type: "question", title: "CodeFlow 更新", message: "有正在运行的会话，是否立即更新？",
              detail: "立即更新将中断当前会话并停止终端和托管服务。",
              buttons: ["立即更新", "稍后"], defaultId: 1, cancelId: 1, noLink: true, signal,
            });
            return result.response === 0;
          },
          /** 恢复前只记录首错；最终失败仍弹框，写入失败继续交回调用方。 */
          onUpdateError: (error, context) => {
            const details = { ...context, errorCode: readDesktopErrorCode(error) };
            if (context.logOnly) {
              recordDesktopError(dataDir, error, details);
              if (error instanceof Error) preloggedDesktopErrors.add(error);
              return;
            }
            showDesktopError(dataDir, "CodeFlow 更新失败", error, details);
            // 窗口隐藏或已关闭时补系统通知，避免用户错过失败。
            if (!normalWindow || normalWindow.isDestroyed() || !normalWindow.isVisible()) {
              notifyDesktopUpdate("CodeFlow 更新失败", "更新未完成，请打开应用查看诊断。", dataDir);
            }
          },
          onUpdateRetry: (context) => recordDesktopError(dataDir, context.error,
            { ...context, errorCode: "DESKTOP_UPDATE_RETRY_SCHEDULED" }),
          /** 下载完成提醒：先唤起窗口再推送；页面晚挂载时由 getUpdateNotice 补查。 */
          onUpdateNotice: notice => {
            // 窗口可见时由页面内提醒承接，避免系统通知与弹窗重复。
            if (!normalWindow || normalWindow.isDestroyed() || !normalWindow.isVisible()) {
              notifyDesktopUpdate("发现新版本", notice.shellOnly
                ? `版本 ${notice.version} 已下载，请手动安装。`
                : `版本 ${notice.version} 已下载完成，重启应用后生效。`, dataDir);
            }
            try { application?.openWindow(); }
            catch (error) { logError(error, { errorCode: readDesktopErrorCode(error, "DESKTOP_UPDATE_NOTICE_OPEN_FAILED"), requestId: "update-notice:open" }); }
            const window = normalWindow;
            if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
            const send = (): void => {
              if (!window.isDestroyed() && !window.webContents.isDestroyed()
                && isTrustedDesktopUrl(window.webContents.mainFrame.url, webEntry)) window.webContents.send("desktop:update-notice", notice);
            };
            if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
            else send();
          },
          onUpdateApplied: ({ version }) => notifyDesktopUpdate("CodeFlow 已更新", `已更新到 ${version}，当前版本已就绪。`, dataDir),
          /** 下载进度：与提醒同一可信窗口边界；高频进度按 100ms 节流后推送。 */
          onUpdateProgress: progress => {
            const window = normalWindow;
            if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
            const now = Date.now();
            if (progress && now - lastUpdateProgressAt < 100) return;
            lastUpdateProgressAt = now;
            if (!isTrustedDesktopUrl(window.webContents.mainFrame.url, webEntry)) return;
            window.webContents.send("desktop:update-progress", progress);
          },
          /** 用户确认重启后先登记重启意图，退出仍由原 owner 完成清理。 */
          relaunch: relaunchDesktop,
          quit: () => { quitAllowed = true; app.quit(); },
        },
      });
      protocol.handle("codeflow", createDesktopWebHandler({
        getWebDir: () => webDir, onError: logError,
      }));
      try {
        await application.start();
        try {
          if (application.getRuntimeState().status !== "ready") {
            throw Object.assign(new Error("DESKTOP_STORAGE_RUNTIME_NOT_READY"), { code: "DESKTOP_STORAGE_RUNTIME_NOT_READY" });
          }
          if (handoffStartup.kind === "held-candidate") await verifyDesktopStorageLocation(location, process.env.CODEFLOWAI_CLIENT_ID);
          else await completeDesktopStorageLocation(location, process.env.CODEFLOWAI_CLIENT_ID);
          await handoff?.started();
        }
        catch (cause) {
          try { await application.exit(); }
          catch (cleanup) { throw new DesktopStartupCleanupError(cause, cleanup); }
          throw cause;
        }
      }
      catch (cause) {
        handoff?.dispose();
        // 启动页或迁移页主动退出由 application.exit 清理，真实错误仍向上传递。
        if (["MIGRATION_STOPPED", "DESKTOP_STARTUP_STOPPED"].includes(String((cause as { code?: unknown } | null)?.code))) return;
        throw cause;
      }
      if (await application.resumeStartupUpdate()) return;
      if (pendingOpen) { pendingOpen = false; application.openWindow(); }
      if (application.updateFailureFailure) {
        const failure = application.updateFailureFailure;
        showDesktopError(dataDir, "CodeFlow 更新错误补报失败", new Error(failure.errorCode), failure);
      }
      if (application.crashDeliveryFailure) {
        const failure = application.crashDeliveryFailure;
        recordDesktopError(dataDir, Object.assign(new Error(failure.errorCode), { code: failure.errorCode }),
          { errorCode: failure.errorCode, requestId: failure.requestId, deviceId: failure.deviceId });
      }
      application.startAutomaticUpdates();
    }).catch((error) => {
      const maintenance = error instanceof DesktopMaintenanceStartupError ? {
        maintenanceRequestId: error.maintenanceRequestId ?? maintenanceRequest?.requestId, clientId: error.clientId ?? maintenanceRecord?.clientId,
        oldDeviceId: error.oldDeviceId ?? maintenanceRecord?.oldDeviceId, nextDeviceId: error.nextDeviceId ?? maintenanceRecord?.nextDeviceId,
        mode: error.mode ?? maintenanceRequest?.mode, maintenancePhase: error.maintenancePhase ?? maintenanceRecord?.phase,
      } : maintenanceRequest ? { maintenanceRequestId: maintenanceRequest.requestId, mode: maintenanceRequest.mode,
        clientId: maintenanceRecord?.clientId, oldDeviceId: maintenanceRecord?.oldDeviceId,
        nextDeviceId: maintenanceRecord?.nextDeviceId, maintenancePhase: maintenanceRecord?.phase } : undefined;
      const errorContext: DesktopErrorContext = { ...shellStartupContext, ...maintenance, startupDiagnostic: true, maintenanceStage,
        errorCode: readDesktopErrorCode(error, "DESKTOP_STARTUP_FAILED"), requestId: typeof error?.requestId === "string"
          && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(error.requestId) ? error.requestId : startupRequestId };
      showDesktopError(userDataDir, maintenanceRequest ? "CodeFlow 卸载失败" : "CodeFlow 启动失败", error, errorContext);
      if (app.isPackaged && process.platform === "win32" && !lifecycleRequest && !(error instanceof DesktopStartupCleanupError)
        && (!recoveryOwner || recoveryOwner.released) && (!maintenanceOwner || maintenanceOwner.released)) {
        // 业务/历史状态故障保留内置恢复入口；不创建Client，不依赖Web资源或远端服务。
        const recovery = new BrowserWindow({ width: 640, height: 420, show: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        const code = errorContext.errorCode ?? "DESKTOP_STARTUP_FAILED";
        recovery.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        recovery.webContents.on("will-navigate", (event, url) => {
          event.preventDefault();
          if (url === "codeflow-recovery://retry") { quitAllowed = true; relaunchDesktop(); app.exit(0); }
          else if (url === "codeflow-recovery://close") { quitAllowed = true; app.exit(1); }
        });
        recovery.on("closed", () => { quitAllowed = true; app.exit(1); });
        const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:16px system-ui;padding:36px;line-height:1.8}a{display:inline-block;margin:16px 20px 0 0}</style><h2>CodeFlow 暂时无法加载工作台</h2><p>壳仍可运行，当前业务资源或本机数据需要修复。可以重新启动，或使用完整安装包修复程序；卸载程序会保留本机数据。</p><p>错误编号：${code}</p><a href="codeflow-recovery://retry">重新启动</a><a href="codeflow-recovery://close">关闭</a>`;
        void recovery.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(pageError => {
          showDesktopError(userDataDir, "CodeFlow 恢复页加载失败", new AggregateError([error, pageError], "DESKTOP_RECOVERY_PAGE_FAILED"), errorContext);
          quitAllowed = true; app.exit(1);
        });
        return;
      }
      if (!(error instanceof DesktopStartupCleanupError) && (!recoveryOwner || recoveryOwner.released)) {
        // 超时只结束启动等待；维护资源真正关闭后才释放主进程和单实例锁。
        if (maintenanceBrowserFlight) {
          const flight = maintenanceBrowserFlight;
          // 超时后晚到的根因补记同一请求；仅实际结算后退出，后续维护步骤始终中止。
          void flight.then(() => { if (maintenanceBrowserFlight === flight) { maintenanceBrowserFlight = undefined; lifecycleRunning = false; exitApplication(1); } },
            cause => {
              if (cause !== maintenanceBrowserTimeout) showDesktopError(userDataDir, "CodeFlow 维护清理失败",
                new AggregateError([error, cause], "DESKTOP_UNINSTALL_BROWSER_CLEANUP_SETTLEMENT_FAILED"),
                { ...errorContext, errorCode: "DESKTOP_UNINSTALL_BROWSER_CLEANUP_SETTLEMENT_FAILED" });
              if (maintenanceBrowserFlight === flight) { maintenanceBrowserFlight = undefined; lifecycleRunning = false; exitApplication(1); }
            });
        } else if (maintenanceOwner) void maintenanceOwner.closed.then(lateFailure => {
          if (lateFailure) showDesktopError(userDataDir, "CodeFlow 维护进程清理失败", lateFailure,
            { ...errorContext, errorCode: "DESKTOP_MAINTENANCE_WORKER_SETTLEMENT_FAILED" });
          exitApplication(1);
        });
        else exitApplication(1);
      }
    });
    app.on("before-quit", (event) => {
      if (quitAllowed) return;
      if (lifecycleRunning) { event.preventDefault(); return; }
      if (maintenanceOwner && !maintenanceOwner.released) {
        event.preventDefault();
        // 由启动等待结算成功或失败，不能仅凭 close 先按成功退出。
        maintenanceOwner.quitRequested = true;
        return;
      }
      if (!application) {
        if (!recoveryOwner || recoveryOwner.released) { quitAllowed = true; return; }
        event.preventDefault();
        void recoveryOwner.close().then(() => { recoveryOwner!.dispose(); quitAllowed = true; app.quit(); }).catch(showError);
        return;
      }
      event.preventDefault();
      void requestQuit();
    });
  }
  app.on("window-all-closed", () => undefined);
  // macOS 点击 Dock 图标时重新显示已隐藏的窗口。
  app.on("activate", () => {
    if (application) application.openWindow(); else pendingOpen = true;
  });
  }
}

}

/** 只接收独立切换器传入的原session路径，不复制其他历史启动参数。 */
function readShellSessionDataDirectory(argv: string[]): string | undefined {
  const args = argv.filter(value => value.startsWith("--codeflow-session-data-dir"));
  if (!args.length) return undefined;
  const directory = args[0]?.slice("--codeflow-session-data-dir=".length);
  if (args.length !== 1 || !args[0]!.startsWith("--codeflow-session-data-dir=") || !directory || !path.isAbsolute(directory)
    || /[\x00-\x1f]/u.test(directory) || path.resolve(directory) !== directory
    || fs.realpathSync.native(directory) !== directory || fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) {
    throw new Error("DESKTOP_SESSION_PROFILE_INVALID");
  }
  return directory;
}

/** 完整安装器只写成功事实；旧更新记录在首次正常启动中按该代次独立归档。 */
function readCompletedInstallation(installRoot: string): { file: string; requestId: string; stat: fs.BigIntStats } | null {
  const file = path.join(installRoot, "installation-completed.ini"), stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 512n) throw new Error("DESKTOP_INSTALL_MARKER_INVALID");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  const match = /^\[installation\]\r\nschema=1\r\nrequestId=(nsis-install-[A-Za-z0-9._+-]{1,100})\r\n$/u.exec(text);
  if (!match) throw new Error("DESKTOP_INSTALL_MARKER_INVALID");
  return { file, requestId: match[1]!, stat };
}

/** 安装与维护共用有限参数入口；不接受外来路径、静默删除或混用选项。 */
function readDesktopLifecycleRequest(argv: string[], packaged: boolean, platform: string):
  { kind: 'check' } | { kind: "installation"; requestId: string } | { kind: "maintenance"; requestId: string; mode: "keep" | "remove"; resumePending?: true } | null {
  if (argv.some(argument => argument.startsWith('--codeflow-check-installation'))) {
    if (!packaged || platform !== 'win32' || argv.length !== 2 || argv[1] !== '--codeflow-check-installation') {
      throw Object.assign(new Error('DESKTOP_INSTALL_REQUEST_INVALID'), { code: 'DESKTOP_INSTALL_REQUEST_INVALID' });
    }
    return { kind: 'check' };
  }
  const installation = argv.some(argument => argument.startsWith("--codeflow-register-installation"));
  if (installation) {
    if (!packaged || platform !== "win32" || (argv.length !== 2 && argv.length !== 3) || argv[1] !== "--codeflow-register-installation"
      || argv.length === 3 && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(argv[2]!)) {
      throw Object.assign(new Error("DESKTOP_INSTALL_REQUEST_INVALID"), { code: "DESKTOP_INSTALL_REQUEST_INVALID" });
    }
    return { kind: "installation", requestId: argv[2] ?? crypto.randomUUID() };
  }
  const positions = argv.flatMap((argument, index) => argument.startsWith("--codeflow-uninstall-maintenance") ? [index] : []);
  if (!positions.length && !argv.includes("--delete-app-data")) return null;
  if (!packaged || platform !== "win32" || positions.length !== 1 || positions[0] !== 1
    || (argv.length !== 4 && !(argv.length === 5 && argv[4] === "--resume-pending"))
    || argv[1] !== "--codeflow-uninstall-maintenance" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(argv[2]!)
    || (argv[3] !== "keep" && argv[3] !== "remove")) {
    throw Object.assign(new Error("DESKTOP_UNINSTALL_REQUEST_INVALID"), { code: "DESKTOP_UNINSTALL_REQUEST_INVALID" });
  }
  return { kind: "maintenance", requestId: argv[2]!, mode: argv[3], ...(argv.length === 5 ? { resumePending: true } : {}) };
}

/** 阻断同安装与私有 Client；只排除本主进程的 Chromium 子进程和精确生命周期父 launcher。 */
async function assertNoDesktopClientProcess(dataDir: string, installRoot: string): Promise<void> {
  const processes = await processSnapshot(), executable = maintenanceProcessPath(process.execPath);
  const self = processes.find(item => item.pid === process.pid);
  const ownArguments = readMaintenanceProcessArguments(self?.commandLine ?? "");
  if (!self || self.parentPid !== process.ppid || self.created <= 0 || self.created > Date.now()
    || maintenanceProcessPath(self.executable) !== executable || !ownArguments.valid
    || maintenanceProcessPath(ownArguments.values[0] ?? "") !== executable
    || ownArguments.values.length !== process.argv.length || ownArguments.values.slice(1).some((value, index) => value !== process.argv[index + 1])) {
    throw Object.assign(new Error("DESKTOP_UNINSTALL_PROCESS_UNKNOWN"), { code: "DESKTOP_UNINSTALL_PROCESS_UNKNOWN" });
  }
  const parent = processes.find(item => item.pid === self.parentPid), parentArguments = readMaintenanceProcessArguments(parent?.commandLine ?? "");
  const launcherPath = maintenanceProcessPath(path.join(installRoot, "CodeFlowAI.exe"));
  const shellDirectory = path.dirname(process.execPath), shellsDirectory = path.dirname(shellDirectory);
  const waitingLauncher = parent && parent.pid !== self.pid && parent.created > 0 && parent.created <= self.created
    && maintenanceProcessPath(parent.executable) === launcherPath && parentArguments.valid
    && maintenanceProcessPath(parentArguments.values[0] ?? "") === launcherPath
    && parentArguments.values.length === process.argv.length && parentArguments.values.slice(1).every((value, index) => value === process.argv[index + 1])
    && path.basename(shellsDirectory).toLowerCase() === "shells" && maintenanceProcessPath(path.dirname(shellsDirectory)) === maintenanceProcessPath(installRoot)
    && path.basename(process.execPath).toLowerCase() === "codeflowai.exe"
    && readDesktopLifecycleRequest(process.argv, app.isPackaged, process.platform) ? parent : undefined;
  const helpers = new Map<number, ProcessIdentity>([[self.pid, self]]), related = new Map<number, ProcessIdentity>();
  let added = true;
  while (added) {
    added = false;
    for (const item of processes) {
      if (helpers.has(item.pid)) continue;
      const parent = helpers.get(item.parentPid);
      if (!parent) continue;
      if (item.created > 0 && item.created < parent.created) { related.set(item.pid, item); continue; }
      const args = readMaintenanceProcessArguments(item.commandLine);
      const types = args.values.filter(argument => argument.startsWith("--type="));
      if (item.created > 0 && item.created <= Date.now() && maintenanceProcessPath(item.executable) === executable
        && args.valid && maintenanceProcessPath(args.values[0] ?? "") === executable && args.values[1]?.startsWith("--")
        && types.length === 1 && ["--type=renderer", "--type=gpu-process", "--type=utility", "--type=crashpad-handler"].includes(types[0]!)) {
        helpers.set(item.pid, item); added = true;
      } else related.set(item.pid, item);
    }
  }
  for (const item of processes) {
    if (helpers.has(item.pid)) continue;
    if (waitingLauncher && item.pid === waitingLauncher.pid) continue;
    const args = readMaintenanceProcessArguments(item.commandLine);
    const clientEntry = maintenanceRuntimeEntries(args.values).some(entry => /[\\/]client[\\/]dist[\\/].+\.(?:cjs|mjs|js)$/iu.test(entry)
      && (maintenancePathContains(installRoot, entry) || maintenancePathContains(path.join(dataDir, "releases"), entry)));
    if (maintenancePathContains(installRoot, item.executable) || maintenancePathContains(installRoot, args.values[0] ?? "") || clientEntry
      || waitingLauncher && item.parentPid === waitingLauncher.pid) related.set(item.pid, item);
  }
  if (related.size) {
    const cause = new AggregateError([...related.values()].map(item => Object.assign(new Error("DESKTOP_UNINSTALL_PROCESS_BLOCKED"), {
      code: "DESKTOP_UNINSTALL_PROCESS_BLOCKED", inventoryFailure: { reason: "RELATED_IDENTITY_INVALID", pid: item.pid, parentPid: item.parentPid,
        created: item.created, instanceSha256: crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex") },
    })), "DESKTOP_UNINSTALL_PROCESSES_ACTIVE");
    throw Object.assign(new Error("DESKTOP_UNINSTALL_APP_RUNNING", { cause }), { code: "DESKTOP_UNINSTALL_APP_RUNNING", processCount: related.size });
  }
}

/** 只跳过已知运行时选项；脚本确定后停止，未知前缀保留候选而不猜参数个数。 */
function maintenanceRuntimeEntries(argv: readonly string[]): string[] {
  const entries: string[] = [], flags = ["--enable-source-maps", "--disable-source-maps", "--trace-warnings", "--trace-uncaught", "--no-warnings",
    "--experimental-modules", "--preserve-symlinks", "--preserve-symlinks-main", "--expose-gc", "--watch", "--inspect", "--inspect-brk"];
  const values = ["--require", "-r", "--import", "--loader", "--experimental-loader", "--title", "--conditions", "-C", "--input-type", "--experimental-default-type", "--inspect-port"];
  const loads = ["--require", "-r", "--import", "--loader", "--experimental-loader"];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--") { if (argv[index + 1]) entries.push(argv[index + 1]!); break; }
    if (!argument.startsWith("-")) { entries.push(argument); break; }
    if (argument.startsWith("-r") && !argument.startsWith("--") && argument.length > 2) { entries.push(argument.slice(2)); continue; }
    const equals = argument.indexOf("="), option = equals < 0 ? argument : argument.slice(0, equals);
    if (values.includes(option)) {
      const value = equals < 0 ? argv[++index] : argument.slice(equals + 1);
      if (value && loads.includes(option)) entries.push(value);
      continue;
    }
    if (flags.includes(option)) continue;
    // 未知运行时形式不能证明后续固定Client路径只是普通业务参数。
    entries.push(...argv.slice(index).flatMap(value => value.includes("=") ? [value, value.slice(value.indexOf("=") + 1)] : [value]));
    break;
  }
  return entries;
}

/** Windows快照中的空字段保持未知，只对绝对路径做大小写无关的边界比较。 */
function maintenanceProcessPath(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value).toLowerCase() : "";
}

/** 包含关系按路径段判定，提及私有路径的后续参数及相邻目录不能冒充运行入口。 */
function maintenancePathContains(root: string, candidate: string): boolean {
  const target = maintenanceProcessPath(candidate);
  if (!target) return false;
  const relative = path.relative(maintenanceProcessPath(root), target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 读取Windows常规argv引号和反斜线规则；坏引号保留已见入口并显式标为无效。 */
function readMaintenanceProcessArguments(commandLine: string): { values: string[]; valid: boolean } {
  const values: string[] = [];
  if (!commandLine || commandLine.length > 32768 || commandLine.includes("\0")) return { values, valid: false };
  let position = 0;
  while (position < commandLine.length) {
    while (commandLine[position] === " " || commandLine[position] === "\t") position++;
    if (position === commandLine.length) break;
    let value = "", quoted = false;
    while (position < commandLine.length) {
      const character = commandLine[position]!;
      if (!quoted && (character === " " || character === "\t")) break;
      if (character === "\\") {
        const start = position;
        while (commandLine[position] === "\\") position++;
        const count = position - start;
        if (commandLine[position] !== '"') { value += "\\".repeat(count); continue; }
        value += "\\".repeat(Math.floor(count / 2));
        if (count % 2) { value += '"'; position++; continue; }
      }
      if (commandLine[position] === '"') {
        if (quoted && commandLine[position + 1] === '"') { value += '"'; position += 2; }
        else { quoted = !quoted; position++; }
      } else value += commandLine[position++]!;
    }
    values.push(value);
    if (quoted) return { values, valid: false };
  }
  return { values, valid: values.length > 0 };
}

/** 浏览器清理有界；超时只报告失败，真实 Promise 结束前由调用方继续持锁。 */
async function awaitMaintenance<T>(flight: Promise<T>, onTimeout: (error: Error) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([flight, new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const code = "DESKTOP_UNINSTALL_BROWSER_CLEANUP_TIMEOUT", error = Object.assign(new Error(code), { code });
        onTimeout(error); reject(error);
      }, 30_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** 有限维护IPC仅在真实close后成功；缺Worker显式失败，超时仍持有owner与锁。 */
function startDesktopMaintenanceWorker(entry: string, dataDir: string, request: {
  schemaVersion: 1; requestId: string; dataDir: string; clientId: string;
} & ({ action: "reinstall_local_tasks"; oldDeviceId: string; nextDeviceId: string } | { deviceId: string; action?: "migration_credentials" })): {
  done: Promise<void>; closed: Promise<Error | undefined>; released: boolean;
} {
  const codePrefix = request.action === "reinstall_local_tasks" ? "DESKTOP_REINSTALL_WORKER" : "DESKTOP_UNINSTALL_WORKER";
  let stat;
  try { stat = fs.lstatSync(entry); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    throw Object.assign(new Error(`${codePrefix}_MISSING`, { cause }), { code: `${codePrefix}_MISSING` });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Object.assign(new Error(`${codePrefix}_INVALID`), { code: `${codePrefix}_INVALID` });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|pathext|systemroot|windir|comspec|systemdrive|home|userprofile|appdata|localappdata|temp|tmp|tmpdir)$/iu.test(key)));
  const child = spawn(process.execPath, [entry], { cwd: dataDir,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", CODEFLOWAI_CLIENT_LOG_DIR: path.join(dataDir, "logs") }, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
  let resolveDone!: () => void, rejectDone!: (error: unknown) => void, resolveClosed!: (lateFailure?: Error) => void;
  const owner = { released: false, closed: new Promise<Error | undefined>(resolve => { resolveClosed = resolve; }),
    done: new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }) };
  const failures: unknown[] = [];
  let responded = false, timedOutFailureCount = 0;
  const timer = setTimeout(() => {
    const failure = Object.assign(new Error(`${codePrefix}_TIMEOUT`), { code: `${codePrefix}_TIMEOUT` });
    failures.push(failure); timedOutFailureCount = failures.length;
    rejectDone(failures.length === 1 ? failure : new AggregateError([...failures], `${codePrefix}_FAILED`));
  }, 120_000);
  child.once("spawn", () => {
    try {
      child.send(request, error => {
        if (error) failures.push(Object.assign(new Error(`${codePrefix}_SEND_FAILED`, { cause: error }), { code: `${codePrefix}_SEND_FAILED` }));
      });
    } catch (cause) {
      failures.push(Object.assign(new Error(`${codePrefix}_SEND_FAILED`, { cause }), { code: `${codePrefix}_SEND_FAILED` }));
    }
  });
  child.on("message", value => {
    const raw = value as { schemaVersion?: unknown; requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown } | null;
    if (responded || !raw || typeof raw !== "object" || raw.schemaVersion !== 1 || raw.requestId !== request.requestId
      || typeof raw.ok !== "boolean" || Object.keys(raw).length !== 4 || Object.keys(raw).some(key => !["schemaVersion", "requestId", "ok", raw.ok ? "result" : "error"].includes(key))) {
      failures.push(Object.assign(new Error(`${codePrefix}_RESPONSE_INVALID`), { code: `${codePrefix}_RESPONSE_INVALID` })); return;
    }
    responded = true;
    if (!raw.ok) {
      failures.push(readDesktopMaintenanceWorkerFailure(raw.error)); return;
    }
    const result = raw.result as Record<string, unknown> | null, fields = request.action === "reinstall_local_tasks" ? ["rebound", "unchanged"] : ["cleanedKeys"];
    if (!result || typeof result !== "object" || Object.keys(result).length !== fields.length || !Object.keys(result).every(key => fields.includes(key))
      || fields.some(key => !Number.isSafeInteger(result[key]) || (result[key] as number) < 0)) {
      failures.push(Object.assign(new Error(`${codePrefix}_RESPONSE_INVALID`), { code: `${codePrefix}_RESPONSE_INVALID` }));
    }
  });
  child.on("error", cause => { failures.push(Object.assign(new Error(`${codePrefix}_PROCESS_FAILED`, { cause }), { code: `${codePrefix}_PROCESS_FAILED` })); });
  child.once("close", (code, signal) => {
    clearTimeout(timer); owner.released = true;
    if (code !== 0 || signal || !responded) failures.push(Object.assign(new Error(`${codePrefix}_CLOSE_FAILED`), { code: `${codePrefix}_CLOSE_FAILED` }));
    // 超时后新增原因由原close承载，主边界补记；普通结算不重复记录已有错误。
    resolveClosed(timedOutFailureCount && failures.length > timedOutFailureCount ? new AggregateError([...failures], `${codePrefix}_FAILED`) : undefined);
    if (failures.length) rejectDone(failures.length === 1 ? failures[0] : new AggregateError(failures, `${codePrefix}_FAILED`));
    else resolveDone();
  });
  return owner;
}

/** IPC失败只保有界短码因果树，原始正文和未知字段不进入主进程日志。 */
function readDesktopMaintenanceWorkerFailure(value: unknown, depth = 0): Error {
  const record = value && typeof value === "object" ? value : {};
  const code = Object.getOwnPropertyDescriptor(record, "code")?.value;
  const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : "DESKTOP_MAINTENANCE_WORKER_FAILED";
  const children = Object.getOwnPropertyDescriptor(record, "causes")?.value;
  const causes = depth < 3 && Array.isArray(children) ? children.slice(0, 8).map(child => readDesktopMaintenanceWorkerFailure(child, depth + 1)) : [];
  return Object.assign(new Error(safeCode, causes.length ? { cause: new AggregateError(causes, "DESKTOP_MAINTENANCE_WORKER_CAUSES") } : undefined), { code: safeCode });
}

/** 信任根只来自壳安装资源；缺少配置时明确禁止更新，不信任用户数据或下载内容。 */
function readInstalledReleaseTrust(shellResourcesDir: string): TrustedReleaseKeys {
  try {
    return assertTrustedReleaseKeys(JSON.parse(fs.readFileSync(path.join(shellResourcesDir, "release-trust.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({});
    throw error;
  }
}

/** 主进程统一记错；卸载展示维护阶段、请求与日志位置，保留失败及非零退出语义。 */
function showDesktopError(dataDir: string, title: string, error: unknown, context?: DesktopErrorContext): void {
  let failure = error;
  try {
    recordDesktopError(dataDir, error, context);
  } catch (logError) {
    failure = new AggregateError([error, logError], "DESKTOP_ERROR_LOG_FAILED");
  }
  const message = describeUserFacingError(failure, context?.maintenanceRequestId
    ? "卸载维护失败，已停止后续删除。请保留数据并查看日志。" : `${title}，请稍后重试或查看日志。`);
  dialog.showErrorBox(title, context?.maintenanceRequestId
    ? `${message}\n阶段：${context.maintenanceStage ?? context.maintenancePhase ?? "startup"}\n请求编号：${context.maintenanceRequestId}\n日志：${path.join(dataDir, "logs", "desktop-errors.jsonl")}`
    : message);
}

/** 保留安全错误上下文；仅已成功预记录的同一对象跳过重复写入。 */
function recordDesktopError(dataDir: string, error: unknown, context?: DesktopErrorContext): void {
  if (error instanceof Error && preloggedDesktopErrors.has(error)) return;
  const filePath = path.join(dataDir, "logs", "desktop-errors.jsonl");
  const safe = snapshotShellHandoffErrorContext(error);
  const line = `${JSON.stringify({
    at: new Date().toISOString(), errorCode: context?.errorCode ?? readDesktopErrorCode(error, 'DESKTOP_OPERATION_FAILED'), requestId: context?.requestId ?? safe.requestId ?? crypto.randomUUID(),
    channel: context?.channel, method: context?.method, updateRequestId: context?.updateRequestId, registrationRequestId: context?.registrationRequestId,
    deviceId: context?.deviceId,
    retry: context?.retry, delayMs: context?.delayMs,
    shellAttemptRequestId: context?.shellAttemptRequestId, continuationId: context?.continuationId,
    shellId: context?.shellId ?? safe.shellId, revision: context?.revision ?? safe.revision, phase: context?.phase ?? safe.phase, installerRequestId: safe.installerRequestId,
    rootCause: safe.causeCodes[0], causeCodes: safe.causeCodes, diagnostic: safe.diagnostic, processIdentityConflicts: safe.processIdentityConflicts,
    inventoryFailures: safe.inventoryFailures,
    maintenanceRequestId: context?.maintenanceRequestId, clientId: context?.clientId, oldDeviceId: context?.oldDeviceId, nextDeviceId: context?.nextDeviceId,
    mode: context?.mode, maintenancePhase: context?.maintenancePhase, maintenanceStage: context?.maintenanceStage,
  })}\n`;
  if (context?.startupDiagnostic) appendDesktopStartupDiagnostic(dataDir, line);
  else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, "utf8");
  }
}

/** 错误码只取结构化短码，未知错误使用所属边界给定的固定码。 */
function readDesktopErrorCode(error: unknown, fallback = "DESKTOP_UPDATE_CHECK_FAILED"): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : fallback;
}
