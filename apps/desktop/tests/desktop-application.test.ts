import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { DESKTOP_STARTUP_CAPABILITY_PATH, type DesktopBridgeApi, type DesktopEvent } from "@codeflowai/shared";

import { createDesktopApplication, DesktopStartupCleanupError, type DesktopHost } from "../src/desktopApplication.js";
import type { ClientRuntime } from "../src/clientRuntime.js";
import { createClientRuntime } from "../src/clientRuntime.js";
import { readActivePointer } from "../src/releaseBundleCoordinator.js";
import { readPendingRelease } from "../src/pendingRelease.js";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createLegacyClientMigration, type LegacyClientMigration } from "../src/legacyClientMigration.js";
import { loadWeb } from "../src/webLoader.js";
import { signReleaseBundleManifest, readReleaseBundleFiles, computeReleaseDirectorySha256, computeReleasePackageSha256 } from "@codeflowai/shared/desktop-release-signing";
import { signShellReleaseManifest } from "@codeflowai/shared/desktop-shell-release-signing";
import { desktopDevicePublicKeySha256, readDesktopDeviceHeaders } from "@codeflowai/shared/desktop-device-auth";
import { createDesktopUpdateReceipt } from "@codeflowai/shared/desktop-update-receipt";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { createUpdateReceiptJournal } from "../src/updateReceiptJournal.js";
import * as shellLaunch from "../src/shellLaunchState.js";
import { createShellUpdateAttemptStore, createShellUpdateAttemptNetworkAdapter, type ShellUpdateAttemptV2 } from "../src/shellUpdateAttempt.js";
import type { ShellUpdateOperationBoundary } from "../src/shellUpdateOperation.js";
import type { ChildProcess } from "node:child_process";
import * as tar from "tar";
import vm from "node:vm";
import ts from "typescript";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const trustedReleaseKeys = { fixture: publicKey };

for (const cancelled of [false, true]) test(`one explicit restart preserves the combined update decision: cancelled=${cancelled}`, async () => {
  const file = new URL("../src/desktopApplication.ts", import.meta.url);
  const source = ts.createSourceFile(file.pathname, await fs.readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
  let method: ts.MethodDeclaration | undefined;
  /** 执行产品重启入口，确认待更新资源不会绕过已准备的原生壳。 */
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "restartForUpdate") method = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(method);
  const calls: string[] = [];
  const context = {
    operation: "idle", window: {} as unknown, preparedUpdate: { manifest: { releaseId: "resource-2" } },
    shellDetails: { result: "prepared" }, shellOwner: undefined as unknown, runtime: {}, restartRequested: false,
    updateCheckFailure: null, shellUpdateFailure: null, updatesSuppressed: false,
    input: { shellUpdate: { boundary: {} }, host: { relaunch() {}, confirmUpdate: async () => true } },
    async beginUpdateCheck(manual: boolean, allowRestart: boolean) {
      assert.equal(manual, true); assert.equal(allowRestart, true);
      calls.push("native transfer with pending resource");
      if (cancelled) context.updatesSuppressed = true;
      else { context.shellOwner = {}; context.window = null; }
    },
    async controlUpdate() { return { hasRunningSessions: false }; },
    application: { async exit() { calls.push("wrong resource-only restart"); } },
  };
  const compiled = ts.transpileModule(`({${method.getText(source)}}).restartForUpdate;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  await vm.runInNewContext(compiled, context)();
  assert.deepEqual(calls, ["native transfer with pending resource"]);
});

for (const failureStage of ["executor", "interrupt"] as const) test(`native shell ${failureStage} failure resumes only its own Client changes`, async () => {
  const file = new URL("../src/desktopApplication.ts", import.meta.url);
  const source = ts.createSourceFile(file.pathname, await fs.readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  /** 抽取实际应用接线，外部执行器失败仍经过产品自身的恢复 hook。 */
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "checkShellInternal") initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer);
  const calls: string[] = [];
  let status = "ready";
  const runtime = {
    snapshot: () => ({ status, pid: status === "ready" ? 123 : null }),
    async drain() { status = "stopped"; calls.push("drain active resource/schema90"); },
    async start() { status = "ready"; calls.push("start active resource/schema90"); },
    async waitReady() { calls.push("ready active resource/schema90"); },
  };
  const context = {
    input: { shellUpdate: { facts: {}, boundary: {} }, dataDir: "data", initialReleaseDir: "installation/schema88", host: {} },
    runtime, identity: { deviceId: "device" }, initialExpectation: { dbSchemaVersion: 88 }, startupHeldId: undefined,
    shellDrainedRuntime: undefined, shellDetails: {}, shellOwner: undefined, switchCommitted: false,
    async resolveActiveRelease() { throw new Error("shell preparation must not require business resources"); },
    async discoverUpdatesInternal() { return {}; },
    async readPendingRelease() { return null; }, async clearPendingRelease() {},
    async controlUpdate(_runtime: unknown, method: string) {
      if (failureStage === "interrupt" && method === "runtime.update.interrupt") throw new Error("INTERRUPT_FAILED");
      if (method === "runtime.update.cancel") calls.push("cancel admission");
      return { hasRunningSessions: false };
    },
    async restartClient(directory: string) { calls.push(`wrong new runtime:${directory}`); },
    async runShellUpdateOperation(input: any) {
      assert.equal(await input.hooks.prepare(), true);
      try { await input.hooks.drain(); }
      catch (cause) { await input.hooks.resume(); throw cause; }
      await input.hooks.resume();
      throw new Error("EXECUTOR_START_FAILED");
    },
  };
  const compiled = ts.transpileModule(`const operation = ${initializer.getText(source)}; operation;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const operation = vm.runInNewContext(compiled, context);
  await assert.rejects(operation(crypto.randomUUID(), new AbortController().signal, true, true), failureStage === "executor" ? /EXECUTOR_START_FAILED/u : /INTERRUPT_FAILED/u);
  assert.deepEqual(calls, failureStage === "executor" ? ["drain active resource/schema90", "start active resource/schema90", "ready active resource/schema90"] : ["cancel admission"]);
  assert.equal(context.shellDrainedRuntime, undefined, "resumed Client must be drained normally on the next exit");
});

/** 云关联测试复用真实壳身份与业务桥，不依赖配置更新源或运行中的桌面实例。 */
async function cloudRegistrationFixture(t: test.TestContext) {
  const f = await fixture(t);
  let bridge!: DesktopBridgeApi;
  const calls: string[] = [];
  f.host.registerBridge = value => { bridge = value; return () => {}; };
  f.runtime.request = async request => {
    calls.push(request.method);
    return { status: 200, body: { ok: true, account: { status: request.method.endsWith("unlink") ? "unlinked" : "linked", generation: 1 } } };
  };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  t.after(() => app.exit());
  return { ...f, app, calls, bridge };
}

test("云关联先撤销旧账号并在账号Server完成签名登记，本地请求不等待登记", async t => {
  const f = await cloudRegistrationFixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit) => {
    assert.equal(String(url), "http://account-server.invalid:39280/api/software/desktop/devices/register");
    assert.equal(f.calls[0], "runtime.cloudAccount.unlink");
    assert.equal(f.calls.includes("runtime.cloudAccount.link"), false);
    const body = JSON.parse(Buffer.from(options.body as Buffer).toString("utf8"));
    assert.equal(body.deviceId, identity.deviceId);
    assert.equal((options.headers as Record<string, string>).authorization, undefined);
    await gate;
    return Response.json({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) });
  });
  const pending = f.bridge.request({ method: "runtime.cloudAccount.link", body: { serverOrigin: "http://account-server.invalid:39280", sessionToken: "session-A" } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls, ["runtime.cloudAccount.unlink"]);
    await f.bridge.request({ method: "workspaces.list" });
    assert.equal(f.calls.includes("runtime.cloudAccount.link"), false);
  } finally { release(); await pending; }
  assert.deepEqual(f.calls, ["runtime.cloudAccount.unlink", "workspaces.list", "runtime.cloudAccount.link"]);
});

test("设备登记失败显式拒绝云关联，下一次请求重新登记后才允许link", async t => {
  const f = await cloudRegistrationFixture(t), identity = await loadOrCreateDeviceIdentity(f.dataDir);
  let healthy = false, registrations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    registrations++;
    return healthy ? Response.json({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) })
      : Response.json({ ok: false, code: "DESKTOP_DEVICE_REVOKED", message: "private server body" }, { status: 403 });
  });
  const request = { method: "runtime.cloudAccount.link" as const, body: { serverOrigin: "https://account-server.invalid", sessionToken: "session-A" } };
  await assert.rejects(f.bridge.request(request), (error: any) => {
    assert.equal(error.code, "DESKTOP_DEVICE_REVOKED");
    assert.equal(error.deviceId, identity.deviceId);
    assert.equal(error.registrationRequestId, error.requestId);
    assert.equal(String(error).includes("private server body"), false);
    return true;
  });
  assert.deepEqual(f.calls, ["runtime.cloudAccount.unlink"]);
  healthy = true;
  await f.bridge.request(request);
  assert.equal(registrations, 2);
  assert.deepEqual(f.calls, ["runtime.cloudAccount.unlink", "runtime.cloudAccount.unlink", "runtime.cloudAccount.link"]);
});

for (const action of ["unlink", "switch", "exit"] as const) test(`登记期间${action}取消旧关联，迟到登记不能恢复旧账号`, async t => {
  const f = await cloudRegistrationFixture(t), identity = await loadOrCreateDeviceIdentity(f.dataDir);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let registrations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++registrations === 1) { started(); await gate; }
    return Response.json({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) });
  });
  const pending = f.bridge.request({ method: "runtime.cloudAccount.link", body: { serverOrigin: "https://account-server.invalid", sessionToken: "session-A" } });
  const rejected = assert.rejects(pending, /DESKTOP_CLOUD_LINK_CANCELLED/u);
  try {
    await Promise.race([entered, new Promise<void>((_, reject) => { const timer = setTimeout(() => reject(new Error("registration did not start")), 2000); timer.unref(); })]);
    if (action === "exit") await f.app.exit();
    else if (action === "unlink") await f.bridge.request({ method: "runtime.cloudAccount.unlink" });
    else await f.bridge.request({ method: "runtime.cloudAccount.link", body: { serverOrigin: "https://account-server.invalid", sessionToken: "session-B" } });
  } finally { release(); await rejected; }
  assert.equal(f.calls.filter(method => method === "runtime.cloudAccount.link").length, action === "switch" ? 1 : 0);
});

test("旧账号撤销失败不会登记设备或关联新账号", async t => {
  const f = await cloudRegistrationFixture(t);
  const failure = { status: 500, body: { ok: false, code: "DESKTOP_CREDENTIAL_RELEASE_FAILED" } };
  f.runtime.request = async () => failure;
  t.mock.method(globalThis, "fetch", async () => { assert.fail("failed revocation must stop registration"); });
  assert.equal(await f.bridge.request({ method: "runtime.cloudAccount.link", body: { serverOrigin: "https://account-server.invalid", sessionToken: "session-A" } }), failure);
});

test("登记确认不匹配不能关联，原账号撤销响应不完整也不能继续登记", async t => {
  const f = await cloudRegistrationFixture(t);
  let registrations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    registrations++;
    return Response.json({ ok: true, deviceId: "other-device", publicKeySha256: "a".repeat(64) });
  });
  const request = { method: "runtime.cloudAccount.link" as const, body: { serverOrigin: "https://account-server.invalid", sessionToken: "session-A" } };
  await assert.rejects(f.bridge.request(request), /DESKTOP_DEVICE_REGISTRATION_ACK_INVALID/u);
  assert.deepEqual(f.calls, ["runtime.cloudAccount.unlink"]);
  f.runtime.request = async () => ({ status: 200, body: { ok: true, account: { status: "linked" } } });
  await assert.rejects(f.bridge.request(request), /DESKTOP_CLOUD_ACCOUNT_STATE_INVALID/u);
  assert.equal(registrations, 1);
});

test("非法云关联参数在撤销账号或设备登记之前拒绝", async t => {
  const f = await cloudRegistrationFixture(t);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("invalid input must not register"); });
  for (const serverOrigin of ["invalid", "https://user:private@server.invalid", "https://server.invalid/private", "file:///private"]) {
    await assert.rejects(f.bridge.request({ method: "runtime.cloudAccount.link", body: { serverOrigin, sessionToken: "session-A" } }), /DESKTOP_CLOUD_ORIGIN_INVALID/u);
  }
  await assert.rejects(f.bridge.request({ method: "runtime.cloudAccount.link", body: { serverOrigin: "https://account-server.invalid", sessionToken: "private\r\nvalue" } }), /DESKTOP_CLOUD_SESSION_INVALID/u);
  await assert.rejects(f.bridge.request({ method: "runtime.cloudAccount.link", body: { serverOrigin: "https://account-server.invalid", sessionToken: "session-A", deviceId: "forged" } }), /DESKTOP_API_REQUEST_INVALID/u);
  assert.deepEqual(f.calls, []);
});

test("壳启动页先于资源校验显示，校验失败销毁同一窗口且不启动Client", async t => {
  const f = await fixture(t);
  f.host.loadStartup = async () => { f.actions.push("startup-page"); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime });
  await assert.rejects(app.start(), /DESKTOP_RELEASE_BASELINE_MISSING/u);
  assert.ok(f.actions.indexOf("startup-page") >= 0);
  assert.ok(f.actions.indexOf("show") > f.actions.indexOf("startup-page"));
  assert.ok(f.actions.indexOf("window-destroy") > f.actions.indexOf("show"));
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.includes("load-web"), false);
});

test("慢Client启动前已显示启动页，业务就绪复用同一窗口", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void, windows = 0;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.host.createWindow = () => { windows++; return f.window; };
  f.host.loadStartup = async () => { f.actions.push("startup-page"); };
  f.runtime.start = async () => { f.actions.push("start"); entered(); await gate; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  const starting = app.start();
  await preparing;
  try {
    assert.ok(f.actions.indexOf("show") >= 0 && f.actions.indexOf("show") < f.actions.indexOf("start"));
    assert.equal(f.actions.includes("load-web"), false);
  } finally { release(); await starting; await app.exit(); }
  assert.equal(windows, 1);
});

test("壳启动页加载失败显式失败并清理，不继续启动Client", async t => {
  const f = await fixture(t), failure = new Error("STARTUP_PAGE_FAILED");
  f.host.loadStartup = async () => { throw failure; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await assert.rejects(app.start(), error => error === failure);
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.filter(action => action === "window-destroy").length, 1);
});

test("普通启动使用核心核验，held 启动仍拒绝库存变化", async t => {
  const f = await heldApplicationFixture(t);
  await fs.mkdir(path.join(f.baseline, "client/node_modules"));
  await fs.writeFile(path.join(f.baseline, "client/node_modules/extra.js"), "extra", "utf8");
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime });
  await app.start(); await app.exit();
  const held = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime,
    startupContinuation: { continuationId: "candidate-1", async authorizeReady() { assert.fail("invalid inventory"); } } });
  await assert.rejects(held.start(), /Client payload SHA-256/u);
});

test("壳交接启动同样先检查数据库迁移围栏，不启动不兼容旧Client", async t => {
  const f = await heldApplicationFixture(t);
  const staging = path.join(f.dataDir, ".staging", "next");
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(f.dataDir, "pending-release.json"), JSON.stringify({ schemaVersion: 1,
    requestId: "a795cc4e-2c1f-4a3f-8611-31c54f0943d3", releaseId: "next", stagingName: "next", databaseSchemaVersion: 89 }));
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime,
    startupContinuation: { continuationId: "candidate-1", async authorizeReady() { assert.fail("incompatible database"); } } });
  await assert.rejects(app.start(), /DESKTOP_DB_SCHEMA_FORWARD_ONLY/u);
  assert.equal(f.actions.includes("start"), false);
});

for (const mode of ["continuation", "preparing"] as const) test(`数据库修复只服从真实交接授权，历史壳${mode}不新增启动围栏`, async t => {
  const f = await heldApplicationFixture(t, { dbSchemaVersion: 89 });
  await createHeldRelease(path.join(f.dataDir, "releases", "active-1"), { releaseId: "active-1", dbSchemaVersion: 88 });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }));
  await fs.mkdir(path.join(f.dataDir, ".staging", "next"), { recursive: true });
  const pending = { schemaVersion: 1, requestId: "a795cc4e-2c1f-4a3f-8611-31c54f0943d3",
    releaseId: "next", stagingName: "next", databaseSchemaVersion: 89 };
  await fs.writeFile(path.join(f.dataDir, "pending-release.json"), JSON.stringify(pending));
  const options: Parameters<typeof createDesktopApplication>[0] = { dataDir: f.dataDir, initialReleaseDir: f.baseline,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime };
  let attempt: ShellUpdateAttemptV2 | undefined;
  if (mode === "continuation") {
    options.startupContinuation = { continuationId: "candidate-1", async authorizeReady() { assert.fail("repair must precede shell handoff"); } };
  } else {
    const originalState = { activeShellId: "old", previousShellId: null, baselineShellId: "baseline" };
    attempt = { schemaVersion: 2, requestId: crypto.randomUUID(), revision: 0, installationDir: f.baseline,
      dataDir: f.dataDir, userDataDir: f.dataDir, sessionDataDir: f.dataDir, originalState,
      candidateState: { ...originalState, activeShellId: "new", previousShellId: "old" }, phase: "preparing",
      target: { shellId: "new", manifestSha256: "a".repeat(64), installerSha256: "b".repeat(64), installerSize: 1 },
      binding: { kind: "active", releaseId: "active-1", packageSha256: "c".repeat(64), health: f.runtime.snapshot().health! },
      retriesUsed: 0, network: null };
    await createShellUpdateAttemptStore(f.dataDir).replace(null, attempt);
    options.shellUpdate = { facts: { installationDir: f.baseline, userDataDir: f.dataDir, sessionDataDir: f.dataDir,
      main: { pid: 101, parentPid: 90, created: 1101, executable: path.join(f.baseline, "CodeFlowAI.exe"), commandLine: "main" } } };
  }
  const app = createDesktopApplication(options);
  if (mode === 'preparing') {
    await app.start();
    assert.equal(app.getRuntimeState().status, 'ready');
    assert.equal(await readActivePointer(f.dataDir), null);
    assert.equal(await readPendingRelease(f.dataDir), null);
    assert.deepEqual(await createShellUpdateAttemptStore(f.dataDir).read(), attempt);
    await app.exit();
    return;
  }
  await assert.rejects(app.start(), /DESKTOP_DB_SCHEMA_FORWARD_ONLY/u);
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.includes("continue"), false);
  assert.equal(await readActivePointer(f.dataDir), "active-1");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, "pending-release.json"), "utf8")), pending);
  if (attempt) assert.deepEqual(await createShellUpdateAttemptStore(f.dataDir).read(), attempt);
});

