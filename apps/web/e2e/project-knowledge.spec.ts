import { expect, test, type Locator, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { KNOWLEDGE_CATEGORIES } from "../../../packages/shared/src/types/knowledgeAssets";

const WORKSPACE_ID = "workspace_chat_core_e2e";
const MOCK_URL = "http://127.0.0.1:39290";

type Node = { id: string; parentId: string | null; title: string; orderKey: string; summary: string; tags: string[]; instructions: string; sourceScope: string[]; contentMode?: "directory" | "reference" | "generated"; reference?: { path: string; adoptedContentHash: string }; category?: "specifications" | "architecture" | "product"; appliesTo?: string[] };
type Run = { id: string; phase: string; active: boolean; mode: string; nodeId: string | null; proposedTree: { schemaVersion: number; instructions: string; nodes: Node[] } | null; [key: string]: unknown };
type RequestBody = Record<string, unknown>;

function assetNode(id = "root", title = "功能说明", parentId: string | null = null): Node {
  return { id, parentId, title, orderKey: id, summary: "项目功能文档", tags: [], instructions: "", sourceScope: ["docs"] };
}

async function installSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    // 本套回归聚焦规格库，桌面迁移引导由独立用例验证。
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    window.localStorage.setItem(`codeflow.desktop-migration.v1:${encodeURIComponent("http://127.0.0.1:39290")}:${encodeURIComponent("chat-core-e2e-user")}`, localDate);
    window.localStorage.setItem("config", JSON.stringify({
      serverWsOrigin: "ws://127.0.0.1:39290", workspaceId: "workspace_chat_core_e2e",
      authMode: "account", accountRole: "enterprise_admin", sessionToken: "kb-e2e-session", sessionExpiresAt: Date.now() + 3_600_000,
      homePath: "/knowledge", setupComplete: true,
      userSummary: { userId: "chat-core-e2e-user", email: "chat-core-e2e@test.local", fullName: "E2E 用户", phone: "", avatarUrl: null, accountRole: "enterprise_admin", status: "active", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      accessContext: { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
    }));
  });
}

/** 同步检查并展开目录，避免首屏自动定位在检查后移除展开按钮。 */
async function expandKnowledgeDirectory(page: Page, title: string): Promise<void> {
  const row = page.getByTestId("knowledge-tree").getByRole("treeitem").filter({ has: page.getByRole("button", { name: title, exact: true }) });
  await expect(row).toHaveAttribute("aria-expanded", /^(true|false)$/);
  await row.evaluate(element => {
    if (element.getAttribute("aria-expanded") !== "false") return;
    const button = element.querySelector<HTMLButtonElement>("button.disclosure");
    if (!button) throw new Error("目录缺少展开按钮");
    button.click();
  });
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

/** 复用 mock Server 的线程创建、列表与 WS 握手；这里只控制知识数据及回合的完成时机。 */
async function installKnowledgeScenario(page: Page, options: { empty?: boolean; plan?: boolean; failBinding?: boolean; bindingErrorCode?: string; holdFirstTurn?: boolean; discussionAfterPlan?: boolean; delivering?: boolean; paginatedImports?: boolean; children?: number; noKnowledge?: boolean; inactiveKnowledge?: boolean; knowledgeNodeId?: string; secondModelLowOnly?: boolean; standaloneRevision?: boolean; staleFullTreeAfterReload?: boolean; currentDocument?: boolean; productDocument?: boolean; reviewState?: "pending" | "issues" | "stale" | "failed" | "queued" } = {}) {
  const ordinary = await page.request.post(`${MOCK_URL}/api/threads/create`, { data: { workspaceId: WORKSPACE_ID, title: "研发会话，不得复用", engine: "codex" } });
  const { threadId: ordinaryThreadId } = await ordinary.json() as { threadId: string };
  const created = await page.request.post(`${MOCK_URL}/api/threads/create`, { data: { workspaceId: WORKSPACE_ID, title: "项目资产协作", engine: "codex" } });
  const { threadId } = await created.json() as { threadId: string };
  const loaded = await page.request.post(`${MOCK_URL}/api/threads/load`, { data: { workspaceId: WORKSPACE_ID, threadId } });
  const { thread: loadedThread } = await loaded.json() as { thread: RequestBody };
  const thread = { ...loadedThread, threadSubtype: "knowledge-conversation" };
  const nodes: Node[] = options.empty ? [] : [assetNode(), ...Array.from({ length: options.children ?? 0 }, (_, index) => assetNode(`child-${index}`, `资产 ${index + 1}`, "root"))];
  if (options.productDocument) {
    nodes[0]!.parentId = "products";
    nodes.unshift({ ...assetNode("products", "产品文档"), category: "product", contentMode: "directory" });
  }
  const initialSummary = { threadId, nodeId: options.knowledgeNodeId ?? null, createdByUserId: "chat-core-e2e-user", title: "项目资产协作", engine: "codex", model: "gpt-test", effort: "high", active: !options.inactiveKnowledge, createdAt: Date.now(), updatedAt: Date.now() };
  const summaries: RequestBody[] = options.noKnowledge ? [] : [initialSummary];
  const longTitle = "订单页面按钮权限与字段校验规范_" + "VeryLongUnbrokenAssetName".repeat(8);
  const plannedNodes = [assetNode("features", "业务功能"), ...Array.from({ length: 18 }, (_, index) => assetNode(`feature-${index}`, index === 0 ? longTitle : `业务功能 ${index + 1} · 按钮与字段说明`, "features"))];
  const tree = () => ({ schemaVersion: 1, instructions: "生成内容必须引用项目来源", nodes: [...nodes] });
  const draftRevision = { schemaVersion: 1, id: "revision-root", nodeId: "root", createdAt: "2026-09-21T12:00:00.000Z", origin: "ai", instructions: "记录日志规范", summary: "错误日志规范", baseHash: null, contentHash: "d".repeat(64), sourcesHash: "e".repeat(64), ...(options.standaloneRevision ? {} : { runId: "batch-e2e" }) };
  const draftDocument = { revision: draftRevision, content: "# 错误日志规范\n\n错误边界记录结构化日志。\n保留原始原因和 requestId。", sources: [{ kind: "code", path: "apps/desktop/client/src/logger.ts", startLine: 24, endLine: 29, contentHash: "b".repeat(64), relation: "统一日志入口" }], path: "codeflow-docs/知识库/assets/root/revisions/revision-root/content.md" };
  let adopted = Boolean(options.currentDocument);
  const reports: RequestBody[] = options.reviewState && ["issues", "stale"].includes(options.reviewState) ? [{ schemaVersion: 1, id: "review-root", nodeId: "root", revisionId: "revision-root", runId: "batch-e2e", createdAt: "2026-09-21T12:01:00.000Z", contentHash: "d".repeat(64), sourcesHash: "e".repeat(64), instructionsHash: "a".repeat(64), sourceScopeHash: "a".repeat(64), sourceHashes: [{ path: "apps/desktop/client/src/logger.ts", contentHash: "b".repeat(64) }], engine: "codex", model: "gpt-second", effort: "low", outcome: "issues", summary: "正文遗漏错误码，应补齐日志诊断字段。", issues: [{ id: "issue-code", severity: "error", category: "coverage", title: "缺少错误码字段", detail: "日志规范没有要求记录业务错误码。", documentStartLine: 3, documentEndLine: 4, sources: draftDocument.sources, suggestion: "记录 errorCode、requestId 与原始错误原因。" }], sources: draftDocument.sources, stale: options.reviewState === "stale", staleReasons: options.reviewState === "stale" ? ["来源内容已变化"] : [] }] : [];
  const snapshot = () => ({ initialized: true, knowledgeId: "kb-e2e", root: "codeflow-docs/知识库", tree: tree(), treeHash: "a".repeat(64), canWrite: true, states: nodes.map(node => ({ nodeId: node.id, revisionId: options.reviewState && node.id === "root" && adopted ? "revision-root" : null, draftCount: options.reviewState && node.id === "root" && !adopted ? 1 : 0, error: null })) });
  let run: Run | null = options.plan || options.delivering ? {
    schemaVersion: 1, id: "run-e2e", createdAt: new Date().toISOString(), phase: options.delivering ? "generating" : "planned", active: !!options.delivering, mode: options.delivering ? "conversation" : "tree", nodeId: null,
    threadId, prompt: "根据项目生成资产树", engine: "codex", model: "gpt-test", effort: "high", treeHash: "a".repeat(64),
    proposedTree: options.delivering ? null : { ...tree(), nodes: plannedNodes }, rationale: "按业务功能划分，并保留按钮、字段和失败反馈的证据。", gaps: [], error: null, activeItemId: null,
    items: options.delivering ? [{ id: "item-root", nodeId: "root", title: "功能说明", expectedHash: null, instructions: "记录功能", status: "completed", revisionId: "revision-1", executionThreadId: "knowledge-generation-root", error: null }] : [],
  } : null;
  if (options.reviewState) run = {
    schemaVersion: 1, id: "batch-e2e", createdAt: "2026-09-21T12:00:00.000Z", mode: "batch", nodeId: null, phase: options.reviewState === "queued" ? "generating" : options.reviewState === "pending" ? "interrupted" : "completed", active: options.reviewState === "queued", activeStage: options.reviewState === "queued" ? "queued" : null, activeItemId: null, ownerThreadId: threadId, prompt: "记录日志规范", engine: "codex", model: "gpt-test", effort: "high", reviewConfig: { enabled: true, model: "gpt-second", effort: "low" }, treeHash: "a".repeat(64), proposedTree: null, rationale: "", gaps: [], error: null, scheduler: { limit: 2, running: 2, queued: options.reviewState === "queued" ? 1 : 0 },
    items: [{ id: "item-root", nodeId: "root", title: "功能说明", expectedHash: null, inheritedInstructions: "目录要求", instructions: "记录日志规范", status: "completed", revisionId: "revision-root", executionThreadId: "knowledge-generation-root", error: null, review: { status: options.reviewState === "failed" ? "failed" : ["issues", "stale"].includes(options.reviewState) ? "issues" : "pending", reportId: reports.length ? "review-root" : null, executionThreadId: "knowledge-review-root", error: options.reviewState === "failed" ? { code: "KNOWLEDGE_REVIEW_FAILED", message: "复检服务未完成" } : null, stale: options.reviewState === "stale", staleReasons: options.reviewState === "stale" ? ["来源内容已变化"] : [] } }],
  };
  const discussions: Run[] = [];
  const calls = { connects: [] as RequestBody[], creates: [] as RequestBody[], ends: [] as RequestBody[], generates: [] as RequestBody[], starts: [] as RequestBody[], stops: [] as RequestBody[], sends: [] as RequestBody[], prefs: [] as RequestBody[], imports: [] as RequestBody[], importOffsets: [] as number[], importDirectories: [] as string[], interrupts: [] as RequestBody[], queued: [] as RequestBody[], adopts: [] as RequestBody[], applies: 0 };
  const savedDraftByThreadId = new Map<string, RequestBody>();
  let failBinding = !!options.failBinding;
  let fullSnapshotRequests = 0;
  let eventSeq = 1_000;
  let activeTurnId: string | null = null;
  let eventThreadId = threadId;
  const events: RequestBody[] = [];
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket("**/ws/web**", socket => {
    sockets.add(socket);
    socket.connectToServer();
    socket.onClose(() => sockets.delete(socket));
  });
  const emit = (type: string, payload: RequestBody) => {
    const event = { schema: 1, seq: ++eventSeq, ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: eventThreadId, engine: "codex", type, payload };
    events.push(event);
    for (const socket of sockets) socket.send(JSON.stringify({ t: "conversation.event", event }));
  };
  const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

  await page.route("**/api/engines/status**", route => json(route, { ok: true, catalogVersion: 2, hostAppliedCatalogVersion: 2, hostCatalogSyncState: "applied", engines: [{
    engineType: "codex", installed: true, version: "test", binPath: null, features: { streaming: true, reasoning: true, toolUse: true, sessionContinuation: true, imageInput: true }, error: null,
    credentialStatus: { available: true, source: "local_oauth", message: null }, providerCredentialStatus: [{ providerId: "openai", available: true, sources: ["local_oauth"], message: null }],
    models: ["gpt-test", "gpt-second"].map((id, index) => ({ id, displayName: index ? "测试模型 B" : "测试模型 A", providerId: "openai", isDefault: !index, supportedReasoningEfforts: index && options.secondModelLowOnly ? [{ reasoningEffort: "low", description: "" }] : [{ reasoningEffort: "high", description: "" }, { reasoningEffort: "low", description: "" }], defaultReasoningEffort: index && options.secondModelLowOnly ? "low" : "high" })),
  }] }));
  const prefsByThreadId = new Map<string, RequestBody>();
  await page.route("**/api/threads/prefs", route => {
    const target = String(route.request().postDataJSON().threadId);
    const summary = summaries.find(item => item.threadId === target);
    return json(route, { ok: true, prefs: prefsByThreadId.get(target) ?? { model: summary?.model ?? "gpt-test", effort: summary?.effort ?? "high", accessMode: "read-only" } });
  });
  await page.route("**/api/threads/latest-prefs", route => json(route, { ok: true, prefs: { model: "gpt-test", effort: "high", accessMode: "read-only" } }));
  await page.route("**/api/threads/update-prefs", route => {
    const body = route.request().postDataJSON() as RequestBody;
    calls.prefs.push(body);
    const target = String(body.threadId), summary = summaries.find(item => item.threadId === target);
    prefsByThreadId.set(target, { model: summary?.model ?? "gpt-test", effort: summary?.effort ?? "high", accessMode: "read-only", ...prefsByThreadId.get(target), ...body.prefs as RequestBody });
    return json(route, { ok: true });
  });
  await page.route("**/api/threads/draft/get", route => {
    const body = route.request().postDataJSON() as RequestBody;
    return json(route, { ok: true, draft: savedDraftByThreadId.get(String(body.threadId)) ?? null });
  });
  await page.route("**/api/threads/draft/save", route => {
    const body = route.request().postDataJSON() as RequestBody;
    const threadId = String(body.threadId);
    if (body.draft && typeof body.draft === "object") savedDraftByThreadId.set(threadId, body.draft as RequestBody);
    return json(route, { ok: true, version: 1, updatedAt: Date.now(), updatedByWebSessionId: "e2e" });
  });
  await page.route("**/api/threads/draft/clear", route => {
    const body = route.request().postDataJSON() as RequestBody;
    savedDraftByThreadId.delete(String(body.threadId));
    return json(route, { ok: true });
  });
  await page.route("**/api/threads?**", async route => {
    const response = await route.fetch();
    const result = await response.json();
    const scope = new URL(route.request().url()).searchParams.get("scope");
    result.threads = result.threads.map((item: RequestBody) => summaries.some(s => s.threadId === item.id) ? { ...item, threadSubtype: "knowledge-conversation" } : item)
      .filter((item: RequestBody) => scope === "knowledge" ? item.threadSubtype === "knowledge-conversation" : scope === "current" ? item.threadSubtype !== "knowledge-conversation" : scope === "archived" ? item.archived : true);
    await json(route, result);
  });
  await page.route("**/api/threads/summary", async route => {
    const target = String(route.request().postDataJSON().threadId);
    if (target === ordinaryThreadId) {
      const response = await page.request.post(`${MOCK_URL}/api/threads/load`, { data: { workspaceId: WORKSPACE_ID, threadId: target } });
      const loaded = await response.json();
      return json(route, { ...loaded, visibility: { routeDeepLink: true, threadList: true, embeddedDetail: true, internalRestore: true } });
    }
    const summary = summaries.find(item => item.threadId === target), prefs = prefsByThreadId.get(target);
    return json(route, { ok: true, thread: { ...thread, ...(target.startsWith("knowledge-generation-") || target.startsWith("knowledge-review-") ? { threadType: "orchestration", threadSubtype: "knowledge-assets" } : {}), id: target, engine: summary?.engine ?? thread.engine, model: prefs?.model ?? summary?.model ?? "gpt-test", effort: prefs?.effort ?? summary?.effort ?? "high", accessMode: "read-only" }, visibility: { routeDeepLink: true, threadList: true, embeddedDetail: true, internalRestore: true }, running: activeTurnId ? { runningTurnId: activeTurnId, startedAt: Date.now() } : null });
  });
  await page.route("**/api/threads/load", route => {
    const target = String((route.request().postDataJSON() as RequestBody).threadId);
    if (target === ordinaryThreadId) return route.fallback();
    const summary = summaries.find(item => item.threadId === target), prefs = prefsByThreadId.get(target);
    return json(route, { ok: true, thread: { ...thread, ...(target.startsWith("knowledge-generation-") || target.startsWith("knowledge-review-") ? { threadType: "orchestration", threadSubtype: "knowledge-assets" } : {}), id: target, engine: summary?.engine ?? thread.engine, model: prefs?.model ?? summary?.model ?? "gpt-test", effort: prefs?.effort ?? summary?.effort ?? "high", accessMode: "read-only" }, events: events.filter(event => event.threadId === target), running: activeTurnId && eventThreadId === target ? { runningTurnId: activeTurnId, startedAt: Date.now() } : null });
  });
  await page.route("**/api/threads/send", async route => {
    const body = route.request().postDataJSON() as RequestBody;
    calls.sends.push(body);
    eventThreadId = String(body.threadId);
    activeTurnId = `turn-${calls.sends.length}`;
    const turnId = activeTurnId;
    emit("turn.started", { turnId });
    emit("item.userMessage.created", { turnId, itemId: `user-${turnId}`, clientItemId: body.clientItemId, text: body.text });
    await json(route, { ok: true, turnId, dispatchMode: "chat_turn" });
    if (!options.holdFirstTurn || calls.sends.length > 1) {
      if (options.discussionAfterPlan) discussions.unshift({ ...run!, id: `discussion-${calls.sends.length}`, phase: "completed", active: false, proposedTree: null, items: [], rationale: "已解释划分理由", appliedTreeHash: null });
      emit("item.agentMessage.completed", { turnId, itemId: `agent-${turnId}`, engineMessageId: `engine-${turnId}`, text: `已收到：${body.text}`, revision: 1 });
      emit("turn.completed", { turnId });
      activeTurnId = null;
    }
  });
  await page.route("**/api/turns/interrupt", async route => {
    const body = route.request().postDataJSON() as RequestBody;
    calls.interrupts.push(body);
    if (run?.active) run = { ...run, active: false, phase: "interrupted" };
    emit("turn.completed", { turnId: body.turnId });
    activeTurnId = null;
    await json(route, { ok: true, running: null });
  });
  await page.route("**/api/threads/queue/**", route => {
    if (route.request().url().endsWith("/list")) return json(route, { ok: true, items: [], paused: false });
    calls.queued.push(route.request().postDataJSON() as RequestBody);
    return json(route, { ok: false, message: "知识消息不应进入普通消息队列", code: "UNEXPECTED_QUEUE" }, 400);
  });
  await page.route("**/api/knowledge/assets/**", async route => {
    const action = route.request().url().split("/api/knowledge/assets/")[1]?.split("?")[0] ?? "";
    const body = (route.request().postDataJSON() ?? {}) as RequestBody;
    let data: unknown;
    if (action === "snapshot") {
      const includeStates = new URL(route.request().url()).searchParams.get("includeStates") === "true";
      if (includeStates) fullSnapshotRequests += 1;
      data = snapshot();
      // 模拟状态补齐请求晚于树请求返回旧树，验证它不会把当前资产覆盖成一级概览。
      if (options.staleFullTreeAfterReload && includeStates && fullSnapshotRequests >= 2) {
        const current = data as RequestBody;
        const tree = current.tree as RequestBody;
        const nodes = (tree.nodes as RequestBody[]).filter(node => node.parentId === null);
        data = { ...current, tree: { ...tree, nodes }, treeHash: "c".repeat(64), states: (current.states as RequestBody[]).filter(state => nodes.some(node => node.id === state.nodeId)) };
      }
    }
    else if (action === "search") {
      data = {
        backend: "hybrid_sqlite_fts5_vector",
        vectorBackend: "local_feature_hash_v1",
        items: [{ nodeId: "root", title: "功能说明", excerpt: "成员邀请与权限说明", path: "codeflow-docs/知识库/assets/root", keywordScore: 0.9, vectorScore: 0.8, score: 0.85, matchMode: "hybrid" }],
        issues: [],
      };
    }
    else if (action === "runs") data = [...discussions, ...(run ? [run] : [])];
    else if (action === "run") data = run;
    else if (action === "changes") data = { items: [], nextOffset: null, pendingNodes: [] };
    else if (action === "update.schedule") data = { schedule: null, hash: null, currentClientId: "e2e-client", defaultTimezone: "Asia/Singapore", nextRunAt: null, lastCheck: null, run: null };
    else if (action === "run.preview") data = { runId: run?.id, tree: run?.proposedTree ?? tree(), treeHash: "a".repeat(64), planHash: "b".repeat(64), items: ((run?.items as RequestBody[] | undefined) ?? []).map(item => {
      const review = item.review as RequestBody | undefined;
      const reviewEnabled = ((item.reviewConfig ?? run?.reviewConfig) as RequestBody | undefined)?.enabled;
      const reason = !item.revisionId ? "尚未保存正文" : reviewEnabled && (!review || review.stale || !["passed", "passed_with_warnings"].includes(String(review.status))) ? "正文尚未通过有效复检" : null;
      return { nodeId: item.nodeId, revisionId: item.revisionId, canApply: !reason, reason, applied: false };
    }) };
    else if (action === "conversation.list") data = summaries;
    else if (action === "conversation.connect") {
      calls.connects.push(body);
      if (failBinding) return json(route, { ok: false, code: options.bindingErrorCode ?? "KNOWLEDGE_BINDING_FAILED", message: options.bindingErrorCode ? "会话不属于当前工作区" : "知识协作绑定失败，请重试" }, options.bindingErrorCode ? 404 : 409);
      data = summaries.find(s => s.threadId === body.threadId); if (data) (data as RequestBody).active = true;
    } else if (action === "conversation.create") {
      calls.creates.push(body);
      const response = await page.request.post(`${MOCK_URL}/api/threads/create`, { data: { workspaceId: WORKSPACE_ID, title: body.nodeId ? "目录专题" : "新项目知识会话", engine: body.engine ?? "codex" } });
      const created = await response.json() as { threadId: string };
      data = { ...initialSummary, threadId: created.threadId, nodeId: body.nodeId ?? null, engine: body.engine ?? "codex", model: body.model ?? null, effort: body.effort ?? null, title: body.nodeId ? "目录专题" : "新项目知识会话", active: true };
      summaries.push(data as RequestBody);
    } else if (action === "conversation.end") { calls.ends.push(body); data = summaries.find(s => s.threadId === body.threadId); if (data) (data as RequestBody).active = false; }
    else if (action === "generate") {
      calls.generates.push(body);
      const selected = new Set(body.selectedNodeIds as string[]);
      const targets = nodes.filter(n => selected.has(n.id) || (body.includeDescendants && n.parentId && selected.has(n.parentId))).filter(n => body.mode !== "review" || options.reviewState && n.id === "root");
      run = { schemaVersion: 1, id: "batch-e2e", createdAt: new Date().toISOString(), mode: String(body.mode), nodeId: null, phase: "planned", active: false, ownerThreadId: body.ownerThreadId, selectedNodeIds: body.selectedNodeIds, includeDescendants: body.includeDescendants, strategy: body.strategy, prompt: body.prompt, engine: body.engine, model: body.model, effort: body.effort, concurrency: body.concurrency ?? 2, reviewConfig: body.reviewConfig, treeHash: "a".repeat(64), proposedTree: null, rationale: "固定清单", gaps: [], error: null, activeItemId: null, activeItemIds: [], items: targets.map(n => ({ id: `item-${n.id}`, nodeId: n.id, title: n.title, expectedHash: null, inheritedInstructions: "目录要求", instructions: body.prompt, status: body.mode === "review" ? "completed" : "pending", revisionId: body.mode === "review" ? "revision-root" : null, review: (body.reviewConfig as RequestBody | undefined)?.enabled ? { status: "pending", reportId: null, error: null } : undefined, error: null })) };
      data = run;
    } else if (action === "run.start") {
      calls.starts.push(body);
      const selected = new Set(body.nodeIds as string[] | undefined);
      const items = (run?.items as RequestBody[]).map(item => {
        if (item.status === "completed" || !selected.has(String(item.nodeId)) || (!Object.hasOwn(body, "model") && !Object.hasOwn(body, "effort"))) return item;
        const current = item.executionConfig as { model: unknown; effort: unknown } | undefined;
        return { ...item, executionConfig: {
          model: Object.hasOwn(body, "model") ? body.model : current ? current.model : run?.model,
          effort: Object.hasOwn(body, "effort") ? body.effort : current ? current.effort : run?.effort,
        } };
      });
      run = { ...run!, ...(body.reviewConfig ? { reviewConfig: body.reviewConfig } : {}), items, phase: "generating", active: true, activeStage: items.every(item => item.status === "completed") ? "reviewing" : "generating", activeItemId: items[0]?.id };
      data = run;
    }
    else if (action === "run.stop") { calls.stops.push(body); run = { ...run!, phase: "interrupted", active: false, activeStage: null, activeItemId: null }; data = run; }
    else if (action === "revision.adopt.batch") {
      calls.adopts.push(body); adopted = true; data = snapshot();
    }
    else if (action === "node" || action === "revision.adopt") {
      if (action === "revision.adopt") { calls.adopts.push(body); adopted = true; }
      data = { node: nodes.find(node => node.id === String(body.nodeId)) ?? nodes[0], current: options.reviewState && adopted ? draftDocument : null, currentHash: options.reviewState && adopted ? "d".repeat(64) : null, drafts: options.reviewState && !adopted ? [draftRevision] : [], effectiveInstructions: "", freshness: [] };
    }
    else if (action === "node") {
      const nodeId = new URL(route.request().url()).searchParams.get("nodeId") ?? "";
      // 空知识库场景采用提议后可能还没有正式树节点，按 nodeId 构造可读详情。
      const node = nodes.find(item => item.id === nodeId) ?? { id: nodeId, title: nodeId, parentId: null, contentMode: "generated", category: "specifications" };
      data = {
        node,
        current: {
          revision: { schemaVersion: 1, id: `formal-${node.id}`, nodeId: node.id, createdAt: "2026-10-20T08:00:00Z", origin: "ai", instructions: "", summary: "", baseHash: "h".repeat(64), contentHash: `formal-${node.id}`, sourcesHash: "s".repeat(64), runId: null },
          content: `# formal-${node.id}\n\n正式内容`,
          sources: [],
          path: `codeflow-docs/知识库/assets/${node.id}/current.md`,
        },
        drafts: [],
        reference: null,
      };
    }
    else if (action === "reviews") data = reports;
    else if (action === "revision") data = draftDocument;
    else if (action === "run.apply") {
      calls.applies += 1;
      nodes.splice(0, nodes.length, ...(run?.proposedTree?.nodes ?? []));
      run = run ? { ...run, phase: "completed", proposedTree: null, appliedTreeHash: "a".repeat(64) } : null;
      data = run;
    } else if (action === "imports") {
      const query = new URL(route.request().url()).searchParams;
      const directory = query.get("directory") ?? "", offset = Number(query.get("offset") ?? 0);
      calls.importOffsets.push(offset);
      calls.importDirectories.push(directory);
      if (!directory) return json(route, { ok: true, data: { files: [], directories: ["docs"], nextOffset: null } });
      if (directory !== "docs") return json(route, { ok: false, code: "KNOWLEDGE_ASSET_NOT_FOUND", message: `目录不存在或不是文件夹：${directory}。请检查路径或返回项目根目录。`, details: { requestId: "import-list-e2e", operation: "imports" } }, 404);
      const files = [{ path: "docs/design.md", title: "设计说明", contentHash: "b".repeat(64) }, { path: "docs/guide.txt", title: "使用指南", contentHash: "c".repeat(64) }];
      data = { files: options.paginatedImports ? [files[offset ? 1 : 0]] : files, directories: [], nextOffset: options.paginatedImports && !offset ? 100 : null };
    }
    else if (action === "import") {
      calls.imports.push(body);
      nodes.push(assetNode(String(body.path).includes("guide") ? "import_guide" : "import_design", String(body.path).includes("guide") ? "使用指南" : "设计说明", nodes[0]?.id ?? null));
      data = snapshot();
    } else return json(route, { ok: false, code: "UNEXPECTED_KNOWLEDGE_ACTION", message: action }, 400);
    await json(route, { ok: true, data });
  });
  return {
    threadId, ordinaryThreadId, calls, longTitle, summaries, savedDraftByThreadId,
    setRun: (value: Run) => { run = value; },
    /** 模拟正文尚未交付，调整弹窗可以修改原任务要求。 */
    setPendingItem: () => {
      if (!run) throw new Error("测试任务尚未创建");
      run = { ...run, phase: "interrupted", items: run.items.map(item => ({ ...item, status: "pending", revisionId: null, executionThreadId: null, review: null })) };
    },
    allowBinding: () => { failBinding = false; }, denyBinding: () => { failBinding = true; },
    setItemReview: (review: { enabled: boolean; status: "pending" | "passed" | "failed"; stale?: boolean }) => {
      if (!run) return;
      run = { ...run, phase: "completed", active: false, activeStage: null, items: (run.items as RequestBody[]).map(item => ({ ...item, reviewConfig: { enabled: review.enabled, model: "gpt-second", effort: "low" }, review: { ...(item.review as RequestBody), status: review.status, stale: review.stale ?? false } })) };
    },
    setReviewError: (message: string) => {
      if (!run) return;
      run = { ...run, items: (run.items as RequestBody[]).map(item => item.review ? { ...item, review: { ...(item.review as RequestBody), error: { code: "KNOWLEDGE_ASSET_OPERATION_FAILED", message } } } : item) };
    },
  };
}

/** 阅读用例显式进入文档视图；首次进入概览由独立用例覆盖。 */
async function openKnowledge(page: Page, threadId?: string, initialView: "assets" | "overview" = "assets"): Promise<void> {
  await page.goto(threadId ? `/knowledge?threadId=${threadId}` : `/knowledge?view=${initialView}`);
  await expect(page.locator(".knowledge-page")).toBeVisible();
}

/** 对话面板默认收起，测试需要交互时通过公开入口展开。 */
async function showKnowledgeAssistant(page: Page): Promise<void> {
  const assistant = page.getByTestId("knowledge-assistant");
  // 后台会话可能先于点击自行展开；每次重查当前状态，不点击已消失的 rail。
  await expect(async () => {
    if (!await assistant.isVisible()) {
      const expand = page.locator('button[aria-label="展开 AI 对话"]:visible').first();
      await expand.click({ timeout: 1000 });
    }
    await expect(assistant).toHaveClass(/open/u, { timeout: 1000 });
  }).toPass({ timeout: 8000 });
}

/** 知识助手默认进入文件工作会话；项目讨论相关用例需要显式切回项目讨论。 */
async function openKnowledgeDiscussion(page: Page): Promise<void> {
  await showKnowledgeAssistant(page);
  const discussion = page.getByTestId("knowledge-assistant").getByRole("button", { name: "项目讨论", exact: true });
  if (await discussion.count() && await discussion.first().isVisible()) {
    // 切文件会触发多次重渲染，按钮可能持续重建；直接派发点击避免等待稳定性。
    try { await discussion.first().click({ timeout: 3000 }); }
    catch { if (await discussion.count()) await discussion.first().dispatchEvent("click"); }
  }
}

/** 所有项目共用左侧生成入口，失败后显式恢复原任务。 */
async function startKnowledgeBuild(page: Page): Promise<void> {
  const recover = page.getByRole("button", { name: "恢复生成", exact: true });
  if (await recover.isVisible()) { await recover.click(); return; }
  await page.locator(".page-empty button.ant-btn-primary:not([disabled]):visible, .build-card button.ant-btn-primary:not([disabled]):visible, [data-testid='knowledge-tree'] .tree-batch-button-primary:not([disabled]):visible").first().click();
}

/** 新建规格会话前显式选择 Mock 提供的引擎和具体模型。 */
async function configureMockKnowledgeModel(page: Page): Promise<void> {
  await showKnowledgeAssistant(page);
  const assistant = page.getByTestId("knowledge-assistant");
  if (await assistant.getByRole("button", { name: "项目讨论", exact: true }).count()) await assistant.getByRole("button", { name: "项目讨论", exact: true }).click();
  if (await assistant.getByRole("button", { name: "管理规格会话", exact: true }).count()) await assistant.getByRole("button", { name: "管理规格会话", exact: true }).click();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "规格库构建设置", exact: true });
  await settings.getByRole("combobox", { name: "批量生成引擎", exact: true }).selectOption("codex");
  await settings.getByRole("combobox", { name: "批量生成模型", exact: true }).selectOption("gpt-test");
  await settings.getByRole("button", { name: "保存构建设置", exact: true }).click();
  await expect(settings).not.toBeVisible();
}

/** 同时提供两个引擎，并让 DeepSeek 与 Claude 默认模型不同，验证不会换供应商。 */
async function installKnowledgeEngineCatalog(page: Page, deepseekAvailable = true): Promise<void> {
  await page.route("**/api/engines/status**", route => route.fulfill({ json: { ok: true, catalogVersion: 2, hostAppliedCatalogVersion: 2, hostCatalogSyncState: "applied", engines: [
    { engineType: "codex", installed: true, features: {}, credentialStatus: { available: true }, providerCredentialStatus: [{ providerId: "openai", available: true }], models: [{ id: "gpt-test", displayName: "测试模型 A", providerId: "openai", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], defaultReasoningEffort: "high" }] },
    { engineType: "claude", installed: true, features: {}, credentialStatus: { available: true }, providerCredentialStatus: [{ providerId: "anthropic", available: true }, { providerId: "deepseek", available: deepseekAvailable, message: deepseekAvailable ? null : "DeepSeek 缺少凭据" }], models: [{ id: "claude-test", displayName: "默认 Anthropic", providerId: "anthropic", isDefault: true }, { id: "deepseek-flash", displayName: "DeepSeek Flash", providerId: "deepseek", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], defaultReasoningEffort: "high" }] },
  ] } }));
}

/** 高级和管理操作统一从顶部更多菜单进入。 */
async function openKnowledgeMenu(page: Page, name: string): Promise<void> {
  if (name === "待确认更新") {
    await page.locator(".header-actions").getByRole("button", { name: /^待确认更新/u }).click();
    return;
  }
  await page.getByRole("button", { name: "规格库更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  if (name === "高级生成" || name === "复检所选知识") {
    const settings = page.locator(".batch-advanced");
    await expect(settings).toBeVisible();
    if (!await settings.evaluate(element => (element as HTMLDetailsElement).open)) await settings.locator("summary").click();
  }
}

/** 文档复检和来源使用标题栏的统一更多入口。 */
async function openDocumentMenu(page: Page, name: string): Promise<void> {
  await page.locator(".reading-document .main-head").getByRole("button", { name: /更多操作$/u }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** 更新入口兼容刷新后的面板恢复，避免等待已被面板取代的摘要按钮。 */
async function openGenerationResults(page: Page): Promise<void> {
  const updates = page.getByTestId("knowledge-updates");
  await expect(async () => {
    if (await updates.isVisible() && await updates.getByRole("button", { name: "采用所选内容", exact: true }).count()) return;
    const summary = page.locator(".updates-summary").getByRole("button", { name: "查看更新", exact: true });
    if (await summary.isVisible()) await summary.click({ timeout: 1000 });
    else await openKnowledgeMenu(page, "待确认更新");
    await expect(updates).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}



/** 构建场景只替换知识 API，浏览器仍经过真实入口、组件和原会话鉴权契约。 */
async function installBuildScenario(page: Page, options: { failApplyOnce?: boolean; failMaintenanceOnce?: boolean; claudeOnly?: boolean; generated?: boolean; documentContent?: string; existingDocument?: boolean; specifications?: boolean; secondTopic?: boolean } = {}) {
  const scenario = await installKnowledgeScenario(page, { empty: true, noKnowledge: true });
  // 构建场景显式选择 Mock 提供的引擎，不依赖用户界面的默认引擎偏好。
  await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "codex", model: "gpt-test", effort: "high" })), WORKSPACE_ID);
  const candidateNodes: Node[] = [{ ...assetNode("project", "项目地图"), contentMode: "directory" }, { ...assetNode("guide", "项目说明原文", "project"), contentMode: "reference", reference: { path: "docs/guide.md", adoptedContentHash: "d".repeat(64) } }];
  if (options.generated) candidateNodes.push({ ...assetNode("new-doc", "关键机制", "project"), contentMode: "generated" });
  if (options.secondTopic) candidateNodes.push({ ...assetNode("other-topic", "其他主题"), contentMode: "directory" }, { ...assetNode("other-guide", "其他主题资料", "other-topic"), contentMode: "reference", reference: { path: "docs/other.md", adoptedContentHash: "d".repeat(64) } });
  if (options.specifications) {
    candidateNodes[0] = { ...candidateNodes[0]!, parentId: "knowledge-specifications", appliesTo: ["apps/web"] };
    candidateNodes.unshift(...([ ["specifications", "规格约束"], ["architecture", "系统架构"], ["product", "产品文档"] ] as const).map(([category, title]) => ({ ...assetNode(`knowledge-${category}`, title), contentMode: "directory" as const, category, sourceScope: [] })));
  }
  const candidateTree = { schemaVersion: options.specifications ? 3 : 2, instructions: "", nodes: candidateNodes };
  const revision = { schemaVersion: 1, id: "build-doc-r1", nodeId: "new-doc", createdAt: "2026-10-19T10:00:00Z", origin: "ai", instructions: "", summary: "关键机制说明", baseHash: null, contentHash: "c".repeat(64), sourcesHash: "d".repeat(64), runId: "build-e2e" };
  const document = { revision, content: options.documentContent ?? "# 关键机制正文\n\n采用前仍可查看候选证据。", sources: [], path: "codeflow-docs/知识库/assets/new-doc/revisions/build-doc-r1/content.md" };
  const report = { schemaVersion: 1, id: "build-doc-review", nodeId: "new-doc", revisionId: revision.id, runId: "build-e2e", createdAt: revision.createdAt, contentHash: revision.contentHash, sourcesHash: revision.sourcesHash, instructionsHash: "a".repeat(64), sourceScopeHash: "b".repeat(64), sourceHashes: [], engine: "codex", model: null, effort: null, outcome: "passed", summary: "独立复检已通过", issues: [], sources: [], stale: false, staleReasons: [] };
  let run: Run | null = null, schedule: RequestBody | null = null, adopted = false, partial = false, sourceChanged = false;
  let maintenanceFailed = false;
  const applies: RequestBody[] = [], saves: RequestBody[] = [], cancels: RequestBody[] = [], dismisses: RequestBody[] = [], reads: URL[] = [];
  const discussions: Run[] = [];
  const dismissed = new Set<string>();
  let cancelled = false;
  /** 快照只投影已生效节点，未采用候选由任务预览提供。 */
  const visibleNodes = () => adopted ? candidateNodes : cancelled ? candidateNodes.filter(node => node.id === "project") : options.existingDocument ? candidateNodes.filter(node => node.id !== "guide") : [];
  const fulfill = (route: Route, data: unknown) => route.fulfill({ json: { ok: true, data } });
  if (options.claudeOnly) await page.route("**/api/engines/status**", route => route.fulfill({ json: { ok: true, catalogVersion: 2, hostAppliedCatalogVersion: 2, hostCatalogSyncState: "applied", engines: [{ engineType: "claude", installed: true, version: "test", binPath: null, features: { streaming: true, reasoning: true, toolUse: true, sessionContinuation: true, imageInput: true }, credentialStatus: { available: true, source: "local_oauth", message: null }, providerCredentialStatus: [{ providerId: "anthropic", available: true, sources: ["local_oauth"], message: null }], models: [{ id: "claude-test", displayName: "Claude 测试模型", isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: null }], error: null }] } }));
  await page.route("**/api/knowledge/assets/**", async route => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    const body = (route.request().postDataJSON() ?? {}) as RequestBody;
    if (action === "snapshot") return fulfill(route, { initialized: true, knowledgeId: "build-kb", root: "codeflow-docs/知识库", tree: { schemaVersion: visibleNodes().length ? 2 : 1, instructions: "", nodes: visibleNodes() }, treeHash: visibleNodes().length ? "e".repeat(64) : null, canWrite: true, states: visibleNodes().map(node => ({ nodeId: node.id, revisionId: adopted && node.id === "new-doc" ? revision.id : null, draftCount: !adopted && node.id === "new-doc" ? 1 : 0, error: null })) });
    if (action === "runs") return fulfill(route, [...discussions, ...(run ? [run] : [])]);
    if (action === "run") return fulfill(route, run);
    if (action === "generate") {
      scenario.calls.generates.push(body);
      run = { schemaVersion: 1, id: "build-e2e", createdAt: new Date().toISOString(), mode: "build", nodeId: null, phase: "planned", active: false,
        ownerThreadId: body.ownerThreadId, engine: body.engine, model: body.model, effort: body.effort, selectedNodeIds: body.selectedNodeIds, includeDescendants: true, prompt: "", treeHash: null, proposedTree: null,
        baseTree: { schemaVersion: 1, instructions: "", nodes: [] }, rationale: "已有项目说明足够，建立引用，无需复制正文。", gaps: [], error: null, items: [], activeItemId: null, reviewConfig: body.reviewConfig };
      return fulfill(route, run);
    }
    if (action === "run.start") { scenario.calls.starts.push(body); run = { ...run!, active: true, phase: "planning" }; return fulfill(route, run); }
    if (action === "run.stop") { scenario.calls.stops.push(body); run = { ...run!, active: false, phase: "interrupted" }; return fulfill(route, run); }
    if (action === "run.preview") return fulfill(route, { runId: run?.id, tree: candidateTree, treeHash: adopted ? "e".repeat(64) : null, planHash: "f".repeat(64), items: candidateNodes.map(node => ({ nodeId: node.id, revisionId: node.id === "new-doc" ? revision.id : null, canApply: !adopted && !partial && !dismissed.has(node.id) && !(cancelled && node.id === "project"), reason: partial ? "已写入部分文件，请恢复原采用" : null, applied: adopted || cancelled && node.id === "project", dismissed: dismissed.has(node.id) })) });
    if (action === "node") {
      const url = new URL(route.request().url()); reads.push(url);
      const id = url.searchParams.get("nodeId");
      const node = candidateNodes.find(node => node.id === id)!;
      if (!url.searchParams.has("runId") && !visibleNodes().some(node => node.id === id)) return route.fulfill({ status: 404, json: { ok: false, code: "KNOWLEDGE_ASSET_NOT_FOUND", message: "正式节点不存在" } });
      return fulfill(route, { node, current: adopted && id === "new-doc" ? document : null, currentHash: adopted && id === "new-doc" ? revision.contentHash : null, drafts: !adopted && id === "new-doc" ? [revision] : [], effectiveInstructions: "", freshness: [], ...(node.contentMode === "reference" ? { reference: { path: node.reference!.path, content: (sourceChanged ? "# 已更新的项目说明\n\n读取最新原文。" : `# ${node.title}\n\n直接引用现有资料。`) + "\n\n[阅读补充](./more.md)\n\n![架构图](./diagram.png)", contentHash: sourceChanged ? "c".repeat(64) : "d".repeat(64), readAt: Date.now(), state: sourceChanged ? "changed" : "unchanged" } } : {}) });
    }
    if (action === "revision") { reads.push(new URL(route.request().url())); return fulfill(route, document); }
    if (action === "reviews") { reads.push(new URL(route.request().url())); return fulfill(route, [report]); }
    if (action === "revision.dismiss") {
      dismisses.push(body);
      for (const node of candidateNodes) {
        let current: string | null = node.id;
        while (current) {
          if (current === String(body.nodeId)) { dismissed.add(node.id); break; }
          current = candidateNodes.find(parent => parent.id === current)?.parentId ?? null;
        }
      }
      run = { ...run!, dismissals: candidateNodes.filter(node => dismissed.has(node.id)).map(node => ({ nodeId: node.id, revisionId: node.id === "new-doc" ? revision.id : null, userId: "chat-core-e2e-user", createdAt: Date.now() })) };
      return fulfill(route, run);
    }
    if (action === "run.cancelAdoption") {
      cancels.push(body); cancelled = true; partial = false;
      for (const node of candidateNodes) if (node.id !== "project") dismissed.add(node.id);
      run = { ...run!, adoptions: (run!.adoptions as RequestBody[]).map(receipt => ({ ...receipt, cancelled: true, cancelledAt: Date.now(), cancelledBy: "chat-core-e2e-user", appliedNodeIds: ["project"] })), dismissals: candidateNodes.filter(node => dismissed.has(node.id)).map(node => ({ nodeId: node.id, revisionId: node.id === "new-doc" ? revision.id : null, userId: "chat-core-e2e-user", createdAt: Date.now() })) };
      return fulfill(route, run);
    }
    if (action === "run.apply") {
      applies.push(body);
      const receipt = { requestId: body.requestId, treeHash: body.treeHash, planHash: body.planHash, selections: body.selections, completed: true, error: null };
      if (options.failApplyOnce && applies.length === 1) {
        partial = true; run = { ...run!, adoptions: [{ ...receipt, completed: false, error: { code: "E2E_WRITE_FAILED", message: "模拟采用中断" } }] };
        return route.fulfill({ status: 500, json: { ok: false, code: "E2E_WRITE_FAILED", message: "模拟采用中断，部分文件已写入", details: { requestId: "build-apply-failed" } } });
      }
      if (partial) {
        const original = (run!.adoptions as RequestBody[])[0]!;
        expect(body).toMatchObject({ requestId: original.requestId, treeHash: original.treeHash, planHash: original.planHash, selections: original.selections });
      }
      adopted = true; partial = false; run = { ...run!, adoptions: [receipt], appliedTreeHash: "e".repeat(64) };
      return fulfill(route, run);
    }
    if (action === "update.schedule") return fulfill(route, { schedule, hash: schedule ? "schedule-hash" : null, currentClientId: "build-client", defaultTimezone: "Asia/Singapore", nextRunAt: null, lastCheck: null, run: null });
    if (action === "update.save") {
      saves.push(body);
      if (options.failMaintenanceOnce && !maintenanceFailed) { maintenanceFailed = true; return route.fulfill({ status: 500, json: { ok: false, code: "E2E_MAINTENANCE_FAILED", message: "模拟维护计划保存失败" } }); }
      schedule = { ...(body.schedule as RequestBody), schemaVersion: 1, id: "build-schedule", executorClientId: "build-client", selectedWorkspaceId: WORKSPACE_ID, updatedAt: Date.now() };
      return fulfill(route, { schedule, hash: "schedule-hash", currentClientId: "build-client", defaultTimezone: "Asia/Singapore", nextRunAt: null, lastCheck: null, run: null });
    }
    return route.fallback();
  });
  return { ...scenario, applies, saves, cancels, dismisses, reads, complete: () => { run = { ...run!, phase: "completed", active: false, proposedTree: candidateTree, items: options.generated ? [{ id: "build-doc", nodeId: "new-doc", title: "关键机制", status: "completed", expectedHash: null, inheritedInstructions: "", instructions: "", revisionId: revision.id, executionThreadId: "build-work-thread", error: null, review: { status: "passed", reportId: report.id, error: null } }] : [] }; }, asReview: (formal = false) => { run = { ...run!, mode: "review", proposedTree: null }; adopted = formal; },
    /** 构建已规划新文档但正文未交付，供原任务恢复入口验证。 */
    interruptWithPendingItem: () => { if (!run) throw new Error("测试任务尚未创建"); run = { ...run, phase: "interrupted", active: false, proposedTree: candidateTree,
      items: [{ id: "build-doc", nodeId: "new-doc", title: "关键机制", status: "pending", expectedHash: null, inheritedInstructions: "", instructions: "", revisionId: null, executionThreadId: null, error: null }] }; },
    /** 构建候选正文已交付但复检失败，正式树尚无此节点。 */
    interruptWithFailedReview: () => { if (!run) throw new Error("测试任务尚未创建"); run = { ...run, phase: "interrupted", active: false, proposedTree: candidateTree,
      items: [{ id: "build-doc", nodeId: "new-doc", title: "关键机制", status: "completed", expectedHash: null, inheritedInstructions: "", instructions: "", revisionId: revision.id, executionThreadId: "build-work-thread", error: null,
        review: { status: "failed", reportId: null, error: { code: "KNOWLEDGE_REVIEW_FAILED", message: "复检失败" } } }] }; },
    // 模拟工作会话续聊产生的附属修订记录，正文与复检的权威归属仍是原构建。
    addExecutionDiscussion: () => { discussions.unshift({ ...run!, id: "execution-discussion", createdAt: new Date(Date.now() + 1000).toISOString(), mode: "conversation", threadId: "build-work-thread", ownerThreadId: "build-work-thread", nodeId: "new-doc", proposedTree: null, items: (run!.items as RequestBody[]).map(item => ({ ...item, review: undefined, executionThreadId: undefined })) }); },
    changeSource: () => { sourceChanged = true; } };
}

/** 浏览器点击真实入口，模型完成事实由场景显式推进。 */
async function completeBuild(page: Page, scenario: Awaited<ReturnType<typeof installBuildScenario>>): Promise<void> {
  await openKnowledge(page);
  await startKnowledgeBuild(page);
  await expect.poll(() => scenario.calls.starts.length).toBe(1);
  await expect(page.locator(".task-summary")).toContainText("文档生成中");
  scenario.complete();
  await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "项目地图", exact: true })).toBeVisible({ timeout: 10_000 });
  await openGenerationResults(page);
  await expect(page.getByTestId("knowledge-build-preview")).toBeVisible({ timeout: 10_000 });
}

/** 多来源场景保留真实公开接口：每份候选有独立任务、正文和采用回执。 */
async function installUnifiedUpdatesScenario(page: Page, options: { multiple?: boolean; proposal?: boolean; failSecond?: boolean; standalone?: boolean; candidate?: Partial<Node> } = {}) {
  const scenario = await installKnowledgeScenario(page, { noKnowledge: true });
  const nodes: Node[] = [
    { ...assetNode("specs", "规格约束"), contentMode: "directory", category: "specifications" },
    { ...assetNode("doc-a", "项目约定", "specs"), contentMode: "generated" },
    { ...assetNode("doc-b", "编码规范", "specs"), contentMode: "generated" },
  ];
  const current = new Map<string, string>([["doc-a", "formal-a"], ["doc-b", "formal-b"]]);
  const manualContent = new Map<string, string>();
  const manualSource = new Map<string, { runId: string; revisionId: string }>();
  const tree = { schemaVersion: 3, instructions: "", nodes };
  /** 候选结构独立于正式树，模拟正文与节点属性在同一任务中变化。 */
  const makeRun = (id: string, nodeId: string, revisionId: string, date: string): Run => ({ schemaVersion: 1, id, createdAt: date, mode: options.standalone ? "conversation" : "batch", threadId: options.standalone ? `thread-${id}` : undefined, nodeId: null, engine: "codex", model: "gpt-test", effort: "high", prompt: "", treeHash: "a".repeat(64), baseTree: tree,
    proposedTree: options.candidate && nodeId === "doc-a" ? { ...tree, nodes: nodes.map(node => node.id === nodeId ? { ...node, ...options.candidate } : node) } : null,
    rationale: "", gaps: [], phase: "completed", active: false, activeItemId: null, error: null, items: [{ id: `item-${id}`, nodeId, title: nodes.find(node => node.id === nodeId)!.title, status: "completed", revisionId, expectedHash: `formal-${nodeId === 'doc-a' ? 'a' : 'b'}`, inheritedInstructions: "", instructions: "", reviewConfig: { enabled: false }, error: null }] });
  const runs = [makeRun("run-a", "doc-a", "candidate-a", "2026-10-20T08:00:00Z"), makeRun("run-b", "doc-b", "candidate-b", "2026-10-19T08:00:00Z")];
  if (options.multiple) runs.unshift(makeRun("run-a-new", "doc-a", "candidate-a-new", "2026-10-21T08:00:00Z"));
  if (options.standalone) {
    runs[0]!.items = [...runs[0]!.items as RequestBody[], ...runs[1]!.items as RequestBody[]];
    runs.splice(1);
  }
  const allItems = () => runs.flatMap(run => run.items as RequestBody[]);
  const isAdopted = (nodeId: string, revisionId: string) => runs.some(run => (run.adoptions ?? []).some(receipt =>
    ((receipt as RequestBody).completed || ((receipt as RequestBody).appliedNodeIds as string[] | undefined)?.includes(nodeId))
      && ((receipt as RequestBody).selections as RequestBody[]).some(selection => selection.nodeId === nodeId && selection.revisionId === revisionId)));
  const drafts = (nodeId: string) => allItems().filter(item => item.nodeId === nodeId && item.revisionId && item.revisionId !== current.get(nodeId) && !isAdopted(nodeId, String(item.revisionId)));
  const document = (nodeId: string, revisionId: string) => ({ revision: { schemaVersion: 1, id: revisionId, nodeId, createdAt: "2026-10-20T08:00:00Z", origin: revisionId.startsWith("manual-") ? "manual" : "ai", instructions: "", summary: "", baseHash: `formal-${nodeId === 'doc-a' ? 'a' : 'b'}`, contentHash: revisionId, sourcesHash: "s", runId: runs.find(run => (run.items as RequestBody[]).some(item => item.revisionId === revisionId))?.id }, content: revisionId.startsWith("manual-") ? manualContent.get(nodeId)! : `# ${revisionId.startsWith('formal') ? '正式内容' : '候选内容'}\n\n${revisionId}`, sources: [], path: `codeflow-docs/知识库/assets/${nodeId}/revisions/${revisionId}/content.md` });
  const proposal = { schemaVersion: 1, id: "proposal-a", nodeId: "doc-a", title: "项目约定", summary: "来自普通会话的修改", createdAt: "2026-10-21T09:00:00Z", updatedAt: "2026-10-21T09:00:00Z", status: "pending", origin: "chat", baseHash: "formal-a", baseContent: document("doc-a", "formal-a").content, content: "# 会话建议正文", sources: [], instructions: "", reviewedAt: null, reviewedBy: null, reviewNote: "", revisionId: null, hash: "proposal-hash", currentContent: document("doc-a", "formal-a").content, stale: false, staleReasons: [] };
  const writes: RequestBody[] = [], approvals: RequestBody[] = [], saves: RequestBody[] = [];
  let pendingProposal = Boolean(options.proposal);
  await page.route("**/api/knowledge/assets/**", route => {
    const url = new URL(route.request().url()), action = url.pathname.split("/").at(-1);
    const body = (route.request().postDataJSON() ?? {}) as RequestBody;
    const reply = (data: unknown) => route.fulfill({ json: { ok: true, data } });
    const run = runs.find(run => run.id === (url.searchParams.get("runId") ?? body.runId));
    if (action === "snapshot") return reply({ initialized: true, knowledgeId: "unified", root: "codeflow-docs/知识库", tree, treeHash: "a".repeat(64), canWrite: true, states: nodes.map(node => ({ nodeId: node.id, revisionId: current.get(node.id) ?? null, draftCount: drafts(node.id).length, error: null })) });
    if (action === "runs") return reply(runs);
    if (action === "run") return reply(run);
    if (action === "run.preview") return reply({ runId: run!.id, tree: run!.proposedTree ?? tree, treeHash: "a".repeat(64), planHash: "b".repeat(64), items: (run!.items as RequestBody[]).map(item => {
      const applied = Boolean(item.revisionId && current.get(String(item.nodeId)) === item.revisionId) || ((run!.adoptions ?? []) as RequestBody[]).some(receipt => receipt.completed && (receipt.selections as RequestBody[]).some(selection => selection.nodeId === item.nodeId && selection.revisionId === item.revisionId));
      return { nodeId: item.nodeId, revisionId: item.revisionId, canApply: !applied, reason: null, applied };
    }) });
    if (action === "node") {
      const nodeId = url.searchParams.get("nodeId")!;
      return reply({ node: nodes.find(node => node.id === nodeId), current: current.has(nodeId) ? document(nodeId, current.get(nodeId)!) : null, sourceRevision: manualSource.get(nodeId) ?? null, currentHash: current.get(nodeId) ?? null, drafts: drafts(nodeId).map(item => document(nodeId, String(item.revisionId)).revision), effectiveInstructions: "", freshness: [] });
    }
    if (action === "revision") return reply(document(url.searchParams.get("nodeId")!, url.searchParams.get("revisionId")!));
    if (action === "reviews") return reply([]);
    if (action === "run.apply" || action === "revision.adopt") {
      writes.push(body);
      const selections = action === "revision.adopt" ? [{ nodeId: body.nodeId, revisionId: body.revisionId }] : body.selections as RequestBody[];
      if (options.failSecond && selections.some(item => item.nodeId === "doc-b")) return route.fulfill({ status: 409, json: { ok: false, code: "E2E_CANDIDATE_CONFLICT", message: "编码规范版本冲突", details: { requestId: "unified-conflict" } } });
      for (const selection of selections) if (selection.revisionId) current.set(String(selection.nodeId), String(selection.revisionId));
      if (action === "revision.adopt") return reply({ node: nodes.find(node => node.id === body.nodeId), current: document(String(body.nodeId), String(body.revisionId)), currentHash: body.revisionId, drafts: [], effectiveInstructions: "", freshness: [] });
      run!.adoptions = [...((run!.adoptions ?? []) as RequestBody[]).filter(receipt => receipt.requestId !== body.requestId), { ...body, completed: true }];
      return reply(run);
    }
    if (action === "changes") return reply({ items: pendingProposal ? [proposal] : [], nextOffset: null, pendingNodes: pendingProposal ? [{ nodeId: "doc-a", title: "项目约定", count: 1 }] : [] });
    if (action === "change") return reply(proposal);
    if (action === "change.review") {
      approvals.push(body); pendingProposal = false;
      if (body.decision === "approve") { current.set("doc-a", "manual-proposal-a"); manualContent.set("doc-a", proposal.content); }
      return reply({ ...proposal, status: body.decision === "approve" ? "approved" : "rejected", revisionId: body.decision === "approve" ? "manual-proposal-a" : null });
    }
    if (action === "document.save") { saves.push(body); current.set(String(body.nodeId), `manual-${body.nodeId}`); manualContent.set(String(body.nodeId), String(body.content)); return reply(document(String(body.nodeId), `manual-${body.nodeId}`).revision); }
    if (action === "update.schedule") return reply({ schedule: { enabled: false }, hash: "schedule", currentClientId: "test-client", defaultTimezone: "Asia/Shanghai", nextRunAt: null, lastCheck: null, run: null });
    return route.fallback();
  });
  return { ...scenario, writes, approvals, saves, current, manualContent, manualSource, proposal, runs, nodes };
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const dimensions = await locator.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
}

/** 抽屉滑入期间等待边界稳定，持续溢出仍使断言失败。 */
async function expectInside(child: Locator, parent: Locator): Promise<void> {
  await expect(async () => {
    const childBox = await child.boundingBox();
    const parentBox = await parent.boundingBox();
    expect(childBox).not.toBeNull(); expect(parentBox).not.toBeNull();
    expect(childBox!.x).toBeGreaterThanOrEqual(parentBox!.x - 1);
    expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(parentBox!.x + parentBox!.width + 1);
    expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(parentBox!.y + parentBox!.height + 1);
  }).toPass({ timeout: 8000 });
}
/** 核验实际输入控件的暗色样式，不依赖可选清除按钮生成的包装节点。 */
async function useDarkTheme(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => page.locator(".composer__textarea").evaluate(element => {
    const rgb = getComputedStyle(element).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    return rgb.reduce((sum, value) => sum + value, 0) / 3;
  })).toBeGreaterThan(180);
  await expect.poll(async () => page.getByTestId("knowledge-search").locator("input.ant-input").evaluate(element => {
    const rgb = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    return rgb.reduce((sum, value) => sum + value, 0) / 3;
  })).toBeLessThan(80);
}

test.describe("项目知识库资产协作", () => {
  test("PK-overview 初次进入展示真实概览，显式文件深链和概览恢复各自保留", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    await page.goto("/knowledge");
    const overview = page.getByTestId("knowledge-overview");
    await expect(overview).toBeVisible();
    await expect(overview).toContainText("现行文档");
    await expect(overview).toContainText("规格文档复检不等于代码验收");
    await expect(page.locator(".header-actions").getByRole("button", { name: "完善规格", exact: true })).toBeVisible();
    await expect(page.locator(".header-actions").getByRole("button", { name: "规格对话", exact: true })).toBeVisible();
    expect(scenario.writes).toHaveLength(0);
    await page.goto(`/knowledge?workspaceId=${WORKSPACE_ID}&nodeId=doc-b`);
    await expect(page.locator("div.document")).toContainText("formal-b");
    await expect(overview).toHaveCount(0);
    await page.getByRole("button", { name: "项目概览", exact: true }).click();
    await expect(overview).toBeVisible();
    await page.reload();
    await expect(overview).toBeVisible();
    await expect(page.locator("div.document")).toHaveCount(0);
  });

  test("PK-overview-empty 空库与只读概览提供明确操作边界", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page, { empty: true });
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ json: { ok: true, data: { initialized: false, knowledgeId: null, root: "codeflow-docs/知识库", tree: { schemaVersion: 3, instructions: "", nodes: [] }, treeHash: null, canWrite: false, states: [] } } }));
    await openKnowledge(page, undefined, "overview");
    const overview = page.getByTestId("knowledge-overview");
    await expect(overview).toContainText("建立项目的研发依据");
    await expect(overview.getByRole("button", { name: /从项目完善/u })).toBeDisabled();
    await expect(overview.getByRole("button", { name: /通过对话补充/u })).toBeDisabled();
    await expect(page.locator(".header-actions").getByRole("button", { name: "规格对话", exact: true })).toBeDisabled();
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
  });

  test("PK-overview-thread 显式概览保留讨论深链，刷新后不被会话自动选正文覆盖", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { currentDocument: true, reviewState: "issues" });
    await openKnowledge(page, scenario.threadId);
    await expect(page.locator(".document-title")).toContainText("功能说明");
    await page.getByRole("button", { name: "项目概览", exact: true }).click();
    await expect(page.getByTestId("knowledge-overview")).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("threadId")).toBe(scenario.threadId);
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("overview");
    await page.reload();
    await expect(page.getByTestId("knowledge-overview")).toBeVisible();
    await expect(page.locator("div.document")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-assistant")).toHaveClass(/open/u);
    expect(new URL(page.url()).searchParams.get("threadId")).toBe(scenario.threadId);
  });

  test("PK-overview-review 复检依据过期显示真实问题并可定位到文档", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page, { reviewState: "stale", currentDocument: true });
    await openKnowledge(page, undefined, "overview");
    const overview = page.getByTestId("knowledge-overview");
    await expect(overview).toContainText("复检依据需核对");
    await expect(overview).toContainText("来源内容已变化");
    await overview.getByRole("button", { name: "查看详情", exact: true }).click();
    await expect(page.locator(".document-title")).toContainText("功能说明");
  });

  test("PK-overview-mobile 手机概览与目录导航保持内容内滚动", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installSession(page);
    await installUnifiedUpdatesScenario(page);
    await page.goto("/knowledge");
    const overview = page.getByTestId("knowledge-overview");
    await expect(overview).toBeVisible();
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
    await expect(overview).toHaveCSS("overflow", "auto");
    await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    const tree = page.getByTestId("knowledge-tree");
    await expect(tree).toBeVisible();
    await tree.getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(tree).toBeHidden();
    await expect(page.locator("div.document")).toContainText("formal-a");
    await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    await tree.getByRole("button", { name: "项目概览", exact: true }).click();
    await expect(overview).toBeVisible();
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
  });

  test("PK-change-recheck 过期建议携带原文回规格对话，不直接覆盖正式文档", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { proposal: true });
    Object.assign(scenario.proposal, { stale: true, staleReasons: ["正式正文已更新"] });
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "codex", model: "gpt-test", effort: "high" })), WORKSPACE_ID);
    await page.goto(`/knowledge?workspaceId=${WORKSPACE_ID}&changeId=proposal-a&view=approvals`);
    const inbox = page.getByTestId("knowledge-change-inbox");
    await expect(inbox).toContainText("正式正文已更新");
    await inbox.getByRole("button", { name: "对照最新正文重新整理", exact: true }).click();
    const input = page.getByTestId("knowledge-assistant").locator(".composer__textarea");
    await expect(input).toHaveValue(/原提案：proposal-a/u);
    await expect(input).toHaveValue(/会话建议正文/u);
    expect(scenario.approvals).toHaveLength(0);
    expect(scenario.writes).toHaveLength(0);
    expect(scenario.calls.sends).toHaveLength(0);
  });

  test("PK-change-history 已处理建议可以从记录入口查看确切决策", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { proposal: true });
    const reviewed = { ...scenario.proposal, status: "rejected", reviewedAt: "2026-11-19T08:00:00Z", reviewedBy: "reviewer", reviewNote: "保留现行要求，不采用此建议" };
    await page.route("**/api/knowledge/assets/changes?**", route => {
      const status = new URL(route.request().url()).searchParams.get("status");
      return route.fulfill({ json: { ok: true, data: { items: status === "all" || status === "rejected" ? [reviewed] : [], nextOffset: null, pendingNodes: [] } } });
    });
    await page.route("**/api/knowledge/assets/change?**", route => route.fulfill({ json: { ok: true, data: reviewed } }));
    await openKnowledge(page, undefined, "overview");
    await openKnowledgeMenu(page, "修改建议记录");
    const history = page.locator(".ant-drawer-content:visible").filter({ has: page.getByText("修改建议记录", { exact: true }) });
    await history.getByRole("combobox", { name: "筛选审批状态", exact: true }).selectOption("rejected");
    await expect(history).toContainText("保留现行要求，不采用此建议");
    await expect(history).toContainText("已拒绝");
    await expect(history.getByRole("button", { name: "批准并采用", exact: true })).toHaveCount(0);
    expect(scenario.approvals).toHaveLength(0);
  });

  test("PK-overview-pending-cache 显式概览不恢复旧待确认目标", async ({ page }) => {
    await installSession(page);
    await installUnifiedUpdatesScenario(page, { proposal: true });
    await page.goto(`/knowledge?workspaceId=${WORKSPACE_ID}&changeId=proposal-a&view=approvals`);
    await expect(page.getByTestId("knowledge-change-inbox")).toContainText("会话建议正文");
    await expect.poll(() => page.evaluate(workspaceId => {
      const state = JSON.parse(sessionStorage.getItem(`knowledge-page-state:v2:${encodeURIComponent(workspaceId)}`) || "null");
      return Boolean(state?.updatesTarget);
    }, WORKSPACE_ID)).toBe(true);
    await page.goto(`/knowledge?workspaceId=${WORKSPACE_ID}&view=overview`);
    await expect(page.getByTestId("knowledge-overview")).toBeVisible();
    await expect(page.getByTestId("knowledge-updates")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-change-inbox")).toHaveCount(0);
  });

  test("PK-change-recheck-workspace 等待重新整理期间切换工作区不污染新会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { proposal: true });
    Object.assign(scenario.proposal, { stale: true, staleReasons: ["正式正文已更新"] });
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "codex", model: "gpt-test", effort: "high" })), WORKSPACE_ID);
    const nextWorkspace = "workspace-recheck-next";
    const created = await page.request.post(`${MOCK_URL}/api/threads/create`, { data: { workspaceId: nextWorkspace, title: "新工作区规格会话", engine: "codex" } });
    const { threadId: nextThreadId } = await created.json() as { threadId: string };
    const nextConversation = { threadId: nextThreadId, nodeId: null, createdByUserId: "chat-core-e2e-user", title: "新工作区规格会话", engine: "codex", model: "gpt-test", effort: "high", active: true, createdAt: Date.now(), updatedAt: Date.now() };
    await page.route("**/api/threads/load", async route => {
      if (route.request().postDataJSON().threadId !== nextThreadId) return route.fallback();
      const response = await page.request.post(`${MOCK_URL}/api/threads/load`, { data: { workspaceId: nextWorkspace, threadId: nextThreadId } });
      return route.fulfill({ json: await response.json() });
    });
    await page.route("**/api/workspaces?**", route => route.fulfill({ json: { ok: true, workspaces: [
      { id: WORKSPACE_ID, title: "原规格项目", path: "D:/e2e-workspace", kind: "local", createdAt: 1, updatedAt: 1 },
      { id: nextWorkspace, title: "新的规格项目", path: "D:/next-knowledge", kind: "local", createdAt: 1, updatedAt: 1 },
    ], workspaceListAuthoritative: true } }));
    await page.route("**/api/knowledge/assets/**", route => {
      const url = new URL(route.request().url());
      const body = route.request().postDataJSON() as RequestBody | null;
      if ((url.searchParams.get("workspaceId") ?? body?.workspaceId) !== nextWorkspace) return route.fallback();
      const action = url.pathname.split("/").at(-1);
      const data = action === "snapshot" ? { initialized: true, canWrite: true, treeHash: null, states: [], tree: { schemaVersion: 3, instructions: "", nodes: [] } }
        : action === "changes" ? { items: [], pendingNodes: [], nextOffset: null }
        : action === "conversation.list" ? [nextConversation] : action === "conversation.connect" ? nextConversation : [];
      return route.fulfill({ json: { ok: true, data } });
    });
    let release!: () => void, waiting = false, returned = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/conversation.create", async route => {
      waiting = true;
      await gate;
      await route.fallback();
      returned = true;
    });
    await page.goto(`/knowledge?workspaceId=${WORKSPACE_ID}&changeId=proposal-a&view=approvals`);
    await expect(page.getByTestId("knowledge-change-inbox").getByRole("button", { name: "对照最新正文重新整理", exact: true })).toBeVisible();
    // 调用已挂载组件的真实处理函数，保留其 Promise，以便精确等待 A 的迟到处理结束。
    await page.evaluate(proposal => {
      let component = (document.querySelector(".knowledge-page") as any).__vueParentComponent;
      while (component && !component.setupState?.recheckKnowledgeChange) component = component.parent;
      if (!component) throw new Error("找不到规格页组件状态");
      (window as any).__pendingKnowledgeRecheck = component.setupState.recheckKnowledgeChange(proposal);
    }, scenario.proposal);
    await expect.poll(() => waiting).toBe(true);
    await page.locator(".ws-compact-trigger").click();
    await page.locator(".ws-compact-option").filter({ hasText: "新的规格项目" }).click();
    await expect(page.getByLabel("规格库所属项目", { exact: true })).toHaveText("新的规格项目");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目概览", exact: true }).click();
    // 在真实组件内设置连接已完成的边界状态，避免把 B 的引擎回放夹具混入跨工作区隔离断言。
    const before = await page.evaluate(({ nextWorkspace, nextThreadId, nextConversation }) => {
      let component = (document.querySelector(".knowledge-page") as any).__vueParentComponent;
      while (component && !component.setupState?.recheckKnowledgeChange) component = component.parent;
      if (!component) throw new Error("找不到规格页组件状态");
      const state = component.setupState;
      if (state.workspaceId !== nextWorkspace) throw new Error("工作区切换尚未完成");
      state.conversations = [nextConversation];
      state.assistantThreadId = nextThreadId;
      state.boundNodeId = null;
      state.bindingReady = true;
      state.bindingError = null;
      state.assistantOpen = false;
      return state.composer.externalActionTick as number;
    }, { nextWorkspace, nextThreadId, nextConversation });
    release();
    await expect.poll(() => returned).toBe(true);
    await page.evaluate(async () => { await (window as any).__pendingKnowledgeRecheck; delete (window as any).__pendingKnowledgeRecheck; });
    await expect.poll(() => page.evaluate(() => {
      let component = (document.querySelector(".knowledge-page") as any).__vueParentComponent;
      while (component && !component.setupState?.recheckKnowledgeChange) component = component.parent;
      if (!component) throw new Error("找不到规格页组件状态");
      return { tick: component.setupState.composer.externalActionTick, error: component.setupState.bindingError };
    })).toEqual({ tick: before, error: null });
    expect(scenario.calls.sends).toHaveLength(0);
  });

  test("PK-navigation 目录树统一导航，选择目录后优先打开正式文档并恢复实际阅读文件", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 920 });
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.current.delete("doc-a");
    await openKnowledge(page, undefined, "overview");
    const tree = page.getByTestId("knowledge-tree"), main = page.locator(".knowledge-page main");
    await expect(page.getByTestId("knowledge-overview")).toBeVisible();
    await tree.getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-b");
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("编码规范");
    await expect(page.locator(".document-title h2")).toHaveText("规格约束 / 编码规范");
    await expect(page.locator(".overview, .directory-heading, .directory-file-list")).toHaveCount(0);
    await expect(tree.getByLabel("规格库统计")).toContainText("已有 1");
    const body = (await page.locator(".reading-document").boundingBox())!, bounds = (await main.boundingBox())!;
    expect(body.width).toBeCloseTo(bounds.width, 0);
    await tree.getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-b");
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("编码规范");
    await page.reload();
    await expect(page.locator("div.document")).toContainText("formal-b");
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("编码规范");
    expect(scenario.writes).toHaveLength(0);
    await showKnowledgeAssistant(page);
    await page.screenshot({ path: test.info().outputPath("knowledge-navigation.png"), animations: "disabled" });
  });

  test("PK-navigation-legacy 旧目录内阅读记录迁移为单一文件定位", async ({ page }) => {
    await installSession(page);
    await installUnifiedUpdatesScenario(page);
    await page.evaluate(workspaceId => sessionStorage.setItem(`knowledge-page-state:v2:${encodeURIComponent(workspaceId)}`, JSON.stringify({ selectedId: "specs", directoryPreviewId: "doc-b", viewTab: "node" })), WORKSPACE_ID);
    await openKnowledge(page);
    await expect(page.locator("div.document")).toContainText("formal-b");
    await expect(page.getByTestId("knowledge-tree").locator(".asset-tree-row.selected")).toContainText("编码规范");
    await expect.poll(() => page.evaluate(workspaceId => JSON.parse(sessionStorage.getItem(`knowledge-page-state:v2:${encodeURIComponent(workspaceId)}`)!), WORKSPACE_ID)).toMatchObject({ selectedId: "doc-b" });
    await page.reload();
    await expect(page.locator("div.document")).toContainText("formal-b");
  });

  test("PK-navigation-candidates 只有候选时进入预览，多版本仍由用户明确选择", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { multiple: true });
    scenario.current.clear();
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".update-row")).toHaveCount(2);
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    await expect(page.getByTestId("knowledge-tree").locator(".asset-tree-row.selected")).toContainText("项目约定");
    await updates.getByRole("button", { name: /项目约定/ }).last().click();
    await expect(updates.locator(".revision-diff .editor.modified")).toContainText("candidate-a");
    expect(scenario.writes).toHaveLength(0);
  });

  test("PK-navigation-directory-actions 目录菜单限定批量范围，不受当前正文选择影响", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-a");
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "规格约束目录操作", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "生成此目录", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "复检此目录", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "查看此目录更新", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".update-row")).toHaveCount(2);
    await expect(updates.getByRole("button", { name: "采用所选内容", exact: true })).toBeVisible();
    expect(scenario.writes).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
  });

  test("PK-navigation-keyboard 上下键跨目录浏览，首尾导航不会被父目录重定向", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.nodes.push({ ...assetNode("system", "系统架构"), contentMode: "directory", category: "architecture" }, { ...assetNode("doc-c", "架构总览", "system"), contentMode: "generated" });
    scenario.current.set("doc-c", "formal-c");
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree"), viewport = tree.getByRole("tree");
    await tree.getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("项目约定");
    await tree.getByRole("button", { name: "系统架构", exact: true }).click();
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("架构总览");
    await viewport.focus();
    for (const title of ["编码规范", "项目约定"]) {
      await viewport.press("ArrowUp");
      await expect(tree.locator(".asset-tree-row.selected")).toContainText(title);
    }
    await viewport.press("End");
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("架构总览");
    await viewport.press("Home");
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("项目约定");
    for (const title of ["编码规范", "架构总览"]) {
      await viewport.press("ArrowDown");
      await expect(tree.locator(".asset-tree-row.selected")).toContainText(title);
    }
  });

  for (const kind of ["discussion", "execution"] as const) test(`PK-navigation-deeplink-${kind} 迟到状态自动选文档时保留指定会话，主动切文件后再映射`, async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    if (kind === "discussion") scenario.summaries.push({ threadId: scenario.threadId, nodeId: null, createdByUserId: "chat-core-e2e-user", title: "项目规格讨论", engine: "codex", model: "gpt-test", effort: "high", active: true, createdAt: Date.now(), updatedAt: Date.now() });
    (scenario.runs[1]!.items as RequestBody[])[0]!.executionThreadId = "work-second-file";
    let release!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/snapshot?**", async route => {
      if (new URL(route.request().url()).searchParams.get("includeStates") === "true") { waiting = true; await gate; return route.fallback(); }
      return route.fulfill({ json: { ok: true, data: { initialized: true, knowledgeId: "unified", root: "codeflow-docs/知识库", tree: { schemaVersion: 3, instructions: "", nodes: scenario.nodes }, treeHash: "a".repeat(64), canWrite: true, states: [] } } });
    });
    const query = kind === "discussion" ? `threadId=${scenario.threadId}` : "executionThreadId=work-second-file";
    await page.goto(`/knowledge?${query}`);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    await expect.poll(() => waiting).toBe(true);
    const title = kind === "discussion" ? "✦ 规格协作" : "知识工作会话 · 编码规范";
    await expect(assistant.getByRole("heading", { level: 2 })).toHaveText(title);
    release();
    await expect(page.locator("div.document")).toContainText("formal-a");
    await expect(assistant.getByRole("heading", { level: 2 })).toHaveText(title);
    await expect(page).toHaveURL(new RegExp(query));
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "编码规范", exact: true }).click();
    await expect(assistant).toContainText("当前文件版本尚无可用的生成会话记录");
    await expect(assistant.getByRole("button", { name: "项目讨论", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.has("executionThreadId")).toBe(false);
  });

  test("PK-navigation-states-error 状态补齐失败停止加载，显式重试后保留概览并可选择正文", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    let fail = true;
    await page.route("**/api/knowledge/assets/snapshot?**", route => {
      if (new URL(route.request().url()).searchParams.get("includeStates") === "true") return fail
        ? route.fulfill({ status: 500, json: { ok: false, code: "E2E_STATES_FAILED", message: "模拟状态补齐失败", details: { requestId: "states-error-test" } } }) : route.fallback();
      return route.fulfill({ json: { ok: true, data: { initialized: true, knowledgeId: "unified", root: "codeflow-docs/知识库", tree: { schemaVersion: 3, instructions: "", nodes: scenario.nodes }, treeHash: "a".repeat(64), canWrite: true, states: [] } } });
    });
    await openKnowledge(page, undefined, "overview");
    const main = page.locator(".knowledge-page main");
    await expect(main.getByRole("alert")).toContainText("模拟状态补齐失败");
    await expect(main.getByRole("alert")).toContainText("states-error-test");
    await expect(main.locator(".node-loading")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true })).toBeVisible();
    fail = false;
    await main.getByRole("button", { name: "重新读取状态", exact: true }).click();
    await expect(page.getByTestId("knowledge-overview")).toBeVisible();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-a");
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-tree").getByLabel("规格库统计")).toContainText("已有 2");
  });

  test("PK-navigation-states-stale 已有正文时状态刷新失败仍可见，重试不会打断阅读", async ({ page }) => {
    await installSession(page);
    await installUnifiedUpdatesScenario(page);
    let fail = true;
    await page.route("**/api/knowledge/assets/snapshot?**", route => {
      if (new URL(route.request().url()).searchParams.get("includeStates") !== "true" || !fail) return route.fallback();
      return route.fulfill({ status: 500, json: { ok: false, code: "E2E_STATES_FAILED", message: "模拟状态刷新失败" } });
    });
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-a");
    const retry = page.getByTestId("knowledge-tree").getByRole("button", { name: "状态读取失败，重试", exact: true });
    await expect(retry).toBeVisible();
    fail = false;
    const refreshed = page.waitForResponse(response => response.url().includes("/api/knowledge/assets/snapshot?") && new URL(response.url()).searchParams.get("includeStates") === "true" && response.ok());
    await retry.click();
    await refreshed;
    await expect(retry).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("formal-a");
  });

  test("PK-navigation-adopted-session 人工编辑已采纳正文后仍映射原生成会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.current.set("doc-a", "manual-current");
    scenario.manualContent.set("doc-a", "# 人工编辑后的正式文档\n\nmanual-current");
    scenario.manualSource.set("doc-a", { runId: "conversation-source", revisionId: "candidate-a" });
    scenario.runs[0]!.adoptions = [{ requestId: "adopted-request", treeHash: null, planHash: "adopted-plan",
      selections: [{ nodeId: "doc-a", revisionId: "candidate-a" }], targetTree: { schemaVersion: 3, instructions: "", nodes: scenario.nodes },
      targetTreeHash: "adopted-tree", completed: true, error: null, appliedNodeIds: ["doc-a"] }];
    scenario.runs[0]!.items[0]!.executionThreadId = "adopted-document-work";
    scenario.runs.push({ ...scenario.runs[0]!, id: "conversation-source", mode: "conversation", threadId: "adopted-document-work", ownerThreadId: undefined,
      adoptions: [], items: [{ ...scenario.runs[0]!.items[0]!, executionThreadId: null }] });
    await page.route("**/api/threads/load", route => {
      if (route.request().postDataJSON().threadId !== "adopted-document-work") return route.fallback();
      return route.fulfill({ json: { ok: true, thread: { id: "adopted-document-work", workspaceId: WORKSPACE_ID, title: "项目约定生成", engine: "codex", threadType: "orchestration", threadSubtype: "knowledge-assets", model: "gpt-test", effort: "high", accessMode: "read-only", planMode: false, archived: false, createdAt: 1, updatedAt: 1 }, running: null,
        events: [{ schema: 1, seq: 1, ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: "adopted-document-work", engine: "codex", type: "item.agentMessage.completed", payload: { itemId: "generated-message", text: "已核对项目约定的来源", revision: 1 } }] } });
    });
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("manual-current");
    await showKnowledgeAssistant(page);
    await expect(page.getByTestId("knowledge-assistant").getByRole("heading", { level: 2 })).toHaveText("知识工作会话 · 项目约定");
    await expect(page.getByTestId("knowledge-assistant")).toContainText("已核对项目约定的来源");
  });

  test("PK-resize 文档与会话分界线支持双向拖动、取消和视口约束", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await installSession(page);
    await installKnowledgeScenario(page, { noKnowledge: true });
    await openKnowledge(page);
    await showKnowledgeAssistant(page);
    const assistant = page.getByTestId("knowledge-assistant");
    const handle = page.getByTestId("knowledge-assistant-resize-handle");
    const main = page.locator(".knowledge-page .main");
    await expect(handle).toHaveAttribute("aria-label", "调整 AI 对话宽度");
    const initialWidth = (await assistant.boundingBox())!.width;
    const initialHeight = (await main.boundingBox())!.height;

    /** 用真实指针操作验证方向与拖动结束后的宽度。 */
    async function dragBoundary(delta: number, cancel = false): Promise<void> {
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + 100, { steps: 5 });
      if (cancel) await handle.dispatchEvent("pointercancel", { pointerId: 1 });
      await page.mouse.up();
    }

    await dragBoundary(-100);
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBeCloseTo(initialWidth + 100, 0);
    await dragBoundary(80);
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBeCloseTo(initialWidth + 20, 0);
    await dragBoundary(-60, true);
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBeCloseTo(initialWidth + 20, 0);
    await expect(page.locator(".knowledge-page .layout--resizing")).toHaveCount(0);

    await assistant.getByRole("button", { name: "收起", exact: true }).click();
    await expect(handle).toHaveCount(0);
    await showKnowledgeAssistant(page);
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBeCloseTo(initialWidth + 20, 0);
    await handle.focus();
    await handle.press("ArrowLeft");
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBeCloseTo(initialWidth + 36, 0);
    await handle.press("ArrowRight");
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBeCloseTo(initialWidth + 20, 0);
    await handle.press("Home");
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBe(320);
    await dragBoundary(500);
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBe(320);
    await dragBoundary(-1000);
    const expandedWidth = (await assistant.boundingBox())!.width;
    expect(expandedWidth).toBeLessThanOrEqual(700);
    expect((await main.boundingBox())!.width).toBeGreaterThanOrEqual(360);

    await page.setViewportSize({ width: 1150, height: 900 });
    await expect.poll(async () => (await main.boundingBox())!.width).toBeGreaterThanOrEqual(360);
    await page.setViewportSize({ width: 1366, height: 900 });
    await expect.poll(async () => (await assistant.boundingBox())!.width).toBe(expandedWidth);
    expect((await main.boundingBox())!.height).toBe(initialHeight);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(handle).toHaveCount(0);
    await page.getByRole("button", { name: "AI 对话", exact: true }).click();
    await expect(assistant).toBeVisible();
    expect((await assistant.boundingBox())!.width).toBeLessThanOrEqual(390);
  });

  test("PK-unified-build 统一目录阅读与集中确认，采用使用确切版本和必要祖先", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true, secondTopic: true });
    await completeBuild(page, scenario);
    await expect(page.getByRole("button", { name: "知识浏览", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "待处理", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "查看任务记录" })).toHaveCount(0);
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".updates-heading")).toContainText("3 篇文档");
    await expect(updates.locator(".updates-heading")).toContainText("5 项结构调整");
    await updates.getByRole("button", { name: /项目地图.*结构调整/ }).click();
    await expect(updates.locator(".preview-toolbar h3")).toHaveText("项目地图");
    await updates.getByRole("button", { name: /关键机制.*生成修订/ }).click();
    await updates.getByRole("tab", { name: "完整内容", exact: true }).click();
    await expect(updates).toContainText("关键机制正文");
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect.poll(() => scenario.applies.length).toBe(1);
    expect((scenario.applies[0]!.selections as RequestBody[]).find(item => item.nodeId === "new-doc")).toEqual({ nodeId: "new-doc", revisionId: "build-doc-r1" });
    expect((scenario.applies[0]!.selections as RequestBody[]).map(item => item.nodeId)).toContain("project");
    await expect.poll(() => scenario.saves.length).toBe(1);
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("关键机制正文");
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "项目地图");
    await tree.getByRole("button", { name: "项目地图", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "目录文档列表", exact: true })).toHaveCount(0);
    await tree.getByRole("button", { name: "关键机制", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("关键机制正文");
    await tree.getByRole("button", { name: "关键机制", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "目录文档列表", exact: true })).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("关键机制正文");
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
  });

  test("PK-unified-single 单文件采纳后加载正式正文，保留工作会话和刷新定位", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true, secondTopic: true });
    await completeBuild(page, scenario);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "项目地图");
    await tree.getByRole("button", { name: "关键机制", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates).toContainText("尚未采用，未生效");
    await expect(updates.getByRole("complementary", { name: "待确认更新清单" })).toHaveCount(0);
    await page.reload();
    await expect(updates).toContainText("1 篇文档");
    await expect(updates.getByRole("complementary", { name: "待确认更新清单" })).toHaveCount(0);
    expect(scenario.reads.filter(url => url.searchParams.get("nodeId") === "new-doc").every(url => url.searchParams.get("runId") === "build-e2e")).toBe(true);
    await showKnowledgeAssistant(page);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant).toContainText("知识工作会话 · 关键机制");
    await assistant.locator(".composer__textarea").fill("采用后继续完善这份文档");
    let release!: () => void;
    await page.route("**/api/knowledge/assets/node?**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("nodeId") !== "new-doc" || url.searchParams.has("runId")) return route.fallback();
      await new Promise<void>(resolve => { release = resolve; });
      await route.fallback();
    });
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect.poll(() => scenario.applies.length).toBe(1);
    expect(scenario.applies[0]!.selections).toEqual(expect.arrayContaining([{ nodeId: "project", revisionId: null }, { nodeId: "new-doc", revisionId: "build-doc-r1" }]));
    expect(scenario.applies[0]!.selections).toHaveLength(2);
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(page.locator(".reading-document > .node-loading")).toBeVisible();
    await expect(updates).toBeHidden();
    await expect(page.locator("div.document")).toHaveCount(0);
    await expect(assistant).toContainText("正在加载文件会话");
    await tree.getByRole("button", { name: "项目地图", exact: true }).click();
    await expect(updates).toBeHidden();
    await expect(page.locator(".reading-document > .node-loading")).toBeVisible();
    await page.unroute("**/api/knowledge/assets/node?**");
    release();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("关键机制正文");
    await expect(page.locator(".document-title")).toContainText("已确认采用");
    await expect(assistant).toContainText("知识工作会话 · 关键机制");
    await expect(assistant.locator(".composer__textarea")).toHaveValue("采用后继续完善这份文档");
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    await page.reload();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("关键机制正文");
    const fileConversationSwitch = assistant.getByRole("button", { name: "文件会话", exact: true });
    if (await fileConversationSwitch.isVisible()) await fileConversationSwitch.click();
    await expect(assistant).toContainText("知识工作会话 · 关键机制");
    expect(scenario.applies).toHaveLength(1);
  });

  test("PK-unified-run-retry 失败复检在主页面按原任务重试", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "failed" });
    await openKnowledge(page, scenario.threadId);
    const summary = page.locator(".task-summary");
    await expect(summary.getByRole("button", { name: "重试失败项", exact: true })).toBeVisible();
    await expect(summary.getByRole("button", { name: "调整未完成项要求", exact: true })).toBeVisible();
    await summary.getByRole("button", { name: "重试失败项", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.starts[0]).toEqual({ workspaceId: WORKSPACE_ID, runId: "batch-e2e", retryFailed: true });
  });

  test("PK-unified-run-adjust 未完成项调整仍提交原任务", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "pending" });
    scenario.setPendingItem();
    await openKnowledge(page, scenario.threadId);
    await page.locator(".task-summary").getByRole("button", { name: "调整未完成项要求", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "确认批量生成", exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole("textbox", { name: "批量生成要求", exact: true }).fill("重点检查失败边界");
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.starts[0]).toMatchObject({ workspaceId: WORKSPACE_ID, runId: "batch-e2e", nodeIds: ["root"] });
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.creates).toHaveLength(0);
  });

  test("PK-unified-run-adjust-review 已交付正文只调整原任务复检配置", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "failed" });
    await openKnowledge(page, scenario.threadId);
    await page.locator(".task-summary").getByRole("button", { name: "调整未完成项要求", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "复检已有文档", exact: true });
    await expect(modal.getByRole("textbox", { name: "批量生成要求", exact: true })).toHaveCount(0);
    await modal.getByRole("combobox", { name: "最大复检轮次", exact: true }).selectOption("3");
    await modal.getByRole("button", { name: "开始复检", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.starts[0]).toMatchObject({ workspaceId: WORKSPACE_ID, runId: "batch-e2e", nodeIds: ["root"], reviewConfig: { maxRounds: 3 } });
    expect(scenario.calls.starts[0]).not.toHaveProperty("prompt");
    expect(scenario.calls.starts[0]).not.toHaveProperty("model");
    expect(scenario.calls.starts[0]).not.toHaveProperty("effort");
  });

  test("PK-unified-run-adjust-build 构建中断后调整候选新文档沿用原任务", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    scenario.interruptWithPendingItem();
    await page.reload();
    await page.locator(".task-summary").getByRole("button", { name: "调整未完成项要求", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "确认批量生成", exact: true });
    await expect(modal).toContainText("关键机制");
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(2);
    expect(scenario.calls.starts[1]).toMatchObject({ workspaceId: WORKSPACE_ID, runId: "build-e2e", nodeIds: ["new-doc"] });
    expect(scenario.calls.generates).toHaveLength(1);
  });

  test("PK-unified-run-adjust-build-review 候选新文档复检失败仍可调整配置", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    scenario.interruptWithFailedReview();
    await page.reload();
    await page.locator(".task-summary").getByRole("button", { name: "调整未完成项要求", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "复检已有文档", exact: true });
    await expect(modal).toContainText("关键机制");
    await modal.getByRole("button", { name: "开始复检", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(2);
    expect(scenario.calls.starts[1]).toMatchObject({ workspaceId: WORKSPACE_ID, runId: "build-e2e", nodeIds: ["new-doc"] });
    expect(scenario.calls.starts[1]).not.toHaveProperty("prompt");
  });

  test("PK-adopt-transition 采用期间持续加载，候选刷新后不闪现对比页", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.current.delete("doc-a");
    await page.goto("/knowledge?nodeId=doc-a");
    const reading = page.locator(".reading-document");
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".diff-editor.is-ready")).toBeVisible();
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeEnabled();
    const initialHeight = (await reading.boundingBox())!.height;
    let releasePreview!: () => void, releaseNode!: () => void, releaseReports!: () => void;
    const preview = new Promise<void>(resolve => { releasePreview = resolve; });
    const node = new Promise<void>(resolve => { releaseNode = resolve; });
    const reports = new Promise<void>(resolve => { releaseReports = resolve; });
    let waitingPreview = false, waitingNode = false, waitingReports = false;
    await page.route("**/api/knowledge/assets/run.preview?**", async route => {
      if (new URL(route.request().url()).searchParams.get("runId") === "run-a" && scenario.current.get("doc-a") === "candidate-a") {
        waitingPreview = true; await preview;
      }
      await route.fallback();
    });
    await page.route("**/api/knowledge/assets/node?**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("nodeId") === "doc-a" && !url.searchParams.has("runId") && scenario.current.get("doc-a") === "candidate-a") {
        waitingNode = true; await node;
      }
      await route.fallback();
    });
    await page.route("**/api/knowledge/assets/reviews?**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("nodeId") === "doc-a" && !url.searchParams.has("runId") && scenario.current.get("doc-a") === "candidate-a") {
        waitingReports = true; await reports;
      }
      await route.fallback();
    });
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect.poll(() => waitingPreview).toBe(true);
    await expect(reading.locator(":scope > .node-loading")).toBeVisible();
    await expect(updates).toBeHidden();
    releasePreview();
    await expect.poll(() => waitingNode).toBe(true);
    await expect(reading.locator(":scope > .node-loading")).toBeVisible();
    await expect(updates).toBeHidden();
    releaseNode();
    await expect.poll(() => waitingReports).toBe(true);
    await expect(reading.locator(":scope > .node-loading")).toBeVisible();
    await expect(updates).toBeHidden();
    expect((await reading.boundingBox())!.height).toBe(initialHeight);
    releaseReports();
    await expect(updates).toHaveCount(0);
    await expect(reading.locator("div.document")).toContainText("candidate-a");
    await expect(reading.locator(":scope > .node-loading")).toHaveCount(0);
    expect((await reading.boundingBox())!.height).toBe(initialHeight);
    expect(scenario.writes).toHaveLength(1);
  });

  test("PK-generating-status 活动候选显示生成中并从待确认统计中分开", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { standalone: true, candidate: { title: "项目约定候选" } });
    const activeRun = scenario.runs.find(run => run.id === "run-a")!;
    Object.assign(activeRun, { active: true, phase: "generating", activeItemId: null, activeItemIds: [], activeItemStages: [{ itemId: "item-run-a", stage: "generating" }] });
    await openKnowledge(page);
    await expandKnowledgeDirectory(page, "规格约束");
    const tree = page.getByTestId("knowledge-tree");
    const activeNode = tree.getByRole("treeitem").filter({ hasText: "项目约定" });
    await expect(activeNode.locator(".generating-status")).toContainText("生成中");
    const statistics = page.locator('footer[aria-label="规格库统计"]');
    await expect(statistics).toContainText("生成中 1");
    await expect(statistics).toContainText("待确认 1");

    await openKnowledgeMenu(page, "待确认更新");
    const updates = page.getByTestId("knowledge-updates");
    const candidate = updates.locator(".update-row").filter({ hasText: "项目约定" });
    await expect(candidate).toContainText("生成中");
    await expect(candidate.locator(".row-reason")).toHaveText("生成中");
    await candidate.getByRole("button").click();
    await expect(updates.locator(".candidate-status")).toHaveText("生成中");
    await expect(updates.locator(".updates-processing")).toContainText("生成中");
  });

  test("PK-adopt-read-failure 采纳已生效但正式读取失败时保留预览，禁止重复提交", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    await expandKnowledgeDirectory(page, "规格约束");
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await page.route("**/api/knowledge/assets/node?**", route => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("runId") || url.searchParams.get("nodeId") !== "doc-a" || scenario.current.get("doc-a") !== "candidate-a") return route.fallback();
      return route.fulfill({ status: 503, json: { ok: false, code: "E2E_ADOPTED_READ_FAILED", message: "正式正文暂时无法读取", details: { requestId: "adopted-read-failed" } } });
    });
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect(updates).toContainText("已采用 1 项更新，页面读取失败");
    await expect(updates.locator(".candidate-status")).toHaveText("已采用，已生效");
    await updates.getByRole("tab", { name: "完整内容", exact: true }).click();
    await expect(updates.getByRole("tabpanel", { name: "完整内容", exact: true })).toContainText("candidate-a");
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toHaveCount(0);
    expect(scenario.current.get("doc-a")).toBe("candidate-a");
    expect(scenario.writes).toHaveLength(1);
    await page.unroute("**/api/knowledge/assets/node?**");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("candidate-a");
    expect(scenario.writes).toHaveLength(1);
  });

  test("PK-adopt-partial 批量部分采纳保留剩余清单，全部完成后直接显示正文", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.getByRole("checkbox", { name: /采用 编码规范/ })).toBeChecked();
    await updates.getByRole("checkbox", { name: /采用 编码规范/ }).uncheck();
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect(updates.locator(".update-row")).toHaveCount(1);
    await expect(updates.locator(".update-row")).toContainText("编码规范");
    await expect(updates.getByRole("button", { name: "采用所选内容", exact: true })).not.toHaveClass(/ant-btn-loading/u);
    await updates.getByRole("checkbox", { name: /采用 编码规范/ }).check();
    await expect(updates.getByRole("button", { name: "采用所选内容", exact: true })).toBeEnabled();
    expect(scenario.writes).toHaveLength(1);
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("candidate-b");
    expect(scenario.writes).toHaveLength(2);
  });

  test("PK-adopt-proposal 会话建议采纳后退出候选并显示正式版本", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { proposal: true });
    await openKnowledge(page);
    await expandKnowledgeDirectory(page, "规格约束");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目约定", exact: true }).click();
    await page.getByRole("button", { name: "查看更新 2", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await updates.locator(".update-row").filter({ hasText: "普通会话" }).getByRole("button").click();
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("会话建议正文");
    await expect(page.locator(".document-title")).toContainText("有待采用版本");
    expect(scenario.approvals).toHaveLength(1);
    expect(scenario.writes).toHaveLength(0);
  });

  test("PK-adopt-deeplink 批量采纳完成后同步旧文件深链，刷新仍阅读刚采用的文件", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.runs.splice(0, 1);
    await page.goto("/knowledge?nodeId=doc-a&view=results");
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("candidate-b");
    expect(new URL(page.url()).searchParams.get("nodeId")).toBe("doc-b");
    expect(new URL(page.url()).searchParams.has("view")).toBe(false);
    await page.reload();
    await expect(page.locator("div.document")).toContainText("candidate-b");
    expect(scenario.writes).toHaveLength(1);
  });

  test("PK-adopt-directory 目录结构采用成功时未生成子文档不造成页面读取失败", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.current.clear();
    scenario.runs.splice(1);
    const run = scenario.runs[0]!;
    run.items = [{ id: "directory-specs", nodeId: "specs", title: "规格约束", status: "completed", revisionId: null, reviewConfig: { enabled: false }, error: null }];
    const baseline = run.baseTree as { schemaVersion: number; instructions: string; nodes: Node[] };
    run.proposedTree = { ...baseline, nodes: baseline.nodes.map(node => node.id === "specs" ? { ...node, summary: "已核对目录适用范围" } : node) };
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect(updates).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "目录文档列表", exact: true })).toHaveCount(0);
    await expect(page.locator(".main-head")).toContainText("规格约束");
    await expect(page.locator(".knowledge-page > .page-error")).toHaveCount(0);
    expect(scenario.writes).toHaveLength(1);
    expect(scenario.writes[0]!.selections).toEqual([{ nodeId: "specs", revisionId: null }]);
  });

  for (const recovery of ["adoption", "maintenance"] as const) test(`PK-adopt-receipts-${recovery} 无候选行时恢复本次操作，历史回执不抢占正文定位`, async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    const run = scenario.runs[0]!;
    run.items = [...run.items as RequestBody[], ...scenario.runs[1]!.items as RequestBody[]];
    scenario.runs.splice(1);
    scenario.current.set("doc-a", "candidate-a"); scenario.current.set("doc-b", "candidate-b");
    run.adoptions = [
      { requestId: "previous-a", treeHash: "a".repeat(64), planHash: "b".repeat(64), selections: [{ nodeId: "doc-a", revisionId: "candidate-a" }], completed: true },
      { requestId: "current-b", treeHash: "a".repeat(64), planHash: "b".repeat(64), selections: [{ nodeId: "doc-b", revisionId: "candidate-b" }], completed: recovery === "maintenance" },
    ];
    let scheduled = recovery === "adoption";
    const maintenanceSaves: RequestBody[] = [];
    /** 项目计划独立于采用回执，恢复维护时只改变计划保存结果。 */
    const scheduleView = () => ({ schedule: scheduled ? { enabled: false } : null, hash: scheduled ? "schedule" : null, currentClientId: "test-client", defaultTimezone: "Asia/Shanghai", nextRunAt: null, lastCheck: null, run: null });
    await page.route("**/api/knowledge/assets/update.schedule**", route => route.fulfill({ json: { ok: true, data: scheduleView() } }));
    await page.route("**/api/knowledge/assets/update.save", route => {
      maintenanceSaves.push(route.request().postDataJSON()); scheduled = true;
      return route.fulfill({ json: { ok: true, data: scheduleView() } });
    });
    await openKnowledge(page);
    await page.locator(".task-summary").getByRole("button", { name: "恢复未完成操作", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".update-row")).toHaveCount(0);
    await updates.getByRole("button", { name: recovery === "adoption" ? "重试未完成采用" : "重试保存计划", exact: true }).click();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("candidate-b");
    expect(scenario.writes).toHaveLength(recovery === "adoption" ? 1 : 0);
    expect(maintenanceSaves).toHaveLength(recovery === "maintenance" ? 1 : 0);
    if (recovery === "adoption") expect(scenario.writes[0]!.requestId).toBe("current-b");
  });

  test("PK-adopt-cancel-history 本次采用失败后原地取消，不把历史完成回执当作本次成功", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    const run = scenario.runs[0]!;
    run.items = [...run.items as RequestBody[], ...scenario.runs[1]!.items as RequestBody[]];
    scenario.runs.splice(1);
    scenario.current.set("doc-a", "candidate-a");
    run.adoptions = [{ requestId: "previous-a", treeHash: "a".repeat(64), planHash: "b".repeat(64), selections: [{ nodeId: "doc-a", revisionId: "candidate-a" }], completed: true }];
    let cancelled = false;
    await page.route("**/api/knowledge/assets/run.apply", route => {
      const body = route.request().postDataJSON();
      run.adoptions = [...run.adoptions as RequestBody[], { ...body, completed: false }];
      return route.fulfill({ status: 500, json: { ok: false, code: "E2E_APPLY_INTERRUPTED", message: "本次采用中断", details: { requestId: body.requestId } } });
    });
    await page.route("**/api/knowledge/assets/run.cancelAdoption", route => {
      const body = route.request().postDataJSON();
      run.adoptions = (run.adoptions as RequestBody[]).map(receipt => receipt.requestId === body.requestId ? { ...receipt, cancelled: true } : receipt);
      run.dismissals = [{ nodeId: "doc-b", revisionId: "candidate-b", userId: "chat-core-e2e-user", createdAt: Date.now() }];
      cancelled = true;
      return route.fulfill({ json: { ok: true, data: run } });
    });
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await updates.getByRole("button", { name: "终止本次采用", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "终止本次采用", exact: true }).click();
    await expect.poll(() => cancelled).toBe(true);
    await expect(updates.getByRole("button", { name: "重试未完成采用", exact: true })).toHaveCount(0);
    await expect(updates.locator(".updates-loading, .preview-loading")).toHaveCount(0);
    await expect(updates).toBeVisible();
    await expect(page.locator("div.document")).toHaveCount(0);
    expect(scenario.current.get("doc-b")).toBe("formal-b");
  });

  test("PK-preview-loading-candidate 正文先于整批核对展示，复用父预览且核对前禁止采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "项目地图");
    let releaseMetadata!: () => void, releaseDocument!: () => void;
    const metadata = new Promise<void>(resolve => { releaseMetadata = resolve; });
    const document = new Promise<void>(resolve => { releaseDocument = resolve; });
    let waitingMetadata = false, waitingDocument = false, previewRequests = 0, runRequests = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/knowledge/assets/run") runRequests++; });
    await page.route("**/api/knowledge/assets/run.preview?**", async route => {
      previewRequests++; waitingMetadata = true; await metadata; await route.fallback();
    });
    await page.route("**/api/knowledge/assets/revision?**", async route => {
      waitingDocument = true; await document; await route.fallback();
    });
    await tree.getByRole("button", { name: "关键机制", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect.poll(() => waitingDocument).toBe(true);
    await expect(updates.locator(".preview-loading")).toBeVisible();
    await expect(updates.locator(".updates-empty, .preview-empty, .revision-diff")).toHaveCount(0);
    releaseDocument();
    await expect(updates.locator(".revision-diff")).toBeVisible();
    await expect.poll(() => waitingMetadata).toBe(true);
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    await expect(updates.locator(".updates-loading, .preview-loading")).toHaveCount(0);
    releaseMetadata();
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeEnabled();
    await expect(updates.getByTestId("knowledge-build-preview")).toContainText("关键机制");
    await expect(updates.locator(".updates-loading, .preview-loading, .updates-empty")).toHaveCount(0);
    expect(previewRequests).toBe(1);
    expect(runRequests).toBe(0);
  });

  test("PK-preview-validation-error 正文已显示但整批校验失败时明确报错并禁止采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    await expandKnowledgeDirectory(page, "项目地图");
    await page.route("**/api/knowledge/assets/run.preview?**", route => route.fulfill({ status: 409, json: { ok: false, code: "KNOWLEDGE_ASSET_CONFLICT", message: "整批校验失败，请重新核对", details: { requestId: "preview-validation-e2e" } } }));
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "关键机制", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".revision-diff")).toBeVisible();
    await expect(updates.getByRole("alert")).toContainText("整批校验失败，请重新核对");
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    expect(scenario.applies).toHaveLength(0);
  });

  test("PK-preview-loading-file 普通节点判定候选期间不展示正文页，迟到读取不覆盖新文件", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.current.delete("doc-a");
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    let releaseNode!: () => void, releaseReports!: () => void;
    const node = new Promise<void>(resolve => { releaseNode = resolve; });
    const reports = new Promise<void>(resolve => { releaseReports = resolve; });
    let waitingNode = false, waitingReports = false;
    await page.route("**/api/knowledge/assets/node?**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("nodeId") === "doc-a" && !url.searchParams.has("runId")) { waitingNode = true; await node; }
      await route.fallback();
    });
    await page.route("**/api/knowledge/assets/reviews?**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("nodeId") === "doc-a" && !url.searchParams.has("runId")) { waitingReports = true; await reports; }
      await route.fallback();
    });
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    const reading = page.locator(".reading-document");
    await expect.poll(() => waitingNode).toBe(true);
    await expect(reading.locator(":scope > .node-loading")).toBeVisible();
    await expect(reading.locator(".main-head, div.document, .node-empty")).toHaveCount(0);
    releaseNode();
    await expect.poll(() => waitingReports).toBe(true);
    await expect(reading.locator(":scope > .node-loading")).toBeVisible();
    await expect(reading.locator(".main-head, div.document, .node-empty")).toHaveCount(0);
    await tree.getByRole("button", { name: "编码规范", exact: true }).click();
    await expect(reading.locator("div.document")).toContainText("formal-b");
    const late = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith("/assets/reviews") && url.searchParams.get("nodeId") === "doc-a" && !url.searchParams.has("runId");
    });
    releaseReports(); await late;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(reading.locator("div.document")).toContainText("formal-b");
    await expect(reading.getByTestId("knowledge-updates")).toHaveCount(0);
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(reading.locator(".revision-diff")).toBeVisible();
    await expect(reading.locator(".main-head, div.document, .updates-empty")).toHaveCount(0);
  });

  test("PK-preview-summary 切换候选文件时不闪现全库更新汇总和普通任务摘要", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.current.clear();
    scenario.runs[0]!.phase = "partial";
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(page.locator(".revision-diff")).toBeVisible();
    await expect(page.locator(".updates-summary")).toHaveCount(0);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(page.locator(".revision-diff")).toBeVisible();
    await expect(page.locator(".updates-summary")).toHaveCount(0);
    let releaseNode!: () => void, releasePreview!: () => void;
    const node = new Promise<void>(resolve => { releaseNode = resolve; });
    const preview = new Promise<void>(resolve => { releasePreview = resolve; });
    let waitingNode = false, waitingPreview = false;
    await page.route("**/api/knowledge/assets/node?**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("nodeId") === "doc-b" && !url.searchParams.has("runId")) { waitingNode = true; await node; }
      await route.fallback();
    });
    await page.route("**/api/knowledge/assets/run.preview?**", async route => {
      if (new URL(route.request().url()).searchParams.get("runId") === "run-b") { waitingPreview = true; await preview; }
      await route.fallback();
    });
    await tree.getByRole("button", { name: "编码规范", exact: true }).click();
    await expect.poll(() => waitingNode).toBe(true);
    await expect(page.locator(".reading-document > .node-loading")).toBeVisible();
    await expect(page.locator(".updates-summary")).toHaveCount(0);
    releaseNode();
    await expect.poll(() => waitingPreview).toBe(true);
    await expect(page.locator(".revision-diff .editor.modified")).toContainText("candidate-b");
    await expect(page.getByTestId("knowledge-updates").getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    await expect(page.locator(".updates-summary")).toHaveCount(0);
    releasePreview();
    await expect(page.locator(".revision-diff .monaco-diff-editor")).toBeVisible();
    await expect(page.locator(".revision-diff .editor.modified")).toContainText("candidate-b");
    await expect(page.locator(".updates-summary")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "返回当前内容", exact: true })).toHaveCount(0);
  });

  test("PK-preview-empty-original 新文档不显示空白删除条，已有正文保留删除标记", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.current.delete("doc-a");
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    const diff = page.locator(".revision-diff");
    for (let visit = 0; visit < 2; visit++) {
      await tree.getByRole("button", { name: "项目约定", exact: true }).click();
      await expect(diff.locator(".diff-editor.is-ready")).toBeVisible();
      await expect(diff.locator(".editor.modified .view-lines[role=presentation]")).toContainText("candidate-a");
      await expect(diff.locator(".editor.modified .line-delete, .inline-deleted-margin-view-zone")).toHaveCount(0);
      const firstLineOffset = await diff.locator(".editor.modified").evaluate(editor => {
        const lines = editor.querySelector(".view-lines[role=presentation]")!;
        return lines.querySelector(".view-line")!.getBoundingClientRect().top - lines.getBoundingClientRect().top;
      });
      expect(firstLineOffset).toBe(0);
      if (visit === 1) break;
      await tree.getByRole("button", { name: "编码规范", exact: true }).click();
      await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
      await expect(diff.locator(".diff-editor.is-ready")).toBeVisible();
      await expect(diff.locator(".editor.modified .view-lines[role=presentation]")).toContainText("candidate-b");
      await expect(diff.locator(".line-delete").first()).toBeVisible();
      await expect(diff.locator(".monaco-diff-editor")).toContainText("formal-b");
    }
  });

  test("PK-preview-editor-ready 切换文件时差异计算完成并铺满内容区后才显示编辑器", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installSession(page);
    await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-a");
    // 只延迟真实差异计算，正文接口保持正常，覆盖编辑器尚未就绪的独立阶段。
    await page.evaluate(() => {
      const post = Worker.prototype.postMessage;
      const pending: (() => void)[] = [];
      Worker.prototype.postMessage = function (...args: Parameters<Worker["postMessage"]>): void {
        const message = args[0] as { method?: string };
        if (message?.method === "$computeDiff") {
          document.documentElement.dataset.diffWorkerWaiting = "true";
          pending.push(() => Reflect.apply(post, this, args));
        } else Reflect.apply(post, this, args);
      };
      window.addEventListener("release-knowledge-diff", () => {
        Worker.prototype.postMessage = post;
        for (const send of pending) send();
        delete document.documentElement.dataset.diffWorkerWaiting;
      }, { once: true });
    });
    const firstFrames = page.locator(".reading-document").evaluate(element => new Promise<{ height: number; visible: boolean; text: string; lineNumbers: string }[]>(resolve => {
      const frames: { height: number; visible: boolean; text: string; lineNumbers: string }[] = [];
      let attempts = 0;
      const sample = () => {
        attempts++;
        const editor = element.querySelector(".monaco-diff-editor");
        if (editor) frames.push({ height: editor.getBoundingClientRect().height, visible: getComputedStyle(editor).visibility === "visible",
          text: editor.querySelector(".editor.modified .view-lines")?.textContent ?? "", lineNumbers: Array.from(editor.querySelectorAll(".line-numbers")).map(line => line.textContent).join("") });
        if (frames.length === 5 || attempts === 300) resolve(frames);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.diffWorkerWaiting === "true");
    const diff = page.locator(".revision-diff");
    await expect(diff.locator(".monaco-diff-editor")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("knowledge-diff-pending.png"), animations: "disabled" });
    const frames = await firstFrames;
    expect(frames).toHaveLength(5);
    expect(frames.filter(frame => frame.visible && (frame.height < 100 || !frame.text.includes("candidate-a")))).toEqual([]);
    await expect(diff.locator(".diff-loading")).toBeVisible();
    await expect(diff.locator(".monaco-diff-editor")).toBeHidden();
    await expect(diff.locator(".diff-editor")).toHaveCSS("opacity", "0");
    await tree.getByRole("button", { name: "编码规范", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-b");
    await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
    await expect(diff.locator(".diff-loading")).toBeVisible();
    await expect(diff.locator(".monaco-diff-editor")).toBeHidden();
    const pendingBounds = (await diff.boundingBox())!;
    await page.evaluate(() => window.dispatchEvent(new Event("release-knowledge-diff")));
    await expect(diff.locator(".monaco-diff-editor")).toBeVisible();
    await expect(diff.locator(".editor.modified .view-lines")).toContainText("candidate-b");
    await expect(diff.locator(".diff-loading")).toHaveCount(0);
    await expect(diff.locator(".diff-editor")).toHaveCSS("opacity", "1");
    const content = (await diff.boundingBox())!, editor = (await diff.locator(".monaco-diff-editor").boundingBox())!;
    expect(content.height).toBeCloseTo(pendingBounds.height, 0);
    expect(editor.height).toBeGreaterThan(content.height - 2);
    expect(content.height).toBeGreaterThan(300);
    expect(errors).toEqual([]);
  });

  test("PK-unified-recovery 采用中断刷新后从主页面恢复原请求，期间锁定导航", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { failApplyOnce: true, generated: true });
    await completeBuild(page, scenario);
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect(updates).toContainText("模拟采用中断");
    await expect(updates.getByRole("button", { name: "重试未完成采用", exact: true })).toBeVisible();
    await page.reload();
    await page.locator(".task-summary").getByRole("button", { name: "恢复未完成操作", exact: true }).click();
    await expect(updates.getByRole("button", { name: "重试未完成采用", exact: true })).toBeVisible();
    let release: (() => void) | null = null;
    await page.route("**/api/knowledge/assets/run.apply", async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fallback(); });
    await updates.getByRole("button", { name: "重试未完成采用", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(updates.getByRole("button", { name: "返回当前内容", exact: true })).toHaveCount(0);
    await expect(updates.getByRole("button", { name: /^刷\s*新$/u })).toHaveCount(0);
    release!();
    await expect.poll(() => scenario.applies.length).toBe(2);
    expect(scenario.applies[1]).toEqual(scenario.applies[0]);
    await expect.poll(() => scenario.saves.length).toBe(1);
    await expect(updates.locator(".candidate-notice")).toHaveCount(0);
    await expect(page.locator(".task-summary")).toHaveCount(0);
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("关键机制正文");
  });

  test("PK-unified-maintenance 维护失败保留重试，刷新后仅保存计划且不重复采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { failMaintenanceOnce: true, generated: true });
    await completeBuild(page, scenario);
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.getByRole("button", { name: "任务详情", exact: true })).toHaveCount(0);
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect(updates.getByRole("button", { name: "重试保存计划", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator(".task-summary")).toContainText("维护设置尚未保存");
    await page.locator(".task-summary").getByRole("button", { name: "恢复未完成操作", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await preview.getByRole("checkbox", { name: "采用后自动维护", exact: true }).uncheck();
    await preview.getByRole("button", { name: "重试保存计划", exact: true }).click();
    await expect.poll(() => scenario.saves.length).toBe(2);
    expect(scenario.applies).toHaveLength(1);
    expect((scenario.saves[1]!.schedule as RequestBody).enabled).toBe(false);
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("关键机制正文");
  });

  test("PK-unified-dismiss 目录不采用前列出受影响后代，处理后候选目录退出导航", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true, secondTopic: true });
    await completeBuild(page, scenario);
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: /项目地图.*结构调整/ }).click();
    await updates.getByRole("button", { name: "本次不采用", exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "本次不采用此更新？" });
    await expect(confirm).toContainText("3 项");
    await expect(confirm).toContainText("项目说明原文、关键机制");
    await confirm.getByRole("button", { name: "本次不采用", exact: true }).click();
    await expect.poll(() => scenario.dismisses.length).toBe(1);
    await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "项目地图", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "其他主题", exact: true })).toBeVisible();
  });

  test("PK-unified-multiple 正式版优先，同文件多候选必须明确选择且只能勾选一份", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { multiple: true });
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-a");
    await expect(page.getByTestId("knowledge-updates")).toHaveCount(0);
    await page.getByRole("button", { name: "查看更新 2", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.getByTestId("knowledge-build-preview")).toHaveCount(0);
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    const candidates = updates.locator(".update-row");
    await expect(candidates).toHaveCount(2);
    await candidates.nth(0).getByRole("checkbox").check();
    await candidates.nth(1).getByRole("checkbox").check();
    await expect(candidates.nth(0).getByRole("checkbox")).not.toBeChecked();
    await candidates.nth(1).getByRole("button").click();
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeEnabled();
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect.poll(() => scenario.writes.length).toBe(1);
    expect(scenario.writes[0]!.selections).toEqual([{ nodeId: "doc-a", revisionId: "candidate-a" }]);
  });

  for (const standalone of [false, true]) test(`PK-unified-first-failure-${standalone} 多任务与独立会话都在首错停止并报告真实生效范围`, async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { failSecond: true, standalone });
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".update-row input:checked")).toHaveCount(2);
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect(updates).toContainText("编码规范版本冲突");
    await expect(updates).toContainText("已完成 1 项：项目约定");
    expect(scenario.writes).toHaveLength(2);
    expect(scenario.current.get("doc-a")).toBe("candidate-a");
    expect(scenario.current.get("doc-b")).toBe("formal-b");
  });

  for (const drift of [false, true]) test(`PK-unified-preview-token-${drift ? "drift" : "advance"} 首组采用后令牌变化${drift ? "仍阻止所选结构漂移" : "允许继续采用无冲突任务"}`, async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { candidate: { summary: "首组确认的新说明" } });
    await page.route("**/api/knowledge/assets/run.preview?**", route => {
      const runId = new URL(route.request().url()).searchParams.get("runId");
      const run = scenario.runs.find(run => run.id === runId)!;
      const version = scenario.writes.length;
      const base = run.baseTree as NonNullable<Run["proposedTree"]>;
      const tree = version && runId === "run-b" ? { ...base, nodes: base.nodes.map(node => node.id === (drift ? "doc-b" : "doc-a") ? { ...node, summary: drift ? "所选结构已被外部修改" : "首组确认的新说明" } : node) } : run.proposedTree ?? base;
      return route.fulfill({ json: { ok: true, data: { runId, tree, treeHash: String(version + 10).repeat(32), planHash: String(version + 20).repeat(32),
        items: (run.items as RequestBody[]).map(item => ({ nodeId: item.nodeId, revisionId: item.revisionId, canApply: scenario.current.get(String(item.nodeId)) !== item.revisionId, reason: null, applied: scenario.current.get(String(item.nodeId)) === item.revisionId })) } } });
    });
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".update-row input:checked")).toHaveCount(2);
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    if (drift) {
      await expect(updates).toContainText("候选结构或适用范围已变化，请重新查看更新");
      expect(scenario.writes).toHaveLength(1);
      expect(scenario.current.get("doc-b")).toBe("formal-b");
    } else {
      await expect.poll(() => scenario.writes.length).toBe(2);
      expect(scenario.writes.map(write => write.runId)).toEqual(["run-a", "run-b"]);
      expect(scenario.writes[1]).toMatchObject({ treeHash: "11".repeat(32), planHash: "21".repeat(32), selections: [{ nodeId: "doc-b", revisionId: "candidate-b" }] });
      expect(scenario.current.get("doc-b")).toBe("candidate-b");
      await expect(page.getByText("预览依据已变化，请重新查看更新后采用", { exact: true })).toHaveCount(0);
    }
    expect(scenario.current.get("doc-a")).toBe("candidate-a");
  });

  test("PK-unified-proposal 会话建议与生成共用清单，保留取消选择并按原审核接口采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { proposal: true });
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".update-row")).toHaveCount(3);
    await updates.locator(".update-row").filter({ hasText: "普通会话" }).getByRole("button").click();
    await expect(updates.getByTestId("knowledge-change-diff")).toBeVisible();
    const proposal = updates.locator(".update-row").filter({ hasText: "普通会话" });
    await proposal.getByRole("checkbox").check();
    await proposal.getByRole("checkbox").uncheck();
    await updates.locator(".update-row").filter({ hasText: "编码规范" }).getByRole("button").click();
    await proposal.getByRole("button").click();
    await expect(proposal.getByRole("checkbox")).not.toBeChecked();
    await proposal.getByRole("checkbox").check();
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect.poll(() => scenario.approvals.length).toBe(1);
    expect(scenario.approvals[0]).toMatchObject({ changeId: "proposal-a", expectedHash: "proposal-hash", decision: "approve" });
    expect(scenario.writes).toHaveLength(1);
    expect(scenario.writes[0]!.runId).toBe("run-b");
    expect(scenario.writes[0]!.selections).toEqual([{ nodeId: "doc-b", revisionId: "candidate-b" }]);
  });

  test("PK-unified-structure 不展示结构明细，正文预览和正式目录保持正常", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { candidate: {
      title: "候选项目约定", parentId: null, summary: "补充长期约定说明", instructions: "必须保留原始错误码",
      tags: ["长期规则"], sourceScope: ["apps/web"], appliesTo: [], orderKey: "next",
    } });
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".updates-heading")).toContainText(/2 篇文档.*另含 1 项结构调整/u);
    await expect(updates.locator(".update-row").filter({ hasText: "项目约定" })).toContainText("正文与结构调整");
    await expect(updates.getByTestId("knowledge-structure-diff")).toHaveCount(0);
    await expect(updates.locator(".preview-toolbar h3")).toHaveText("候选项目约定");
    await expect(updates.locator(".revision-diff")).toBeVisible();
    await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "候选项目约定", exact: true })).toHaveCount(0);
    expect(scenario.writes).toHaveLength(0);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(updates);
    }
  });

  for (const verification of ["approved", "pending", "unavailable"] as const) test(`PK-unified-proposal-response-loss-${verification} 审核报错后核实实际结果，停止后续采用`, async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { proposal: true });
    const nextProposal = { ...scenario.proposal, id: "proposal-b", nodeId: "doc-b", title: "编码规范", hash: "proposal-b-hash" };
    const verified: string[] = [];
    await page.route("**/api/knowledge/assets/changes?**", route => route.fulfill({ json: { ok: true, data: {
      items: [scenario.proposal, nextProposal], nextOffset: null,
      pendingNodes: [scenario.proposal, nextProposal].map(item => ({ nodeId: item.nodeId, title: item.title, count: 1 })),
    } } }));
    await page.route("**/api/knowledge/assets/change?**", route => {
      const changeId = new URL(route.request().url()).searchParams.get("changeId")!;
      if (scenario.approvals.length) {
        verified.push(changeId);
        if (verification === "unavailable") return route.fulfill({ status: 503, json: { ok: false, code: "E2E_VERIFY_FAILED", message: "审核记录暂不可读" } });
      }
      return route.fulfill({ json: { ok: true, data: changeId === "proposal-b" ? nextProposal : scenario.proposal } });
    });
    await page.route("**/api/knowledge/assets/change.review", async route => {
      const body = route.request().postDataJSON() as RequestBody;
      if (verification !== "pending") {
        scenario.proposal.status = "approved";
        scenario.proposal.reviewedAt = "2026-10-21T10:00:00Z";
        scenario.proposal.reviewedBy = "chat-core-e2e-user";
        scenario.proposal.revisionId = "proposal-approved-revision";
        scenario.current.set("doc-a", "proposal-approved-revision");
      }
      scenario.approvals.push(body);
      await route.fulfill({ status: 502, json: { ok: false, code: "E2E_RESPONSE_LOST", message: "审核结果响应丢失" } });
    });
    await openKnowledge(page);
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    const proposals = updates.locator(".update-row").filter({ hasText: "普通会话" });
    for (const proposal of [proposals.nth(0), proposals.nth(1)]) {
      await proposal.getByRole("button").click();
      await proposal.getByRole("checkbox").check();
    }
    await expect(updates.locator(".update-row input:checked")).toHaveCount(2);
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect.poll(() => scenario.approvals.length).toBe(1);
    await expect.poll(() => verified).toEqual(["proposal-a"]);
    await expect(updates).toContainText("审核结果响应丢失");
    await expect(updates).toContainText(verification === "approved" ? "已完成 1 项：项目约定" : verification === "pending" ? "已完成 0 项" : "当前组的生效状态未知");
    if (verification === "unavailable") await expect(updates).toContainText("审核记录暂不可读");
    expect(scenario.approvals.map(item => item.changeId)).toEqual(["proposal-a"]);
    expect(scenario.writes).toHaveLength(0);
    expect(scenario.current.get("doc-b")).toBe("formal-b");
  });

  for (const action of ["node", "revision"] as const) test(`PK-document-timeout-${action} 在线请求超时显示读取失败，重试保留当前版本`, async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { noKnowledge: true, standaloneRevision: true });
    await page.route("**/api/knowledge/assets/node?**", route => route.fulfill({ json: { ok: true, data: {
      node: assetNode(), current: null, currentHash: null,
      drafts: [{ id: "revision-root", nodeId: "root", createdAt: "2026-09-21T12:00:00.000Z" }], effectiveInstructions: "", freshness: [],
    } } }));
    let attempts = 0;
    await page.route(`**/api/knowledge/assets/${action}?**`, route => ++attempts === 1
      ? route.fulfill({ status: 504, json: { ok: false, code: "CLIENT_REQUEST_TIMEOUT", message: "client 请求超时", details: { requestId: `document-timeout-${action}` } } })
      : route.fallback());
    await openKnowledge(page);
    const reading = page.locator(".reading-document");
    await expect(reading.getByRole("alert")).toContainText(`document-timeout-${action}`);
    await expect(reading.getByRole("heading", { name: "文档读取失败", exact: true })).toBeVisible();
    await expect(reading.locator(".node-loading")).toHaveCount(0);
    await expect(reading.getByText("这份知识还没有内容", { exact: true })).toHaveCount(0);
    await showKnowledgeAssistant(page);
    await expect(page.getByTestId("knowledge-assistant").locator(".conversation-start--loading")).toHaveCount(0);
    await reading.getByRole("button", { name: "重新读取文档", exact: true }).click();
    await expect(reading.locator("div.document")).toContainText("错误边界记录结构化日志");
    await expect(reading.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".knowledge-page > .page-error")).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.adopts).toHaveLength(0);
  });

  test("PK-document-timeout-refresh 已有正文重读超时后重试节点，不能复用上次成功的正文", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.runs[1]!.active = true;
    const statesReady = page.waitForResponse(response => response.url().includes("/knowledge/assets/snapshot?") && new URL(response.url()).searchParams.get("includeStates") === "true");
    await openKnowledge(page);
    await statesReady;
    const reading = page.locator(".reading-document");
    await expect(reading.locator("div.document")).toContainText("formal-a");
    await expect(page.locator(".task-summary")).toContainText("文档生成中");
    let attempts = 0;
    await page.route("**/api/knowledge/assets/node?**", route => {
      if (new URL(route.request().url()).searchParams.get("nodeId") !== "doc-a") return route.fallback();
      return ++attempts === 1
        ? route.fulfill({ status: 504, json: { ok: false, code: "CLIENT_REQUEST_TIMEOUT", message: "client 请求超时", details: { requestId: "document-refresh-timeout" } } })
        : route.fallback();
    });
    scenario.current.set("doc-a", "formal-a-updated");
    scenario.runs[1]!.active = false;
    await expect(reading.getByRole("alert")).toContainText("document-refresh-timeout");
    await reading.getByRole("button", { name: "重新读取文档", exact: true }).click();
    await expect(reading.locator("div.document")).toContainText("formal-a-updated");
    await expect(reading.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".knowledge-page > .page-error")).toHaveCount(0);
    expect(attempts).toBe(2);
  });

  test("PK-document-timeout-stale 切换空目录后旧正文请求超时不覆盖当前视图", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.nodes.push({ ...assetNode("empty-dir", "空目录", "specs"), contentMode: "directory" });
    await openKnowledge(page);
    const reading = page.locator(".reading-document");
    await expect(reading.locator("div.document")).toContainText("formal-a");
    let release!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/node?**", async route => {
      if (new URL(route.request().url()).searchParams.get("nodeId") !== "doc-b") return route.fallback();
      waiting = true;
      await gate;
      await route.fulfill({ status: 504, json: { ok: false, code: "CLIENT_REQUEST_TIMEOUT", message: "旧文档读取超时", details: { requestId: "stale-document-timeout" } } });
    });
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    await tree.getByRole("button", { name: "编码规范", exact: true }).click();
    await expect.poll(() => waiting).toBe(true);
    await tree.getByRole("button", { name: "空目录", exact: true }).click();
    const received = page.waitForResponse(response => response.url().includes("/knowledge/assets/node?") && response.status() === 504);
    release(); await received;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(reading.getByRole("heading", { name: "此目录暂无内容", exact: true })).toBeVisible();
    await expect(reading.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".knowledge-page > .page-error")).toHaveCount(0);
  });

  test("PK-document-loading-draft 独立草稿正文到达后不等待复检报告", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page, { noKnowledge: true, standaloneRevision: true });
    await page.route("**/api/knowledge/assets/node?**", route => route.fulfill({ json: { ok: true, data: {
      node: assetNode(), current: null, currentHash: null,
      drafts: [{ id: "revision-root", nodeId: "root", createdAt: "2026-09-21T12:00:00.000Z" }], effectiveInstructions: "", freshness: [],
    } } }));
    let release!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/reviews?**", async route => { waiting = true; await gate; await route.fallback(); });
    await openKnowledge(page);
    const reading = page.locator(".reading-document");
    await expect.poll(() => waiting).toBe(true);
    await expect(reading.locator("div.document")).toContainText("错误边界记录结构化日志");
    await expect(reading.locator(".node-loading")).toHaveCount(0);
    await showKnowledgeAssistant(page);
    await expect(page.getByTestId("knowledge-assistant").locator(".conversation-start--loading")).toHaveCount(0);
    release();
    await expect(reading.locator("div.document")).toContainText("错误边界记录结构化日志");
  });

  test("PK-document-loading 文档加载居中提示，正文到达后不等待复检报告", async ({ page }) => {
    await installSession(page);
    await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    const reading = page.locator(".reading-document");
    await expect(reading.locator("div.document")).toContainText("formal-a");
    await showKnowledgeAssistant(page);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    await tree.getByRole("button", { name: "编码规范", exact: true }).click();
    await expect(reading.locator("div.document")).toContainText("formal-b");
    let releaseDocument!: () => void, releaseReports!: () => void;
    const documentGate = new Promise<void>(resolve => { releaseDocument = resolve; });
    const reportsGate = new Promise<void>(resolve => { releaseReports = resolve; });
    let waitingDocument = false, waitingReports = false;
    await page.route("**/api/knowledge/assets/node?**", async route => {
      if (new URL(route.request().url()).searchParams.get("nodeId") === "doc-a") { waitingDocument = true; await documentGate; }
      await route.fallback();
    });
    await page.route("**/api/knowledge/assets/reviews?**", async route => {
      if (new URL(route.request().url()).searchParams.get("nodeId") === "doc-a") { waitingReports = true; await reportsGate; }
      await route.fallback();
    });
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect.poll(() => waitingDocument).toBe(true);
    const loading = reading.locator(".node-loading");
    await expect(loading).toHaveText("加载中");
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect.poll(async () => {
        const area = (await reading.boundingBox())!, spinner = (await loading.boundingBox())!;
        return Math.max(Math.abs(spinner.x + spinner.width / 2 - area.x - area.width / 2), Math.abs(spinner.y + spinner.height / 2 - area.y - area.height / 2));
      }).toBeLessThanOrEqual(2);
      await page.screenshot({ path: test.info().outputPath(`knowledge-document-loading-${width}.png`), animations: "disabled" });
    }
    releaseDocument();
    await expect.poll(() => waitingReports).toBe(true);
    await expect(reading.locator("div.document")).toContainText("formal-a");
    await expect(loading).toHaveCount(0);
    await expect(page.getByTestId("knowledge-assistant").locator(".conversation-start--loading")).toHaveCount(0);
    releaseReports();
    await expect(reading.locator("div.document")).toContainText("formal-a");
    await expect(loading).toHaveCount(0);
  });

  for (const viewport of [{ width: 1920, height: 920 }, { width: 1366, height: 540 }, { width: 390, height: 844 }]) test(`PK-document-space-${viewport.width} 阅读和编辑共用紧凑标题栏，正文占满剩余高度`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    scenario.runs[0]!.phase = "partial";
    await openKnowledge(page);
    await expect(page.locator(".overview, .overview-list, .directory-file-list, .directory-heading")).toHaveCount(0);
    expect((await page.locator(".page-header").boundingBox())!.height).toBeLessThan(viewport.width < 640 ? 90 : 45);
    if (viewport.width <= 1100) await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    await expandKnowledgeDirectory(page, "规格约束");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目约定", exact: true }).click();
    const main = page.locator(".knowledge-page main"), reading = page.locator(".reading-document");
    await expect(reading.locator("div.document")).toContainText("formal-a");
    // 进行中的生成任务会显示状态摘要，正文空间由后续高度断言保证。
    const bounds = (await main.boundingBox())!, head = (await reading.locator(".main-head").boundingBox())!, content = (await reading.locator(".content").boundingBox())!;
    expect(head.height).toBeLessThan(viewport.width < 640 ? 90 : 50);
    // 标题栏之外还有生成状态摘要条，正文起点允许包含该摘要高度。
    expect(content.y - bounds.y).toBeLessThan(viewport.width < 640 ? 120 : 85);
    expect(content.height).toBeGreaterThan(bounds.height * 0.8);
    await reading.getByRole("button", { name: "编辑文档", exact: true }).click();
    const editor = reading.getByRole("textbox", { name: "知识正文", exact: true });
    await editor.fill("项目约定\n\n" + "知识正文应当占满可用内容区。\n".repeat(150));
    const editorBounds = (await editor.boundingBox())!;
    expect(editorBounds.height).toBeGreaterThan(bounds.height * 0.75);
    expect(editorBounds.y - bounds.y).toBeLessThan(viewport.width < 640 ? 140 : 105);
    expect(await editor.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await reading.locator(".content").evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await expectInside(reading.getByRole("button", { name: "保存到项目", exact: true }), main);
    await expectNoHorizontalOverflow(main);
    await page.screenshot({ path: test.info().outputPath(`knowledge-editor-${viewport.width}.png`), animations: "disabled" });
    await reading.getByRole("button", { name: /^取\s*消$/u }).click();
    await expect(reading.locator("div.document")).toContainText("formal-a");
    expect((await reading.locator(".content").boundingBox())!.height).toBeCloseTo(content.height, 0);
  });

  // 未改动的编辑态可以直接查看来源和复检，长内容仍由阅读容器滚动。
  test("PK-editor-secondary 编辑后切换来源与复检，长内容可滚动且返回正文保留原内容", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 540 });
    await installSession(page);
    await installKnowledgeScenario(page, { noKnowledge: true });
    const content = "# 正式正文\n\n来源与复检不应被编辑布局裁切。";
    const sources = Array.from({ length: 30 }, (_, index) => ({ kind: "code", path: `apps/web/evidence-${index}.ts`, startLine: index + 1, endLine: index + 2, contentHash: "b".repeat(64), relation: `项目证据 ${index}` }));
    await page.route("**/api/knowledge/assets/node?**", route => route.fulfill({ json: { ok: true, data: {
      node: assetNode(), current: { revision: { schemaVersion: 1, id: "formal", nodeId: "root", origin: "manual", contentHash: "a".repeat(64) }, content, sources, path: "docs/product.md" },
      currentHash: "c".repeat(64), drafts: [], effectiveInstructions: "", freshness: [],
    } } }));
    await page.route("**/api/knowledge/assets/reviews?**", route => route.fulfill({ json: { ok: true, data: [{
      schemaVersion: 1, id: "formal-review", nodeId: "root", revisionId: "formal", createdAt: "2026-10-21T10:00:00Z", engine: "codex", model: "gpt-test", effort: "high",
      outcome: "issues", summary: "需要核对项目证据", stale: false, staleReasons: [], sources: [],
      issues: Array.from({ length: 24 }, (_, index) => ({ id: `issue-${index}`, severity: "warning", category: "coverage", title: `复检问题 ${index}`, detail: "需要对照对应来源核实正文。", documentStartLine: 3, documentEndLine: 3, sources: [], suggestion: "补齐来源证据。" })),
    }] } }));
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const reading = page.locator(".reading-document"), body = reading.locator(".content");
    await expect(reading.locator("div.document")).toContainText("正式正文");
    const height = (await body.boundingBox())!.height;
    for (const [menu, entries] of [["来源依据", ".source"], ["复检报告", ".review-issue"]]) {
      await reading.getByRole("button", { name: "编辑文档", exact: true }).click();
      await openDocumentMenu(page, menu!);
      const lastEntry = body.locator(entries!).last();
      await expect(lastEntry).toBeAttached();
      expect((await body.boundingBox())!.height).toBeCloseTo(height, 0);
      await body.hover();
      await page.mouse.wheel(0, 10_000);
      await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await expect(lastEntry).toBeInViewport();
      await reading.getByRole("button", { name: "返回文档", exact: true }).click();
      await expect(reading.getByRole("textbox", { name: "知识正文", exact: true })).toHaveValue(content);
      await reading.getByRole("button", { name: /^取\s*消$/u }).click();
    }
  });

  // 长命中片段在编辑时让出空间，取消编辑后仍能返回原命中位置。
  for (const viewport of [{ width: 1366, height: 540 }, { width: 1366, height: 420 }, { width: 390, height: 540 }]) test(`PK-editor-search-${viewport.width}x${viewport.height} 搜索结果进入编辑时正文铺满，取消后保留命中提示`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSession(page);
    await installKnowledgeScenario(page, { noKnowledge: true });
    const content = "# 项目正文\n\n" + Array.from({ length: 150 }, (_, index) => `搜索证据第 ${index} 行`).join("\n");
    await page.route("**/api/knowledge/assets/node?**", route => route.fulfill({ json: { ok: true, data: {
      node: assetNode(), current: { revision: { schemaVersion: 1, id: "formal", nodeId: "root", origin: "manual", contentHash: "a".repeat(64) }, content, sources: [], path: "docs/product.md" },
      currentHash: "c".repeat(64), drafts: [], effectiveInstructions: "", freshness: [],
    } } }));
    await page.route("**/api/knowledge/assets/search?**", route => route.fulfill({ json: { ok: true, data: { issues: [], items: [{
      nodeId: "root", title: "功能说明", heading: "证据章节", chunkId: "hit", startLine: 1, endLine: 35, contentHash: "a".repeat(64), excerpt: "搜索证据", path: "docs/product.md", matchMode: "hybrid", score: 0.9,
    }] } } }));
    await openKnowledge(page);
    const search = page.getByTestId("knowledge-search"), location = page.getByTestId("knowledge-search-location"), reading = page.locator(".reading-document");
    await search.getByPlaceholder("搜索规格与文档").fill("搜索证据");
    await search.getByRole("button", { name: /^搜\s*索$/u }).click();
    await page.getByTestId("knowledge-search-results").getByRole("button", { name: /功能说明/ }).click();
    await expect(location.locator("pre")).toContainText("搜索证据第 31 行");
    await reading.getByRole("button", { name: "编辑文档", exact: true }).click();
    const editor = reading.getByRole("textbox", { name: "知识正文", exact: true }), body = reading.locator(".content");
    await expect(location).toHaveCount(0);
    await expect(editor).toHaveValue(content);
    expect((await editor.boundingBox())!.height).toBeGreaterThan((await body.boundingBox())!.height * 0.8);
    await expectInside(editor, body);
    await editor.fill(content + "\n未保存的编辑内容");
    expect(await editor.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await body.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await reading.getByRole("button", { name: /^取\s*消$/u }).click();
    await expect(location.locator("pre")).toContainText("搜索证据第 31 行");
    await expect(reading.locator("div.document")).not.toContainText("未保存的编辑内容");
  });

  test("PK-unified-edit 目录内编辑离开时可以继续、放弃或保存，不把正文写到目录", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true }).click();
    await page.getByRole("button", { name: "编辑文档", exact: true }).click();
    await page.locator(".reading-document textarea").fill("手工补充项目约束");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "编码规范", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "这份文档还有未保存修改", exact: true });
    await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(page.locator(".reading-document textarea")).toHaveValue("手工补充项目约束");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "编码规范", exact: true }).click();
    await dialog.getByRole("button", { name: "保存并继续", exact: true }).click();
    await expect.poll(() => scenario.saves.length).toBe(1);
    expect(scenario.saves[0]).toMatchObject({ nodeId: "doc-a", content: "手工补充项目约束", expectedHash: "formal-a" });
    await expect(page.locator(".document-title")).toContainText("编码规范");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("手工补充项目约束");
  });

  test("PK-unified-legacy 旧审批深链定位建议，前进后退映射统一页面", async ({ page }) => {
    await installSession(page);
    await installUnifiedUpdatesScenario(page, { proposal: true });
    await openKnowledge(page);
    await page.goto(`/knowledge?workspaceId=${WORKSPACE_ID}&view=approvals&changeId=proposal-a`);
    await expect(page.getByTestId("knowledge-change-inbox")).toContainText("来自普通会话的修改");
    await expect(page.getByRole("button", { name: "待处理", exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByTestId("knowledge-updates")).toHaveCount(0);
    await page.goForward();
    await expect(page.getByTestId("knowledge-change-inbox")).toContainText("来自普通会话的修改");
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "规格约束");
    await tree.getByRole("button", { name: "编码规范", exact: true }).click();
    await expect(page.getByTestId("knowledge-updates")).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("formal-b");
    expect(new URL(page.url()).searchParams.has("changeId")).toBe(false);
  });

  test("PK-unified-execution 执行链接映射右侧，移除目标后迟到结果不重新打开", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page, { reviewState: "pending" });
    await page.goto("/knowledge?executionThreadId=knowledge-generation-root");
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant).toContainText("知识工作会话 · 功能说明");
    let release: (() => void) | null = null;
    let completed!: () => void;
    const settled = new Promise<void>(resolve => { completed = resolve; });
    await page.route("**/api/threads/load", async route => {
      if (route.request().postDataJSON().threadId !== "knowledge-review-root") return route.fallback();
      await new Promise<void>(resolve => { release = resolve; });
      await route.fallback();
      completed();
    });
    await page.evaluate(async () => {
      const app = (document.querySelector("#app") as any).__vue_app__;
      await app.config.globalProperties.$router.push("/knowledge?executionThreadId=knowledge-review-root");
    });
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.evaluate(async () => {
      const app = (document.querySelector("#app") as any).__vue_app__;
      await app.config.globalProperties.$router.push("/knowledge");
    });
    await expect(assistant).not.toContainText("复检会话 · 功能说明");
    release!(); await settled;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(assistant).not.toContainText("复检会话 · 功能说明");
    await expect(page.getByTestId("knowledge-execution-drawer")).toHaveCount(0);
  });

  test("PK-file-session 切文件及候选时映射对应会话，保留草稿并隔离迟到加载", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page, { multiple: true });
    for (const run of scenario.runs) for (const item of run.items as RequestBody[]) item.executionThreadId = `work-${run.id}`;
    const loaded: string[] = [];
    let release!: () => void;
    let waitForOld = true;
    await page.route("**/api/threads/load", async route => {
      const id = String(route.request().postDataJSON().threadId);
      loaded.push(id);
      if (id === "work-run-a-new" && waitForOld) { waitForOld = false; await new Promise<void>(resolve => { release = resolve; }); }
      await route.fallback();
    });
    await openKnowledge(page);
    await expandKnowledgeDirectory(page, "规格约束");
    const tree = page.getByTestId("knowledge-tree"), assistant = page.getByTestId("knowledge-assistant");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await showKnowledgeAssistant(page);
    await expect(assistant).toContainText("当前文件版本尚无可用的生成会话记录");
    await page.getByRole("button", { name: "查看更新 2", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(assistant).toContainText("请选择一个候选版本");
    await updates.getByRole("button", { name: /项目约定/ }).first().click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(assistant).toContainText("正在加载文件会话");
    await updates.getByRole("button", { name: /项目约定/ }).nth(1).click();
    const draft = assistant.locator(".composer__textarea");
    await expect(draft).toBeEnabled();
    await draft.fill("只给旧候选的补充要求");
    await expect.poll(() => scenario.savedDraftByThreadId.get("work-run-a")).toBeTruthy();
    release();
    await expect(draft).toHaveValue("只给旧候选的补充要求");
    await tree.getByRole("button", { name: "编码规范", exact: true }).click();
    await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
    await expect(assistant).toContainText("知识工作会话 · 编码规范");
    await expect(draft).toHaveValue("");
    await draft.fill("编码规范的补充要求");
    await expect.poll(() => scenario.savedDraftByThreadId.get("work-run-b")).toBeTruthy();
    expect(loaded).toEqual(expect.arrayContaining(["work-run-a", "work-run-a-new", "work-run-b"]));
    expect(scenario.calls.ends).toHaveLength(0);
    expect(scenario.calls.sends).toHaveLength(0);
    await draft.press("Enter");
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    expect(scenario.calls.sends[0]).toMatchObject({ threadId: "work-run-b", text: "编码规范的补充要求" });
  });

  test("PK-file-subagent 复检在文件会话内展开，运行期间禁止并行修订", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    const run = scenario.runs[0]!, item = (run.items as RequestBody[])[0]!;
    run.active = true;
    item.executionThreadId = "file-work";
    item.review = { parentThreadId: "file-work", executionThreadId: "review-child", status: "pending", reportId: null, error: null };
    await page.route("**/api/threads/load", route => {
      if (route.request().postDataJSON().threadId !== "file-work") return route.fallback();
      const event = (seq: number, type: string, payload: RequestBody) => ({ schema: 1, seq, ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: "file-work", engine: "codex", type, payload });
      return route.fulfill({ json: { ok: true, thread: { id: "file-work", workspaceId: WORKSPACE_ID, title: "文件工作会话", engine: "codex", threadType: "orchestration", threadSubtype: "knowledge-assets", model: "gpt-test", effort: "high", accessMode: "read-only", planMode: false, archived: false, createdAt: 1, updatedAt: 1 }, running: null, events: [
        event(1, "item.subagent.started", { itemId: "review-task", taskId: "review-child", description: "复检 · 项目约定", taskType: "knowledge_review" }),
        event(2, "item.subagent.childEvent", { itemId: "review-task", taskId: "review-child", innerEventType: "item.agentMessage.snapshot", innerPayload: { itemId: "review-message", text: "正在交叉核对约束和源码", revision: 1 } }),
        event(3, "item.subagent.childEvent", { itemId: "review-task", taskId: "review-child", innerEventType: "item.agentMessage.completed", innerPayload: { itemId: "review-message", text: "已交叉核对约束和源码，证据完整。", revision: 2 } }),
      ] } });
    });
    await openKnowledge(page);
    await expandKnowledgeDirectory(page, "规格约束");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目约定", exact: true }).click();
    await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
    await showKnowledgeAssistant(page);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant).toContainText("知识工作会话 · 项目约定");
    await expect(assistant).toContainText("复检 · 项目约定");
    await assistant.getByRole("button", { name: "查看 (1)", exact: true }).click();
    await expect(page.locator(".subagent-pop__body")).toContainText("已交叉核对约束和源码，证据完整。");
    await assistant.getByRole("button", { name: "查看 (1)", exact: true }).click();
    await expect(assistant.locator(".composer__textarea")).toBeDisabled();
    expect(scenario.calls.sends).toHaveLength(0);
    await expect(page.getByTestId("knowledge-updates").getByRole("button", { name: "任务详情", exact: true })).toHaveCount(0);
  });

  test("PK-unified-lock 采用请求期间切树和搜索不会中断原确认", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    let release: (() => void) | null = null;
    await page.route("**/api/knowledge/assets/run.apply", async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fallback(); });
    await completeBuild(page, scenario);
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(updates.getByRole("button", { name: "返回当前内容", exact: true })).toHaveCount(0);
    await expect(updates.getByRole("button", { name: /^刷\s*新$/u })).toHaveCount(0);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目地图", exact: true }).click();
    await page.getByPlaceholder("搜索规格与文档", { exact: true }).fill("功能");
    await page.getByPlaceholder("搜索规格与文档", { exact: true }).press("Enter");
    await expect(page.locator(".search-result")).toBeDisabled();
    release!();
    await expect.poll(() => scenario.applies.length).toBe(1);
    await expect.poll(() => scenario.saves.length).toBe(1);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目地图", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "目录文档列表", exact: true })).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("直接引用现有资料");
  });

  for (const width of [1366, 760, 390]) test(`PK-unified-layout-${width} 固定阅读高度和内部滚动，稀疏和候选状态不溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installSession(page);
    await installUnifiedUpdatesScenario(page, { multiple: true, proposal: true });
    await openKnowledge(page);
    if (width <= 1100) await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束", exact: true }).click();
    const main = page.locator(".knowledge-page main");
    await expect(page.locator(".directory-file-list")).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("formal-a");
    const height = (await main.boundingBox())!.height;
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
    await expectNoHorizontalOverflow(page.locator(".reading-layout"));
    if (width <= 1100) await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "规格约束目录操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "查看此目录更新", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates).toBeVisible();
    expect((await main.boundingBox())!.height).toBeCloseTo(height, 0);
    await updates.locator(".update-row").filter({ hasText: "普通会话" }).getByRole("button").click();
    const inbox = updates.getByTestId("knowledge-change-inbox"), diff = inbox.getByTestId("knowledge-change-diff");
    await expect(diff.locator(".monaco-diff-editor")).toBeVisible();
    const inboxBounds = (await inbox.boundingBox())!, diffBounds = (await diff.boundingBox())!;
    expect(diffBounds.y - inboxBounds.y).toBeLessThan(width < 640 ? 100 : 65);
    expect(diffBounds.height).toBeGreaterThan(inboxBounds.height * 0.7);
    await inbox.getByRole("button", { name: "对比设置", exact: true }).click();
    await page.getByRole("menuitem", { name: "内联对比", exact: true }).click();
    await inbox.getByRole("button", { name: "完整文档", exact: true }).click();
    await expect(inbox.locator(".comparison")).toContainText("会话建议正文");
    await inbox.getByRole("button", { name: "变更对比", exact: true }).click();
    await expect(diff.locator(".monaco-diff-editor")).toBeVisible();
    await inbox.getByRole("button", { name: "对比设置", exact: true }).click();
    await page.getByRole("menuitem", { name: "显示全文对比", exact: true }).click();
    await inbox.getByRole("button", { name: "对比设置", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "仅看变更", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "并排对比", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "下一处差异", exact: true }).click();
    await expectInside(updates.getByRole("button", { name: "采用所选内容", exact: true }), page.locator(".knowledge-page"));
    await expectNoHorizontalOverflow(updates);
    await page.screenshot({ path: test.info().outputPath(`knowledge-unified-${width}.png`), animations: "disabled" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expectNoHorizontalOverflow(updates);
  });

  // 用实际正文高度与页面边界约束紧凑预览，覆盖长文、单栏新文档和低高度窗口。
  for (const viewport of [{ width: 1920, height: 920 }, { width: 1366, height: 540 }, { width: 390, height: 844 }]) test(`PK-preview-space-${viewport.width} 正文占满剩余空间，长文只在内容区滚动`, async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true, documentContent: `# 关键机制正文\n\n${"项目关键机制的来源与边界。\n\n".repeat(120)}` });
    await completeBuild(page, scenario);
    await page.setViewportSize(viewport);
    const updates = page.getByTestId("knowledge-updates");
    await updates.locator(".update-row").filter({ hasText: "关键机制" }).getByRole("button").click();
    const preview = updates.getByTestId("knowledge-build-preview");
    const diff = preview.locator(".revision-diff");
    await expect(diff.locator(".monaco-diff-editor")).toBeVisible();
    await expect(preview.getByRole("checkbox", { name: "采用后自动维护", exact: true })).toHaveCount(0);
    const content = (await diff.boundingBox())!, bounds = (await updates.boundingBox())!;
    await page.screenshot({ path: test.info().outputPath(`knowledge-preview-${viewport.width}.png`), animations: "disabled" });
    expect(content.height).toBeGreaterThan(bounds.height * (viewport.width < 640 ? 0.4 : viewport.height < 600 ? 0.6 : 0.7));
    expect(content.y - bounds.y).toBeLessThan(viewport.width < 640 ? 320 : 140);
    await expect.poll(async () => (await diff.locator(".editor.modified").boundingBox())!.width).toBeGreaterThan(content.width * 0.9);
    await expectInside(updates.getByRole("button", { name: "采用所选内容", exact: true }), page.locator(".knowledge-page"));
    await expectNoHorizontalOverflow(updates);
    await preview.getByRole("tab", { name: "完整内容", exact: true }).click();
    const body = preview.locator(".preview-body");
    await expect(body).toContainText("关键机制正文");
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect((await body.boundingBox())!.height).toBeCloseTo(content.height, 0);
    await page.emulateMedia({ colorScheme: "dark" });
    await expectNoHorizontalOverflow(updates);
  });

  test("PK-default-roots 空库直接展示三类目录，统一顶部搜索且知识树可浏览", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { empty: true, noKnowledge: true });
    const nodes: Node[] = [
      { ...assetNode("knowledge-specifications", "规格约束"), contentMode: "directory", category: "specifications" },
      { ...assetNode("knowledge-architecture", "架构机制"), contentMode: "directory", category: "architecture" },
      { ...assetNode("knowledge-product", "产品文档"), contentMode: "directory", category: "product" },
    ].map((node, index) => ({ ...node, orderKey: String(index), summary: "", sourceScope: [] })) as Node[];
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ json: { ok: true, data: {
      initialized: false, knowledgeId: null, root: "codeflow-docs/知识库", canWrite: true, treeHash: null,
      tree: { schemaVersion: 3, instructions: "", nodes }, states: nodes.map(node => ({ nodeId: node.id, revisionId: null, draftCount: 0, error: null })),
    } } }));
    await page.route("**/api/knowledge/assets/node?**", route => route.fulfill({ json: { ok: true, data: {
      node: nodes.find(node => node.id === new URL(route.request().url()).searchParams.get("nodeId")),
      current: null, currentHash: null, drafts: [], effectiveInstructions: "", freshness: [],
    } } }));
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await expect(tree.getByRole("treeitem")).toHaveCount(3);
    await tree.getByRole("button", { name: "系统架构", exact: true }).click();
    await expect(page.locator(".main-head")).toContainText("系统架构");
    await expect(tree.getByRole("button", { name: "架构机制", exact: true })).toHaveCount(0);
    await expect(tree.locator(".node-icon")).toHaveCount(3);
    await expect(tree.locator(".state-dot")).toHaveCount(0);
    await expect(tree.getByRole("button", { name: "一键生成", exact: true })).toBeEnabled();
    await tree.getByRole("button", { name: "规格约束", exact: true }).click();
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("规格约束");
    await expect(page.locator(".main-head")).toContainText("规格约束");
    await expect(tree.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-search").getByRole("textbox")).toHaveCount(1);
    await expect(tree.getByRole("treeitem")).toHaveCount(3);
    await expectNoHorizontalOverflow(tree);
    await page.screenshot({ path: test.info().outputPath("knowledge-default-directories.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => tree.locator(".node-label").first().evaluate(element => {
      const rgb = getComputedStyle(element).color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      return rgb.reduce((sum, value) => sum + value, 0) / 3;
    })).toBeGreaterThan(180);
    await expect(tree.getByRole("button", { name: "规格约束", exact: true })).toBeVisible();
    for (let depth = 1; depth <= 10; depth++) nodes.push({
      ...assetNode(`deep-${depth}`, `第${depth}层知识目录与长标题`, depth === 1 ? "knowledge-specifications" : `deep-${depth - 1}`), contentMode: "directory",
    });
    await page.reload();
    await expandKnowledgeDirectory(page, "规格约束");
    for (let depth = 1; depth < 10; depth++) await expandKnowledgeDirectory(page, `第${depth}层知识目录与长标题`);
    const deepTitle = tree.getByRole("treeitem").filter({ has: page.getByRole("button", { name: "第10层知识目录与长标题", exact: true }) }).locator(".node-title");
    await expect(deepTitle).toBeVisible();
    expect(await deepTitle.evaluate(element => element.clientWidth)).toBeGreaterThan(40);
    await expectNoHorizontalOverflow(tree);
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.creates).toHaveLength(0);
  });

  test("PK-pending-default-roots 统一目录保留三个分类，空分类不展示其他目录候选", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { specifications: true });
    const roots: Node[] = KNOWLEDGE_CATEGORIES.map(category => ({ ...assetNode(category.id, category.title), contentMode: "directory", category: category.category, sourceScope: [] }));
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ json: { ok: true, data: {
      initialized: false, knowledgeId: null, root: "codeflow-docs/知识库", canWrite: true, treeHash: null,
      tree: { schemaVersion: 3, instructions: "", nodes: roots }, states: roots.map(node => ({ nodeId: node.id, revisionId: null, draftCount: 0, error: null })),
    } } }));
    await completeBuild(page, scenario);
    await openGenerationResults(page);
    const tree = page.getByTestId("knowledge-tree");
    // 确认候选处理和普通阅读始终共用完整分类导航。
    const assertRoots = async () => {
      for (const category of KNOWLEDGE_CATEGORIES) await expect(tree.getByRole("button", { name: category.title, exact: true })).toBeVisible();
      await expect(tree.getByRole("textbox")).toHaveCount(0);
    };
    await assertRoots();
    for (const title of ["系统架构", "产品文档"]) {
      await tree.getByRole("button", { name: title, exact: true }).click();
      await expect(page.locator(".main-head")).toContainText(title);
      await expect(page.getByRole("heading", { name: "此目录暂无内容", exact: true })).toBeVisible();
      await expect(page.getByTestId("knowledge-build-preview")).toHaveCount(0);
      await expect(page.locator(".results-toolbar")).toHaveCount(0);
      await expect(tree.getByRole("treeitem").filter({ has: page.getByRole("button", { name: title, exact: true }) }).locator(".pending-count")).toHaveCount(0);
    }
    await page.reload();
    await expect(page.locator(".main-head")).toContainText("产品文档");
    await assertRoots();
    await tree.getByRole("button", { name: "规格约束", exact: true }).click();
    await tree.getByRole("button", { name: "规格约束目录操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "查看此目录更新", exact: true }).click();
    await expect(page.getByTestId("knowledge-updates")).toContainText("项目说明原文");
    await assertRoots();
    await tree.getByRole("button", { name: "系统架构", exact: true }).click();
    await expect(page.getByRole("heading", { name: "此目录暂无内容", exact: true })).toBeVisible();
    await expect(page.getByTestId("knowledge-build-preview")).toHaveCount(0);
    await assertRoots();
    expect(scenario.applies).toHaveLength(0);
    expect(scenario.dismisses).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(1);
  });

  test("PK-category-planning 规划、失败和中断不再提供详情入口，分类阅读正常", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { empty: true, noKnowledge: true });
    const roots: Node[] = KNOWLEDGE_CATEGORIES.map(category => ({ ...assetNode(category.id, category.title), contentMode: "directory", category: category.category, sourceScope: [] }));
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ json: { ok: true, data: {
      initialized: false, knowledgeId: null, root: "codeflow-docs/知识库", canWrite: true, treeHash: null,
      tree: { schemaVersion: 3, instructions: "", nodes: roots }, states: roots.map(node => ({ nodeId: node.id, revisionId: null, draftCount: 0, error: null })),
    } } }));
    for (const variant of [
      { phase: "planning", active: true, selectedNodeIds: ["knowledge-specifications"], nodeId: null },
      { phase: "failed", active: false, selectedNodeIds: ["knowledge-specifications"], nodeId: null },
      { phase: "interrupted", active: false, selectedNodeIds: ["knowledge-specifications"], nodeId: null },
      { phase: "planning", active: true, selectedNodeIds: [], nodeId: null },
      { phase: "failed", active: false, selectedNodeIds: [], nodeId: "knowledge-specifications" },
    ]) {
      scenario.setRun({ schemaVersion: 1, id: "planning-e2e", createdAt: "2026-10-21T10:00:00Z", mode: "build", ownerThreadId: scenario.threadId,
        engine: "codex", model: "gpt-test", effort: "high", treeHash: null, proposedTree: null, items: [], error: variant.phase === "failed" ? { code: "E2E_PLANNING_FAILED", message: "规划尚未提交" } : null, rationale: "等待完成规划", prompt: "", gaps: [], ...variant });
      await page.goto("/knowledge?view=results");
      const tree = page.getByTestId("knowledge-tree");
      await tree.getByRole("button", { name: "规格约束", exact: true }).click();
      await expect(page.getByRole("button", { name: "任务详情", exact: true })).toHaveCount(0);
      await expect(page.getByTestId("knowledge-plan-review")).toHaveCount(0);
      await tree.getByRole("button", { name: "系统架构", exact: true }).click();
      // 目录视图不再渲染正文标题栏，以空态标题确认已切换到对应目录。
      await expect(page.getByRole("heading", { name: "此目录暂无内容", exact: true })).toBeVisible();
    }
    const existing = { ...assetNode("adopted-architecture", "已采用架构总览", "knowledge-architecture"), contentMode: "generated" as const };
    const formal = { schemaVersion: 3, instructions: "", nodes: [...roots, existing] };
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ json: { ok: true, data: {
      initialized: true, knowledgeId: "kb-e2e", root: "codeflow-docs/知识库", canWrite: true, treeHash: "a".repeat(64), tree: formal,
      states: formal.nodes.map(node => ({ nodeId: node.id, revisionId: node.id === existing.id ? "adopted-revision" : null, draftCount: 0, error: null })),
    } } }));
    scenario.setRun({ schemaVersion: 1, id: "failed-specification", createdAt: "2026-10-21T11:00:00Z", mode: "build", phase: "failed", active: false, nodeId: null,
      ownerThreadId: scenario.threadId, engine: "codex", model: "gpt-test", effort: "high", treeHash: "a".repeat(64), baseTree: formal, proposedTree: formal,
      selectedNodeIds: ["knowledge-specifications"], items: [], error: { code: "E2E_FAILED", message: "仅规格任务失败" }, rationale: "失败后保留完整候选快照", prompt: "", gaps: [] });
    await page.goto("/knowledge?view=results");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "系统架构", exact: true }).click();
    await expect(page.getByTestId("knowledge-tree").locator(".asset-tree-row.selected")).toContainText("已采用架构总览");
    await expect(page.getByTestId("knowledge-plan-review")).toHaveCount(0);
    await expect(page.locator(".results-toolbar")).toHaveCount(0);
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.starts).toHaveLength(0);
    expect(scenario.calls.stops).toHaveLength(0);
  });

  test("PK-policy 三类管理策略可查阅，导入按用途确认且页面不溢出", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeMenu(page, "管理策略");
    const policy = page.locator(".ant-drawer-content").filter({ hasText: "规格库管理策略" });
    await expect(policy.getByRole("heading", { name: "规格约束", exact: true })).toBeVisible();
    await expect(policy.getByRole("heading", { name: "系统架构", exact: true })).toBeVisible();
    for (const title of ["架构总览", "核心流程", "关键机制"]) await expect(policy.locator("li strong").getByText(title, { exact: true })).toBeVisible();
    await expect(policy).toContainText("默认只补齐以上三份文档");
    await expect(policy).toContainText("其他专题由用户在规格协作对话中按需生成");
    await expect(policy.getByRole("heading", { name: "产品文档", exact: true })).toBeVisible();
    await expect(policy).toContainText("临时任务要求和个人偏好不保存为共享规则");
    for (const title of ["项目约定", "编码规范", "界面规范", "接口规范", "数据规范", "业务约束", "安全规范", "交付规范"]) await expect(policy.locator("li strong").getByText(title, { exact: true })).toBeVisible();
    await expect(policy).toContainText("以上八份为内置默认规格文档及其作用");
    for (const purpose of ["依赖引入要求", "错误处理", "响应式与无障碍要求", "接口兼容要求", "数据归属及一致性要求", "重复结算限制", "生产操作授权边界", "验收条件"]) await expect(policy).toContainText(purpose);
    await expect(policy).toContainText("始终提供全部八份文档");
    await expect(policy).toContainText("一份原文可以支撑多份规格");
    await expect(policy).toContainText("空文档不作为已生效规则加载");
    await expectNoHorizontalOverflow(policy);
    await policy.getByRole("button", { name: "Close", exact: true }).click();
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await expect(modal).toContainText("导入后直接引用原文，按章节检索");
    await expect(modal.getByRole("radio", { name: "产品文档", exact: true })).toBeChecked();
    await modal.getByText("规格约束", { exact: true }).click();
    await expect(modal.getByRole("radio", { name: "规格约束", exact: true })).toBeChecked();
    await expect(modal.locator("button").filter({ hasText: "上传本地文档" })).toBeVisible();
    await modal.getByRole("button", { name: /适用范围：整个项目/ }).click();
    await expect(modal.getByRole("textbox", { name: "规格适用范围", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(modal);
    await modal.getByRole("textbox", { name: "规格适用范围", exact: true }).fill("apps/web");
    await modal.getByRole("button", { name: "docs/", exact: true }).click();
    await modal.locator("input[type=checkbox]").first().check();
    await modal.getByRole("button", { name: "导入选中的 1 个文档", exact: true }).click();
    await expect.poll(() => scenario.calls.imports.length).toBe(1);
    expect(scenario.calls.imports[0]).toMatchObject({ category: "specifications", appliesTo: ["apps/web"] });
  });

  test("PK-import-layout 分类和文件浏览分区，明暗与窄屏下内容滚动且确认始终可见", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page);
    const files = Array.from({ length: 18 }, (_, index) => ({ path: `docs/长期维护文档-${index}.md`, title: `长期维护文档 ${index}`, contentHash: "b".repeat(64) }));
    await page.route("**/api/knowledge/assets/imports?**", route => route.fulfill({ json: { ok: true, data: { files, directories: ["apps", "codeflow-docs", "包含很长名称的项目资料目录"], nextOffset: null } } }));
    await openKnowledge(page);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await modal.getByRole("radio", { name: "规格约束", exact: true }).check();
    await expect(modal).toContainText("导入后作为所选范围的规格规则生效");
    await expect(modal.getByRole("button", { name: /适用范围：整个项目/ })).toBeVisible();
    for (const viewport of [{ width: 1366, height: 900 }, { width: 688, height: 730 }, { width: 390, height: 844 }, { width: 390, height: 540 }]) {
      await page.setViewportSize(viewport);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expectNoHorizontalOverflow(modal);
        await expectNoHorizontalOverflow(modal.locator(".import-scroll"));
        await expectInside(modal.locator(".import-footer"), modal);
        await expect(modal.getByRole("button", { name: "导入选中的 0 个文档", exact: true })).toBeInViewport();
        const scroll = modal.locator(viewport.width <= 720 ? ".import-layout" : ".import-scroll");
        await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
        expect(await modal.locator(".import-scroll").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(120);
        await modal.getByRole("checkbox", { name: /长期维护文档 0 / }).check();
        await expect(modal.getByRole("checkbox", { name: /长期维护文档 0 / })).toBeInViewport();
        await modal.getByRole("checkbox", { name: /长期维护文档 0 / }).uncheck();
        const bounds = await modal.boundingBox();
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
        await page.screenshot({ path: test.info().outputPath(`knowledge-import-${viewport.width}-${viewport.height}-${colorScheme}.png`), animations: "disabled" });
      }
    }
  });

  test("PK-import-height 目录加载、空态和多文档保持相同浏览高度", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page);
    let populated = false, hold = false, release!: () => void;
    await page.route("**/api/knowledge/assets/imports?**", async route => {
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: { ok: true, data: { files: populated ? [{ title: "文档", path: "docs/readme.md", contentHash: "b".repeat(64) }] : [], directories: [], nextOffset: null } } });
    });
    await openKnowledge(page);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    const browser = modal.locator(".import-scroll");
    await expect(modal.locator(".ant-empty")).toBeVisible();
    const height = await browser.evaluate(element => element.clientHeight);
    hold = true;
    await modal.getByRole("button", { name: "读取目录", exact: true }).click();
    await expect(browser).toHaveAttribute("aria-busy", "true");
    expect(await browser.evaluate(element => element.clientHeight)).toBe(height);
    populated = true; release();
    await expect(modal.getByRole("checkbox", { name: /文档/ })).toBeVisible();
    expect(await browser.evaluate(element => element.clientHeight)).toBe(height);
  });

  test("PK-policy-upload 上传使用已加载目录，刷新期间禁止重复上传，失败保留上传事实", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page);
    let refreshing = false, release!: () => void;
    const refreshGate = new Promise<void>(resolve => { release = resolve; });
    let uploaded = false, uploadCalls = 0;
    await page.route("**/api/fs/upload?**", async route => { expect(new URL(route.request().url()).searchParams.get("targetDir")).toBeNull(); uploadCalls++; uploaded = true; await route.fulfill({ json: { ok: true, data: { transferId: "upload-doc", path: "new.md", fileName: "new.md", size: 10 } } }); });
    await page.route("**/api/knowledge/assets/imports?**", async route => {
      if (!uploaded) return route.fallback();
      refreshing = true; await refreshGate;
      return route.fulfill({ status: 500, json: { ok: false, code: "E2E_LIST_FAILED", message: "模拟来源刷新失败" } });
    });
    await openKnowledge(page);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    const upload = modal.locator("button").filter({ hasText: "上传本地文档" });
    await expect(upload).toBeEnabled();
    await modal.getByRole("textbox", { name: "导入来源目录", exact: true }).fill("尚未读取的目录");
    await expect(upload).toHaveAttribute("title", "上传到：项目根目录");
    await modal.locator('input[type="file"]').setInputFiles({ name: "new.md", mimeType: "text/markdown", buffer: Buffer.from("# 原始资料") });
    await expect.poll(() => refreshing).toBe(true);
    await expect(upload).toBeDisabled();
    release();
    await expect(modal).toContainText("原文件已上传，但来源目录读取失败");
    await expect(upload).toBeDisabled();
    expect(uploadCalls).toBe(1);
    await expect(page.locator(".ant-message-success")).toHaveCount(0);
  });

  test("PK-policy-preview 采用前展示候选规格继承的适用范围", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { specifications: true });
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    scenario.complete();
    await openGenerationResults(page);
    const preview = page.getByTestId("knowledge-build-preview");
    await page.getByTestId("knowledge-updates").locator(".update-row").filter({ hasText: "项目说明原文" }).getByRole("button").click();
    await expect(preview).toContainText("规格适用范围：apps/web");
  });

  test("PK-build-task-options 详情抽屉及入口已删除，刷新和窄屏阅读正常", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: /关键机制.*生成修订/ }).click();
    await expect(updates.locator(".revision-diff")).toBeVisible();
    await expect(page.getByRole("button", { name: "任务详情", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("knowledge-plan-review")).toHaveCount(0);
    await page.getByRole("button", { name: "规格库更多操作", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "任务历史", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(updates);
    }
    await page.reload();
    await expect(updates.locator(".revision-diff")).toBeVisible();
    await expect(page.getByRole("button", { name: "任务详情", exact: true })).toHaveCount(0);
    await expect(page.locator(".ant-drawer-content:visible")).toHaveCount(0);
    expect(scenario.applies).toHaveLength(0);
  });

  test("PK-build-01 空库一键后台构建，目录与实时引用统一预览采用并保存维护", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    await openKnowledge(page);
    await expect(page.getByRole("group", { name: "协作范围" })).toHaveCount(0);
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.creates).toHaveLength(1);
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null, engine: "codex" });
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "build", selectedNodeIds: [], reviewConfig: { enabled: true, autoRepair: true, maxRounds: 2 } });
    expect(scenario.calls.sends).toHaveLength(0);
    await expect(page.getByRole("button", { name: "知识浏览", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("knowledge-assistant")).toBeHidden();
    expect(new URL(page.url()).searchParams.get("threadId")).toBeNull();
    scenario.complete();
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates");
    const preview = page.getByTestId("knowledge-build-preview");
    await updates.locator(".update-row").filter({ hasText: "项目说明原文" }).getByRole("button").click();
    await expect(preview).toContainText("直接引用现有资料");
    await expect(preview).toContainText("读取时间");
    await expect(updates.getByRole("checkbox", { name: /^采用 项目说明原文 ·/ })).toBeChecked();
    scenario.summaries.at(-1)!.active = false;
    expect(scenario.calls.connects).toHaveLength(0);
    await expectNoHorizontalOverflow(preview);
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect.poll(() => scenario.saves.length).toBe(1);
    expect(scenario.applies[0]).toMatchObject({ treeHash: null, planHash: "f".repeat(64), selections: expect.arrayContaining([{ nodeId: "project", revisionId: null }, { nodeId: "guide", revisionId: null }]) });
    expect(scenario.applies[0]!.selections).toHaveLength(2);
    expect((scenario.saves[0]!.schedule as RequestBody)).toMatchObject({ enabled: true, cronExpr: "0 3 * * *", timezone: "Asia/Singapore" });
    expect(scenario.calls.connects).toHaveLength(0);
    expect(new URL(page.url()).searchParams.get("threadId")).toBeNull();
    await expect(updates).toHaveCount(0);
    await expect(page.locator("div.document")).toContainText("直接引用现有资料");
    scenario.changeSource();
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "项目地图");
    await tree.getByRole("button", { name: "项目说明原文", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("实时引用 · 原文已变化");
    await expect(page.locator("div.document")).toContainText("已更新的项目说明");
    await expect(page.getByRole("button", { name: "复检当前知识", exact: true })).toHaveCount(0);
  });

  test("PK-build-portable 另一Client缺少原会话仍可预览采用项目候选", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    scenario.summaries.splice(0);
    scenario.denyBinding();
    const creates = scenario.calls.creates.length;
    await page.reload();
    await openGenerationResults(page);
    const updates = page.getByTestId("knowledge-updates"), preview = page.getByTestId("knowledge-build-preview");
    await expect(updates.locator(".update-row")).toHaveCount(3);
    await updates.locator(".update-row").filter({ hasText: "关键机制" }).getByRole("button").click();
    await updates.getByRole("tab", { name: "完整内容", exact: true }).click();
    await expect(preview).toContainText("关键机制正文");
    await updates.locator(".update-row").filter({ hasText: "关键机制" }).getByRole("checkbox").check();
    await updates.getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect.poll(() => scenario.applies.length).toBe(1);
    await expect.poll(() => scenario.saves.length).toBe(1);
    expect(scenario.calls.connects).toHaveLength(0);
    expect(scenario.calls.creates).toHaveLength(creates);
  });

  test("PK-build-04 原引擎不可用时保留选择，显式确认后冻结模型再构建", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { claudeOnly: true });
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    const dialog = page.getByRole("dialog", { name: "规格库构建设置" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("批量生成引擎", { exact: true })).toHaveValue("codex");
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
    await dialog.getByLabel("批量生成引擎", { exact: true }).selectOption("claude");
    await dialog.getByRole("button", { name: "保存并开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.creates[0]).toMatchObject({ engine: "claude", model: "claude-test", nodeId: null });
    expect(scenario.calls.generates[0]).toMatchObject({ engine: "claude", model: "claude-test", mode: "build", reviewConfig: { model: "claude-test" } });
    expect(await page.evaluate(workspaceId => JSON.parse(localStorage.getItem(`codeflow:knowledge-build-prefs:${workspaceId}`)!), WORKSPACE_ID)).toMatchObject({ engine: "claude", model: "claude-test" });
    await expect(page.getByTestId("knowledge-assistant")).toBeHidden();
  });

  test("PK-build-model-null 旧配置没有具体模型时先确认，不创建默认供应商任务", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "codex", model: null, effort: null })), WORKSPACE_ID);
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    const dialog = page.getByRole("dialog", { name: "规格库构建设置" });
    await expect(dialog).toBeVisible();
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
    await dialog.getByRole("button", { name: "保存并开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ engine: "codex", model: "gpt-test", effort: "high" });
  });

  test("PK-build-new-session 新知识会话优先项目模型设置，历史会话保持原配置", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "codex", model: "gpt-second", effort: "low" })), WORKSPACE_ID);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant.locator(".composer__textarea")).toBeVisible();
    await assistant.getByRole("button", { name: "管理规格会话", exact: true }).click();
    await page.getByRole("button", { name: "新建规格会话", exact: true }).click();
    await expect.poll(() => scenario.calls.creates.length).toBe(1);
    expect(scenario.calls.creates[0]).toMatchObject({ workspaceId: WORKSPACE_ID, engine: "codex", model: "gpt-second", effort: "low" });
    expect(scenario.summaries[0]).toMatchObject({ model: "gpt-test", effort: "high" });
    expect(scenario.calls.prefs).toHaveLength(0);
  });

  test("PK-engine-toolbar 引擎在模型左边，切换沿用DeepSeek并携带草稿，构建使用相同配置", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await installKnowledgeEngineCatalog(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "claude", model: "deepseek-flash", effort: "high" })), WORKSPACE_ID);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant"), input = assistant.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await expect(page.locator(".page-header").getByRole("button", { name: "构建设置", exact: true })).toHaveCount(0);
    await expect(page.locator(".page-header").getByRole("button", { name: "一键生成", exact: true })).toHaveCount(0);
    const engine = assistant.getByLabel("规格会话引擎");
    await expect(engine).toContainText("Codex");
    const engineBox = await engine.boundingBox(), modelBox = await assistant.locator(".composer__model-select").boundingBox();
    expect(engineBox!.x + engineBox!.width).toBeLessThanOrEqual(modelBox!.x + 1);
    await input.fill("只整理对 AI 有价值的规格约束");
    await assistant.locator('input[type="file"]').setInputFiles({ name: "constraints.txt", mimeType: "text/plain", buffer: Buffer.from("保留原始约束") });
    await expect(assistant.locator(".composer__attachment")).toContainText("constraints.txt");
    await engine.click();
    await page.locator(".ant-select-dropdown:visible").getByText("Claude", { exact: true }).click();
    await expect.poll(() => scenario.calls.creates.length).toBe(1);
    const newId = String(scenario.summaries[1]!.threadId);
    await expect(page).toHaveURL(new RegExp(`threadId=${newId}`));
    await expect(input).toHaveValue("只整理对 AI 有价值的规格约束");
    await expect(assistant.locator(".composer__attachment")).toContainText("constraints.txt");
    await expect(engine).toContainText("Claude");
    await expect(assistant.locator(".composer__model-select")).toContainText("DeepSeek Flash");
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null, engine: "claude", model: "deepseek-flash", effort: "high" });
    expect(scenario.summaries[0]).toMatchObject({ engine: "codex", model: "gpt-test" });
    expect(scenario.savedDraftByThreadId.get(scenario.threadId)).toMatchObject({ text: "只整理对 AI 有价值的规格约束", files: [expect.objectContaining({ name: "constraints.txt" })] });
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.generates.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ engine: "claude", model: "deepseek-flash", effort: "high", reviewConfig: { model: "deepseek-flash", effort: "high" } });
    expect(scenario.calls.creates.every(call => call.engine === "claude" && call.model === "deepseek-flash")).toBe(true);
  });

  test("PK-toolbar-simple 知识工具栏按内容定宽，隐藏Fast及输入提示，生成入口只在左侧", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { empty: true });
    const longLabel = "测试模型 B · 一个需要完整显示的长模型名称";
    await page.route("**/api/engines/status**", route => route.fulfill({ json: { ok: true, catalogVersion: 2, hostAppliedCatalogVersion: 2, hostCatalogSyncState: "applied", engines: [{ engineType: "codex", installed: true, features: {}, credentialStatus: { available: true }, providerCredentialStatus: [{ providerId: "openai", available: true }], models: ["gpt-test", "gpt-second"].map((id, index) => ({ id, displayName: index ? longLabel : "模型 A", providerId: "openai", isDefault: !index, supportsFastMode: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }, { reasoningEffort: "low", description: "" }], defaultReasoningEffort: "high" })) }] } }));
    await page.route("**/api/threads/prefs", route => route.fulfill({ json: { ok: true, prefs: { model: "gpt-test", effort: "high", accessMode: "read-only", serviceTier: "fast" } } }));
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant"), input = assistant.locator(".composer__textarea"), model = assistant.locator(".composer__model-select");
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute("placeholder", "");
    await expect(assistant.getByRole("button", { name: "Fast", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "一键生成", exact: true })).toHaveCount(1);
    await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "一键生成", exact: true })).toBeVisible();
    await expect(page.locator(".page-header").getByRole("button", { name: "一键生成", exact: true })).toHaveCount(0);
    const shortWidth = (await model.boundingBox())!.width;
    await model.click();
    await page.locator(".composer__model-dropdown").getByText(longLabel, { exact: true }).click();
    await expect(model).toContainText(longLabel);
    expect((await model.boundingBox())!.width).toBeGreaterThan(shortWidth + 80);
    const labelFits = await model.locator(".ant-select-selection-item").evaluate(el => el.scrollWidth <= el.clientWidth + 1);
    expect(labelFits).toBe(true);
    await input.fill("确认标准档位发送");
    await assistant.locator(".composer__send-btn").click();
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    expect(scenario.calls.sends[0]).toMatchObject({ model: "gpt-second", serviceTier: null });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "AI 对话", exact: true }).click();
    await expect(assistant).toBeVisible();
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
    await expectInside(assistant.locator(".composer__send-btn"), assistant);
  });

  test("PK-engine-settings-recover 新建会话模型失效后，旧会话仍可保存设置并保留输入", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "codex", model: "unavailable-model", effort: "high" })), WORKSPACE_ID);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant"), input = assistant.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await input.fill("修复配置时也保留输入");
    await assistant.getByRole("button", { name: "管理规格会话", exact: true }).click();
    await page.getByRole("button", { name: "新建规格会话", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "规格库构建设置", exact: true });
    await expect(settings).toBeVisible();
    await expect(settings).toContainText("所选模型不在当前引擎目录中");
    await settings.getByLabel("批量生成模型", { exact: true }).selectOption("gpt-second");
    await settings.getByRole("button", { name: "保存构建设置", exact: true }).click();
    await expect(settings).not.toBeVisible();
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("修复配置时也保留输入");
    await expect(assistant.locator(".composer__model-select")).toContainText("测试模型 B");
    await expect(page).toHaveURL(new RegExp(`threadId=${scenario.threadId}`));
    expect(scenario.calls.creates).toHaveLength(0);
  });

  for (const failure of ["credential", "create", "draft"] as const) test(`PK-engine-failure-${failure} 切换失败保留原会话和草稿并显式显示原因`, async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await installKnowledgeEngineCatalog(page, failure !== "credential");
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "claude", model: "deepseek-flash", effort: "high" })), WORKSPACE_ID);
    if (failure === "create") await page.route("**/api/knowledge/assets/conversation.create", route => route.fulfill({ status: 503, json: { ok: false, code: "E2E_CREATE_FAILED", message: "模拟会话创建失败" } }));
    if (failure === "draft") await page.route("**/api/threads/draft/save", route => route.fulfill({ status: 503, json: { ok: false, code: "E2E_DRAFT_FAILED", message: "模拟草稿保存失败" } }));
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant"), input = assistant.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await input.fill("切换失败也不能丢失的草稿");
    await assistant.getByLabel("规格会话引擎").click();
    await page.locator(".ant-select-dropdown:visible").getByText("Claude", { exact: true }).click();
    await expect(assistant.getByTestId("knowledge-conversation-binding")).toContainText(failure === "credential" ? "DeepSeek 缺少凭据" : failure === "create" ? "模拟会话创建失败" : "模拟草稿保存失败");
    await expect(page).toHaveURL(new RegExp(`threadId=${scenario.threadId}`));
    await expect(input).toHaveValue("切换失败也不能丢失的草稿");
    await expect(input).toBeEnabled();
    await expect(assistant.getByLabel("规格会话引擎")).toContainText("Codex");
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
    expect(await page.evaluate(workspaceId => JSON.parse(localStorage.getItem(`codeflow:knowledge-build-prefs:${workspaceId}`)!), WORKSPACE_ID)).toMatchObject({ engine: "claude", model: "deepseek-flash" });
  });

  test("PK-engine-running 运行期间禁止切换引擎，停止后恢复", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { holdFirstTurn: true });
    await installKnowledgeEngineCatalog(page);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant"), input = assistant.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await input.fill("分析项目要求");
    await assistant.locator(".composer__send-btn").click();
    const engineInput = assistant.getByLabel("规格会话引擎").getByRole("combobox");
    await expect(engineInput).toBeDisabled();
    await expect(assistant.locator(".composer__send-btn")).toHaveAttribute("aria-label", "终止");
    await assistant.locator(".composer__send-btn").click();
    await expect(engineInput).toBeEnabled();
    expect(scenario.calls.creates).toHaveLength(0);
  });

  test("PK-engine-model-sync 工具栏模型和强度修改同步后续构建，恢复会话不覆盖已保存偏好", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "claude", model: "deepseek-flash", effort: "high" })), WORKSPACE_ID);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    expect(await page.evaluate(workspaceId => JSON.parse(localStorage.getItem(`codeflow:knowledge-build-prefs:${workspaceId}`)!), WORKSPACE_ID)).toMatchObject({ engine: "claude", model: "deepseek-flash" });
    await assistant.locator(".composer__model-select").click();
    await page.locator(".composer__model-dropdown").getByText("测试模型 B", { exact: true }).click();
    await assistant.locator(".composer__effort-select").click();
    await page.locator(".composer__effort-dropdown .ant-select-item-option-content").filter({ hasText: /^low$/ }).click();
    expect(await page.evaluate(workspaceId => JSON.parse(localStorage.getItem(`codeflow:knowledge-build-prefs:${workspaceId}`)!), WORKSPACE_ID)).toMatchObject({ engine: "codex", model: "gpt-second", effort: "low" });
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.generates.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ engine: "codex", model: "gpt-second", effort: "low", reviewConfig: { model: "gpt-second", effort: "low" } });
    expect(scenario.calls.creates).toHaveLength(1);
  });

  for (const engine of ["codex", "claude"] as const) test(`PK-engine-settings-${engine} 保存设置同步当前会话，后续模型与引擎显示一致`, async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    if (engine === "claude") await installKnowledgeEngineCatalog(page);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant"), input = assistant.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await input.fill("模型设置切换时保留输入");
    await assistant.getByRole("button", { name: "管理规格会话", exact: true }).click();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "规格库构建设置", exact: true });
    await settings.getByLabel("批量生成引擎", { exact: true }).selectOption(engine);
    await settings.getByLabel("批量生成模型", { exact: true }).selectOption(engine === "claude" ? "deepseek-flash" : "gpt-second");
    if (engine === "codex") await settings.getByLabel("批量思考强度", { exact: true }).selectOption("low");
    await settings.getByRole("button", { name: "保存构建设置", exact: true }).click();
    await expect(settings).not.toBeVisible();
    await expect(input).toHaveValue("模型设置切换时保留输入");
    await expect(assistant.getByLabel("规格会话引擎")).toContainText(engine === "claude" ? "Claude" : "Codex");
    await expect(assistant.locator(".composer__model-select")).toContainText(engine === "claude" ? "DeepSeek Flash" : "测试模型 B");
    expect(scenario.calls.creates).toHaveLength(engine === "claude" ? 1 : 0);
    if (engine === "codex") expect(scenario.calls.prefs.at(-1)).toMatchObject({ threadId: scenario.threadId, prefs: { model: "gpt-second", effort: "low" } });
    else expect(scenario.summaries[0]).toMatchObject({ model: "gpt-test", engine: "codex" });
  });

  test("PK-engine-roundtrip 往返切换引擎继续使用DeepSeek，不回退Anthropic默认模型", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await installKnowledgeEngineCatalog(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "claude", model: "deepseek-flash", effort: "high" })), WORKSPACE_ID);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    for (const [index, label] of ["Claude", "Codex", "Claude"].entries()) {
      await assistant.getByLabel("规格会话引擎").click();
      await page.locator(".ant-select-dropdown:visible").getByText(label, { exact: true }).click();
      await expect.poll(() => scenario.calls.creates.length).toBe(index + 1);
      await expect(assistant.locator(".composer__model-select")).toContainText(label === "Claude" ? "DeepSeek Flash" : "测试模型 A");
      await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    }
    expect(scenario.calls.creates.map(call => [call.engine, call.model])).toEqual([["claude", "deepseek-flash"], ["codex", "gpt-test"], ["claude", "deepseek-flash"]]);
    // 刷新后其他引擎的会话尚未 hydrate，仍须优先使用知识摘要里的模型。
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "codex", model: "gpt-test", effort: "high" })), WORKSPACE_ID);
    await openKnowledge(page, scenario.threadId);
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    await assistant.getByLabel("规格会话引擎").click();
    await page.locator(".ant-select-dropdown:visible").getByText("Claude", { exact: true }).click();
    await expect.poll(() => scenario.calls.creates.length).toBe(4);
    expect(scenario.calls.creates[3]).toMatchObject({ engine: "claude", model: "deepseek-flash" });
  });

  test("PK-engine-effort 旧强度不被新模型支持时，构建使用工具栏实际显示的有效强度", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { secondModelLowOnly: true });
    await page.route("**/api/engines/status**", route => route.fulfill({ json: { ok: true, catalogVersion: 2, hostAppliedCatalogVersion: 2, hostCatalogSyncState: "applied", engines: [{ engineType: "codex", installed: true, features: {}, credentialStatus: { available: true }, providerCredentialStatus: [{ providerId: "openai", available: true }], models: [
      { id: "gpt-test", displayName: "测试模型 A", providerId: "openai", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }, { reasoningEffort: "low", description: "" }], defaultReasoningEffort: "low" },
      { id: "gpt-second", displayName: "测试模型 B", providerId: "openai", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }], defaultReasoningEffort: "low" },
    ] }] } }));
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    await assistant.locator(".composer__model-select").click();
    await page.locator(".composer__model-dropdown").getByText("测试模型 B", { exact: true }).click();
    await expect(assistant.locator(".composer__effort-select")).toContainText("low");
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.generates.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ model: "gpt-second", effort: "low", reviewConfig: { effort: "low" } });
  });

  for (const available of [true, false]) test(`PK-build-deepseek ${available ? '生成复检和新会话固定DeepSeek' : 'DeepSeek凭据不可用时不改用默认供应商'}`, async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, JSON.stringify({ engine: "claude", model: "deepseek-flash", effort: "high" })), WORKSPACE_ID);
    await page.route("**/api/engines/status**", route => route.fulfill({ json: { ok: true, catalogVersion: 2, hostAppliedCatalogVersion: 2, hostCatalogSyncState: "applied", engines: [{ engineType: "claude", installed: true, features: {}, credentialStatus: { available: true }, providerCredentialStatus: [{ providerId: "anthropic", available: true }, { providerId: "deepseek", available, message: available ? null : "DeepSeek 缺少凭据" }], models: [{ id: "claude-test", displayName: "默认 Anthropic", providerId: "anthropic", isDefault: true }, { id: "deepseek-flash", displayName: "DeepSeek Flash", providerId: "deepseek", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], defaultReasoningEffort: "high" }] }] } }));
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    if (!available) {
      await expect(page.getByRole("dialog", { name: "规格库构建设置" })).toBeVisible();
      expect(scenario.calls.creates).toHaveLength(0);
      expect(scenario.calls.generates).toHaveLength(0);
      await expect(page.getByLabel("批量生成模型", { exact: true })).toHaveValue("deepseek-flash");
      return;
    }
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.creates[0]).toMatchObject({ workspaceId: WORKSPACE_ID, engine: "claude", model: "deepseek-flash", effort: "high" });
    expect(scenario.calls.generates[0]).toMatchObject({ engine: "claude", model: "deepseek-flash", reviewConfig: { model: "deepseek-flash", effort: "high" } });
    scenario.complete();
    await openGenerationResults(page);
    await page.getByTestId("knowledge-updates").locator(".update-row").filter({ hasText: "项目说明原文" }).getByRole("button").click();
    await expect(page.getByTestId("knowledge-build-preview")).toBeVisible({ timeout: 10_000 });
    await openKnowledgeDiscussion(page);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant.getByLabel("会话引擎")).toHaveCount(0);
    await assistant.getByRole("button", { name: "新建独立会话", exact: true }).click();
    await expect.poll(() => scenario.calls.creates.length).toBe(2);
    expect(scenario.calls.creates[1]).toMatchObject({ workspaceId: WORKSPACE_ID, engine: "claude", model: "deepseek-flash", effort: "high" });
  });

  test("PK-build-empty-restart 空库停止构建后仍保留一个生成入口，可直接新建构建", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    await page.locator(".task-summary").getByRole("button", { name: /^停\s*止$/ }).click();
    await expect.poll(() => scenario.calls.stops.length).toBe(1);
    await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "一键生成", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "一键生成", exact: true })).toHaveCount(1);
    await startKnowledgeBuild(page);
    await expect.poll(() => scenario.calls.starts.length).toBe(2);
    expect(scenario.calls.creates).toHaveLength(2);
    expect(scenario.calls.generates).toHaveLength(2);
    expect(scenario.calls.generates[1]!.requestId).not.toBe(scenario.calls.generates[0]!.requestId);
  });

  test("PK-build-prefs-error 配置损坏和保存失败均显式中止，不回退其他模型", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    await page.evaluate(workspaceId => localStorage.setItem(`codeflow:knowledge-build-prefs:${workspaceId}`, "{invalid"), WORKSPACE_ID);
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    const dialog = page.getByRole("dialog", { name: "规格库构建设置" });
    await expect(dialog).toBeVisible();
    expect(scenario.calls.creates).toHaveLength(0);
    await dialog.getByLabel("批量生成引擎", { exact: true }).selectOption("codex");
    await dialog.getByLabel("批量生成模型", { exact: true }).selectOption("gpt-test");
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key.startsWith("codeflow:knowledge-build-prefs:")) throw new Error("E2E 模型设置存储失败"); return original.call(this, key, value); };
    });
    await dialog.getByRole("button", { name: "保存并开始生成", exact: true }).click();
    await expect(dialog).toContainText("E2E 模型设置存储失败");
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
  });

  test("PK-batch-freeze 会话创建延迟时锁定表单，任务使用点击时的参数", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2, secondModelLowOnly: true });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成", exact: true });
    await modal.getByRole("combobox", { name: "批量生成模型", exact: true }).selectOption("gpt-second");
    await modal.getByRole("switch", { name: "包含所选目录的后代", exact: true }).click();
    await modal.getByRole("textbox", { name: "批量生成要求", exact: true }).fill("固定本次要求");
    await modal.getByRole("spinbutton", { name: "批次并发数", exact: true }).fill("2");
    let release!: () => void, creating = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/conversation.create", async route => { creating = true; await gate; await route.fallback(); });
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => creating).toBe(true);
    for (const control of [
      modal.getByRole("combobox", { name: "批量生成引擎", exact: true }),
      modal.getByRole("combobox", { name: "批量生成模型", exact: true }),
      modal.getByRole("switch", { name: "包含所选目录的后代", exact: true }),
      modal.getByRole("radio", { name: "只补齐空白", exact: true }),
      modal.getByRole("textbox", { name: "批量生成要求", exact: true }),
      modal.getByRole("button", { name: /取\s*消/, exact: true }),
    ]) await expect(control).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    release();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.creates).toHaveLength(1);
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null, model: "gpt-second", effort: "low" });
    expect(scenario.calls.generates[0]).toMatchObject({ ownerThreadId: scenario.summaries.at(-1)!.threadId, selectedNodeIds: ["root"], includeDescendants: false, strategy: "all", prompt: "固定本次要求", treeHash: "a".repeat(64), concurrency: 2, model: "gpt-second", effort: "low" });
  });

  test("PK-batch-start-retry 生成计划成功但启动失败后复用原任务与归属会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    const attempts: RequestBody[] = [];
    await page.route("**/api/knowledge/assets/run.start", async route => {
      attempts.push(route.request().postDataJSON() as RequestBody);
      if (attempts.length === 1) return route.fulfill({ status: 503, json: { ok: false, code: "E2E_START_FAILED", message: "模拟启动失败" } });
      await route.fallback();
    });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成", exact: true });
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(modal).toContainText("模拟启动失败");
    await expect(modal.getByRole("textbox", { name: "批量生成要求", exact: true })).toBeDisabled();
    await modal.getByRole("button", { name: "重试原任务", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(attempts).toEqual([{ workspaceId: WORKSPACE_ID, runId: "batch-e2e" }, { workspaceId: WORKSPACE_ID, runId: "batch-e2e" }]);
    expect(scenario.calls.generates).toHaveLength(1);
    expect(scenario.calls.creates).toHaveLength(1);
    await expect(modal).not.toBeVisible();
  });

  test("PK-batch-settings 待恢复任务与构建设置互不改写，重开显示原冻结参数", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 1, secondModelLowOnly: true });
    let attempts = 0;
    await page.route("**/api/knowledge/assets/run.start", async route => {
      if (++attempts === 1) return route.fulfill({ status: 503, json: { ok: false, code: "E2E_START_FAILED", message: "模拟启动失败" } });
      await route.fallback();
    });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成", exact: true });
    await modal.getByRole("combobox", { name: "批量生成模型", exact: true }).selectOption("gpt-second");
    await modal.getByRole("switch", { name: "包含所选目录的后代", exact: true }).click();
    await modal.getByRole("textbox", { name: "批量生成要求", exact: true }).fill("原批任务目标");
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect(modal).toContainText("模拟启动失败");
    await modal.getByRole("button", { name: /取\s*消/, exact: true }).click();
    await configureMockKnowledgeModel(page);
    await openKnowledgeMenu(page, "高级生成");
    await expect(modal.getByRole("combobox", { name: "批量生成模型", exact: true })).toHaveValue("gpt-second");
    await expect(modal.getByRole("combobox", { name: "批量思考强度", exact: true })).toHaveValue("low");
    await expect(modal.getByRole("switch", { name: "包含所选目录的后代", exact: true })).not.toBeChecked();
    await expect(modal.getByRole("textbox", { name: "批量生成要求", exact: true })).toHaveValue("原批任务目标");
    await modal.getByRole("button", { name: "重试原任务", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates).toHaveLength(1);
    expect(scenario.calls.generates[0]).toMatchObject({ model: "gpt-second", effort: "low", includeDescendants: false, prompt: "原批任务目标" });
    expect(scenario.calls.creates).toHaveLength(1);
  });

  test("PK-build-start-retry 一键构建启动失败后只重试原计划，不重建归属会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    const attempts: RequestBody[] = [];
    await page.route("**/api/knowledge/assets/run.start", async route => {
      attempts.push(route.request().postDataJSON() as RequestBody);
      if (attempts.length === 1) return route.fulfill({ status: 503, json: { ok: false, code: "E2E_START_FAILED", message: "模拟构建启动失败" } });
      await route.fallback();
    });
    await openKnowledge(page);
    await startKnowledgeBuild(page);
    const failure = page.locator(".knowledge-page > .page-error");
    await expect(failure).toContainText("模拟构建启动失败");
    await expect(failure.getByRole("button", { name: "恢复生成", exact: true })).toBeVisible();
    await failure.getByRole("button", { name: "恢复生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(attempts).toEqual([{ workspaceId: WORKSPACE_ID, runId: "build-e2e" }, { workspaceId: WORKSPACE_ID, runId: "build-e2e" }]);
    expect(scenario.calls.generates).toHaveLength(1);
    expect(scenario.calls.creates).toHaveLength(1);
    await expect(page.locator(".task-summary")).toContainText("文档生成中");
    await expect(page.locator(".knowledge-page > .page-error")).toHaveCount(0);
  });

  for (const kind of ["batch", "build"] as const) test(`PK-generation-reset-${kind} 明确放弃冲突请求后刷新事实并允许重新配置`, async ({ page }) => {
    await installSession(page);
    const scenario = kind === "build" ? await installBuildScenario(page) : await installKnowledgeScenario(page);
    const attempts: RequestBody[] = [];
    await page.route("**/api/knowledge/assets/generate", async route => {
      attempts.push(route.request().postDataJSON() as RequestBody);
      if (attempts.length === 1) return route.fulfill({ status: 409, json: { ok: false, code: "KNOWLEDGE_ASSET_CONFLICT", message: "模拟目录已变化" } });
      await route.fallback();
    });
    await openKnowledge(page, kind === "batch" ? scenario.threadId : undefined);
    if (kind === "batch") {
      await page.getByTestId("knowledge-tree").getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
      await openKnowledgeMenu(page, "高级生成");
      await page.getByRole("dialog", { name: "确认批量生成", exact: true }).getByRole("button", { name: "开始生成", exact: true }).click();
    } else await startKnowledgeBuild(page);
    const failure = kind === "batch" ? page.getByRole("dialog", { name: "确认批量生成", exact: true }) : page.locator(".knowledge-page > .page-error");
    await expect(failure).toContainText("模拟目录已变化");
    const refreshedHash = "c".repeat(64);
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ json: { ok: true, data: { initialized: true, knowledgeId: "kb-e2e", root: "codeflow-docs/知识库", tree: { schemaVersion: 1, instructions: "", nodes: kind === "batch" ? [assetNode()] : [] }, treeHash: refreshedHash, canWrite: true, states: kind === "batch" ? [{ nodeId: "root", revisionId: null, draftCount: 0, error: null }] : [] } } }));
    await failure.getByRole("button", { name: kind === "batch" ? "重新配置" : "放弃本次恢复", exact: true }).click();
    if (kind === "batch") {
      const modal = page.getByRole("dialog", { name: "确认批量生成", exact: true });
      await expect(modal.getByRole("textbox", { name: "批量生成要求", exact: true })).toBeEnabled();
      await modal.getByRole("textbox", { name: "批量生成要求", exact: true }).fill("重新确认后的要求");
      await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    } else {
      await expect(failure).toHaveCount(0);
      await startKnowledgeBuild(page);
    }
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ treeHash: refreshedHash, ...(kind === "batch" ? { prompt: "重新确认后的要求" } : {}) });
    expect(attempts[1]!.requestId).not.toBe(attempts[0]!.requestId);
    expect(scenario.calls.creates).toHaveLength(2);
  });

  test("PK-preview-cancel 切换预览取消旧正文读取，不误报错误或回灌旧内容", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    const preview = page.getByTestId("knowledge-build-preview");
    let release!: () => void, completed!: () => void, waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const responseDone = new Promise<void>(resolve => { completed = resolve; });
    await page.route("**/api/knowledge/assets/node?**", async route => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("nodeId") !== "guide" || !query.has("runId") || waiting) return route.fallback();
      waiting = true;
      await gate;
      await route.fallback();
      completed();
    });
    const updates = page.getByTestId("knowledge-updates");
    await updates.locator(".update-row").filter({ hasText: "项目说明原文" }).getByRole("button").click();
    await expect.poll(() => waiting).toBe(true);
    await updates.locator(".update-row").filter({ hasText: "关键机制" }).getByRole("button").click();
    await expect(preview.locator(".preview-content")).toContainText("关键机制正文");
    release(); await responseDone;
    await expect(preview.locator(".ant-alert-error")).toHaveCount(0);
    await expect(page.locator(".knowledge-page > .page-error")).toHaveCount(0);
    await expect(preview.locator(".preview-content")).toContainText("关键机制正文");
  });

  test("PK-workspace-reload 切换项目后刷新固定新项目并移除旧项目深链", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    const nextWorkspace = "workspace_knowledge_reload_next";
    await page.route("**/api/workspaces?**", route => route.fulfill({ json: { ok: true, workspaces: [
      { id: WORKSPACE_ID, title: "原知识项目", path: "D:/e2e-workspace", kind: "local", createdAt: 1, updatedAt: 1 },
      { id: nextWorkspace, title: "新知识项目", path: "D:/next-knowledge", kind: "local", createdAt: 1, updatedAt: 1 },
    ], workspaceListAuthoritative: true } }));
    await page.route("**/api/knowledge/assets/snapshot?**", route => new URL(route.request().url()).searchParams.get("workspaceId") === nextWorkspace ? route.fulfill({ json: { ok: true, data: { initialized: true, canWrite: true, treeHash: null, states: [], tree: { schemaVersion: 2, instructions: "", nodes: [] } } } }) : route.fallback());
    await page.route("**/api/knowledge/assets/conversation.list?**", route => new URL(route.request().url()).searchParams.get("workspaceId") === nextWorkspace ? route.fulfill({ json: { ok: true, data: [] } }) : route.fallback());
    await page.goto(`/knowledge?workspaceId=${WORKSPACE_ID}&threadId=${scenario.threadId}`);
    await showKnowledgeAssistant(page);
    await page.locator(".ws-compact-trigger").click();
    await page.locator(".ws-compact-option").filter({ hasText: "新知识项目" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("workspaceId")).toBe(nextWorkspace);
    await expect(page.getByLabel("规格库所属项目", { exact: true })).toHaveText("新知识项目");
    expect(new URL(page.url()).searchParams.has("threadId")).toBe(false);
    await page.reload();
    await expect(page.getByLabel("规格库所属项目", { exact: true })).toHaveText("新知识项目");
    expect(new URL(page.url()).searchParams.get("workspaceId")).toBe(nextWorkspace);
    await showKnowledgeAssistant(page);
    await expect(page.getByTestId("knowledge-assistant").locator(".composer__textarea")).toHaveCount(0);
    expect(scenario.calls.creates).toHaveLength(0);
  });

  for (const timezone of [
    { id: "Asia/Shanghai", taskTime: "2026-10-21 09:36", revisionTime: "2026-09-21 20:00:00" },
    { id: "America/Los_Angeles", taskTime: "2026-10-20 18:36", revisionTime: "2026-09-21 05:00:00" },
  ]) test.describe(`知识时间 ${timezone.id}`, () => {
    test.use({ timezoneId: timezone.id });

    test("PK-timezone 构建记录与待采用版本按浏览器时区显示", async ({ page }) => {
      await installSession(page);
      const scenario = await installKnowledgeScenario(page, { reviewState: "pending" });
      scenario.setRun({ schemaVersion: 1, id: "timezone-build", createdAt: "2026-10-21T01:36:03.157Z", mode: "build", nodeId: null,
        phase: "planning", active: true, proposedTree: null, items: [], ownerThreadId: scenario.threadId, engine: "codex", model: "gpt-test", effort: "high",
        treeHash: "a".repeat(64), prompt: "", rationale: "", gaps: [], error: null, activeItemId: null });
      await openKnowledge(page);
      await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "选择知识版本", exact: true }).locator("option:checked")).toHaveText(`待采用 · ${timezone.revisionTime}`);
    });
  });

  for (const width of [1366, 760]) test("PK-poll-layout-" + width + " 任务摘要自动同步且主页面布局稳定", async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installSession(page);
    await installKnowledgeScenario(page, { delivering: true });
    await openKnowledge(page);
    const summary = page.locator(".task-summary");
    await expect(summary).toBeVisible();
    const before = await summary.boundingBox();
    let requests = 0;
    await page.route("**/api/knowledge/assets/runs?**", async route => { requests++; await route.fallback(); });
    await expect.poll(() => requests, { timeout: 8000 }).toBeGreaterThan(0);
    expect(await summary.boundingBox()).toEqual(before);
    await expect(summary.getByRole("button", { name: "任务详情", exact: true })).toHaveCount(0);
  });

  test("PK-review-fix-01 搜索保留且不显示过滤，选择知识后仍检索全库", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page);
    const searches: URL[] = [];
    await page.route("**/api/knowledge/assets/search?**", route => { searches.push(new URL(route.request().url())); return route.fallback(); });
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const search = page.getByTestId("knowledge-search");
    await expect(search.getByRole("combobox")).toHaveCount(0);
    await expect(search.getByRole("button", { name: /过滤/ })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "仅搜索所选节点及子项", exact: true })).toHaveCount(0);
    await search.getByRole("textbox").fill("权限");
    await search.getByRole("button", { name: /^搜\s*索$/ }).click();
    await expect.poll(() => searches.length).toBe(1);
    expect(searches[0]!.searchParams.has("nodeId")).toBe(false);
    await expect(page.getByTestId("knowledge-search-results")).toContainText("全部规格与文档");
    await page.getByTestId("knowledge-search-results").getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("button", { name: "规格库概览", exact: true })).toHaveCount(0);
    await search.getByRole("button", { name: /^搜\s*索$/ }).click();
    await expect.poll(() => searches.length).toBe(2);
    expect(searches[1]!.searchParams.has("nodeId")).toBe(false);
  });

  test("PK-review-fix-02 引用可打开原文，相对文档与图片沿原文件目录读取", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    const files: string[] = [];
    await page.route("**/api/fs/readFile", route => {
      const path = String(route.request().postDataJSON().path); files.push(path);
      return route.fulfill({ json: { ok: true, path, content: path.endsWith(".png") ? null : "# 文件预览已打开", isBinary: path.endsWith(".png"), size: 100, base64: path.endsWith(".png") ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqZkAAAAASUVORK5CYII=" : null, mimeType: path.endsWith(".png") ? "image/png" : null } });
    });
    await completeBuild(page, scenario);
    const preview = page.getByTestId("knowledge-build-preview");
    await page.getByTestId("knowledge-updates").locator(".update-row").filter({ hasText: "项目说明原文" }).getByRole("button").click();
    await expect.poll(() => files.includes("docs/diagram.png")).toBe(true);
    await expect(preview.getByRole("img", { name: "架构图", exact: true })).toHaveAttribute("src", /^data:image\/png;base64,/);
    await preview.getByRole("button", { name: "打开原文", exact: true }).click();
    await expect(page.locator(".preview-window__filepath")).toHaveText("docs/guide.md");
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await preview.getByRole("link", { name: "阅读补充", exact: true }).click();
    await expect(page.locator(".preview-window__filepath")).toHaveText("docs/more.md");
    expect(files).toContain("docs/guide.md");
    expect(files).toContain("docs/more.md");
  });

  test("PK-review-fix-03 新候选详情与复检报告保留runId，不请求不存在的正式节点", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    await openGenerationResults(page);
    const tree = page.getByTestId("knowledge-tree");
    await expandKnowledgeDirectory(page, "项目地图");
    await tree.getByRole("button", { name: "项目说明原文", exact: true }).click();
    await expect(page.getByTestId("knowledge-build-preview")).toContainText("直接引用现有资料");
    await tree.getByRole("button", { name: "关键机制", exact: true }).click();
    await expect(page.getByTestId("knowledge-build-preview")).toContainText("关键机制正文");
    await expect(page.getByTestId("knowledge-build-preview").locator(".preview-tree")).toHaveCount(0);
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("关键机制");
    await page.getByTestId("knowledge-build-preview").getByRole("tab", { name: "复检报告", exact: true }).click();
    await expect(page.getByTestId("knowledge-review-report")).toContainText("独立复检已通过");
    const reads = scenario.reads.filter(url => url.searchParams.get("nodeId") === "new-doc");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.every(url => url.searchParams.get("runId") === "build-e2e")).toBe(true);
    await expect(page.getByRole("button", { name: "待处理", exact: true })).toHaveCount(0);
    await expandKnowledgeDirectory(page, "项目地图");
    await tree.getByRole("button", { name: "项目说明原文", exact: true }).click();
    await expect(page.getByTestId("knowledge-build-preview")).toContainText("直接引用现有资料");
    await expect(page.getByTestId("knowledge-build-preview")).not.toContainText("所选正文已被后续修订替代");
  });

  test("PK-review-fix-04 复检草稿统一预览后带确切版本采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario); scenario.asReview();
    await page.reload(); await openGenerationResults(page);
    await page.getByTestId("knowledge-updates").getByRole("button", { name: "采用所选内容", exact: true }).click();
    await expect.poll(() => scenario.applies.length).toBe(1);
    expect(scenario.applies[0]).toMatchObject({ requestId: expect.any(String), planHash: "f".repeat(64), selections: expect.arrayContaining([{ nodeId: "new-doc", revisionId: "build-doc-r1" }]) });
  });

  test("PK-review-fix-05 纯正式版本复检不展示采用入口", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario); scenario.asReview(true);
    await page.reload();
    await expect(page.locator(".updates-summary")).toHaveCount(0);
    await expandKnowledgeDirectory(page, "项目地图");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "关键机制", exact: true }).click();
    await openDocumentMenu(page, "复检报告");
    await expect(page.getByTestId("knowledge-updates")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-review-report")).toContainText("独立复检已通过");
    expect(scenario.applies).toHaveLength(0);
  });

  test("PK-review-fix-06 单篇批任务草稿转统一预览，只选该版本及必要祖先", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true, existingDocument: true });
    await completeBuild(page, scenario);
    const tree = page.getByTestId("knowledge-tree");
    await openGenerationResults(page);
    await expandKnowledgeDirectory(page, "项目地图");
    await tree.getByRole("button", { name: "项目说明原文", exact: true }).click();
    await expect(page.getByTestId("knowledge-build-preview")).toContainText("直接引用现有资料");
    await tree.getByRole("button", { name: "关键机制", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await expect(preview.locator(".preview-tree")).toHaveCount(0);
    await expect(preview.locator(".preview-content")).toContainText("关键机制正文");
    await expect(tree.locator(".asset-tree-row.selected")).toContainText("关键机制");
    await page.getByTestId("knowledge-updates").getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect.poll(() => scenario.applies.length).toBe(1);
    expect(scenario.applies[0]!.selections).toEqual(expect.arrayContaining([{ nodeId: "project", revisionId: null }, { nodeId: "new-doc", revisionId: "build-doc-r1" }]));
    expect(scenario.applies[0]!.selections).toHaveLength(2);
    expect(scenario.calls.adopts).toHaveLength(0);
  });

  test("PK-result-owner-01 工作会话修订归回原构建预览，采用绑定原任务和版本", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    scenario.addExecutionDiscussion();
    await page.reload(); await openGenerationResults(page);
    await expect(page.getByTestId("knowledge-updates").locator(".update-row").filter({ hasText: "关键机制" })).toHaveCount(1);
    await expandKnowledgeDirectory(page, "项目地图");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "关键机制", exact: true }).click();
    await expect(page.getByTestId("knowledge-build-preview")).toContainText("关键机制正文");
    expect(scenario.applies).toHaveLength(0);
    await page.getByTestId("knowledge-updates").getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect.poll(() => scenario.applies.length).toBe(1);
    expect(scenario.applies[0]).toMatchObject({ runId: "build-e2e", requestId: expect.any(String), planHash: "f".repeat(64), selections: expect.arrayContaining([{ nodeId: "new-doc", revisionId: "build-doc-r1" }]) });
    expect(scenario.calls.applies).toBe(0);
  });

  test("PK-result-owner-02 独立讨论正文可查看和单篇采用，不显示目录采用入口", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "pending", standaloneRevision: true });
    scenario.setRun({ id: "independent-discussion", createdAt: new Date().toISOString(), mode: "conversation", threadId: scenario.threadId, nodeId: "root", phase: "completed", active: false, proposedTree: null, prompt: "记录日志规范", engine: "codex", model: "gpt-test", effort: "high", rationale: "", gaps: [], error: null, items: [{ id: "item-root", nodeId: "root", title: "功能说明", status: "completed", revisionId: "revision-root", error: null }] });
    await openKnowledge(page); await openGenerationResults(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates).toContainText("错误边界记录结构化日志");
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect.poll(() => scenario.calls.adopts.length).toBe(1);
    expect(scenario.calls.adopts[0]).toMatchObject({ nodeId: "root", revisionId: "revision-root" });
    expect(scenario.calls.applies).toBe(0);
  });

  test("PK-review-fix-07 终止未完成采用沿原请求确认，保留已生效项且不伪装成功", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { failApplyOnce: true });
    await completeBuild(page, scenario);
    const preview = page.getByTestId("knowledge-build-preview");
    await page.getByTestId("knowledge-updates").getByRole("button", { name: "采用所选内容", exact: true }).click();
    await preview.getByRole("button", { name: "终止本次采用", exact: true }).click();
    const confirmation = page.getByRole("dialog").filter({ hasText: "终止本次未完成采用？" });
    await expect(confirmation).toContainText("已生效的知识会保留");
    await confirmation.getByRole("button", { name: "终止本次采用", exact: true }).click();
    await expect.poll(() => scenario.cancels.length).toBe(1);
    await expect(page.getByTestId("knowledge-updates").locator(".candidate-notice")).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "重试未完成采用", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "恢复未完成操作", exact: true })).toHaveCount(0);
    expect(scenario.cancels).toEqual([{ workspaceId: WORKSPACE_ID, runId: "build-e2e", requestId: scenario.applies[0]!.requestId }]);
    expect(scenario.applies).toHaveLength(1);
    expect(scenario.saves).toHaveLength(0);
  });

  test("PK-review-fix-08 目录不采用确认完整候选范围，发送null版本及预览指纹", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page);
    await completeBuild(page, scenario);
    const updates = page.getByTestId("knowledge-updates");
    await updates.getByRole("button", { name: "本次不采用", exact: true }).click();
    const confirmation = page.getByRole("dialog").filter({ hasText: "本次不采用此更新？" });
    await expect(confirmation).toContainText("本次处理 2 项：项目地图、项目说明原文");
    expect(scenario.dismisses).toHaveLength(0);
    await confirmation.getByRole("button", { name: "本次不采用", exact: true }).click();
    await expect.poll(() => scenario.dismisses.length).toBe(1);
    expect(scenario.dismisses[0]).toMatchObject({ runId: "build-e2e", nodeId: "project", revisionId: null, planHash: "f".repeat(64) });
    // 没有可采用的选中项时，当前产品隐藏采用按钮而不是置灰。
    await expect(updates.getByRole("button", { name: "采用所选内容", exact: true })).toHaveCount(0);
  });


  test("PK-45 统一清单覆盖分页建议，按目录核对并采用后保留正式导航", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page, { children: 2, noKnowledge: true });
    const base = { schemaVersion: 1, title: "验收修改", summary: "纠正次数", createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:00:00Z", status: "pending", origin: "chat", baseHash: null, baseContent: "旧规则", content: "新规则", sources: [], instructions: "", reviewedAt: null, reviewedBy: null, reviewNote: "", revisionId: null, hash: "change-hash", currentContent: "旧规则", stale: false, staleReasons: [] };
    const proposals = [{ ...base, id: "first-change", nodeId: "child-0", title: "资产 1 修改" }, { ...base, id: "second-change", nodeId: "child-1", title: "资产 2 修改" }];
    const reads: string[] = [];
    await page.route("**/api/knowledge/assets/changes?**", route => {
      const query = new URL(route.request().url()).searchParams;
      const scope = query.get("nodeId"); reads.push(scope || "all");
      const pending = proposals.filter(item => item.status === "pending");
      const scoped = pending.filter(item => !scope || scope === "root" || item.nodeId === scope);
      const offset = Number(query.get("offset") || 0);
      return route.fulfill({ json: { ok: true, data: { items: scoped.slice(offset, offset + 1), nextOffset: scoped.length > offset + 1 ? offset + 1 : null, pendingNodes: pending.map(item => ({ nodeId: item.nodeId, title: item.title, count: 1 })) } } });
    });
    await page.route("**/api/knowledge/assets/change?**", route => route.fulfill({ json: { ok: true, data: proposals.find(item => item.id === new URL(route.request().url()).searchParams.get("changeId")) } }));
    await page.route("**/api/knowledge/assets/change.review", route => {
      const item = proposals.find(item => item.id === route.request().postDataJSON().changeId)!; item.status = "approved";
      return route.fulfill({ json: { ok: true, data: item } });
    });
    await page.goto("/knowledge?view=approvals&changeId=first-change");
    const tree = page.getByTestId("knowledge-tree"), inbox = page.getByTestId("knowledge-change-inbox"), updates = page.getByTestId("knowledge-updates");
    await expect(inbox.locator(".detail-heading")).toContainText("资产 1 修改");
    await expect(page.locator(".change-list")).toHaveCount(0);
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await expect(tree.getByRole("button", { name: "资产 2", exact: true })).toBeVisible();
    await expect(updates.locator(".update-row")).toHaveCount(2);
    await updates.locator(".update-row").filter({ hasText: "资产 2 修改" }).getByRole("button").click();
    await expect(inbox.locator(".detail-heading")).toContainText("资产 2 修改");
    await page.reload();
    await expect(inbox.locator(".detail-heading")).toContainText("资产 2 修改");
    await tree.getByRole("button", { name: "资产 2", exact: true }).click();
    await expect(inbox.locator(".detail-heading")).toContainText("资产 2 修改");
    expect(reads).toContain("child-1");
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect(updates).toContainText(/已采用 1 项/u);
    await expect(tree.getByRole("button", { name: "资产 2", exact: true })).toBeVisible();
    await expect(tree.getByRole("button", { name: "资产 1", exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: test.info().outputPath("knowledge-shared-tree-approvals.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    await tree.getByRole("button", { name: "资产 1", exact: true }).click();
    await expect(tree).toBeHidden();
    await expect(inbox.locator(".detail-heading")).toContainText("资产 1 修改");
    await expectInside(updates.getByRole("button", { name: "采用此版本" }), page.locator(".knowledge-page"));
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
  });

  test.beforeEach(async ({ request }) => { await request.post(`${MOCK_URL}/api/test/reset`); });

  test("PK-50 定时更新配置直接选择模型与并发，保存和立即检查不借用研发会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2, noKnowledge: true });
    let schedule: RequestBody | null = null;
    let lastCheck: RequestBody | null = null;
    let saveBody: RequestBody | null = null;
    let starts = 0;
    await page.route("**/api/knowledge/assets/update.*", async route => {
      const action = new URL(route.request().url()).pathname.split("/").at(-1);
      if (action === "update.save") {
        saveBody = route.request().postDataJSON() as RequestBody;
        schedule = { ...(saveBody.schedule as RequestBody), schemaVersion: 1, id: "update-e2e", executorClientId: "e2e-client", selectedWorkspaceId: WORKSPACE_ID, updatedAt: Date.now() };
      }
      if (action === "update.run") { starts++; lastCheck = { scheduledAt: Date.now(), checkedAt: Date.now(), outcome: "unchanged", runId: null, selectedCount: 0, deferredCount: 1, error: null }; }
      await route.fulfill({ json: { ok: true, data: { schedule, hash: schedule ? "schedule-hash" : null, currentClientId: "e2e-client", nextRunAt: schedule ? Date.now() + 60_000 : null, lastCheck, run: null } } });
    });
    await openKnowledge(page);
    await openKnowledgeMenu(page, "定时更新");
    const settings = page.getByTestId("knowledge-update-settings");
    await expect(settings.getByRole("switch", { name: "启用定时更新" })).toBeVisible();
    await settings.getByRole("switch", { name: "启用定时更新" }).click();
    await settings.getByLabel("执行时间").fill("04:30");
    await settings.getByRole("spinbutton", { name: "定时更新并发", exact: true }).fill("5");
    await settings.getByRole("spinbutton", { name: "定时复检轮数", exact: true }).fill("2");
    await settings.getByLabel("定时更新引擎", { exact: true }).click();
    await page.locator('.ant-select-item-option[title="Codex"]').click();
    await settings.getByLabel("定时生成模型", { exact: true }).click();
    await page.locator('.ant-select-item-option[title="测试模型 B"]').click();
    await page.getByRole("button", { name: "保存计划", exact: true }).click();
    await expect.poll(() => schedule?.enabled).toBe(true);
    const savedSchedule = schedule as RequestBody | null;
    expect(savedSchedule?.cronExpr).toBe("30 4 * * *");
    expect(savedSchedule?.concurrency).toBe(5);
    expect(savedSchedule?.model).toBe("gpt-second");
    expect((savedSchedule?.reviewConfig as RequestBody).maxRounds).toBe(2);
    await page.getByRole("button", { name: "立即检查", exact: true }).click();
    await expect(settings).toContainText("没有需要更新的资产");
    expect(starts).toBe(1);
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.sends).toHaveLength(0);
    await page.locator(".ant-drawer-close").click();
    await expect(settings).not.toBeVisible();
    await expect(page.getByTestId("knowledge-tree")).toBeVisible();
    await expect(page.getByRole("button", { name: "知识浏览", exact: true })).toHaveCount(0);
  });

  test("PK-51 定时检查状态不覆盖未保存要求，结果由用户打开，暗色窄屏面板不溢出", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 1, reviewState: "pending" });
    const run: Run = { schemaVersion: 1, id: "update-result", createdAt: new Date().toISOString(), phase: "completed", active: false, mode: "batch", nodeId: null, proposedTree: null, ownerThreadId: scenario.threadId, selectedNodeIds: ["root"], includeDescendants: false, strategy: "all", prompt: "", engine: "codex", model: "gpt-test", effort: "high", concurrency: 2, treeHash: "a".repeat(64), rationale: "定时更新", gaps: [], error: null, activeItemId: null, items: [{ id: "item-update", nodeId: "root", title: "功能说明", expectedHash: null, inheritedInstructions: "", instructions: "", status: "completed", revisionId: "revision-root", error: null, review: { status: "passed", reportId: "report-update", error: null } }] };
    scenario.setRun(run);
    const schedule = { schemaVersion: 1, id: "update-e2e", enabled: true, cronExpr: "0 3 * * *", timezone: "Asia/Singapore", executorClientId: "e2e-client", selectedWorkspaceId: WORKSPACE_ID, updatedAt: Date.now(), selectedNodeIds: [], includeDescendants: true, engine: "codex", model: "gpt-test", effort: "high", concurrency: 2, prompt: "已保存要求", reviewConfig: { enabled: true, model: "gpt-test", effort: "low", autoRepair: true, maxRounds: 2 } };
    await page.route("**/api/knowledge/assets/update.schedule?**", route => route.fulfill({ json: { ok: true, data: { schedule, hash: "hash", currentClientId: "e2e-client", nextRunAt: Date.now() + 1000, lastCheck: { outcome: "started", scheduledAt: Date.now(), checkedAt: Date.now(), runId: run.id, selectedCount: 1, deferredCount: 0, error: null }, run } } }));
    await openKnowledge(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await openKnowledgeMenu(page, "定时更新");
    const settings = page.getByTestId("knowledge-update-settings");
    await expect(settings.getByLabel("定时更新要求")).toHaveValue("已保存要求");
    await settings.getByLabel("定时更新要求").fill("尚未保存的新要求");
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(settings.getByLabel("定时更新要求")).toHaveValue("尚未保存的新要求");
    await expect(page.getByTestId("knowledge-plan-review")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(settings);
    const drawer = page.locator(".ant-drawer-content");
    await expectInside(page.getByRole("button", { name: "保存计划", exact: true }), drawer);
    await page.screenshot({ path: test.info().outputPath("knowledge-update-settings-mobile.png"), animations: "disabled" });
    await settings.getByRole("button", { name: "查看生成结果", exact: true }).click();
    await expect(page.getByTestId("knowledge-plan-review")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-updates")).toContainText("功能说明");
  });

  test("PK-46 知识库搜索显示混合命中并可定位资产", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page, { children: 2 });
    await openKnowledge(page);
    const search = page.getByTestId("knowledge-search");
    await search.getByPlaceholder("搜索规格与文档").fill("成员");
    await search.getByRole("button", { name: /^搜\s*索$/ }).click();
    const results = page.getByTestId("knowledge-search-results");
    await expect(results).toContainText("功能说明");
    await expect(results).toContainText("关键词 + 语义");
    await results.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(results).toHaveCount(0);
    await search.getByPlaceholder("搜索规格与文档").fill("成员");
    await search.getByRole("button", { name: /^搜\s*索$/ }).click();
    await expect(page.getByTestId("knowledge-search-results")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectInside(results, page.locator(".knowledge-page"));
    await expectNoHorizontalOverflow(results);
    const searchBounds = (await search.boundingBox())!;
    // 结果面板紧贴搜索框下沿，允许 8px 的视觉重叠容差。
    expect((await results.boundingBox())!.y).toBeGreaterThanOrEqual(searchBounds.y + searchBounds.height - 8);
    await results.getByRole("button", { name: /功能说明/ }).click();
    await expect(page.locator(".asset-tree-row.selected")).toContainText("功能说明");
  });

  test("PK-46a 同一长文的不同命中显示对应行段，原文变化明确要求重新搜索", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page);
    let content = ["# 成员", "首段成员说明", ...Array.from({ length: 150 }, () => "普通资料"), "## 权限", "末段权限规则"].join("\n");
    let changed = false;
    await page.route("**/api/knowledge/assets/node?**", route => route.fulfill({ json: { ok: true, data: {
      node: assetNode(), current: { revision: { schemaVersion: 1, id: "formal", nodeId: "root", origin: "manual", contentHash: (changed ? "b" : "a").repeat(64) }, content, sources: [], path: "docs/product.md" },
      currentHash: "c".repeat(64), drafts: [], effectiveInstructions: "", freshness: [],
    } } }));
    await page.route("**/api/knowledge/assets/search?**", route => route.fulfill({ json: { ok: true, data: { issues: [], items: [
      { nodeId: "root", title: "功能说明", heading: "成员章节", chunkId: "first", startLine: 1, endLine: 2, contentHash: "a".repeat(64), excerpt: "首段成员说明", path: "docs/product.md", matchMode: "hybrid", score: 0.9, keywordScore: 0.9, vectorScore: 0.9 },
      { nodeId: "root", title: "功能说明", heading: "权限章节", chunkId: "last", startLine: 153, endLine: 154, contentHash: "a".repeat(64), excerpt: "末段权限规则", path: "docs/product.md", matchMode: "hybrid", score: 0.8, keywordScore: 0.8, vectorScore: 0.8 },
    ] } } }));
    await openKnowledge(page);
    const search = page.getByTestId("knowledge-search"), location = page.getByTestId("knowledge-search-location");
    for (const [heading, expected, absent] of [["成员章节", "首段成员说明", "末段权限规则"], ["权限章节", "末段权限规则", "首段成员说明"]]) {
      await search.getByPlaceholder("搜索规格与文档").fill("成员权限");
      await search.getByRole("button", { name: /^搜\s*索$/ }).click();
      await page.getByTestId("knowledge-search-results").getByRole("button", { name: new RegExp(heading!) }).click();
      await expect(location).toContainText(heading!);
      await expect(location.locator("pre")).toContainText(expected!);
      await expect(location.locator("pre")).not.toContainText(absent!);
    }
    changed = true;
    await search.getByRole("button", { name: /^搜\s*索$/ }).click();
    await page.getByTestId("knowledge-search-results").getByRole("button", { name: /权限章节/ }).click();
    await expect(location).toContainText("原文或版本已变化，请重新搜索定位");
    await expect(location.locator("pre")).toHaveCount(0);
    changed = false;
    content = "长行普通资料".repeat(50_000) + "末尾唯一权限证据";
    await page.route("**/api/knowledge/assets/search?**", route => route.fulfill({ json: { ok: true, data: { issues: [], items: [
      { nodeId: "root", title: "功能说明", heading: "长行末尾", chunkId: "tail", startLine: 1, endLine: 1, contentHash: "a".repeat(64), excerpt: "末尾唯一权限证据", path: "docs/product.md", matchMode: "hybrid", score: 0.9, keywordScore: 0.9, vectorScore: 0.9 },
    ] } } }));
    await search.getByRole("button", { name: /^搜\s*索$/ }).click();
    await page.getByTestId("knowledge-search-results").getByRole("button", { name: /长行末尾/ }).click();
    await expect(location.locator("pre")).toContainText("末尾唯一权限证据");
    expect((await location.locator("pre").textContent())!.length).toBeLessThanOrEqual(2000);
    await expect(location).toBeInViewport();
  });

  test("PK-46b 切换项目清空搜索并中止旧请求，迟到命中不能进入新项目", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page);
    const nextWorkspace = "workspace_knowledge_search_next";
    await page.route("**/api/workspaces?**", route => route.fulfill({ json: { ok: true, workspaceListAuthoritative: true, workspaces: [
      { id: WORKSPACE_ID, title: "E2E 工作区", path: "D:/e2e-workspace", kind: "local", createdAt: 1, updatedAt: 1 },
      { id: nextWorkspace, title: "新的知识项目", path: "D:/next-knowledge", kind: "local", createdAt: 1, updatedAt: 1 },
    ] } }));
    await page.route("**/api/knowledge/assets/snapshot?**", route => {
      if (new URL(route.request().url()).searchParams.get("workspaceId") !== nextWorkspace) return route.fallback();
      return route.fulfill({ json: { ok: true, data: { initialized: true, knowledgeId: "next-kb", root: "codeflow-docs/知识库", canWrite: true, treeHash: null, states: [], tree: { schemaVersion: 1, instructions: "", nodes: [] } } } });
    });
    await page.route("**/api/knowledge/assets/conversation.list?**", route => new URL(route.request().url()).searchParams.get("workspaceId") === nextWorkspace ? route.fulfill({ json: { ok: true, data: [] } }) : route.fallback());
    let release!: () => void, completed!: () => void;
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    const responseDone = new Promise<void>(resolve => { completed = resolve; });
    await page.route("**/api/knowledge/assets/search?**", async route => {
      await responseGate;
      await route.fulfill({ json: { ok: true, data: { issues: [], items: [{ nodeId: "root", title: "旧项目迟到命中", excerpt: "不得回灌", path: "docs/old.md", matchMode: "hybrid", score: 0.9, keywordScore: 0.9, vectorScore: 0.9 }] } } });
      completed();
    });
    await openKnowledge(page);
    const search = page.getByTestId("knowledge-search");
    await search.getByPlaceholder("搜索规格与文档").fill("旧资料");
    const requested = page.waitForRequest(request => request.url().includes("/knowledge/assets/search?"));
    await search.getByRole("button", { name: /^搜\s*索$/ }).click();
    await requested;
    await page.evaluate(workspaceId => {
      const app = document.querySelector("#app") as HTMLElement & { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { switchWorkspace: (id: string, options: { reloadPage: boolean }) => void }> } } } } };
      app.__vue_app__.config.globalProperties.$pinia._s.get("config")!.switchWorkspace(workspaceId, { reloadPage: false });
    }, nextWorkspace);
    await expect(page.getByText("0 个节点", { exact: false })).toBeVisible();
    await expect(search.getByPlaceholder("搜索规格与文档")).toHaveValue("");
    release(); await responseDone;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId("knowledge-search-results")).toHaveCount(0);
    await expect(page.getByText("旧项目迟到命中", { exact: true })).toHaveCount(0);
  });

  test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

  test("PK-40 延迟恢复任务不抢占阅读，刷新确认清单时正式树保持可用", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2, reviewState: "issues" });
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await tree.getByRole("button", { name: "资产 2", exact: true }).click();
    let release!: () => void;
    let gate = new Promise<void>(resolve => { release = resolve; });
    let waiting = false;
    await page.route("**/api/knowledge/assets/runs?**", async route => { waiting = true; await gate; await route.fallback(); });
    await page.reload();
    await expect(page.locator(".document-title")).toContainText("资产 2");
    await expect.poll(() => waiting).toBe(true);
    release();
    await expect(page.locator(".updates-summary")).toHaveCount(0);
    await expect(page.locator(".document-title")).toContainText("资产 2");
    await openGenerationResults(page);
    gate = new Promise<void>(resolve => { release = resolve; }); waiting = false;
    await page.reload();
    await expect(page.getByTestId("knowledge-updates")).toBeVisible();
    await expect(tree.getByRole("button", { name: "资产 2", exact: true })).toBeVisible();
    await expect(page.getByTestId("knowledge-build-preview")).toHaveCount(0);
    await expect(page.locator(".document-title")).toHaveCount(0);
    await expect.poll(() => waiting).toBe(true);
    release();
    await expect(page.getByTestId("knowledge-build-preview")).toBeVisible();
    await tree.getByRole("button", { name: "资产 2", exact: true }).click();
    await expect(page.locator(".document-title")).toContainText("资产 2");
  });

  test("PK-40b 慢快照期间不展示旧树，收到权威响应后再交付目录", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2 });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    await expect(tree.getByRole("button", { name: "功能说明", exact: true })).toBeVisible();

    let release!: () => void;
    let waiting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/snapshot?**", async route => {
      waiting = true;
      await gate;
      await route.fallback();
    });
    await page.goto("/knowledge", { waitUntil: "commit" });

    // 快照未返回时保持加载态，不把上次页面的旧目录当成当前项目事实。
    await expect(tree.getByRole("button", { name: "功能说明", exact: true })).toHaveCount(0);
    await expect(tree.locator(".ant-skeleton")).toBeVisible();
    await expect.poll(() => waiting).toBe(true);
    release();
    await expect(tree.getByRole("button", { name: "功能说明", exact: true })).toBeVisible();
  });



  test("PK-42 旧审批深链映射统一确认，读取不触发采用，窄屏保留操作区", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { noKnowledge: true });
    const proposal = { schemaVersion: 1, id: "change-e2e", nodeId: "root", title: "重试次数", summary: "源码为 3 次，原文误记为 2 次", createdAt: "2026-09-24T10:00:00Z", updatedAt: "2026-09-24T10:00:00Z", status: "pending", origin: "chat", baseHash: "old-hash", baseContent: "重试 2 次", content: "重试 3 次", sources: [{ kind: "code", path: "source.ts", relation: "重试次数定义" }], instructions: "", reviewedAt: null as string | null, reviewedBy: null as string | null, reviewNote: "", revisionId: null as string | null, hash: "change-hash", currentContent: "重试 2 次", stale: false, staleReasons: [] };
    const reviews: RequestBody[] = [];
    await page.route("**/api/knowledge/assets/changes?**", route => route.fulfill({ json: { ok: true, data: { items: proposal.status === 'pending' ? [proposal] : [], nextOffset: null, pendingNodes: proposal.status === 'pending' ? [{ nodeId: proposal.nodeId, title: proposal.title, count: 1 }] : [] } } }));
    await page.route("**/api/knowledge/assets/change?**", route => route.fulfill({ json: { ok: true, data: proposal } }));
    await page.route("**/api/knowledge/assets/change.review", route => {
      const body = route.request().postDataJSON(); reviews.push(body);
      proposal.status = body.decision === "approve" ? "approved" : "rejected";
      proposal.reviewedAt = "2026-09-24T11:00:00Z"; proposal.reviewedBy = "test"; proposal.revisionId = "approved-revision";
      return route.fulfill({ json: { ok: true, data: proposal } });
    });
    await page.goto(`/knowledge?view=approvals&changeId=change-e2e&workspaceId=${WORKSPACE_ID}`);
    const inbox = page.getByTestId("knowledge-change-inbox"), updates = page.getByTestId("knowledge-updates");
    await expect(inbox).toContainText("重试 2 次");
    await expect(inbox).toContainText("重试 3 次");
    expect(reviews).toHaveLength(0);
    expect(scenario.calls.sends).toHaveLength(0);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => updates.locator(".update-row button").evaluate(el => {
        const rgb = getComputedStyle(el).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
        return rgb.reduce((sum, value) => sum + value, 0) / 3 > 128;
      })).toBe(colorScheme === "dark");
      await expectNoHorizontalOverflow(inbox);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`knowledge-approvals-redesign-${colorScheme}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(inbox);
    await expectInside(updates.getByRole("button", { name: "采用所选内容" }), updates);
    await updates.getByRole("button", { name: "采用所选内容" }).click();
    await expect.poll(() => reviews.length).toBe(1);
    expect(reviews[0]).toMatchObject({ workspaceId: WORKSPACE_ID, changeId: proposal.id, expectedHash: "change-hash", decision: "approve", note: "" });
    await expect(updates).toContainText(/已采用 1 项/u);
  });


  test("PK-01 空知识树直接通过会话规划，无生成范围表单", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { empty: true });
    await openKnowledge(page, scenario.threadId);
    await expect(page.locator(".generation-modes")).toHaveCount(0);
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    await page.locator(".composer__textarea").fill("按项目功能规划目录，说明按钮和字段");
    await page.locator(".composer__send-btn").click();
    await expect(page.getByText("已收到：按项目功能规划目录，说明按钮和字段", { exact: true })).toBeVisible();
    expect(scenario.calls.sends).toHaveLength(1);
    expect(scenario.calls.sends[0].threadId).toBe(scenario.threadId);
    expect(scenario.calls.sends[0].threadId).not.toBe(scenario.ordinaryThreadId);
    expect(scenario.calls.connects.every(call => call.threadId !== scenario.ordinaryThreadId)).toBeTruthy();
  });

  test("PK-02 同一会话选择模型、停止后保留草稿并继续发送", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { holdFirstTurn: true });
    await openKnowledge(page, scenario.threadId);
    await showKnowledgeAssistant(page);
    const input = page.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await page.locator(".composer__model-select").click();
    await page.locator(".composer__model-dropdown").getByText("测试模型 B", { exact: true }).click();
    await input.fill("先梳理所有业务功能");
    await page.locator(".composer__send-btn").click();
    await expect(page.locator(".composer__send-btn")).toHaveAttribute("aria-label", "终止");
    await input.fill("改为只处理订单页面，保留按钮权限和失败反馈");
    await expect(page.locator(".composer__send-btn")).toHaveAttribute("aria-label", "终止");
    await useDarkTheme(page);
    await page.screenshot({ path: test.info().outputPath("knowledge-conversation-running-dark.png") });
    await page.locator(".composer__send-btn").click();
    await expect.poll(() => scenario.calls.interrupts.length).toBe(1);
    await expect(input).toHaveValue("改为只处理订单页面，保留按钮权限和失败反馈");
    await expect(page.locator(".composer__send-btn")).toHaveAttribute("aria-label", "发送");
    await expect(page.locator(".composer__send-btn")).toBeEnabled();
    await input.press("Enter");
    await expect(page.getByText("已收到：改为只处理订单页面，保留按钮权限和失败反馈", { exact: true })).toBeVisible();
    expect(scenario.calls.sends).toHaveLength(2);
    expect(scenario.calls.sends.every(body => body.threadId === scenario.threadId && body.model === "gpt-second")).toBeTruthy();
    expect(scenario.calls.interrupts[0].threadId).toBe(scenario.threadId);
    expect(scenario.calls.queued).toHaveLength(0);
  });


  test("PK-04 桌面知识树固定显示，右侧图标收起恢复，明暗主题均无水平溢出", async ({ page }, testInfo) => {
    await installSession(page);
    await page.emulateMedia({ colorScheme: "light" });
    const scenario = await installKnowledgeScenario(page);
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant.locator(".composer__textarea")).toBeVisible();
    await expect(tree).toBeVisible();
    await expect(tree.getByRole("button", { name: "收起", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "展开规格库目录", exact: true })).toHaveCount(0);
    const collapse = assistant.getByRole("button", { name: "收起", exact: true });
    await expect(collapse.locator("svg")).toBeVisible();
    await expect(collapse).toHaveText("");
    await collapse.click();
    await expect(assistant).not.toBeVisible();
    await page.getByRole("button", { name: "展开 AI 对话", exact: true }).click();
    await expect(assistant).toBeVisible();
    const surface = page.locator(".knowledge-page");
    const light = await surface.evaluate(element => getComputedStyle(element).backgroundColor);
    await expectNoHorizontalOverflow(surface);
    await expectNoHorizontalOverflow(assistant);
    await page.screenshot({ path: testInfo.outputPath("knowledge-light.png") });
    await useDarkTheme(page);
    await expect.poll(() => surface.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(light);
    await expectNoHorizontalOverflow(surface);
    await expectNoHorizontalOverflow(assistant);
    await page.screenshot({ path: testInfo.outputPath("knowledge-dark.png") });
  });


  test("PK-07 目录浏览支持多选文档并批量导入", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("textbox", { name: "导入来源目录" })).toHaveValue("");
    await expect(modal.getByRole("button", { name: "上级目录", exact: true })).toBeDisabled();
    await expect(modal.locator(".ant-empty")).toHaveCount(0);
    await modal.getByRole("button", { name: "docs/", exact: true }).click();
    const checkboxes = modal.locator("input[type=checkbox]");
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await modal.getByRole("button", { name: "导入选中的 2 个文档" }).click();
    await expect(page.getByText("3 个节点", { exact: false })).toBeVisible();
    expect(scenario.calls.importDirectories).toEqual(["", "docs"]);
  });

  test("PK-07a 导入来源目录缺失时显示弹窗错误，可返回项目根继续导入", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await modal.getByRole("textbox", { name: "导入来源目录" }).fill("codeflow-docs");
    await modal.getByRole("button", { name: "读取目录", exact: true }).click();
    await expect(modal.getByRole("alert")).toContainText("请检查路径或返回项目根目录");
    await expect(modal.getByRole("alert")).toContainText("import-list-e2e");
    await expect(modal.locator(".ant-empty")).toHaveCount(0);
    await expect(page.locator(".ant-message-error")).toHaveCount(0);
    await modal.getByRole("button", { name: "返回项目根目录", exact: true }).click();
    await expect(modal.getByRole("alert")).toHaveCount(0);
    await modal.getByRole("button", { name: "docs/", exact: true }).click();
    await modal.getByRole("checkbox", { name: /设计说明/ }).check();
    await modal.getByRole("button", { name: "导入选中的 1 个文档", exact: true }).click();
    await expect(modal).not.toBeVisible();
    expect(scenario.calls.imports.map(item => item.path)).toEqual(["docs/design.md"]);
  });

  test("PK-07b 空项目正常显示空态，目录读取失败显式提示并可重试", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    let fail = false;
    await page.route("**/api/knowledge/assets/imports?**", route => route.fulfill({
      contentType: "application/json", status: fail ? 500 : 200,
      body: JSON.stringify(fail
        ? { ok: false, code: "KNOWLEDGE_ASSET_IO_FAILED", message: "项目目录暂时无法读取", details: { requestId: "import-read-e2e" } }
        : { ok: true, data: { files: [], directories: [], nextOffset: null } }),
    }));
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await expect(modal.locator(".ant-empty")).toBeVisible();
    await expect(modal.getByRole("alert")).toHaveCount(0);
    fail = true;
    await modal.getByRole("button", { name: "读取目录", exact: true }).click();
    await expect(modal.getByRole("alert")).toContainText("import-read-e2e");
    await expect(modal.locator(".ant-empty")).toHaveCount(0);
    fail = false;
    await modal.getByRole("button", { name: "读取目录", exact: true }).click();
    await expect(modal.locator(".ant-empty")).toBeVisible();
    await expect(modal.getByRole("alert")).toHaveCount(0);
  });

  test("PK-07c 批量导入首错即停，保留未完成选择并可重试，目录显示实际配置", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    const nodes = [assetNode()];
    const snapshot = () => ({ initialized: true, knowledgeId: "kb-custom", root: "customer-docs/知识库", tree: { schemaVersion: 1, instructions: "", nodes }, treeHash: "a".repeat(64), canWrite: true, states: [] });
    const files = ["first", "second", "third"].map(title => ({ path: `${title}.md`, title, contentHash: "b".repeat(64) }));
    const attempts: string[] = [];
    let failSecond = true;
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: snapshot() }) }));
    await page.route("**/api/knowledge/assets/imports?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { files, directories: [], nextOffset: null } }) }));
    await page.route("**/api/knowledge/assets/import", route => {
      const body = route.request().postDataJSON() as RequestBody;
      const source = String(body.path);
      attempts.push(source);
      if (source === "second.md" && failSecond) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, code: "KNOWLEDGE_ASSET_CONFLICT", message: "该文档已导入到「原目录」，请在原位置编辑", details: { requestId: "import-second-e2e" } }) });
      nodes.push(assetNode(`import_${source.replace(".md", "")}`, source));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: snapshot() }) });
    });
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await expect(modal.locator(".import-destination")).toContainText("产品文档");
    await expect(modal.locator(".import-description")).not.toContainText("customer-docs/知识库");
    for (const file of files) await modal.getByRole("checkbox", { name: new RegExp(file.title) }).check();
    await modal.getByRole("button", { name: "导入选中的 3 个文档", exact: true }).click();
    await expect(modal.getByRole("alert")).toContainText("已导入 1 个文档");
    await expect(modal.getByRole("alert")).toContainText("原目录");
    await expect(modal.getByRole("alert")).toContainText("import-second-e2e");
    expect(attempts).toEqual(["first.md", "second.md"]);
    await expect(modal.getByRole("checkbox", { name: /first/ })).not.toBeChecked();
    await expect(modal.getByRole("checkbox", { name: /second/ })).toBeChecked();
    await expect(modal.getByRole("checkbox", { name: /third/ })).toBeChecked();
    const retry = modal.getByRole("button", { name: "导入选中的 2 个文档", exact: true });
    await expect(retry).toBeEnabled();
    failSecond = false;
    await retry.click();
    await expect(modal).not.toBeVisible();
    expect(attempts).toEqual(["first.md", "second.md", "second.md", "third.md"]);
    expect(nodes.map(node => node.id)).toEqual(["root", "import_first", "import_second", "import_third"]);
  });

  test("PK-08 刷新恢复独立知识会话，顶部结束协作保留聊天记录", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    await page.goto("/knowledge");
    await openKnowledgeDiscussion(page);
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.connects.at(-1)?.threadId).toBe(scenario.threadId);
    const finish = page.locator(".assistant-head").getByRole("button", { name: "结束协作", exact: true });
    await expect(finish).toBeVisible();
    await expectInside(finish, page.locator(".assistant-head"));
    await finish.click();
    await expect.poll(() => scenario.calls.ends.length).toBe(1);
    await expect(page.getByRole("button", { name: "继续最近会话", exact: true })).toBeVisible();
    const existing = await page.request.post(`${MOCK_URL}/api/threads/load`, { data: { workspaceId: WORKSPACE_ID, threadId: scenario.threadId } });
    expect((await existing.json()).ok).toBeTruthy();
  });

  test("PK-08a 刷新知识页保留当前选中的深层资产", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2 });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await tree.getByRole("button", { name: "资产 2", exact: true }).click();
    await expect(page.locator(".document-title")).toContainText("资产 2");
    await page.reload();
    await expect(page.locator(".knowledge-page")).toBeVisible();
    await expect(page.locator(".document-title")).toContainText("资产 2");
  });

  test("PK-08b 后台旧树响应不会把刷新后的深层资产跳回一级概览", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2, staleFullTreeAfterReload: true });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await tree.getByRole("button", { name: "资产 2", exact: true }).click();
    await expect(page.locator(".document-title")).toContainText("资产 2");
    await page.reload();
    await expect(page.locator(".knowledge-page")).toBeVisible();
    await expect(page.locator(".document-title")).toContainText("资产 2");
  });

  test("PK-08c 刷新带目录会话深链时不把阅读项改回会话绑定的一级目录", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2, knowledgeNodeId: "root" });
    await page.goto(`/knowledge?threadId=${scenario.threadId}`);
    await expect(page.locator(".assistant-scope")).toHaveText("功能说明");
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await tree.getByRole("button", { name: "资产 2", exact: true }).click();
    await expect(page.locator(".document-title")).toContainText("资产 2");
    await page.reload();
    await expect(page.locator(".knowledge-page")).toBeVisible();
    await expect(page.locator(".document-title")).toContainText("资产 2");
  });

  test("PK-09 切换资产只改变查看项，保持知识会话范围和草稿", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeDiscussion(page);
    const input = page.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await input.fill("这段要求尚未发送，保留字段校验的上下文");
    const connects = scenario.calls.connects.length;
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    await openKnowledgeDiscussion(page);
    await expect(page.locator(".assistant-scope")).toContainText("整个项目");
    expect(scenario.calls.connects.length).toBe(connects);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("这段要求尚未发送，保留字段校验的上下文");
  });


  test("PK-11 对话逐项交付不伪造总进度，停止后可继续讨论", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { holdFirstTurn: true, delivering: true });
    await openKnowledge(page, scenario.threadId);
    const input = page.locator(".composer__textarea");
    await expect(input).toBeEnabled();
    await input.fill("请开始生成项目资产");
    await page.locator(".composer__send-btn").click();
    await expect(page.locator(".composer__send-btn")).toHaveAttribute("aria-label", "终止");
    await expect(page.locator(".task-summary")).toContainText("已交付 1 份文档");
    await expect(page.locator(".task-summary")).not.toContainText("/ 1");
    await page.locator(".composer__send-btn").click();
    await expect.poll(() => scenario.calls.interrupts.length).toBe(1);
    await input.fill("继续讨论生成要求");
    await page.locator(".composer__send-btn").click();
    await expect.poll(() => scenario.calls.sends.length).toBe(2);
    await expect(page.getByTestId("knowledge-plan-review")).toHaveCount(0);
  });

  test("PK-13 导入目录分页保留跨页多选并导入全部选择", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { paginatedImports: true });
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await modal.getByRole("button", { name: "docs/", exact: true }).click();
    await modal.getByRole("checkbox", { name: /设计说明/ }).check();
    await modal.getByRole("button", { name: "加载更多文档和目录", exact: true }).click();
    await expect(modal.getByRole("checkbox", { name: /设计说明/ })).toBeChecked();
    await modal.getByRole("checkbox", { name: /使用指南/ }).check();
    await expect(modal.getByRole("button", { name: "加载更多文档和目录", exact: true })).toHaveCount(0);
    await modal.getByRole("button", { name: "导入选中的 2 个文档", exact: true }).click();
    await expect(page.getByText("3 个节点", { exact: false })).toBeVisible();
    expect(scenario.calls.importOffsets).toEqual([0, 0, 100]);
    expect(scenario.calls.importDirectories).toEqual(["", "docs", "docs"]);
    expect(scenario.calls.imports).toHaveLength(2);
  });

  test("PK-14 切换工作区丢弃旧导入响应并停止后续批量写入", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    const nextWorkspace = "workspace_knowledge_next_e2e";
    await page.route("**/api/workspaces?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, workspaces: [
      { id: WORKSPACE_ID, title: "E2E 工作区", path: "D:/e2e-workspace", kind: "local", createdAt: 1, updatedAt: 1 },
      { id: nextWorkspace, title: "新的工作区", path: "D:/next-workspace", kind: "local", createdAt: 1, updatedAt: 1 },
    ], workspaceListAuthoritative: true }) }));
    await openKnowledge(page, scenario.threadId);
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    const imports: RequestBody[] = [];
    await page.route("**/api/knowledge/assets/import", async route => {
      imports.push(route.request().postDataJSON() as RequestBody);
      await responseGate;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { initialized: true, knowledgeId: "old-kb", root: "codeflow-docs/知识库", canWrite: true, treeHash: "b".repeat(64), states: [], tree: { schemaVersion: 1, instructions: "", nodes: [assetNode("stale", "不应出现在新工作区")] } } }) });
    });
    await page.route("**/api/knowledge/assets/snapshot?**", async route => {
      if (new URL(route.request().url()).searchParams.get("workspaceId") !== nextWorkspace) return route.fallback();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { initialized: true, knowledgeId: "next-kb", root: "codeflow-docs/知识库", canWrite: true, treeHash: null, states: [], tree: { schemaVersion: 1, instructions: "", nodes: [] } } }) });
    });
    await openKnowledgeMenu(page, "导入文档");
    const modal = page.getByRole("dialog", { name: "选择项目文档导入" });
    await modal.getByRole("button", { name: "docs/", exact: true }).click();
    await modal.getByRole("checkbox", { name: /设计说明/ }).check();
    await modal.getByRole("checkbox", { name: /使用指南/ }).check();
    await modal.getByRole("button", { name: "导入选中的 2 个文档", exact: true }).click();
    await expect.poll(() => imports.length).toBe(1);
    // 使用应用真实的无刷新切换分支，保留旧请求以验证 scope 隔离，而不让整页 reload 隐藏竞态。
    await page.evaluate(workspaceId => {
      const app = document.querySelector("#app") as HTMLElement & { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { switchWorkspace: (id: string, options: { reloadPage: boolean }) => void }> } } } } };
      app.__vue_app__.config.globalProperties.$pinia._s.get("config")!.switchWorkspace(workspaceId, { reloadPage: false });
    }, nextWorkspace);
    await expect(page.getByText("0 个节点", { exact: false })).toBeVisible();
    await expect(modal).not.toBeVisible();
    const oldResponse = page.waitForResponse(response => response.url().endsWith("/api/knowledge/assets/import"));
    releaseResponse!();
    await oldResponse;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText("0 个节点", { exact: false })).toBeVisible();
    await expect(page.getByText("不应出现在新工作区", { exact: true })).toHaveCount(0);
    expect(imports).toHaveLength(1);
    expect(imports[0].workspaceId).toBe(WORKSPACE_ID);
    await openKnowledgeMenu(page, "导入文档");
    await expect(modal.getByRole("textbox", { name: "导入来源目录" })).toHaveValue("");
    await expect(modal.getByRole("button", { name: "docs/", exact: true })).toBeVisible();
    await expect(modal.getByRole("alert")).toHaveCount(0);
  });

  test("PK-15 目录箭头展开折叠并记忆，大目录虚拟滚动", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 200 });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    await expect(tree.getByRole("button", { name: "资产 1", exact: true })).toHaveCount(0);
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await expect(tree.getByRole("button", { name: "资产 1", exact: true })).toBeVisible();
    expect(await tree.getByRole("treeitem").count()).toBeLessThan(60);
    const viewport = tree.getByRole("tree", { name: "规格库目录", exact: true });
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    // Mock 按字符串 orderKey 排序，child-99 对应的资产 100 位于末尾。
    await expect(tree.getByRole("button", { name: "资产 100", exact: true })).toBeVisible();
    await expect(tree.getByRole("button", { name: "资产 1", exact: true })).toHaveCount(0);
    expect(await tree.getByRole("treeitem").count()).toBeLessThan(60);
    await viewport.evaluate(element => { element.scrollTop = 0; });
    await expect(tree.getByRole("button", { name: "资产 1", exact: true })).toBeVisible();
    await tree.getByRole("button", { name: "资产 1", exact: true }).click();
    await tree.getByRole("button", { name: "折叠功能说明", exact: true }).click();
    await expect(page.locator(".document-title")).toContainText("资产 1");
    await expect(tree.getByRole("button", { name: "资产 1", exact: true })).toHaveCount(0);
    await page.goto("/knowledge");
    // 当前产品刷新后默认展开目录，以展开按钮状态确认树已恢复。
    await expect(tree.getByRole("button", { name: "折叠功能说明", exact: true })).toBeVisible();
  });

  test("PK-16 多选批量确认后代与模型，主页面显示进度并停止", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2 });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成" });
    await expect(modal).toContainText("本次处理 3 项");
    await expect(modal.getByRole("combobox", { name: "批量生成模型", exact: true })).toHaveValue("gpt-test");
    await expect(modal.getByRole("combobox", { name: "批量思考强度", exact: true })).toHaveValue("high");
    await modal.getByRole("switch", { name: "包含所选目录的后代", exact: true }).click();
    await expect(modal).toContainText("本次处理 1 项");
    await modal.getByRole("textbox", { name: "批量生成要求" }).fill("说明按钮和字段");
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "batch", ownerThreadId: scenario.summaries.at(-1)!.threadId, selectedNodeIds: ["root"], includeDescendants: false, strategy: "all", concurrency: 5, model: "gpt-test", prompt: "说明按钮和字段" });
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null });
    const result = page.locator(".task-summary");
    await expect(result).toContainText("0 / 1");
    await result.getByRole("button", { name: /^停\s*止$/u }).click();
    await expect.poll(() => scenario.calls.stops.length).toBe(1);
    await expect(result.getByRole("button", { name: /^停\s*止$/u })).toHaveCount(0);
    expect(scenario.calls.starts).toHaveLength(1);
    expect(scenario.calls.sends).toHaveLength(0);
    await page.locator(".assistant-head").getByRole("button", { name: "结束协作", exact: true }).click();
    await expect.poll(() => scenario.calls.ends.length).toBe(1);
    expect(scenario.calls.stops).toHaveLength(1);
  });

  test("PK-16b 选择父目录会同步勾选后代，取消子目录后父目录显示半选", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2 });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    const parent = tree.getByRole("checkbox", { name: "选择功能说明", exact: true });
    await parent.check();
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    const child = tree.getByRole("checkbox", { name: "选择资产 1", exact: true });
    await expect(child).toBeChecked();
    await child.uncheck();
    await expect(child).not.toBeChecked();
    await expect.poll(() => parent.evaluate(element => (element as HTMLInputElement).indeterminate)).toBe(true);
  });

  test("PK-16a 批任务草稿在统一更新中预览，未通过复检不能绕过采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues" });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await expect(page.getByRole("button", { name: "采用选中 1 项", exact: true })).toHaveCount(0);
    await tree.getByRole("button", { name: "功能说明", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates).toBeVisible();
    const preview = page.getByTestId("knowledge-build-preview");
    await expect(updates.getByRole("button", { name: "返回当前内容", exact: true })).toHaveCount(0);
    await expect(preview.getByRole("tab", { name: "变更", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(preview.locator(".revision-diff")).toBeVisible();
    const previewHeight = (await preview.boundingBox())!.height;
    await preview.getByRole("tab", { name: "完整内容", exact: true }).click();
    await expect(preview.locator(".preview-content")).toContainText("错误边界记录结构化日志");
    await expect(preview.locator(".revision-diff")).toHaveCount(0);
    await preview.getByRole("tab", { name: "复检报告", exact: true }).click();
    await expect(preview.getByTestId("knowledge-review-report")).toContainText("缺少错误码字段");
    await expect(preview.getByRole("tab", { name: "复检报告", exact: true })).toHaveAttribute("aria-selected", "true");
    await preview.getByRole("tab", { name: "变更", exact: true }).click();
    await expect(preview.locator(".revision-diff")).toBeVisible();
    expect((await preview.boundingBox())!.height).toBe(previewHeight);
    await expect(preview).toContainText("复检发现 1 个阻断问题");
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    expect(scenario.calls.adopts).toHaveLength(0);
    expect(scenario.calls.applies).toBe(0);
  });

  test("PK-preview-report-tab 报告定位显示加载动画，迟到报告与配置不抢占用户选择", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true, existingDocument: true });
    await completeBuild(page, scenario);
    await page.evaluate(workspaceId => {
      sessionStorage.setItem(`knowledge-page-state:v2:${encodeURIComponent(workspaceId)}`, JSON.stringify({ selectedId: "new-doc", viewTab: "node", assistantOpen: false, updatesTarget: { scopeNodeId: "new-doc", report: true } }));
    }, WORKSPACE_ID);
    let releaseReports!: () => void, releaseSchedule!: () => void;
    const reportsGate = new Promise<void>(resolve => { releaseReports = resolve; });
    const scheduleGate = new Promise<void>(resolve => { releaseSchedule = resolve; });
    await page.route("**/api/knowledge/assets/reviews?**", async route => {
      if (new URL(route.request().url()).searchParams.has("runId")) await reportsGate;
      await route.fallback();
    });
    await page.route("**/api/knowledge/assets/update.schedule?**", async route => { await scheduleGate; await route.fallback(); });
    await page.reload();
    const preview = page.getByTestId("knowledge-build-preview");
    const reportTab = preview.getByRole("tab", { name: "复检报告", exact: true });
    const documentTab = preview.getByRole("tab", { name: "完整内容", exact: true });
    await expect(reportTab).toHaveAttribute("aria-selected", "true");
    await expect(preview.getByLabel("正在加载复检报告", { exact: true })).toBeVisible();
    await expect(preview).not.toContainText("尚未复检");
    await documentTab.click();
    await expect(preview).toContainText("关键机制正文");
    const reportsResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === "/api/knowledge/assets/reviews" && url.searchParams.has("runId");
    });
    const validationResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/knowledge/assets/run.preview");
    releaseReports(); await reportsResponse;
    await validationResponse;
    releaseSchedule();
    await expect(documentTab).toHaveAttribute("aria-selected", "true");
    await reportTab.click();
    await expect(preview.getByTestId("knowledge-review-report")).toContainText("独立复检已通过");
    await expect(preview.getByLabel("正在加载复检报告", { exact: true })).toHaveCount(0);
  });

  test("PK-preview-review-guidance 问题候选可直接查看报告并确认生成当前文件的修订版", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues", children: 1 });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates"), preview = page.getByTestId("knowledge-build-preview");
    await expect(preview).toContainText("复检发现 1 个阻断问题");
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    const report = preview.getByTestId("knowledge-review-report");
    await expect(report).toContainText("缺少错误码字段");
    await report.getByRole("button", { name: "按报告问题生成修订版", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "根据报告生成修订版", exact: true });
    await expect(modal).toContainText("本次处理 1 项");
    expect(scenario.calls.generates).toHaveLength(0);
    await modal.getByRole("button", { name: "开始生成修订版", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "batch", selectedNodeIds: ["root"], includeDescendants: false, repairReports: [{ nodeId: "root", reportId: "review-root" }], reviewConfig: { enabled: true } });
    expect(scenario.calls.adopts).toHaveLength(0);
  });

  test("PK-preview-review-session 候选报告可打开原工作会话并预填修订要求，不自动发送", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues" });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await page.setViewportSize({ width: 390, height: 844 });
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    await expectNoHorizontalOverflow(preview);
    await expectNoHorizontalOverflow(preview.getByTestId("knowledge-review-report"));
    await preview.getByRole("button", { name: "回知识工作会话修订", exact: true }).click();
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant).toContainText("知识工作会话 · 功能说明");
    await expect(assistant.locator(".composer__textarea")).toHaveValue(/缺少错误码字段/);
    expect(scenario.calls.sends).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.adopts).toHaveLength(0);
  });

  test("PK-preview-review-compact 提示保持紧凑，顶部可直接重新复检且窄屏不溢出", async ({ page }, testInfo) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "stale" });
    await page.setViewportSize({ width: 1920, height: 900 });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview"), notice = preview.getByTestId("knowledge-review-notice");
    await expect(notice).toContainText("复检依据已变化，请重新复检");
    await showKnowledgeAssistant(page);
    await page.screenshot({ path: testInfo.outputPath("compact-desktop.png") });
    expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(48);
    await expect(preview.getByRole("tab", { name: "变更", exact: true })).toHaveAttribute("aria-selected", "true");
    await notice.getByRole("button", { name: "重新复检", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "复检已有文档", exact: true });
    await expect(modal).toContainText("本次处理 1 项");
    expect(scenario.calls.starts).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
    await modal.getByRole("button", { name: /取\s*消/, exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(preview);
    await expectNoHorizontalOverflow(notice);
    await expectInside(notice.getByRole("button", { name: "重新复检", exact: true }), notice);
    expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(110);
    await page.screenshot({ path: testInfo.outputPath("compact-mobile.png") });
    await notice.getByRole("button", { name: "重新复检", exact: true }).click();
    await modal.getByRole("button", { name: "开始复检", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "review", selectedNodeIds: ["root"], includeDescendants: false });
  });

  for (const activity of [
    { stage: "queued", review: "pending", text: "等待复检…", finish: "passed" },
    { stage: "reviewing", review: "pending", text: "正在复检，请稍候…", finish: "source-changed" },
    { stage: "generating", review: "repairing", text: "正在根据问题修订…", finish: "failed" },
  ] as const) {
    test(`PK-preview-review-progress-${activity.stage} 提示条显示实际阶段，正文可读且结束后更新提示`, async ({ page }, testInfo) => {
      await installSession(page);
      const scenario = await installKnowledgeScenario(page, { reviewState: "pending", children: activity.stage === "queued" ? 1 : 0 });
      const item = { id: "item-root", nodeId: "root", title: "功能说明", expectedHash: null, inheritedInstructions: "目录要求", instructions: "记录日志规范", status: "completed", revisionId: "revision-root", executionThreadId: "knowledge-generation-root", error: null,
        review: { status: activity.review, reportId: null as string | null, error: null as RequestBody | null } };
      const otherItem = { ...item, id: "item-other", nodeId: "child-0", title: "资产 1", status: "pending", revisionId: null, review: undefined };
      const run: Run = { schemaVersion: 1, id: "batch-e2e", createdAt: "2026-09-21T12:00:00.000Z", mode: "batch", nodeId: null, phase: "generating", active: true, activeStage: activity.stage, activeItemId: item.id, activeItemStages: [{ itemId: item.id, stage: activity.stage }], ownerThreadId: scenario.threadId, prompt: "", engine: "codex", model: "gpt-test", effort: "high", reviewConfig: { enabled: true }, proposedTree: null, treeHash: "a".repeat(64), rationale: "", gaps: [], error: null, items: [item] };
      scenario.setRun(run);
      let reviewFinished = false;
      const sourceReason = "来源已变化，请重新读取：apps/desktop/client/src/knowledge/knowledgeAssetStore.ts";
      await page.route("**/api/knowledge/assets/run.preview?**", route => route.fulfill({ json: { ok: true, data: { runId: run.id, tree: { schemaVersion: 1, instructions: "", nodes: [assetNode()] }, treeHash: "a".repeat(64), planHash: "b".repeat(64), items: [{ nodeId: "root", revisionId: "revision-root", canApply: activity.finish === "passed", reason: activity.finish === "source-changed" ? sourceReason : activity.finish === "failed" ? "正文尚未通过有效复检" : null, applied: false }] } } }));
      await page.route("**/api/knowledge/assets/reviews?**", route => route.fulfill({ json: { ok: true, data: !reviewFinished || activity.finish === "failed" ? [] : [{ id: "passed-review", nodeId: "root", revisionId: "revision-root", createdAt: "2026-09-21T12:02:00Z", engine: "codex", outcome: "passed", summary: "已核对最新来源。", issues: [], stale: false, staleReasons: [] }] } }));
      await openKnowledge(page, scenario.threadId);
      await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
      const preview = page.getByTestId("knowledge-build-preview"), notice = preview.getByTestId("knowledge-review-notice");
      await expect(notice).toContainText(activity.text);
      await expect(notice).toHaveAttribute("aria-busy", "true");
      await expect(notice.locator(".anticon-loading")).toBeVisible();
      await expect(notice.getByRole("button")).toHaveCount(0);
      await expect(preview.getByRole("tab", { name: "变更", exact: true })).toBeVisible();
      expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(44);
      const viewport = page.viewportSize()!;
      const main = page.locator(".knowledge-page .main"), height = (await main.boundingBox())!.height;
      await preview.getByRole("tab", { name: "完整内容", exact: true }).click();
      await expect(preview.locator(".preview-content")).toContainText("错误边界记录结构化日志");
      await expect(page.getByTestId("knowledge-updates").getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoHorizontalOverflow(notice);
      await expectNoHorizontalOverflow(preview);
      await page.screenshot({ path: testInfo.outputPath(`review-progress-${activity.stage}.png`) });
      await page.setViewportSize(viewport);
      await expect.poll(async () => (await main.boundingBox())!.height).toBeCloseTo(height, 0);
      const finished = { ...item, review: { status: activity.finish === "failed" ? "failed" : "passed", reportId: activity.finish === "failed" ? null : "passed-review", error: activity.finish === "failed" ? { code: "REVIEW_FAILED", message: "复检执行失败" } : null } };
      reviewFinished = true;
      if (activity.stage === "queued") {
        scenario.setRun({ ...run, activeStage: "generating", activeItemId: otherItem.id, activeItemIds: [otherItem.id], activeItemStages: [{ itemId: otherItem.id, stage: "generating" }], items: [finished, otherItem] });
        await expect(notice).toHaveCount(0, { timeout: 12000 });
        await expect(preview.getByRole("tab", { name: "完整内容", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(preview.locator(".preview-content")).toContainText("错误边界记录结构化日志");
        await expect(page.getByTestId("knowledge-updates").locator(".updates-processing")).toHaveCount(0);
      }
      run.active = false;
      scenario.setRun({ ...run, phase: activity.finish === "failed" ? "failed" : "completed", activeStage: null, activeItemId: null, activeItemStages: [], items: [finished] });
      if (activity.finish === "passed") {
        await expect(notice).toHaveCount(0, { timeout: 12000 });
        await expect(page.getByTestId("knowledge-updates").getByRole("button", { name: "采用此版本", exact: true })).toBeEnabled();
      } else {
        await expect(notice).toContainText(activity.finish === "source-changed" ? sourceReason : "复检未完成，请重试复检", { timeout: 12000 });
        await expect(notice.locator(".anticon-loading")).toHaveCount(0);
        await expect(notice).toHaveAttribute("aria-busy", "false");
      }
      await expect(preview.getByRole("tab", { name: "完整内容", exact: true })).toHaveAttribute("aria-selected", "true");
      expect((await main.boundingBox())!.height).toBeCloseTo(height, 0);
      expect(scenario.calls.generates).toHaveLength(0);
      expect(scenario.calls.adopts).toHaveLength(0);
    });
  }

  test("PK-preview-review-progress-independent 独立复检结束刷新原候选报告与采用资格，保留当前标签页", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues" });
    await openKnowledge(page, scenario.threadId);
    const original = await page.evaluate(async workspaceId => {
      const response = await fetch(`/api/knowledge/assets/runs?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (!response.ok) throw new Error(`读取测试任务失败：${response.status}`);
      return (await response.json()).data.find((run: Run) => run.id === "batch-e2e") as Run;
    }, WORKSPACE_ID);
    const candidateNodes = [{ ...assetNode(), title: "日志规范修订" }];
    original.proposedTree = { schemaVersion: 1, instructions: "", nodes: candidateNodes };
    const item = { ...(original.items as RequestBody[])[0], id: "independent-item", review: { status: "pending", reportId: null as string | null, error: null } };
    const reviewHost: Run = { ...original, id: "independent-review", mode: "review", createdAt: "2026-09-22T12:00:00Z", proposedTree: null, active: true, phase: "generating", activeItemId: item.id, activeItemStages: [{ itemId: item.id, stage: "reviewing" }], items: [item] };
    let originalValidations = 0, reportReads = 0;
    await page.route("**/api/knowledge/assets/runs?**", route => route.fulfill({ json: { ok: true, data: [reviewHost, original] } }));
    await page.route("**/api/knowledge/assets/run.preview?**", route => {
      const runId = new URL(route.request().url()).searchParams.get("runId");
      if (runId === original.id) originalValidations++;
      return route.fulfill({ json: { ok: true, data: { runId, tree: { schemaVersion: 1, instructions: "", nodes: runId === original.id ? candidateNodes : [assetNode()] }, treeHash: "a".repeat(64), planHash: "b".repeat(64), items: [{ nodeId: "root", revisionId: "revision-root", canApply: !reviewHost.active, reason: reviewHost.active ? "正文尚未通过有效复检" : null, applied: false }] } } });
    });
    await page.route("**/api/knowledge/assets/reviews?**", route => {
      reportReads++;
      return reviewHost.active ? route.fallback() : route.fulfill({ json: { ok: true, data: [{ id: "independent-passed", nodeId: "root", revisionId: "revision-root", createdAt: "2026-09-22T12:02:00Z", engine: "codex", outcome: "passed", summary: "独立复检已核对最新来源。", issues: [], stale: false, staleReasons: [] }] } });
    });
    await page.reload();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates"), preview = updates.getByTestId("knowledge-build-preview"), notice = preview.getByTestId("knowledge-review-notice");
    await expect(updates.locator(".update-row")).toHaveCount(2);
    await updates.locator(".update-row button").last().click();
    await expect(preview.locator("h3")).toHaveText("日志规范修订");
    await expect(notice).toContainText("正在复检，请稍候…");
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    await preview.getByRole("tab", { name: "复检报告", exact: true }).click();
    await expect(preview.getByTestId("knowledge-review-report")).toContainText("缺少错误码字段");
    const beforeValidations = originalValidations, beforeReports = reportReads;
    reviewHost.active = false;
    reviewHost.phase = "completed";
    reviewHost.activeItemId = null;
    reviewHost.activeItemStages = [];
    item.review = { status: "passed", reportId: "independent-passed", error: null };
    await expect(notice).toHaveCount(0, { timeout: 12000 });
    await expect(preview.getByTestId("knowledge-review-report")).toContainText("独立复检已核对最新来源。");
    await expect(preview.getByRole("tab", { name: "复检报告", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeEnabled();
    expect(originalValidations).toBeGreaterThan(beforeValidations);
    expect(reportReads).toBeGreaterThan(beforeReports);
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.adopts).toHaveLength(0);
  });

  for (const state of ["pending", "failed", "stale"] as const) {
    test(`PK-preview-review-retry-${state} 未完成或失效候选说明下一步并进入单文件复检`, async ({ page }) => {
      await installSession(page);
      const scenario = await installKnowledgeScenario(page, { reviewState: state });
      await openKnowledge(page, scenario.threadId);
      await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
      const preview = page.getByTestId("knowledge-build-preview");
      await expect(preview).toContainText(state === "stale" ? "复检依据已变化" : state === "failed" ? "复检未完成，请重试复检" : "文档已保存，请继续复检");
      await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
      const report = preview.getByTestId("knowledge-review-report");
      if (state === "stale") await expect(report.getByRole("button", { name: "按报告问题生成修订版", exact: true })).toBeDisabled();
      if (state !== "stale") {
        await expect(report).toContainText(state === "failed" ? "复检失败" : "待复检");
        await preview.getByRole("button", { name: state === "failed" ? "重试复检" : "继续复检", exact: true }).click();
        await expect.poll(() => scenario.calls.starts.length).toBe(1);
        expect(scenario.calls.starts[0]).toMatchObject({ runId: "batch-e2e", nodeIds: ["root"] });
        expect(scenario.calls.generates).toHaveLength(0);
        expect(scenario.calls.adopts).toHaveLength(0);
        return;
      }
      await report.getByRole("button", { name: "重新复检", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "复检已有文档", exact: true });
      await expect(modal).toContainText("本次处理 1 项");
      await modal.getByRole("button", { name: "开始复检", exact: true }).click();
      await expect.poll(() => scenario.calls.starts.length).toBe(1);
      expect(scenario.calls.generates[0]).toMatchObject({ mode: "review", selectedNodeIds: ["root"], includeDescendants: false });
      expect(scenario.calls.adopts).toHaveLength(0);
    });
  }

  test("PK-preview-review-readonly 无维护权限仍可查看问题，但不能发起修订或预填要求", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues" });
    await page.route("**/api/knowledge/assets/snapshot?**", route => route.fulfill({ json: { ok: true, data: { initialized: true, knowledgeId: "kb-e2e", root: "codeflow-docs/知识库", tree: { schemaVersion: 1, instructions: "", nodes: [assetNode()] }, treeHash: "a".repeat(64), canWrite: false, states: [{ nodeId: "root", revisionId: null, draftCount: 1, error: null }] } } }));
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await expect(preview).toContainText("请有维护权限的成员");
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    for (const name of ["重新复检", "按报告问题生成修订版", "回知识工作会话修订"]) {
      await expect(preview.getByRole("button", { name, exact: true }).first()).toBeDisabled();
      for (const button of await preview.getByRole("button", { name, exact: true }).all()) await expect(button).toBeDisabled();
    }
    expect(scenario.calls.generates).toHaveLength(0);
  });

  test("PK-preview-review-warning 仅提醒的有效报告不显示阻断指引，仍可采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues" });
    scenario.setItemReview({ enabled: true, status: "passed" });
    await page.route("**/api/knowledge/assets/reviews?**", route => route.fulfill({ json: { ok: true, data: [{ id: "warning-report", nodeId: "root", revisionId: "revision-root", createdAt: "2026-09-21T12:01:00.000Z", engine: "codex", outcome: "passed_with_warnings", summary: "复检通过，可补充日志示例。", stale: false, staleReasons: [], issues: [{ id: "warning-example", severity: "warning", category: "coverage", title: "可补充示例", detail: "建议增加日志示例。", documentStartLine: 3, documentEndLine: 4, sources: [], suggestion: "补充一个结构化日志示例。" }] }] } }));
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await preview.getByRole("tab", { name: "复检报告", exact: true }).click();
    await expect(preview).toContainText("复检通过（有提醒）");
    await expect(preview.getByRole("button", { name: "查看复检报告", exact: true })).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "按报告问题生成修订版", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("knowledge-updates").getByRole("button", { name: "采用此版本", exact: true })).toBeEnabled();
  });

  test("PK-preview-review-new-node 新候选未加入正式目录时说明边界", async ({ page }) => {
    await installSession(page);
    const scenario = await installBuildScenario(page, { generated: true });
    await completeBuild(page, scenario);
    scenario.interruptWithFailedReview();
    const nodes = [{ ...assetNode("project", "项目地图"), contentMode: "directory" }, { ...assetNode("new-doc", "关键机制", "project"), contentMode: "generated" }];
    await page.route("**/api/knowledge/assets/run.preview?**", route => route.fulfill({ json: { ok: true, data: { runId: "build-e2e", tree: { schemaVersion: 2, instructions: "", nodes }, treeHash: null, planHash: "f".repeat(64), items: nodes.map(node => ({ nodeId: node.id, revisionId: node.id === "new-doc" ? "build-doc-r1" : null, canApply: node.id !== "new-doc", reason: node.id === "new-doc" ? "正文尚未通过有效复检" : null, applied: false })) } } }));
    await page.route("**/api/knowledge/assets/reviews?**", route => route.fulfill({ json: { ok: true, data: [] } }));
    await page.reload();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "关键机制", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await expect(preview).toContainText("复检未完成，请重试复检");
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    await expect(preview.getByRole("button", { name: "复检这份文档", exact: true })).toHaveCount(0);
    expect(scenario.calls.generates).toHaveLength(1);
    expect(scenario.calls.starts).toHaveLength(1);
    expect(scenario.applies).toHaveLength(0);
    await preview.getByRole("button", { name: "重试复检", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(2);
    expect(scenario.calls.starts[1]).toMatchObject({ runId: "build-e2e", nodeIds: ["new-doc"] });
    expect(scenario.calls.generates).toHaveLength(1);
  });

  test("PK-preview-review-read-failure 报告读取失败显式阻断错误操作，重读保留当前正文", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues" });
    let failed = true;
    await page.route("**/api/knowledge/assets/reviews?**", route => failed ? route.fulfill({ status: 503, json: { ok: false, code: "REVIEW_READ_FAILED", message: "暂时无法读取报告" } }) : route.fallback());
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await expect(preview).toContainText("复检报告读取失败");
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    await expect(preview).not.toContainText("尚未复检");
    await expect(preview.getByRole("button", { name: "重新复检", exact: true })).toBeDisabled();
    failed = false;
    await preview.getByRole("button", { name: "重新读取报告", exact: true }).click();
    await expect(preview.getByTestId("knowledge-review-report")).toContainText("缺少错误码字段");
    await expect(preview.getByRole("tab", { name: "复检报告", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.starts).toHaveLength(0);
  });

  test("PK-preview-review-old-version 旧候选不能通过新建复检误操作最新草稿", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "stale" });
    await page.route("**/api/knowledge/assets/node?**", route => route.fulfill({ json: { ok: true, data: { node: assetNode(), current: null, currentHash: null, drafts: [{ id: "revision-newer", nodeId: "root", createdAt: "2026-09-22T12:00:00Z" }, { id: "revision-root", nodeId: "root", createdAt: "2026-09-21T12:00:00Z", runId: "batch-e2e" }], effectiveInstructions: "", freshness: [] } } }));
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await expect(preview).toContainText("已有更新的待采用版本");
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    await expect(preview.getByRole("button", { name: "重新复检", exact: true })).toHaveCount(2);
    for (const button of await preview.getByRole("button", { name: "重新复检", exact: true }).all()) await expect(button).toBeDisabled();
    expect(scenario.calls.starts).toHaveLength(0);
  });

  test("PK-preview-review-product 产品原文的问题指引更新原始资料，不出现无法执行的生成修订", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues", productDocument: true });
    await openKnowledge(page, scenario.threadId);
    await expandKnowledgeDirectory(page, "产品文档");
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await expect(preview).toContainText("请更新资料后重新导入并复检");
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    await expect(preview.getByRole("button", { name: "按报告问题生成修订版", exact: true })).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "回知识工作会话修订", exact: true })).toHaveCount(0);
    await expect(preview.getByTestId("knowledge-review-notice").getByRole("button", { name: "重新复检", exact: true })).toBeEnabled();
    expect(scenario.calls.generates).toHaveLength(0);
  });

  test("PK-preview-review-running 文件工作会话正在修订时禁止并行复检和生成修订", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues", holdFirstTurn: true });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    await preview.getByRole("button", { name: "回知识工作会话修订", exact: true }).click();
    const assistant = page.getByTestId("knowledge-assistant");
    await assistant.locator(".composer__textarea").press("Enter");
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    for (const name of ["重新复检", "按报告问题生成修订版", "回知识工作会话修订"]) {
      await expect(preview.getByRole("button", { name, exact: true }).first()).toBeDisabled();
      for (const button of await preview.getByRole("button", { name, exact: true }).all()) await expect(button).toBeDisabled();
    }
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.starts).toHaveLength(0);
  });

  test("PK-preview-review-session-owner 同一正文存在另一复检宿主时仍返回当前候选的原会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues" });
    await openKnowledge(page, scenario.threadId);
    const runs = await page.evaluate(async workspaceId => {
      const response = await fetch(`/api/knowledge/assets/runs?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (!response.ok) throw new Error(`读取测试任务失败：${response.status}`);
      return (await response.json()).data as Run[];
    }, WORKSPACE_ID);
    const original = runs.find(run => run.id === "batch-e2e")!;
    const reviewHost = { ...original, id: "earlier-review-host", mode: "review", createdAt: "2026-09-20T12:00:00Z", items: (original.items as RequestBody[]).map(item => ({ ...item, executionThreadId: "knowledge-generation-other" })) };
    await page.route("**/api/knowledge/assets/runs?**", route => route.fulfill({ json: { ok: true, data: [reviewHost, original] } }));
    await page.reload();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const preview = page.getByTestId("knowledge-build-preview");
    await preview.getByRole("button", { name: "查看复检报告", exact: true }).click();
    await preview.getByRole("button", { name: "回知识工作会话修订", exact: true }).click();
    const input = page.getByTestId("knowledge-assistant").locator(".composer__textarea");
    await expect(input).toHaveValue(/缺少错误码字段/);
    await input.press("Enter");
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    expect(scenario.calls.sends[0]).toMatchObject({ threadId: "knowledge-generation-root" });
  });

  test("PK-preview-slow-maintenance 维护配置迟到不阻塞正文和采用校验，提交前必须等待", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-a");
    let releaseSchedule!: () => void;
    const scheduleGate = new Promise<void>(resolve => { releaseSchedule = resolve; });
    let validations = 0;
    await page.route("**/api/knowledge/assets/update.schedule?**", async route => { await scheduleGate; await route.fallback(); });
    await page.route("**/api/knowledge/assets/run.preview?**", async route => { validations++; await route.fallback(); });
    await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".revision-diff")).toContainText("candidate-a");
    await expect.poll(() => validations).toBeGreaterThan(0);
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect.poll(() => validations).toBeGreaterThan(1);
    expect(scenario.writes).toHaveLength(0);
    releaseSchedule();
    await expect.poll(() => scenario.writes.length).toBe(1);
    await expect(page.locator("div.document")).toContainText("candidate-a");
  });

  test("PK-preview-maintenance-failure 维护配置失败仍可阅读正文，采用显式失败且无写入", async ({ page }) => {
    await installSession(page);
    const scenario = await installUnifiedUpdatesScenario(page);
    await openKnowledge(page);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "项目约定", exact: true }).click();
    await expect(page.locator("div.document")).toContainText("formal-a");
    await page.route("**/api/knowledge/assets/update.schedule?**", route => route.fulfill({ status: 503, json: { ok: false, code: "E2E_MAINTENANCE_READ_FAILED", message: "维护配置暂时无法读取" } }));
    await page.getByRole("button", { name: "查看更新 1", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    await expect(updates.locator(".revision-diff")).toContainText("candidate-a");
    await expect(updates).toContainText("维护配置暂时无法读取");
    await updates.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect(updates).toContainText("已完成 0 项");
    expect(scenario.writes).toHaveLength(0);
    expect(scenario.saves).toHaveLength(0);
  });

  test("PK-17 新建会话统一归属项目，浏览目录只改变阅读目标", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 1 });
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeDiscussion(page);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "功能说明", exact: true }).click();
    // 选中文档会切回文件工作会话，项目级会话操作需要重新切回项目讨论。
    await openKnowledgeDiscussion(page);
    await page.getByTestId("knowledge-assistant").locator(".assistant-head").getByRole("button", { name: "管理规格会话", exact: true }).click();
    await page.getByRole("button", { name: "新建规格会话", exact: true }).click();
    await expect.poll(() => scenario.calls.creates.length).toBe(1);
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null });
    await expect(page.locator(".assistant-scope")).toHaveText("整个项目");
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await tree.getByRole("button", { name: "资产 1", exact: true }).click();
    await openKnowledgeDiscussion(page);
    await expect(page.locator(".assistant-scope")).toHaveText("整个项目");
    expect(scenario.calls.creates.length).toBe(1);
  });

  test("PK-17a 历史目录会话保持原范围，新高级任务独立归属项目", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2, knowledgeNodeId: "child-0" });
    await openKnowledge(page, scenario.threadId);
    await openKnowledgeDiscussion(page);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("button", { name: "展开功能说明", exact: true }).click();
    await tree.getByRole("button", { name: "资产 1", exact: true }).click();
    // 选中文档会切回文件工作会话，重新切回项目讨论再核对专题归属。
    await openKnowledgeDiscussion(page);
    await expect(page.locator(".assistant-scope")).toHaveText("功能说明 / 资产 1");
    await tree.getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成" });
    await expect(modal.getByTestId("batch-scope-resolution")).toHaveCount(0);
    expect(scenario.calls.creates).toHaveLength(0);
    await expect(page.locator(".assistant-scope")).toHaveText("功能说明 / 资产 1");
    await expect(modal.getByRole("button", { name: "开始生成", exact: true })).toBeEnabled();
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.creates).toHaveLength(1);
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null });
    expect(scenario.calls.generates[0]).toMatchObject({ ownerThreadId: scenario.summaries.at(-1)!.threadId, selectedNodeIds: ["root"] });
    expect(scenario.calls.connects.every(call => call.threadId === scenario.threadId)).toBe(true);
    // 候选会自动定位文件会话，这里已在项目讨论模式核对原专题归属。
    await expect(page.locator(".assistant-scope")).toHaveText("功能说明 / 资产 1");
  });

  test("PK-18 首次进入不占用研发会话，明确开始后创建项目知识会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { noKnowledge: true });
    await openKnowledge(page);
    await openKnowledgeDiscussion(page);
    await expect(page.getByRole("button", { name: "开始规格对话", exact: true })).toBeVisible();
    await expect(page.locator(".composer__textarea")).toHaveCount(0);
    expect(scenario.calls.connects).toHaveLength(0);
    expect(scenario.calls.creates).toHaveLength(0);
    await configureMockKnowledgeModel(page);
    await page.getByRole("button", { name: "开始规格对话", exact: true }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.creates).toHaveLength(1);
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null, engine: "codex" });
    expect(scenario.calls.creates[0]).not.toHaveProperty("threadId");
    await expect(page.locator(".assistant-scope")).toContainText("整个项目");
    await expect(page.locator(".assistant-head").getByRole("button", { name: "结束协作", exact: true })).toBeVisible();
    await page.locator(".composer__textarea").fill("整理项目知识");
    await page.locator(".composer__send-btn").click();
    await expect(page.getByText("已收到：整理项目知识", { exact: true })).toBeVisible();
    expect(scenario.calls.sends[0].threadId).not.toBe(scenario.ordinaryThreadId);
    expect(scenario.calls.sends[0].threadId).not.toBe(scenario.threadId);
  });

  test("PK-19 知识会话保留模型思考强度，隐藏权限计划角色；研发会话保持原配置", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await page.goto(`/chat?threadId=${scenario.ordinaryThreadId}`);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByLabel("规格会话引擎")).toHaveCount(0);
    await expect(page.locator(".composer__access-select")).toBeVisible();
    await expect(page.getByRole("switch", { name: "计划模式", exact: true })).toBeVisible();
    await expect(page.locator(".composer__role-select")).toBeVisible();
    await page.goto(`/knowledge?threadId=${scenario.threadId}`);
    await expect(page.locator(".knowledge-page")).toBeVisible();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    await expect(page.locator(".composer__model-select")).toBeVisible();
    await expect(page.locator(".composer__effort-select")).toBeVisible();
    await expect(page.locator(".composer__access-select")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "计划模式", exact: true })).toHaveCount(0);
    await expect(page.locator(".composer__role-select")).toHaveCount(0);
    await page.locator(".composer__textarea").fill("核对知识来源");
    await page.locator(".composer__send-btn").click();
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    expect(scenario.calls.sends[0]).toMatchObject({ threadId: scenario.threadId, accessMode: "read-only", planMode: false, roleId: null });
  });

  test("PK-21 知识引导整体水平垂直居中，亮暗主题与窄屏不溢出", async ({ page }, testInfo) => {
    await installSession(page);
    await installKnowledgeScenario(page, { noKnowledge: true });
    await openKnowledge(page);
    await showKnowledgeAssistant(page);
    const assistant = page.getByTestId("knowledge-assistant");
    const welcome = assistant.locator(".conversation-welcome");
    await assistant.getByRole("button", { name: "项目讨论", exact: true }).click();
    for (const size of [{ width: 1366, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      if (size.width <= 1100) {
        const toggle = page.getByRole("button", { name: "AI 对话", exact: true });
        if (size.width === 1024) await expect(toggle).toHaveAttribute("aria-expanded", "false");
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(assistant).toBeVisible();
        const treeToggle = page.getByRole("button", { name: "规格库目录", exact: true });
        if (await treeToggle.getAttribute("aria-expanded") === "false") await treeToggle.click();
        await expect(treeToggle).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByTestId("tree-batch-actions")).toHaveCount(1);
        if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
      }
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await expect(welcome).toBeVisible();
        await expect.poll(async () => welcome.locator(".ant-select-selector").evaluate(element => {
          const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
          const brightness = channels.reduce((sum, channel) => sum + channel, 0) / 3;
          return brightness < 100 ? "dark" : "light";
        })).toBe(colorScheme);
        const surface = await assistant.locator(".conversation-start").boundingBox();
        const content = await welcome.boundingBox();
        expect(surface).not.toBeNull(); expect(content).not.toBeNull();
        expect(Math.abs(content!.x + content!.width / 2 - surface!.x - surface!.width / 2)).toBeLessThanOrEqual(2);
        expect(Math.abs(content!.y + content!.height / 2 - surface!.y - surface!.height / 2)).toBeLessThanOrEqual(2);
        await expectInside(welcome, assistant);
        await expectNoHorizontalOverflow(assistant);
        await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
        await expectNoHorizontalOverflow(page.locator(".page-header"));
        await expectInside(page.locator(".page-header").getByRole("button", { name: "完善规格", exact: true }), page.locator(".page-header"));
        if (size.width > 1100) await expectInside(page.getByTestId("tree-batch-actions").getByRole("button", { name: "一键生成", exact: true }), page.getByTestId("knowledge-tree"));
        await expectNoHorizontalOverflow(assistant.locator(".assistant-head"));
        await expectInside(assistant.getByRole("button", { name: "收起", exact: true }), assistant.locator(".assistant-head"));
        await expect(assistant.locator(".assistant-head").getByRole("button", { name: "新建规格会话", exact: true })).toHaveCount(0);
        await expect(assistant.locator(".assistant-head .conversation-picker")).toHaveCount(0);
        await expect(assistant.getByRole("button", { name: "开始规格对话", exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`knowledge-welcome-${size.width}-${colorScheme}.png`) });
      }
    }
  });

  test("PK-22 低高度引导保持顶部可达，操作可滚动查看", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { noKnowledge: true });
    await openKnowledge(page);
    await page.setViewportSize({ width: 390, height: 360 });
    await page.getByRole("button", { name: "AI 对话", exact: true }).click();
    await expect(page.getByTestId("knowledge-assistant")).toHaveClass(/open/u);
    const discussion = page.getByTestId("knowledge-assistant").getByRole("button", { name: "项目讨论", exact: true });
    if (await discussion.count()) await discussion.first().dispatchEvent("click");
    const start = page.locator(".conversation-start");
    const position = await start.evaluate(element => {
      // 引导内容结构已简化，取首个可见子元素作为内容顶部基准。
      const content = element.querySelector(".conversation-welcome") ?? element.firstElementChild ?? element;
      return { viewportTop: element.getBoundingClientRect().top, contentTop: content.getBoundingClientRect().top, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    expect(position.contentTop).toBeGreaterThanOrEqual(position.viewportTop);
    // 低高度下引导内容已压缩到容器内，允许不产生内部滚动，但内容不能被裁切。
    expect(position.scrollHeight).toBeGreaterThanOrEqual(position.clientHeight);
    const begin = page.getByRole("button", { name: "开始规格对话", exact: true });
    await begin.scrollIntoViewIfNeeded();
    await expectInside(begin, start);
    await expectNoHorizontalOverflow(start);
    await configureMockKnowledgeModel(page);
    await begin.click();
    await expect.poll(() => scenario.calls.creates.length).toBe(1);
    await expect(page.locator(".composer__textarea")).toBeEnabled();
  });

  test("PK-23 欢迎区统一项目入口，选择目录后新建会话仍归属整个项目", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { noKnowledge: true });
    await openKnowledge(page);
    await showKnowledgeAssistant(page);
    const assistant = page.getByTestId("knowledge-assistant");
    const welcome = assistant.locator(".conversation-welcome");
    await assistant.getByRole("button", { name: "项目讨论", exact: true }).click();
    await expect(welcome.getByRole("button", { name: "整个项目", exact: true })).toHaveCount(0);
    await expect(welcome.getByRole("button", { name: "当前目录", exact: true })).toHaveCount(0);
    await expect(assistant.locator(".assistant-head .session-controls")).toHaveCount(0);
    await expect(assistant.getByRole("button", { name: "开始规格对话", exact: true })).toHaveCount(1);
    await expect(page.locator(".overview")).toHaveCount(0);
    await expect(page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true })).toBeVisible();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    await assistant.getByRole("button", { name: "项目讨论", exact: true }).click();
    await expect(welcome.locator(".scope-description")).toContainText("目录与多选只限定本次任务");
    await configureMockKnowledgeModel(page);
    await welcome.getByRole("button", { name: "开始规格对话", exact: true }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.creates).toHaveLength(1);
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null, engine: "codex" });
    expect(scenario.calls.creates[0]).not.toHaveProperty("threadId");
    await expect(assistant.locator(".assistant-scope")).toHaveText("整个项目");
    await page.locator(".composer__textarea").fill("说明当前目录下的功能资产");
    await page.locator(".composer__send-btn").click();
    await expect(page.getByText("已收到：说明当前目录下的功能资产", { exact: true })).toBeVisible();
    expect(scenario.calls.sends[0].threadId).not.toBe(scenario.ordinaryThreadId);
    expect(scenario.calls.sends[0].threadId).not.toBe(scenario.threadId);
    await assistant.getByRole("button", { name: "结束协作", exact: true }).click();
    await expect(welcome).toBeVisible();
    await expect(welcome.locator(".scope-description")).toContainText("目录与多选只限定本次任务");
  });

  test("PK-24 结束协作后在欢迎区继续历史会话，窄屏顶部管理操作不溢出", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    await openKnowledge(page, scenario.threadId);
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    await assistant.locator(".assistant-head").getByRole("button", { name: "结束协作", exact: true }).click();
    await expect(assistant.locator(".conversation-welcome")).toBeVisible();
    await expect(assistant.locator(".assistant-head .conversation-picker")).toHaveCount(0);
    await expect(assistant.getByRole("button", { name: "新建规格会话", exact: true })).toHaveCount(0);
    const history = assistant.locator('.conversation-welcome [aria-label="选择历史规格会话"]');
    await history.click();
    await page.locator(".ant-select-dropdown:visible").getByText("项目资产协作", { exact: true }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.connects.at(-1)?.threadId).toBe(scenario.threadId);
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.ends).toHaveLength(1);
    for (const size of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      const toggle = page.getByRole("button", { name: "AI 对话", exact: true });
      if (size.width === 1024) await expect(toggle).toHaveAttribute("aria-expanded", "false");
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(assistant).toBeVisible();
      const header = assistant.locator(".assistant-head");
      await expectNoHorizontalOverflow(header);
      for (const name of ["管理规格会话", "结束协作", "收起"]) await expectInside(header.getByRole("button", { name, exact: true }), header);
      await expectInside(assistant.locator(".composer__send-btn"), assistant);
      await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
    }
    await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    const tree = page.getByTestId("knowledge-tree");
    await expect(tree).toBeVisible();
    await tree.getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const batch = page.getByRole("dialog", { name: "确认批量生成" });
    await expect(batch).toBeVisible();
    const batchModel = batch.getByRole("combobox", { name: "批量生成模型", exact: true });
    const batchEffort = batch.getByRole("combobox", { name: "批量思考强度", exact: true });
    await batchModel.selectOption("gpt-second");
    await batchEffort.selectOption("low");
    expect(page.viewportSize()?.width).toBe(390);
    for (const control of [batchModel, batchEffort, batch.getByRole("button", { name: "开始生成", exact: true }), batch.getByRole("button", { name: /取\s*消/, exact: true })]) await expectInside(control, batch);
    await expectNoHorizontalOverflow(batch);
    await batch.getByRole("button", { name: /取\s*消/, exact: true }).click();
    await expect(batch).not.toBeVisible();
    await page.getByRole("button", { name: "规格库目录", exact: true }).click();
    await page.getByRole("button", { name: "AI 对话", exact: true }).click();
    await expect(tree).not.toBeVisible();
    await expect(assistant).toBeVisible();
    await expect(page.getByRole("button", { name: "规格库目录", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "AI 对话", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.locator(".composer__textarea").fill("继续整理原来的项目知识");
    await page.locator(".composer__send-btn").click();
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    expect(scenario.calls.sends[0]).toMatchObject({ threadId: scenario.threadId, model: "gpt-test", effort: "high" });
    expect(scenario.calls.sends[0].threadId).not.toBe(scenario.ordinaryThreadId);
    await expect(page.getByText("已收到：继续整理原来的项目知识", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 360 });
    const input = assistant.locator(".composer__textarea");
    const send = assistant.locator(".composer__send-btn");
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeVisible();
    await expectInside(input, assistant);
    await expectInside(send, assistant);
    const inputBox = await input.boundingBox();
    const sendBox = await send.boundingBox();
    const assistantBox = await assistant.boundingBox();
    expect(inputBox!.y).toBeGreaterThanOrEqual(assistantBox!.y - 1);
    expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(assistantBox!.y + assistantBox!.height + 1);
  });

  test("PK-25 默认继续本人最近项目会话，显式新建保留独立历史", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { inactiveKnowledge: true });
    await openKnowledge(page);
    await openKnowledgeDiscussion(page);
    await configureMockKnowledgeModel(page);
    await expect(page.getByRole("button", { name: "继续最近会话", exact: true })).toBeVisible();
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    await openKnowledgeDiscussion(page);
    await page.getByRole("button", { name: "继续最近会话", exact: true }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.connects.at(-1)?.threadId).toBe(scenario.threadId);
    expect(scenario.calls.creates).toHaveLength(0);
    await page.locator(".assistant-head").getByRole("button", { name: "结束协作", exact: true }).click();
    await expect(page.getByRole("button", { name: "继续最近会话", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "新建独立会话", exact: true }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.creates).toHaveLength(1);
    expect(scenario.calls.creates[0]).toMatchObject({ nodeId: null });
    expect(new URL(page.url()).searchParams.get("threadId")).not.toBe(scenario.threadId);
    await page.locator(".assistant-head").getByRole("button", { name: "结束协作", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "筛选规格会话", exact: true })).toHaveCount(0);
    await page.locator('[aria-label="选择历史规格会话"]').click();
    await expect(page.locator(".ant-select-dropdown:visible").getByText("项目资产协作", { exact: true })).toBeVisible();
    await expect(page.locator(".ant-select-dropdown:visible").getByText("新项目知识会话", { exact: true })).toBeVisible();
  });

  test("PK-26 知识深链进入指定目录会话，非法目标不退回其他会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { inactiveKnowledge: true, knowledgeNodeId: "root" });
    await page.goto(`/knowledge?threadId=${scenario.threadId}`);
    await openKnowledgeDiscussion(page);
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    await expect(page.locator(".assistant-scope")).toHaveText("功能说明");
    await expect(page.locator(".document-title")).toContainText("功能说明");
    expect(scenario.calls.connects).toHaveLength(1);
    expect(scenario.calls.connects[0].threadId).toBe(scenario.threadId);
    await page.goto(`/knowledge?threadId=${scenario.ordinaryThreadId}`);
    // 非法会话不再显示旧绑定错误，但同样不能自动连接普通会话或渲染输入框。
    await expect(page.locator(".composer__textarea")).toHaveCount(0);
    expect(scenario.calls.connects).toHaveLength(1);
    expect(scenario.calls.creates).toHaveLength(0);
  });

  test("PK-27 规格类别直开原会话，显式恢复协作，刷新和研发草稿保留", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { inactiveKnowledge: true, knowledgeNodeId: "root" });
    await page.goto(`/chat?threadId=${scenario.ordinaryThreadId}`);
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    await page.locator(".composer__textarea").fill("研发草稿，不应带进知识会话");
    const knowledgeTab = page.locator('.thread-list__segmented [title="规格会话"]');
    await knowledgeTab.click();
    const knowledgeItem = page.locator(".thread-list__item").filter({ hasText: "项目资产协作" });
    await expect(knowledgeItem).toBeVisible();
    await expect(page.locator(".composer__textarea")).toHaveValue("研发草稿，不应带进知识会话");
    const draftSaved = page.waitForResponse(response => response.url().includes("/api/threads/draft/save") && response.request().method() === "POST");
    await knowledgeItem.click();
    await draftSaved;
    await expect.poll(() => {
      const url = new URL(page.url());
      return { path: url.pathname, workspaceId: url.searchParams.get("workspaceId"), threadId: url.searchParams.get("threadId") };
    }).toEqual({ path: "/chat", workspaceId: WORKSPACE_ID, threadId: scenario.threadId });
    const context = page.getByTestId("knowledge-thread-context");
    await expect(context).toContainText("功能说明");
    await expect(page.locator(".composer__textarea")).toBeDisabled();
    expect(scenario.calls.connects).toHaveLength(0);
    await context.getByRole("button", { name: "恢复协作" }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    await expect(page.locator(".composer__textarea")).toHaveValue("");
    expect(scenario.calls.connects.at(-1)?.threadId).toBe(scenario.threadId);
    await page.reload();
    await expect(page.getByTestId("knowledge-thread-context")).toContainText("功能说明");
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.connects).toHaveLength(1);
    await page.goBack();
    await expect(page.locator(".composer__textarea")).toHaveValue("研发草稿，不应带进知识会话");
    await page.goForward();
    await expect(page.getByTestId("knowledge-thread-context")).toContainText("功能说明");
    await page.goBack();
    const ordinaryTab = page.locator(".thread-list__segmented .ant-segmented-item").filter({ hasText: "普通" });
    await expect(ordinaryTab).toBeVisible();
    await ordinaryTab.click();
    const ordinaryItem = page.locator(".thread-list__item").filter({ hasText: "研发会话，不得复用" });
    await expect(ordinaryItem).toBeVisible();
    await ordinaryItem.click();
    await expect(page.locator(".composer__textarea")).toHaveValue("研发草稿，不应带进知识会话");
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.sends).toHaveLength(0);
  });

  test("PK-direct-planning 一键生成的规划会话可直开，任务结束仍只读并返回原讨论", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    const run: Run = { schemaVersion: 1, id: "planning-work", createdAt: "2026-10-22", mode: "build", nodeId: null, ownerThreadId: scenario.threadId, planningThreadId: "knowledge-generation-planning", proposedTree: null, active: true, phase: "planning", items: [] };
    scenario.setRun(run);
    await page.goto(`/chat?workspaceId=${WORKSPACE_ID}&threadId=${run.planningThreadId}`);
    const context = page.getByTestId("knowledge-thread-context");
    await expect(context).toContainText("知识规划 · 筛选与组织项目知识");
    await expect(context).toContainText("知识任务执行中，规划过程仅可查看");
    await expect(context.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".composer__textarea")).toBeDisabled();
    scenario.setRun({ ...run, active: false, phase: "completed" });
    await expect(context).toContainText("规划过程仅可查看，请在规格知识库管理或继续任务", { timeout: 10000 });
    await expect(page.locator(".composer__textarea")).toBeDisabled();
    await expect(context.getByRole("button", { name: "恢复协作" })).toHaveCount(0);
    expect(scenario.calls.connects).toHaveLength(0);
    expect(scenario.calls.creates).toHaveLength(0);
    expect(scenario.calls.sends).toHaveLength(0);
    await context.getByRole("button", { name: "打开规格库" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("threadId")).toBe(scenario.threadId);
    expect(new URL(page.url()).searchParams.has("executionThreadId")).toBe(false);
  });

  test("PK-direct-work 文件工作会话直开，后台完成后可续聊并定位文档", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "queued" });
    await page.goto(`/chat?workspaceId=${WORKSPACE_ID}&threadId=knowledge-generation-root`);
    const context = page.getByTestId("knowledge-thread-context");
    await expect(context).toContainText("文件工作 · 功能说明");
    await expect(context).toContainText("后台任务执行或采用中");
    await expect(page.locator(".composer__textarea")).toBeDisabled();
    scenario.setRun({ schemaVersion: 1, id: "finished-work", createdAt: "2026-10-22", mode: "batch", nodeId: null, ownerThreadId: scenario.threadId, proposedTree: null, active: false, phase: "completed", items: [{ id: "work", nodeId: "root", title: "功能说明", executionThreadId: "knowledge-generation-root", status: "completed", revisionId: "revision-root" }] });
    await expect(page.locator(".composer__textarea")).toBeEnabled({ timeout: 10000 });
    await page.locator(".composer__textarea").fill("补充失败处理的证据");
    await page.locator(".composer__textarea").press("Enter");
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    expect(scenario.calls.sends[0].threadId).toBe("knowledge-generation-root");
    expect(scenario.calls.generates).toHaveLength(0);
    await context.getByRole("button", { name: "查看对应文档" }).click();
    await expect(page).toHaveURL(/\/knowledge\?.*nodeId=root/u);
    await expect(page.getByRole("main").getByRole("heading", { name: "功能说明", exact: true })).toBeVisible();
  });

  test("PK-direct-error 状态读取失败明确报错并阻止续聊，重试后恢复", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    let fail = true;
    await page.route("**/api/knowledge/assets/runs?**", route => fail
      ? route.fulfill({ status: 503, json: { ok: false, code: "KNOWLEDGE_READ_FAILED", message: "模拟任务读取失败", details: { requestId: "read-test" } } })
      : route.fallback());
    await page.goto(`/chat?workspaceId=${WORKSPACE_ID}&threadId=${scenario.threadId}`);
    const context = page.getByTestId("knowledge-thread-context");
    await expect(context.getByRole("alert")).toContainText("模拟任务读取失败");
    await expect(page.locator(".composer__textarea")).toBeDisabled();
    fail = false;
    await context.getByRole("button", { name: /重\s*试/u }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.connects).toHaveLength(0);
    expect(scenario.calls.creates).toHaveLength(0);
  });

  test("PK-28 加载时改选会话，以最新地址为准且不覆盖为旧会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { inactiveKnowledge: true });
    const nextId = "knowledge-route-new";
    scenario.summaries.push({ ...scenario.summaries[0], threadId: nextId, nodeId: "root", title: "新的目录讨论" });
    let release!: () => void, connecting = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/conversation.connect", async route => {
      if (route.request().postDataJSON().threadId !== scenario.threadId) return route.fallback();
      connecting = true; await gate;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { ...scenario.summaries[0], active: true } }) });
    });
    await page.goto(`/knowledge?threadId=${scenario.threadId}`);
    await expect.poll(() => connecting).toBeTruthy();
    await page.evaluate(async id => {
      const app = (document.querySelector("#app") as any).__vue_app__;
      await app.config.globalProperties.$router.push({ path: "/knowledge", query: { threadId: id } });
    }, nextId);
    release();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    await expect.poll(() => new URL(page.url()).searchParams.get("threadId")).toBe(nextId);
    await expect(page.locator(".assistant-scope")).toHaveText("功能说明");
    expect(scenario.calls.connects.at(-1)?.threadId).toBe(nextId);
  });

  test("PK-29 参与他人的知识会话不自动恢复或默认续聊，可手动选择", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    scenario.summaries[0].createdByUserId = "another-user";
    await openKnowledge(page);
    await openKnowledgeDiscussion(page);
    await expect(page.getByRole("button", { name: "开始规格对话", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "继续最近会话", exact: true })).toHaveCount(0);
    expect(scenario.calls.connects).toHaveLength(0);
    await page.locator('[aria-label="选择历史规格会话"]').click();
    await page.locator(".ant-select-dropdown:visible").getByText("项目资产协作", { exact: true }).click();
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    expect(scenario.calls.connects[0].threadId).toBe(scenario.threadId);
    expect(scenario.calls.creates).toHaveLength(0);
  });

  test("PK-30 批量弹窗直接配置模型与支持的思考强度，取消还原且不修改会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { secondModelLowOnly: true });
    await openKnowledge(page, scenario.threadId);
    await expect(page.locator(".composer__textarea")).toBeEnabled();
    const initialPrefsUpdates = scenario.calls.prefs.length;
    await page.getByTestId("knowledge-tree").getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成" });
    const model = modal.getByRole("combobox", { name: "批量生成模型", exact: true });
    const effort = modal.getByRole("combobox", { name: "批量思考强度", exact: true });
    await expect(model).toHaveValue("gpt-test");
    await expect(effort).toHaveValue("high");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const control of [model, effort]) {
        await expect.poll(() => control.evaluate(element => {
          const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
          const brightness = channels.reduce((sum, value) => sum + value, 0) / 3;
          return brightness < 80 ? "dark" : brightness > 180 ? "light" : "indistinct";
        })).toBe(colorScheme);
        await expect.poll(() => control.evaluate(element => {
          const style = getComputedStyle(element);
          const luminance = (color: string) => {
            const linear = (color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []).map(channel => {
              const normalized = channel / 255;
              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
          };
          const text = luminance(style.color), background = luminance(style.backgroundColor);
          return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
        })).toBeGreaterThanOrEqual(4.5);
        await expectInside(control, modal);
      }
      await expectNoHorizontalOverflow(modal);
      await page.screenshot({ animations: "disabled", path: test.info().outputPath(`knowledge-batch-model-${colorScheme}.png`) });
    }
    await expect(modal.getByRole("button", { name: "在会话中调整", exact: true })).toHaveCount(0);
    await model.selectOption("gpt-second");
    await expect(effort).toHaveValue("low");
    await expect(effort.locator('option[value="high"]')).toHaveCount(0);
    await modal.getByRole("button", { name: /取\s*消/, exact: true }).click();
    await expect(modal).not.toBeVisible();
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.prefs).toHaveLength(initialPrefsUpdates);

    await openKnowledgeMenu(page, "高级生成");
    await expect(model).toHaveValue("gpt-test");
    await expect(effort).toHaveValue("high");
    await model.selectOption("gpt-second");
    await expect(effort).toHaveValue("low");
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates).toHaveLength(1);
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "batch", ownerThreadId: scenario.summaries.at(-1)!.threadId, engine: "codex", model: "gpt-second", effort: "low" });
    expect(scenario.calls.prefs).toHaveLength(initialPrefsUpdates);
    await page.locator(".task-summary").getByRole("button", { name: /^停\s*止$/u }).click();
    await expect.poll(() => scenario.calls.stops.length).toBe(1);
    await page.locator(".composer__textarea").fill("继续讨论当前知识目录");
    await page.locator(".composer__send-btn").click();
    await expect.poll(() => scenario.calls.sends.length).toBe(1);
    expect(scenario.calls.sends[0]).toMatchObject({ threadId: scenario.threadId, model: "gpt-test", effort: "high" });
  });

  test("PK-30a 批量生成可切换执行引擎并把选择提交到任务", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2 });
    await openKnowledge(page, scenario.threadId);
    const tree = page.getByTestId("knowledge-tree");
    await tree.getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成" });
    const engine = modal.getByRole("combobox", { name: "批量生成引擎", exact: true });
    await expect(engine).toHaveValue("codex");
    await engine.selectOption("claude");
    await expect(engine).toHaveValue("claude");
    await expect(modal.getByRole("button", { name: "开始生成", exact: true })).toBeEnabled();
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.generates.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ engine: "claude", selectedNodeIds: ["root"] });
  });


  test("PK-32 生成默认复检，复检模型与生成配置独立提交", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { secondModelLowOnly: true });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "高级生成");
    const modal = page.getByRole("dialog", { name: "确认批量生成" });
    await expect(modal.getByRole("switch", { name: "生成后复检", exact: true })).toBeChecked();
    await expect(modal.getByRole("switch", { name: "发现问题后自动修订", exact: true })).toBeChecked();
    await expect(modal.getByRole("combobox", { name: "复检模型", exact: true })).toHaveValue("gpt-test");
    await modal.getByRole("combobox", { name: "复检模型", exact: true }).selectOption("gpt-second");
    await expect(modal.getByRole("combobox", { name: "复检思考强度", exact: true })).toHaveValue("low");
    await expect(modal.getByRole("combobox", { name: "批量生成模型", exact: true })).toHaveValue("gpt-test");
    await expect(modal.getByRole("combobox", { name: "批量思考强度", exact: true })).toHaveValue("high");
    await modal.getByRole("button", { name: "开始生成", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "batch", model: "gpt-test", effort: "high", reviewConfig: { enabled: true, model: "gpt-second", effort: "low", autoRepair: true, maxRounds: 2 } });
  });

  test("PK-33 首份待复检草稿在主页面预览，未复检通过不能采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "pending" });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    const updates = page.getByTestId("knowledge-updates");
    const preview = page.getByTestId("knowledge-build-preview");
    await preview.getByRole("tab", { name: "完整内容", exact: true }).click();
    await expect(preview.locator(".preview-content")).toContainText("错误边界记录结构化日志");
    await expect(updates.getByRole("button", { name: "采用此版本", exact: true })).toBeDisabled();
    expect(scenario.calls.starts).toHaveLength(0);
    expect(scenario.calls.generates).toHaveLength(0);
  });

  test("PK-33a 工作与历史复检深链直接在右侧打开", async ({ page }) => {
    await installSession(page);
    await installKnowledgeScenario(page, { reviewState: "pending" });
    await page.goto("/knowledge?executionThreadId=knowledge-generation-root");
    const assistant = page.getByTestId("knowledge-assistant");
    await expect(assistant).toContainText("知识工作会话 · 功能说明");
    await expect(assistant.locator(".chat-panel")).toBeVisible();
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    await page.goto("/knowledge?executionThreadId=knowledge-review-root");
    await expect(assistant).toContainText("复检会话 · 功能说明");
    await expect(assistant.locator(".composer__textarea")).toBeEnabled();
    await expect(page.getByTestId("knowledge-plan-review")).toHaveCount(0);
  });

  test("PK-34 复检报告展示正文行号证据建议，显式按报告生成待采用修订", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "issues", currentDocument: true });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    await openDocumentMenu(page, "复检报告");
    const report = page.getByTestId("knowledge-review-report");
    await expect(report).toContainText("缺少错误码字段");
    await expect(report).toContainText("正文第 3–4 行");
    await expect(report.locator(".issue-suggestion")).toContainText("记录 errorCode、requestId 与原始错误原因");
    const reportBounds = (await report.boundingBox())!, issueBounds = (await report.locator(".review-issue").first().boundingBox())!;
    expect(issueBounds.y - reportBounds.y).toBeLessThan(110);
    const evidence = report.locator(".issue-sources");
    await expect(evidence).not.toHaveAttribute("open", "");
    await evidence.locator("summary").click();
    await expect(evidence.locator("code")).toBeVisible();
    await expect(evidence).toContainText("apps/desktop/client/src/logger.ts:24–29");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page.locator(".knowledge-page"));
    await expectNoHorizontalOverflow(report);
    await report.getByRole("button", { name: "按报告问题生成修订版", exact: true }).scrollIntoViewIfNeeded();
    await expectInside(report.getByRole("button", { name: "按报告问题生成修订版", exact: true }), report);
    expect(scenario.calls.generates).toHaveLength(0);
    expect(scenario.calls.adopts).toHaveLength(0);
    await report.getByRole("button", { name: "按报告问题生成修订版", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "根据报告生成修订版", exact: true });
    await expect(modal).toContainText("保留现有版本");
    await modal.locator(".batch-advanced > summary").click();
    await expect(modal.getByRole("switch", { name: "生成后复检", exact: true })).toBeChecked();
    await modal.getByRole("button", { name: "开始生成修订版", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates).toHaveLength(1);
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "batch", strategy: "all", selectedNodeIds: ["root"], includeDescendants: false, repairReports: [{ nodeId: "root", reportId: "review-root" }], reviewConfig: { enabled: true } });
    expect(scenario.calls.adopts).toHaveLength(0);
  });

  for (const width of [1366, 390]) {
    test(`PK-review-issue-list-${width} 长摘要折叠，问题逐项展示修复建议并优先显示阻断项`, async ({ page }, testInfo) => {
      // 先用桌面入口选中文档，再切到目标宽度检查报告本身；移动布局的文档入口不同。
      await page.setViewportSize({ width: 1366, height: 900 });
      await installSession(page);
      const scenario = await installKnowledgeScenario(page, { reviewState: "issues", currentDocument: true });
      const source = { kind: "code", path: `apps/desktop/client/src/${"long-evidence-path-".repeat(12)}.ts`, startLine: 24, endLine: 29, relation: "实际错误边界实现" };
      const reportData = {
        id: "review-root", nodeId: "root", revisionId: "revision-root", createdAt: "2026-09-21T12:01:00.000Z", engine: "codex", outcome: "issues", stale: false, staleReasons: [],
        summary: "已核对源码与文档。".repeat(180),
        issues: [
          { id: "example", severity: "warning", category: "coverage", title: "缺少日志示例", detail: "日志规范没有给出完整示例，不影响现有规则。", documentStartLine: 5, documentEndLine: 5, sources: [source], suggestion: "增加一个包含完整诊断字段的日志示例。" },
          { id: "code", severity: "error", category: "coverage", title: "缺少错误码字段", detail: "日志规范没有要求记录业务错误码，排障时无法识别错误类型。", documentStartLine: 3, documentEndLine: 4, sources: [source], suggestion: "1. 在日志字段要求中补充 errorCode。\n2. 保留 requestId 与原始错误原因。" },
          { id: "scope", severity: "error", category: "factual", title: "日志配置适用范围错误", detail: "正文把 Server 的配置扩展到了 Client，与实际配置入口不符。", documentStartLine: 6, documentEndLine: 6, sources: [source], suggestion: "将该段适用范围限定为 Server，单独说明 Client 配置。" },
        ],
      };
      await page.route("**/api/knowledge/assets/reviews?**", route => route.fulfill({ json: { ok: true, data: [reportData] } }));
      await openKnowledge(page, scenario.threadId);
      await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
      await page.setViewportSize({ width, height: 900 });
      if (width < 1100) {
        const backdrop = page.getByRole("button", { name: "关闭侧面板", exact: true });
        if (await backdrop.isVisible()) await backdrop.click();
      }
      await openDocumentMenu(page, "复检报告");
      const report = page.getByTestId("knowledge-review-report"), issues = report.getByRole("list", { name: "复检问题条目" }).getByRole("article");
      await expect(report.locator(".review-counts")).toHaveText("共 3 项问题：2 项需修复 · 1 项提醒");
      await expect(issues).toHaveCount(3);
      await expect(issues.getByRole("heading", { level: 4 })).toHaveText(["1. 缺少错误码字段", "2. 日志配置适用范围错误", "3. 缺少日志示例"]);
      for (const [index, issue] of (await issues.all()).entries()) {
        await issue.scrollIntoViewIfNeeded();
        await expect(issue.getByText("问题说明", { exact: true })).toBeVisible();
        await expect(issue.getByText("修复建议", { exact: true })).toBeVisible();
        await expect(issue.locator(".issue-suggestion p")).toHaveText(reportData.issues[[1, 2, 0][index]!]!.suggestion);
        await expect(issue.locator(".issue-evidence")).not.toBeVisible();
      }
      const explanation = report.locator(".review-explanation");
      await expect(explanation.locator("p")).not.toBeVisible();
      await explanation.locator("summary").click();
      await expect(explanation.locator("p")).toBeVisible();
      await expect(explanation.locator("p")).toHaveText(reportData.summary);
      await explanation.locator("summary").click();
      await issues.first().locator(".issue-sources summary").click();
      await expect(issues.first().locator(".issue-evidence")).toBeVisible();
      await expectNoHorizontalOverflow(report);
      await page.emulateMedia({ colorScheme: "dark" });
      await expectNoHorizontalOverflow(report);
      await expect(issues.first().locator(".issue-suggestion")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`review-issues-${width}.png`) });
      expect(scenario.calls.generates).toHaveLength(0);
      expect(scenario.calls.adopts).toHaveLength(0);
    });
  }

  test("PK-35 目录多选可仅复检已有文档，空白跳过且独立选复检模型", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { children: 2, reviewState: "issues", secondModelLowOnly: true });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("checkbox", { name: "选择功能说明", exact: true }).check();
    await openKnowledgeMenu(page, "复检所选知识");
    const modal = page.getByRole("dialog", { name: "复检已有文档", exact: true });
    await expect(modal).toContainText("本次处理 1 项");
    await expect(modal).toContainText("最新待采用版本");
    await expect(modal.getByRole("switch", { name: "发现问题后自动修订", exact: true })).not.toBeChecked();
    await expect(modal.getByRole("combobox", { name: "批量生成模型", exact: true })).toHaveCount(0);
    await modal.getByRole("combobox", { name: "复检模型", exact: true }).selectOption("gpt-second");
    await expect(modal.getByRole("combobox", { name: "复检思考强度", exact: true })).toHaveValue("low");
    await modal.getByRole("button", { name: "开始复检", exact: true }).click();
    await expect.poll(() => scenario.calls.starts.length).toBe(1);
    expect(scenario.calls.generates).toHaveLength(1);
    expect(scenario.calls.generates[0]).toMatchObject({ mode: "review", ownerThreadId: scenario.summaries.at(-1)!.threadId, selectedNodeIds: ["root"], includeDescendants: true, reviewConfig: { enabled: true, model: "gpt-second", effort: "low", autoRepair: false, maxRounds: 2 } });
    expect(scenario.calls.sends).toHaveLength(0);
  });

  test("PK-36 独立草稿的失效报告禁用修订，显式确认后才采用", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "stale", standaloneRevision: true });
    await page.route("**/api/knowledge/assets/runs?**", route => route.fulfill({ json: { ok: true, data: [] } }));
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    await openDocumentMenu(page, "复检报告");
    const report = page.getByTestId("knowledge-review-report");
    await expect(report).toContainText("复检已失效");
    await expect(report).toContainText("来源内容已变化");
    await expect(report.getByRole("button", { name: "按报告问题生成修订版", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "采用此版本", exact: true }).click();
    await expect(page.getByText("复检依据已经变化，这份报告已失效。采用后该版本会成为正式文档。", { exact: true })).toBeVisible();
    expect(scenario.calls.adopts).toHaveLength(0);
    await page.getByRole("button", { name: "仍然采用", exact: true }).click();
    await expect.poll(() => scenario.calls.adopts.length).toBe(1);
    await page.getByRole("button", { name: "返回文档", exact: true }).click();
    await expect(page.locator(".document-title")).toContainText("已确认采用");
    await expect(page.locator("div.document")).toContainText("错误日志规范");
    await openDocumentMenu(page, "复检报告");
    await expect(report).toContainText("复检已失效");
  });



  test("PK-38 主页面可重新复检失效报告，已跳过的历史复检不阻挡完成", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page, { reviewState: "stale", currentDocument: true });
    await openKnowledge(page, scenario.threadId);
    await page.getByTestId("knowledge-tree").getByRole("button", { name: "功能说明", exact: true }).click();
    await openDocumentMenu(page, "复检报告");
    const report = page.getByTestId("knowledge-review-report");
    await expect(report).toContainText("来源内容已变化");
    await report.getByRole("button", { name: "重新复检", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "复检已有文档", exact: true });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: /取\s*消/, exact: true }).click();
    expect(scenario.calls.starts).toHaveLength(0);
    for (const status of ["pending", "failed"] as const) {
      scenario.setItemReview({ enabled: false, status });
      await page.goto("/knowledge?threadId=" + scenario.threadId);
      await expect(page.locator(".task-summary")).not.toBeVisible();
    }
    scenario.setItemReview({ enabled: true, status: "passed" });
    await page.goto("/knowledge?threadId=" + scenario.threadId);
    await expect(page.locator(".task-summary")).not.toBeVisible();
    await expect(page.getByTestId("knowledge-updates")).toHaveCount(0);
    await expect(page.locator(".document-title")).toContainText("功能说明");
  });

  test("PK-20 切换工作区后迟到会话清单不覆盖新项目，也不自动连接旧知识会话", async ({ page }) => {
    await installSession(page);
    const scenario = await installKnowledgeScenario(page);
    const nextWorkspace = "workspace_knowledge_list_next";
    await page.route("**/api/workspaces?**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, workspaces: [
      { id: WORKSPACE_ID, title: "E2E 工作区", path: "D:/e2e-workspace", kind: "local", createdAt: 1, updatedAt: 1 },
      { id: nextWorkspace, title: "新的知识项目", path: "D:/next-knowledge", kind: "local", createdAt: 1, updatedAt: 1 },
    ], workspaceListAuthoritative: true }) }));
    let release!: () => void, listRequested = false;
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/knowledge/assets/conversation.list?**", async route => {
      const current = new URL(route.request().url()).searchParams.get("workspaceId");
      if (current === nextWorkspace) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: [] }) });
      listRequested = true; await responseGate;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: [{ threadId: scenario.threadId, nodeId: null, title: "旧项目迟到会话", engine: "codex", model: "gpt-test", effort: "high", active: true, createdAt: 1, updatedAt: 1 }] }) });
    });
    await page.route("**/api/knowledge/assets/snapshot?**", route => {
      if (new URL(route.request().url()).searchParams.get("workspaceId") !== nextWorkspace) return route.fallback();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { initialized: true, knowledgeId: "next-kb", root: "codeflow-docs/知识库", canWrite: true, treeHash: null, states: [], tree: { schemaVersion: 1, instructions: "", nodes: [] } } }) });
    });
    await openKnowledge(page, scenario.threadId);
    await expect.poll(() => listRequested).toBeTruthy();
    await page.evaluate(workspaceId => {
      const app = document.querySelector("#app") as HTMLElement & { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { switchWorkspace: (id: string, options: { reloadPage: boolean }) => void }> } } } } };
      app.__vue_app__.config.globalProperties.$pinia._s.get("config")!.switchWorkspace(workspaceId, { reloadPage: false });
    }, nextWorkspace);
    await expect(page.getByText("0 个节点", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "展开 AI 对话", exact: true }).click();
    await expect(page.getByRole("button", { name: "开始规格对话", exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse(response => response.url().includes("/conversation.list?") && new URL(response.url()).searchParams.get("workspaceId") === WORKSPACE_ID);
    release(); await oldResponse;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText("旧项目迟到会话", { exact: true })).toHaveCount(0);
    await expect(page.locator(".conversation-picker")).toHaveCount(0);
    await expect(page.locator(".composer__textarea")).toHaveCount(0);
    expect(scenario.calls.connects).toHaveLength(0);
  });
});
