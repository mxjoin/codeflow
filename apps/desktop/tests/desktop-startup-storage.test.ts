import test from "node:test";
import { describeUserFacingError } from "@codeflowai/shared";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";
import { DesktopStartupCleanupError } from "../src/desktopApplication.js";
import { retireShellUpdateAttempt, snapshotShellHandoffErrorContext } from "../src/shellHandoff.js";
import { cancelLegacyMigrationAccountForUninstall } from "../src/legacyClientMigration.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { DatabaseSync } from "node:sqlite";
import { resolveDesktopStorageLocation, persistDesktopStorageLocation, completeDesktopStorageLocation } from "../src/desktopStorageLocation.js";
import { EventEmitter } from "node:events";
import type { ProcessIdentity } from "../src/windowsProcessIdentity.js";

/** 在真实临时路径创建独占安装夹具，避免 Mac 路径别名触发存储拒绝。 */
async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-d16-startup-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "user-data"), installRoot = path.join(root, "install"), custom = path.join(root, "private-data");
  await fs.mkdir(userDataDir); await fs.mkdir(installRoot); await fs.writeFile(path.join(installRoot, "CodeFlowAI.exe"), "fixture");
  await fs.writeFile(path.join(installRoot, "package.json"), JSON.stringify({ version: "7.8.9-fixture" }), "utf8");
  return { root, userDataDir, installRoot, custom };
}

/** 按指定平台执行实际 main，原生打包模式保留 argv、安装事实和退出结果。 */
async function runMain(f: Awaited<ReturnType<typeof fixture>>, env: Record<string, string> = {}, interrupt = false,
  options: { locked?: boolean; kind?: "ordinary" | "held-candidate" | "recovery-control"; initialize?: boolean; cleanupFailure?: Error;
    onStart?: () => Promise<void>; runtimeStatus?: string; heldShell?: boolean; candidate?: boolean; earlyQuit?: boolean; quitDuringAdmission?: boolean;
    workerFailure?: boolean; workerMessage?: "wrong-request" | "duplicate" | "invalid-result"; workerGate?: Promise<void>; workerEntered?: () => void;
    workerTimeout?: boolean; workerSendFailure?: boolean; workerRepeatedError?: boolean; quitDuringWorker?: boolean; workerLateFailure?: boolean;
    workerCloseDuringErrorDialog?: boolean;
    maintenance?: boolean; installation?: boolean; maintenanceMode?: "keep" | "remove"; maintenanceArgv?: string[]; browserFailure?: "data" | "auth" | "storage"; quitDuringBrowser?: boolean;
    maintenanceSecondInstance?: boolean; leftoverClient?: boolean; processQueryFailure?: Error;
    processRows?: ProcessIdentity[]; processSelf?: Partial<ProcessIdentity>; executablePath?: string;
    browserGate?: Promise<void>; browserStorageGate?: Promise<void>; browserStorageRejection?: unknown;
    browserTimeout?: boolean; activeReleaseFailure?: Error; nativePackaged?: boolean; onHandoff?: () => Promise<void>; platform?: NodeJS.Platform } = {}) {
  const source = await fs.readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = ast.statements.filter(ts.isVariableStatement).filter(statement => statement.declarationList.declarations.some(declaration =>
    declaration.initializer && ts.isNewExpression(declaration.initializer) && declaration.initializer.expression.getText(ast) === "WeakSet"));
  const statements = [...declarations, ...ast.statements.filter(statement => ts.isFunctionDeclaration(statement) || ts.isIfStatement(statement))];
  const compiled = ts.transpileModule(statements.map(statement => statement.getFullText(ast)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const imports = ast.statements.filter(ts.isImportDeclaration).map(statement => statement.moduleSpecifier.getText(ast));
  const storage = imports.some(value => value.includes("desktopStorageLocation")) ? await import("../src/desktopStorageLocation.js") : {};
  const maintenance: Partial<typeof import("../src/desktopMaintenanceRecord.js")> = imports.some(value => value.includes("desktopMaintenanceRecord")) ? await import("../src/desktopMaintenanceRecord.js") : {};
  const installationRepair = imports.some(value => value.includes("installationRepair")) ? await import("../src/installationRepair.js") : {};
  const events: string[] = [], dataDirectories: string[] = [], shown: string[] = [], exits: number[] = [], workerRequests: Record<string, unknown>[] = [];
  const menuCalls: unknown[] = [];
  let retiredShellAttempts = 0;
  const window = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), {
    mainFrame: { url: "codeflow://desktop/" }, isDestroyed: () => false, isLoading: () => false, send() {},
  }) });
  let unregisterBridge: (() => void) | undefined;
  const executablePath = options.executablePath ?? path.join(f.installRoot, "CodeFlowAI.exe");
  const mainArgv = options.maintenanceArgv ?? (options.installation ? [executablePath, "--codeflow-register-installation", "nsis-install-test"]
    : options.maintenance ? [executablePath, "--codeflow-uninstall-maintenance", "maintenance:keep", options.maintenanceMode ?? "keep"]
      : options.nativePackaged ? [executablePath] : []);
  const listeners = new Map<string, (...args: any[]) => void>();
  let startupFlight: Promise<unknown> | undefined;
  let activeWorker: EventEmitter | undefined;
  let done!: () => void;
  const completed = new Promise<void>(resolve => { done = resolve; });
  let exited!: () => void;
  const exitFlight = new Promise<void>(resolve => { exited = resolve; });
  vm.runInNewContext(compiled, {
    Error, AggregateError, Promise, WeakSet, Date, Object, Reflect, TextDecoder, path, crypto, fs: syncFs, ...storage, ...maintenance, ...installationRepair,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback,
      options.workerTimeout && delay === 120_000 || options.browserTimeout && (delay === 120_000 || delay === 30_000) ? 10 : delay),
    clearTimeout, loadOrCreateDeviceIdentity, cancelLegacyMigrationAccountForUninstall, URL,
    Menu: {
      /** 记录实际main传入的菜单参数，验证菜单移除边界。 */
      setApplicationMenu(menu: unknown) { menuCalls.push(menu); },
      /** Mac 菜单只记录模板，保留真实启动入口的调用。 */
      buildFromTemplate(template: unknown) { return template; },
    },
    resolveActiveRelease: async () => { if (options.activeReleaseFailure) throw options.activeReleaseFailure; return null; },
    resolveBaselineRelease: async () => ({ releaseDir: f.installRoot }), resolveVersionedShellStartup: async () => null,
    processSnapshot: async () => {
      if (options.processQueryFailure) throw options.processQueryFailure;
      return [{ pid: 1, parentPid: 2, created: 100, executable: executablePath,
        commandLine: mainArgv.map(argument => `"${argument}"`).join(" "), ...options.processSelf },
        ...(options.leftoverClient ? [{ pid: 17, parentPid: 16, created: 90, executable: path.join(f.installRoot, "CodeFlowAI.exe"),
          commandLine: `"${path.join(f.installRoot, "CodeFlowAI.exe")}" "${path.join(f.installRoot, "resources", "client", "dist", "index.cjs")}" --foreground` }] : []),
        ...options.processRows ?? []];
    },
    session: { defaultSession: {
      async clearData() {
        events.push("browser-data");
        await options.browserGate;
        if (options.quitDuringBrowser) listeners.get("before-quit")!({ preventDefault() { events.push("quit-blocked"); } });
        if (options.browserFailure === "data") throw Object.assign(new Error("TEST_BROWSER_DATA_FAILED"), { code: "TEST_BROWSER_DATA_FAILED" });
      },
      /** 核验完整origin参数；独立等待与拒绝注入覆盖持久化阶段边界。 */
      async clearStorageData(storageOptions: { origin: string }) {
        assert.deepEqual(Object.keys(storageOptions), ["origin"]);
        assert.equal(storageOptions.origin, "codeflow://desktop");
        events.push(`browser-storage:${storageOptions.origin}`);
        await options.browserStorageGate;
        if (Object.hasOwn(options, "browserStorageRejection")) throw options.browserStorageRejection;
        if (options.browserFailure === "storage") throw Object.assign(new Error("TEST_BROWSER_STORAGE_FAILED"), { code: "TEST_BROWSER_STORAGE_FAILED" });
      },
      async clearAuthCache() { events.push("browser-auth"); if (options.browserFailure === "auth") throw new Error("TEST_BROWSER_AUTH_FAILED"); },
    } },
    spawn() {
      events.push("worker-spawn");
      const child = new EventEmitter() as EventEmitter & { connected: boolean; send(value: any, callback: (error?: Error) => void): void };
      activeWorker = child;
      child.connected = true;
      child.send = (value, callback) => {
        workerRequests.push(structuredClone(value));
        if (options.workerSendFailure) {
          setImmediate(() => { events.push("worker-close"); child.emit("close", 1, null); });
          throw new Error("TEST_IPC_SEND_FAILED");
        }
        callback();
        setImmediate(async () => {
          const cleanup = value.action !== "reinstall_local_tasks";
          if (cleanup && !Object.hasOwn(value, "action") && !options.workerFailure) {
            const file = path.join(value.dataDir, "config.json"), config = JSON.parse(await fs.readFile(file, "utf8"));
            await fs.writeFile(file, JSON.stringify({ ...config, apiKey: "" }));
          }
          if (options.workerRepeatedError) { child.emit("error", new Error("TEST_IPC_ERROR_1")); child.emit("error", new Error("TEST_IPC_ERROR_2")); }
          const response = options.workerFailure ? { schemaVersion: 1, requestId: value.requestId, ok: false,
            error: { code: "DESKTOP_REINSTALL_TASK_FAILED", causes: [{ code: "SCHEDULED_TASK_CONFIG_CONFLICT" }] } }
            : { schemaVersion: 1, requestId: options.workerMessage === "wrong-request" ? "different-request" : value.requestId, ok: true,
              result: options.workerMessage === "invalid-result" ? { rebound: -1, unchanged: 0 } : cleanup ? { cleanedKeys: 1 } : { rebound: 0, unchanged: 0 } };
          child.emit("message", response); if (options.workerMessage === "duplicate") child.emit("message", response);
          if (options.quitDuringWorker) listeners.get("before-quit")!({ preventDefault() { events.push("quit-blocked"); } });
          options.workerEntered?.(); await options.workerGate;
          if (options.workerLateFailure) child.emit("error", Object.assign(new Error("TEST_WORKER_LATE_ERROR"), { code: "TEST_WORKER_LATE_ERROR" }));
          events.push("worker-close"); child.emit("close", options.workerFailure || options.workerLateFailure ? 1 : 0, null);
        });
        return true;
      };
      setImmediate(() => child.emit("spawn")); return child;
    },
    assertDesktopMaintenanceStartup: async (input: Parameters<NonNullable<typeof maintenance.assertDesktopMaintenanceStartup>>[0]) => {
      await maintenance.assertDesktopMaintenanceStartup!(input);
      if (options.quitDuringAdmission) { listeners.get("before-quit")!({ preventDefault() { throw new Error("UNEXPECTED_QUIT_BLOCKED"); } }); setImmediate(done); }
    },
    currentDirectory: path.join(f.installRoot, "dist"),
    process: { versions: { electron: "test" }, env, platform: options.platform ?? (options.maintenance || options.installation || options.nativePackaged ? "win32" : "linux"), resourcesPath: f.installRoot,
      execPath: executablePath, pid: 1, ppid: 2,
      argv: mainArgv },
    app: { isPackaged: !!options.maintenance || !!options.installation || !!options.nativePackaged, getPath: (name: string) => name === "userData" ? f.userDataDir : path.join(f.userDataDir, name),
      setAppUserModelId() {},
      requestSingleInstanceLock: () => options.locked !== false, on(name: string, listener: (...args: any[]) => void) { listeners.set(name, listener); },
      whenReady: () => ({ then(onReady: () => Promise<unknown>) {
        const flight = Promise.resolve().then(onReady), catchFailure = flight.catch.bind(flight);
        flight.catch = onRejected => { startupFlight = catchFailure(onRejected); return startupFlight as typeof flight; };
        return flight;
      } }), getVersion: () => "test",
      setPath() {},
      quit() { events.push("quit"); done(); },
      /** 记录真实main退出后再释放超时用例等待，避免仅凭启动catch结算推断退出。 */
      exit(code: number) { exits.push(code); exited(); done(); } },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    dialog: { showErrorBox(_title: string, message: string) {
      shown.push(message);
      if (options.workerCloseDuringErrorDialog && activeWorker) {
        const child = activeWorker; activeWorker = undefined;
        child.emit("error", Object.assign(new Error("TEST_WORKER_LATE_ERROR"), { code: "TEST_WORKER_LATE_ERROR" }));
        events.push("worker-close"); child.emit("close", 1, null);
      }
      done();
    } },
    DESKTOP_WEB_ENTRY: "codeflow://desktop/", createDesktopWebHandler: () => ({}),
    readCandidateShellHealthRequest: () => options.candidate ? { temporaryRoot: f.root } : null,
    assertCandidateShellHealthEnvironment() {}, executeCandidateShellHealth: async () => { events.push("candidate-health"); },
    assertTrustedReleaseKeys: () => ({}),
    /** 隔离崩溃捕获外部边界，保留真实存储初始化与维护入口。 */
    createDesktopCrashCapture: () => ({ initialize() {}, expectExit() {}, updateRuntimeFacts() {}, reportClientExit() {} }),
    readInstalledUpdateOrigin: () => undefined,
    readShellUpdateHostFacts: async () => undefined,
    readShellHandoffStartup: async () => {
      await options.onHandoff?.();
      if (options.earlyQuit) { listeners.get("before-quit")!({ preventDefault() { throw new Error("UNEXPECTED_QUIT_BLOCKED"); } }); setImmediate(done); }
      return { kind: options.kind ?? "ordinary", attempt: { requestId: "attempt:held", continuationId: "held", target: { shellId: "candidate" }, revision: 1, phase: "handoff" } };
    },
    startShellRecoveryController: async () => ({ assertHealthy() { events.push("recovery"); } }),
    createShellHandoffContinuation: () => ({ continuation: {}, started: async () => { events.push("handoff-started"); }, dispose() { events.push("handoff-disposed"); } }),
    /** 计数后执行真实归档入口，保留无记录与进程门禁的真实行为。 */
    async retireShellUpdateAttempt(input: Parameters<typeof retireShellUpdateAttempt>[0]) {
      retiredShellAttempts++;
      await retireShellUpdateAttempt(input);
    },
    snapshotShellHandoffErrorContext, DesktopStartupCleanupError, describeUserFacingError,
    ipcMain: { handle() {}, removeHandler() {} }, bindMainFrameEvents: () => () => undefined,
    /** 保留真实main注册的窗口监听，并在测试应用退出时执行其释放入口。 */
    createDesktopApplication(input: { dataDir: string; host: { registerBridge: (bridge: unknown, window: unknown) => () => void } }) {
      events.push("application"); dataDirectories.push(input.dataDir);
      return {
        /** 启动夹具并保留真实main桥接释放函数。 */
        async start() {
          events.push("start"); if (interrupt) throw new Error("TEST_INITIALIZATION_INTERRUPTED");
          if (options.maintenanceSecondInstance) listeners.get("second-instance")!({}, [path.join(f.installRoot, "CodeFlowAI.exe"), "--codeflow-uninstall-maintenance", "maintenance:second", "keep"]);
          if (options.initialize) await readyData(input.dataDir);
          unregisterBridge = input.host.registerBridge({ getState: async () => ({ status: options.heldShell ? "starting" : options.runtimeStatus ?? "ready" }), onEvent: () => () => undefined }, window);
          await options.onStart?.();
        },
        /** 主进程持有实际Client健康事实，不使用面向页面的held投影。 */
        getRuntimeState() { return { status: options.runtimeStatus ?? "ready" }; },
        /** 沿真实main顺序检查存储已完成，再接续壳更新；无候选时保持原入口。 */
        async resumeStartupUpdate() {
          if (options.heldShell) {
            const saved = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
            assert.equal(saved.clientId, "client-original");
            events.push("resume-shell");
          }
          return false;
        },
        /** 释放桥接监听后显式传播清理故障。 */
        async exit() { events.push("exit"); unregisterBridge?.(); if (options.cleanupFailure) throw options.cleanupFailure; }, openWindow() { events.push("window"); },
        startAutomaticUpdates() { events.push("updates"); done(); },
      };
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([completed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("D16_MAIN_DID_NOT_SETTLE")), 30_000); })]); }
  finally { if (timer) clearTimeout(timer); }
  await startupFlight;
  await new Promise(resolve => setImmediate(resolve));
  return { events, dataDirectories, shown, exits, menuCalls, workerRequests, retiredShellAttempts, settled: exitFlight,
    windowListeners: [window.listenerCount("maximize"), window.listenerCount("unmaximize")] };
}

