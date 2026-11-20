import crypto from "node:crypto";
import type { AccessMode, ConversationEventInput, EngineType, ItemId, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { createTurnErrorEventInput, createTurnErrorEventInputFromError } from "../../errors/turnErrors.js";

import { describeWorkspaceApiFailure, isWorkspaceApiRequestFailure, WorkspaceApiRequestFailure, type ApiHandlerContext, type ApiRequestMessage } from "../handleApiRequest.js";
import { emitTurnTerminalWithAssistantReconcile } from "../../engines/turnTerminalEmitter.js";
import { logger } from "../../logger.js";
import { engineDiagnosticCause, engineDiagnosticField, isEngineWorkspaceLogFailure } from "../../engines/threadSession.js";
import { trackOrdinaryTurnExecution, type OrdinaryTurnExecutionControl } from "../ordinaryTurnExecution.js";
import { buildDefaultChatSystemPrompt } from "../defaultChatSystemPrompt.js";
import { resolveWorkspaceKnowledgeChatContext } from "../workspaceKnowledgeChatContext.js";
import { createKnowledgeSpecificationTurn } from "../../knowledge/knowledgeSpecificationTurn.js";
import { buildPromptText } from "../utils/promptWithAttachments.js";
import { assertClientReasoningEffortSupported } from "../../engines/engineModelCapabilities.js";
import { createKnowledgeSuggestionTurn } from "../../knowledge/knowledgeChangeTools.js";
import { KnowledgeAssetStore } from "../../knowledge/knowledgeAssetStore.js";
import { createKnowledgeConversationTurn, readKnowledgeConversationActor, settleKnowledgeConversationEvent, type KnowledgeConversationActor } from "../../knowledge/knowledgeConversationService.js";
import { KnowledgeAssetError } from "../../knowledge/knowledgeAssetFiles.js";
import { readSharedWorkspaceToolExecutionContext, type SharedWorkspaceToolExecutionContext } from "../sharedWorkspaceToolPolicy.js";
import { respondAsyncUserInput } from "./asyncUserInput.js";

/** 异步交互只在同步仓储调用期间取得许可，等待引擎前释放。 */
function withInteractionDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 只读取异常自有 code，未知访问器不参与 provider 旋转策略。 */
function isCodexDynamicToolBindingMismatch(error: unknown): boolean {
  return engineDiagnosticField(error, "code") === "codex_thread_capability_incompatible";
}

/** 原请求已核 W 固定写入；未确定 W 的准入拒绝留应用，诊断双错始终保原值。 */
async function logInteraction(ctx: ApiHandlerContext, req: Pick<ApiRequestMessage, "id" | "method">,
  level: "info" | "warn" | "error", tag: string, message: string, build: () => Record<string, unknown>,
  business?: { reason: unknown }, responseAttempted = false): Promise<void> {
  const workspaceId = ctx.db.workspaceId;
  try {
    const data = { ...build(), workspaceId, requestId: req.id };
    await withInteractionDatabase(ctx, req.id, () => {
      if (workspaceId) ctx.db.writeWorkspaceLog(workspaceId, { level, tag, message, data });
      else logger[level](tag, message, data);
    });
  } catch (cause) { throw new WorkspaceApiRequestFailure(business ? [business.reason, cause] : [cause], {
    code: "WORKSPACE_API_REQUEST_LOG_FAILED", requestId: req.id, method: req.method, workspaceId, responseAttempted,
  }); }
}

/** 描述失败与原业务失败同处处理边界，不执行未知 getter/toString。 */
function describeInteractionFailure(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): ReturnType<typeof describeWorkspaceApiFailure> {
  try { return describeWorkspaceApiFailure(error); }
  catch (cause) { throw new WorkspaceApiRequestFailure([error, cause], { code: "WORKSPACE_API_REQUEST_LOG_FAILED",
    requestId: req.id, method: req.method, workspaceId: ctx.db.workspaceId }); }
}

/** 失败响应只尝试一次，标记或投递失败与原业务原因一起交原请求 owner。 */
function replyInteractionFailure(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown, message: string): void {
  let responseAttempted = false;
  try {
    ctx.onApiFailureLogged?.();
    responseAttempted = true;
    const result = ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message } });
    if (result?.accepted === false) throw result;
  } catch (cause) { throw new WorkspaceApiRequestFailure([error, cause], { code: "WORKSPACE_API_RESPONSE_FAILED",
    requestId: req.id, method: req.method, workspaceId: ctx.db.workspaceId, responseAttempted }); }
}

