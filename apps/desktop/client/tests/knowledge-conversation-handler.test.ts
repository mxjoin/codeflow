import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINE_MODEL_CATALOG_SCHEMA_VERSION, type ConversationEventInput, type KnowledgeAssetActorContext, type ThreadId, type TurnId, type WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { KnowledgeAssetStore, knowledgeCategoryNodes, withKnowledgeDocumentDefaults } from "../src/knowledge/knowledgeAssetStore.ts";
import { KnowledgeChangeStore } from "../src/knowledge/knowledgeChangeStore.ts";
import { KnowledgeGenerationService, stopKnowledgeGenerationForUpdate } from "../src/knowledge/knowledgeGenerationService.ts";
import { logger } from "../src/logger.ts";
import { applyEngineModelCatalogSnapshot, resetEngineModelCatalogRuntimeForTest } from "../src/engines/engineModelCatalogRuntime.ts";
import type { ClientToServerMessage } from "../src/protocol/messages.ts";
import type { SendMessageInput, ThreadEventEmitters } from "../src/engines/threadSession.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";

const WORKSPACE_ID = "client-test:knowledge-handler" as WorkspaceId;
const THREAD_ID = "knowledge-independent-chat" as ThreadId;
const ACTOR: KnowledgeAssetActorContext = { userId: "knowledge-owner", accountRole: "enterprise_admin", enterpriseId: null, requestId: "request-knowledge-bind", permissionScope: "account" };

test("知识会话列表、创建、连接和结束经过真实Writer短许可", async () => {
  const h = setupHarness();
  const writer = new ClientDbWriterService({ db: h.db, dbPath: path.join(h.workspacePath, "client.db"), onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    h.ctx.withDatabase = (requestId, operation) => writer.withLegacyDatabase(requestId, operation);
    const body = { workspaceId: WORKSPACE_ID, actorContext: ACTOR };
    assert.equal((await h.request("guard-list", "knowledge.assets.conversation.list", body))?.status, 200);
    const created = await h.request("guard-create", "knowledge.assets.conversation.create", { ...body, engine: "codex", nodeId: null, title: "许可内会话" });
    assert.equal(created?.status, 200, JSON.stringify(created?.body));
    const threadId = (created?.body as any).data.threadId;
    assert.equal((await h.request("guard-connect", "knowledge.assets.conversation.connect", { ...body, threadId }))?.status, 200);
    assert.equal((await h.request("guard-end", "knowledge.assets.conversation.end", { ...body, threadId }))?.status, 200);
  } finally { await writer.close(); h.cleanup(); }
});

test("真实 API 受理日志拒写仅返回一次知识失败信封，不补应用同条或启动模型", async t => {
  const harness = setupHarness(), cause = new Error("api-accepted-log");
  try {
    const service = new KnowledgeGenerationService(harness.store, WORKSPACE_ID, async () => assert.fail("不得执行"), "api-begin", () => ({ nodeId: null, activationVersion: 1 }), harness.db);
    const run = service.begin({ requestId: "api-start-failure", mode: "batch", ownerThreadId: THREAD_ID, selectedNodeIds: ["knowledge-spec-project"], includeDescendants: false, strategy: "all", prompt: "明确要求", treeHash: harness.store.readTree().hash, engine: "codex", model: "gpt-test", effort: "high" });
    const write = harness.db.writeWorkspaceLog;
    t.mock.method(harness.db, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: any) => { if (entry.data.code === "KNOWLEDGE_RUN_START_ACCEPTED") throw cause; write(workspaceId,entry); });
    let appLogs = 0; t.mock.method(logger, "error", () => { appLogs++; });
    const response = await harness.request("api-log-failure", "knowledge.assets.run.start", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, runId: run.id });
    assert.equal(response?.status, 500); assert.equal((response?.body as any).ok, false);
    assert.equal(harness.sent.filter((message: any) => message.t === "api.res" && message.id === "api-log-failure").length, 1);
    assert.equal(harness.engineInputs.length, 0); assert.equal(appLogs, 0); assert.equal(harness.store.isRunExecuting(run.id), false);
    await assert.rejects(stopKnowledgeGenerationForUpdate(harness.workspacePath, { requestId: "api-stop" }), (error: any) => error instanceof AggregateError && error.errors[0] === cause);
  } finally { harness.cleanup(); }
});

/** 测试引擎仍走真实模型目录门禁，目录中的 gpt-test 只用于替身 session。 */
applyEngineModelCatalogSnapshot({
  schemaVersion: ENGINE_MODEL_CATALOG_SCHEMA_VERSION,
  configVersion: 1,
  capturedAt: 1,
  rows: [
    {
      catalogItemId: "test:claude",
      engine: "claude",
      providerId: "anthropic",
      providerLabel: "Anthropic Claude",
      modelId: "claude-test",
      displayName: "Claude Test",
      description: "",
      inputModalities: ["text"],
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "高" }],
      defaultReasoningEffort: "high",
      contextWindow: 200_000,
      maxContextWindow: null,
      supportsFastMode: false,
      supports1MContext: false,
      isDefault: true,
      sortOrder: 1,
      runtimeProfileId: "native",
      transportModelId: null,
      fastTaskModelId: null,
      subagentModelId: null,
    },
    {
      catalogItemId: "test:codex",
      engine: "codex",
      providerId: "openai",
      providerLabel: "OpenAI",
      modelId: "gpt-test",
      displayName: "GPT Test",
      description: "",
      inputModalities: ["text"],
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "高" }],
      defaultReasoningEffort: "high",
      contextWindow: 200_000,
      maxContextWindow: null,
      supportsFastMode: false,
      supports1MContext: false,
      isDefault: true,
      sortOrder: 1,
      runtimeProfileId: "native",
      transportModelId: null,
      fastTaskModelId: null,
      subagentModelId: null,
    },
  ],
});
test.after(() => resetEngineModelCatalogRuntimeForTest());

