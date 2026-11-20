import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { verifyClientMigrationRequest } from "@codeflowai/shared/client-migration-auth";
import { loadOrCreateDeviceIdentity } from "../src/deviceIdentity.js";
import { createLegacyClientMigration, resolveLegacyClientMigrationWorker, type LegacyMigrationExecutor } from "../src/legacyClientMigration.js";
import * as migrationModule from "../src/legacyClientMigration.js";

/** 隔离真实持久记录，仅替换 Worker 和网络边界。 */
async function fixture(t: test.TestContext, execute: LegacyMigrationExecutor) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-legacy-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const identity = await loadOrCreateDeviceIdentity(dataDir);
  return { dataDir, identity, workerEntry: path.join(dataDir, "worker.cjs"), execute };
}

for (const throws of [false, true]) test(`Worker停止${throws ? "抛错" : "返回false"}后仍释放迁移门禁并保留失败`, async t => {
  const f = await fixture(t, async () => { assert.fail("use the real Worker owner"); });
  const require = createRequire(import.meta.url);
  const worker = Object.assign(new EventEmitter(), {
    /** 只模拟IPC受理，不启动外部进程。 */
    send(_request: unknown, done: (error: null) => void) { done(null); },
    /** 覆盖系统拒绝停止与停止调用抛错两条失败边界。 */
    kill() { if (throws) throw new Error("WORKER_KILL_FAILED"); return false; },
  });
  const source = ts.transpileModule(readFileSync(new URL("../src/legacyClientMigration.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as typeof import("../src/legacyClientMigration.js") };
  /** 仅替换进程创建；真实迁移门禁、持久记录与失败传播均由源码执行。 */
  const load = (id: string): unknown => id === "node:child_process" ? { spawn: () => worker }
    : id.startsWith("./") ? require(`../src/${id.slice(2)}`) : require(id);
  new Function("require", "module", "exports", source)(load, module, module.exports);
  const owner = module.exports.createLegacyClientMigration({ dataDir: f.dataDir, identity: f.identity, workerEntry: f.workerEntry });
  let settled = false;
  const preparing = assert.rejects(owner.prepare(), /MIGRATION_STOPPED/u).then(() => { settled = true; });
  t.after(async () => { await owner.stop(); await preparing; });
  await assert.rejects(owner.stop(), new RegExp(throws ? "WORKER_KILL_FAILED" : "MIGRATION_WORKER_STOP_FAILED", "u"));
  worker.emit("close", 1, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, "Worker关闭后不能继续等待遗漏释放的门禁");
});

test("卸载持久取消旧账号恢复，重装保留本地数据但不再次登录", async t => {
  const f = await fixture(t, async () => ({ candidateId: "source", workspaceCount: 1, completed: true,
    accountSource: { sourceClientId: "old", apiKey: "fixture-key", serverWs: "wss://example.test/ws/client" } }));
  await fs.writeFile(path.join(f.dataDir, "config.json"), JSON.stringify({ clientId: "local_fixture" }));
  await fs.writeFile(path.join(f.dataDir, "legacy-client-migration-account.json"), JSON.stringify({ schemaVersion: 1,
    targetClientId: "local_fixture", migrationId: f.identity.deviceId, nonce: f.identity.deviceId, cancelled: false, delivered: false }));
  const cancel = (migrationModule as Record<string, unknown>).cancelLegacyMigrationAccountForUninstall;
  assert.equal(typeof cancel, "function");
  (cancel as (dataDir: string) => void)(f.dataDir);
  let attempts = 0;
  const owner = createLegacyClientMigration({ ...f, restoreAccount: async () => { attempts++; throw new Error("unexpected account restore"); } });
  await owner.prepare(); await owner.runtimeReady();
  assert.equal(owner.snapshot().status, "ready"); assert.equal(owner.snapshot().account.status, "cancelled");
  assert.equal(attempts, 0);
});

test("卸载取消记录写入失败显式失败并保留原选择", async t => {
  const f = await fixture(t, async () => ({ candidateId: null, workspaceCount: 0 }));
  const file = path.join(f.dataDir, "legacy-client-migration-account.json");
  const before = JSON.stringify({ schemaVersion: 1, targetClientId: "local_fixture", migrationId: f.identity.deviceId,
    nonce: f.identity.deviceId, cancelled: false, delivered: false });
  await fs.writeFile(file, before);
  const nativeFs = await import("node:fs"), failure = new Error("controlled account rename failure");
  t.mock.method(nativeFs.default, "renameSync", () => { throw failure; });
  const cancel = (migrationModule as Record<string, unknown>).cancelLegacyMigrationAccountForUninstall as (dataDir: string) => void;
  assert.throws(() => cancel(f.dataDir), error => error === failure);
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal((await fs.readdir(f.dataDir)).some(name => name.endsWith(".tmp")), false);
});

test("Windows卸载取消迁移账号沿系统路径大小写规则", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, async () => ({ candidateId: null, workspaceCount: 0 }));
  await fs.writeFile(path.join(f.dataDir, "legacy-client-migration-journal.json"), "{}");
  migrationModule.cancelLegacyMigrationAccountForUninstall(f.dataDir.toUpperCase());
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, "legacy-client-migration-account.json"), "utf8")).cancelled, true);
});