// Mac 在首次及已有数据的启动中都不进入 Windows 壳交接，安装身份保持一致。
test("macOS ordinary startup preserves initialized storage on the second launch", async t => {
  const f = await fixture(t);
  const options = { platform: "darwin" as const, initialize: true,
    onHandoff: async () => { assert.fail("macOS must not enter Windows shell handoff"); } };
  const first = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, options);
  assert.deepEqual(first.shown, []);
  assert.ok(first.events.includes("start") && first.events.includes("updates"));
  const locator = await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"));
  const identity = await fs.readFile(path.join(f.custom, "device-identity.json"));
  const second = await runMain(f, {}, false, options);
  assert.deepEqual(second.shown, []);
  assert.ok(second.events.includes("start") && second.events.includes("updates"));
  assert.deepEqual(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json")), locator);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), identity);
});

/** 即使用例提前失败，也释放测试gate并有界等待真实main结算；拒绝继续向测试框架传播。 */
function observeTimeout(t: test.TestContext, release: () => void, flight: ReturnType<typeof runMain>) {
  t.after(async () => {
    release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([flight.then(result => result.settled), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("D16_TIMEOUT_FIXTURE_DID_NOT_SETTLE")), 5_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  });
  return flight;
}

for (const leftoverClient of [false, true]) test(`real main installation preflight is read-only and refuses an active Client=${leftoverClient}`, async t => {
  const f = await fixture(t), executable = path.join(f.installRoot, 'CodeFlowAI.exe');
  const result = await runMain(f, {}, false, { installation: true, leftoverClient,
    maintenanceArgv: [executable, '--codeflow-check-installation'] });
  assert.deepEqual(result.exits, [leftoverClient ? 1 : 0]);
  assert.equal(result.events.includes('application'), false); assert.equal(result.events.includes('start'), false);
  assert.equal(result.events.includes('handoff'), false);
  assert.equal(result.retiredShellAttempts, 0);
  await assert.rejects(fs.access(path.join(f.userDataDir, 'desktop-data-location.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.userDataDir, 'runtime')), { code: 'ENOENT' });
});

test("real main installation preflight without an attempt preserves an existing empty runtime", async t => {
  const f = await fixture(t), runtime = path.join(f.userDataDir, "runtime");
  await fs.mkdir(runtime);
  const result = await runMain(f, {}, false, { installation: true,
    maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"), "--codeflow-check-installation"] });
  assert.deepEqual(result.exits, [0]);
  assert.equal(result.retiredShellAttempts, 0);
  assert.deepEqual(await fs.readdir(runtime), []);
  await assert.rejects(fs.access(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

/** 准备只有六字段定位与确空默认根的从未运行安装。 */
async function emptyInstallation(t: test.TestContext) {
  const f = await fixture(t), location = await resolveDesktopStorageLocation(f);
  await fs.mkdir(location.dataDir); await persistDesktopStorageLocation(location);
  return { f, location };
}

test("real main installation registration exits without D13 or business initialization", async t => {
  const f = await fixture(t); let handoffReads = 0;
  const result = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false,
    { installation: true, onHandoff: async () => { handoffReads++; } });
  assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, []); assert.equal(handoffReads, 0);
  assert.deepEqual(result.menuCalls, [null]);
  assert.deepEqual(result.windowListeners, [0, 0]);
  const location = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
  assert.equal(location.dataDir, path.join(f.userDataDir, "runtime"));
  assert.equal(location.clientId, null); assert.equal(location.deviceId, null);
  assert.deepEqual(await fs.readdir(location.dataDir), []);
  await assert.rejects(fs.lstat(f.custom), { code: "ENOENT" });
});

test("real main installation registration preserves an initialized custom locator", async t => {
  const f = await fixture(t); await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true });
  const target = path.join(f.userDataDir, "desktop-data-location.json"), before = await fs.readFile(target);
  let handoffReads = 0;
  const result = await runMain(f, {}, false, { installation: true, onHandoff: async () => { handoffReads++; } });
  assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, []); assert.equal(handoffReads, 0);
  assert.deepEqual(await fs.readFile(target), before);
});

test("new installation registration archives an unfinished old shell attempt with request-linked evidence", { skip: process.platform !== "win32" }, async t => {
  const { f, location } = await emptyInstallation(t), attemptPath = path.join(location.dataDir, "shell-update-attempt.json");
  const original = Buffer.from('{"phase":"failed","recovery":{"direction":"original","terminalEvidence":null}}');
  await fs.writeFile(attemptPath, original);
  const result = await runMain(f, {}, false, { installation: true, maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"),
    "--codeflow-register-installation", "nsis-install-evidence"] });
  assert.deepEqual(result.exits, [0]);
  const archiveDirectory = path.join(location.dataDir, "logs");
  const archived = (await fs.readdir(archiveDirectory)).find(name => name.startsWith("shell-update-retired-install-nsis-install-evidence-"));
  assert.ok(archived);
  assert.deepEqual(await fs.readFile(path.join(archiveDirectory, archived)), original);
  const logs = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.ok(logs.some(row => row.errorCode === "DESKTOP_INSTALL_ATTEMPT_SUPERSEDED" && row.requestId === "nsis-install-evidence" && row.sha256));
});

test("new installation preserves an unfinished attempt when an old Client remains active", { skip: process.platform !== "win32" }, async t => {
  const { f, location } = await emptyInstallation(t), attemptPath = path.join(location.dataDir, "shell-update-attempt.json");
  const original = Buffer.from('{"phase":"failed","recovery":{"direction":"original","terminalEvidence":null}}');
  await fs.writeFile(attemptPath, original);
  const result = await runMain(f, {}, false, { installation: true, leftoverClient: true,
    maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"), "--codeflow-register-installation", "nsis-install-busy"] });
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(await fs.readFile(attemptPath), original);
  assert.equal((await fs.readdir(location.dataDir)).some(name => name.startsWith("shell-update-retired-install-")), false);
});

test("real main installation registration refuses an occupied instance before any locator write", async t => {
  const f = await fixture(t), result = await runMain(f, {}, false, { installation: true, locked: false });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
  assert.ok(result.shown.some(message => message.includes("正在运行")));
  assert.ok(result.shown.every(message => !message.includes("DESKTOP_INSTALL_APP_RUNNING")));
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

test("real main installation refuses a leftover Client before creating runtime or locator", async t => {
  const f = await fixture(t), result = await runMain(f, {}, false, { installation: true, leftoverClient: true });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
  assert.ok(result.shown.some(message => message.includes("仍在运行")));
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "runtime")), { code: "ENOENT" });
});

for (const extra of [["extra"], ["--codeflow-register-installation"], ["--delete-app-data"], ["--codeflow-uninstall-maintenance", "request", "keep"], ["bad/request"]]) {
  test(`real main installation rejects ambiguous argv ${extra.join(" ")} before side effects`, async t => {
    const f = await fixture(t), result = await runMain(f, {}, false, { installation: true,
      maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"), "--codeflow-register-installation", "nsis-install-test", ...extra] });
    assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
    await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
  });
}

for (const registration of [false, true]) test(`real main null pending blocks before D13 or registration writes; register=${registration}`, async t => {
  const f = await fixture(t), dataDir = path.join(f.userDataDir, "runtime"), recordPath = path.join(f.userDataDir, "desktop-uninstall-result.json");
  const record = { schemaVersion: 1, appId: "ai.codeflow.codeflowai", requestId: "maintenance:empty-pending", mode: "keep", phase: "started",
    installRoot: f.installRoot, dataDir, clientId: null, oldDeviceId: null };
  await fs.writeFile(recordPath, JSON.stringify(record)); const before = await fs.readFile(recordPath); let handoffReads = 0;
  const result = await runMain(f, {}, false, { installation: registration, onHandoff: async () => {
    handoffReads++; await fs.mkdir(path.join(dataDir, ".shell-update-file-auth"), { recursive: true });
  } });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []); assert.equal(handoffReads, 0);
  assert.ok(result.shown.some(message => message.includes("上次安装或卸载尚未完成")));
  await assert.rejects(fs.lstat(dataDir), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(recordPath), before);
});

for (const mode of ["keep", "remove"] as const) test(`real main empty ${mode} maintenance uses browser and unique record without a worker or D13`, async t => {
  const { f, location } = await emptyInstallation(t); let handoffReads = 0;
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode, onHandoff: async () => { handoffReads++; } });
  assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, ["browser-data", "browser-storage:codeflow://desktop", "browser-auth"]); assert.equal(handoffReads, 0);
  const record = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8"));
  assert.equal(record.mode, mode); assert.equal(record.phase, "completed"); assert.equal(record.clientId, null); assert.equal(record.oldDeviceId, null);
  assert.equal(Object.hasOwn(record, "nextDeviceId"), false); assert.deepEqual(await fs.readdir(location.dataDir), []);
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

for (const mode of ["keep", "remove"] as const) for (const failure of ["data", "storage", "auth"] as const) {
  test(`real main empty ${mode} browser ${failure} failure retains started and retries without D13`, async t => {
    const { f, location } = await emptyInstallation(t), target = path.join(f.userDataDir, "desktop-data-location.json"), before = await fs.readFile(target);
    const failed = await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode, browserFailure: failure });
    assert.deepEqual(failed.exits, [1]); assert.deepEqual(failed.events, ["browser-data",
      ...(failure === "data" ? [] : ["browser-storage:codeflow://desktop"]), ...(failure === "auth" ? ["browser-auth"] : [])]);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
    assert.deepEqual(await fs.readFile(target), before); assert.deepEqual(await fs.readdir(location.dataDir), []);
    let handoffReads = 0;
    const retry = await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode, onHandoff: async () => { handoffReads++; } });
    assert.deepEqual(retry.exits, [0]); assert.deepEqual(retry.events, ["browser-data", "browser-storage:codeflow://desktop", "browser-auth"]); assert.equal(handoffReads, 0);
  });
}

for (const mode of ["keep", "remove"] as const) test(`real main empty ${mode} completed reentry has no cleanup or F4 side effect`, async t => {
  const { f, location } = await emptyInstallation(t);
  await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode });
  const target = path.join(f.userDataDir, "desktop-uninstall-result.json"), before = await fs.readFile(target); let handoffReads = 0;
  const reentry = await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode, onHandoff: async () => { handoffReads++; } });
  assert.deepEqual(reentry.exits, [0]); assert.deepEqual(reentry.events, []); assert.equal(handoffReads, 0);
  assert.deepEqual(await fs.readFile(target), before); assert.deepEqual(await fs.readdir(location.dataDir), []);
});