/** 使用迁移后的工作区 DB 和 API 分发；仅替换不调用真实 AI 的引擎 session。 */
function setupHarness(options: { ordinary?: boolean; staleDynamicBinding?: boolean; knowledgeEnabled?: boolean; toolTransport?: "native-dynamic" | "protocol"; validateEvidence?: boolean } = {}) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-knowledge-handler-"));
  const application = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  application.workspaces.upsert({ id: WORKSPACE_ID, title: "项目知识接入测试", path: workspacePath });
  const db = application.forWorkspace(WORKSPACE_ID);
  db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, title: options.ordinary ? "普通研发会话" : "独立知识会话", engine: "codex", prefs: { model: "gpt-test", effort: "high", knowledgeEnabled: options.ordinary && options.knowledgeEnabled !== false }, ...(options.ordinary ? {} : { threadSubtype: "knowledge-conversation" as const }) });
  if (!options.ordinary) db.db.prepare("INSERT INTO knowledge_conversations (thread_id, node_id, created_by_user_id) VALUES (?, NULL, ?)").run(THREAD_ID, ACTOR.userId);
  const store = new KnowledgeAssetStore(workspacePath);
  if (options.ordinary) {
    store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "feature", parentId: null, title: "原有功能", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
    store.saveDocument({ nodeId: "feature", content: "# 原有文档", sources: [], expectedHash: null, origin: "manual" });
  }
  const sent: ClientToServerMessage[] = [];
  const engineInputs: SendMessageInput[] = [];
  const transportRequirements: SendMessageInput["platformToolTransportRequirement"][] = [];
  const sessionThreadIds: ThreadId[] = [];
  let seq = 0;
  let activeTurnId: TurnId | null = null;
  let toolResult: unknown;
  let sendCount = 0;
  let bindingResets = 0;

  const session = {
    engine: "codex", workspaceId: WORKSPACE_ID, threadId: THREAD_ID,
    getSessionId() { return "existing-provider-session"; },
    hasActiveTurn() { return activeTurnId !== null; },
    getActiveTurnId() { return activeTurnId; },
    resolvePlatformToolTransport(_registry: SendMessageInput["toolRegistry"], requirement: SendMessageInput["platformToolTransportRequirement"]) {
      transportRequirements.push(requirement);
      return options.toolTransport ?? "native-dynamic";
    },
    async prepareAssistantTerminalEvents() { return { events: [], latestAssistantText: null }; },
    async sendMessage(input: SendMessageInput, emitters: ThreadEventEmitters) {
      sendCount += 1;
      engineInputs.push(input);
      activeTurnId = input.turnId;
      if (options.staleDynamicBinding && sendCount === 1) {
        activeTurnId = null;
        throw Object.assign(new Error("动态工具绑定不一致"), { code: "codex_thread_capability_incompatible" });
      }
      if (!options.ordinary || options.knowledgeEnabled !== false) {
        assert.ok(input.executeHostTool, "知识写工具必须走真实 host tool 执行入口");
        toolResult = await input.executeHostTool({
          toolId: (options.ordinary ? "knowledge.change.propose" : "knowledge.plan.submit") as any,
          accessMode: input.accessMode ?? "current",
          toolInput: options.ordinary ? { nodeId: "feature", expectedHash: store.currentHash("feature"), content: "# 修改建议", summary: "补充已确认需求", sources: [{ kind: "requirement", requirement: "用户确认的功能补充", relation: "用户要求" }] } : { nodes: [{ id: "features", parentId: "knowledge-architecture", title: "业务功能", orderKey: "01", summary: "项目功能说明", tags: [], instructions: "按页面和按钮整理", sourceScope: [] }], rationale: "根据当前项目和用户要求整理目录", gaps: [] },
        });
      }
      if (options.validateEvidence) {
        const eventBase = { ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex" } as const;
        emitters.conversation({ ...eventBase, type: "item.tool.started", payload: { itemId: "run-real-boundary", toolName: "commandExecution", input: { command: "node --test" } } } as ConversationEventInput);
        emitters.conversation({ ...eventBase, type: "item.tool.completed", payload: { itemId: "run-real-boundary", toolName: "commandExecution", status: "failed", output: { exitCode: 1, stdout: "expected no write after failure" } } } as ConversationEventInput);
        toolResult = await input.executeHostTool!({ toolId: "knowledge.acceptance.record" as any, accessMode: input.accessMode ?? "current", toolInput: {
          checks: [{ nodeId: null, requirement: "失败时停止后续写入", method: "失败分支测试", evidenceItemIds: ["run-real-boundary"] }],
        } });
      }
      emitters.raw({ ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex", source: "codex.app-server.msg", data: { method: "item/tool/completed", params: { turnId: input.turnId, toolName: "knowledge.plan.submit" } }, handled: true, action: "mapped", emittedTypes: [] });
      emitters.conversation({ ts: Date.now(), workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex", type: "item.agentMessage.completed", payload: { turnId: input.turnId, itemId: input.assistantItemId, engineMessageId: "provider-agent-result", text: "目录计划已提交，请在知识页采用。", revision: 1 } } as ConversationEventInput);
      activeTurnId = null;
      return { responseText: "目录计划已提交，请在知识页采用。" };
    },
    resetDynamicToolBinding() {
      bindingResets += 1;
      return true;
    },
  };
  const ctx = {
    db, workspaces: new Map([[WORKSPACE_ID, workspacePath]]), clientId: "client-test", threads: new ThreadStore(),
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    sessions: {
      beginThreadOperation() { return () => {}; },
      getOrCreate(runtime: { threadId: ThreadId }) { sessionThreadIds.push(runtime.threadId); return session; },
      hasActiveTurn() { return session.hasActiveTurn(); },
      getActiveTurnId() { return session.getActiveTurnId(); },
    },
    orchEngine: {
      /** 替身没有工作区状态，按生产接口返回同一引擎。 */
      forWorkspace() { return this; },
      buildManagedServiceToolRegistry() { return null; },
    },
    send(message: ClientToServerMessage) {
      sent.push(message);
      if (message.t === "raw.event") db.rawEvents.appendEnvelope({ ...message.event, schema: 1, seq: ++seq } as any);
    },
    onBeforeEmitConversationEvent(event: ConversationEventInput) {
      const envelope = { ...event, schema: 1, seq: ++seq };
      db.conversationEvents.appendEnvelope(envelope as any);
      const turnId = (event.payload as { turnId?: TurnId }).turnId;
      if (event.type === "turn.started" && turnId && !db.turns.get(turnId)) {
        db.turns.insertStarted({ workspaceId: WORKSPACE_ID, threadId: THREAD_ID, engine: "codex", turnId, startedAt: event.ts, startEventSeq: envelope.seq });
      }
      if ((event.type === "turn.completed" || event.type === "turn.error") && turnId) {
        db.turns.setEnded(turnId, { status: event.type === "turn.completed" ? "completed" : "error", endedAt: event.ts, endEventSeq: envelope.seq });
      }
    },
  } as unknown as ApiHandlerContext;

  async function request(id: string, method: string, body: Record<string, unknown>) {
    await handleApiRequest(ctx, { t: "api.req", id, method, path: `/${method.replaceAll(".", "/")}`, body } as ApiRequestMessage);
    return sent.find(message => message.t === "api.res" && message.id === id) as Extract<ClientToServerMessage, { t: "api.res" }> | undefined;
  }
  async function bind() {
    const response = await request("bind-knowledge", "knowledge.assets.conversation.connect", { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, actorContext: ACTOR });
    assert.equal(response?.status, 200, JSON.stringify(response?.body));
  }
  async function waitTerminal(turnId: TurnId) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const turn = db.turns.get(turnId);
      if (turn && turn.status !== "started") {
        await new Promise(resolve => setTimeout(resolve, 0));
        return turn;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`普通会话 ${turnId} 未产生终态`);
  }
  return { ctx, db, store, sent, engineInputs, transportRequirements, sessionThreadIds, workspacePath, request, bind, waitTerminal,
    get sendCount() { return sendCount; },
    get bindingResets() { return bindingResets; },
    get toolResult() { return toolResult; },
    /** 应用入口统一关闭已打开的工作区库。 */
    cleanup() { application.close(); fs.rmSync(workspacePath, { recursive: true, force: true }); },
  };
}

test("知识导入 API 缺省或空目录均读取项目根，指定缺失目录仍返回可定位的失败", async () => {
  const h = setupHarness();
  try {
    fs.writeFileSync(path.join(h.workspacePath, "README.md"), "# 项目说明\n", "utf8");
    for (const [index, directory] of [undefined, ""].entries()) {
      const response = await h.request(`import-root-${index}`, "knowledge.assets.imports", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, directory });
      assert.equal(response?.status, 200, JSON.stringify(response?.body));
      const body = response?.body as { ok: boolean; data: { files: Array<{ path: string }> } };
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.files.map(file => file.path), ["README.md"]);
    }
    assert.equal(fs.existsSync(path.join(h.workspacePath, "codeflow-docs")), false);
    const response = await h.request("import-missing", "knowledge.assets.imports", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, directory: "codeflow-docs" });
    assert.equal(response?.status, 404);
    const failure = response?.body as { ok: boolean; code: string; message: string; details: { requestId: string; operation: string } };
    assert.equal(failure.ok, false);
    assert.equal(failure.code, "KNOWLEDGE_ASSET_NOT_FOUND");
    assert.equal(failure.details.requestId, "import-missing");
    assert.equal(failure.details.operation, "imports");
    assert.doesNotMatch(failure.message, /knowledge\.source/u);
  } finally { h.cleanup(); }
});

