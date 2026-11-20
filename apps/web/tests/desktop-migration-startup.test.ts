import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { computed, createApp, nextTick, reactive, ref, watch } from "vue";
import { createPinia } from "pinia";
import persistedstate from "pinia-plugin-persistedstate";
import type { AccountLoginResponseBody, DesktopMigrationState } from "@codeflowai/shared";
import { useConfigStore } from "../src/store/config.ts";
import { desktopAuthModalOpen } from "../src/features/account/desktopAuthPromptState.ts";
import { createLegacyClientMigration } from "../../desktop/src/legacyClientMigration.ts";

/** 使用完整账号身份，避免迁移夹具绕过真实会话的数据合同。 */
function accountUser(userId: string): AccountLoginResponseBody["userSummary"] {
  return { userId, email: `${userId}@example.test`, fullName: userId, phone: "", avatarUrl: null,
    accountRole: "personal_normal", status: "active", enterpriseId: null, enterpriseName: null };
}

/** 执行真实组件脚本，只替换宿主传输和store边界以控制迟到会话。 */
function setup(status: "restored" | "cancelled" | "failed", realConfig?: ReturnType<typeof useConfigStore>, migration?: ReturnType<typeof createLegacyClientMigration>, startupLabel = "") {
  const source = fs.readFileSync(new URL("../src/features/desktop/components/desktop-migration-startup.vue", import.meta.url), "utf8");
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const state: DesktopMigrationState = migration?.snapshot() ?? { status: "ready", migrationId: "migration-1", candidateId: "source-1", workspaceCount: 1,
    stage: "completed", completed: 1, total: 1, errorCode: null, message: null, account: { status, errorCode: null, message: null } };
  let mounted!: () => Promise<void>;
  let listener!: (value: DesktopMigrationState) => void;
  let resolveTake!: (value: unknown) => void;
  let taking!: () => void;
  const takeStarted = new Promise<void>(resolve => { taking = resolve; });
  const take = new Promise(resolve => { resolveTake = resolve; });
  let acknowledgements = 0, ready = 0, takes = 0;
  const config = realConfig ?? reactive({ serverWsOrigin: "wss://source.test", sessionToken: "initial", userSummary: accountUser("initial-user"), logoutInProgress: false,
    isAccountSession: true, hasActiveSession: true,
    localRuntimeReady: true,
    setAccountSession(session: AccountLoginResponseBody) { this.sessionToken = session.sessionToken; this.userSummary = session.userSummary; },
    persistAccountSession() {}, async refreshDesktopRuntime() {}, async syncDesktopCloudAccount() {} });
  const bridge = { getMigrationState: async () => migration?.snapshot() ?? state, retryMigrationAccount: async () => { await migration?.retryAccount(); },
    onMigrationState(fn: typeof listener) { listener = fn; return migration?.subscribe(fn) ?? (() => {}); },
    takeMigrationAccount: () => { takes++; taking(); return migration ? migration.takeAccount() : take; },
    async acknowledgeMigrationAccount() { await migration?.acknowledgeAccount(); acknowledgements++; } };
  const code = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exposed = {} as { error: () => string | null; showNotice: () => boolean; deferredNotice: () => string | null; openLogin: () => void; dismiss: () => void; label: () => string };
  const errors: unknown[] = [];
  vm.runInNewContext(code + '\nexports.error = () => actionError.value; exports.showNotice = () => showAccountNotice.value; exports.deferredNotice = () => deferredMigrationNotice.value; exports.openLogin = openAccountLogin; exports.dismiss = dismissAccountNotice; exports.label = () => stageLabel.value;', { exports: exposed, URL,
    console: { error: (...args: unknown[]) => { errors.push(args); } },
    defineEmits: () => (event: string) => { if (event === "ready") ready++; },
    defineProps: () => ({ startupLabel }),
    require: (id: string) => {
      if (id === "vue") return { computed, ref, watch, inject: () => ref(true), onMounted(fn: typeof mounted) { mounted = fn; }, onBeforeUnmount() {}, onScopeDispose() {} };
      if (id.endsWith("services/desktop")) return { getDesktopBridge: () => bridge };
      if (id.endsWith("store/config")) return { useConfigStore: () => config };
      if (id.endsWith("desktopAuthPromptState")) return { desktopAuthModalOpen };
      if (id === "ant-design-vue") return {};
      throw new Error(`unexpected component dependency: ${id}`);
    } });
  return { config, state, takeStarted, run: () => mounted(), send: (value: DesktopMigrationState) => listener(value), resolveTake,
    error: exposed.error, showNotice: exposed.showNotice, deferredNotice: exposed.deferredNotice,
    openLogin: exposed.openLogin, dismiss: exposed.dismiss, label: exposed.label, errors, counts: () => ({ acknowledgements, ready, takes }) };
}

