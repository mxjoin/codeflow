import { expect, test, type Page } from "@playwright/test";
import { CODEX_MODELS } from "@codeflowai/shared";

// 注入登录态；WS 握手与 threads 端点由 mock-codeflow-server 提供。
// 说明：ensureSession 要求 userSummary 非空，故注入完整 userSummary 与 accessContext。
// 采用 basic 的 openFresh 模式（先导航首页再 evaluate 写 localStorage），避免 addInitScript 首次导航失败。
async function installSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290",
      authMode: "account",
      accountRole: "enterprise_admin",
      sessionToken: "chat-core-e2e-session",
      sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/chat",
      userSummary: { userId: "chat-core-e2e-user", email: "chat-core-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

/** 通过「+ 新建」弹框创建一个会话并断言其出现在列表。 */
async function createThread(page: Page, title: string): Promise<void> {
  await page.getByText("+ 新建").click();
  await page.getByRole("dialog").getByPlaceholder(/例如：修复登录页样式/).fill(title);
  await page.getByRole("dialog").getByRole("button", { name: /确\s*定/ }).click();
  await expect(page.getByText(title).first()).toBeVisible();
}

test.describe("会话核心链路", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("http://127.0.0.1:39290/api/test/reset");
  });

  test("CT-01 进入 /chat 会话列表加载", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await expect(page.locator(".thread-list")).toBeVisible();
  });

  test("聊天页从 main 切换 monitor 后，刷新仍保留所选工作区", async ({ page }) => {
    await installSession(page);
    const mainWorkspace = "workspace_chat_core_e2e";
    const monitorWorkspace = "workspace_monitor_e2e";
    await page.route("**/api/workspaces?**", route => route.fulfill({ json: {
      ok: true,
      workspaces: [
        { id: mainWorkspace, title: "main", path: "D:/e2e-main", kind: "local", createdAt: 1, updatedAt: 1 },
        { id: monitorWorkspace, title: "monitor", path: "D:/e2e-monitor", kind: "local", createdAt: 2, updatedAt: 2 },
      ],
      workspaceListAuthoritative: true,
    } }));
    await page.goto(`/chat?workspaceId=${mainWorkspace}`);
    const selector = page.locator(".ws-compact-trigger");
    await expect(selector).toHaveAttribute("aria-label", "切换工作区，当前 main");
    await selector.click();
    await page.locator(".ws-compact-option").filter({ hasText: "monitor" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("workspaceId")).toBe(monitorWorkspace);
    await expect(selector).toHaveAttribute("aria-label", "切换工作区，当前 monitor");
    await page.reload();
    await expect(selector).toHaveAttribute("aria-label", "切换工作区，当前 monitor");
    expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(monitorWorkspace);
  });

  test("工作区下拉打开及手动刷新会更新共享 Host 状态，失败保留列表", async ({ page }) => {
    await installSession(page);
    let online = false, failRefresh = false, requests = 0;
    const mainWorkspace = "workspace_chat_core_e2e";
    await page.route("**/api/workspaces?**", route => {
      requests++;
      if (failRefresh) return route.fulfill({ status: 503, json: { ok: false, code: "WORKSPACE_REFRESH_FAILED", message: "工作区列表刷新失败" } });
      return route.fulfill({ json: { ok: true, workspaceListAuthoritative: true, workspaces: [
        { id: mainWorkspace, title: "main", path: "D:/e2e-main", kind: "local", createdAt: 1, updatedAt: 1 },
        { id: "shared:refresh-test", title: "测试共享入口", path: "", kind: "shared", createdAt: 2, updatedAt: 2,
          entryStatus: online ? "available" : "host_offline", disabledReason: online ? null : "Host 当前离线",
          shared: { displayName: "测试共享入口", hostOwnerFullName: "测试 Host" } },
      ] } });
    });
    await page.goto(`/chat?workspaceId=${mainWorkspace}`);
    await page.getByRole("button", { name: "暂时继续使用 Web" }).click();
    const selector = page.locator(".ws-compact-trigger");
    await expect(selector).toHaveAttribute("aria-label", "切换工作区，当前 main");
    await selector.click();
    const panel = page.locator(".ws-compact-panel");
    const shared = panel.locator(".ws-compact-option").filter({ hasText: "测试共享入口" });
    await expect(shared).toBeDisabled();
    await expect(shared).toContainText("Host 离线");
    await selector.click();
    await expect(panel).toBeHidden();

    online = true;
    const beforeOpen = requests;
    await selector.click();
    await expect(shared).toBeEnabled();
    await expect(shared).toContainText("Host 在线");
    expect(requests).toBeGreaterThan(beforeOpen);

    online = false;
    const refresh = panel.getByRole("button", { name: "刷新工作区列表" });
    await refresh.click();
    await expect(shared).toBeDisabled();
    await expect(shared).toContainText("Host 离线");
    await expect(panel).toBeVisible();

    failRefresh = true;
    await refresh.click();
    await expect(page.getByText("工作区列表刷新失败", { exact: true }).first()).toBeVisible();
    await expect(shared).toBeDisabled();
    await expect(refresh).toBeEnabled();

    failRefresh = false;
    online = true;
    await refresh.click();
    await expect(shared).toBeEnabled();
    await expect(shared).toContainText("Host 在线");
  });

  test("CT-02 新建会话默认 Codex", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "新会话");
    // 默认引擎为 Codex
    await expect(page.getByRole("radio", { name: "Codex" })).toBeChecked();
  });

  test("新建会话默认关闭 Fast、Spec、WorkFlow，手动开启后刷新保留且不影响下一会话", async ({ page }) => {
    let prefs: Record<string, unknown> = {};
    let workflowEnabled = false;
    let snapshotRequests = 0;
    await page.route("**/api/account/me/model-context-preferences", (route) => route.fulfill({ json: { ok: true, preferences: [] } }));
    await page.route("**/api/engines/status**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.catalogVersion = 2;
      body.hostAppliedCatalogVersion = 2;
      body.engines = body.engines.map((engine: { engineType: string }) => engine.engineType === "codex"
        ? { ...engine, models: CODEX_MODELS.filter(model => model.id === "gpt-5.6-sol" || model.id === "gpt-5.5") }
        : engine);
      return route.fulfill({ response, json: body });
    });
    await page.route("**/api/threads/latest-prefs**", (route) => route.fulfill({ json: { ok: true, prefs: { model: "gpt-5.6-sol", serviceTier: "fast", knowledgeEnabled: true } } }));
    await page.route("**/api/knowledge/assets/snapshot?**", (route) => {
      snapshotRequests += 1;
      return route.fulfill({ json: { ok: true, data: { initialized: true } } });
    });
    await page.route("**/api/orch/chat/**", (route) => {
      const endpoint = new URL(route.request().url()).pathname.split("/").pop();
      if (endpoint === "settings") workflowEnabled = route.request().postDataJSON().enabled;
      return route.fulfill({ json: { ok: true, recommendationEnabled: workflowEnabled, tasks: [] } });
    });
    await page.route("**/api/threads/create", async (route) => {
      prefs = route.request().postDataJSON().initialPrefs;
      expect(prefs.serviceTier).toBeNull();
      expect(prefs.knowledgeEnabled).toBe(false);
      workflowEnabled = false;
      await route.continue();
    });
    await page.route("**/api/threads/prefs", (route) => route.fulfill({ json: { ok: true, prefs } }));
    await page.route("**/api/threads/load", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, thread: { ...body.thread, ...prefs } } });
    });
    await page.route("**/api/threads/update-prefs", (route) => {
      prefs = { ...prefs, ...route.request().postDataJSON().prefs };
      return route.fulfill({ json: { ok: true } });
    });
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "开关默认关闭会话");
    const fast = page.getByRole("button", { name: "Fast", exact: true });
    const spec = page.getByRole("button", { name: "Spec", exact: true });
    const workflow = page.getByRole("button", { name: "WorkFlow", exact: true });
    for (const toggle of [fast, spec, workflow]) {
      await expect(toggle).toBeVisible();
      await expect(toggle).not.toHaveClass(/composer__toggle--on/u);
    }
    await page.locator(".composer__model-select").click();
    await page.locator(".composer__model-dropdown:visible").getByText("GPT-5.5", { exact: true }).click();
    await expect.poll(() => prefs.model).toBe("gpt-5.5");
    await expect(fast).not.toHaveClass(/composer__toggle--on/u);
    expect(prefs.serviceTier).toBeNull();
    await fast.click();
    await expect.poll(() => prefs.serviceTier).toBe("fast");
    await expect(fast).toHaveClass(/composer__toggle--on/u);
    await spec.click();
    await expect.poll(() => prefs.knowledgeEnabled).toBe(true);
    expect(snapshotRequests).toBeGreaterThan(0);
    await workflow.click();
    await expect.poll(() => workflowEnabled).toBe(true);
    await page.reload();
    for (const toggle of [fast, spec, workflow]) await expect(toggle).toHaveClass(/composer__toggle--on/u);
    await fast.click();
    await expect.poll(() => prefs.serviceTier).toBeNull();
    await expect(fast).not.toHaveClass(/composer__toggle--on/u);
    await page.reload();
    await expect(fast).toBeVisible();
    await expect(fast).not.toHaveClass(/composer__toggle--on/u);
    await expect(spec).toHaveClass(/composer__toggle--on/u);
    await expect(workflow).toHaveClass(/composer__toggle--on/u);
    await createThread(page, "下一会话仍默认关闭");
    for (const toggle of [fast, spec, workflow]) await expect(toggle).not.toHaveClass(/composer__toggle--on/u);
  });

  test("CT-03 发送消息并收到回复", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "对话会话");
    const input = page.locator("textarea").first();
    await input.fill("你好");
    await page.locator(".composer__send-btn").click();
    await expect(page.getByText("已收到：你好").first()).toBeVisible({ timeout: 10_000 });
  });

  test("CT-04 新会话同步到列表", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "同步会话");
    await expect(page.getByText("同步会话").first()).toBeVisible();
  });

  test("CT-05 会话重命名", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "待重命名");
    await page.getByText("待重命名").first().hover();
    await page.getByLabel("更多").first().click();
    await page.getByText("重命名", { exact: true }).click();
    await page.getByRole("dialog").getByPlaceholder(/例如：修复登录页样式/).fill("核心链路会话");
    await page.getByRole("dialog").getByRole("button", { name: /确\s*定/ }).click();
    await expect(page.getByText("核心链路会话").first()).toBeVisible();
  });

  test("CT-06 会话删除", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "待删除");
    await page.getByText("待删除").first().hover();
    await page.getByLabel("更多").first().click();
    await page.getByText("删除", { exact: true }).click();
    await page.getByRole("button", { name: /删\s*除/ }).last().click();
    await expect(page.getByText("待删除")).toHaveCount(0);
  });

  test("CT-07 切换会话加载历史", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    await createThread(page, "切换会话");
    await page.getByText("切换会话").first().click();
    await expect(page.locator(".composer__textarea")).toBeVisible();
  });

  test("CT-08 刷新等待期间持续旋转，完成后停转并提示成功", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    const refresh = page.getByRole("button", { name: "刷新列表", exact: true });
    await expect(refresh).toBeEnabled();
    await page.waitForLoadState("networkidle");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    await page.route("**/api/threads?**", async (route) => {
      requests += 1;
      const response = await route.fetch();
      await pending;
      await route.fulfill({ response });
    });
    try {
      await refresh.click();
      await expect.poll(() => requests).toBe(1);
      await expect(refresh).toBeDisabled();
      await expect(refresh).toHaveAttribute("aria-busy", "true");
      const spinner = refresh.locator(".thread-list__refresh-spinner svg");
      await expect(spinner).toBeVisible();
      await expect.poll(() => spinner.evaluate((icon) => icon.getAnimations().length)).toBe(1);
      const frames = await spinner.evaluate((icon) => (icon.getAnimations()[0].effect as KeyframeEffect).getKeyframes());
      expect(frames.map((frame) => frame.transform)).toEqual(["rotate(0deg)", "rotate(360deg)"]);
      expect(await spinner.evaluate((icon) => icon.getAnimations()[0].effect?.getComputedTiming().iterations)).toBe(Infinity);
      const before = await spinner.evaluate((icon) => getComputedStyle(icon).transform);
      await page.waitForTimeout(1250);
      const after = await spinner.evaluate((icon) => getComputedStyle(icon).transform);
      expect(after).not.toBe(before);
      await expect(spinner).toBeVisible();
      await expect(page.locator(".ant-message-success")).toHaveCount(0);
      await refresh.evaluate((button) => (button as HTMLButtonElement).click());
      expect(requests).toBe(1);
      release();
      await expect(refresh).toBeEnabled();
      await expect(refresh).toHaveAttribute("aria-busy", "false");
      await expect(refresh.locator(".thread-list__refresh-spinner")).toHaveCount(0);
      await expect(page.getByText("列表已刷新", { exact: true })).toBeVisible();
    } finally {
      release();
    }
  });

  test("CT-09 刷新失败后停止旋转，不提示成功", async ({ page }) => {
    await installSession(page);
    await page.goto("/chat");
    const refresh = page.getByRole("button", { name: "刷新列表", exact: true });
    await expect(refresh).toBeEnabled();
    await page.waitForLoadState("networkidle");
    await page.route("**/api/threads?**", (route) => route.fulfill({
      status: 503,
      json: { ok: false, code: "TEST_REFRESH_FAILED", message: "会话列表刷新失败" },
    }));
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("会话列表刷新失败", { exact: true })).toBeVisible();
    await expect(refresh).toHaveAttribute("aria-busy", "false");
    await expect(refresh).toBeEnabled();
    await expect(refresh.locator(".thread-list__refresh-spinner")).toHaveCount(0);
    await expect(page.locator(".ant-message-success")).toHaveCount(0);
  });
});