test("普通会话提案立即可审批且正常完成回合，人工审核通过真实 Client API 更新正式知识", async () => {
  const h = setupHarness({ ordinary: true });
  try {
    const turnId = "turn-ordinary-proposal" as TurnId;
    const sent = await h.request("send-proposal", "threads.sendMessage", {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId, text: "请补充已确认需求并提交知识修改建议", inputKind: "message", model: "gpt-test", effort: "high", accessMode: "full-access",
      knowledgeConversationActorContext: { userId: ACTOR.userId, permissionScope: ACTOR.permissionScope },
    });
    assert.equal(sent?.status, 200);
    assert.equal((await h.waitTerminal(turnId)).status, "completed");
    assert.deepEqual(h.transportRequirements, ["required"]);
    assert.equal(h.engineInputs[0]!.platformToolTransportRequirement, "required");
    assert.match(h.engineInputs[0]!.systemMessage ?? "", /knowledge\.tree\.read/);
    for (const toolId of ["knowledge.tree.read", "knowledge.node.read", "knowledge.search", "knowledge.source.list", "knowledge.source.read", "knowledge.change.propose"]) {
      assert.ok(h.engineInputs[0]!.toolRegistry?.tools.some(tool => tool.toolId === toolId), `${toolId} 必须真实注册`);
    }
    assert.equal(h.engineInputs[0]!.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.asset.submit"), false);
    assert.equal((h.toolResult as { ok?: boolean })?.ok, true);
    assert.equal(h.store.detail("feature").current?.content, "# 原有文档");
    const listing = await h.request("changes", "knowledge.assets.changes", { workspaceId: WORKSPACE_ID, actorContext: ACTOR });
    assert.equal(listing?.status, 200);
    const list = (listing?.body as any).data.items;
    assert.equal(list.length, 1);
    const loaded = await h.request("change", "knowledge.assets.change", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, changeId: list[0].id });
    const proposal = (loaded?.body as any).data;
    assert.equal(proposal.status, "pending");
    const denied = await h.request("review-denied", "knowledge.assets.change.review", { workspaceId: WORKSPACE_ID, actorContext: { ...ACTOR, permissionScope: "shared_member" }, changeId: proposal.id, expectedHash: proposal.hash, decision: "approve" });
    assert.equal(denied?.status, 403);
    const reviewed = await h.request("review", "knowledge.assets.change.review", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, changeId: proposal.id, expectedHash: proposal.hash, decision: "approve", note: "" });
    assert.equal(reviewed?.status, 200);
    assert.equal(h.store.detail("feature").current?.content, "# 修改建议");
    // 提交结果提示已改为「文档修改建议」并附待确认更新入口。
    assert.ok(h.sent.some(event => event.t === "conversation.event" && event.event.type === "item.agentMessage.completed" && event.event.payload.text.includes("本轮已提交 1 项文档修改建议")));
    assert.equal(h.sent.some(event => event.t === "conversation.event" && String(event.event.type) === "approval.requested"), false);
  } finally { h.cleanup(); }
});