test("关闭壳启动页后迟到加载不再启动Client或重开窗口", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void, quit!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const quitting = new Promise<void>(resolve => { quit = resolve; });
  f.host.loadStartup = async () => { entered(); await gate; };
  f.host.quit = () => { f.actions.push("quit"); quit(); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  const starting = assert.rejects(app.start(), /DESKTOP_STARTUP_STOPPED/u);
  await loading;
  f.window.emit("close", { preventDefault() {} });
  await quitting;
  release();
  await starting;
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.includes("show"), false);
  assert.equal(f.actions.filter(action => action === "drain").length, 1);
});

test("业务页加载期间关闭窗口取消启动，页面迟到完成不会重显", async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void, quit!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const quitting = new Promise<void>(resolve => { quit = resolve; });
  f.host.loadStartup = async () => {};
  f.host.loadWeb = async () => { entered(); await gate; };
  f.host.quit = () => { f.actions.push("quit"); quit(); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  const starting = assert.rejects(app.start(), /DESKTOP_STARTUP_STOPPED/u);
  await loading;
  const shown = f.actions.filter(action => action === "show").length;
  f.window.emit("close", { preventDefault() {} });
  release();
  await starting; await quitting;
  assert.equal(f.actions.filter(action => action === "show").length, shown);
});

test("启动页取消等待原退出结果，清理失败保留 owner 并可从窗口重试", async t => {
  const f = await fixture(t), cleanup = new Error("DRAIN_FAILED");
  let release!: () => void, entered!: () => void, failed!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failureShown = new Promise<void>(resolve => { failed = resolve; });
  f.host.loadStartup = async () => { entered(); await gate; };
  f.host.onMigrationError = error => { assert.equal(error, cleanup); failed(); };
  f.runtime.drain = async () => { throw cleanup; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  const starting = assert.rejects(app.start(), error => error instanceof DesktopStartupCleanupError && error.errors.includes(cleanup));
  await loading; f.window.emit("close", { preventDefault() {} }); await failureShown;
  release(); await starting;
  assert.equal(f.actions.includes("quit"), false);
  let quit!: () => void;
  const quitting = new Promise<void>(resolve => { quit = resolve; });
  f.runtime.drain = async () => { f.actions.push("drain"); };
  f.host.quit = () => { f.actions.push("quit"); quit(); };
  f.window.emit("close", { preventDefault() {} }); await quitting;
});

test("关闭启动页导致导航明确取消时正常收口", async t => {
  const f = await fixture(t);
  let rejectLoad!: (error: unknown) => void, entered!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  f.host.loadStartup = async () => { entered(); await new Promise<void>((_resolve, reject) => { rejectLoad = reject; }); };
  f.window.destroy = () => { f.actions.push("window-destroy"); rejectLoad(Object.assign(new Error("navigation aborted"), { code: "ERR_ABORTED" })); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  const starting = assert.rejects(app.start(), /DESKTOP_STARTUP_STOPPED/u);
  await loading; await app.exit(); await starting;
});

test("迁移提示先加载同一窗口，明确选择前不启动Client，业务IPC不能绕过", async t => {
  const f = await fixture(t);
  let bridge!: DesktopBridgeApi;
  let migration!: LegacyClientMigration;
  f.host.registerBridge = value => { bridge = value; return () => {}; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    createRuntime: () => f.runtime,
    createMigration: ({ identity }) => (migration = createLegacyClientMigration({ dataDir: f.dataDir, identity, workerEntry: "unused",
      execute: async () => ({ candidateId: "source-1", workspaceCount: 2 }) })) });
  const starting = app.start();
  while (!migration) await new Promise(resolve => setImmediate(resolve));
  await migration.whenDiscovered();
  assert.equal(f.actions.includes("load-web"), true);
  assert.equal(f.actions.includes("show"), true);
  assert.equal(f.actions.includes("start"), false);
  await assert.rejects(bridge.request({ method: "workspaces.list" }), /DESKTOP_MIGRATION_IN_PROGRESS/u);
  await bridge.deferMigration!();
  await starting;
  assert.equal(f.actions.includes("start"), true);
  assert.equal((await bridge.getMigrationState!()).status, "ready");
  await app.exit();
});

test("迁移与标准页面就绪并行，页面可等待迁移及Client真正完成启动", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  let migration!: LegacyClientMigration;
  f.host.loadWeb = async () => {
    await migration.whenDiscovered();
    if (migration.snapshot().status !== "ready") await new Promise<void>(resolve => {
      const unsubscribe = migration.subscribe(state => { if (state.status === "ready") { unsubscribe(); resolve(); } });
    });
    f.actions.push("web-ready");
  };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    createRuntime: () => f.runtime,
    createMigration: ({ identity }) => (migration = createLegacyClientMigration({ dataDir: f.dataDir, identity, workerEntry: "unused",
      execute: async () => ({ candidateId: null, workspaceCount: 0 }) })) });
  await app.start();
  assert.ok(f.actions.includes("web-ready"));
  assert.ok(f.actions.includes("start"));
  await app.exit();
});

test("自动续迁账号恢复不消耗Web预算，账号失败仍可完成本地启动", { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  let migration!: LegacyClientMigration, restore!: () => void, entered!: () => void;
  const restoring = new Promise<void>(resolve => { entered = resolve; });
  const account = new Promise<void>(resolve => { restore = resolve; });
  f.host.loadWeb = async (_window, _releaseDir, options) => loadWeb({ loadURL: async () => {},
    webContents: { executeJavaScript: async () => migration.snapshot().status === "ready" } }, "codeflow://desktop/",
    { requireReady: true, timeoutMs: 20, beforeReady: options?.beforeReady });
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    createRuntime: () => f.runtime,
    createMigration: ({ identity }) => (migration = createLegacyClientMigration({ dataDir: f.dataDir, identity, workerEntry: "unused",
      execute: async () => ({ candidateId: "source-1", workspaceCount: 1, completed: true,
        accountSource: { sourceClientId: "legacy", apiKey: "fixture-key", serverWs: "wss://example.test/ws/client" } }),
      restoreAccount: async () => { entered(); await account; throw new Error("ACCOUNT_OFFLINE"); } })) });
  const starting = app.start();
  const started = assert.doesNotReject(starting);
  try {
    await restoring;
    await new Promise(resolve => setTimeout(resolve, 40));
  } finally { restore(); await started; }
  assert.equal(migration.snapshot().status, "ready");
  assert.equal(migration.snapshot().account.status, "failed");
  assert.equal(f.actions.includes("window-destroy"), false);
  await app.exit();
});

test("页面真实就绪但启动授权尚未完成时只投影starting，结束后才开放业务", async t => {
  const f = await heldApplicationFixture(t);
  f.host.loadStartup = async () => { assert.fail("held must preserve its display gate"); };
  let bridge!: DesktopBridgeApi;
  f.host.registerBridge = value => { bridge = value; return () => {}; };
  f.host.loadWeb = async () => { assert.equal((await bridge.getState()).status, "starting"); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, trustedReleaseKeys, host: f.host,
    createRuntime: () => f.runtime,
    startupContinuation: { continuationId: "candidate-1", async authorizeReady() {
      assert.equal((await bridge.getState()).status, "starting");
      await assert.rejects(bridge.request({ method: "workspaces.list" }), /DESKTOP_STARTUP_HELD/u);
    } } });
  await app.start();
  assert.equal((await bridge.getState()).status, "ready");
  await app.exit();
});

test("迁移发现仍在等待用户时页面失败会停止原迁移，不遗留继续启动Client的任务", async t => {
  const f = await fixture(t);
  let migration!: LegacyClientMigration;
  f.host.loadWeb = async (_window, _releaseDir, options) => {
    await migration.whenDiscovered(); await options?.beforeReady?.(); throw new Error("WEB_READY_FAILED");
  };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    createRuntime: () => f.runtime,
    createMigration: ({ identity }) => (migration = createLegacyClientMigration({ dataDir: f.dataDir, identity, workerEntry: "unused",
      execute: async () => ({ candidateId: "source-1", workspaceCount: 2 }) })) });
  await assert.rejects(app.start(), /WEB_READY_FAILED/u);
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.filter(action => action === "drain").length, 1);
  await assert.rejects(migration.defer(), /MIGRATION_DECISION_INVALID/u);
});

test("迁移停止失败立即保留清理owner与原错，退出可重试且不等待仍在运行的Worker", { timeout: 5_000 }, async t => {
  const f = await fixture(t), webFailure = new Error("WEB_READY_FAILED"), stopFailure = new Error("WORKER_STOP_FAILED");
  let complete!: (value: { candidateId: null; workspaceCount: number }) => void;
  const worker = new Promise<{ candidateId: null; workspaceCount: number }>(resolve => { complete = resolve; });
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    createRuntime: () => f.runtime, createMigration: ({ identity }) => {
      const owner = createLegacyClientMigration({ dataDir: f.dataDir, identity, workerEntry: "unused", execute: async () => worker });
      const stop = owner.stop;
      let first = true;
      t.mock.method(owner, "stop", async () => { if (first) { first = false; throw stopFailure; } await stop(); });
      return owner;
    } });
  f.host.loadWeb = async () => { throw webFailure; };
  const starting = app.start();
  let failed = false;
  const rejected = assert.rejects(starting, error => {
    assert.ok(error instanceof DesktopStartupCleanupError);
    assert.deepEqual(error.errors, [webFailure, stopFailure]);
    failed = true; return true;
  });
  t.after(async () => { complete({ candidateId: null, workspaceCount: 0 }); await app.exit(); await rejected; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(failed, true, "停止失败必须立即返回，不能无限等待未退出的Worker");
  assert.equal(f.actions.includes("window-destroy"), false);
  assert.equal(f.actions.includes("drain"), false);
});

for (const closeMethod of ["exit", "window_close"] as const) test(`迁移提示期间退出只清理一次且不启动Client：${closeMethod}`, async t => {
  const f = await fixture(t);
  let quit!: () => void;
  const quitDone = new Promise<void>(resolve => { quit = resolve; });
  f.host.quit = () => { f.actions.push("quit"); quit(); };
  let migration!: LegacyClientMigration;
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    createRuntime: () => f.runtime,
    createMigration: ({ identity }) => (migration = createLegacyClientMigration({ dataDir: f.dataDir, identity, workerEntry: "unused",
      execute: async () => ({ candidateId: "source-1", workspaceCount: 2 }) })) });
  const starting = app.start();
  while (!migration) await new Promise(resolve => setImmediate(resolve));
  await migration.whenDiscovered();
  const failure = assert.rejects(starting, /MIGRATION_STOPPED/u);
  if (closeMethod === "exit") await app.exit();
  else f.window.emit("close", { preventDefault() {} });
  await failure;
  await quitDone;
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.filter(action => action === "drain").length, 1);
});

for (const phase of ["spawn", "ready"] as const) for (const shutdown of ["normal", "failed"] as const) {
  test(`迁移放行后启动中退出区分主动停止和真实清理失败：${phase}/${shutdown}`, { timeout: 5_000 }, async t => {
    const f = await fixture(t);
    let spawned!: () => void;
    const spawnEntered = new Promise<void>(resolve => { spawned = resolve; });
    const stopFailure = new Error('review-shutdown-failed');
    const child = Object.assign(new EventEmitter(), { pid: 123,
      /** 只替代系统进程，应用与 Runtime 启停、错误处理均使用真实实现。 */
      send(message: unknown, callback: (error: Error | null) => void): boolean {
        assert.equal((message as { t: string }).t, 'desktop.shutdown');
        f.actions.push('shutdown'); callback(shutdown === 'failed' ? stopFailure : null);
        if (shutdown === 'normal') queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
        return true;
      } });
    let runtime!: ClientRuntime, migration!: LegacyClientMigration;
    const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
      createRuntime: entry => (runtime = createClientRuntime({ entry, dataDir: f.dataDir, spawn: () => {
        spawned(); if (phase === 'ready') queueMicrotask(() => child.emit('spawn')); return child;
      } })),
      createMigration: ({ identity }) => (migration = createLegacyClientMigration({ dataDir: f.dataDir, identity, workerEntry: 'unused',
        execute: async () => ({ candidateId: 'source-1', workspaceCount: 1 }) })) });
    const starting = app.start();
    const result = starting.then(() => null, error => error as Error & { code?: string });
    while (!migration) await new Promise(resolve => setImmediate(resolve));
    await migration.whenDiscovered(); await migration.defer(); await spawnEntered;
    await new Promise(resolve => setImmediate(resolve));
    if (shutdown === 'normal') await app.exit();
    else {
      await assert.rejects(app.exit(), /review-shutdown-failed/u);
      child.emit('exit', 0, null); child.emit('close', 0, null);
    }
    const error = await result; assert.ok(error);
    if (shutdown === 'normal') {
      assert.equal(error.code, 'MIGRATION_STOPPED');
      assert.equal(fsSync.existsSync(path.join(f.dataDir, 'logs', 'desktop-runtime-errors.jsonl')), false);
      assert.equal(f.actions.filter(action => action === 'quit').length, 1);
    } else {
      assert.notEqual(error.code, 'MIGRATION_STOPPED');
      assert.equal(f.actions.includes('quit'), false);
      assert.match(await fs.readFile(path.join(f.dataDir, 'logs', 'desktop-runtime-errors.jsonl'), 'utf8'), /review-shutdown-failed/u);
    }
    assert.equal(f.actions.filter(action => action === 'shutdown').length, 1);
    assert.equal(runtime.snapshot().pid, null);
    assert.equal(child.listenerCount('message'), 0);
  });
}

for (const failure of ["none", "frame", "authorize", "ack", "ready"] as const) test(`trusted startup continuation follows held ready, frame, authorization and strict ACK: ${failure}`, async t => {
  const f = await heldApplicationFixture(t); let bridge!: DesktopBridgeApi, startup: unknown;
  const originalSnapshot = f.runtime.snapshot;
  f.runtime.snapshot = () => ({ ...originalSnapshot(), startup: { continuationId: failure === "ready" ? "wrong" : "candidate-1", admission: "paused" } });
  f.host.loadWeb = async () => { f.actions.push("frame"); if (failure === "frame") throw new Error("frame failed"); };
  f.host.registerBridge = value => { bridge = value; return () => f.actions.push("unregister"); };
  f.runtime.request = async request => { assert.equal(request.method, "runtime.startup.continue"); assert.deepEqual(request.body, { continuationId: "candidate-1" }); f.actions.push("continue"); return { status: 200, body: { ok: true, ...(failure === "ack" ? { extra: true } : {}) } }; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, host: f.host, trustedReleaseKeys,
    createRuntime: (_entry, _expected, mode) => { startup = mode; return f.runtime; },
    startupContinuation: { continuationId: "candidate-1", async authorizeReady(facts) { f.actions.push("authorize"); assert.equal(facts.client.startup?.continuationId, "candidate-1");
      assert.deepEqual(facts.baseline.manifest, f.manifest); assert.equal(facts.active, null);
      assert.deepEqual(facts.web, { loaded: true, releaseDir: f.baseline }); assert.equal(typeof facts.continueRequestId, "string");
      if (failure === "authorize") throw new Error("authorize failed"); } } });
  if (failure !== "none") {
    await assert.rejects(app.start()); assert.equal(f.actions.includes("continue"), failure === "ack"); assert.equal(f.actions.includes("show"), false);
    if (failure === "ready" || failure === "frame") assert.equal(f.actions.includes("authorize"), false);
    assert.equal(f.actions.includes("drain"), true); return;
  }
  await app.start(); assert.deepEqual(startup, { mode: "held", continuationId: "candidate-1" });
  assert.equal((await bridge.getMigrationState!()).status, "ready", "preload advertises migration state during held startup too");
  assert.equal(await bridge.takeMigrationAccount!(), null);
  await bridge.cancelMigrationAccount!();
  assert.deepEqual(f.actions.slice(0, 6), ["start", "ready", "frame", "authorize", "continue", "show"]);
  await assert.rejects(bridge.request({ method: "runtime.startup.continue", body: { continuationId: "candidate-1" } } as never), /DESKTOP_STARTUP_CONTROL_FORBIDDEN/u);
  await app.exit();
});