for (const name of ["legacy-client-migration-account.json", "legacy-client-migration-journal.json"])
test(`卸载读取${name}权限失败不得当作没有迁移记录`, async t => {
  const f = await fixture(t, async () => ({ candidateId: null, workspaceCount: 0 }));
  const nativeFs = await import("node:fs"), original = nativeFs.default.lstatSync;
  const failure = Object.assign(new Error("controlled migration record access failure"), { code: "EACCES" });
  t.mock.method(nativeFs.default, "lstatSync", (...args: Parameters<typeof original>) => {
    if (args[0] === path.join(f.dataDir, name)) throw failure;
    return original(...args);
  });
  assert.throws(() => migrationModule.cancelLegacyMigrationAccountForUninstall(f.dataDir), error => error === failure);
  assert.equal((await fs.readdir(f.dataDir)).includes("legacy-client-migration-account.json"), false);
});

test("旧整组包未声明迁移能力时保持可启动，已有迁移记录不得绕过", async t => {
  const f = await fixture(t, async () => ({ candidateId: null, workspaceCount: 0 }));
  assert.equal(resolveLegacyClientMigrationWorker(path.join(f.dataDir, "release"), f.dataDir), null);
  await fs.writeFile(path.join(f.dataDir, "legacy-client-migration-journal.json"), "{}", "utf8");
  assert.throws(() => resolveLegacyClientMigrationWorker(path.join(f.dataDir, "release"), f.dataDir), /MIGRATION_RELEASE_UNSUPPORTED/u);
});

test("只读发现等待明确选择，稍后不会执行迁移", async t => {
  const calls: string[] = [];
  const f = await fixture(t, async request => {
    calls.push(request.action);
    return { candidateId: "source-1", workspaceCount: 2 };
  });
  const migration = createLegacyClientMigration(f);
  let released = false;
  const waiting = migration.prepare().then(() => { released = true; });
  await migration.whenDiscovered();
  assert.equal(migration.snapshot().status, "available");
  assert.equal(released, false);
  assert.deepEqual(calls, ["discover"]);
  await migration.defer();
  await waiting;
  assert.deepEqual(calls, ["discover"]);
});