test("普通发送链记录实际规格并从引擎事件核定失败证据，不接受模型自述通过", async () => {
  const h = setupHarness({ ordinary: true, validateEvidence: true });
  try {
    const turnId = "turn-specification-evidence" as TurnId;
    const response = await h.request("send-evidence", "threads.sendMessage", { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId,
      text: "失败时停止后续写入", inputKind: "message", model: "gpt-test", effort: "high", accessMode: "full-access",
      knowledgeConversationActorContext: { userId: ACTOR.userId, permissionScope: ACTOR.permissionScope },
    });
    assert.equal(response?.status, 200);
    assert.equal((await h.waitTerminal(turnId)).status, "completed");
    assert.ok(h.engineInputs[0]?.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.acceptance.record"));
    const record = h.toolResult as { ok: boolean; output: { checks: Array<{ status: string }>; acceptance: string } };
    assert.equal(record.ok, true);
    assert.equal(record.output.checks[0]?.status, "failed");
    assert.equal(record.output.acceptance, "needs_review");
    assert.ok(h.sent.some(message => message.t === "conversation.event" && message.event.type === "item.tool.completed" && message.event.payload.toolName === "项目规格已提供"));
    assert.ok(h.sent.some(message => message.t === "conversation.event" && message.event.type === "item.tool.completed" && message.event.payload.toolName === "规格验证依据"));
    const continuedTurnId = "turn-specification-evidence-continued" as TurnId;
    const continued = await h.request("continue-evidence", "threads.sendMessage", { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: continuedTurnId,
      text: "继续", inputKind: "message", model: "gpt-test", effort: "high", accessMode: "full-access",
      knowledgeConversationActorContext: { userId: ACTOR.userId, permissionScope: ACTOR.permissionScope },
    });
    assert.equal(continued?.status, 200);
    assert.equal((await h.waitTerminal(continuedTurnId)).status, "completed");
    assert.equal((h.toolResult as typeof record).ok, true);
    assert.equal((h.toolResult as typeof record).output.checks[0]?.status, "failed");
  } finally { h.cleanup(); }
});

test("普通会话开启知识库但工具传输不可用时明确失败，不发送仅有提示词的回合", async () => {
  const h = setupHarness({ ordinary: true, toolTransport: "protocol" });
  const turnId = "turn-ordinary-knowledge-unavailable" as TurnId;
  try {
    await h.request("send-unavailable", "threads.sendMessage", {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId, text: "查询项目知识", inputKind: "message", model: "gpt-test", effort: "high",
    });
    assert.equal((await h.waitTerminal(turnId)).status, "error");
    assert.deepEqual(h.transportRequirements, ["required"]);
    assert.equal(h.engineInputs.length, 0);
    const errors = h.db.conversationEvents.listByThread(THREAD_ID).filter(event => event.type === "turn.error");
    assert.equal(errors.length, 1);
    assert.equal((errors[0]!.payload as { code?: string }).code, "KNOWLEDGE_TOOL_TRANSPORT_UNAVAILABLE");
    assert.equal(new KnowledgeChangeStore(h.store).list().items.length, 0);
  } finally { h.cleanup(); }
});

test("普通旧 Codex 会话缺少知识工具时提示新建会话，保留绑定且不旋转重发", async () => {
  const h = setupHarness({ ordinary: true, staleDynamicBinding: true });
  const turnId = "turn-ordinary-knowledge-stale-binding" as TurnId;
  try {
    await h.request("send-stale", "threads.sendMessage", {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId, text: "查询项目知识", inputKind: "message", model: "gpt-test", effort: "high",
    });
    assert.equal((await h.waitTerminal(turnId)).status, "error");
    assert.equal(h.sendCount, 1);
    assert.equal(h.bindingResets, 0);
    const errors = h.db.conversationEvents.listByThread(THREAD_ID).filter(event => event.type === "turn.error");
    assert.equal(errors.length, 1);
    const error = errors[0]!.payload as { code?: string; error?: string; providerThreadId?: string; preserveBinding?: boolean };
    assert.equal(error.code, "KNOWLEDGE_TOOLS_REQUIRE_NEW_SESSION");
    assert.match(error.error ?? "", /请新建会话后重试/);
    assert.equal(error.providerThreadId, "existing-provider-session");
    assert.equal(error.preserveBinding, true);
    assert.equal(new KnowledgeChangeStore(h.store).list().items.length, 0);
  } finally { h.cleanup(); }
});

test("普通会话关闭知识库时不注入知识提示词或工具，不要求动态注册", async () => {
  const h = setupHarness({ ordinary: true, knowledgeEnabled: false, toolTransport: "protocol" });
  const turnId = "turn-ordinary-knowledge-disabled" as TurnId;
  try {
    await h.request("send-disabled", "threads.sendMessage", {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId, text: "继续开发", inputKind: "message", model: "gpt-test", effort: "high",
    });
    assert.equal((await h.waitTerminal(turnId)).status, "completed");
    assert.deepEqual(h.transportRequirements, ["optional"]);
    assert.equal(h.engineInputs[0]!.platformToolTransportRequirement, "optional");
    assert.doesNotMatch(h.engineInputs[0]!.systemMessage ?? "", /knowledge\.tree\.read/);
    assert.equal(h.engineInputs[0]!.toolRegistry, null);
  } finally { h.cleanup(); }
});

test("独立知识会话通过普通发送链调用真实工具并保留 canonical/raw 事件", async () => {
  const harness = setupHarness();
  const turnId = "turn-knowledge-independent-chat" as TurnId;
  try {
    await harness.bind();
    const response = await harness.request("send-knowledge", "threads.sendMessage", {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId, text: "根据项目规划知识目录", inputKind: "message", model: "gpt-test", effort: "high", accessMode: "full-access",
      knowledgeConversationActorContext: { userId: ACTOR.userId, permissionScope: ACTOR.permissionScope },
    });
    assert.equal(response?.status, 200);
    const terminal = await harness.waitTerminal(turnId);
    assert.equal(terminal.status, "completed");
    assert.equal(harness.engineInputs.length, 1);
    const input = harness.engineInputs[0]!;
    assert.equal(input.accessMode, "read-only");
    assert.equal(input.providerNativeToolPolicy, "allow");
    assert.equal(input.platformToolTransportRequirement, "required");
    assert.equal("allowDynamicToolMigration" in input, false);
    assert.deepEqual(input.requiredWorkspaceSkills, []);
    assert.ok(input.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.plan.submit"));
    assert.ok(input.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.asset.submit"));
    assert.match(input.developerMessage ?? "", /正常回答、澄清和连续调整/);
    assert.ok(harness.sessionThreadIds.every(id => id === THREAD_ID));
    assert.deepEqual(harness.db.threads.listByWorkspace(WORKSPACE_ID).threads.map(thread => thread.id), [THREAD_ID]);
    assert.equal((harness.toolResult as { ok?: boolean })?.ok, true);
    const runs = harness.store.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.threadId, THREAD_ID);
    assert.equal(runs[0]!.phase, "planned");
    assert.equal(runs[0]!.proposedTree?.nodes.find(node => node.id === "features")?.title, "业务功能");
    assert.ok(fs.existsSync(path.join(harness.workspacePath, "codeflow-docs", "规格知识库", "runs", runs[0]!.id, "plan.json")));
    // 读取时会补齐八份默认规格文档，这里比较的是补齐后的默认导航。
    assert.deepEqual(harness.store.readTree().tree.nodes, withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }).nodes, "工具提交后仅默认导航可见，候选仍需用户采用");
    assert.equal(harness.store.readTree().hash, null);
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.ok(events.some(event => event.type === "item.agentMessage.completed"));
    assert.equal(events.filter(event => event.type === "turn.completed").length, 1);
    assert.ok(harness.sent.some(message => message.t === "raw.event" && message.event.threadId === THREAD_ID));
    assert.equal(harness.db.rawEvents.listByThreadFromSeq(THREAD_ID, { fromSeqInclusive: 0 }).length, 1);
  } finally { harness.cleanup(); }
});