/** 每份工件都独立签实际库存，marker失败不会被不匹配的签名提前掩盖。 */
async function createHeldRelease(directory: string, options: { releaseId?: string; version?: string; webVersion?: string; baseline?: boolean; marker?: Record<string, unknown> | false; clientVersion?: string; dbSchemaVersion?: number } = {}) {
  await fs.mkdir(path.join(directory, "web"), { recursive: true }); await fs.mkdir(path.join(directory, "client", "dist"), { recursive: true });
  const source = "held-client";
  await fs.writeFile(path.join(directory, "web", "index.html"), "held-web", "utf8"); await fs.writeFile(path.join(directory, "client", "dist", "index.cjs"), source, "utf8");
  if (options.marker !== false) await fs.writeFile(path.join(directory, DESKTOP_STARTUP_CAPABILITY_PATH), JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
    clientEntrySha256: crypto.createHash("sha256").update(source).digest("hex"), ...options.marker }), "utf8");
  const files = await readReleaseBundleFiles(directory), webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  const manifest = signReleaseBundleManifest({ schemaVersion: 2, releaseId: options.releaseId ?? "baseline", version: options.version ?? "1.0.0", webVersion: options.webVersion ?? options.version ?? "1.0.0", clientVersion: options.clientVersion ?? "1.0.0",
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: options.dbSchemaVersion ?? 88, platform: process.platform, arch: process.arch, keyId: "fixture",
    archiveSha256: "e".repeat(64), archiveSize: 100, files, webSha256, clientSha256, packageSha256: computeReleasePackageSha256(webSha256, clientSha256),
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z" }, privateKey);
  await fs.writeFile(path.join(directory, options.baseline ? "baseline-release-manifest.json" : "manifest.json"), JSON.stringify(manifest), "utf8");
  return manifest;
}

/** held用固定安装目录及可信签名，automatic原夹具继续不需要proof。 */
async function heldApplicationFixture(t: test.TestContext, options: Parameters<typeof createHeldRelease>[1] = {}) {
  const f = await fixture(t); await loadOrCreateDeviceIdentity(f.dataDir);
  const baseline = path.join(f.dataDir, "installation"), manifest = await createHeldRelease(baseline, { ...options, baseline: true });
  const snapshot = f.runtime.snapshot;
  f.runtime.snapshot = () => ({ ...snapshot(), startup: { continuationId: "candidate-1", admission: "paused" } });
  f.runtime.request = async request => { assert.equal(request.method, "runtime.startup.continue"); f.actions.push("continue"); return { status: 200, body: { ok: true } }; };
  return { ...f, baseline, manifest };
}

for (const scenario of [
  { baseline: "2026.11.19.02", active: "2026.11.18.02", selected: "baseline", held: false },
  { baseline: "2026.11.19.02", active: "2026.11.20.01", selected: "active-1", held: false },
  { baseline: "2026.11.19.02", active: "2026.11.19.02", selected: "active-1", held: false },
  { baseline: "2026.11.19.02", active: "2026.11.18.02", selected: "active-1", held: true },
] as const) test(`完整安装按资源版本选择且交接保持原绑定：${JSON.stringify(scenario)}`, async t => {
  const f = await heldApplicationFixture(t, { version: scenario.baseline });
  const activeDir = path.join(f.dataDir, "releases", "active-1");
  await createHeldRelease(activeDir, { releaseId: "active-1", version: scenario.active });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  let selectedEntry: string | undefined, selectedRelease: string | undefined, loadedDir: string | undefined;
  f.host.loadWeb = async (_window, directory) => { loadedDir = directory; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys,
    createRuntime: (entry, expectation) => { selectedEntry = entry; selectedRelease = expectation?.releaseId; return f.runtime; },
    ...(scenario.held ? { startupContinuation: { continuationId: "candidate-1", async authorizeReady(facts) {
      assert.equal(facts.active?.releaseId, "active-1"); assert.equal(facts.web.releaseDir, activeDir);
    } } } : {}) });
  await app.start();
  const selectedDir = scenario.selected === "baseline" ? f.baseline : activeDir;
  assert.equal(selectedRelease, scenario.selected);
  assert.equal(selectedEntry, path.join(selectedDir, "client", "dist", "index.cjs"));
  assert.equal(loadedDir, selectedDir);
  assert.equal(await readActivePointer(f.dataDir), scenario.selected === "baseline" ? null : "active-1");
  assert.equal((await app.getUpdateDetails()).current.bundle?.version, scenario.selected === "baseline" ? scenario.baseline : scenario.active);
  await app.exit();
});

for (const corruption of ["signature", "payload", "missing-payload"] as const) test(`完整安装存在active仍拒绝损坏基线：${corruption}`, async t => {
  const f = await heldApplicationFixture(t, { version: "2.0.0" });
  await createHeldRelease(path.join(f.dataDir, "releases", "active-1"), { releaseId: "active-1" });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  const proof = path.join(f.baseline, "baseline-release-manifest.json");
  if (corruption === "signature") await fs.writeFile(proof, JSON.stringify({ ...f.manifest, version: "3.0.0" }), "utf8");
  else if (corruption === "missing-payload") await fs.rm(path.join(f.baseline, "client", "dist", "index.cjs"));
  else await fs.writeFile(path.join(f.baseline, "client", "dist", "index.cjs"), "tampered", "utf8");
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime });
  await assert.rejects(app.start());
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.includes("load-web"), false);
  assert.equal(await readActivePointer(f.dataDir), "active-1");
});

for (const invalid of ["baseline", "active"] as const) test(`完整安装不把非数字${invalid}资源版本当作可比较版本`, async t => {
  const f = await heldApplicationFixture(t, { version: invalid === "baseline" ? "invalid" : "2.0.0" });
  await createHeldRelease(path.join(f.dataDir, "releases", "active-1"), { releaseId: "active-1", version: invalid === "active" ? "invalid" : "1.0.0" });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime });
  await assert.rejects(app.start(), /DESKTOP_RESOURCE_VERSION_INVALID/u);
  assert.equal(f.actions.includes("start"), false);
  assert.equal(await readActivePointer(f.dataDir), "active-1");
});

test("完整安装较新基线不得降低active数据库结构", async t => {
  const f = await heldApplicationFixture(t, { version: "2.0.0", dbSchemaVersion: 88 });
  await createHeldRelease(path.join(f.dataDir, "releases", "active-1"), { releaseId: "active-1", dbSchemaVersion: 89 });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime });
  await assert.rejects(app.start(), /DESKTOP_DB_SCHEMA_DOWNGRADE_FORBIDDEN/u);
  assert.equal(f.actions.includes("start"), false);
  assert.equal(await readActivePointer(f.dataDir), "active-1");
});

test("完整安装仍服从比基线更高的持久数据库围栏", async t => {
  const f = await heldApplicationFixture(t, { version: "2.0.0", dbSchemaVersion: 89 });
  await createHeldRelease(path.join(f.dataDir, "releases", "active-1"), { releaseId: "active-1" });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  await fs.writeFile(path.join(f.dataDir, "pending-release.json"), JSON.stringify({ schemaVersion: 1,
    requestId: "a795cc4e-2c1f-4a3f-8611-31c54f0943d3", releaseId: "active-1", stagingName: "active-1", databaseSchemaVersion: 90 }), "utf8");
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: () => f.runtime });
  await assert.rejects(app.start(), /DESKTOP_DB_SCHEMA_FORWARD_ONLY/u);
  assert.equal(f.actions.includes("start"), false);
  assert.equal(await readActivePointer(f.dataDir), "active-1");
  assert.equal((await readPendingRelease(f.dataDir))?.databaseSchemaVersion, 90);
});

test("完整安装升级数据库时Client失败只中止，不自动启动旧active", async t => {
  const f = await heldApplicationFixture(t, { version: "2.0.0", dbSchemaVersion: 89 });
  await createHeldRelease(path.join(f.dataDir, "releases", "active-1"), { releaseId: "active-1" });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  const started: string[] = [];
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: (_entry, expectation) => {
      f.runtime.start = async () => { started.push(expectation!.releaseId); throw new Error("BASELINE_CLIENT_FAILED"); };
      return f.runtime;
    } });
  await assert.rejects(app.start(), /BASELINE_CLIENT_FAILED/u);
  assert.deepEqual(started, ["baseline"]);
  assert.equal(await readActivePointer(f.dataDir), "active-1");
});

test("完整安装基线失败保留旧指针，健康后清理再收口旧active的pending", async t => {
  const f = await heldApplicationFixture(t, { version: "2.0.0" });
  const activeDir = path.join(f.dataDir, "releases", "active-1");
  await createHeldRelease(activeDir, { releaseId: "active-1" });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  await fs.writeFile(path.join(f.dataDir, "pending-release.json"), JSON.stringify({ schemaVersion: 1,
    requestId: "a795cc4e-2c1f-4a3f-8611-31c54f0943d3", releaseId: "active-1", stagingName: "active-1" }), "utf8");
  let failWeb = true;
  const entries: string[] = [], receipts: string[] = [];
  f.host.loadWeb = async (_window, directory) => {
    assert.equal(directory, f.baseline);
    assert.equal(await readActivePointer(f.dataDir), "active-1");
    if (failWeb) throw new Error("BASELINE_WEB_FAILED");
  };
  const options: Parameters<typeof createDesktopApplication>[0] = { dataDir: f.dataDir, initialReleaseDir: f.baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, reportReceipt: async receipt => { receipts.push(receipt.stage); },
    createRuntime: (entry, _expectation, startup) => {
      entries.push(entry);
      f.runtime.snapshot = () => ({ status: "ready", requestId: "ready", releaseId: "baseline", errorCode: null, pid: 123,
        health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" },
        ...(startup?.mode === "held" ? { startup: { continuationId: startup.continuationId, admission: "paused" } } : {}) });
      return f.runtime;
    } };
  await assert.rejects(createDesktopApplication(options).start(), /BASELINE_WEB_FAILED/u);
  assert.equal(await readActivePointer(f.dataDir), "active-1");
  assert.ok(await readPendingRelease(f.dataDir));
  failWeb = false;
  const app = createDesktopApplication(options);
  await app.start();
  assert.equal(entries.every(entry => entry === path.join(f.baseline, "client", "dist", "index.cjs")), true);
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal(await readPendingRelease(f.dataDir), null);
  assert.equal((await app.getUpdateDetails()).bundle.result, "same");
  assert.deepEqual(receipts, []);
  await app.exit();
});

for (const mode of ["missing-baseline", "wrong-baseline", "old-baseline", "wrong-baseline-marker", "old-active", "wrong-active-marker", "wrong-active-signature"] as const) {
  test(`held artifact gate rejects ${mode} before spawning and preserves the active binding`, async t => {
    const f = await heldApplicationFixture(t, { marker: mode === "old-baseline" ? false : mode === "wrong-baseline-marker" ? { heldStartupProtocol: 2 } : undefined });
    const active = path.join(f.dataDir, "releases", "active-1");
    await createHeldRelease(active, { releaseId: "active-1", marker: mode === "old-active" ? false : mode === "wrong-active-marker" ? { clientEntrySha256: "0".repeat(64) } : undefined });
    const pointer = path.join(f.dataDir, "active-release.json"), originalPointer = JSON.stringify({ releaseId: "active-1" }); await fs.writeFile(pointer, originalPointer, "utf8");
    if (mode === "missing-baseline") await fs.rm(path.join(f.baseline, "baseline-release-manifest.json"));
    if (mode === "wrong-baseline" || mode === "wrong-active-signature") {
      const file = mode === "wrong-baseline" ? path.join(f.baseline, "baseline-release-manifest.json") : path.join(active, "manifest.json");
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, "utf8")), clientVersion: "tampered" }), "utf8");
    }
    const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime,
      startupContinuation: { continuationId: "candidate-1", async authorizeReady() { f.actions.push("authorize"); } } });
    await assert.rejects(app.start()); assert.equal(f.actions.includes("start"), false); assert.equal(f.actions.includes("authorize"), false); assert.equal(f.actions.includes("continue"), false);
    assert.equal(await fs.readFile(pointer, "utf8"), originalPointer);
  });
}

for (const hasActive of [false, true]) test(`held artifact gate passes trusted ${hasActive ? "active" : "baseline"} health expectations before startup`, async t => {
  const f = await heldApplicationFixture(t, { clientVersion: "2026.10.28.01", dbSchemaVersion: 96 }), calls: unknown[] = [];
  let expected = f.manifest;
  if (hasActive) {
    expected = await createHeldRelease(path.join(f.dataDir, "releases", "active-1"), { releaseId: "active-1", clientVersion: "2026.10.28.02", dbSchemaVersion: 97 });
    await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-1" }), "utf8");
  }
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, trustedReleaseKeys, host: f.host,
    createRuntime: (entry, expectation) => { calls.push({ entry, expectation }); f.runtime.start = async () => { assert.equal(expectation?.releaseId, expected.releaseId); assert.equal(expectation?.clientVersion, expected.clientVersion); assert.equal(expectation?.dbSchemaVersion, expected.dbSchemaVersion); assert.equal(expectation?.protocolVersion, expected.protocolVersion); f.actions.push("start"); }; return f.runtime; },
    startupContinuation: { continuationId: "candidate-1", async authorizeReady() { f.actions.push("authorize"); } } });
  await app.start(); assert.equal(f.actions.filter(action => action === "continue").length, 1); assert.equal(f.actions.indexOf("load-web") < f.actions.indexOf("authorize"), true);
  const chosen = calls.at(-1) as { entry: string }; assert.equal(chosen.entry, path.join(hasActive ? path.join(f.dataDir, "releases", "active-1") : f.baseline, "client", "dist", "index.cjs"));
  await app.exit();
});

for (const phase of ["frame", "authorize"] as const) for (const change of ["baseline-manifest", "baseline-payload", "active-manifest", "active-pointer", "active-removed", "active-added", "active-payload"] as const) {
  test(`held artifact gate detects ${change} drift during ${phase} before continuing`, async t => {
    const f = await heldApplicationFixture(t), active = path.join(f.dataDir, "releases", "active-1");
    await createHeldRelease(active, { releaseId: "active-1" }); await createHeldRelease(path.join(f.dataDir, "releases", "active-2"), { releaseId: "active-2" });
    const pointer = path.join(f.dataDir, "active-release.json"); if (change !== "active-added") await fs.writeFile(pointer, JSON.stringify({ releaseId: "active-1" }), "utf8");
    /** 修改发生在真实异步边界；签名替换与裸payload损坏分开验证。 */
    const mutate = async () => {
      if (change === "baseline-manifest") await createHeldRelease(f.baseline, { baseline: true, clientVersion: "changed" });
      else if (change === "active-manifest") await createHeldRelease(active, { releaseId: "active-1", clientVersion: "changed" });
      else if (change === "active-pointer" || change === "active-added") await fs.writeFile(pointer, JSON.stringify({ releaseId: "active-2" }), "utf8");
      else if (change === "active-removed") await fs.rm(pointer);
      else await fs.writeFile(path.join(change === "baseline-payload" ? f.baseline : active, "client", "dist", "index.cjs"), "tampered", "utf8");
    };
    f.host.loadWeb = async () => { f.actions.push("frame"); if (phase === "frame") await mutate(); };
    const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime,
      startupContinuation: { continuationId: "candidate-1", async authorizeReady() { f.actions.push("authorize"); if (phase === "authorize") await mutate(); } } });
    await assert.rejects(app.start()); assert.equal(f.actions.includes("continue"), false); assert.equal(f.actions.includes("show"), false); assert.equal(f.actions.includes("drain"), true);
    assert.equal(f.actions.includes("authorize"), phase === "authorize");
    if (change === "active-removed") await assert.rejects(fs.stat(pointer), { code: "ENOENT" });
    else assert.equal(await fs.readFile(pointer, "utf8"), JSON.stringify({ releaseId: change === "active-pointer" || change === "active-added" ? "active-2" : "active-1" }));
  });
}

test("held artifact drift retains its primary failure when original Client cleanup also fails", async t => {
  const f = await heldApplicationFixture(t), cleanupCause = new Error("cleanup failed");
  f.runtime.drain = async () => { f.actions.push("drain"); throw cleanupCause; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.baseline, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime,
    startupContinuation: { continuationId: "candidate-1", async authorizeReady() { await createHeldRelease(f.baseline, { baseline: true, clientVersion: "changed" }); } } });
  await assert.rejects(app.start(), error => {
    assert.ok(error instanceof DesktopStartupCleanupError); assert.equal(error.errors[0].message, "DESKTOP_STARTUP_ARTIFACT_CHANGED"); assert.equal(error.errors[1], cleanupCause); return true;
  });
  assert.equal(f.actions.includes("continue"), false); assert.equal(f.actions.includes("window-destroy"), false);
  f.runtime.drain = async () => { f.actions.push("drain"); }; await app.exit();
});

for (const failUpdate of [false, true]) test(`default runtime starts without asset authorization through update and rollback: ${failUpdate}`, async t => {
  const f = await fixture(t), entryDir = path.join(f.dataDir, "client", "dist"); await fs.mkdir(entryDir, { recursive: true });
  /** 临时子进程只模拟健康/API协议，实际runtime、切换和回退均用默认入口。 */
  const source = (version: string) => `const fs=require('node:fs'); const path=require('node:path'); const requestId=process.env.CODEFLOWAI_DESKTOP_REQUEST_ID;
fs.appendFileSync(path.join(process.cwd(),'observed-runtime.jsonl'),JSON.stringify({version:${JSON.stringify(version)}})+String.fromCharCode(10));
process.on('message',m=>{if(m.t==='desktop.api.req'){process.send({t:'desktop.api.res',requestId,id:m.id,response:{status:200,body:{ok:true,...(m.request.method==='runtime.update.prepare'?{hasRunningSessions:false}:{})}}});}else if(m.t==='desktop.shutdown'){process.exit(0);}});
process.send({t:'desktop.ready',requestId,health:{protocolVersion:1,clientVersion:${JSON.stringify(version)},dbSchemaVersion:94,database:'ready'}});`;
  await fs.writeFile(path.join(entryDir, "index.cjs"), source("1.0.0"), "utf8");
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, trustedReleaseKeys });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir, 94, "new-release", source(failUpdate ? "wrong" : "2.2.0"));
  if (failUpdate) await assert.rejects(app.applyRelease(directory)); else assert.equal((await app.applyRelease(directory))?.releaseId, "new-release");
  await app.exit();
  const snapshots = (await fs.readFile(path.join(f.dataDir, "observed-runtime.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(snapshots.map(snapshot => snapshot.version), failUpdate ? ["1.0.0", "wrong", "1.0.0"] : ["1.0.0", "2.2.0"]);
});

/** 使用轻量窗口和运行时替身，验证壳的清理顺序。 */
async function fixture(t: test.TestContext) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-app-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const actions: string[] = [];
  const eventListeners = new Set<(event: DesktopEvent) => void>();
  const window = Object.assign(new EventEmitter(), {
    show: () => { actions.push("show"); }, focus: () => {}, hide: () => { actions.push("hide"); },
    destroy: () => { actions.push("window-destroy"); },
  });
  const runtime: ClientRuntime = {
    start: async () => { actions.push("start"); }, waitReady: async () => { actions.push("ready"); },
    stop: async () => {}, drain: async () => { actions.push("drain"); },
    request: async (request) => {
      if (request.method === "runtime.update.prepare") return { status: 200, body: { ok: true, hasRunningSessions: false } };
      if (request.method === "runtime.update.cancel" || request.method === "runtime.update.interrupt") return { status: 200, body: { ok: true } };
      throw new Error("unexpected request");
    },
    onEvent: (listener) => { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; },
    snapshot: () => ({ status: "ready", requestId: null, releaseId: null, errorCode: null, pid: 123,
      health: { protocolVersion: 1, clientVersion: "1.0.0", dbSchemaVersion: 88, database: "ready" } }),
  };
  const host: DesktopHost = {
    createWindow: () => window,
    loadWeb: async () => { actions.push("load-web"); },
    createTray: () => ({ destroy: () => { actions.push("tray-destroy"); } }),
    registerBridge: () => () => { actions.push("unregister"); },
    quit: () => { actions.push("quit"); },
  };
  return { dataDir, actions, window, runtime, host, eventListeners };
}