test("旧账号Server不可达时自动保留旧文件并放行新桌面，不恢复账号且下次重新检测", async t => {
  const calls: string[] = [];
  const f = await fixture(t, async request => {
    calls.push(request.action);
    throw Object.assign(new Error("source server unavailable"), { code: "SOURCE_ACCOUNT_UNRESOLVED" });
  });
  const oldDirectory = path.join(f.dataDir, "legacy-fixture");
  await fs.mkdir(oldDirectory);
  const oldConfig = Buffer.from(JSON.stringify({ serverWs: "ws://127.0.0.1:39280/ws/client", apiKey: "fixture-only" }));
  const oldDatabase = Buffer.from("fixture old database remains untouched");
  await fs.writeFile(path.join(oldDirectory, "config.json"), oldConfig);
  await fs.writeFile(path.join(oldDirectory, "codeflowai.db"), oldDatabase);
  let restores = 0;
  const owner = createLegacyClientMigration({ ...f, restoreAccount: async () => { restores++; throw new Error("unexpected restore"); } });
  let released = false;
  const waiting = owner.prepare().then(() => { released = true; });
  await owner.whenDiscovered();
  t.after(async () => { await owner.stop(); await waiting; });
  assert.equal(owner.snapshot().status, "running");
  assert.equal(owner.snapshot().canDefer, false);
  assert.equal(owner.snapshot().message, "旧 Client 所属 Server 暂不可用，旧数据已保留；未迁移旧数据，新桌面将继续启动。");
  await waiting; assert.equal(released, true);
  await owner.runtimeReady();
  assert.equal(owner.snapshot().status, "ready");
  assert.equal(owner.snapshot().errorCode, "SOURCE_ACCOUNT_UNRESOLVED");
  assert.ok(owner.snapshot().message);
  assert.equal(await owner.takeAccount(), null);
  assert.equal(restores, 0);
  assert.deepEqual(calls, ["discover"]);
  assert.deepEqual(await fs.readFile(path.join(oldDirectory, "config.json")), oldConfig);
  assert.deepEqual(await fs.readFile(path.join(oldDirectory, "codeflowai.db")), oldDatabase);
  for (const name of ["legacy-client-migration-account.json", "legacy-client-migration-journal.json"])
    await assert.rejects(fs.stat(path.join(f.dataDir, name)), { code: "ENOENT" });
  await assert.rejects(owner.defer(), /MIGRATION_DECISION_INVALID/u);
  const reopened = createLegacyClientMigration(f);
  const next = reopened.prepare();
  await reopened.whenDiscovered();
  assert.equal(reopened.snapshot().status, "running");
  assert.ok(reopened.snapshot().message);
  await next; await reopened.runtimeReady();
  assert.deepEqual(calls, ["discover", "discover"]);
  await reopened.stop();
});

test("检测成功选择稍后也不恢复旧账号或交付旧登录", async t => {
  let restores = 0;
  const f = await fixture(t, async () => ({ candidateId: "source-1", workspaceCount: 1,
    accountSource: { sourceClientId: "old", apiKey: "fixture-only", serverWs: "ws://old.test/ws/client" } }));
  const owner = createLegacyClientMigration({ ...f, restoreAccount: async () => { restores++; throw new Error("unexpected restore"); } });
  const waiting = owner.prepare(); await owner.whenDiscovered();
  await owner.defer(); await waiting; await owner.runtimeReady();
  assert.equal(restores, 0);
  assert.equal(await owner.takeAccount(), null);
  assert.equal(owner.snapshot().account.status, "not_requested");
  assert.equal(owner.snapshot().candidateId, null);
  assert.equal(owner.snapshot().workspaceCount, 0);
});