test("独立知识会话遇到旧 Codex dynamic tool binding 时只旋转一次并重发当前回合", async () => {
  const harness = setupHarness({ staleDynamicBinding: true });
  const turnId = "turn-knowledge-binding-rotation" as TurnId;
  try {
    await harness.bind();
    const response = await harness.request("send-binding-rotation", "threads.sendMessage", {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId, text: "继续维护知识目录", inputKind: "message", model: "gpt-test", effort: "high", accessMode: "full-access",
      knowledgeConversationActorContext: { userId: ACTOR.userId, permissionScope: ACTOR.permissionScope },
    });
    assert.equal(response?.status, 200);
    assert.equal((await harness.waitTerminal(turnId)).status, "completed");
    assert.equal(harness.sendCount, 2);
    assert.equal(harness.bindingResets, 1);
    assert.equal((harness.toolResult as { ok?: boolean })?.ok, true);
  } finally { harness.cleanup(); }
});

test("独立知识会话缺少本轮可信账号时拒绝知识写入并发出终态", async () => {
  const harness = setupHarness();
  const turnId = "turn-knowledge-untrusted" as TurnId;
  try {
    await harness.bind();
    await harness.request("send-untrusted", "threads.sendMessage", { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId, text: "生成目录" });
    const terminal = await harness.waitTerminal(turnId);
    assert.equal(terminal.status, "error");
    assert.equal(harness.engineInputs.length, 0, "权限失败不能调用 provider");
    assert.equal(harness.store.listRuns().length, 0);
    const errors = harness.db.conversationEvents.listByThread(THREAD_ID).filter(event => event.type === "turn.error");
    assert.equal(errors.length, 1);
    assert.equal((errors[0]!.payload as { code?: string }).code, "KNOWLEDGE_ASSET_PERMISSION_DENIED");
    assert.deepEqual(harness.db.threads.listByWorkspace(WORKSPACE_ID).threads.map(thread => thread.id), [THREAD_ID]);
  } finally { harness.cleanup(); }
});

test("独立知识会话创建、列表、结束和重新连接通过真实Client handler", async () => {
  const harness = setupHarness();
  try {
    const base = { workspaceId: WORKSPACE_ID, actorContext: ACTOR };
    const created = await harness.request("create-new", "knowledge.assets.conversation.create", { ...base, nodeId: null, engine: "claude" });
    assert.equal(created?.status, 200, JSON.stringify(created?.body));
    const threadId = (created!.body as any).data.threadId as ThreadId;
    assert.notEqual(threadId, THREAD_ID);
    assert.equal(harness.db.threads.get(threadId)?.threadSubtype, "knowledge-conversation");
    const list = await harness.request("list-new", "knowledge.assets.conversation.list", base);
    assert.equal((list!.body as any).data.length, 2);
    const end = await harness.request("end-new", "knowledge.assets.conversation.end", { ...base, threadId });
    assert.equal(end?.status, 200, JSON.stringify(end?.body));
    assert.equal((end!.body as any).data.active, false);
    const connected = await harness.request("connect-new", "knowledge.assets.conversation.connect", { ...base, threadId });
    assert.equal(connected?.status, 200, JSON.stringify(connected?.body));
    assert.equal((connected!.body as any).data.active, true);
    assert.ok(harness.db.threads.get(threadId));
  } finally { harness.cleanup(); }
});