test("可见启动层显示工作台的真实升级阶段，不被迁移完成态隐藏", async () => {
  const f = setup("cancelled", undefined, undefined, "正在切换新版本");
  await f.run();
  assert.equal(f.label(), "正在切换新版本");
});

test("旧Server不可达自动放行后，工作台就绪时提示旧数据已保留", async () => {
  const state: DesktopMigrationState = { status: "ready", migrationId: null, candidateId: null, workspaceCount: 0,
    stage: "completed", completed: 0, total: null, errorCode: "SOURCE_ACCOUNT_UNRESOLVED",
    message: "旧 Client 所属 Server 暂不可用，旧数据已保留；未迁移旧数据，新桌面将继续启动。",
    account: { status: "not_requested", errorCode: null, message: null } };
  const f = setup("cancelled", undefined, { snapshot: () => state, subscribe: () => () => {} } as unknown as ReturnType<typeof createLegacyClientMigration>);
  await f.run();
  assert.equal(f.counts().ready, 1);
  assert.equal(f.deferredNotice(), state.message);
  assert.equal(f.showNotice(), true);
});

test("旧 Server 不可达时自动保留旧数据并进入新桌面，工作台就绪后显示提示", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-offline-skip-"));
  const migration = createLegacyClientMigration({ dataDir, workerEntry: "unused",
    identity: { deviceId: "22222222-2222-4222-8222-222222222222", createdAt: new Date().toISOString(), publicKeyBase64: "fixture" },
    execute: async () => { throw Object.assign(new Error("source Server unavailable"), { code: "SOURCE_ACCOUNT_UNRESOLVED" }); } });
  t.after(async () => { await migration.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const preparing = migration.prepare();
  await migration.whenDiscovered();
  await preparing;
  assert.equal(migration.snapshot().status, "running");
  await migration.runtimeReady();
  assert.equal(migration.snapshot().status, "ready");

  const f = setup("cancelled", undefined, migration);
  await f.run();
  assert.equal(f.counts().ready, 1);
  assert.equal(f.counts().takes, 1);
  assert.match(f.deferredNotice() ?? "", /旧数据已保留/u);
  assert.match(f.deferredNotice() ?? "", /未迁移旧数据/u);
});

/** 安装真实 Pinia 持久化插件，存储故障只施加于既有 config key。 */
async function persistedConfig(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), values = new Map<string, string>();
  let fault: "none" | "reject" | "omit-session" | "omit-access" = "none";
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (key === "config" && fault === "reject") throw new Error("fixture storage denied");
      if (key === "config" && (fault === "omit-session" || fault === "omit-access")) {
        const partial = JSON.parse(value);
        delete partial[fault === "omit-session" ? "sessionToken" : "accessContext"];
        value = JSON.stringify(partial);
      }
      values.set(key, value);
    },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage, sessionStorage: storage, location: new URL("https://source.test") } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  const pinia = createPinia().use(persistedstate); createApp({}).use(pinia);
  const config = useConfigStore(pinia);
  t.mock.method(config, "refreshDesktopRuntime", async () => {});
  t.mock.method(config, "syncDesktopCloudAccount", async () => {});
  await nextTick();
  return { config, values, setFault(value: typeof fault) { fault = value; } };
}