for (const scenario of ["unsafe", "journal", "bound", "stage"] as const) {
  test(`检测失败暂缓门禁拒绝 ${scenario}`, async t => {
    const f = await fixture(t, async (_request, progress) => {
      if (scenario === "stage") progress({ stage: "snapshot", completed: 0, total: 1 });
      throw Object.assign(new Error("fixture failure"), { code: scenario === "unsafe" ? "SOURCE_PATH_UNSAFE" : "SOURCE_ACCOUNT_UNRESOLVED" });
    });
    if (scenario === "journal") await fs.writeFile(path.join(f.dataDir, "legacy-client-migration-journal.json"), "{}");
    if (scenario === "bound") await fs.writeFile(path.join(f.dataDir, "legacy-client-migration-account.json"), JSON.stringify({
      schemaVersion: 1, targetClientId: "local_fixture", migrationId: f.identity.deviceId, nonce: f.identity.deviceId, cancelled: false, delivered: false }));
    const owner = createLegacyClientMigration(f);
    const waiting = assert.rejects(owner.prepare(), /MIGRATION_STOPPED/u);
    await owner.whenDiscovered();
    assert.equal(owner.snapshot().canDefer, false);
    await assert.rejects(owner.defer(), /MIGRATION_DECISION_INVALID/u);
    await owner.stop(); await waiting;
  });
}

test("暂缓执行前重新检查磁盘迁移记录，拒绝检测后出现的日志", async t => {
  const f = await fixture(t, async () => ({ candidateId: "source-1", workspaceCount: 1 }));
  const owner = createLegacyClientMigration(f), waiting = owner.prepare();
  await owner.whenDiscovered();
  assert.equal(owner.snapshot().status, "available");
  assert.equal(owner.snapshot().canDefer, true);
  await fs.writeFile(path.join(f.dataDir, "legacy-client-migration-journal.json"), "{}");
  assert.equal(owner.snapshot().canDefer, false);
  await assert.rejects(owner.defer(), /MIGRATION_DECISION_INVALID/u);
  await owner.stop(); await assert.rejects(waiting, /MIGRATION_STOPPED/u);
});

test("最终复核：迁移未绑定的历史取消记录沿正常Client配置身份恢复", async t => {
  const ids: string[] = [];
  const f = await fixture(t, async request => {
    ids.push(request.targetClientId);
    return { candidateId: "source-1", workspaceCount: 1 };
  });
  const owner = createLegacyClientMigration(f), waiting = owner.prepare();
  await owner.whenDiscovered(); await owner.defer(); await waiting;
  await owner.cancelAccount(); await owner.stop();
  await fs.writeFile(path.join(f.dataDir, "config.json"), JSON.stringify({ clientId: "local_normal_client" }), "utf8");
  const restored = createLegacyClientMigration(f), next = restored.prepare();
  await restored.whenDiscovered();
  assert.equal(ids[1], "local_normal_client");
  assert.notEqual(ids[0], ids[1]);
  assert.equal(restored.snapshot().account.status, "cancelled");
  await restored.defer(); await next; await restored.stop();
});

test("最终复核：迁移已开始后，即使配置身份变化也不得重新绑定", async t => {
  const ids: string[] = [];
  const f = await fixture(t, async request => {
    ids.push(request.targetClientId);
    if (request.action === "migrate") throw new Error("fixture migration interrupted");
    return { candidateId: "source-1", workspaceCount: 1 };
  });
  const owner = createLegacyClientMigration(f);
  const waiting = assert.rejects(owner.prepare(), /MIGRATION_STOPPED/u);
  await owner.whenDiscovered();
  await assert.rejects(owner.start("source-1"), /fixture migration interrupted/u);
  await owner.stop(); await waiting;
  await fs.writeFile(path.join(f.dataDir, "config.json"), JSON.stringify({ clientId: "different_client" }), "utf8");
  const restored = createLegacyClientMigration(f);
  const next = assert.rejects(restored.prepare(), /MIGRATION_STOPPED/u);
  await restored.whenDiscovered();
  assert.equal(ids[2], ids[0]);
  assert.notEqual(ids[2], "different_client");
  await restored.stop(); await next;
});