test("共享批任务缺少当次Server归属授权时拒绝，停止不能覆盖已存owner", async () => {
  const harness = setupHarness();
  try {
    const sharedThreadAcl = { sharedWorkspaceId: "shared-a", ownerUserId: ACTOR.userId, visibility: "private" as const, participantUserIds: [], updatedAt: Date.now() };
    harness.db.threads.setSharedAcl(THREAD_ID, sharedThreadAcl);
    const tree = harness.store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "a", parentId: null, title: "资产", orderKey: "1", instructions: "", summary: "", tags: [], sourceScope: [] }] }, null);
    const base = { workspaceId: WORKSPACE_ID, sharedWorkspaceId: "shared-a", actorContext: { ...ACTOR, permissionScope: "shared_asset_admin" } };
    const generate = { ...base, requestId: "shared-batch", mode: "batch", ownerThreadId: THREAD_ID, selectedNodeIds: ["a"], includeDescendants: false, strategy: "missing", prompt: "", treeHash: tree.hash, engine: "codex" };
    const missing = await harness.request("generate-missing-auth", "knowledge.assets.generate", generate);
    assert.equal(missing?.status, 403);
    const created = await harness.request("generate-authorized", "knowledge.assets.generate", { ...generate, verifiedOwnerThreadId: THREAD_ID, sharedThreadAcl });
    assert.equal(created?.status, 200, JSON.stringify(created?.body));
    const runId = (created!.body as any).data.id;
    const spoofed = await harness.request("stop-spoofed-owner", "knowledge.assets.run.stop", { ...base, runId, verifiedOwnerThreadId: "other-thread", sharedThreadAcl });
    assert.equal(spoofed?.status, 403);
    const stopped = await harness.request("stop-authorized", "knowledge.assets.run.stop", { ...base, runId, verifiedOwnerThreadId: THREAD_ID, sharedThreadAcl });
    assert.equal(stopped?.status, 200, JSON.stringify(stopped?.body));
  } finally { harness.cleanup(); }
});

test("复检报告读取允许项目只读成员，仍要求可信身份与可访问工作区", async () => {
  const harness = setupHarness();
  try {
    harness.store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "a", parentId: null, title: "资产", orderKey: "1", instructions: "", summary: "", tags: [], sourceScope: [] }] }, null);
    const base = { workspaceId: WORKSPACE_ID, nodeId: "a", actorContext: { ...ACTOR, permissionScope: "shared_member" } };
    const read = await harness.request("read-reviews", "knowledge.assets.reviews", base);
    assert.equal(read?.status, 200, JSON.stringify(read?.body));
    assert.deepEqual((read!.body as any).data, []);
    const untrusted = await harness.request("read-reviews-untrusted", "knowledge.assets.reviews", { ...base, actorContext: undefined });
    assert.equal(untrusted?.status, 403);
    const missingWorkspace = await harness.request("read-reviews-elsewhere", "knowledge.assets.reviews", { ...base, workspaceId: "other-workspace" });
    assert.equal(missingWorkspace?.status, 404);
    const forbidden = await harness.request("read-member-cannot-review", "knowledge.assets.generate", { ...base, mode: "review" });
    assert.equal(forbidden?.status, 403);
    assert.equal(harness.engineInputs.length, 0);
  } finally { harness.cleanup(); }
});

test("Client generate 与 run.start 传递完整复检配置与指定修复报告", async t => {
  const harness = setupHarness();
  const begins: unknown[] = [], starts: unknown[] = [];
  t.mock.method(KnowledgeGenerationService.prototype, "begin", function (input: unknown) { begins.push(input); return { id: "r" }; });
  t.mock.method(KnowledgeGenerationService.prototype, "startAsync", function (runId: string, input: unknown) { starts.push({ runId, input }); return { id: runId }; });
  try {
    const reviewConfig = { enabled: true, model: "gpt-5.6-sol", effort: "xhigh" };
    const repairReports = [{ nodeId: "a", reportId: "review_a" }];
    const generate = { requestId: "review-handler", mode: "review", ownerThreadId: THREAD_ID, selectedNodeIds: ["a"], includeDescendants: false, strategy: "all", prompt: "复核", treeHash: null, engine: "codex", model: null, effort: null, reviewConfig, repairReports };
    const created = await harness.request("generate-review", "knowledge.assets.generate", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, ...generate });
    assert.equal(created?.status, 200, JSON.stringify(created?.body));
    assert.deepEqual(begins, [generate]);
    const started = await harness.request("start-review", "knowledge.assets.run.start", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, runId: "r", retryFailed: true, reviewConfig });
    assert.equal(started?.status, 200, JSON.stringify(started?.body));
    assert.deepEqual(starts, [{ runId: "r", input: { retryFailed: true, nodeIds: undefined, prompt: undefined, model: undefined, effort: undefined, reviewConfig } }]);
    assert.equal(harness.engineInputs.length, 0);
  } finally { harness.cleanup(); }
});

test("共享独立复检必须携带当轮已核验归属授权", async t => {
  const harness = setupHarness();
  const begins: unknown[] = [];
  t.mock.method(KnowledgeGenerationService.prototype, "begin", function (input: unknown) { begins.push(input); return { id: "review-r" }; });
  try {
    const sharedThreadAcl = { sharedWorkspaceId: "shared-a", ownerUserId: ACTOR.userId, visibility: "private" as const, participantUserIds: [], updatedAt: Date.now() };
    harness.db.threads.setSharedAcl(THREAD_ID, sharedThreadAcl);
    const request = { workspaceId: WORKSPACE_ID, sharedWorkspaceId: "shared-a", actorContext: { ...ACTOR, permissionScope: "shared_asset_admin" }, requestId: "shared-review", mode: "review", ownerThreadId: THREAD_ID, selectedNodeIds: ["a"], includeDescendants: false, strategy: "all", prompt: "", treeHash: null, engine: "codex" };
    const missing = await harness.request("review-missing-auth", "knowledge.assets.generate", request);
    assert.equal(missing?.status, 403);
    const spoofed = await harness.request("review-spoofed-auth", "knowledge.assets.generate", { ...request, verifiedOwnerThreadId: "someone-else", sharedThreadAcl });
    assert.equal(spoofed?.status, 403);
    assert.equal(begins.length, 0);
    const authorized = await harness.request("review-authorized", "knowledge.assets.generate", { ...request, verifiedOwnerThreadId: THREAD_ID, sharedThreadAcl });
    assert.equal(authorized?.status, 200, JSON.stringify(authorized?.body));
    assert.equal(begins.length, 1);
  } finally { harness.cleanup(); }
});