test("real main first custom choice after empty registration survives initialization interruption", async t => {
  const { f, location } = await emptyInstallation(t);
  const interrupted = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, true);
  assert.ok(interrupted.shown.some(message => message.includes("启动失败")));
  assert.ok(interrupted.shown.every(message => !message.includes("TEST_INITIALIZATION_INTERRUPTED")));
  const locator = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
  assert.equal(locator.dataDir, f.custom); assert.equal(locator.clientId, null); assert.equal(locator.deviceId, null);
  const retry = await runMain(f, {}, true); assert.deepEqual(retry.dataDirectories, [f.custom]);
  assert.deepEqual(await fs.readdir(location.dataDir), []);
});

for (const entry of ["unknown.txt", "shell-update-attempt.json"] as const) {
  test(`real main empty keep refuses ${entry} before browser or D13`, async t => {
    const { f, location } = await emptyInstallation(t), target = path.join(location.dataDir, entry);
    await fs.writeFile(target, "fixture-owned-content");
    let handoffReads = 0;
    const result = await runMain(f, {}, false, { maintenance: true, onHandoff: async () => { handoffReads++; } });
    assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []); assert.equal(handoffReads, 0);
    assert.ok((await fs.lstat(target)).isFile());
    await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
  });
}

test("real main empty keep allows app-owned runtime entries before registration", async t => {
  const { f, location } = await emptyInstallation(t);
  await fs.mkdir(path.join(location.dataDir, "logs"));
  await fs.mkdir(path.join(location.dataDir, ".shell-update-file-auth"));
  for (const name of ["device-identity.json", "errors.jsonl", "crash-session.json"]) {
    await fs.writeFile(path.join(location.dataDir, name), "{}");
  }
  const result = await runMain(f, {}, false, { maintenance: true });
  assert.deepEqual(result.exits, [0]);
  const completed = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8"));
  assert.equal(completed.phase, "completed");
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

/** 准备真实固定文件，让main的ready回填走产品SQLite和身份读取。 */
async function readyData(dataDir: string) {
  await loadOrCreateDeviceIdentity(dataDir);
  await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ clientId: "client-original" }));
  await fs.writeFile(path.join(dataDir, "codeflowai.db.meta.json"), JSON.stringify({ schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "ready" }));
  if (!syncFs.existsSync(path.join(dataDir, "codeflowai.db"))) {
    const db = new DatabaseSync(path.join(dataDir, "codeflowai.db"));
    try { db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('client_id', 'client-original')"); }
    finally { db.close(); }
  }
}

/** 真实旧身份和完整定位，维护模拟器仅替代凭据边界，不绕过main阶段控制。 */
async function maintenanceInstallation(t: test.TestContext) {
  const f = await fixture(t);
  await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true });
  await fs.writeFile(path.join(f.custom, "config.json"), JSON.stringify({ clientId: "client-original", apiKey: "fixture-cloud-secret" }));
  await fs.mkdir(path.join(f.installRoot, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(f.installRoot, "client", "dist", "desktopUninstallWorker.cjs"), "fixture worker boundary");
  const oldIdentity = await fs.readFile(path.join(f.custom, "device-identity.json"));
  return { f, oldIdentity };
}