/** 知识工具沿原失败结果返回安全消息；描述异常与业务原值一并保留。 */
function describeFollowUpKnowledgeFailure(ctx: ApiHandlerContext, turnId: TurnId, error: unknown): { code: string; message: string } {
  try {
    const description = describeWorkspaceApiFailure(error);
    const code = engineDiagnosticField(error, "code");
    return error instanceof KnowledgeAssetError && typeof code === "string"
      ? { code, message: description.message }
      : { code: "KNOWLEDGE_ASSET_IO_FAILED", message: `项目知识操作失败：${description.message}` };
  } catch (cause) { throw new WorkspaceApiRequestFailure([error, cause], { code: "WORKSPACE_API_REQUEST_LOG_FAILED",
    workspaceId: ctx.db.workspaceId, requestId: turnId, method: "approvals.respond", responseAttempted: true, responseDelivered: true }); }
}

/** 处理 `approvals.respond`：将 Web 决策回写到引擎（Codex app-server）。 */
export async function handleApprovalsRespond(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const requestId = (req.body as any)?.requestId as unknown;
  const decision = String((req.body as any)?.decision ?? "").trim();
  const choice = typeof (req.body as any)?.choice === "string" ? String((req.body as any).choice).trim() : null;
  const note = typeof (req.body as any)?.note === "string" ? String((req.body as any).note) : null;
  if (!workspaceId || !threadId || requestId === undefined || (decision !== "accept" && decision !== "decline")) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/requestId/decision" } });
    return;
  }

  const thread = await withInteractionDatabase(ctx, req.id, () => getThreadRuntime(ctx, threadId));
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (thread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }
  if (ctx.db.workspaceId === null) ctx = { ...ctx, db: await withInteractionDatabase(ctx, req.id, () => ctx.db.forWorkspace(thread.workspaceId)) };

  const session = ctx.sessions.getOrCreate(thread);
  const responder = session as any;
  if (typeof responder.respondApproval !== "function") {
    ctx.send({ t: "api.res", id: req.id, status: 501, body: { ok: false, message: "当前引擎不支持 approval.respond" } });
    return;
  }
  let result: { followUp?: { kind: "clearContextAndSend"; promptText: string; accessMode: "current" | "full-access" } } | null = null;
  // 审批等待保留普通写租约；返回续跑决策后释放，清理阶段再取得独占门禁。
  const finishApproval = ctx.sessions.beginThreadOperation(threadId);
  try {
    result = await responder.respondApproval(requestId, decision, { choice, note });
  } catch (e) {
    if (isEngineWorkspaceLogFailure(e) || isWorkspaceApiRequestFailure(e)) throw e;
    const errMsg = describeInteractionFailure(ctx, req, e).message;
    if (isExpiredApprovalError(errMsg)) {
      await expireApprovalAndRunningTurn(ctx, { workspaceId, threadId, engine: thread.engine, requestId, message: "审批请求已失效，请重新发起。" });
      ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "审批请求已失效，请重新发起。" } });
      return;
    }
    await logInteraction(ctx, req, "error", "approval", "approval response failed", () => ({ errorCode: "APPROVAL_RESPONSE_FAILED", providerRequestId: requestId, threadId, rootCause: engineDiagnosticCause(e) }), { reason: e });
    replyInteractionFailure(ctx, req, e, errMsg);
    return;
  } finally { finishApproval(); }
  if (result?.followUp?.kind === "clearContextAndSend") {
    await logInteraction(ctx, req, "info", "approval", "clearContextAndSend follow-up started", () => ({ providerRequestId: requestId, threadId, accessMode: result!.followUp!.accessMode }));
    await clearThreadForFollowUp(ctx, { workspaceId, threadId });
    const response = ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, threadChangedKind: "cleared" } });
    if (response?.accepted === false) throw new WorkspaceApiRequestFailure([response], { code: "WORKSPACE_API_RESPONSE_FAILED",
      workspaceId, requestId: req.id, method: req.method, responseAttempted: true, responseDelivered: false });
    await new Promise<void>(resolve => setTimeout(resolve, 150));
    try {
      await startThreadFollowUpTurn(ctx, {
        workspaceId,
        threadId,
        text: result.followUp!.promptText,
        accessMode: result.followUp!.accessMode,
        sharedContext: readSharedWorkspaceToolExecutionContext((req.body ?? {}) as Record<string, unknown>),
        trustedActor: readKnowledgeConversationActor((req.body as Record<string, unknown>)?.knowledgeConversationActorContext),
      });
    } catch (cause) { throw new WorkspaceApiRequestFailure([cause], { code: "WORKSPACE_API_FOLLOW_UP_FAILED",
      workspaceId, requestId: req.id, method: req.method, responseAttempted: true, responseDelivered: true }); }
    return;
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
}