test('exit drain returns a structured shutdown response and keeps the exit fence', async t => {
  const f = await fixture(t); let bridge!: DesktopBridgeApi, release!: () => void, entered!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  f.host.registerBridge = value => { bridge = value; return () => {}; };
  f.runtime.drain = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const exiting = app.exit(); await draining;
  try {
    const response = await bridge.request({ method: 'workspaces.list' });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { ok: false, code: 'APP_SHUTTING_DOWN', message: 'CodeFlow 正在退出' });
    assert.equal(f.actions.includes('quit'), false);
  } finally { release(); await exiting; }
  assert.equal(f.actions.includes('quit'), true);
});

/** 真实资源准备与shell store/INI/binding；外部进程受控，显式重启仍走原退出边界。 */
async function shellApplicationFixture(t: test.TestContext, hotUpdate = false, resourceVersion = '2.0.0', resourceWebVersion?: string) {
  const f = await fixture(t), installationDir = path.join(f.dataDir, "installation"), userDataDir = path.join(f.dataDir, "user"), sessionDataDir = path.join(f.dataDir, "session");
  for (const directory of [userDataDir, sessionDataDir]) await fs.mkdir(directory);
  for (const shell of ["old", "new", "baseline"]) { const directory = path.join(installationDir, "shells", shell); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "CodeFlowAI.exe"), "fixture"); }
  const initialReleaseDir = path.join(installationDir, "shells", "baseline", "resources"), manifest = await createHeldRelease(initialReleaseDir, { baseline: true });
  await fs.writeFile(path.join(initialReleaseDir, "release-trust.json"), "{}");
  const originalState = { activeShellId: "old", previousShellId: null, baselineShellId: "baseline" };
  await fs.writeFile(path.join(installationDir, "shell-launch.ini"), shellLaunch.serializeShellLaunchState(originalState));
  const main = { pid: 101, parentPid: 90, created: 1101, executable: path.join(installationDir, "shells", "old", "CodeFlowAI.exe"), commandLine: "main" };
  const helper = { ...main, pid: 103, parentPid: main.pid, created: 1103, commandLine: "helper" }, client = { ...main, pid: 123, parentPid: main.pid, created: 1123, commandLine: "client" };
  const health = f.runtime.snapshot().health!;
  let runtimeReleaseId: string | null = null;
  let heldId: string | undefined;
  f.runtime.snapshot = () => ({ status: "ready", requestId: "client-ready-1", releaseId: runtimeReleaseId, errorCode: null, pid: client.pid, health,
    ...(heldId ? { startup: { continuationId: heldId, admission: "paused" as const } } : {}) });
  const store = createShellUpdateAttemptStore(f.dataDir), identity = await loadOrCreateDeviceIdentity(f.dataDir), errors: unknown[] = [], serverErrors: unknown[] = [];
  const control = { available: true, hotAvailable: hotUpdate, resourceAuthorized: true, busy: false, confirm: true, fail: "", spawned: false, closed: false, drained: false, failHot: false, quitFail: false,
    shellChannelFailed: false, resourceChannelFailed: false,
    holdHealth: undefined as (() => Promise<void>) | undefined, holdDrain: undefined as (() => Promise<void>) | undefined };
  let hotManifest = manifest, archive: Buffer = Buffer.alloc(0);
  if (hotUpdate) {
    const packageDir = path.join(f.dataDir, "hot-incoming"), original = await createHeldRelease(packageDir, { releaseId: "hot-release", version: resourceVersion, webVersion: resourceWebVersion }), archiveFile = path.join(f.dataDir, "hot.tar.gz");
    await tar.c({ cwd: packageDir, file: archiveFile, gzip: true, portable: true }, ["web", "client"]);
    archive = await fs.readFile(archiveFile); const { signature: _signature, ...payload } = original;
    hotManifest = signReleaseBundleManifest({ ...payload, archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"), archiveSize: archive.length }, privateKey);
  }
  const requestPaths: string[] = [];
  const server = http.createServer((request, response) => { void (async () => {
    requestPaths.push(request.url ?? '');
    const meta = readDesktopDeviceHeaders(request.rawHeaders); response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/devices/register")) { for await (const _chunk of request) { /* 完整消费登记体。 */ } response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) })); return; }
    if (request.url?.endsWith("/archive")) { response.writeHead(200, { etag: `"${hotManifest.archiveSha256}"`, "content-length": archive.length }); response.end(archive); return; }
    if (request.url?.endsWith("/update-receipts")) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8")); response.end(JSON.stringify({ ok: true, deviceId: receipt.deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId, archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 })); return; }
    if (request.url?.endsWith("/update-failures")) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const record = JSON.parse(Buffer.concat(chunks).toString("utf8")); response.end(JSON.stringify({ ok: true, deviceId: record.deviceId, errorId: record.errorId, payloadSha256: record.payloadSha256 })); return; }
    if (request.url?.endsWith("/switch-authorization")) { response.end(JSON.stringify({ ok: true, authorized: control.resourceAuthorized, deviceId: identity.deviceId, requestId: meta.requestId, releaseId: hotManifest.releaseId,
      ...(control.resourceAuthorized ? { archiveSha256: hotManifest.archiveSha256 } : {}) })); return; }
    f.actions.push("hot-discover");
    if (control.failHot) { response.writeHead(403); response.end("{}"); return; }
    response.end(JSON.stringify(request.url?.endsWith('/update-availability')
      ? { ok: true, deviceId: identity.deviceId, requestId: meta.requestId,
        resource: control.resourceChannelFailed ? { available: false, error: { code: 'DESKTOP_UPDATE_UNAVAILABLE', requestId: meta.requestId } }
          : control.hotAvailable ? { available: true, manifest: hotManifest } : { available: false },
        shell: control.shellChannelFailed ? { available: false, error: { code: 'DESKTOP_SHELL_ARTIFACT_EXPIRED', requestId: meta.requestId } }
          : control.available ? { available: true, manifest: shellManifest } : { available: false } }
      : { ok: true, available: control.hotAvailable, ...(control.hotAvailable ? { manifest: hotManifest } : {}), deviceId: identity.deviceId, requestId: meta.requestId }));
  })().catch(error => { serverErrors.push(error); response.writeHead(500); response.end("{}"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); assert.deepEqual(serverErrors, []); });
  const shellManifest = signShellReleaseManifest({ schemaVersion: 1, protocol: 'codeflow-desktop-shell-v1', shellId: 'new', version: '1.1',
    platform: 'win32', arch: 'x64', installerSha256: 'b'.repeat(64), installerSize: 1, keyId: 'fixture',
    files: ['CodeFlowAI.exe', 'resources/app.asar', 'resources/release-trust.json'].map(path => ({ path, size: 1, sha256: 'a'.repeat(64) })),
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }, privateKey);
  const channel = Object.assign(new EventEmitter(), { pid: helper.pid, connected: true,
    /** 响应沿同一真实store接线；禁止在旧main退出前伪造候选进程。 */
    send(message: any, callback: (error: Error | null) => void) { f.actions.push(message.kind); callback(null); queueMicrotask(() => { void (async () => {
      const kind = message.kind === "arm" ? "armed" : message.kind === "accept" ? "accepted" : "exit-request";
      let revision = message.revision;
      if (message.kind === "drained") {
        const adapter = createShellUpdateAttemptNetworkAdapter(store), current = await adapter.read();
        const sent = await adapter.replace(current, { retriesUsed: current.retriesUsed, network: { actionKey: `shell-authorize:${current.revision}`, requestSha256: "1".repeat(64), status: "dispatching" } });
        const acknowledged = await adapter.replace(sent, { retriesUsed: sent.retriesUsed, network: { ...sent.network!, status: "succeeded", evidence: { kind: "shell-switch-authorization", sha256: "2".repeat(64) } } });
        revision = acknowledged.revision;
        await fs.writeFile(path.join(installationDir, "shell-launch.ini"), shellLaunch.serializeShellLaunchState((await store.read())!.candidateState));
      }
      channel.emit("message", { ...message, revision, kind, body: kind === "armed" ? { helper } : {} });
    })().catch(error => channel.emit("error", error)); }); return true; },
    disconnect() { control.closed = true; channel.connected = false; queueMicrotask(() => channel.emit("close", 1, null)); }, unref() { f.actions.push("helper-unref"); } });
  const boundary: Partial<ShellUpdateOperationBoundary> = { createNetwork: networkInput => ({
    async prepare() { f.actions.push("shell-discover"); if (control.fail === "discover") throw new Error("shell discover failed");
      let current = await store.read() as ShellUpdateAttemptV2;
      if (networkInput.discovery) {
        const cached = await networkInput.discovery(current.requestId);
        assert.equal(cached.requestId, current.requestId);
        assert.equal(cached.available, control.available);
        if (cached.available) assert.deepEqual(cached.manifest, shellManifest);
      }
      if (current.target) return { status: "target", attempt: current, manifest: shellManifest };
      const sent = await store.replace(current, { ...current, revision: current.revision + 1, network: { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" } }) as ShellUpdateAttemptV2;
      current = await store.replace(sent, { ...sent, revision: sent.revision + 1, network: { ...sent.network!, status: "succeeded", evidence: { kind: "shell-manifest", sha256: "e".repeat(64) } } }) as ShellUpdateAttemptV2;
      if (!control.available) return { status: "no-update", reason: "none", attempt: await store.replace(current, { ...current, revision: current.revision + 1, phase: "no-update" }) as ShellUpdateAttemptV2 };
      return { status: "target", manifest: shellManifest, attempt: await store.replace(current, { ...current, revision: current.revision + 1,
        target: { shellId: "new", manifestSha256: "c".repeat(64), installerSha256: "b".repeat(64), installerSize: 1 }, candidateState: { activeShellId: "new", previousShellId: "old", baselineShellId: "baseline" } }) as ShellUpdateAttemptV2 }; },
    async downloadInstaller() { return { installerPath: path.join(f.dataDir, "installer.exe"), sha256: "b".repeat(64), size: 1 }; }
  }), async install() { return { manifest: shellManifest, candidateDirectory: path.join(installationDir, "shells", "new") }; },
    /** 健康报告只列实际活动资源，准备候选不进入壳绑定。 */
    async health() { await control.holdHealth?.(); const activeReleaseId = await readActivePointer(f.dataDir);
      const check = { role: "baseline" as const, releaseId: "installation", releaseDir: initialReleaseDir, health, native: { loaded: [], credentialsAccessed: false as const, ptyCreated: false as const }, web: { files: [] }, database: { integrity: "ok" as const, schemaVersion: 88 }, childClosed: true as const }; return { schemaVersion: 1, requestId: crypto.randomUUID(), candidateShellId: "new", temporaryRoot: f.dataDir, status: "passed", phase: "completed",
      checks: [check, ...(activeReleaseId ? [{ ...check, role: "active" as const, releaseId: activeReleaseId, releaseDir: path.join(f.dataDir, "releases", activeReleaseId) }] : [])] }; },
    async snapshot() { return [main, ...(!control.drained ? [client] : []), ...(control.spawned && !control.closed ? [helper] : [])]; },
    spawnHelper() { control.spawned = true; return channel as unknown as ChildProcess; }, async stop() { channel.disconnect(); } };
  f.runtime.request = async request => { f.actions.push(request.method); if (request.method === "runtime.update.interrupt" && control.fail === "interrupt") throw new Error("interrupt failed"); return { status: 200, body: { ok: true, ...(request.method === "runtime.update.prepare" ? { hasRunningSessions: control.busy } : {}) } }; };
  f.runtime.drain = async () => { f.actions.push("drain"); await control.holdDrain?.(); if (control.fail === "drain") { control.fail = ""; throw new Error("drain failed"); } control.drained = true; };
  f.runtime.start = async () => { control.drained = false; f.actions.push("start"); };
  f.host.confirmUpdate = async () => { f.actions.push("confirm"); return control.confirm; };
  f.host.onUpdateError = error => { errors.push(error); }; f.host.onUpdateRetry = () => {};
  f.host.quit = () => { f.actions.push("quit"); if (control.quitFail) throw new Error("quit failed"); };
  f.host.relaunch = () => { f.actions.push("relaunch"); };
  const options: Parameters<typeof createDesktopApplication>[0] = { requireBaseline: true, shellVersion: "1.0", dataDir: f.dataDir, initialReleaseDir, trustedReleaseKeys, host: f.host, createRuntime: (_entry, expectation, startup) => { runtimeReleaseId = expectation?.releaseId ?? null; heldId = startup?.mode === "held" ? startup.continuationId : undefined; return f.runtime; },
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    shellUpdate: { facts: { installationDir, userDataDir, sessionDataDir, main }, boundary, timeoutMs: 10_000 } };
  let app = createDesktopApplication(options);
  await app.start(); f.actions.length = 0;
  return { ...f, get app() { return app; }, control, errors, store, manifest, boundary, requestPaths,
    /** 使用同一磁盘尝试重建 owner，模拟下一次正常启动。 */
    async restart() { await app.exit(); control.drained = false; app = createDesktopApplication(options); await app.start(); } };
}

test('revoking prepared resources does not skip an independently available shell', async t => {
  const f = await shellApplicationFixture(t, true); f.control.available = false;
  await f.app.checkForUpdates();
  f.control.resourceAuthorized = false; f.control.hotAvailable = false; f.control.available = true;
  await f.app.checkForUpdates();
  assert.equal((await f.app.getUpdateDetails()).shell.result, 'prepared');
  assert.equal(f.control.drained, false);
  await f.app.exit();
});

test('a failed shell channel remains explicit while verified resources are prepared', async t => {
  const f = await shellApplicationFixture(t, true);
  f.control.shellChannelFailed = true;
  await assert.rejects(f.app.checkForUpdates(), /DESKTOP_SHELL_OPERATION_FAILED/u);
  const details = await f.app.getUpdateDetails();
  assert.equal(details.bundle.result, 'prepared');
  assert.equal(details.bundle.target?.releaseId, 'hot-release');
  assert.equal(details.shell.result, 'failure');
  assert.ok(f.app.shellUpdateFailure);
  assert.ok(await readPendingRelease(f.dataDir));
  assert.equal(f.control.drained, false);
  await f.app.exit();
});

test('a failed resource channel remains explicit while a healthy shell is prepared', async t => {
  const f = await shellApplicationFixture(t, true);
  f.control.resourceChannelFailed = true;
  await assert.rejects(f.app.checkForUpdates(), /DESKTOP_UPDATE_UNAVAILABLE/u);
  const details = await f.app.getUpdateDetails();
  assert.equal(details.bundle.result, 'failure');
  assert.equal(details.shell.result, 'prepared');
  assert.ok(f.app.updateCheckFailure);
  assert.equal(f.control.drained, false);
  await f.app.exit();
});

test('one update check consumes a combined response for both channels without duplicate discovery', async t => {
  const f = await shellApplicationFixture(t); f.control.available = false;
  await f.app.checkForUpdates();
  assert.equal(f.requestPaths.filter(value => value.endsWith('/update-availability')).length, 1);
  assert.equal(f.requestPaths.some(value => value.endsWith('/release-availability') || value.endsWith('/shell-release-availability')), false);
  assert.equal((await f.app.getUpdateDetails()).shell.result, 'none');
  await f.app.exit();
});

for (const version of ['0.9.0', '1.0.0', '2.0.0']) test(`resource discovery compares only its numeric version: ${version}`, async t => {
  const f = await shellApplicationFixture(t, true, version); f.control.available = false;
  await f.app.checkForUpdates();
  assert.equal(f.requestPaths.filter(value => value.endsWith('/archive')).length, version === '2.0.0' ? 1 : 0);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, version === '2.0.0' ? 'prepared' : 'same');
  assert.equal(await readActivePointer(f.dataDir), null);
  await f.app.exit();
});

test('resource activation uses the bundle version even when its compatible Web version is lower', async t => {
  const f = await shellApplicationFixture(t, true, '2.0.0', '0.9.0'); f.control.available = false;
  await f.app.checkForUpdates(); await f.restart();
  assert.equal(await readActivePointer(f.dataDir), 'hot-release');
  assert.equal((await f.app.getUpdateDetails()).current.bundle?.version, '2.0.0');
  await f.app.exit();
});

for (const malformed of ['request', 'shell-extra', 'resource-type']) test(`combined discovery rejects an invalid ${malformed} envelope before downloading`, async t => {
  const f = await shellApplicationFixture(t, true), fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const response = await fetch(url, options);
    if (!String(url).endsWith('/update-availability')) return response;
    const body = await response.json();
    if (malformed === 'request') body.requestId = 'another-attempt';
    else if (malformed === 'shell-extra') body.shell.extra = true;
    else body.resource.available = 'true';
    return Response.json(body);
  });
  await assert.rejects(f.app.checkForUpdates(), { code: 'DESKTOP_UPDATE_RESPONSE_INVALID' });
  assert.equal(f.requestPaths.some(value => value.endsWith('/archive')), false);
  assert.equal(f.control.spawned, false);
  await f.app.exit();
});

test('pending remote receipt delivery cannot block a new update check', async t => {
  const f = await shellApplicationFixture(t), identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(),
    releaseId: 'old-pending', archiveSha256: 'a'.repeat(64), stage: 'received', at: '2026-11-18T00:00:00.000Z', errorCode: null, errorId: null });
  await createUpdateReceiptJournal(f.dataDir).record(receipt);
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    if (String(url).endsWith('/update-receipts')) throw new Error('REMOTE_RECEIPT_OFFLINE');
    return await fetch(url, options);
  });
  assert.equal(await f.app.checkForUpdates(), null);
  assert.equal((await f.app.getUpdateDetails()).shell.result, 'prepared');
  assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(identity.deviceId), [receipt]);
  await f.app.exit();
});