for (const completedInstall of [false, true]) test(`native packaged startup isolates old attempts and preserves profile bytes; installationFact=${completedInstall}`, { skip: process.platform !== "win32" }, async t => {
  const { f } = await maintenanceInstallation(t);
  await fs.mkdir(path.join(f.installRoot, "resources"));
  await fs.writeFile(path.join(f.installRoot, "resources", "shell-switch.exe"), "native executor presence only");
  const attempt = path.join(f.custom, "shell-update-attempt.json"), originalAttempt = Buffer.from('{broken historical attempt 账号');
  await fs.writeFile(attempt, originalAttempt);
  const marker = path.join(f.installRoot, "installation-completed.ini"), requestId = "nsis-install-native-startup";
  if (completedInstall) await fs.writeFile(marker, `[installation]\r\nschema=1\r\nrequestId=${requestId}\r\n`, "ascii");
  const protectedFiles = [path.join(f.userDataDir, "desktop-data-location.json"),
    ...["device-identity.json", "config.json", "codeflowai.db", "codeflowai.db.meta.json"].map(name => path.join(f.custom, name))];
  const before = await Promise.all(protectedFiles.map(file => fs.readFile(file)));
  let handoffReads = 0;
  const result = await runMain(f, {}, false, { nativePackaged: true, onHandoff: async () => { handoffReads++; throw new Error("LEGACY_HANDOFF_MUST_NOT_RUN"); } });
  assert.deepEqual(result.shown, []); assert.deepEqual(result.exits, []);
  assert.ok(result.events.includes("start")); assert.ok(result.events.includes("updates"));
  assert.equal(result.events.includes("worker-spawn"), false); assert.equal(result.events.includes("recovery"), false);
  assert.equal(handoffReads, 0);
  for (let index = 0; index < protectedFiles.length; index++) assert.deepEqual(await fs.readFile(protectedFiles[index]!), before[index]);
  if (completedInstall) {
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
    await assert.rejects(fs.access(attempt), { code: "ENOENT" });
    const archive = (await fs.readdir(path.join(f.custom, "logs"))).filter(name => name.startsWith(`shell-update-retired-install-${requestId}-`));
    assert.equal(archive.length, 1); assert.deepEqual(await fs.readFile(path.join(f.custom, "logs", archive[0]!)), originalAttempt);
  } else assert.deepEqual(await fs.readFile(attempt), originalAttempt);
});

/** 只在真实已清理安装写原维护授权，模拟删除中断而不伪造任意路径载荷。 */
async function authorizedRemoval(t: test.TestContext) {
  const { f, oldIdentity } = await maintenanceInstallation(t), maintenance = await import("../src/desktopMaintenanceRecord.js");
  const location = { ...JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8")), userDataDir: f.userDataDir };
  const config = JSON.parse(await fs.readFile(path.join(f.custom, "config.json"), "utf8"));
  await fs.writeFile(path.join(f.custom, "config.json"), JSON.stringify({ ...config, apiKey: "" }));
  const started = await maintenance.beginDesktopMaintenance({ userDataDir: f.userDataDir, location, requestId: "maintenance:keep", mode: "remove" });
  const record = await maintenance.authorizeDesktopMaintenance({ userDataDir: f.userDataDir, location }, started);
  return { f, oldIdentity, record };
}

for (const removed of ["database", "locator", "identity"] as const) test(`real main remove authorized retry after ${removed} deletion never reopens cleanup or release`, async t => {
  const { f } = await authorizedRemoval(t);
  const target = removed === "database" ? path.join(f.custom, "codeflowai.db")
    : removed === "locator" ? path.join(f.userDataDir, "desktop-data-location.json") : path.join(f.custom, "device-identity.json");
  await fs.unlink(target);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove", activeReleaseFailure: new Error("RELEASE_MUST_NOT_BE_READ") });
  assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, []);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "completed");
  await assert.rejects(fs.lstat(path.join(f.custom, "codeflowai.db")), { code: "ENOENT" });
});

test("real main remove authorized retry completes empty authentication directory before first D13 read", async t => {
  const { f } = await authorizedRemoval(t), authentication = path.join(f.custom, ".shell-update-file-auth");
  await fs.mkdir(authentication);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove", onHandoff: async () => {
    await assert.rejects(fs.lstat(authentication), { code: "ENOENT" });
  } });
  assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, []);
});

test("real main remove process gate precedes authorized empty authentication cleanup", async t => {
  const { f } = await authorizedRemoval(t), authentication = path.join(f.custom, ".shell-update-file-auth");
  await fs.mkdir(authentication);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove", leftoverClient: true,
    onHandoff: async () => { throw new Error("D13_MUST_NOT_RUN_BEFORE_PROCESS_GATE"); } });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
  assert.ok((await fs.lstat(authentication)).isDirectory());
  assert.match(result.shown.join("\n"), /仍在运行/);
});

test("real main remove authorized retry cannot be taken over by a different request", async t => {
  const { f } = await authorizedRemoval(t), target = path.join(f.userDataDir, "desktop-uninstall-result.json"), before = await fs.readFile(target);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove",
    maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"), "--codeflow-uninstall-maintenance", "different-request", "remove"] });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []); assert.deepEqual(await fs.readFile(target), before);
  assert.ok((await fs.lstat(path.join(f.custom, "codeflowai.db"))).isFile());
});

for (const mode of ["keep", "remove"] as const) for (const versioned of [false, true]) {
  test(`real main explicitly resumes a ${mode} request after reopening the uninstaller; launcher=${versioned}`, async t => {
    const { f } = await maintenanceInstallation(t);
    const launcher = path.join(f.installRoot, "CodeFlowAI.exe"), executablePath = versioned ? path.join(f.installRoot, "shells/current/CodeFlowAI.exe") : launcher;
    /** 调用参数保留新 ID；只有业务记录采用已核旧 ID，父链仍按真实调用匹配。 */
    function invocation(requestId: string, resume = false) {
      const tail = ["--codeflow-uninstall-maintenance", requestId, mode, ...(resume ? ["--resume-pending"] : [])];
      return { executablePath, maintenanceArgv: [executablePath, ...tail], processRows: versioned
        ? [{ pid: 2, parentPid: 3, created: 50, executable: launcher, commandLine: [launcher, ...tail].map(value => `"${value}"`).join(" ") }] : [] };
    }
    const first = await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode, workerFailure: true, ...invocation("maintenance:keep") });
    assert.deepEqual(first.exits, [1]);
    const file = path.join(f.userDataDir, "desktop-uninstall-result.json"), original = JSON.parse(await fs.readFile(file, "utf8"));
    const resumed = await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode, ...invocation("nsis:reopened", true) });
    assert.deepEqual(resumed.exits, [0]); assert.deepEqual(resumed.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]);
    const completed = JSON.parse(await fs.readFile(file, "utf8")); assert.equal(completed.requestId, original.requestId); assert.equal(completed.phase, "completed");
    const repeated = await runMain(f, {}, false, { maintenance: true, maintenanceMode: mode, ...invocation("nsis:reopened", true) });
    assert.deepEqual(repeated.exits, [0]); assert.deepEqual(repeated.events, []);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), completed);
  });
}

test("real main explicit resume completes authorized removal without recreating a missing locator", async t => {
  const { f } = await authorizedRemoval(t), locator = path.join(f.userDataDir, "desktop-data-location.json");
  await fs.unlink(locator);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove",
    maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"), "--codeflow-uninstall-maintenance", "nsis:reopened", "remove", "--resume-pending"] });
  assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, []);
  await assert.rejects(fs.access(locator), { code: "ENOENT" }); assert.deepEqual(await fs.readdir(f.custom), []);
});

test("real main explicit resume rejects a changed maintenance mode before cleanup", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  await runMain(f, {}, false, { maintenance: true, workerFailure: true });
  const file = path.join(f.userDataDir, "desktop-uninstall-result.json"), before = await fs.readFile(file);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove",
    maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"), "--codeflow-uninstall-maintenance", "nsis:reopened", "remove", "--resume-pending"] });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
  assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
});

for (const boundary of ["process-query", "handoff"] as const) test(`real main remove authorized ${boundary} failure logs known ownership once`, async t => {
  const { f, record } = await authorizedRemoval(t);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove",
    ...(boundary === "process-query" ? { processQueryFailure: Object.assign(new Error("QUERY_FAILED"), { code: "QUERY_FAILED" }) }
      : { kind: "held-candidate" as const }) });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
  const rows = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].maintenanceRequestId, record.requestId); assert.equal(rows[0].mode, "remove");
  assert.equal(rows[0].clientId, record.clientId); assert.equal(rows[0].oldDeviceId, record.oldDeviceId);
  assert.equal(rows[0].maintenancePhase, "data_action_authorized");
});

for (const kind of ["held-candidate", "recovery-control"] as const) test(`real main remove authorized retry rejects ${kind} without deleting private targets`, async t => {
  const { f, oldIdentity } = await authorizedRemoval(t), database = await fs.readFile(path.join(f.custom, "codeflowai.db"));
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove", kind });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "codeflowai.db")), database);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "data_action_authorized");
});

test("real main remove completed retry does not resolve old storage or start cleanup", async t => {
  const { f } = await authorizedRemoval(t);
  const first = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove" }); assert.deepEqual(first.exits, [0]);
  const second = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: path.join(f.root, "irrelevant") }, false,
    { maintenance: true, maintenanceMode: "remove", activeReleaseFailure: new Error("RELEASE_MUST_NOT_BE_READ"),
      onHandoff: async () => { throw new Error("D13_MUST_NOT_RUN_FOR_COMPLETED_DIAGNOSIS"); } });
  assert.deepEqual(second.exits, [0]); assert.deepEqual(second.events, []);
  await assert.rejects(fs.lstat(path.join(f.custom, "codeflowai.db")), { code: "ENOENT" });
});

test("real main remove completed diagnosis still refuses a leftover Client before acknowledging uninstall", async t => {
  const { f } = await authorizedRemoval(t);
  const first = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove" }); assert.deepEqual(first.exits, [0]);
  const second = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove", leftoverClient: true });
  assert.deepEqual(second.exits, [1]); assert.deepEqual(second.events, []);
  assert.match(second.shown.join("\n"), /仍在运行/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "completed");
});