test("重复点击复用同一迁移，数据完成前不放行，登录失败明确开放本地", async t => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const calls: string[] = [];
  const f = await fixture(t, async (request, progress) => {
    calls.push(request.action);
    if (request.action === "discover") return { candidateId: "source-1", workspaceCount: 2 };
    progress({ stage: "snapshot", completed: 1, total: 2 });
    await gate;
    return { candidateId: "source-1", workspaceCount: 2, migrationId: request.migrationId!, completed: true,
      accountSource: { sourceClientId: "old-client", apiKey: "fixture-key", serverWs: "wss://example.test/ws/client" } };
  });
  const migration = createLegacyClientMigration({ ...f, restoreAccount: async () => { throw Object.assign(new Error("offline"), { code: "MIGRATION_ACCOUNT_OFFLINE" }); } });
  const waiting = migration.prepare();
  await migration.whenDiscovered();
  const first = migration.start("source-1"), second = migration.start("source-1");
  assert.equal(migration.snapshot().status, "running");
  await assert.rejects(migration.defer(), /MIGRATION_DECISION_INVALID/u);
  finish();
  await Promise.all([first, second, waiting]);
  assert.equal(calls.filter(action => action === "migrate").length, 1);
  assert.equal(migration.snapshot().status, "running");
  await migration.runtimeReady();
  assert.equal(migration.snapshot().status, "ready");
  assert.equal(migration.snapshot().account.status, "failed");
  assert.equal(migration.snapshot().account.errorCode, "MIGRATION_ACCOUNT_OFFLINE");
  assert.match(await fs.readFile(path.join(f.dataDir, "logs", "legacy-client-migration.jsonl"), "utf8"), /MIGRATION_ACCOUNT_OFFLINE/u);
  assert.doesNotMatch(await fs.readFile(path.join(f.dataDir, "legacy-client-migration-account.json"), "utf8"), /fixture-key/u);
});

test("迁移失败保留屏障，错误状态可见，同任务重试不生成新身份", async t => {
  let runs = 0;
  const ids: string[] = [];
  const f = await fixture(t, async request => {
    if (request.action === "discover") return { candidateId: "source-1", workspaceCount: 1 };
    ids.push(request.migrationId!);
    if (++runs === 1) throw Object.assign(new Error("disk full"), { code: "MIGRATION_DISK_FULL" });
    return { candidateId: "source-1", workspaceCount: 1, migrationId: request.migrationId!, completed: true };
  });
  const migration = createLegacyClientMigration(f);
  let released = false;
  const waiting = migration.prepare().then(() => { released = true; });
  await migration.whenDiscovered();
  await assert.rejects(migration.start("source-1"), /disk full/u);
  assert.equal(released, false);
  assert.equal(migration.snapshot().status, "failed");
  await assert.rejects(migration.start("another-source"), /MIGRATION_CANDIDATE_CHANGED/u);
  await migration.start("source-1");
  await waiting;
  assert.equal(ids[0], ids[1]);
});

test("主动退出账号后，即使重启也不再自动恢复旧账号", async t => {
  let attempts = 0;
  let migrated = false;
  const f = await fixture(t, async request => request.action === "discover"
    ? { candidateId: "source-1", workspaceCount: 1, completed: migrated }
    : (migrated = true, { candidateId: "source-1", workspaceCount: 1, migrationId: request.migrationId!, completed: true,
      accountSource: { sourceClientId: "old", apiKey: "fixture-key", serverWs: "wss://example.test/ws/client" } }));
  const restoreAccount = async (): Promise<never> => { attempts++; throw new Error("offline"); };
  const migration = createLegacyClientMigration({ ...f, restoreAccount });
  const waiting = migration.prepare();
  await migration.whenDiscovered();
  await migration.start("source-1");
  await waiting;
  await migration.runtimeReady();
  await migration.cancelAccount();
  await assert.rejects(migration.retryAccount(), /MIGRATION_ACCOUNT_CANCELLED/u);
  assert.equal(attempts, 1);
  const restored = createLegacyClientMigration({ ...f, restoreAccount });
  const next = restored.prepare();
  await restored.whenDiscovered();
  await next;
  await restored.runtimeReady();
  assert.equal(attempts, 1);
});