const restoredSession: AccountLoginResponseBody = { sessionToken: "sess_persisted_fixture", sessionExpiresAt: Date.now() + 60_000,
  serverNow: Date.now(), authMode: "account", accountRole: "personal_normal", homePath: "/chat",
  userSummary: accountUser("old-account"), accessContext: { identityType: "PERSONAL_USER", editionType: "COMMUNITY",
    editionStatus: "ACTIVE", effectiveAccessScope: "COMMUNITY", enterpriseId: null, enterpriseName: null } };

/** 真实 owner 持有账号结果和 ACK 记录，仅替换 Worker 与远端兑换边界。 */
async function accountOwner(t: test.TestContext, restoreAccount: () => Promise<{ serverOrigin: string; session: AccountLoginResponseBody }>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-account-apply-"));
  const migration = createLegacyClientMigration({ dataDir, workerEntry: "unused",
    identity: { deviceId: "22222222-2222-4222-8222-222222222222", createdAt: new Date().toISOString(), publicKeyBase64: "fixture" },
    execute: async () => ({ candidateId: "source", workspaceCount: 1, migrationId: "11111111-1111-4111-8111-111111111111", completed: true,
      accountSource: { sourceClientId: "old-client", apiKey: "fixture-key", serverWs: "wss://source.test/ws/client" } }), restoreAccount });
  t.after(async () => { await migration.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await migration.prepare(); await migration.runtimeReady();
  return { migration, record: () => JSON.parse(fs.readFileSync(path.join(dataDir, "legacy-client-migration-account.json"), "utf8")) };
}

test("最终复核：真实owner保存失败后重新进入交付同一会话，不兑换撤销待交付凭据", async t => {
  let exchanges = 0, finishRotation!: () => void, finishRefresh!: () => void, refreshed!: () => void;
  const rotation = new Promise<void>(resolve => { finishRotation = resolve; });
  const refreshing = new Promise<void>(resolve => { refreshed = resolve; });
  const refresh = new Promise<void>(resolve => { finishRefresh = resolve; });
  t.after(() => { finishRotation(); finishRefresh(); });
  const owner = await accountOwner(t, async () => {
    exchanges++;
    if (exchanges > 1) await rotation;
    return { serverOrigin: "https://source.test", session: { ...restoredSession, sessionToken: `sess_exchange_${exchanges}` } };
  });
  const persistence = await persistedConfig(t), f = setup("restored", persistence.config, owner.migration);
  persistence.setFault("reject"); await f.run();
  assert.equal(f.counts().acknowledgements, 0);
  assert.equal(owner.record().delivered, false);
  persistence.setFault("none");
  t.mock.method(persistence.config, "refreshDesktopRuntime", async () => { refreshed(); await refresh; });
  const reopened = setup("restored", persistence.config, owner.migration);
  const retry = reopened.run(); await refreshing;
  finishRotation(); await nextTick(); finishRefresh(); await retry; await nextTick();
  assert.equal(exchanges, 1, "保存失败只重试原结果交付，不能兑换新session撤销已保存结果");
  assert.equal(JSON.parse(persistence.values.get("config")!).sessionToken, "sess_exchange_1");
  assert.equal(reopened.counts().acknowledgements, 1);
  assert.equal(owner.record().delivered, true);
  assert.equal(await owner.migration.takeAccount(), null);
});

for (const cancelled of [false, true]) {
  test(`最终复核：真实owner待交付会话过期先清旧结果，恢复${cancelled ? "取消后迟到结果不覆盖新选择" : "期间不消费旧会话"}`, async t => {
    let exchanges = 0, finishRotation!: () => void, rotating!: () => void;
    const rotation = new Promise<void>(resolve => { finishRotation = resolve; });
    const started = new Promise<void>(resolve => { rotating = resolve; });
    t.after(() => finishRotation());
    const firstExpiresAt = Date.now() + 60_000;
    const owner = await accountOwner(t, async () => {
      exchanges++;
      if (exchanges > 1) { rotating(); await rotation; }
      return { serverOrigin: "https://source.test", session: { ...restoredSession, sessionToken: `sess_exchange_${exchanges}`,
        sessionExpiresAt: exchanges === 1 ? firstExpiresAt : Date.now() + 60_000 } };
    });
    const persistence = await persistedConfig(t), f = setup("restored", persistence.config, owner.migration);
    persistence.setFault("reject"); await f.run(); persistence.setFault("none");
    t.mock.method(Date, "now", () => firstExpiresAt + 1);
    const retry = owner.migration.retryAccount(); await started; await nextTick();
    const pendingAccount = await owner.migration.takeAccount();
    const restoringCounts = f.counts();
    if (cancelled) {
      persistence.config.sessionToken = "sess_user_selected";
      persistence.config.userSummary = accountUser("selected-account");
      await owner.migration.cancelAccount();
    }
    finishRotation(); await retry; await nextTick();
    const reopened = setup("restored", persistence.config, owner.migration);
    await reopened.run();
    assert.equal(pendingAccount, null, "恢复新会话前必须清除过期结果");
    assert.equal(restoringCounts.acknowledgements, 0);
    assert.equal(restoringCounts.takes, 1, "restoring事件不能再次消费旧结果");
    assert.equal(persistence.config.sessionToken, cancelled ? "sess_user_selected" : "sess_exchange_2");
    assert.equal(reopened.counts().acknowledgements, cancelled ? 0 : 1);
    assert.equal(owner.record().delivered, !cancelled);
  });
}

test("最终复核：真实owner不交付或确认已过期会话", async t => {
  const expiresAt = Date.now() + 60_000;
  const owner = await accountOwner(t, async () => ({ serverOrigin: "https://source.test", session: { ...restoredSession, sessionExpiresAt: expiresAt } }));
  assert.ok(await owner.migration.takeAccount());
  t.mock.method(Date, "now", () => expiresAt + 1);
  await assert.rejects(owner.migration.takeAccount(), /MIGRATION_ACCOUNT_EXPIRED/u);
  await assert.rejects(owner.migration.acknowledgeAccount(), /MIGRATION_ACCOUNT_EXPIRED/u);
  assert.equal(owner.record().delivered, false);
});

for (const fault of ["reject", "omit-session", "omit-access"] as const) {
  test(`最终复核：真实持久化${fault}不确认迁移账号，修复存储后可重试交付`, async t => {
    const persistence = await persistedConfig(t), f = setup("restored", persistence.config);
    persistence.setFault(fault);
    const pending = f.run(); await f.takeStarted;
    f.resolveTake({ serverOrigin: "https://source.test", session: restoredSession }); await pending;
    assert.equal(f.counts().acknowledgements, 0);
    assert.equal(f.counts().ready, 1, "账号失败仍开放已迁移的本地功能");
    assert.ok(f.error(), "页面必须明确展示会话保存失败");
    assert.equal(f.errors.length, 1);
    assert.ok(!JSON.stringify(f.errors).includes(restoredSession.sessionToken));
    persistence.setFault("none");
    const reopened = setup("restored", persistence.config);
    reopened.resolveTake({ serverOrigin: "https://source.test", session: restoredSession });
    await reopened.run();
    assert.equal(reopened.counts().acknowledgements, 1);
    const saved = JSON.parse(persistence.values.get("config")!);
    assert.equal(saved.sessionToken, restoredSession.sessionToken);
    assert.equal(saved.sessionExpiresAt, restoredSession.sessionExpiresAt);
    assert.equal(saved.authMode, "account");
    assert.deepEqual(saved.accessContext, restoredSession.accessContext);
    assert.deepEqual(saved.userSummary, restoredSession.userSummary);
    assert.equal(reopened.error(), null);
  });
}

test("最终复核：真实session完整保存后才确认迁移账号", async t => {
  const persistence = await persistedConfig(t), f = setup("restored", persistence.config);
  const pending = f.run(); await f.takeStarted;
  f.resolveTake({ serverOrigin: "https://source.test", session: restoredSession }); await pending;
  assert.equal(f.counts().acknowledgements, 1);
  assert.equal(JSON.parse(persistence.values.get("config")!).sessionToken, restoredSession.sessionToken);
  assert.equal(f.error(), null);
});

test("迁移账号未登录提示可关闭，重复状态通知不重新弹出", async () => {
  const f = setup("failed");
  Object.assign(f.config, { sessionToken: null, userSummary: null, isAccountSession: false, hasActiveSession: false });
  f.resolveTake(null); await f.run();
  assert.equal(f.showNotice(), true);
  f.dismiss();
  assert.equal(f.showNotice(), false);
  f.send(f.state); await nextTick();
  assert.equal(f.showNotice(), false);
  assert.equal(f.state.account.status, "failed", "关闭不改变真实迁移或认证状态");
});

test("迁移提示去登录直接打开桌面登录窗口，登录成功自动隐藏", async t => {
  desktopAuthModalOpen.value = false;
  t.after(() => { desktopAuthModalOpen.value = false; });
  const f = setup("failed");
  Object.assign(f.config, { sessionToken: null, userSummary: null, isAccountSession: false, hasActiveSession: false });
  f.resolveTake(null); await f.run();
  assert.equal(f.showNotice(), true);
  const before = f.counts();
  f.openLogin();
  assert.equal(desktopAuthModalOpen.value, true);
  assert.deepEqual(f.counts(), before, "打开登录不再重试旧凭据恢复");
  Object.assign(f.config, { isAccountSession: true, hasActiveSession: true });
  await nextTick();
  assert.equal(f.showNotice(), false);
});

test("迁移登录提示文案全中文且提供原生关闭入口", () => {
  const source = fs.readFileSync(new URL("../src/features/desktop/components/desktop-migration-startup.vue", import.meta.url), "utf8");
  const notice = source.match(/<aside[^>]+class="desktop-migration__account"[\s\S]*?<\/aside>/u)?.[0];
  assert.ok(notice);
  assert.match(notice, /本地数据已迁移，账号未登录/u);
  assert.match(notice, />去登录<\/Button>/u);
  assert.match(notice, /closable/u);
  assert.doesNotMatch(notice, /account\.(?:message|errorCode)|description=/u);
});

test("主动切换账号与取消后，迟到迁移session不能覆盖新选择", async () => {
  const f = setup("restored");
  const pending = f.run();
  await f.takeStarted;
  f.config.sessionToken = "user-selected-session";
  f.config.userSummary = accountUser("user-selected-account");
  f.send({ ...f.state, account: { status: "cancelled", errorCode: null, message: null } });
  f.resolveTake({ serverOrigin: "https://source.test", session: { sessionToken: "late-old-session", userSummary: { userId: "old-account" } } });
  await pending;
  assert.equal(f.config.sessionToken, "user-selected-session");
  assert.equal(f.counts().acknowledgements, 0);
  assert.equal(f.counts().ready, 1);
});

test("持久取消的迁移账号在重启时直接开放本地，不再取旧session", async () => {
  const f = setup("cancelled");
  await f.run();
  assert.equal(f.counts().ready, 1);
  assert.equal(f.counts().acknowledgements, 0);
  assert.equal(f.config.sessionToken, "initial");
});

test("held期间账号只交付一次，云端关联留给放行后的Shell生命周期", async t => {
  const f = setup("restored");
  Object.defineProperty(f.config, "localRuntimeReady", { value: false });
  let links = 0;
  t.mock.method(f.config, "syncDesktopCloudAccount", async () => { links++; throw new Error("DESKTOP_STARTUP_HELD"); });
  const pending = f.run(); await f.takeStarted;
  f.resolveTake({ serverOrigin: "https://source.test", session: restoredSession }); await pending;
  assert.equal(f.counts().ready, 1);
  assert.equal(f.counts().acknowledgements, 1);
  assert.equal(links, 0);
  assert.equal(f.error(), null);
  f.send(f.state); await nextTick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().takes, 1);
  assert.equal(f.counts().ready, 1);
});