test("real main remove maintenance deletes only authorized private data after worker and browser close", async t => {
  const { f } = await maintenanceInstallation(t), project = path.join(f.root, "project", ".codeflow");
  await fs.mkdir(project, { recursive: true }); await fs.writeFile(path.join(project, "keep.txt"), "项目保留\n", "utf8");
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove" });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]); assert.deepEqual(result.exits, [0]);
  const record = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8"));
  assert.equal(record.mode, "remove"); assert.equal(record.phase, "completed");
  for (const name of ["config.json", "codeflowai.db", "codeflowai.db.meta.json", "device-identity.json"]) {
    await assert.rejects(fs.lstat(path.join(f.custom, name)), { code: "ENOENT" });
  }
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(project, "keep.txt"), "utf8"), "项目保留\n");
});

for (const fail of [false, true]) test(`real main migration account cancellation gates browser and authorization: failure=${fail}`, async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), account = path.join(f.custom, "legacy-client-migration-account.json");
  const before = JSON.stringify({ schemaVersion: 1, targetClientId: "client-original", migrationId: crypto.randomUUID(),
    nonce: crypto.randomUUID(), cancelled: false, delivered: false });
  await fs.writeFile(account, before);
  if (fail) {
    const rename = syncFs.renameSync;
    t.mock.method(syncFs, "renameSync", (...args: Parameters<typeof rename>) => {
      if (args[1] === account) throw Object.assign(new Error("controlled cancellation write failure"), { code: "TEST_CANCEL_WRITE_FAILED" });
      return rename(...args);
    });
  }
  const result = await runMain(f, {}, false, { maintenance: true });
  assert.deepEqual(result.exits, [fail ? 1 : 0]);
  const record = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8"));
  assert.equal(record.phase, fail ? "started" : "completed");
  assert.equal(JSON.parse(await fs.readFile(account, "utf8")).cancelled, !fail);
  if (fail) {
    assert.deepEqual(result.events, ["worker-spawn", "worker-close"]);
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
    const rows = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, 1); assert.equal(rows[0].errorCode, "TEST_CANCEL_WRITE_FAILED");
    assert.equal(rows[0].maintenanceRequestId, "maintenance:keep"); assert.equal(rows[0].maintenanceStage, "browser");
  }
});

for (const phase of ["data_action_authorized", "completed"] as const) test(`real main legacy keep ${phase} completes migration cleanup before acknowledging uninstall`, async t => {
  const { f } = await maintenanceInstallation(t), maintenance = await import("../src/desktopMaintenanceRecord.js");
  const location = { ...JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8")), userDataDir: f.userDataDir };
  await fs.writeFile(path.join(f.custom, "config.json"), JSON.stringify({ clientId: "client-original", apiKey: "" }));
  const account = path.join(f.custom, "legacy-client-migration-account.json");
  await fs.writeFile(account, JSON.stringify({ schemaVersion: 1, targetClientId: "client-original", migrationId: crypto.randomUUID(),
    nonce: crypto.randomUUID(), cancelled: false, delivered: false }));
  await fs.writeFile(path.join(f.custom, "legacy-client-migration-journal.json"), "{}");
  const input = { userDataDir: f.userDataDir, location, requestId: "maintenance:keep", mode: "keep" as const };
  const started = await maintenance.beginDesktopMaintenance(input), authorized = await maintenance.authorizeDesktopMaintenance(input, started);
  if (phase === "completed") await maintenance.completeDesktopMaintenance(input, authorized);
  const dbFile = path.join(f.custom, "codeflowai.db"), before = await fs.readFile(dbFile);
  const result = await runMain(f, {}, false, { maintenance: true });
  assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, ["worker-spawn", "worker-close"]);
  assert.equal(result.workerRequests[0]?.action, "migration_credentials");
  assert.equal(JSON.parse(await fs.readFile(account, "utf8")).cancelled, true);
  assert.deepEqual(await fs.readFile(dbFile), before);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "completed");
});

for (const mode of ["keep", "remove"] as const) test(`real main ${mode} maintenance ignores inherited data directory overrides`, async t => {
  const { f } = await maintenanceInstallation(t), other = path.join(f.root, "other-private-data");
  await fs.mkdir(other); await fs.writeFile(path.join(other, "keep.txt"), "other data", "utf8");
  const result = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: other }, false, { maintenance: true, maintenanceMode: mode });
  assert.deepEqual(result.exits, [0]); assert.equal(result.events[0], "worker-spawn");
  assert.equal(await fs.readFile(path.join(other, "keep.txt"), "utf8"), "other data");
});

for (const boundary of ["worker", "data", "storage", "auth"] as const) test(`real main remove maintenance ${boundary} failure preserves old ownership before authorization`, async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceMode: "remove",
    ...(boundary === "worker" ? { workerFailure: true } : { browserFailure: boundary }) });
  assert.deepEqual(result.exits, [1]); assert.equal(result.events[0], "worker-spawn");
  const record = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8"));
  assert.equal(record.mode, "remove"); assert.equal(record.phase, "started");
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  assert.ok((await fs.lstat(path.join(f.custom, "codeflowai.db"))).isFile());
  assert.equal(result.events.includes("browser-auth"), boundary === "auth");
});

test("real main keep maintenance cleans worker and browser before authorizing identity removal and never starts ordinary business", async t => {
  const { f } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]); assert.deepEqual(result.exits, [0]);
  assert.deepEqual(result.shown, []);
  const record = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8"));
  assert.equal(record.phase, "completed"); assert.equal(record.requestId, "maintenance:keep"); assert.ok(record.retainedFiles);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.custom, "config.json"), "utf8")).apiKey, "");
  await assert.rejects(fs.lstat(path.join(f.custom, "device-identity.json")), { code: "ENOENT" });
  const again = await runMain(f, {}, false, { maintenance: true }); assert.deepEqual(again.events, []); assert.deepEqual(again.exits, [0]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).nextDeviceId, record.nextDeviceId);
});

test("real main keep maintenance clears the desktop origin storage between data and auth", async t => {
  const { f } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]);
  assert.deepEqual(result.exits, [0]);
});

test("real main keep maintenance stops when desktop origin storage clearing fails", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false,
    { maintenance: true, browserFailure: "storage" });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop"]);
  assert.deepEqual(result.exits, [1]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
});

test("real main keep maintenance treats an undefined storage rejection as failure", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false,
    { maintenance: true, browserStorageRejection: undefined });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop"]);
  assert.deepEqual(result.exits, [1]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
});

test("real main keep maintenance storage timeout holds the flight and never reaches auth", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false,
    { maintenance: true, browserTimeout: true, browserStorageGate: gate }));
  try {
    assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop"]);
    assert.deepEqual(result.exits, []);
    assert.match(result.shown.join("\n"), /清理应用页面数据超时/);
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  } finally { release(); }
  await result.settled;
  assert.deepEqual(result.exits, [1]);
  assert.equal(result.events.includes("browser-auth"), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
});

test("real main keep maintenance retains timeout and a late storage rejection", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false,
    { maintenance: true, browserTimeout: true, browserStorageGate: gate, browserFailure: "storage" }));
  assert.deepEqual(result.exits, []);
  release(); await result.settled;
  assert.deepEqual(result.exits, [1]);
  assert.equal(result.events.includes("browser-auth"), false);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
  const logs = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logs.length, 2);
  assert.equal(logs[1].maintenanceRequestId, "maintenance:keep");
  assert.equal(logs[1].maintenancePhase, "started");
  assert.ok(logs[1].causeCodes.includes("DESKTOP_UNINSTALL_BROWSER_CLEANUP_TIMEOUT"));
  assert.ok(logs[1].causeCodes.includes("TEST_BROWSER_STORAGE_FAILED"));
});

for (const browserFailure of ["data", "auth"] as const) test(`real main keep maintenance ${browserFailure} failure preserves started and old identity`, async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, browserFailure });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", ...(browserFailure === "auth" ? ["browser-storage:codeflow://desktop", "browser-auth"] : [])]);
  assert.deepEqual(result.exits, [1]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  const retried = await runMain(f, {}, false, { maintenance: true });
  assert.deepEqual(retried.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]); assert.deepEqual(retried.exits, [0]);
});

test("real main keep maintenance worker failure stops before browser and preserves old identity", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, workerFailure: true });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]); assert.deepEqual(result.exits, [1]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
});

for (const workerMessage of ["wrong-request", "duplicate", "invalid-result"] as const) test(`real main keep maintenance rejects worker ${workerMessage} before browser or identity removal`, async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, workerMessage });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]); assert.deepEqual(result.exits, [1]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
});

test("real main keep maintenance cannot clear browser or authorize identity before worker actual close", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), notified = new Promise<void>(resolve => { entered = resolve; });
  const flight = runMain(f, {}, false, { maintenance: true, workerGate: gate, workerEntered: entered });
  await notified;
  try {
    assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  } finally { release(); }
  const result = await flight;
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]); assert.deepEqual(result.exits, [0]);
});

for (const workerFailure of [false, true]) test(`real main keep maintenance resolves requested quit at its owning boundary; failure=${workerFailure}`, async t => {
  const { f } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, workerFailure, quitDuringWorker: true });
  assert.deepEqual(result.events, ["worker-spawn", "quit-blocked", "worker-close", ...(workerFailure ? [] : ["browser-data", "browser-storage:codeflow://desktop", "browser-auth"])]);
  assert.deepEqual(result.exits, [workerFailure ? 1 : 0]);
});

test("real main keep maintenance browser work retains the same instance lock through requested quit", async t => {
  const { f } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, quitDuringBrowser: true });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "quit-blocked", "browser-storage:codeflow://desktop", "browser-auth"]); assert.deepEqual(result.exits, [0]);
});

test("real main keep maintenance rejects a leftover packaged Client even when dataDir is only its cwd", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, leftoverClient: true });
  assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
});