/** 维持原审批失效识别口径，仅输入已安全读取的消息。 */
function isExpiredApprovalError(message: string): boolean {
  return message.includes("Claude stdin 不可写") || message.includes("approval request 不存在或已处理");
}

/** 过期审批先等待原终态协调，失败交原请求而非遗失在 detached Promise。 */
async function expireApprovalAndRunningTurn(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; engine: EngineType; requestId: unknown; message: string },
): Promise<void> {
  emitConversation(ctx, {
    ts: Date.now(),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: input.engine,
    type: "approval.expired",
    payload: { requestId: input.requestId, message: input.message },
  });

  await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);
  const runningTurn = await withInteractionDatabase(ctx, input.threadId, () => [...ctx.db.turns.listByThread(input.threadId)].reverse().find((turn) => turn.status === "started") ?? null);
  if (!runningTurn) return;
  const thread = await withInteractionDatabase(ctx, input.threadId, () => getThreadRuntime(ctx, input.threadId));
  await emitTurnTerminalWithAssistantReconcile({
    session: thread ? ctx.sessions.getOrCreate(thread) : null,
    turnId: runningTurn.turnId,
    outcome: "error",
    emitConversation: (event) => emitConversation(ctx, event),
    buildTerminalEvent: () => createTurnErrorEventInput({
      ts: Date.now(),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      engine: input.engine,
      turnId: runningTurn.turnId,
      error: input.message,
      terminationKind: "error",
    }),
  });
}

/** 处理 `userInput.respond`：将表单答案回写到引擎（Codex app-server）。 */
export async function handleUserInputRespond(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const requestId = (req.body as any)?.requestId as unknown;
  const answers = (req.body as any)?.answers as unknown;

  if (!workspaceId || !threadId || requestId === undefined || !answers || typeof answers !== "object") {
    await logInteraction(ctx, req, "warn", "userInput", "user input response rejected", () => ({ errorCode: "USER_INPUT_RESPONSE_INVALID", providerRequestId: requestId, threadId, answersType: typeof answers, rootCause: "invalid workspaceId/threadId/requestId/answers" }));
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/requestId/answers" } });
    return;
  }

  const thread = await withInteractionDatabase(ctx, req.id, () => getThreadRuntime(ctx, threadId));
  if (!thread) {
    await logInteraction(ctx, req, "warn", "userInput", "user input thread not found", () => ({ errorCode: "USER_INPUT_THREAD_NOT_FOUND", providerRequestId: requestId, threadId, rootCause: "thread does not exist" }));
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (thread.workspaceId !== workspaceId) {
    await logInteraction(ctx, req, "warn", "userInput", "user input workspace mismatch", () => ({ errorCode: "USER_INPUT_WORKSPACE_MISMATCH", providerRequestId: requestId, threadId, threadWorkspaceId: thread.workspaceId, rootCause: "thread workspace differs from request workspace" }));
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }
  if (ctx.db.workspaceId === null) ctx = { ...ctx, db: await withInteractionDatabase(ctx, req.id, () => ctx.db.forWorkspace(thread.workspaceId)) };

  if (thread.engine === "codex" && await respondAsyncUserInput(ctx, req)) return;
  const session = ctx.sessions.getOrCreate(thread);
  const responder = session as any;
  if (typeof responder.respondUserInput !== "function") {
    await logInteraction(ctx, req, "warn", "userInput", "engine does not support user input response", () => ({ errorCode: "USER_INPUT_RESPONSE_UNSUPPORTED", providerRequestId: requestId, threadId, engine: thread.engine, rootCause: "engine does not support userInput.respond" }));
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 501, body: { ok: false, message: "当前引擎不支持 userInput.respond" } });
    return;
  }
  try {
    await responder.respondUserInput(requestId, answers);
  } catch (e) {
    if (isEngineWorkspaceLogFailure(e) || isWorkspaceApiRequestFailure(e)) throw e;
    const errMsg = describeInteractionFailure(ctx, req, e).message;
    await logInteraction(ctx, req, "error", "userInput", "user input response failed", () => ({ errorCode: "USER_INPUT_RESPONSE_FAILED", providerRequestId: requestId, threadId, rootCause: engineDiagnosticCause(e) }), { reason: e });
    replyInteractionFailure(ctx, req, e, errMsg);
    return;
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
}