test("用户重启更新前确认运行中会话，取消后保留应用", async t => {
  const f = await shellApplicationFixture(t);
  await f.app.checkForUpdates();
  f.control.busy = true;
  f.control.confirm = false;
  await f.app.restartForUpdate();
  assert.ok(f.actions.includes("confirm"), "有运行中会话时必须先确认");
  assert.equal(f.actions.includes("quit"), false, "取消后不得退出应用");
  assert.equal(f.actions.includes("drain"), false, "取消后不得中断运行环境");
});

test("shell preparation shares the checking flight and explicit restart exits once without self waiting", async t => {
  const f = await shellApplicationFixture(t); const first = f.app.checkForUpdates(); assert.equal(f.app.checkForUpdates(), first);
  assert.equal(await first, null);
  assert.equal(f.actions.indexOf("hot-discover") < f.actions.indexOf("shell-discover"), true);
  assert.equal((await f.app.getUpdateDetails()).shell.result, "prepared");
  assert.equal(f.actions.includes("runtime.update.prepare"), false); assert.equal(f.control.spawned, false);
  assert.equal(f.actions.includes("drain"), false); assert.equal(f.actions.includes("quit"), false);
  await f.app.restartForUpdate();
  assert.equal(f.actions.filter(action => action === "drain").length, 1); assert.equal(f.actions.filter(action => action === "quit").length, 1);
  assert.equal(f.actions.at(-1), "helper-unref"); assert.equal(f.app.updateCheckFailure, null);
});

test("prepared resource defers shell discovery until its next activation", async t => {
  const f = await shellApplicationFixture(t, true); f.control.available = false;
  assert.equal(await f.app.checkForUpdates(), null);
  assert.equal(await f.store.read(), null);
  assert.equal(f.actions.includes("shell-discover"), false);
  assert.equal(await readActivePointer(f.dataDir), null);
  const details = await f.app.getUpdateDetails(); assert.equal(details.bundle.result, "prepared");
  assert.equal(details.bundle.target?.releaseId, "hot-release"); assert.notEqual(details.current.bundle?.releaseId, "hot-release");
  assert.equal(f.actions.includes("drain"), false); assert.equal(f.errors.length, 0); await f.app.exit();
});

test("resource activation releases business startup without a shell discovery or automatic restart", async t => {
  const f = await shellApplicationFixture(t, true);
  await f.app.checkForUpdates();
  await f.restart();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, "healthy");
  assert.equal(f.actions.filter(action => action === "runtime.startup.continue").length, 1);
  assert.equal(await readPendingRelease(f.dataDir), null);
  assert.equal(await f.app.resumeStartupUpdate(), false);
  assert.equal(await f.store.read(), null);
  assert.equal(f.actions.filter(action => action === "quit").length, 1);
  assert.equal(f.control.spawned, false);
  await f.app.exit();
});

test("resource update releases tasks without waiting for an absent shell update", async t => {
  const f = await shellApplicationFixture(t, true); f.control.available = false;
  await f.app.checkForUpdates();
  await f.restart();
  assert.equal(f.actions.includes("runtime.startup.continue"), true);
  assert.equal(await f.app.resumeStartupUpdate(), false);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, "healthy");
  assert.equal(f.actions.filter(action => action === "runtime.startup.continue").length, 1);
  assert.equal(await readPendingRelease(f.dataDir), null);
  assert.equal(f.control.spawned, false);
  await f.app.exit();
});

test("another cold restart preserves activated resources without reopening their pending transaction", async t => {
  const f = await shellApplicationFixture(t, true); f.control.available = false;
  await f.app.checkForUpdates(); await f.restart();
  assert.equal(await readPendingRelease(f.dataDir), null);
  await f.restart();
  assert.equal(f.actions.filter(action => action === 'runtime.startup.continue').length, 1);
  assert.equal(await f.app.resumeStartupUpdate(), false);
  assert.equal((await f.app.getUpdateDetails()).current.bundle?.releaseId, 'hot-release');
  assert.equal(await readPendingRelease(f.dataDir), null);
  await f.app.exit();
});

test("完整安装接管后较新pending失败只恢复当前基线", async t => {
  const f = await shellApplicationFixture(t, true); f.control.available = false;
  await f.app.checkForUpdates();
  const baseline = path.join(f.dataDir, "installation", "shells", "baseline", "resources");
  await createHeldRelease(baseline, { baseline: true, version: "1.5.0" });
  await createHeldRelease(path.join(f.dataDir, "releases", "old-active"), { releaseId: "old-active" });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "old-active" }), "utf8");
  const loaded: string[] = [];
  f.host.loadWeb = async (_window, directory) => {
    loaded.push(directory);
    if (directory === path.join(f.dataDir, "releases", "hot-release")) throw new Error("PENDING_WEB_FAILED");
  };
  await f.restart();
  assert.deepEqual(loaded, [baseline, path.join(f.dataDir, "releases", "hot-release"), baseline]);
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal(await readPendingRelease(f.dataDir), null);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, "restored");
  assert.equal((await f.app.getUpdateDetails()).current.bundle?.releaseId, "baseline");
  assert.ok(f.app.updateCheckFailure);
  await f.app.exit();
});

test("a historical shell no-update binding is archived before activating new resources", async t => {
  const f = await shellApplicationFixture(t, true); f.control.hotAvailable = false; f.control.available = false;
  await f.app.checkForUpdates();
  assert.equal((await f.store.read())?.binding.kind, "installation");
  f.control.hotAvailable = true;
  await f.app.checkForUpdates(); await f.restart();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, "healthy");
  assert.equal(await f.store.read(), null);
  assert.ok((await fs.readdir(f.dataDir)).some(name => name.startsWith("shell-update-retired-")));
  await f.app.resumeStartupUpdate();
  await f.app.checkForUpdates();
  const attempt = await f.store.read();
  assert.equal(attempt?.binding.kind === "active" && attempt.binding.releaseId, "hot-release");
  await f.app.exit();
});

test("shell discovery failure after resource activation remains a partial update failure", async t => {
  const f = await shellApplicationFixture(t, true);
  await f.app.checkForUpdates(); await f.restart(); f.control.fail = "discover";
  await assert.rejects(f.app.checkForUpdates());
  const details = await f.app.getUpdateDetails();
  assert.equal(details.current.bundle?.releaseId, 'hot-release');
  assert.equal(details.bundle.result, "same");
  assert.equal(details.shell.result, "failure");
  assert.ok(f.app.shellUpdateFailure);
  assert.equal(await readPendingRelease(f.dataDir), null);
  assert.equal(f.control.spawned, false);
  await f.app.exit();
});

test("resource pending cleanup failure is explicit and cannot transfer lifecycle ownership to a shell helper", async t => {
  const f = await shellApplicationFixture(t, true);
  await f.app.checkForUpdates();
  const remove = fs.rm;
  const mocked = t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === path.join(f.dataDir, "pending-release.json")) throw new Error("pending cleanup failed");
    return await remove(...args);
  });
  const outcome = await Promise.allSettled([f.restart()]);
  assert.equal(outcome.length, 1);
  assert.equal(f.control.spawned, false, "fallible resource cleanup cannot strand an accepted shell helper");
  assert.ok(f.app.updateCheckFailure);
  assert.ok(await readPendingRelease(f.dataDir));
  mocked.mock.restore();
  await f.app.exit();
});

test("a prepared shell failure leaves activated resources usable across a cold restart", async t => {
  const f = await shellApplicationFixture(t, true);
  await f.app.checkForUpdates(); await f.restart();
  f.control.holdHealth = async () => { throw new Error("candidate health interrupted"); };
  await assert.rejects(f.app.checkForUpdates());
  assert.ok((await f.store.read())?.target);
  assert.equal(await readPendingRelease(f.dataDir), null);
  f.control.holdHealth = undefined;
  await f.restart();
  assert.equal((await f.app.getUpdateDetails()).current.bundle?.releaseId, 'hot-release');
  assert.equal(await f.app.resumeStartupUpdate(), false);
  assert.equal(f.control.spawned, false);
  await f.app.checkForUpdates(); await f.app.restartForUpdate();
  assert.equal(f.control.spawned, true);
});

test("resources discovered after a prepared shell activate before that shell is rebound", async t => {
  const f = await shellApplicationFixture(t, true); f.control.hotAvailable = false;
  await f.app.checkForUpdates();
  const previous = await f.store.read(); assert.equal(previous?.target?.shellId, "new");
  f.control.hotAvailable = true; await f.app.checkForUpdates(); await f.restart();
  assert.equal(await readActivePointer(f.dataDir), "hot-release");
  assert.equal(await f.store.read(), null, "old binding must be archived before resource activation");
  assert.equal(f.actions.includes("runtime.startup.continue"), true);
  assert.equal(await f.app.resumeStartupUpdate(), false);
  await f.app.checkForUpdates(); await f.app.restartForUpdate();
  const current = await f.store.read();
  assert.notEqual(current?.requestId, previous?.requestId);
  assert.equal(current?.binding.kind === "active" && current.binding.releaseId, "hot-release");
});

test("explicit shell restart also restarts for resources first discovered by that click", async t => {
  const f = await shellApplicationFixture(t, true); f.control.hotAvailable = false;
  await f.app.checkForUpdates(); f.control.hotAvailable = true; f.actions.length = 0;
  await f.app.restartForUpdate();
  assert.equal(f.actions.filter(action => action === "quit").length, 1);
  assert.equal(f.actions.filter(action => action === "relaunch").length, 1);
  assert.equal(f.control.spawned, false, "new resources must be activated before shell handoff");
  assert.ok(await readPendingRelease(f.dataDir));
});

test("newly discovered resources still honor cancellation of an explicit shell restart", async t => {
  const f = await shellApplicationFixture(t, true); f.control.hotAvailable = false;
  await f.app.checkForUpdates(); f.control.hotAvailable = true; f.control.busy = true; f.control.confirm = false;
  await f.app.restartForUpdate();
  assert.equal(f.actions.filter(action => action === "confirm").length, 1);
  assert.equal(f.actions.includes("quit"), false); assert.equal(f.control.drained, false);
  assert.equal((await f.app.getUpdateDetails()).bundle.result, "prepared");
  await f.app.exit();
});

test("resource rollback does not continue an older prepared shell update", async t => {
  const f = await shellApplicationFixture(t, true); f.control.hotAvailable = false;
  await f.app.checkForUpdates(); f.control.hotAvailable = true; await f.app.checkForUpdates();
  const loadWeb = f.host.loadWeb;
  f.host.loadWeb = async (window, releaseDir, options) => {
    if (releaseDir.endsWith("hot-release")) throw new Error("candidate web rejected");
    await loadWeb(window, releaseDir, options);
  };
  await f.restart();
  assert.equal((await f.app.getUpdateDetails()).bundle.result, "restored");
  assert.equal(await f.app.resumeStartupUpdate(), false);
  assert.equal(f.control.spawned, false);
  assert.equal(f.actions.filter(action => action === "runtime.startup.continue").length, 1);
  await f.app.exit();
});

/** 真实耐久网络失败用于验证后续资源更新，不伪造恢复或交接成功。 */
async function failShellDiscovery(f: Awaited<ReturnType<typeof shellApplicationFixture>>): Promise<void> {
  const network = f.boundary.createNetwork!;
  f.boundary.createNetwork = () => ({
    async prepare() {
      const adapter = createShellUpdateAttemptNetworkAdapter(f.store), before = await adapter.read();
      const sent = await adapter.replace(before, { retriesUsed: 0, network: { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" } });
      await adapter.replace(sent, { retriesUsed: 0, network: { ...sent.network!, status: "failed", errorCode: "NETWORK_REFUSED" } });
      throw new Error("controlled terminal network failure");
    },
    async downloadInstaller() { assert.fail("failed discovery cannot download"); },
  });
  await assert.rejects(f.app.checkForUpdates());
  f.boundary.createNetwork = network;
}

test("a historical shell network failure cannot prevent valid resources from starting", async t => {
  const f = await shellApplicationFixture(t, true); f.control.hotAvailable = false;
  await failShellDiscovery(f); assert.equal((await f.store.read())?.phase, "failed");
  f.control.hotAvailable = true; f.control.available = false; await f.app.checkForUpdates();
  const snapshot = f.runtime.snapshot;
  f.runtime.snapshot = () => ({ ...snapshot(), ...(f.control.drained ? { status: "stopped" as const } : {}) });
  await f.restart();
  assert.equal(await readActivePointer(f.dataDir), "hot-release");
  assert.equal(await f.app.resumeStartupUpdate(), false);
  assert.equal(f.app.getRuntimeState().status, "ready");
  assert.equal((await f.app.getUpdateDetails()).shell.result, "unknown");
  await f.app.exit();
});

test("retirement I/O failure restores the stopped original Client and retains the pending update", async t => {
  const f = await shellApplicationFixture(t, true); f.control.hotAvailable = false; f.control.available = false;
  await f.app.checkForUpdates(); f.control.hotAvailable = true; await f.app.checkForUpdates();
  const snapshot = f.runtime.snapshot;
  f.runtime.snapshot = () => ({ ...snapshot(), ...(f.control.drained ? { status: "stopped" as const } : {}) });
  const rename = fs.rename;
  const failure = Object.assign(new Error("retirement archive denied"), { code: "EACCES" });
  const mocked = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).includes("shell-update-retired-")) throw failure;
    return await rename(...args);
  });
  await f.restart();
  assert.equal(f.app.getRuntimeState().status, "ready");
  assert.ok(f.app.updateCheckFailure, "recovery must preserve the explicit resource update failure");
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.ok(await readPendingRelease(f.dataDir));
  assert.ok(await f.store.read());
  mocked.mock.restore(); await f.app.exit();
});

test("normal restart starts business immediately and leaves the prepared shell for explicit update restart", async t => {
  const f = await shellApplicationFixture(t);
  let bridge!: DesktopBridgeApi;
  f.host.registerBridge = value => { bridge = value; return () => {}; };
  await f.app.checkForUpdates();
  await f.restart();
  assert.equal((await bridge.getState()).status, "ready");
  assert.equal(f.app.getRuntimeState().status, "ready");
  assert.equal(f.actions.includes("runtime.startup.continue"), false);
  assert.equal(await f.app.resumeStartupUpdate(), false);
  assert.equal(f.actions.includes("runtime.update.interrupt"), false);
  assert.equal(f.control.spawned, false);
  assert.equal(f.errors.length, 0);
});

test("shell failure stays separate from hot failure and stops the original automatic timer", async t => {
  const f = await shellApplicationFixture(t); f.control.fail = "discover";
  t.mock.timers.enable({ apis: ["setTimeout"] }); f.app.startAutomaticUpdates(); await assert.rejects(f.app.checkForUpdates());
  assert.equal(f.app.updateCheckFailure, null); assert.ok(f.app.shellUpdateFailure); assert.equal(f.errors.length, 1);
  const before = f.actions.filter(action => action === "hot-discover").length; t.mock.timers.tick(30 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.actions.filter(action => action === "hot-discover").length, before);
  await f.app.exit();
});

test("D13 application persists one final shell failure in the existing journal with its actual stage", async t => {
  const f = await shellApplicationFixture(t); f.control.fail = "discover";
  await assert.rejects(f.app.checkForUpdates());
  const identity = await loadOrCreateDeviceIdentity(f.dataDir), rows = createUpdateFailureJournal(f.dataDir).pending(identity.deviceId);
  assert.equal(rows.length, 1); const record = rows[0]!;
  assert.equal(record.errorCode, "DESKTOP_SHELL_UPDATE_FAILED");
  if (record.errorCode !== "DESKTOP_SHELL_UPDATE_FAILED") assert.fail("shell discriminator required");
  assert.equal(record.requestId, (await f.store.read())!.requestId);
  assert.equal(record.shellId, null); assert.equal(record.phase, "prepare"); assert.equal(record.recovery, "not_needed");
  assert.equal(record.rootCause.code, "DESKTOP_SHELL_OPERATION_FAILED");
  assert.equal(Object.hasOwn(record, "releaseId"), false); await f.app.exit();
});

test("D13 tray retry opens a new manual request independently of pending error delivery", async t => {
  const f = await shellApplicationFixture(t), network = f.boundary.createNetwork!;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], options?: RequestInit) => String(url).endsWith("/update-failures")
    ? Response.json({ ok: false, code: "DESKTOP_UPDATE_UNAVAILABLE" }, { status: 503 }) : await originalFetch(url, options));
  f.boundary.createNetwork = () => ({
    async prepare() {
      const adapter = createShellUpdateAttemptNetworkAdapter(f.store), before = await adapter.read();
      const sent = await adapter.replace(before, { retriesUsed: 0, network: { actionKey: "shell-discover", requestSha256: "d".repeat(64), status: "dispatching" } });
      await adapter.replace(sent, { retriesUsed: 0, network: { ...sent.network!, status: "failed", errorCode: "NETWORK_REFUSED" } });
      throw new Error("controlled terminal network failure");
    },
    async downloadInstaller() { assert.fail("failed discovery cannot download"); }
  });
  await assert.rejects(f.app.checkForUpdates()); const failed = await f.store.read(); assert.ok(failed);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir), journal = createUpdateFailureJournal(f.dataDir), failure = journal.pending(identity.deviceId)[0]!;
  assert.equal(failure.requestId, failed.requestId); f.boundary.createNetwork = network; f.control.available = false;
  assert.equal(await f.app.checkForUpdates(), null); const next = await f.store.read();
  assert.notEqual(next!.requestId, failed.requestId); assert.equal(next!.phase, "no-update"); assert.equal(next!.retriesUsed, 0);
  assert.deepEqual(journal.pending(identity.deviceId), [failure]); assert.deepEqual(journal.shellFailures(identity.deviceId, failed.requestId), [failure]);
  assert.equal(f.app.shellUpdateFailure, null); assert.equal(f.control.spawned, false); await f.app.exit();
});

