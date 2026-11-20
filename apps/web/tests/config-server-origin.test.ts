import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createApp } from "vue";
import { createPinia, defineStore, disposePinia, setActivePinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";
import ts from "typescript";
import { fetchPublicSiteContactInfo } from "../src/composables/siteContactInfo.ts";
import { getNumericCaptchaChallenge } from "../src/api/account/index.ts";

const sourceUrl = new URL("../src/store/config.ts", import.meta.url);
const source = readFileSync(sourceUrl, "utf8");
const requireSource = createRequire(sourceUrl);
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  transformers: {
    before: [context => file => {
      /** 仅注入构建环境；完整配置模块、默认 state 和迁移仍执行真实源码。 */
      const visit: ts.Visitor = node => ts.isPropertyAccessExpression(node) && node.name.text === "env"
        && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
        ? context.factory.createIdentifier("testViteEnv") : ts.visitEachChild(node, visit, context);
      return ts.visitNode(file, visit) as ts.SourceFile;
    }],
  },
}).outputText;

/** 隔离浏览器存储，令真实持久化插件可以恢复并保存配置。 */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
}

/** 每场重新求值真实模块，以实际 Pinia 初始化、hydrate 和公开迁移观察地址。 */
function fixture(t: test.TestContext, href?: string, env: Record<string, string> = {}, persistedOrigin?: string) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = memoryStorage();
  if (persistedOrigin !== undefined) storage.setItem("config", JSON.stringify({ serverWsOrigin: persistedOrigin }));
  if (href) Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL(href), localStorage: storage, sessionStorage: memoryStorage(),
  } });
  else Reflect.deleteProperty(globalThis, "window");
  const pinia = createPinia();
  pinia.use(createPersistedState({ storage }));
  createApp({}).use(pinia);
  setActivePinia(pinia);
  t.after(() => {
    disposePinia(pinia);
    descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window");
  });
  const exports = {} as typeof import("../src/store/config.ts");
  new Function("require", "exports", "testViteEnv", compiled)(
    (name: string) => name === "pinia" ? { defineStore } : requireSource(name), exports, env,
  );
  const store = exports.useConfigStore();
  return { store, migrate: exports.migrateConfigDefaults, storage };
}

for (const legacy of ["ws://47.98.203.210:39280", "ws://47.98.203.210:39280/ws/web", "ws://codeflow-test.hanshangai.com"]) {
  test(`测试包将持久旧入口 ${legacy} 迁移为安全域名并保存`, t => {
    const target = "wss://codeflow-test.hanshangai.com";
    const { store, migrate, storage } = fixture(t, "codeflow://desktop/chat", { VITE_CODEFLOWAI_SERVER_WS_ORIGIN: target }, legacy);
    assert.equal(store.serverWsOrigin, target, "hydrate 后、发起关联前已迁移");
    migrate(); store.$persist();
    assert.equal(JSON.parse(storage.getItem("config")!).serverWsOrigin, target);
    assert.equal(store.wsWebUrl, `${target}/ws/web`);
  });
}

for (const [target, saved] of [["wss://codeflow-test.hanshangai.com", "wss://codeflowai.cn"],
  ["wss://codeflow-test.hanshangai.com", "ws://127.0.0.1:39280"], ["wss://codeflowai.cn", "ws://47.98.203.210:39280"]]) {
  test(`默认 ${target} 不改写其他已保存入口 ${saved}`, t => {
    const { store, migrate } = fixture(t, "codeflow://desktop/chat", { VITE_CODEFLOWAI_SERVER_WS_ORIGIN: target }, saved);
    migrate(); assert.equal(store.serverWsOrigin, saved);
  });
}

for (const href of ["codeflow://desktop/chat", "file:///app/index.html", "data:text/html,test", "about:blank"]) {
  test(`${href.split(":")[0]} 默认未配置 Server，公共信息不发网络请求`, async t => {
    const { store, migrate } = fixture(t, href);
    assert.equal(store.serverWsOrigin, "");
    migrate();
    assert.equal(store.serverWsOrigin, "");
    assert.equal(store.canConnectServer, false);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("UNEXPECTED_NETWORK_REQUEST"); });
    await fetchPublicSiteContactInfo({ serverWsOrigin: store.serverWsOrigin, sessionToken: null, webSessionId: null });
    assert.equal(requests, 0);
  });

  for (const origin of ["ws://127.0.0.1:39280/ws/web", "ws://desktop:39280", "wss://cloud.example/base/ws/web", "ws://desktop"]) {
    test(`${href.split(":")[0]} 保留持久来源 ${origin}`, t => {
      const { store, migrate, storage } = fixture(t, href, {}, origin);
      const expected = origin.replace(/\/ws\/web$/, "");
      assert.equal(store.serverWsOrigin, expected);
      migrate();
      assert.equal(store.serverWsOrigin, expected);
      store.$persist();
      assert.equal(JSON.parse(storage.getItem("config")!).serverWsOrigin, expected);
    });
  }
}