for (const variant of ["old-shell", "old-shell-helper", "external-node-baseline", "external-node-release", "external-node-worker",
  "same-root-empty-command", "unknown-child", "predates-parent", "missing-executable-client"] as const) {
  test(`real main process gate rejects ${variant} before any maintenance side effect`, async t => {
    const { f, oldIdentity } = await maintenanceInstallation(t), node = path.join(f.root, "external", "node.exe");
    const oldShell = path.join(f.installRoot, "shells", "older", "CodeFlowAI.exe");
    let row: ProcessIdentity = { pid: 17, parentPid: 16, created: 90, executable: oldShell, commandLine: `"${oldShell}"` };
    if (variant === "old-shell-helper") row.commandLine += " --type=gpu-process";
    if (variant.startsWith("external-node") || variant === "missing-executable-client") {
      const entry = variant === "external-node-baseline" || variant === "missing-executable-client"
        ? path.join(f.installRoot, "resources", "client", "dist", "index.cjs")
        : path.join(f.custom, "releases", "previous release", "client", "dist", variant === "external-node-worker" ? "desktopUninstallWorker.cjs" : "index.cjs");
      row = { ...row, executable: variant === "missing-executable-client" ? "" : node, commandLine: `"${node}" "${entry}" --foreground` };
    }
    if (variant === "same-root-empty-command") row.commandLine = "";
    if (variant === "unknown-child") row = { ...row, parentPid: 1, created: 110, executable: "", commandLine: "" };
    if (variant === "predates-parent") row = { ...row, parentPid: 1, executable: node, commandLine: `"${node}" "${path.join(f.root, "unknown.mjs")}"` };
    const result = await runMain(f, {}, false, { maintenance: true, processRows: [row] });
    assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]);
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
    await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
  });
}

for (const kind of ["installation", "keep", "remove", "resume-keep", "resume-remove"] as const) {
  test(`real main lifecycle permits only its exact waiting launcher parent: ${kind}`, async t => {
    const { f } = kind === "installation" ? await emptyInstallation(t) : await maintenanceInstallation(t);
    const launcher = path.join(f.installRoot, "CodeFlowAI.exe"), executablePath = path.join(f.installRoot, "shells/current/CodeFlowAI.exe");
    const mode = kind.endsWith("remove") ? "remove" : "keep";
    const tail = kind === "installation" ? ["--codeflow-register-installation", "nsis-install-test"] : ["--codeflow-uninstall-maintenance", "maintenance:keep", mode,
      ...(kind.startsWith("resume-") ? ["--resume-pending"] : [])];
    const result = await runMain(f, {}, false, { executablePath, maintenanceArgv: [executablePath, ...tail],
      ...(kind === "installation" ? { installation: true } : { maintenance: true, maintenanceMode: mode }),
      processRows: [{ pid: 2, parentPid: 3, created: 50, executable: launcher, commandLine: [launcher, ...tail].map(value => `"${value}"`).join(" ") }] });
    assert.deepEqual(result.exits, [0]);
    assert.deepEqual(result.events, kind === "installation" ? [] : ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]);
  });
}

for (const variant of ["wrong-parent", "wrong-path", "newer-parent", "unknown-created", "different-request", "different-mode", "extra-argument", "sibling", "unknown-child"] as const) {
  test(`real main lifecycle rejects a waiting launcher with ${variant}`, async t => {
    const { f, oldIdentity } = await maintenanceInstallation(t), launcher = path.join(f.installRoot, "CodeFlowAI.exe");
    const executablePath = path.join(f.installRoot, "shells/current/CodeFlowAI.exe");
    const parent: ProcessIdentity = { pid: 2, parentPid: 3, created: 50, executable: launcher,
      commandLine: `"${launcher}" --codeflow-uninstall-maintenance "maintenance:keep" keep` };
    if (variant === "wrong-parent") parent.pid = 20;
    if (variant === "wrong-path") parent.executable = path.join(f.installRoot, "shells/old/CodeFlowAI.exe");
    if (variant === "newer-parent") parent.created = 101;
    if (variant === "unknown-created") parent.created = 0;
    if (variant === "different-request") parent.commandLine = parent.commandLine.replace("maintenance:keep", "another-request");
    if (variant === "different-mode") parent.commandLine = parent.commandLine.replace(/ keep$/u, " remove");
    if (variant === "extra-argument") parent.commandLine += " extra";
    const rows = [parent];
    if (variant === "sibling") rows.push({ ...parent, pid: 21, parentPid: 2, created: 60 });
    if (variant === "unknown-child") rows.push({ pid: 21, parentPid: 2, created: 60, executable: "", commandLine: "" });
    const result = await runMain(f, {}, false, { executablePath, maintenance: true, processRows: rows });
    assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
    await assert.rejects(fs.access(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
  });
}

for (const variant of ["own-helpers", "parent-path-argument", "unrelated-empty", "adjacent-root", "unrelated-client"] as const) {
  test(`real main process gate permits ${variant} without claiming unrelated processes`, async t => {
    const { f } = await maintenanceInstallation(t), exe = path.join(f.installRoot, "CodeFlowAI.exe"), node = path.join(f.root, "external", "node.exe");
    let rows: ProcessIdentity[] = [{ pid: 2, parentPid: 3, created: 50, executable: node,
      commandLine: `"${node}" "${path.join(f.root, "runner.mjs")}" --target "${f.custom}" --foreground` }];
    if (variant === "own-helpers") rows = [
      { pid: 17, parentPid: 1, created: 110, executable: exe, commandLine: `"${exe}" --type=gpu-process --user-data-dir="${f.userDataDir}"` },
      { pid: 18, parentPid: 17, created: 120, executable: exe, commandLine: `"${exe}" --type=utility --utility-sub-type=network.mojom.NetworkService` },
    ];
    if (variant === "unrelated-empty") rows = [{ pid: 0, parentPid: 0, created: 0, executable: "", commandLine: "" }];
    if (variant === "adjacent-root") {
      const adjacent = path.join(`${f.installRoot}-other`, "CodeFlowAI.exe");
      rows = [{ pid: 17, parentPid: 16, created: 90, executable: adjacent, commandLine: `"${adjacent}" --foreground` }];
    }
    if (variant === "unrelated-client") rows = [{ pid: 17, parentPid: 16, created: 90, executable: node,
      commandLine: `"${node}" "${path.join(f.root, "elsewhere", "client", "dist", "index.cjs")}" --foreground` }];
    const result = await runMain(f, {}, false, { maintenance: true, processRows: rows });
    assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "completed");
  });
}

for (const variant of ["baseline-runtime-flags", "release-runtime-flags", "after-double-dash", "runtime-option-value", "unknown-runtime-form", "client-preload"] as const) {
  test(`real main process gate rejects Client entry with ${variant}`, async t => {
    const { f, oldIdentity } = await maintenanceInstallation(t), node = path.join(f.root, "external", "node.exe");
    const entry = variant === "baseline-runtime-flags" ? path.join(f.installRoot, "resources", "client", "dist", "index.cjs")
      : path.join(f.custom, "releases", "previous release", "client", "dist", "index.cjs");
    let args = `--enable-source-maps "${entry}" --foreground`;
    if (variant === "release-runtime-flags") args = `--trace-warnings --inspect=127.0.0.1:0 "${entry}" --foreground`;
    if (variant === "after-double-dash") args = `--enable-source-maps -- "${entry}" --foreground`;
    if (variant === "runtime-option-value") args = `--require "${path.join(f.root, "bootstrap.cjs")}" --enable-source-maps "${entry}" --foreground`;
    if (variant === "unknown-runtime-form") args = `--future-runtime-option unknown-value "${entry}" --foreground`;
    if (variant === "client-preload") args = `--require "${entry}" "${path.join(f.root, "ordinary.cjs")}"`;
    const row: ProcessIdentity = { pid: 17, parentPid: 16, created: 90, executable: node, commandLine: `"${node}" ${args}` };
    const result = await runMain(f, {}, false, { maintenance: true, processRows: [row] });
    assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]);
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
    await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
  });
}

for (const variant of ["runtime-flags", "double-dash", "title-value", "unknown-script-argument"] as const) {
  test(`real main process gate permits a non-Client script with ${variant} and later Client paths`, async t => {
    const { f } = await maintenanceInstallation(t), node = path.join(f.root, "external", "node.exe"), script = path.join(f.root, "ordinary.cjs");
    const dataArgument = path.join(f.custom, "releases", "current", "client", "dist", "index.cjs");
    let args = `--enable-source-maps "${script}" --target "${dataArgument}"`;
    if (variant === "double-dash") args = `-- "${script}" --target "${dataArgument}"`;
    if (variant === "title-value") args = `--title "${dataArgument}" "${script}"`;
    if (variant === "unknown-script-argument") args = `"${script}" --future-runtime-option "${dataArgument}"`;
    const row: ProcessIdentity = { pid: 17, parentPid: 16, created: 90, executable: node, commandLine: `"${node}" ${args}` };
    const result = await runMain(f, {}, false, { maintenance: true, processRows: [row] });
    assert.deepEqual(result.exits, [0]); assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data", "browser-storage:codeflow://desktop", "browser-auth"]);
  });
}

test("real main keep maintenance process query failure precedes started and credential cleanup", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, processQueryFailure: new Error("TEST_PROCESS_QUERY_FAILED") });
  assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
});

test("real main keep maintenance browser timeout retains ownership until actual settlement and exits failed", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false, { maintenance: true, browserTimeout: true, browserGate: gate }));
  try {
    assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data"]); assert.deepEqual(result.exits, []);
    assert.match(result.shown.join("\n"), /清理应用页面数据超时/);
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  } finally { release(); }
  await result.settled;
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "started");
});

test("real main keep maintenance preserves a late browser rejection alongside the timeout", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false, { maintenance: true, browserTimeout: true, browserGate: gate, browserFailure: "data" }));
  release();
  await result.settled;
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "browser-data"]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  const logs = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logs.length, 2);
  assert.equal(logs[1].maintenanceRequestId, "maintenance:keep");
  assert.equal(logs[1].maintenancePhase, "started");
  assert.ok(logs[1].causeCodes.includes("DESKTOP_UNINSTALL_BROWSER_CLEANUP_TIMEOUT"));
  assert.ok(logs[1].causeCodes.includes("TEST_BROWSER_DATA_FAILED"));
});

test("real main keep maintenance timeout exits failed only after close and never proceeds to browser", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false, { maintenance: true, workerTimeout: true, workerGate: gate }));
  try {
    assert.deepEqual(result.events, ["worker-spawn"]); assert.deepEqual(result.exits, []);
    assert.match(result.shown.join("\n"), /卸载维护程序执行超时/);
    assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  } finally { release(); }
  await result.settled;
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]); assert.deepEqual(result.exits, [1]);
});