test("D13 shell journal I/O failure retains the operation and logging causes and stays failed", async t => {
  const f = await shellApplicationFixture(t), primary = new Error("controlled shell failure"), io = new Error("controlled journal sync failure");
  const sync = fsSync.fsyncSync; let injected = false;
  f.boundary.createNetwork = () => ({
    async prepare() {
      t.mock.method(fsSync, "fsyncSync", (fd: number) => { if (!injected) { injected = true; throw io; } sync(fd); });
      throw primary;
    },
    async downloadInstaller() { assert.fail("failed discovery cannot download"); }
  });
  await assert.rejects(f.app.checkForUpdates(), (error: any) => {
    assert.equal(error.message, "DESKTOP_SHELL_FAILURE_RECORD_FAILED"); assert.equal(error.errors[0].cause, primary);
    assert.equal(error.errors[1], io); assert.equal(injected, true); assert.equal(f.app.shellUpdateFailure?.error, error); return true;
  });
  assert.equal(f.actions.includes("quit"), false); assert.equal(f.control.spawned, false); await f.app.exit();
});

test("hot failure prevents shell work and preserves its original failure boundary", async t => {
  const f = await shellApplicationFixture(t); f.control.failHot = true;
  await assert.rejects(f.app.checkForUpdates()); assert.ok(f.app.updateCheckFailure); assert.equal(f.app.shellUpdateFailure, null);
  assert.equal(f.actions.includes("shell-discover"), false); await f.app.exit();
});

test("shell later cancels original admission before helper creation and leaves the attempt reusable", async t => {
  const f = await shellApplicationFixture(t); f.control.busy = true; f.control.confirm = false;
  assert.equal(await f.app.checkForUpdates(), null);
  await f.app.restartForUpdate();
  assert.deepEqual(f.actions.slice(-3), ["runtime.update.prepare", "confirm", "runtime.update.cancel"]);
  assert.equal((await f.app.getUpdateDetails()).shell.result, "postponed");
  assert.equal(f.actions.includes("quit"), false); assert.equal(f.app.shellUpdateFailure, null);
  assert.equal(f.control.spawned, false); assert.equal((await f.store.read())?.schemaVersion, 5);
  await f.app.exit();
});

test("shell interrupt failure closes its helper and cancels admission without restarting the untouched Client", async t => {
  const f = await shellApplicationFixture(t); await f.app.checkForUpdates(); f.control.fail = "interrupt";
  await assert.rejects(f.app.restartForUpdate()); assert.equal(f.control.closed, true); assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.includes("runtime.update.cancel"), true); assert.equal(f.actions.includes("drain"), false);
  assert.equal(f.actions.includes("quit"), false); assert.equal(f.app.updateCheckFailure, null); assert.ok(f.app.shellUpdateFailure);
  await f.app.exit();
});

for (const rejectResume of [false, true]) test(`shell prearm failure logs before held Client cancel ${rejectResume ? "rejects" : "completes"}`, { timeout: 10_000 }, async t => {
  const f = await shellApplicationFixture(t), primary = new Error("prearm snapshot failed"), additional = new Error("cancel failed");
  await f.app.checkForUpdates();
  const snapshot = f.boundary.snapshot!, request = f.runtime.request, reports: { error: any; context: any }[] = [];
  let injected = false, enter!: () => void, release!: () => void, settled = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.boundary.snapshot = async () => { if (f.control.spawned && !injected) { injected = true; throw primary; } return await snapshot(); };
  f.host.onUpdateError = (error, context) => { reports.push({ error, context }); };
  f.runtime.request = async input => {
    if (input.method === "runtime.update.cancel") { enter(); await held; if (rejectResume) throw additional; }
    return await request(input);
  };
  const flight = f.app.restartForUpdate().then(() => { settled = true; throw new Error("EXPECTED_FAILURE"); }, error => { settled = true; return error; });
  const attemptAtGate = await (async () => {
    try {
      await entered;
      assert.equal(injected, true); assert.equal(f.control.closed, true); assert.equal(settled, false);
      assert.equal(reports.length, 1); assert.equal(reports[0].context.logOnly, true); assert.equal(reports[0].error.cause, primary);
      assert.equal(reports[0].context.requestId, reports[0].error.requestId);
      assert.equal(reports[0].context.deviceId, reports[0].error.deviceId);
      assert.equal(f.app.shellUpdateFailure, null); assert.equal(f.app.updateCheckFailure, null);
      assert.equal(f.actions.includes("quit"), false); assert.equal(f.actions.includes("arm"), false);
      return await f.store.read();
    } finally { release(); }
  })();
  const failure = await flight;
  assert.equal(reports.length, 2); assert.equal(reports[1].context.logOnly, undefined); assert.equal(reports[1].error, failure);
  assert.equal(f.app.shellUpdateFailure?.error, failure); assert.equal(failure.helperOwner, undefined);
  if (rejectResume) { assert.notEqual(failure, reports[0].error); assert.deepEqual(failure.cause.errors, [primary, additional]); }
  else assert.equal(failure, reports[0].error);
  assert.deepEqual(await f.store.read(), attemptAtGate); await f.app.exit();
});

test("shell prearm log failure retains its cause and stops Client cancel", async t => {
  const f = await shellApplicationFixture(t), primary = new Error("prearm snapshot failed"), logFailure = new Error("log write failed");
  await f.app.checkForUpdates();
  const snapshot = f.boundary.snapshot!, reports: { error: any; context: any }[] = [];
  let injected = false;
  f.boundary.snapshot = async () => { if (f.control.spawned && !injected) { injected = true; throw primary; } return await snapshot(); };
  f.host.onUpdateError = (error, context) => { reports.push({ error, context }); if ((context as any).logOnly) throw logFailure; };
  await assert.rejects(f.app.restartForUpdate(), (error: any) => {
    assert.deepEqual(error.cause.errors, [primary, logFailure]); assert.equal(f.app.shellUpdateFailure?.error, error); return true;
  });
  assert.equal(reports.length, 2); assert.equal(reports[0].context.logOnly, true);
  assert.equal(reports[1].context.logOnly, undefined); assert.equal(f.control.closed, true);
  assert.equal(f.actions.includes("runtime.update.cancel"), false); assert.equal(f.actions.includes("start"), false);
  await f.app.exit();
});

test("shell quit failure retains its failure and never pretends a destroyed UI recovered", async t => {
  const f = await shellApplicationFixture(t); await f.app.checkForUpdates(); f.control.quitFail = true;
  await assert.rejects(f.app.restartForUpdate()); assert.equal(f.control.closed, true); assert.equal(f.actions.includes("start"), false);
  assert.equal(f.app.updateCheckFailure, null); assert.ok(f.app.shellUpdateFailure); assert.equal(f.actions.includes("helper-unref"), false);
});

test("shell drain failure closes helper and restarts exactly one original Client without quitting", async t => {
  const f = await shellApplicationFixture(t); await f.app.checkForUpdates(); f.control.fail = "drain";
  await assert.rejects(f.app.restartForUpdate()); assert.equal(f.control.closed, true);
  assert.equal(f.actions.filter(action => action === "start").length, 1); assert.equal(f.actions.includes("quit"), false);
  assert.equal(f.app.updateCheckFailure, null); assert.ok(f.app.shellUpdateFailure); await f.app.exit();
});

test("external exit during shell preflight aborts the original signal without a false failure", async t => {
  const f = await shellApplicationFixture(t); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.control.holdHealth = async () => { entered(); await held; };
  const checking = f.app.checkForUpdates(); await started; const exiting = f.app.exit(); release();
  await assert.rejects(checking); await exiting;
  assert.equal(f.control.spawned, false); assert.equal(f.errors.length, 0); assert.equal(f.app.shellUpdateFailure, null); assert.equal(f.app.updateCheckFailure, null);
});

test("external exit after accepted handoff waits once and never cancels the committed transfer", { timeout: 10_000 }, async t => {
  const f = await shellApplicationFixture(t); let entered!: () => void, release!: () => void;
  await f.app.checkForUpdates();
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.control.holdDrain = async () => { entered(); await held; };
  const restarting = f.app.restartForUpdate(); await started; const exiting = f.app.exit(); release();
  await Promise.all([restarting, exiting]);
  assert.equal(f.actions.filter(action => action === "drain").length, 1); assert.equal(f.actions.filter(action => action === "quit").length, 1);
  assert.equal(f.actions.includes("runtime.update.cancel"), false); assert.equal(f.errors.length, 0);
});

test("a Web startup failure drains Client and destroys the hidden window", async (t) => {
  const f = await fixture(t);
  f.host.loadWeb = async () => { throw new Error("web failed"); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await assert.rejects(() => app.start(), /web failed/);
  assert.deepEqual(f.actions, ["start", "ready", "drain", "unregister", "tray-destroy", "window-destroy"]);
});

test("closing the window keeps Client alive, explicit exit drains before destruction", async (t) => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  let prevented = false;
  f.window.emit("close", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.actions.includes("drain"), false);
  await app.exit();
  assert.deepEqual(f.actions.slice(-5), ["drain", "unregister", "tray-destroy", "window-destroy", "quit"]);
});

for (const missing of ["directory", "manifest"] as const) test(`a trusted active resource starts without a permanently required installation baseline: ${missing}`, async t => {
  const f = await fixture(t), activeDirectory = path.join(f.dataDir, "releases", "active-independent");
  await loadOrCreateDeviceIdentity(f.dataDir);
  await createHeldRelease(activeDirectory, { releaseId: "active-independent" });
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "active-independent" }));
  if (missing === "manifest") await fs.mkdir(path.join(f.dataDir, "missing-old-baseline"));
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: path.join(f.dataDir, "missing-old-baseline"),
    requireBaseline: true, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  assert.equal(f.actions.includes("start"), true); assert.equal(f.actions.includes("load-web"), true);
  await app.exit();
});

test("start wires the local identity receipt journal and delivery for pending receipts", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateReceiptJournal(f.dataDir);
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  await journal.record(receipt);
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/api/software/desktop/devices/register") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, deviceId: body.deviceId, requestId: body.requestId, releaseId: body.releaseId,
      archiveSha256: body.archiveSha256, stage: body.stage, at: body.at, payloadSha256: body.payloadSha256 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, configuredServerOrigin: origin, createRuntime: () => f.runtime });
  await app.start();
  assert.deepEqual(await journal.pending(identity.deviceId), [receipt]);
  assert.deepEqual(requests.filter(url => url !== "/api/software/desktop/devices/register"), []);
  await app.reportReceipt(receipt);
  assert.deepEqual(await journal.pending(identity.deviceId), []);
  assert.deepEqual(requests.filter(url => url !== "/api/software/desktop/devices/register"), ["/api/software/desktop/update-receipts"]);
  assert.ok(requests.some(url => url === "/api/software/desktop/devices/register"));
  await app.exit();
});

test("a stalled remote error delivery does not hold local startup or normal exit", { timeout: 3000 }, async t => {
  const f = await fixture(t), identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateFailureJournal(f.dataDir);
  journal.record({ deviceId: identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1",
    clientVersion: "1", requestId: "held-report", releaseId: "release-2", phase: "health", recovery: "restored", error: new Error("EIO") });
  let release!: () => void, entered!: () => void, reported!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { entered = resolve; }), reporting = new Promise<void>(resolve => { reported = resolve; });
  t.mock.method(globalThis, "fetch", async () => { entered(); await gate; throw new Error("TEST_REPORT_OFFLINE"); });
  f.host.onUpdateError = (_error, context) => { assert.equal(context.logOnly, true); if (context.requestId !== "device-presence") reported(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: "https://report.invalid", createRuntime: () => f.runtime });
  let completed = false;
  const starting = app.start().then(() => { completed = true; });
  try {
    await starting;
    assert.equal(completed, true, "local startup cannot wait for remote telemetry");
    t.mock.timers.tick(1000); await sending;
    await app.exit(); assert.equal(f.actions.includes("quit"), true);
  } finally { release(); await starting; }
  await reporting;
  assert.equal(journal.pending(identity.deviceId).length, 1);
  assert.equal(app.updateFailureFailure?.requestId, 'held-report');
});

test("start flushes existing update failures once after local Web health", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateFailureJournal(f.dataDir);
  const record = journal.record({ deviceId: identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1",
    clientVersion: "1", requestId: "failure-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/api/software/desktop/devices/register") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, deviceId: body.deviceId, errorId: body.errorId, payloadSha256: body.payloadSha256 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  assert.deepEqual(requests.filter(url => url !== "/api/software/desktop/devices/register"), []);
  await app.flushFailures();
  assert.deepEqual(requests.filter(url => url !== "/api/software/desktop/devices/register"), ["/api/software/desktop/update-failures"]);
  assert.ok(requests.some(url => url === "/api/software/desktop/devices/register"));
  assert.deepEqual(journal.pending(identity.deviceId), []);
  await app.flushFailures();
  assert.deepEqual(requests.filter(url => url !== "/api/software/desktop/devices/register"), ["/api/software/desktop/update-failures"]);
  assert.equal(record.requestId, "failure-request");
  await app.exit();
});

test("startup failure delivery keeps pending evidence and exposes fixed error context", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateFailureJournal(f.dataDir);
  const record = journal.record({ deviceId: identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1",
    clientVersion: "1", requestId: "failure-request", releaseId: "release-2", phase: "health", recovery: "restored", error: new Error("EIO") });
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/software/desktop/devices/register") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    for await (const _chunk of request) { /* consume body */ }
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, code: "DESKTOP_UPDATE_UNAVAILABLE" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  await assert.rejects(app.flushFailures());
  assert.deepEqual(await journal.pending(identity.deviceId), [record]);
  assert.deepEqual(app.updateFailureFailure, { errorCode: "DESKTOP_UPDATE_UNAVAILABLE", requestId: record.requestId, deviceId: identity.deviceId });
  await app.exit();
});

test("missing Server origin leaves local startup available but failure flush explicit", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateFailureJournal(f.dataDir);
  const record = journal.record({ deviceId: identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1",
    clientVersion: "1", requestId: "failure-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  await assert.rejects(() => app.flushFailures(), /DESKTOP_UPDATE_UNAVAILABLE/);
  assert.deepEqual(app.updateFailureFailure, { errorCode: "DESKTOP_UPDATE_UNAVAILABLE", requestId: record.requestId, deviceId: identity.deviceId });
  await assert.rejects(() => app.flushFailures(), /DESKTOP_UPDATE_UNAVAILABLE/);
  assert.deepEqual(journal.pending(identity.deviceId), [record]);
  await app.exit();
});

test("failure flush owns the lifecycle until delivery finishes", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateFailureJournal(f.dataDir);
  let releaseRegister!: () => void;
  const registerHeld = new Promise<void>(resolve => { releaseRegister = resolve; });
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/software/desktop/devices/register") {
      await registerHeld;
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    for await (const _chunk of request) { /* consume body */ }
    response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, errorId: "", payloadSha256: "" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  journal.record({ deviceId: identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1",
    clientVersion: "1", requestId: "failure-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  const flushing = app.flushFailures();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => app.exit(), /DESKTOP_OPERATION_IN_PROGRESS/);
  releaseRegister();
  await assert.rejects(() => flushing);
  await app.exit();
});

test("public receipt reporting rejects while failure delivery owns the lifecycle", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const failureJournal = createUpdateFailureJournal(f.dataDir);
  let registerCount = 0;
  let releaseRegister!: () => void;
  const registerHeld = new Promise<void>(resolve => { releaseRegister = resolve; });
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/software/desktop/devices/register") {
      registerCount += 1;
      if (registerCount === 1) await registerHeld;
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.end(request.url?.endsWith("update-failures")
      ? JSON.stringify({ ok: true, errorId: body.errorId, deviceId: body.deviceId, payloadSha256: body.payloadSha256 })
      : JSON.stringify({ ok: true, deviceId: body.deviceId, requestId: body.requestId, releaseId: body.releaseId,
        archiveSha256: body.archiveSha256, stage: body.stage, at: body.at, payloadSha256: body.payloadSha256 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  failureJournal.record({ deviceId: identity.deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1",
    clientVersion: "1", requestId: "failure-request", releaseId: "release-2", phase: "prepare", recovery: "not_needed", error: new Error("EIO") });
  const flushing = app.flushFailures();
  await new Promise(resolve => setImmediate(resolve));
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(), releaseId: "release-2",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  await assert.rejects(() => app.reportReceipt(receipt), /DESKTOP_OPERATION_IN_PROGRESS/);
  releaseRegister();
  await flushing;
  await app.exit();
});

test("public receipt reporting owns the lifecycle before journal I/O yields", async t => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: (await loadOrCreateDeviceIdentity(f.dataDir)).deviceId,
    requestId: crypto.randomUUID(), releaseId: "release-1", archiveSha256: "a".repeat(64), stage: "received",
    at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  let releaseOpen!: () => void;
  const openHeld = new Promise<void>(resolve => { releaseOpen = resolve; });
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    await openHeld;
    return await originalOpen(...args);
  });
  const reporting = app.reportReceipt(receipt);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => app.exit(), /DESKTOP_OPERATION_IN_PROGRESS/);
  await assert.rejects(() => app.flushFailures(), /DESKTOP_OPERATION_IN_PROGRESS/);
  await assert.rejects(() => app.downloadReleaseBundle({ manifestBytes: new Uint8Array(), archivePath: "/api/software/desktop/releases/archive" }), /DESKTOP_OPERATION_IN_PROGRESS/);
  releaseOpen();
  await assert.rejects(() => reporting, /DESKTOP_UPDATE_UNAVAILABLE/);
  await app.exit();
});

