import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClientToServerMessage, ConversationEventInput, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";

import { handleApprovalsRespond, handleUserInputRespond } from "../src/app/handlers/interactionHandlers.ts";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.ts";
import type { SendMessageInput } from "../src/engines/threadSession.ts";
import { waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.ts";

const WORKSPACE_ID = "client-test:approval-follow-up" as WorkspaceId;
const THREAD_ID = "thread-approval-follow-up" as ThreadId;
const OLD_TURN_ID = "turn-approval-follow-up-old" as TurnId;

test("审批续跑按同步短段取得数据库许可，清理前关闭准入并排空", async () => {
  const harness = setupApprovalFollowUpHarness();
  let permitted = false, fenced = false, approvalActive = false, flushed = 0;
  harness.ctx.withDatabase = async (_requestId, operation) => {
    assert.equal(permitted, false); permitted = true;
    try { const result = operation(); assert.equal(Boolean(result && typeof (result as any).then === "function"), false); return result; }
    finally { permitted = false; }
  };
  (harness.ctx.sessions as any).beginThreadOperation = () => { approvalActive = true; return () => { approvalActive = false; }; };
  (harness.ctx.sessions as any).beginThreadDeletion = () => { assert.equal(approvalActive, false); fenced = true; return () => { fenced = false; }; };
  harness.ctx.flushLocalEvents = async () => { assert.equal(permitted, false); flushed++; };
  const originalClear = harness.db.conversationEvents.deleteByThread.bind(harness.db.conversationEvents);
  harness.db.conversationEvents.deleteByThread = threadId => {
    assert.equal(permitted, true); assert.equal(fenced, true); assert.ok(flushed > 0);
    return originalClear(threadId);
  };
  const originalPrefs = harness.db.threads.updatePrefs.bind(harness.db.threads);
  harness.db.threads.updatePrefs = (threadId, prefs) => { assert.equal(permitted, true); return originalPrefs(threadId, prefs); };
  try {
    await handleApprovalsRespond(harness.ctx, { t: "api.req", id: "approval-lease", method: "approvals.respond", path: "/test", body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, requestId: "approval", decision: "accept" } });
    assert.equal(fenced, false);
    assert.ok(flushed > 1);
    harness.completeFollowUp();
    await waitForOrdinaryTurnExecution(harness.ctx.sessions, { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: harness.followUpTurnId! });
  } finally { harness.cleanup(); }
});