test("real main keep maintenance preserves worker errors arriving after timeout in the same request", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false, { maintenance: true, workerTimeout: true, workerGate: gate, workerLateFailure: true }));
  assert.deepEqual(result.exits, []);
  release();
  await result.settled;
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  const logs = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logs.length, 2);
  assert.equal(logs[1].requestId, logs[0].requestId);
  assert.equal(logs[1].maintenanceRequestId, "maintenance:keep");
  for (const code of ["DESKTOP_UNINSTALL_WORKER_TIMEOUT", "DESKTOP_UNINSTALL_WORKER_PROCESS_FAILED", "DESKTOP_UNINSTALL_WORKER_CLOSE_FAILED", "TEST_WORKER_LATE_ERROR"]) {
    assert.ok(logs[1].causeCodes.includes(code), code);
  }
});

test("real main keep maintenance timeout retains errors already reported by the worker", async t => {
  const { f } = await maintenanceInstallation(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false, { maintenance: true, workerTimeout: true, workerGate: gate, workerRepeatedError: true }));
  const logs = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  release();
  await result.settled;
  assert.deepEqual(result.exits, [1]);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].causeCodes.includes("DESKTOP_UNINSTALL_WORKER_TIMEOUT"));
  assert.ok(logs[0].causeCodes.includes("DESKTOP_UNINSTALL_WORKER_PROCESS_FAILED"));
  assert.equal((await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").length, 1);
});

test("real main keep maintenance consumes worker late causes even when close precedes the failure exit decision", async t => {
  const { f } = await maintenanceInstallation(t);
  const result = await runMain(f, {}, false, { maintenance: true, workerTimeout: true,
    workerGate: new Promise<void>(() => {}), workerCloseDuringErrorDialog: true });
  await result.settled;
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]); assert.deepEqual(result.exits, [1]);
  const logs = (await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logs.length, 2);
  assert.equal(logs[0].requestId, logs[1].requestId);
  assert.ok(logs[1].causeCodes.includes("DESKTOP_UNINSTALL_WORKER_TIMEOUT"));
  assert.ok(logs[1].causeCodes.includes("TEST_WORKER_LATE_ERROR"));
});

test("real main ordinary instance does not open a window for a maintenance second instance", async t => {
  const { f } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenanceSecondInstance: true });
  assert.deepEqual(result.events, ["application", "start", "updates"]); assert.deepEqual(result.shown, []);
});

test("real main keep maintenance refuses an occupied instance without opening business or writing a record", async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, locked: false });
  assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
  const log = JSON.parse((await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  assert.equal(log.maintenanceRequestId, "maintenance:keep"); assert.equal(log.mode, "keep");
});

for (const kind of ["held-candidate", "recovery-control"] as const) test(`real main keep maintenance rejects ${kind} before worker or browser`, async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t), result = await runMain(f, {}, false, { maintenance: true, kind });
  assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
  const log = JSON.parse((await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  assert.equal(log.maintenanceRequestId, "maintenance:keep"); assert.equal(log.mode, "keep");
});

for (const args of [
  ["--codeflow-uninstall-maintenance", "maintenance:keep", "unknown"],
  ["--codeflow-uninstall-maintenance", "bad\nrequest", "keep"],
  ["--codeflow-uninstall-maintenance", "maintenance:keep\n", "keep"],
  ["--codeflow-uninstall-maintenance", "maintenance:keep", "keep", "--codeflow-uninstall-maintenance"],
  ["--codeflow-uninstall-maintenance=keep", "maintenance:keep", "keep"],
  ["--codeflow-uninstall-maintenance", "maintenance:keep", "keep", "--delete-app-data"],
  ["--codeflow-uninstall-maintenance", "maintenance:keep", "keep", "--RESUME-PENDING"],
  ["--codeflow-uninstall-maintenance", "maintenance:keep", "keep", "--resume-pending", "--resume-pending"],
  ["--codeflow-uninstall-maintenance", "maintenance:keep", "--resume-pending", "keep"],
]) test(`real main rejects malformed keep maintenance arguments ${JSON.stringify(args)}`, async t => {
  const { f, oldIdentity } = await maintenanceInstallation(t);
  const result = await runMain(f, {}, false, { maintenance: true, maintenanceArgv: [path.join(f.installRoot, "CodeFlowAI.exe"), ...args] });
  assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]); assert.match(result.shown.join("\n"), /卸载请求无效/);
  assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), oldIdentity);
  await assert.rejects(fs.lstat(path.join(f.userDataDir, "desktop-uninstall-result.json")), { code: "ENOENT" });
});

test("real main persists custom storage before interrupted initialization and reuses it without env", async (t) => {
  const f = await fixture(t);
  const first = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, true);
  assert.deepEqual(first.dataDirectories, [f.custom]);
  assert.equal(syncFs.existsSync(path.join(f.userDataDir, "desktop-data-location.json")), true);
  const locator = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
  assert.equal(locator.dataDir, f.custom); assert.equal(locator.clientId, null); assert.equal(locator.deviceId, null);
  const second = await runMain(f, {}, true);
  assert.deepEqual(second.dataDirectories, [f.custom]);
  assert.equal(syncFs.existsSync(path.join(f.userDataDir, "runtime")), false);
});

test("real main completes persistent ownership only after ready and then starts updates", async t => {
  const f = await fixture(t), result = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true });
  assert.deepEqual(result.events, ["application", "start", "updates"]); assert.deepEqual(result.shown, []);
  assert.deepEqual(result.menuCalls, [null]);
  assert.deepEqual(result.windowListeners, [1, 1]);
  const record = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
  assert.equal(record.clientId, "client-original"); assert.match(record.deviceId, /^[0-9a-f-]{36}$/u);
});

test("real main completes storage using actual Client health before resuming a prepared held shell", async t => {
  const f = await fixture(t);
  const result = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true, heldShell: true });
  assert.deepEqual(result.events, ["application", "start", "resume-shell", "updates"]);
  assert.deepEqual(result.shown, []);
  assert.deepEqual(result.exits, []);
});

for (const cleanupFailure of [undefined, Object.assign(new Error("cleanup failed"), { code: "CLIENT_CLEANUP_FAILED" })])
test(`real main awaits application exit after ready ownership failure; cleanup failure=${!!cleanupFailure}`, async t => {
  const f = await fixture(t), result = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { cleanupFailure });
  assert.deepEqual(result.events, ["application", "start", "exit"]); assert.equal(result.shown.length, 1);
  assert.deepEqual(result.windowListeners, [0, 0]);
  assert.deepEqual(result.exits, cleanupFailure ? [] : [1]);
  const record = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
  assert.equal(record.clientId, null); assert.equal(record.deviceId, null);
  if (cleanupFailure) assert.match(result.shown[0]!, /停止运行环境/u);
});

test("second instance and candidate health never register ordinary storage", async t => {
  for (const options of [{ locked: false }, { candidate: true }]) {
    const f = await fixture(t), result = await runMain(f, {}, false, options);
    await assert.rejects(fs.stat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
    assert.deepEqual(result.events, options.candidate ? ["candidate-health"] : ["quit"]);
  }
});

test("recovery controller retains ownership and never writes locator or creates application", async t => {
  const f = await fixture(t), result = await runMain(f, {}, false, { kind: "recovery-control" });
  assert.deepEqual(result.events, ["recovery", "quit"]);
  await assert.rejects(fs.stat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

test("held candidate requires complete existing location and does not rewrite it", async t => {
  const f = await fixture(t), incomplete = await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { kind: "held-candidate" });
  assert.deepEqual(incomplete.events, []); assert.deepEqual(incomplete.exits, [1]);
  await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, true);
  await readyData(f.custom);
  await completeDesktopStorageLocation(await resolveDesktopStorageLocation({ userDataDir: f.userDataDir, installRoot: f.installRoot }));
  const file = path.join(f.userDataDir, "desktop-data-location.json"), before = await fs.readFile(file);
  const result = await runMain(f, {}, false, { kind: "held-candidate" });
  assert.deepEqual(result.events, ["application", "start", "handoff-started", "updates"]);
  assert.deepEqual(await fs.readFile(file), before);
});

test("ordinary complete locator rejects changed identity before application initialization", async t => {
  const f = await fixture(t);
  await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true });
  const identity = JSON.parse(await fs.readFile(path.join(f.custom, "device-identity.json"), "utf8"));
  identity.deviceId = crypto.randomUUID();
  await fs.writeFile(path.join(f.custom, "device-identity.json"), JSON.stringify(identity));
  const result = await runMain(f);
  assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]);
});

test("early quit during handoff reads never persists a locator", async t => {
  const f = await fixture(t), result = await runMain(f, {}, false, { earlyQuit: true });
  assert.deepEqual(result.events, []); assert.deepEqual(result.shown, []);
  await assert.rejects(fs.stat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

test("early quit during maintenance admission never persists a locator", async t => {
  const f = await fixture(t), result = await runMain(f, {}, false, { quitDuringAdmission: true });
  assert.deepEqual(result.events, []); assert.deepEqual(result.shown, []);
  await assert.rejects(fs.stat(path.join(f.userDataDir, "desktop-data-location.json")), { code: "ENOENT" });
});

/** 旧身份先由真实初始化登记，合法keep记录只写测试自有干净摘要。 */
async function keepRecord(t: test.TestContext) {
  const f = await fixture(t); await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true });
  let locator = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
  await completeDesktopStorageLocation({ ...locator, userDataDir: f.userDataDir });
  locator = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8"));
  await fs.unlink(path.join(f.custom, "device-identity.json"));
  await fs.mkdir(path.join(f.installRoot, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(f.installRoot, "client", "dist", "desktopUninstallWorker.cjs"), "fixture worker boundary");
  const retainedFiles: Record<string, string> = {};
  for (const [key, name] of Object.entries({ configSha256: "config.json", databaseSha256: "codeflowai.db", metadataSha256: "codeflowai.db.meta.json" })) {
    retainedFiles[key] = crypto.createHash("sha256").update(await fs.readFile(path.join(f.custom, name))).digest("hex");
  }
  const record = { schemaVersion: 1, appId: "ai.codeflow.codeflowai", requestId: "maintenance:reinstall", mode: "keep", phase: "completed",
    installRoot: f.installRoot, dataDir: f.custom, clientId: locator.clientId, oldDeviceId: locator.deviceId,
    nextDeviceId: "16e38f2a-0640-49b0-a871-a897e5fcae81", createdAt: "2026-10-31T00:00:00.000Z", retainedFiles };
  await fs.writeFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), JSON.stringify(record));
  return { f, record };
}