test("explicit receipt flush owns the lifecycle until delivery finishes", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateReceiptJournal(f.dataDir);
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  await journal.record(receipt);
  let releaseRegister!: () => void;
  const registerHeld = new Promise<void>(resolve => { releaseRegister = resolve; });
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/software/desktop/devices/register") {
      await registerHeld;
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.end(JSON.stringify({ ok: true, deviceId: value.deviceId, requestId: value.requestId, releaseId: value.releaseId,
      archiveSha256: value.archiveSha256, stage: value.stage, at: value.at, payloadSha256: value.payloadSha256 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  const flushing = app.flushReceipts();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => app.exit(), /DESKTOP_OPERATION_IN_PROGRESS/);
  releaseRegister();
  await flushing;
  await app.exit();
});

test("receipt flush reports the requestId of the first failed pending receipt", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const journal = createUpdateReceiptJournal(f.dataDir);
  const first = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  const second = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "verified", at: "2026-10-24T00:00:01.000Z", errorCode: null, errorId: null });
  await journal.record(first); await journal.record(second);
  let receiptCount = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === "/api/software/desktop/devices/register") {
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    for await (const _chunk of request) { /* consume body */ }
    receiptCount += 1;
    if (receiptCount === 2) { response.writeHead(503); response.end(JSON.stringify({ ok: false, code: "DESKTOP_UPDATE_UNAVAILABLE" })); return; }
    response.end(JSON.stringify({ ok: true, deviceId: first.deviceId, requestId: first.requestId, releaseId: first.releaseId,
      archiveSha256: first.archiveSha256, stage: first.stage, at: first.at, payloadSha256: first.payloadSha256 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  await assert.rejects(() => app.flushReceipts(), /DESKTOP_UPDATE_HTTP_FAILED/);
  assert.deepEqual(app.updateReceiptFailure, { errorCode: "DESKTOP_UPDATE_UNAVAILABLE", requestId: second.requestId });
  await app.exit();
});

test("missing Server origin keeps local startup available and explicitly disables updates", async t => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  assert.equal(app.updateAvailable, false);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: identity.deviceId, requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  await assert.rejects(() => app.reportReceipt(receipt), /DESKTOP_UPDATE_UNAVAILABLE/);
  assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(identity.deviceId), [receipt]);
  assert.deepEqual(f.actions.slice(0, 3), ["start", "ready", "load-web"]);
  await app.exit();
});

test("receipt from another device is rejected before journal persistence", async t => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const receipt = createDesktopUpdateReceipt({ schemaVersion: 1, deviceId: crypto.randomUUID(), requestId: crypto.randomUUID(), releaseId: "release-1",
    archiveSha256: "a".repeat(64), stage: "received", at: "2026-10-24T00:00:00.000Z", errorCode: null, errorId: null });
  await assert.rejects(() => app.reportReceipt(receipt), /DESKTOP_UPDATE_RECEIPT_DEVICE_MISMATCH/);
  assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(identity.deviceId), []);
  await app.exit();
});

test("online updates require one requestId for the entire lifecycle", async t => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host,
    configuredServerOrigin: "http://127.0.0.1:1", trustedReleaseKeys, createRuntime: () => f.runtime });
  await app.start();
  const packageDir = await createUpdatePackage(f.dataDir);
  await assert.rejects(() => app.applyRelease(packageDir), /DESKTOP_UPDATE_REQUEST_ID_REQUIRED/);
  assert.equal(f.actions.includes("drain"), false);
  await app.exit();
});

test("download is rejected while exit owns the lifecycle", async t => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  let releaseDrain!: () => void;
  const releaseHeld = new Promise<void>(resolve => { releaseDrain = resolve; });
  f.runtime.drain = async () => { f.actions.push("drain"); await releaseHeld; };
  const exiting = app.exit();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => app.downloadReleaseBundle({ manifestBytes: new Uint8Array(), archivePath: "/api/software/desktop/releases/archive" }), /DESKTOP_OPERATION_IN_PROGRESS/);
  releaseDrain();
  await exiting;
});

test("initial Web load can request the already healthy local runtime", async (t) => {
  const f = await fixture(t);
  let bridge: DesktopBridgeApi;
  f.runtime.request = async (request) => ({ status: 200, body: { method: request.method } });
  f.host.registerBridge = (value) => { bridge = value; return () => {}; };
  f.host.loadWeb = async () => {
    assert.deepEqual(await bridge.request({ method: "workspaces.list" }), { status: 200, body: { method: "workspaces.list" } });
  };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  await app.exit();
});

for (const fails of [false, true]) {
  test(`concurrent exits share one drain and its ${fails ? "failure" : "success"}`, async t => {
    const f = await fixture(t);
    const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
    await app.start();
    let settle!: () => void;
    const held = new Promise<void>(resolve => { settle = resolve; });
    const failure = new Error("cleanup failed");
    f.runtime.drain = async () => { f.actions.push("drain"); await held; if (fails) throw failure; };
    const results = Promise.allSettled([app.exit(), app.exit(), app.exit()]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.actions.filter(action => action === "drain").length, 1);
    settle();
    for (const result of await results) {
      assert.equal(result.status, fails ? "rejected" : "fulfilled");
      if (result.status === "rejected") assert.equal(result.reason, failure);
    }
    assert.equal(f.actions.filter(action => action === "quit").length, fails ? 0 : 1);
    if (fails) {
      f.runtime.drain = async () => {};
      await app.exit();
      assert.equal(f.actions.at(-1), "quit");
    }
  });
}

test("a failed exit keeps the window and tray available for a retry", async (t) => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  f.runtime.drain = async () => { throw new Error("cleanup failed"); };
  await assert.rejects(() => app.exit(), /cleanup failed/);
  assert.equal(f.actions.includes("window-destroy"), false);
  assert.equal(f.actions.includes("quit"), false);
  f.runtime.drain = async () => { f.actions.push("drain"); };
  await app.exit();
  assert.equal(f.actions.at(-1), "quit");
});

/** 创建真实目录及临时测试签名，更新测试仍走生产整组校验入口。 */
async function createUpdatePackage(root: string, dbSchemaVersion = 88, releaseId = "new-release", clientSource = "client"): Promise<string> {
  const directory = path.join(root, "incoming");
  await fs.mkdir(path.join(directory, "web"), { recursive: true });
  await fs.mkdir(path.join(directory, "client", "dist"), { recursive: true });
  await fs.writeFile(path.join(directory, "web", "index.html"), "web", "utf8");
  await fs.writeFile(path.join(directory, "client", "dist", "index.cjs"), clientSource, "utf8");
  const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
  const webSha256 = hash(`index.html\0${hash("web")}\n`);
  const clientSha256 = hash(`dist/index.cjs\0${hash(clientSource)}\n`);
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(signReleaseBundleManifest({
    schemaVersion: 2, releaseId, version: "2.0.0", webVersion: "2.1.0", clientVersion: "2.2.0", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion,
    platform: process.platform, arch: process.arch, keyId: "fixture", archiveSha256: "f".repeat(64), archiveSize: 100,
    webSha256, clientSha256, packageSha256: hash(`client\0${clientSha256}\nweb\0${webSha256}\n`),
    files: [{ path: "client/dist/index.cjs", size: Buffer.byteLength(clientSource), sha256: hash(clientSource) }, { path: "web/index.html", size: 3, sha256: hash("web") }],
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2099-10-24T00:00:00.000Z",
  }, privateKey)), "utf8");
  return directory;
}

/** 构造三份不同资源路径，验证新壳不会替代安装基线或业务活动包。 */
async function versionedInstallation(dataDir: string) {
  const root = await fs.realpath(dataDir);
  for (const id of ["shell-new", "installation"]) {
    const directory = path.join(root, "shells", id);
    await fs.mkdir(path.join(directory, "resources", "web"), { recursive: true });
    await fs.mkdir(path.join(directory, "resources", "client", "dist"), { recursive: true });
    await fs.writeFile(path.join(directory, "CodeFlowAI.exe"), "fixture", "utf8");
    await fs.writeFile(path.join(directory, "resources", "web", "index.html"), id, "utf8");
    await fs.writeFile(path.join(directory, "resources", "client", "dist", "index.cjs"), id, "utf8");
    await fs.writeFile(path.join(directory, "resources", "release-trust.json"), "{}", "utf8");
  }
  const statePath = path.join(root, "shell-launch.ini");
  await fs.writeFile(statePath, "[shell]\r\nschema=1\r\nactive=shell-new\r\nprevious=\r\nbaseline=installation\r\n", "ascii");
  return { statePath, executable: path.join(root, "shells", "shell-new", "CodeFlowAI.exe"),
    baseline: path.join(root, "shells", "installation", "resources") };
}

for (const hasActive of [false, true]) test(`versioned shell keeps ${hasActive ? "the signed active binding" : "the original installation baseline"} on cold startup`, async t => {
  const f = await fixture(t);
  const installation = await versionedInstallation(f.dataDir);
  const pointerNames = ["active-release.json", "previous-release.json"];
  if (hasActive) {
    await loadOrCreateDeviceIdentity(f.dataDir);
    const incoming = await createUpdatePackage(f.dataDir);
    await fs.mkdir(path.join(f.dataDir, "releases"));
    await fs.rename(incoming, path.join(f.dataDir, "releases", "new-release"));
    await fs.writeFile(path.join(f.dataDir, pointerNames[0]), '{ "releaseId": "new-release" }\n', "utf8");
    await fs.writeFile(path.join(f.dataDir, pointerNames[1]), '{ "releaseId": "old-binding" }\n', "utf8");
  }
  const retainedFiles = [installation.statePath, ...(hasActive ? pointerNames.map(name => path.join(f.dataDir, name)) : [])];
  const before = await Promise.all(retainedFiles.map(file => fs.readFile(file)));
  assert.equal(typeof shellLaunch.resolveVersionedShellStartup, "function", "versioned startup must resolve its fixed baseline");
  const startup = await shellLaunch.resolveVersionedShellStartup(installation.executable);
  assert.ok(startup);
  const clientEntries: string[] = [], webDirectories: string[] = [];
  f.host.loadWeb = async (_window, releaseDir) => { webDirectories.push(releaseDir); };
  const application = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: startup.initialReleaseDir,
    trustedReleaseKeys, host: f.host, createRuntime: entry => { clientEntries.push(entry); return f.runtime; } });
  await application.start();
  const expected = hasActive ? path.join(f.dataDir, "releases", "new-release") : installation.baseline;
  assert.equal(clientEntries.at(-1), path.join(expected, "client", "dist", "index.cjs"));
  assert.deepEqual(webDirectories, [expected]);
  await application.exit();
  assert.deepEqual(await Promise.all(retainedFiles.map(file => fs.readFile(file))), before);
  if (!hasActive) for (const name of pointerNames) await assert.rejects(fs.access(path.join(f.dataDir, name)), { code: "ENOENT" });
});

test("versioned shell restores the fixed original baseline after a binding health failure", async t => {
  const f = await fixture(t);
  const installation = await versionedInstallation(f.dataDir);
  assert.equal(typeof shellLaunch.resolveVersionedShellStartup, "function", "versioned startup must resolve its fixed baseline");
  const startup = await shellLaunch.resolveVersionedShellStartup(installation.executable);
  assert.ok(startup);
  const entries: string[] = [], web: string[] = [];
  f.host.loadWeb = async (_window, releaseDir) => { web.push(releaseDir); };
  const application = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: startup.initialReleaseDir,
    trustedReleaseKeys, host: f.host, createRuntime: (entry, expected) => {
      entries.push(entry);
      return expected?.releaseId === "new-release" ? { ...f.runtime, waitReady: async () => { throw new Error("D13_BINDING_HEALTH_FAILED"); } } : f.runtime;
    } });
  await application.start();
  const before = await fs.readFile(installation.statePath);
  await assert.rejects(application.applyRelease(await createUpdatePackage(f.dataDir)), /D13_BINDING_HEALTH_FAILED/);
  assert.equal(entries.length, 3);
  assert.equal(entries[0], path.join(installation.baseline, "client", "dist", "index.cjs"));
  assert.equal(entries.at(-1), entries[0]);
  assert.deepEqual(web, [installation.baseline, installation.baseline]);
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.deepEqual(await fs.readFile(installation.statePath), before);
  await application.exit();
});

test("简化启动后的首次更新失败，回退前必须全量核验基线", async t => {
  const f = await fixture(t), baseline = path.join(f.dataDir, "installation");
  await createHeldRelease(baseline, { baseline: true });
  await fs.mkdir(path.join(baseline, "client/node_modules"));
  await fs.writeFile(path.join(baseline, "client/node_modules/extra.js"), "extra", "utf8");
  let baselineStarts = 0;
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: baseline, requireBaseline: true,
    host: f.host, trustedReleaseKeys, createRuntime: (_entry, expected) => {
      if (expected?.releaseId === "baseline") baselineStarts++;
      return expected?.releaseId === "new-release" ? { ...f.runtime, waitReady: async () => { throw new Error("CANDIDATE_FAILED"); } } : f.runtime;
    } });
  await app.start();
  await assert.rejects(app.applyRelease(await createUpdatePackage(f.dataDir)), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(cause => cause instanceof Error && /Client payload SHA-256/u.test(cause.message)));
    return true;
  });
  assert.equal(baselineStarts, 1);
  await app.exit();
});

for (const busy of [false, true]) test(`update ${busy ? "confirms and interrupts busy sessions" : "silently switches an idle Client"}`, async t => {
  const f = await fixture(t);
  f.runtime.request = async request => {
    f.actions.push(request.method);
    return { status: 200, body: { ok: true, ...(request.method === "runtime.update.prepare" ? { hasRunningSessions: busy } : {}) } };
  };
  f.host.confirmUpdate = async () => { f.actions.push("confirm"); return true; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  const result = await app.applyRelease(directory);
  assert.equal(result?.releaseId, "new-release");
  assert.deepEqual(f.actions.slice(0, busy ? 4 : 3), busy
    ? ["runtime.update.prepare", "confirm", "runtime.update.interrupt", "drain"]
    : ["runtime.update.prepare", "runtime.update.interrupt", "drain"]);
  assert.equal(f.actions.includes("confirm"), busy);
  await app.exit();
});

test("postponing an update resumes admission without interrupting or switching", async t => {
  const f = await fixture(t);
  f.runtime.request = async request => {
    f.actions.push(request.method);
    return { status: 200, body: { ok: true, hasRunningSessions: true } };
  };
  f.host.confirmUpdate = async () => false;
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  assert.equal(await app.applyRelease(directory), null);
  assert.deepEqual(f.actions, ["runtime.update.prepare", "runtime.update.cancel"]);
  assert.equal(await readActivePointer(f.dataDir), null);
  await assert.rejects(() => fs.access(path.join(f.dataDir, "errors.jsonl")), { code: "ENOENT" });
  await app.exit();
});

test("postponed update retries the same request with the original prepared receipts", async t => {
  const f = await fixture(t);
  const requestId = crypto.randomUUID();
  const receipts: Array<{ stage: string; at: string; payloadSha256: string }> = [];
  let accept = false;
  f.host.confirmUpdate = async () => accept;
  f.runtime.request = async () => ({ status: 200, body: { ok: true, hasRunningSessions: true } });
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    createRuntime: () => f.runtime, reportReceipt: async receipt => { receipts.push(receipt); } });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  assert.equal(await app.applyRelease(directory, { requestId }), null);
  assert.equal(await app.applyRelease(directory, { requestId }), null);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".staging")), []);
  accept = true;
  assert.equal((await app.applyRelease(directory, { requestId }))?.releaseId, "new-release");
  assert.deepEqual(receipts.filter(value => value.stage === "verified")[1], receipts[0]);
  assert.deepEqual(receipts.filter(value => value.stage === "prepared")[1], receipts[1]);
  await app.exit();
});

test("confirmation owns the update lifecycle while existing interaction requests remain available", async t => {
  const f = await fixture(t);
  let bridge!: DesktopBridgeApi;
  f.host.registerBridge = value => { bridge = value; return () => {}; };
  let confirm!: (accepted: boolean) => void;
  let prompting!: () => void;
  const prompted = new Promise<void>(resolve => { prompting = resolve; });
  f.host.confirmUpdate = async () => { prompting(); return await new Promise<boolean>(resolve => { confirm = resolve; }); };
  f.runtime.request = async request => ({ status: 200, body: { ok: true, hasRunningSessions: true, method: request.method } });
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  const pending = app.applyRelease(directory);
  await prompted;
  await assert.rejects(() => app.applyRelease(directory), /DESKTOP_OPERATION_IN_PROGRESS/);
  await assert.rejects(() => app.exit(), /DESKTOP_OPERATION_IN_PROGRESS/);
  assert.equal((await bridge.request({ method: "approvals.respond" })).status, 200);
  await assert.rejects(() => bridge.request({ method: "runtime.update.cancel" } as any), /DESKTOP_UPDATE_CONTROL_FORBIDDEN/);
  confirm(false);
  assert.equal(await pending, null);
  await app.exit();
});

test("failed admission recovery preserves both errors and prevents switching", async t => {
  const f = await fixture(t);
  f.runtime.request = async request => {
    if (request.method === "runtime.update.prepare") throw new Error("query-failed");
    throw new Error("resume-failed");
  };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  await assert.rejects(() => app.applyRelease(directory), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "DESKTOP_UPDATE_ADMISSION_RESUME_FAILED");
    assert.deepEqual(error.errors.map(value => value.message), ["query-failed", "resume-failed"]);
    return true;
  });
  assert.deepEqual(f.actions, []);
  assert.equal(await readActivePointer(f.dataDir), null);
  await app.exit();
});

test("cancelling while confirmation is open resumes admission without interrupting", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.runtime.request = async request => {
    f.actions.push(request.method);
    return { status: 200, body: { ok: true, hasRunningSessions: true } };
  };
  f.host.confirmUpdate = async () => { controller.abort(new Error("cancel-update")); return true; };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  await assert.rejects(() => app.applyRelease(directory, { signal: controller.signal }), /cancel-update/);
  assert.deepEqual(f.actions, ["runtime.update.prepare", "runtime.update.cancel"]);
  assert.equal(await readActivePointer(f.dataDir), null);
  await app.exit();
});

test("cancelling during interruption prevents the subsequent version switch", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.runtime.request = async request => {
    f.actions.push(request.method);
    if (request.method === "runtime.update.interrupt") controller.abort(new Error("cancel-after-interrupt"));
    return { status: 200, body: { ok: true, hasRunningSessions: false } };
  };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  await assert.rejects(() => app.applyRelease(directory, { signal: controller.signal }), /cancel-after-interrupt/);
  assert.deepEqual(f.actions, ["runtime.update.prepare", "runtime.update.interrupt", "runtime.update.cancel"]);
  assert.equal(await readActivePointer(f.dataDir), null);
  await app.exit();
});