test("结束知识协作停止该会话全部生成和复检任务，保留其他会话任务", async t => {
  const harness = setupHarness(), stopped: string[] = [];
  t.mock.method(KnowledgeGenerationService.prototype, "list", function () {
    return [
      { id: "batch-owned", ownerThreadId: THREAD_ID, mode: "batch", active: true },
      { id: "review-owned", ownerThreadId: THREAD_ID, mode: "review", active: true },
      { id: "build-owned", ownerThreadId: THREAD_ID, mode: "build", active: true },
      { id: "review-finished", ownerThreadId: THREAD_ID, mode: "review", active: false },
      { id: "review-other", ownerThreadId: "another-owner", mode: "review", active: true },
    ];
  });
  t.mock.method(KnowledgeGenerationService.prototype, "stop", function (runId: string) { stopped.push(runId); return { id: runId }; });
  try {
    const end = await harness.request("end-with-reviews", "knowledge.assets.conversation.end", { workspaceId: WORKSPACE_ID, actorContext: ACTOR, threadId: THREAD_ID });
    assert.equal(end?.status, 200, JSON.stringify(end?.body));
    assert.deepEqual(stopped, ["batch-owned", "review-owned", "build-owned"]);
    assert.equal((end!.body as any).data.active, false);
  } finally { harness.cleanup(); }
});

test("项目候选不依赖本机原会话，预览和采用不恢复聊天权限", async () => {
  const harness = setupHarness();
  try {
    const base = { workspaceId: WORKSPACE_ID, actorContext: ACTOR };
    const node = { id: "candidate", parentId: null, title: "待采用", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] };
    const service = new KnowledgeGenerationService(harness.store, WORKSPACE_ID, async () => { throw new Error("预览不得启动引擎"); }, "candidate-read", () => ({ nodeId: null, activationVersion: 1 }), harness.db);
    const generated = service.begin({ requestId: "candidate-read", mode: "build", ownerThreadId: THREAD_ID, selectedNodeIds: [], includeDescendants: true, strategy: "missing", prompt: "", treeHash: null, engine: "codex", model: null, effort: null, reviewConfig: { enabled: false, model: null, effort: null } });
    const run = harness.store.readRun(generated.id);
    run.proposedTree = { schemaVersion: 2, instructions: "", nodes: [node] };
    run.phase = "planned";
    harness.store.saveRun(run);
    const revision = harness.store.forRun(run.id).saveDocument({ nodeId: node.id, content: "候选正文", sources: [], expectedHash: null, origin: "ai", adopt: false });
    run.items = [{ id: "candidate-item", nodeId: node.id, title: node.title, instructions: "", inheritedInstructions: "", expectedHash: null, status: "completed", revisionId: revision.id, error: null }];
    run.phase = "completed";
    harness.store.saveRun(run);
    harness.db.db.prepare("UPDATE knowledge_conversations SET active = 0 WHERE thread_id = ?").run(THREAD_ID);
    const candidate = await harness.request("read-own-candidate", "knowledge.assets.node", { ...base, runId: run.id, nodeId: node.id });
    assert.equal(candidate?.status, 200, JSON.stringify(candidate?.body));
    assert.equal((candidate!.body as any).data.node.title, node.title);
    const preview = await harness.request("preview-own-inactive", "knowledge.assets.run.preview", { ...base, runId: run.id });
    assert.equal(preview?.status, 200, JSON.stringify(preview?.body));
    const readRevision = await harness.request("read-own-candidate-revision", "knowledge.assets.revision", { ...base, runId: run.id, nodeId: node.id, revisionId: revision.id });
    assert.equal(readRevision?.status, 200, JSON.stringify(readRevision?.body));
    assert.equal((readRevision!.body as any).data.content, "候选正文");
    const ordinary = await harness.request("read-formal-candidate", "knowledge.assets.node", { ...base, nodeId: node.id });
    assert.equal(ordinary?.status, 404);
    harness.db.db.prepare("DELETE FROM knowledge_conversations WHERE thread_id = ?").run(THREAD_ID);
    for (const action of ["node", "revision", "reviews", "run.preview"]) {
      const readable = await harness.request(`read-other-${action}`, `knowledge.assets.${action}`, { ...base, actorContext: { ...ACTOR, userId: "other-user" }, runId: run.id, nodeId: node.id, revisionId: revision.id });
      assert.equal(readable?.status, 200, JSON.stringify(readable?.body));
    }
    assert.equal(harness.store.readTree().hash, null);
    const previewData = service.preview(run.id);
    const readonly = await harness.request("adopt-readonly", "knowledge.assets.run.apply", { ...base, actorContext: { ...ACTOR, permissionScope: "shared_member" }, runId: run.id, requestId: "adopt-candidate", treeHash: previewData.treeHash, planHash: previewData.planHash, selections: [{ nodeId: node.id, revisionId: revision.id }] });
    assert.equal(readonly?.status, 403);
    assert.equal(harness.store.readTree().hash, null);
    const adopted = await harness.request("adopt-without-owner", "knowledge.assets.run.apply", { ...base, runId: run.id, requestId: "adopt-candidate", treeHash: previewData.treeHash, planHash: previewData.planHash, selections: [{ nodeId: node.id, revisionId: revision.id }] });
    assert.equal(adopted?.status, 200, JSON.stringify(adopted?.body));
    assert.equal(harness.store.detail(node.id).current?.revision.id, revision.id);
    const connect = await harness.request("connect-missing-owner", "knowledge.assets.conversation.connect", { ...base, threadId: THREAD_ID });
    assert.equal(connect?.status, 403);
    const resume = await harness.request("resume-missing-owner", "knowledge.assets.run.start", { ...base, runId: run.id });
    assert.equal(resume?.status, 403);
    assert.equal((harness.db.db.prepare("SELECT count(*) AS n FROM knowledge_conversations").get() as { n: number }).n, 0);
    assert.equal(harness.engineInputs.length, 0);
  } finally { harness.cleanup(); }
});