test("real main installation rebinds a retained custom root before F4 and consumes its source only after worker close", async t => {
  const { f, record } = await keepRecord(t), nextRoot = path.join(f.root, "next-install");
  await fs.mkdir(nextRoot); await fs.writeFile(path.join(nextRoot, "CodeFlowAI.exe"), "fixture");
  await fs.copyFile(path.join(f.installRoot, "package.json"), path.join(nextRoot, "package.json"));
  await fs.mkdir(path.join(nextRoot, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(nextRoot, "client", "dist", "desktopUninstallWorker.cjs"), "fixture worker boundary");
  const moved = { ...f, installRoot: nextRoot }, recordPath = path.join(f.userDataDir, "desktop-uninstall-result.json");
  let handoffReads = 0;
  const registered = await runMain(moved, {}, false, { installation: true, onHandoff: async () => { handoffReads++; } });
  assert.deepEqual(registered.exits, [0]); assert.deepEqual(registered.events, []); assert.equal(handoffReads, 0);
  const rebound = JSON.parse(await fs.readFile(recordPath, "utf8"));
  assert.equal(rebound.installRoot, nextRoot); assert.equal(rebound.rebindFromInstallRoot, f.installRoot);
  assert.equal(rebound.nextDeviceId, record.nextDeviceId); assert.equal(rebound.phase, "completed");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-data-location.json"), "utf8")).installRoot, nextRoot);
  await assert.rejects(fs.lstat(path.join(f.custom, "device-identity.json")), { code: "ENOENT" });
  const retry = await runMain(moved, {}, false, { installation: true }); assert.deepEqual(retry.exits, [0]); assert.deepEqual(retry.events, []);
  const ordinary = await runMain(moved);
  assert.deepEqual(ordinary.shown, []);
  assert.ok(ordinary.events.includes("worker-close")); assert.ok(ordinary.events.includes("application"));
  const consumed = JSON.parse(await fs.readFile(recordPath, "utf8"));
  assert.equal(consumed.phase, "consumed"); assert.equal(Object.hasOwn(consumed, "rebindFromInstallRoot"), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.custom, "device-identity.json"), "utf8")).deviceId, record.nextDeviceId);
});

test("real main installation keeps the original root and identity on an unapproved root change", async t => {
  const f = await fixture(t); await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true });
  const target = path.join(f.userDataDir, "desktop-data-location.json"), before = await fs.readFile(target), identity = await fs.readFile(path.join(f.custom, "device-identity.json"));
  const nextRoot = path.join(f.root, "next-install"); await fs.mkdir(nextRoot); await fs.writeFile(path.join(nextRoot, "CodeFlowAI.exe"), "fixture");
  const result = await runMain({ ...f, installRoot: nextRoot }, {}, false, { installation: true });
  assert.deepEqual(result.exits, [1]); assert.deepEqual(result.events, []);
  assert.deepEqual(await fs.readFile(target), before); assert.deepEqual(await fs.readFile(path.join(f.custom, "device-identity.json")), identity);
});

test("real main consumes authorized keep only after maintenance worker closes and then starts ordinary application", async t => {
  const { f, record } = await keepRecord(t), result = await runMain(f);
  assert.deepEqual(result.events, ["worker-spawn", "worker-close", "application", "start", "updates"]);
  assert.deepEqual(result.shown, []);
  const consumed = JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8"));
  assert.equal(consumed.phase, "consumed");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.custom, "device-identity.json"), "utf8")).deviceId, record.nextDeviceId);
});

test("real main retains reinstalling and starts no ordinary application after worker failure", async t => {
  const { f, record } = await keepRecord(t), failed = await runMain(f, {}, false, { workerFailure: true });
  assert.deepEqual(failed.events, ["worker-spawn", "worker-close"]); assert.deepEqual(failed.exits, [1]);
  const log = JSON.parse((await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  assert.equal(log.maintenanceRequestId, record.requestId); assert.equal(log.clientId, record.clientId);
  assert.equal(log.oldDeviceId, record.oldDeviceId); assert.equal(log.nextDeviceId, record.nextDeviceId);
  assert.ok(log.causeCodes.includes("SCHEDULED_TASK_CONFIG_CONFLICT"));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "reinstalling");
  const retried = await runMain(f); assert.deepEqual(retried.shown, []);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.custom, "device-identity.json"), "utf8")).deviceId, record.nextDeviceId);
});

for (const workerMessage of ["wrong-request", "duplicate", "invalid-result"] as const) test(`real main rejects worker ${workerMessage} and leaves authorized retry`, async t => {
  const { f } = await keepRecord(t), result = await runMain(f, {}, false, { workerMessage });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]); assert.deepEqual(result.exits, [1]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "reinstalling");
});

test("real main does not consume maintenance success before actual worker close", async t => {
  const { f } = await keepRecord(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), notified = new Promise<void>(resolve => { entered = resolve; });
  const flight = runMain(f, {}, false, { workerGate: gate, workerEntered: entered });
  await notified;
  try { assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "reinstalling"); }
  finally { release(); }
  assert.deepEqual((await flight).events, ["worker-spawn", "worker-close", "application", "start", "updates"]);
});

test("real main keeps ownership after maintenance timeout and exits failed only after actual close", async t => {
  const { f } = await keepRecord(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const result = await observeTimeout(t, release, runMain(f, {}, false, { workerTimeout: true, workerGate: gate }));
  try {
    assert.deepEqual(result.events, ["worker-spawn"]); assert.deepEqual(result.exits, []);
    assert.match(result.shown.join("\n"), /修复安装程序执行超时/);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "reinstalling");
  } finally { release(); }
  await result.settled;
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]); assert.deepEqual(result.exits, [1]);
});

for (const boundary of ["workerSendFailure", "workerRepeatedError"] as const) test(`real main retains authorized retry after ${boundary}`, async t => {
  const { f } = await keepRecord(t), result = await runMain(f, {}, false, { [boundary]: true });
  assert.deepEqual(result.events, ["worker-spawn", "worker-close"]); assert.deepEqual(result.exits, [1]);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "reinstalling");
  assert.match(result.shown.join("\n"), /修复安装未完成/);
  const log = JSON.parse((await fs.readFile(path.join(f.userDataDir, "logs", "desktop-errors.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  assert.ok(log.causeCodes.includes(boundary === "workerSendFailure" ? "DESKTOP_REINSTALL_WORKER_SEND_FAILED" : "DESKTOP_REINSTALL_WORKER_PROCESS_FAILED"));
});

for (const workerFailure of [false, true]) test(`real main waits for maintenance result before requested quit; failure=${workerFailure}`, async t => {
  const { f } = await keepRecord(t), result = await runMain(f, {}, false, { workerFailure, quitDuringWorker: true });
  assert.deepEqual(result.events, ["worker-spawn", "quit-blocked", "worker-close", ...(workerFailure ? [] : ["quit"])]);
  assert.deepEqual(result.exits, workerFailure ? [1] : []);
  assert.equal(result.shown.length, workerFailure ? 1 : 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), "utf8")).phase, "reinstalling");
});

test("pending failure with a log junction never writes into a project", async t => {
  const f = await fixture(t), project = path.join(f.root, "project"); await fs.mkdir(project);
  await fs.symlink(project, path.join(f.userDataDir, "logs"), "junction");
  const record = { schemaVersion: 1, appId: "ai.codeflow.codeflowai", requestId: "maintenance:pending", mode: "remove", phase: "started",
    installRoot: f.installRoot, dataDir: path.join(f.userDataDir, "runtime"), clientId: "client-original", oldDeviceId: "d50fcfbe-f82a-43b9-ab7e-656af07a9a45" };
  await fs.writeFile(path.join(f.userDataDir, "desktop-uninstall-result.json"), JSON.stringify(record));
  const result = await runMain(f);
  assert.deepEqual(result.events, []); assert.deepEqual(result.exits, [1]); assert.match(result.shown[0]!, /日志保存失败/u);
  assert.deepEqual(await fs.readdir(project), []);
});

test("held candidate rechecks ready ownership and never reports started after identity changed", async t => {
  const f = await fixture(t);
  await runMain(f, { CODEFLOWAI_DESKTOP_DATA_DIR: f.custom }, false, { initialize: true });
  const result = await runMain(f, {}, false, { kind: "held-candidate", onStart: async () => {
    const file = path.join(f.custom, "device-identity.json"), identity = JSON.parse(await fs.readFile(file, "utf8"));
    identity.deviceId = crypto.randomUUID(); await fs.writeFile(file, JSON.stringify(identity));
  } });
  assert.deepEqual(result.events, ["application", "start", "exit", "handoff-disposed"]); assert.deepEqual(result.exits, [1]);
});

for (const phase of ["started", "data_action_authorized"] as const) test(`real main blocks ${phase} maintenance before any application initialization`, async (t) => {
  const f = await fixture(t), dataDir = path.join(f.userDataDir, "runtime");
  const record = { schemaVersion: 1, appId: "ai.codeflow.codeflowai", requestId: "maintenance:pending", mode: "remove", phase,
    installRoot: f.installRoot, dataDir, clientId: "client-original", oldDeviceId: "d50fcfbe-f82a-43b9-ab7e-656af07a9a45",
    ...(phase === "data_action_authorized" ? {
      authorizedPaths: ["shell-update-attempt.json", "config.json", "codeflowai.db", "codeflowai.db.meta.json", "codeflowai.db-wal", "codeflowai.db-shm",
        "codeflowai.db-journal", "active-release.json", "previous-release.json", "errors.jsonl", "update-receipts.jsonl", "releases", ".staging", "logs", ".shell-update-file-auth"]
        .map(name => `dataDir/${name}`).concat("userDataDir/desktop-data-location.json"),
      removalRoots: { dataDir: { dev: "1", ino: "2", birthtimeNs: "3" }, userDataDir: { dev: "1", ino: "4", birthtimeNs: "5" } },
    } : {}) };
  const file = path.join(f.userDataDir, "desktop-uninstall-result.json"), bytes = JSON.stringify(record);
  await fs.writeFile(file, bytes, "utf8");
  const result = await runMain(f);
  assert.deepEqual(result.events, []); assert.equal(result.shown.length, 1); assert.deepEqual(result.exits, [1]);
  assert.match(result.shown[0]!, /上次安装或卸载尚未完成/u);
  assert.equal(syncFs.existsSync(dataDir), false); assert.equal(await fs.readFile(file, "utf8"), bytes);
});