/** 先复用运行对象，再从本次已核 W 仓储恢复相同父身份。 */
function getThreadRuntime(ctx: ApiHandlerContext, threadId: ThreadId) {
  let thread = ctx.threads.get(threadId);
  if (thread) return thread;

  const fromDb = ctx.db.threads.get(threadId);
  if (!fromDb) return null;
  thread = ctx.threads.create({
    threadId: fromDb.id,
    workspaceId: fromDb.workspaceId,
    engine: fromDb.engine,
    title: fromDb.title,
    sessionId: fromDb.sessionId,
    sessionCapabilities: fromDb.sessionCapabilities,
  });
  return thread;
}

/** 清理历史前收口遗留运行回合，避免 follow-up 保留旧运行态。 */
function settleRunningTurnsBeforeFollowUp(
  ctx: ApiHandlerContext,
  input: { workspaceId: WorkspaceId; threadId: ThreadId },
): number {
  const runningTurns = ctx.db.turns.listByThread(input.threadId).filter(
    (turn) => turn.status === "started" && turn.endedAt === null,
  );
  for (const turn of runningTurns) {
    if (turn.workspaceId !== input.workspaceId) {
      throw new Error(`审批续跑清理的 turn workspace 不匹配：threadId=${input.threadId}, turnId=${turn.turnId}`);
    }
    emitConversation(ctx, createTurnErrorEventInput({
      ts: Date.now(),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      engine: turn.engine,
      turnId: turn.turnId,
      error: "审批已切换到新的会话上下文，原回合已结束。",
      code: "approval_context_cleared",
      terminationKind: "transient_cleanup",
    }));
  }
  return runningTurns.length;
}

/** 清理审批续跑前的本地历史，并释放旧引擎会话。 */
async function clearThreadForFollowUp(ctx: ApiHandlerContext, input: { workspaceId: WorkspaceId; threadId: ThreadId }): Promise<void> {
  const release = ctx.sessions.beginThreadDeletion([input.threadId]);
  try {
  await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);
  const closedRunningTurnCount = await withInteractionDatabase(ctx, input.threadId, () => settleRunningTurnsBeforeFollowUp(ctx, input));
  await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);
  await ctx.sessions.disposeThreadWithOptions(input.threadId, { flushActiveTurn: false });
  await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);
  const { deletedConversationEvents, deletedRawEvents, deletedFileChanges } = await withInteractionDatabase(ctx, input.threadId, () => ctx.db.db.transaction(() => {
    const deletedConversationEvents = ctx.db.conversationEvents.deleteByThread(input.threadId);
    const deletedRawEvents = ctx.db.rawEvents.deleteByThread(input.threadId);
    const deletedFileChanges = ctx.db.fileChanges.deleteByThread(input.threadId);
    ctx.db.threads.clearSessionId(input.threadId);
    return { deletedConversationEvents, deletedRawEvents, deletedFileChanges };
  })());
  await logInteraction(ctx, { id: input.threadId, method: "approvals.respond" }, "info", "approval", "clearThreadForFollowUp cleared local history", () => ({
    threadId: input.threadId,
    closedRunningTurnCount,
    deletedEvents: deletedConversationEvents + deletedRawEvents,
    deletedFileChanges,
  }));
  ctx.threads.clearSessionId(input.threadId);
  } finally { release(); }
}