test("终止采用只需共享项目维护权，只读成员不能修改回执", async () => {
  const harness = setupHarness();
  try {
    const service = new KnowledgeGenerationService(harness.store, WORKSPACE_ID, async () => {}, "cancel-handler", () => ({ nodeId: null, activationVersion: 1 }), harness.db);
    const generated = service.begin({ requestId: "cancel-handler", mode: "build", ownerThreadId: THREAD_ID, selectedNodeIds: [], includeDescendants: true, strategy: "all", prompt: "", treeHash: null, engine: "codex", reviewConfig: { enabled: false, model: null, effort: null } });
    const run = harness.store.readRun(generated.id);
    const directory = { id: "directory", parentId: null, title: "目录", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [], contentMode: "directory" as const };
    run.proposedTree = { schemaVersion: 2, instructions: "", nodes: [directory] };
    run.phase = "completed";
    run.adoptions = [{ requestId: "original-adoption", treeHash: null, planHash: "a".repeat(64), selections: [{ nodeId: directory.id, revisionId: null }], targetTree: run.proposedTree, targetTreeHash: "b".repeat(64), completed: false, error: { code: "IO_FAILED", message: "写入失败" } }];
    harness.store.saveRun(run);
    const sharedThreadAcl = { sharedWorkspaceId: "shared-a", ownerUserId: ACTOR.userId, visibility: "private" as const, participantUserIds: [], updatedAt: Date.now() };
    harness.db.threads.setSharedAcl(THREAD_ID, sharedThreadAcl);
    const base = { workspaceId: WORKSPACE_ID, sharedWorkspaceId: "shared-a", actorContext: { ...ACTOR, permissionScope: "shared_asset_admin" }, runId: run.id, requestId: "original-adoption" };
    const reader = await harness.request("cancel-readonly", "knowledge.assets.run.cancelAdoption", { ...base, actorContext: { ...base.actorContext, permissionScope: "shared_member" } });
    assert.equal(reader?.status, 403);
    assert.equal(harness.store.readRun(run.id).adoptions?.[0]?.cancelled, undefined);
    const cancelled = await harness.request("cancel-authorized", "knowledge.assets.run.cancelAdoption", { ...base, actorContext: { ...base.actorContext, userId: "another-maintainer" } });
    assert.equal(cancelled?.status, 200, JSON.stringify(cancelled?.body));
    assert.equal((cancelled!.body as any).data.adoptions[0].cancelled, true);
    assert.equal((cancelled!.body as any).data.adoptions[0].completed, false);
    assert.equal(harness.store.readTree().hash, null);
    assert.equal(harness.engineInputs.length, 0);
  } finally { harness.cleanup(); }
});

test("项目候选可由共享成员读取，原会话ACL仍限制执行及聊天连接", async () => {
  const harness = setupHarness();
  try {
    const nodes = ["inside", "outside"].map(id => ({ id, parentId: null, title: id, orderKey: id, summary: "", tags: [], instructions: "", sourceScope: [] }));
    const saved = harness.store.saveTree({ schemaVersion: 1, instructions: "", nodes }, null);
    harness.db.db.prepare("UPDATE knowledge_conversations SET node_id = ? WHERE thread_id = ?").run("inside", THREAD_ID);
    const service = new KnowledgeGenerationService(harness.store, WORKSPACE_ID, async () => { throw new Error("预览不得启动引擎"); }, "scoped-read", () => ({ nodeId: "inside", activationVersion: 1 }), harness.db);
    const run = service.begin({ requestId: "scoped-read", mode: "batch", ownerThreadId: THREAD_ID, selectedNodeIds: ["inside"], includeDescendants: false, strategy: "missing", prompt: "", treeHash: saved.hash, engine: "codex", model: null, effort: null, reviewConfig: { enabled: false, model: null, effort: null } });
    const base = { workspaceId: WORKSPACE_ID, actorContext: ACTOR, runId: run.id };
    const inside = await harness.request("candidate-inside", "knowledge.assets.node", { ...base, nodeId: "inside" });
    assert.equal(inside?.status, 200, JSON.stringify(inside?.body));
    const outside = await harness.request("candidate-outside", "knowledge.assets.node", { ...base, nodeId: "outside" });
    assert.equal(outside?.status, 200);
    const sharedThreadAcl = { sharedWorkspaceId: "shared-a", ownerUserId: ACTOR.userId, visibility: "private" as const, participantUserIds: [], updatedAt: 100 };
    harness.db.threads.setSharedAcl(THREAD_ID, sharedThreadAcl);
    const shared = { ...base, sharedWorkspaceId: "shared-a", actorContext: { ...ACTOR, userId: "other-member", permissionScope: "shared_member" } };
    const missing = await harness.request("candidate-shared-missing", "knowledge.assets.node", { ...shared, nodeId: "inside" });
    assert.equal(missing?.status, 200, JSON.stringify(missing?.body));
    const allowed = await harness.request("candidate-shared-allowed", "knowledge.assets.node", { ...shared, nodeId: "inside", verifiedOwnerThreadId: THREAD_ID, sharedThreadAcl });
    assert.equal(allowed?.status, 200, JSON.stringify(allowed?.body));
    const revoked = await harness.request("candidate-shared-revoked", "knowledge.assets.node", { ...shared, nodeId: "inside", verifiedOwnerThreadId: THREAD_ID, sharedThreadAcl: { ...sharedThreadAcl, ownerUserId: "another-owner", updatedAt: 101 } });
    assert.equal(revoked?.status, 200, JSON.stringify(revoked?.body));
    assert.equal(harness.db.threads.get(THREAD_ID)?.ownerUserId, ACTOR.userId, "读取候选不接受会话 ACL 写回");
    for (const action of ["run.start", "run.stop", "conversation.connect"]) {
      const denied = await harness.request(`private-${action}`, `knowledge.assets.${action}`, { ...shared, actorContext: { ...shared.actorContext, permissionScope: "shared_asset_admin" }, threadId: THREAD_ID });
      assert.equal(denied?.status, 403, JSON.stringify(denied?.body));
    }
    const dismissed = await harness.request("dismiss-readonly", "knowledge.assets.revision.dismiss", { ...shared, nodeId: "inside", revisionId: null });
    assert.equal(dismissed?.status, 403);
  } finally { harness.cleanup(); }
});