for (const failure of ["query", "interrupt", "malformed", "missing-confirmation"]) test(`update ${failure} failure preserves the current Client and releases admission`, async t => {
  const f = await fixture(t);
  f.runtime.request = async request => {
    f.actions.push(request.method);
    if (failure === "query" && request.method === "runtime.update.prepare"
      || failure === "interrupt" && request.method === "runtime.update.interrupt") return { status: 500, body: { ok: false, code: "UPDATE_TEST_FAILED" } };
    if (failure === "malformed" && request.method === "runtime.update.prepare") return { status: 200, body: { ok: true } };
    return { status: 200, body: { ok: true, hasRunningSessions: true } };
  };
  if (failure !== "missing-confirmation") f.host.confirmUpdate = async () => true;
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const directory = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  await assert.rejects(() => app.applyRelease(directory));
  assert.equal(f.actions.includes("drain"), false);
  assert.equal(f.actions.at(-1), "runtime.update.cancel");
  assert.equal(await readActivePointer(f.dataDir), null);
  const records = (await fs.readFile(path.join(f.dataDir, "errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.at(-1).phase, "drain");
  await app.exit();
});

/** 使用真实归档与本地 HTTP，覆盖下载事实到协调器阶段的单次请求链。 */
test("download retries replay the original received fact and apply keeps the same requestId", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const packageDir = await createUpdatePackage(f.dataDir);
  const archivePath = path.join(f.dataDir, "archive.tar.gz");
  await tar.c({ cwd: packageDir, file: archivePath, gzip: true, portable: true }, ["web", "client"]);
  const archive = await fs.readFile(archivePath);
  const parsed = JSON.parse(await fs.readFile(path.join(packageDir, "manifest.json"), "utf8"));
  const { signature: _signature, ...payload } = parsed;
  const manifest = signReleaseBundleManifest({ ...payload, archiveSize: archive.length, archiveSha256: crypto.createHash("sha256").update(archive).digest("hex") }, privateKey);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const receipts: unknown[] = [];
  let downloads = 0;
  let fail = true;
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/software/desktop/releases/new-release/switch-authorization") {
      assert.equal(request.headers["x-codeflow-request-id"], requestId);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, authorized: true, deviceId: identity.deviceId, requestId,
        releaseId: manifest.releaseId, archiveSha256: manifest.archiveSha256 }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/software/desktop/release") {
      assert.equal(request.headers["x-codeflow-request-id"], requestId);
      response.setHeader("content-type", "application/json");
      response.end(manifestBytes);
      return;
    }
    if (request.method === "GET") {
      assert.equal(request.url, "/api/software/desktop/releases/new-release/archive");
      downloads += 1;
      response.writeHead(200, { etag: `"${manifest.archiveSha256}"`, "content-length": archive.length });
      response.end(archive);
      return;
    }
    if (request.url === "/api/software/desktop/devices/register") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal((await createUpdateReceiptJournal(f.dataDir).pending(identity.deviceId)).some(value => value.payloadSha256 === receipt.payloadSha256), true);
    receipts.push(receipt);
    response.setHeader("content-type", "application/json");
    if (fail) { response.writeHead(503); response.end(JSON.stringify({ ok: false, code: "DESKTOP_UPDATE_UNAVAILABLE" })); return; }
    response.end(JSON.stringify({ ok: true, deviceId: receipt.deviceId, requestId: receipt.requestId, releaseId: receipt.releaseId,
      archiveSha256: receipt.archiveSha256, stage: receipt.stage, at: receipt.at, payloadSha256: receipt.payloadSha256 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  const requestId = crypto.randomUUID();
  const options = { requestId };
  await app.downloadAvailableReleaseBundle(options);
  await assert.rejects(() => app.flushReceipts());
  const pending = await createUpdateReceiptJournal(f.dataDir).pending(identity.deviceId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.stage, "received");
  assert.deepEqual(app.updateReceiptFailure, { errorCode: "DESKTOP_UPDATE_UNAVAILABLE", requestId });
  assert.equal(await readActivePointer(f.dataDir), null);
  assert.equal(f.actions.includes("drain"), false);
  fail = false;
  const result = await app.downloadAvailableReleaseBundle(options);
  await app.flushReceipts();
  assert.equal(downloads, 1);
  assert.deepEqual(receipts, [pending[0], pending[0]]);
  await app.downloadAvailableReleaseBundle(options);
  assert.equal(downloads, 1);
  assert.equal(receipts.length, 2);
  assert.equal(app.updateReceiptFailure, null);
  await app.applyRelease(result.directory, { requestId: result.requestId });
  await app.flushReceipts();
  assert.deepEqual(receipts.slice(1).map((value: any) => value.stage), ["received", "verified", "prepared", "switched", "healthy"]);
  assert.equal(receipts.every((value: any) => value.requestId === requestId), true);
  assert.deepEqual(await createUpdateReceiptJournal(f.dataDir).pending(identity.deviceId), []);
  await app.exit();
});

test("a schema-changing update preserves the current Client and Web", async (t) => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const packageDir = await createUpdatePackage(f.dataDir, 89);
  f.actions.length = 0;
  await assert.rejects(() => app.applyRelease(packageDir), /DESKTOP_DB_SCHEMA_UPDATE_UNSUPPORTED/);
  assert.deepEqual(f.actions, []);
  assert.equal(await readActivePointer(f.dataDir), null);
  await app.exit();
});

test("Server discovery owns the lifecycle and invalid manifest failure leaves Client and disk untouched", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  let discoveryStarted!: () => void;
  const started = new Promise<void>(resolve => { discoveryStarted = resolve; });
  let finishDiscovery!: () => void;
  const finish = new Promise<void>(resolve => { finishDiscovery = resolve; });
  let archiveRequests = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/devices/register")) {
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
    } else if (request.url === "/api/software/desktop/release") {
      discoveryStarted();
      await finish;
      response.end("PRIVATE_INVALID_MANIFEST");
    } else { archiveRequests += 1; response.writeHead(500); response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  const requestId = crypto.randomUUID();
  const pending = app.downloadAvailableReleaseBundle({ requestId });
  await started;
  await assert.rejects(() => app.exit(), /DESKTOP_OPERATION_IN_PROGRESS/);
  await assert.rejects(() => app.flushReceipts(), /DESKTOP_OPERATION_IN_PROGRESS/);
  finishDiscovery();
  await assert.rejects(() => pending, error => {
    assert.equal((error as any).code, "DESKTOP_RELEASE_MANIFEST_INVALID");
    assert.equal((error as any).requestId, requestId);
    assert.equal((error as Error).message.includes("PRIVATE_"), false);
    return true;
  });
  assert.equal(archiveRequests, 0);
  assert.equal((await fs.readdir(f.dataDir)).includes(".staging"), false);
  assert.equal(f.actions.includes("drain"), false);
  const failures = createUpdateFailureJournal(f.dataDir).pending(identity.deviceId);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.requestId, requestId);
  assert.equal(failures[0]!.phase, "discovery");
  assert.equal(failures[0]!.releaseId, "unknown");
  assert.equal(failures[0]!.rootCause.code, "DESKTOP_RELEASE_MANIFEST_INVALID");
  assert.equal(JSON.stringify(failures).includes("PRIVATE_"), false);
  const originalSync = fsSync.fsyncSync;
  let syncCalls = 0;
  const failedSync = t.mock.method(fsSync, "fsyncSync", (...args: Parameters<typeof fsSync.fsyncSync>) => {
    if (++syncCalls === 1) throw Object.assign(new Error("PRIVATE_IO_WRITE_FAILURE"), { code: "EIO" });
    return originalSync(...args);
  });
  await assert.rejects(() => app.downloadAvailableReleaseBundle({ requestId }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal((error as any).requestId, requestId);
    assert.equal((error.errors[0] as any).code, "DESKTOP_RELEASE_MANIFEST_INVALID");
    assert.equal((error.errors[1] as any).code, "EIO");
    return true;
  });
  failedSync.mock.restore();
  assert.deepEqual(createUpdateFailureJournal(f.dataDir).pending(identity.deviceId), failures);
  await app.exit();
});

test("Server discovery cannot download an untrusted or expired manifest", async t => {
  for (const kind of ["untrusted", "expired"]) await t.test(kind, async subtest => {
    const f = await fixture(subtest);
    const identity = await loadOrCreateDeviceIdentity(f.dataDir);
    const directory = await createUpdatePackage(f.dataDir);
    let manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
    const { signature: _signature, ...payload } = manifest;
    if (kind === "untrusted") manifest = signReleaseBundleManifest({ ...payload, keyId: "unknown-key" }, privateKey);
    else manifest = signReleaseBundleManifest({ ...payload, expiresAt: "2026-10-24T12:00:00.000Z" }, privateKey);
    let archiveRequests = 0;
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/devices/register")) response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
      else if (request.url === "/api/software/desktop/release") response.end(JSON.stringify(manifest));
      else { archiveRequests += 1; response.writeHead(500); response.end("{}"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    subtest.after(() => server.close());
    const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
      configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
    await app.start();
    await assert.rejects(() => app.downloadAvailableReleaseBundle(), { code: kind === "untrusted" ? "DESKTOP_RELEASE_UNTRUSTED_KEY" : "DESKTOP_RELEASE_EXPIRED" });
    assert.equal(archiveRequests, 0);
    assert.equal((await fs.readdir(f.dataDir)).includes(".staging"), false);
    assert.equal(f.actions.includes("drain"), false);
    const failures = createUpdateFailureJournal(f.dataDir).pending(identity.deviceId);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.phase, "download");
    assert.equal(failures[0]!.errorCode, "DESKTOP_RELEASE_FAILED");
    assert.equal(failures[0]!.releaseId, manifest.releaseId);
    assert.equal(failures[0]!.recovery, "not_needed");
    assert.equal(failures[0]!.rootCause.code, kind === "untrusted" ? "DESKTOP_RELEASE_UNTRUSTED_KEY" : "DESKTOP_RELEASE_EXPIRED");
    await app.exit();
  });
});

test("Server discovery body interruption retains its requestId and releases the lifecycle", async t => {
  const f = await fixture(t);
  const identity = await loadOrCreateDeviceIdentity(f.dataDir);
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith("/devices/register")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, deviceId: identity.deviceId, publicKeySha256: desktopDevicePublicKeySha256(identity.publicKeyBase64) }));
    } else {
      response.writeHead(200, { "content-type": "application/json", "content-length": 1000 });
      response.write("{\"PRIVATE_PARTIAL_MANIFEST\":");
      setTimeout(() => response.destroy(), 100);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  const requestId = crypto.randomUUID();
  await assert.rejects(() => app.downloadAvailableReleaseBundle({ requestId }), error => {
    assert.equal((error as any).requestId, requestId);
    assert.equal((error as Error).message.includes("PRIVATE_"), false);
    return true;
  });
  assert.equal(f.actions.includes("drain"), false);
  await app.exit();
});

test("Server discovery rejects an invalid receipt requestId before any HTTP or disk side effect", async t => {
  const f = await fixture(t);
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    configuredServerOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, createRuntime: () => f.runtime });
  await app.start();
  await assert.rejects(() => app.downloadAvailableReleaseBundle({ requestId: "not-a-receipt-uuid" }), { code: "DESKTOP_UPDATE_RECEIPT_INVALID" });
  assert.equal(requests, 0);
  assert.equal((await fs.readdir(f.dataDir)).includes(".staging"), false);
  await app.exit();
});

test("new Client health failure restores the installation without loading the new Web", async (t) => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    createRuntime: (entry, expectedRelease) => {
      if (!expectedRelease || expectedRelease.clientVersion === "1.0.0") return f.runtime;
      assert.equal(expectedRelease.clientVersion, "2.2.0");
      const child = Object.assign(new EventEmitter(), {
        send: (_message: unknown, callback: (error: Error | null) => void) => {
          callback(null);
          queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
          return true;
        },
      });
      return createClientRuntime({ entry, dataDir: f.dataDir, expectedRelease, spawn: (_file, _args, options) => {
        queueMicrotask(() => {
          child.emit("spawn");
          child.emit("message", { t: "desktop.ready", requestId: options.env.CODEFLOWAI_DESKTOP_REQUEST_ID,
            health: { protocolVersion: 1, clientVersion: "1.9.0", dbSchemaVersion: 88, database: "ready" } });
        });
        return child;
      } });
    },
  });
  await app.start();
  const packageDir = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  await assert.rejects(() => app.applyRelease(packageDir), /CLIENT_HEALTH_VERSION_MISMATCH/);
  assert.equal(f.actions.filter((action) => action === "load-web").length, 1, "only the restored installation is loaded");
  assert.equal(await readActivePointer(f.dataDir), null);
  await app.exit();
});

test("healthy receipt failure updates failure context to the activated release", async t => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    reportReceipt: async receipt => { if (receipt.stage === "healthy") throw new Error("receipt offline"); }, createRuntime: () => f.runtime });
  await app.start();
  const firstPackage = await createUpdatePackage(f.dataDir);
  await app.applyRelease(firstPackage);
  const secondPackage = await createUpdatePackage(f.dataDir, 89, "next-release");
  await assert.rejects(() => app.applyRelease(secondPackage), /DESKTOP_DB_SCHEMA_UPDATE_UNSUPPORTED/);
  const records = (await fs.readFile(path.join(f.dataDir, "errors.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const latest = records.at(-1)!;
  assert.equal(latest.currentReleaseId, "new-release");
  assert.equal(latest.webVersion, "2.1.0");
  assert.equal(latest.clientVersion, "2.2.0");
  await app.exit();
});

test("cold startup passes the verified active manifest to Client health validation", async (t) => {
  const f = await fixture(t);
  await loadOrCreateDeviceIdentity(f.dataDir);
  const packageDir = await createUpdatePackage(f.dataDir);
  await fs.mkdir(path.join(f.dataDir, "releases"));
  await fs.rename(packageDir, path.join(f.dataDir, "releases", "new-release"));
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "new-release" }), "utf8");
  let checked = false;
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    createRuntime: (_entry, expectedRelease) => {
      if (expectedRelease) {
        assert.equal(expectedRelease.releaseId, "new-release");
        assert.equal(expectedRelease.clientVersion, "2.2.0");
        assert.equal(expectedRelease.dbSchemaVersion, 88);
        checked = true;
      }
      return f.runtime;
    },
  });
  await app.start();
  assert.equal(checked, true);
  await app.exit();
});

test("missing trust leaves installation usable but refuses updates and an existing active release", async t => {
  const f = await fixture(t);
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await app.start();
  const packageDir = await createUpdatePackage(f.dataDir);
  f.actions.length = 0;
  await assert.rejects(() => app.applyRelease(packageDir), /UNTRUSTED_KEY/);
  assert.equal(f.actions.length, 0);
  await app.exit();
  await fs.mkdir(path.join(f.dataDir, "releases"));
  await fs.rename(packageDir, path.join(f.dataDir, "releases", "new-release"));
  await fs.writeFile(path.join(f.dataDir, "active-release.json"), JSON.stringify({ releaseId: "new-release" }), "utf8");
  f.actions.length = 0;
  const restart = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await assert.rejects(() => restart.start(), /UNTRUSTED_KEY/);
  assert.equal(f.actions.includes("start"), false);
  assert.equal(f.actions.includes("load-web"), false);
});

test("a startup cleanup failure keeps an explicit owner and remains retryable", async (t) => {
  const f = await fixture(t);
  f.host.loadWeb = async () => { throw new Error("web failed"); };
  f.runtime.drain = async () => { throw new Error("cleanup failed"); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await assert.rejects(() => app.start(), DesktopStartupCleanupError);
  assert.equal(f.actions.includes("window-destroy"), false);
  f.runtime.drain = async () => { f.actions.push("drain"); };
  await app.exit();
  assert.equal(f.actions.at(-1), "quit");
});

test("a failure before Client readiness retains a tray exit action", async (t) => {
  const f = await fixture(t);
  let trayExit: (() => Promise<void>) | undefined;
  f.host.createTray = (_open, exit) => { trayExit = exit; return { destroy: () => {} }; };
  f.runtime.waitReady = async () => { throw new Error("initialization failed"); };
  f.runtime.drain = async () => { throw new Error("cleanup timed out"); };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, host: f.host, createRuntime: () => f.runtime });
  await assert.rejects(() => app.start(), DesktopStartupCleanupError);
  assert.ok(trayExit, "the user must retain a way to exit after the error dialog closes");
  f.runtime.drain = async () => {};
  await trayExit();
  assert.equal(f.actions.at(-1), "quit");
});

test("application reconnects events to the replacement runtime and clears subscriptions on exit", async (t) => {
  const f = await fixture(t);
  let bridge!: DesktopBridgeApi;
  f.host.registerBridge = (value) => { bridge = value; return () => {}; };
  const nextListeners = new Set<(event: DesktopEvent) => void>();
  const nextRuntime: ClientRuntime = { ...f.runtime,
    onEvent: (listener) => { nextListeners.add(listener); return () => { nextListeners.delete(listener); }; },
  };
  const app = createDesktopApplication({ dataDir: f.dataDir, initialReleaseDir: f.dataDir, trustedReleaseKeys, host: f.host,
    createRuntime: (_entry, expected) => expected?.clientVersion === "2.2.0" ? nextRuntime : f.runtime });
  await app.start();
  const received: DesktopEvent[] = [];
  const remove = bridge.onEvent!((event) => received.push(event));
  const event: DesktopEvent = { t: "conversation.event", event: { schema: 1, seq: 9, ts: 1000, workspaceId: "client:workspace" as any,
    threadId: "thread-1" as any, engine: "codex", type: "thread.started", payload: {} } };
  assert.equal(f.eventListeners.size, 1);
  for (const listener of f.eventListeners) listener(event);
  assert.deepEqual(received, [event]);
  await app.applyRelease(await createUpdatePackage(f.dataDir));
  assert.equal(f.eventListeners.size, 0);
  assert.equal(nextListeners.size, 1);
  for (const listener of nextListeners) listener(event);
  assert.equal(received.length, 2);
  remove();
  for (const listener of nextListeners) listener(event);
  assert.equal(received.length, 2);
  await app.exit();
  assert.equal(nextListeners.size, 0);
});