/** 等待异步 follow-up 到达指定状态，超时即明确失败。 */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** 构造审批续跑的真实 SQLite 夹具，并同步模拟 canonical 事件索引。 */
function setupApprovalFollowUpHarness(options: { knowledgeEnabled?: boolean; toolTransport?: "native-dynamic" | "protocol"; staleDynamicBinding?: boolean } = {}) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-approval-follow-up-"));
  const application = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  application.workspaces.upsert({ id: WORKSPACE_ID, title: "审批续跑测试", path: workspacePath });
  const db = application.forWorkspace(WORKSPACE_ID);
  const threads = new ThreadStore();
  const sent: ClientToServerMessage[] = [];
  let seq = 100;
  let disposed = 0;
  let followUpTurnId: TurnId | null = null;
  let resolveFollowUp: ((result: { responseText: string }) => void) | null = null;
  let followUpInput: SendMessageInput | null = null;
  const transportRequirements: SendMessageInput["platformToolTransportRequirement"][] = [];
  const engine = options.staleDynamicBinding ? "codex" : "claude";

  db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, engine, title: "审批续跑", prefs: { knowledgeEnabled: options.knowledgeEnabled === true } });
  if (options.knowledgeEnabled) {
    new KnowledgeAssetStore(workspacePath).saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "feature", parentId: null, title: "已初始化知识", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  }
  db.engineCustomModels.insert({
    engine,
    providerId: engine === "codex" ? "openai" : "anthropic",
    modelId: "claude-approval-follow-up-test",
    displayName: "审批续跑测试模型",
    contextWindow: 200_000,
    supportedReasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    enabled: true,
  });
  db.threads.updatePrefs(THREAD_ID, { model: "claude-approval-follow-up-test", effort: "high" });
  db.turns.insertStarted({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine,
    turnId: OLD_TURN_ID,
    startedAt: Date.now() - 1_000,
    startEventSeq: 1,
  });
  db.conversationEvents.appendEnvelope({
    schema: 1,
    seq: 1,
    ts: Date.now() - 1_000,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine,
    type: "turn.started",
    payload: { turnId: OLD_TURN_ID },
  } as any);
  db.rawEvents.appendEnvelope({
    schema: 1,
    seq: 2,
    ts: Date.now() - 900,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine,
    source: "claude.stream-json.stdout",
    data: { type: "assistant" },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  } as any);
  threads.create({ threadId: THREAD_ID, workspaceId: WORKSPACE_ID, engine, title: "审批续跑" });

  const approvalSession = {
    async respondApproval() {
      return {
        followUp: {
          kind: "clearContextAndSend" as const,
          promptText: "继续实现",
          accessMode: "current" as const,
        },
      };
    },
  };
  const followUpSession = {
    getSessionId() { return "follow-up-provider-session"; },
    resolvePlatformToolTransport(_registry: SendMessageInput["toolRegistry"], requirement: SendMessageInput["platformToolTransportRequirement"]) {
      transportRequirements.push(requirement);
      return options.toolTransport ?? "native-dynamic";
    },
    async sendMessage(input: SendMessageInput) {
      followUpTurnId = input.turnId;
      followUpInput = input;
      if (options.staleDynamicBinding) {
        throw Object.assign(new Error("动态工具绑定不一致"), { code: "codex_thread_capability_incompatible" });
      }
      return await new Promise<{ responseText: string }>((resolve) => {
        resolveFollowUp = resolve;
      });
    },
    async prepareAssistantTerminalEvents() {
      return { events: [], latestAssistantText: null };
    },
  };
  let getOrCreateCalls = 0;
  const ctx = {
    db,
    workspaces: new Map([[WORKSPACE_ID, workspacePath]]),
    clientId: "client-test",
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    threads,
    sessions: {
      /** 单请求夹具只隔离引擎；专项测试覆盖清理门禁时序。 */
      beginThreadDeletion() { return () => {}; },
      /** provider 等待期保留普通写租约，续跑清理前释放。 */
      beginThreadOperation() { return () => {}; },
      getOrCreate() {
        getOrCreateCalls += 1;
        return getOrCreateCalls === 1 ? approvalSession : followUpSession;
      },
      async disposeThreadWithOptions() {
        disposed += 1;
      },
      assertThreadAvailable() {},
    },
    orchEngine: {},
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
    onBeforeEmitConversationEvent(event: ConversationEventInput) {
      const envelope = { ...event, seq: ++seq } as any;
      db.conversationEvents.appendEnvelope(envelope);
      const turnId = String((event.payload as any)?.turnId ?? "").trim() as TurnId;
      if (!turnId) return;
      if (event.type === "turn.started") {
        db.turns.insertStarted({
          workspaceId: event.workspaceId,
          threadId: event.threadId,
          engine: event.engine,
          turnId,
          startedAt: Number(event.ts),
          startEventSeq: envelope.seq,
        });
      }
      if (event.type === "turn.error") {
        db.turns.setEnded(turnId, { status: "error", endedAt: Number(event.ts), endEventSeq: envelope.seq });
      }
      if (event.type === "turn.completed") {
        db.turns.setEnded(turnId, { status: "completed", endedAt: Number(event.ts), endEventSeq: envelope.seq });
      }
    },
  } as unknown as ApiHandlerContext;

  return {
    db,
    ctx,
    sent,
    transportRequirements,
    get followUpInput() { return followUpInput; },
    get disposed() {
      return disposed;
    },
    get followUpTurnId() {
      return followUpTurnId;
    },
    completeFollowUp() {
      if (!resolveFollowUp) throw new Error("follow-up 尚未启动");
      resolveFollowUp({ responseText: "已完成后续实现" });
    },
    cleanup() {
      application.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test("审批 clearContextAndSend 先收口旧 turn，再启动 follow-up", async () => {
  const harness = setupApprovalFollowUpHarness();
  try {
    await handleApprovalsRespond(harness.ctx, {
      t: "api.req",
      id: "req-approval-follow-up",
      method: "approvals.respond",
      path: "/approvals/respond",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, requestId: "approval-1", decision: "accept" },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-approval-follow-up") as any;
    const oldTerminal = harness.sent.find(
      (message) => message.t === "conversation.event"
        && message.event.type === "turn.error"
        && message.event.payload.turnId === OLD_TURN_ID,
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.threadChangedKind, "cleared");
    assert.equal(harness.db.turns.get(OLD_TURN_ID)?.status, "error");
    assert.ok(harness.db.turns.get(OLD_TURN_ID)?.endedAt);
    assert.notEqual(harness.db.turns.listRunningByWorkspace(WORKSPACE_ID)[THREAD_ID]?.runningTurnId, OLD_TURN_ID);
    assert.equal(oldTerminal?.event?.payload?.code, "approval_context_cleared");
    assert.equal(oldTerminal?.event?.payload?.terminationKind, "transient_cleanup");
    assert.equal(harness.db.conversationEvents.listByThread(THREAD_ID).some(event => (event.payload as { turnId?: string }).turnId === OLD_TURN_ID), false);
    assert.ok(harness.sent.indexOf(oldTerminal) < harness.sent.findIndex(message => message.t === "conversation.event"
      && message.event.type === "turn.started" && message.event.payload.turnId === harness.followUpTurnId));
    assert.equal(Number(harness.db.db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events WHERE thread_id = ?").get(THREAD_ID).count), 0);
    assert.equal(harness.disposed, 1);

    await waitFor(() => harness.followUpTurnId !== null, "follow-up 未启动");
    const followUpTurnId = harness.followUpTurnId!;
    assert.equal(harness.db.turns.get(followUpTurnId)?.status, "started");

    harness.completeFollowUp();
    await waitFor(() => harness.db.turns.get(followUpTurnId)?.status === "completed", "follow-up 未完成");
  } finally {
    harness.cleanup();
  }
});

test("普通会话审批后续跑沿用开启的知识库工具和 required 传输", async () => {
  const harness = setupApprovalFollowUpHarness({ knowledgeEnabled: true });
  try {
    await handleApprovalsRespond(harness.ctx, {
      t: "api.req", id: "req-approval-knowledge", method: "approvals.respond", path: "/approvals/respond",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, requestId: "approval-knowledge", decision: "accept" },
    } as ApiRequestMessage);
    await waitFor(() => harness.followUpInput !== null, "知识续跑未启动");
    const input = harness.followUpInput!;
    assert.deepEqual(harness.transportRequirements, ["required"]);
    assert.equal(input.platformToolTransportRequirement, "required");
    assert.match(input.systemMessage ?? "", /knowledge\.tree\.read/);
    assert.ok(input.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.tree.read"));
    assert.ok(input.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.change.propose"));
    assert.ok(input.toolRegistry?.tools.some(tool => tool.toolId === "knowledge.acceptance.record"));
    harness.completeFollowUp();
    await waitFor(() => harness.db.turns.get(input.turnId)?.status === "completed", "知识续跑未完成");
    assert.ok(harness.sent.some(message => message.t === "conversation.event" && message.event.type === "item.tool.completed" && message.event.payload.toolName === "项目规格已提供"));
  } finally { harness.cleanup(); }
});

test("普通会话审批后知识工具不可用时回合明确失败，不发送提示词", async () => {
  const harness = setupApprovalFollowUpHarness({ knowledgeEnabled: true, toolTransport: "protocol" });
  try {
    await assert.rejects(handleApprovalsRespond(harness.ctx, {
      t: "api.req", id: "req-approval-unavailable", method: "approvals.respond", path: "/approvals/respond",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, requestId: "approval-unavailable", decision: "accept" },
    } as ApiRequestMessage));
    await waitFor(() => harness.db.conversationEvents.listByThread(THREAD_ID).some(event => event.type === "turn.error"), "续跑缺少错误终态");
    assert.deepEqual(harness.transportRequirements, ["required"]);
    assert.equal(harness.followUpInput, null);
    const error = harness.db.conversationEvents.listByThread(THREAD_ID).find(event => event.type === "turn.error")!;
    assert.equal((error.payload as { code?: string }).code, "KNOWLEDGE_TOOL_TRANSPORT_UNAVAILABLE");
  } finally { harness.cleanup(); }
});

test("普通 Codex 审批续跑缺少知识工具绑定时提示新建会话", async () => {
  const harness = setupApprovalFollowUpHarness({ knowledgeEnabled: true, staleDynamicBinding: true });
  try {
    await handleApprovalsRespond(harness.ctx, {
      t: "api.req", id: "req-approval-stale", method: "approvals.respond", path: "/approvals/respond",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, requestId: "approval-stale", decision: "accept" },
    } as ApiRequestMessage);
    await waitFor(() => harness.followUpTurnId !== null && harness.db.turns.get(harness.followUpTurnId)?.status === "error", "旧绑定续跑缺少错误终态");
    const error = harness.db.conversationEvents.listByThread(THREAD_ID).find(event => event.type === "turn.error")!;
    const payload = error.payload as { code?: string; error?: string; providerThreadId?: string };
    assert.equal(payload.code, "KNOWLEDGE_TOOLS_REQUIRE_NEW_SESSION");
    assert.match(payload.error ?? "", /请新建会话后重试/);
    assert.equal(payload.providerThreadId, "follow-up-provider-session");
    await assert.rejects(waitForOrdinaryTurnExecution(harness.ctx.sessions, { workspaceId: WORKSPACE_ID, threadId: THREAD_ID,
      turnId: harness.followUpTurnId! }), /请新建会话后重试/);
  } finally { harness.cleanup(); }
});

test("交互固定日志失败保留falsy业务原值且不发送第二条响应", async t => {
  const harness = setupApprovalFollowUpHarness(), writerFailure = { reason: "writer-failed" };
  try {
    (harness.ctx.sessions as any).getOrCreate = () => ({ async respondUserInput() { throw undefined; } });
    let writerWorkspace: WorkspaceId | null = null;
    t.mock.method(harness.db, "writeWorkspaceLog", (workspaceId) => { writerWorkspace = workspaceId; throw writerFailure; });
    await assert.rejects(handleUserInputRespond(harness.ctx, { t: "api.req", id: "input-log-failure", method: "userInput.respond", path: "/test",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, requestId: 7, answers: {} } }), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [undefined, writerFailure]);
        return true;
      });
    assert.equal(writerWorkspace, WORKSPACE_ID);
    assert.equal(harness.sent.filter(message => message.t === "api.res").length, 0);
  } finally { harness.cleanup(); }
});

test("交互日志描述不调用未知getter或toString且投递再失败保留业务原对象", async t => {
  const harness = setupApprovalFollowUpHarness(), deliveryFailure = new Error("delivery-failed");
  let getterReads = 0;
  const business = Object.create(null, { message: { get() { getterReads += 1; throw new Error("must not read"); } },
    toString: { get() { getterReads += 1; throw new Error("must not convert"); } } });
  try {
    (harness.ctx.sessions as any).getOrCreate = () => ({ async respondUserInput() { throw business; } });
    const logs: unknown[] = [];
    t.mock.method(harness.db, "writeWorkspaceLog", (_workspaceId, entry) => { logs.push(entry); });
    harness.ctx.send = () => { throw deliveryFailure; };
    await assert.rejects(handleUserInputRespond(harness.ctx, { t: "api.req", id: "input-delivery-failure", method: "userInput.respond", path: "/test",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, requestId: 7, answers: {} } }), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [business, deliveryFailure]);
        return true;
      });
    assert.equal(getterReads, 0);
    assert.equal(logs.length, 1);
  } finally { harness.cleanup(); }
});