/** 启动审批后的续跑回合，知识工具与普通发送使用相同的真实注册要求。 */
async function startThreadFollowUpTurn(ctx: ApiHandlerContext, input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  text: string;
  accessMode: AccessMode;
  sharedContext?: SharedWorkspaceToolExecutionContext | null;
  trustedActor?: KnowledgeConversationActor | null;
}): Promise<void> {
  const thread = await withInteractionDatabase(ctx, input.threadId, () => getThreadRuntime(ctx, input.threadId));
  if (!thread) throw new Error("thread 不存在");
  const workspacePath = ctx.workspaces.get(input.workspaceId) ?? null;
  if (!workspacePath) throw new Error(`未知 workspaceId：${input.workspaceId}`);
  ctx.sessions.assertThreadAvailable(input.threadId, thread);

  const persistedThread = await withInteractionDatabase(ctx, input.threadId, () => {
  const persistedThread = ctx.db.threads.get(input.threadId);
  assertClientReasoningEffortSupported(
    ctx.db,
    thread.engine,
    persistedThread?.model ?? null,
    persistedThread?.effort ?? null,
  );
  ctx.db.threads.updatePrefs(input.threadId, {
    model: persistedThread?.model ?? null,
    effort: persistedThread?.effort ?? null,
    accessMode: input.accessMode,
    planMode: false,
    autoCompactPct: persistedThread?.autoCompactPct ?? null,
    contextWindow: persistedThread?.contextWindow ?? null,
    serviceTier: persistedThread?.serviceTier ?? null,
  });
  return persistedThread;
  });

  const turnId = `turn_${crypto.randomUUID()}` as TurnId;
  const userItemId = `item_user_${crypto.randomUUID()}` as ItemId;
  const assistantItemId = `item_assistant_${crypto.randomUUID()}`;
  const reasoningItemId = `item_reasoning_${crypto.randomUUID()}`;
  const workMode = "general";
  const promptText = buildPromptText({ text: String(input.text ?? "").trim(), files: [] });
  const lifecycleVersion = thread.lifecycleVersion;
  const isThreadLifecycleCurrent = () => {
    const latest = ctx.threads.get(input.threadId);
    return Boolean(latest && latest.lifecycleVersion === lifecycleVersion);
  };

  emitConversation(ctx, { ts: Date.now(), workspaceId: input.workspaceId, threadId: input.threadId, engine: thread.engine, type: "turn.started", payload: { turnId } });
  emitConversation(ctx, {
    ts: Date.now(),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    engine: thread.engine,
    type: "item.userMessage.created",
    payload: { turnId, itemId: userItemId, text: String(input.text ?? "").trim() },
  });
  await ctx.flushLocalEvents?.(input.workspaceId, input.threadId);

  let knowledgeTurn: ReturnType<typeof createKnowledgeConversationTurn> = null;
  try {
  const session = ctx.sessions.getOrCreate(thread);
  const isActive = () => isThreadLifecycleCurrent() && (!ctx.db.turns.get(turnId) || ctx.db.turns.get(turnId)?.status === "started");
  knowledgeTurn = await withInteractionDatabase(ctx, turnId, () => createKnowledgeConversationTurn({
    db: ctx.db, store: new KnowledgeAssetStore(workspacePath), workspaceId: input.workspaceId, threadId: input.threadId,
    turnId, engine: thread.engine, model: persistedThread?.model ?? null, effort: persistedThread?.effort ?? null,
    prompt: input.text, isActive, sharedContext: input.sharedContext, trustedActor: input.trustedActor,
  }));
   const workspaceKnowledge = knowledgeTurn ? { systemRule: null, requiredWorkspaceSkills: [], knowledgeAssetTools: null, specifications: undefined } : resolveWorkspaceKnowledgeChatContext({
    workspacePath, engine: thread.engine, enabled: persistedThread?.knowledgeEnabled === true,
  });
  const knowledgeToolRegistry = knowledgeTurn?.registry ?? workspaceKnowledge.knowledgeAssetTools ?? null;
   const specificationTurn = workspaceKnowledge.specifications ? createKnowledgeSpecificationTurn({
     store: new KnowledgeAssetStore(workspacePath), specifications: workspaceKnowledge.specifications,
     workspaceId: input.workspaceId, threadId: input.threadId, turnId, engine: thread.engine,
     userRequirements: await withInteractionDatabase(ctx, turnId, () => [input.text, ...ctx.db.conversationEvents.listByThreadType(input.threadId, "item.userMessage.created", { limit: 100 }).map(event => (event.payload as { text?: string }).text ?? "")].join("\n\n")),
     isActive, emit: event => emitConversation(ctx, event),
   }) : null;
   const suggestions = createKnowledgeSuggestionTurn({
    store: new KnowledgeAssetStore(workspacePath), workspaceId: input.workspaceId, threadId: input.threadId,
    turnId, engine: thread.engine, origin: "chat", canPropose: Boolean(input.trustedActor), isActive,
     specificationTurn,
    emit: event => emitConversation(ctx, event),
  });
  const knowledgeToolTransport = knowledgeToolRegistry
    ? await withInteractionDatabase(ctx, turnId, () => session.resolvePlatformToolTransport(knowledgeToolRegistry, "required"))
    : null;
  const enableKnowledgeTools = Boolean(knowledgeToolRegistry && knowledgeToolTransport === "native-dynamic");
  if (knowledgeTurn && !enableKnowledgeTools) throw new Error("当前会话不支持知识提交工具，请使用支持平台工具的会话。");
  if (workspaceKnowledge.knowledgeAssetTools && !enableKnowledgeTools) {
    throw new KnowledgeAssetError("KNOWLEDGE_TOOL_TRANSPORT_UNAVAILABLE", "当前引擎会话不支持知识库工具，请切换支持平台工具的引擎后重试。");
  }
  await logInteraction(ctx, { id: turnId, method: "approvals.respond" }, "info", "approval", "startThreadFollowUpTurn spawned", () => ({ threadId: input.threadId, turnId, accessMode: input.accessMode, workMode }));
  const sendInput: Parameters<typeof session.sendMessage>[0] = {
        turnId,
        userItemId,
        text: promptText,
        systemMessage: buildDefaultChatSystemPrompt([knowledgeTurn ? null : workspaceKnowledge.systemRule]),
        developerMessage: knowledgeTurn?.instructions,
        requiredWorkspaceSkills: knowledgeTurn ? [] : workspaceKnowledge.requiredWorkspaceSkills,
        toolRegistry: enableKnowledgeTools ? knowledgeToolRegistry : null,
        toolRegistryJson: enableKnowledgeTools && knowledgeToolRegistry ? JSON.stringify(knowledgeToolRegistry) : null,
        platformToolTransportRequirement: knowledgeToolRegistry ? "required" : "optional",
        conversationProfile: knowledgeTurn?.conversationProfile ?? "default",
        executeHostTool: enableKnowledgeTools
          ? async ({ toolId, toolInput }) => {
            try {
              return await withInteractionDatabase(ctx, turnId, () => knowledgeTurn ? knowledgeTurn.execute(String(toolId), toolInput) : suggestions.execute(String(toolId), toolInput));
            } catch (error) {
              await logInteraction(ctx, { id: turnId, method: "approvals.respond" }, "error", "knowledge-assets", "follow-up project knowledge tool failed", () => ({
                code: describeFollowUpKnowledgeFailure(ctx, turnId, error).code,
                requestId: turnId,
                workspaceId: input.workspaceId,
                threadId: input.threadId,
                toolId: String(toolId),
                rootCause: engineDiagnosticCause(error),
              }), { reason: error });
              return {
                ok: false,
                ...describeFollowUpKnowledgeFailure(ctx, turnId, error),
                output: {
                  requestId: turnId,
                  operation: String(toolId),
                  threadId: input.threadId,
                  rootCause: engineDiagnosticCause(error),
                },
              };
            }
          }
          : null,
        workMode,
        planMode: false,
        images: [],
        accessMode: persistedThread?.threadSubtype === "knowledge-conversation" ? "read-only" : input.accessMode,
        model: persistedThread?.model ?? undefined,
        effort: persistedThread?.effort ?? undefined,
        autoCompactPct: persistedThread?.autoCompactPct ?? undefined,
        contextWindow: persistedThread?.contextWindow ?? undefined,
        serviceTier: persistedThread?.serviceTier ?? null,
        assistantItemId,
        reasoningItemId,
        timeoutPolicy: ctx.timeoutPolicy,
      };
  const sendEmitters: Parameters<typeof session.sendMessage>[1] = {
        flush: () => ctx.flushLocalEvents?.(input.workspaceId, input.threadId) ?? Promise.resolve(),
        conversation: (event) => {
          if (!isThreadLifecycleCurrent()) return;
           specificationTurn?.observe(event);
          settleKnowledgeConversationEvent(knowledgeTurn, turnId, event);
          emitConversation(ctx, event);
        },
        raw: (event) => {
          if (!isThreadLifecycleCurrent()) return;
          emitRaw(ctx, event);
        },
      };
  // 普通会话保留原 binding；独立知识执行会话仍沿用既有的安全旋转入口。
  /** 续跑沿普通回合 owner 登记派发，失败不重复投递未知状态的输入。 */
  const sendKnowledgeMessage = async (execution: OrdinaryTurnExecutionControl) => {
    let bindingReset = false;
    while (true) {
      try {
        execution.assertNotCancelled();
        execution.markProviderDispatch();
         const result = await session.sendMessage(sendInput, sendEmitters);
         specificationTurn?.provided();
         return result;
      } catch (error) {
        if (isWorkspaceApiRequestFailure(error) || isEngineWorkspaceLogFailure(error)) throw error;
        if (!knowledgeTurn && workspaceKnowledge.knowledgeAssetTools && thread.engine === "codex" && isCodexDynamicToolBindingMismatch(error)) {
          const providerThreadId = session.getSessionId();
          await logInteraction(ctx, { id: turnId, method: "approvals.respond" }, "error", "knowledge-assets", "follow-up knowledge tools require a new provider session", () => ({
            code: "KNOWLEDGE_TOOLS_REQUIRE_NEW_SESSION", requestId: turnId,
            workspaceId: input.workspaceId, threadId: input.threadId, providerThreadId,
            rootCause: engineDiagnosticCause(error),
          }), { reason: error });
          throw Object.assign(new KnowledgeAssetError("KNOWLEDGE_TOOLS_REQUIRE_NEW_SESSION", "当前 Codex 会话无法追加本轮知识库工具，请新建会话后重试。"), { cause: error, providerThreadId, preserveBinding: true });
        }
        // 资产生成/复检执行线程的工具集合会在不同阶段变化；Codex provider
        // thread 的 dynamic tools 是启动时固定的，准入失败时只能旋转旧 generation，
        // 不能把同一条消息重复投递到旧 binding。
        if (!knowledgeTurn || bindingReset || thread.engine !== "codex" || !isCodexDynamicToolBindingMismatch(error)) throw error;
        const staleProviderThreadId = session.getSessionId();
        let rotated = false;
        try {
          rotated = session.resetDynamicToolBinding?.() === true;
        } catch (rotationError) {
          await logInteraction(ctx, { id: turnId, method: "approvals.respond" }, "error", "knowledge-assets", "interactive Codex dynamic tool binding rotation failed", () => ({
            code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_FAILED",
            requestId: turnId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            providerThreadId: staleProviderThreadId,
            activeTurnId: session.getActiveTurnId?.() ?? null,
            rootCause: engineDiagnosticCause(rotationError),
            mismatch: engineDiagnosticCause(error),
          }), { reason: rotationError });
          throw rotationError;
        }
        if (!rotated) {
          await logInteraction(ctx, { id: turnId, method: "approvals.respond" }, "error", "knowledge-assets", "interactive Codex dynamic tool binding cannot be rotated safely", () => ({
            code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_REJECTED",
            requestId: turnId,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            providerThreadId: staleProviderThreadId,
            activeTurnId: session.getActiveTurnId?.() ?? null,
            rootCause: engineDiagnosticCause(error),
          }), { reason: error });
          throw error;
        }
        bindingReset = true;
        await logInteraction(ctx, { id: turnId, method: "approvals.respond" }, "warn", "knowledge-assets", "stale Codex dynamic tool binding rotated for interactive knowledge turn", () => ({
          code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATED",
          requestId: turnId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          providerThreadId: staleProviderThreadId,
          rootCause: engineDiagnosticCause(error),
        }), { reason: error });
      }
    }
  };
  trackOrdinaryTurnExecution(ctx.sessions, { workspaceId: input.workspaceId, threadId: input.threadId, turnId, localWorkspaceOnly: ctx.localWorkspaceOnly === true }, async execution => {
    let result: Awaited<ReturnType<typeof sendKnowledgeMessage>>;
    try {
      result = await sendKnowledgeMessage(execution);
    } catch (e) {
      try { await withInteractionDatabase(ctx, turnId, () => knowledgeTurn?.finish(e, !isActive())); }
      catch (cleanup) { throw new WorkspaceApiRequestFailure([e, cleanup], { code: "WORKSPACE_API_REQUEST_CLEANUP_FAILED",
        workspaceId: input.workspaceId, requestId: turnId, method: "approvals.respond", responseAttempted: true, responseDelivered: true }); }
      if (isWorkspaceApiRequestFailure(e) || isEngineWorkspaceLogFailure(e)) throw e;
      if (!isThreadLifecycleCurrent()) throw e;
      try { await emitTurnTerminalWithAssistantReconcile({
        session,
        turnId,
        outcome: "error",
        emitConversation: (event) => emitConversation(ctx, event),
        buildTerminalEvent: () => createTurnErrorEventInputFromError({
          ts: Date.now(),
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          engine: thread.engine,
          turnId,
          error: e,
        }),
      }); } catch (terminalError) { throw new WorkspaceApiRequestFailure([e, terminalError], { code: "WORKSPACE_API_REQUEST_CLEANUP_FAILED",
        workspaceId: input.workspaceId, requestId: turnId, method: "approvals.respond", responseAttempted: true, responseDelivered: true }); }
      throw e;
    }
    await withInteractionDatabase(ctx, turnId, () => knowledgeTurn?.finish(undefined, !isActive()));
    if (!isThreadLifecycleCurrent()) return;
    await emitTurnTerminalWithAssistantReconcile({
      session, turnId, outcome: "completed", emitConversation: event => emitConversation(ctx, event),
      buildTerminalEvent: latestAssistantText => ({ ts: Date.now(), workspaceId: input.workspaceId, threadId: input.threadId,
        engine: thread.engine, type: "turn.completed", payload: { turnId, result: { ...result,
          responseText: latestAssistantText ?? String(result.responseText ?? "") } } }),
    });
  });
  } catch (error) {
    try { await withInteractionDatabase(ctx, turnId, () => knowledgeTurn?.finish(error)); }
    catch (cleanup) { throw new WorkspaceApiRequestFailure([error, cleanup], { code: "WORKSPACE_API_REQUEST_CLEANUP_FAILED",
      workspaceId: input.workspaceId, requestId: turnId, method: "approvals.respond", responseAttempted: true, responseDelivered: true }); }
    if (isWorkspaceApiRequestFailure(error) || isEngineWorkspaceLogFailure(error)) throw error;
    await logInteraction(ctx, { id: turnId, method: "approvals.respond" }, "error", "knowledge-assets", "follow-up turn initialization failed", () => ({
      code: describeFollowUpKnowledgeFailure(ctx, turnId, error).code, requestId: turnId, workspaceId: input.workspaceId,
      threadId: input.threadId, rootCause: engineDiagnosticCause(error),
    }), { reason: error });
    emitConversation(ctx, createTurnErrorEventInputFromError({ workspaceId: input.workspaceId, threadId: input.threadId, engine: thread.engine, turnId, error }));
    throw error;
  }
}

/** 先提交本地事件，再校验投递；失败不得继续发布后续终态。 */
function emitConversation(ctx: Pick<ApiHandlerContext, "send" | "onBeforeEmitConversationEvent">, event: ConversationEventInput): void {
  if (ctx.onBeforeEmitConversationEvent) ctx.onBeforeEmitConversationEvent(event);
  const result = ctx.send({ t: "conversation.event", event });
  if (result?.accepted === false) throw result;
}

/** 原始trace投递失败保持显式失败，不能伪装已交付。 */
function emitRaw(ctx: Pick<ApiHandlerContext, "send">, event: any): void {
  const result = ctx.send({ t: "raw.event", event });
  if (result?.accepted === false) throw result;
}