for (const [href, expected] of [
  ["http://localhost:39281/chat", "ws://localhost:39280"],
  ["http://127.0.0.1:39281/chat", "ws://127.0.0.1:39280"],
  ["http://[::1]:39281/chat", "ws://[::1]:39280"],
  ["https://example.com:39281/chat", "wss://example.com:39280"],
  ["https://[2001:db8::1]:39281/chat", "wss://[2001:db8::1]:39280"],
  ["http://example.com:8080/chat", "ws://example.com:8080"],
  ["https://example.com/chat", "wss://example.com"],
] as const) {
  test(`HTTP 页面默认地址保持 ${expected}`, t => {
    const { store, migrate } = fixture(t, href);
    assert.equal(store.serverWsOrigin, expected);
    migrate();
    assert.equal(store.serverWsOrigin, expected);
  });
}

for (const [env, expected] of [
  [{ VITE_CODEFLOWAI_SERVER_WS_ORIGIN: "wss://primary.example/base/ws/web", VITE_AIDT_CODE_SERVER_WS_ORIGIN: "wss://legacy.example" }, "wss://primary.example/base"],
  [{ VITE_AIDT_CODE_SERVER_WS_ORIGIN: "wss://legacy.example" }, "wss://legacy.example"],
  [{ VITE_CODEFLOWAI_SERVER_WS_ORIGIN: "ws://127.0.0.1:39280" }, "ws://127.0.0.1:39280"],
  [{ VITE_CODEFLOWAI_SERVER_WS_ORIGIN: "", VITE_AIDT_CODE_SERVER_WS_ORIGIN: "wss://legacy.example" }, ""],
] as [Record<string, string>, string][]) {
  test(`桌面显式 Vite 来源保持原优先级 ${expected || "空主配置"}`, t => {
    const { store, migrate } = fixture(t, "codeflow://desktop/chat", env);
    assert.equal(store.serverWsOrigin, expected);
    migrate();
    assert.equal(store.serverWsOrigin, expected);
  });
}

test("桌面修复历史空地址后验证码请求测试 Server，而非本地静态协议", async t => {
  const { store, migrate, storage } = fixture(t, "codeflow://desktop/chat", { VITE_CODEFLOWAI_SERVER_WS_ORIGIN: "ws://47.98.203.210:39280" }, "");
  assert.equal(store.serverWsOrigin, "");
  migrate();
  assert.equal(store.serverWsOrigin, "ws://47.98.203.210:39280");
  let requested = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify({ ok: true, challengeId: "fixture", imageDataUrl: "data:image/svg+xml,fixture" }), { headers: { "content-type": "application/json" } });
  });
  const result = await getNumericCaptchaChallenge(store.serverWsOrigin, "light");
  assert.equal(result.ok, true);
  assert.equal(requested, "http://47.98.203.210:39280/api/account/auth/captcha/numeric?theme=light");
  store.$persist();
  assert.equal(JSON.parse(storage.getItem("config")!).serverWsOrigin, "ws://47.98.203.210:39280");
});

test("HTTP 页面空地址不被桌面构建默认覆盖", t => {
  const { store, migrate } = fixture(t, "https://other.example/chat", { VITE_CODEFLOWAI_SERVER_WS_ORIGIN: "ws://47.98.203.210:39280" }, "");
  migrate();
  assert.equal(store.serverWsOrigin, "");
});

test("持久云地址优先于 Vite 默认，桌面迁移不改写有效配置", t => {
  const { store, migrate } = fixture(t, "codeflow://desktop/chat", { VITE_CODEFLOWAI_SERVER_WS_ORIGIN: "wss://default.example" }, "wss://saved.example/ws/web");
  migrate();
  assert.equal(store.serverWsOrigin, "wss://saved.example");
});

test("无 window 时保留原 loopback 默认", t => {
  const { store, migrate } = fixture(t);
  assert.equal(store.serverWsOrigin, "ws://127.0.0.1:39280");
  migrate();
  assert.equal(store.serverWsOrigin, "ws://127.0.0.1:39280");
});

for (const [href, persisted, expected] of [
  ["https://example.com/chat", "ws://127.0.0.1:39280/ws/web", "wss://example.com"],
  ["http://example.com:39281/chat", "ws://example.com:39281", "ws://example.com:39280"],
  ["http://localhost:39281/chat", "wss://saved.example", "wss://saved.example"],
] as const) {
  test(`HTTP 页面迁移保持 ${expected}`, t => {
    const { store, migrate } = fixture(t, href, {}, persisted);
    migrate();
    assert.equal(store.serverWsOrigin, expected);
  });
}