test("账号恢复向原Server登记安装并发送绑定Key的签名，重试只轮换账号", async t => {
  const requests: Array<{ path: string; body: Record<string, unknown>; authorization?: string }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/software/desktop/devices/register") {
      const { desktopDevicePublicKeySha256 } = await import("@codeflowai/shared/desktop-device-auth");
      res.end(JSON.stringify({ ok: true, deviceId: body.deviceId, publicKeySha256: desktopDevicePublicKeySha256(body.publicKeyBase64) }));
    } else if (requests.filter(request => request.path === req.url).length === 1) {
      res.writeHead(503); res.end(JSON.stringify({ ok: false, code: "CLIENT_MIGRATION_UNAVAILABLE" }));
    } else res.end(JSON.stringify({ ok: true, sessionToken: "sess_real_fixture", sessionExpiresAt: Date.now() + 60_000,
      userSummary: { userId: "account-1" }, accountRole: "personal", accessContext: {} }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let imports = 0;
  const f = await fixture(t, async request => request.action === "discover" ? { candidateId: "source-1", workspaceCount: 1 }
    : (imports++, { candidateId: "source-1", workspaceCount: 1, migrationId: request.migrationId!, completed: true,
      accountSource: { sourceClientId: "old", apiKey: "fixture-key", serverWs: origin.replace("http:", "ws:") + "/ws/client" } }));
  const migration = createLegacyClientMigration(f);
  const waiting = migration.prepare(); await migration.whenDiscovered(); await migration.start("source-1"); await waiting;
  await migration.runtimeReady();
  assert.equal(migration.snapshot().account.status, "failed");
  await migration.retryAccount();
  assert.equal(imports, 1);
  assert.equal(migration.snapshot().account.status, "restored");
  const auth = requests.filter(request => request.path === "/api/account/auth/client-migration");
  assert.equal(auth.length, 2);
  for (const request of auth) {
    assert.equal(request.authorization, "Bearer fixture-key");
    assert.equal(request.body.apiKey, undefined);
    verifyClientMigrationRequest(request.body, "fixture-key", Date.now());
  }
  assert.equal(auth[0]!.body.nonce, auth[1]!.body.nonce);
  assert.equal(auth[0]!.body.migrationId, auth[1]!.body.migrationId);
  const restored = await migration.takeAccount();
  assert.equal(restored?.serverOrigin, origin);
  assert.equal(restored?.session.sessionToken, "sess_real_fixture");
  assert.equal((await migration.takeAccount())?.session.sessionToken, "sess_real_fixture", "lost bridge response can be fetched again before store ACK");
  await migration.acknowledgeAccount();
  assert.equal(await migration.takeAccount(), null);
});

test("本地完成但来源认证离线时，账号重试只读已完成记录而不重新导入", async t => {
  const calls: string[] = [];
  let migrationId: string | undefined;
  const f = await fixture(t, async request => {
    calls.push(request.action);
    if (request.action === "migrate") { migrationId = request.migrationId; return { candidateId: "source", workspaceCount: 1, completed: true, migrationId }; }
    return migrationId ? { candidateId: "source", workspaceCount: 1, completed: true, migrationId,
      accountSource: { sourceClientId: "old", serverWs: "wss://source.test", apiKey: "fixture" } } : { candidateId: "source", workspaceCount: 1 };
  });
  const migration = createLegacyClientMigration({ ...f, restoreAccount: async () => ({ serverOrigin: "https://source.test", session: { sessionToken: "sess_fixture" } as never }) });
  const waiting = migration.prepare(); await migration.whenDiscovered(); await migration.start("source"); await waiting;
  await migration.runtimeReady();
  assert.equal(migration.snapshot().account.errorCode, "MIGRATION_ACCOUNT_SOURCE_MISSING");
  await migration.retryAccount();
  assert.equal(migration.snapshot().account.status, "restored");
  assert.deepEqual(calls, ["discover", "migrate", "discover"]);
});
