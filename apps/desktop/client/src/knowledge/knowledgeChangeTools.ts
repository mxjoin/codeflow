import type { ConversationEventInput, EngineType, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { KnowledgeAssetStore } from "./knowledgeAssetStore.js";
import { KnowledgeChangeStore } from "./knowledgeChangeStore.js";
import { KnowledgeAssetError } from "./knowledgeAssetFiles.js";
import { executeKnowledgeAssetReadTool, knowledgeTool } from "./knowledgeAssetTools.js";
import type { HostToolExecutionResult } from "../engines/threadSession.js";
import type { createKnowledgeSpecificationTurn } from "./knowledgeSpecificationTurn.js";

export const KNOWLEDGE_CHANGE_RULE = [
  "发现知识与代码、已确认需求不一致时，读取当前节点与直接证据，用 knowledge.change.propose 保存完整修改建议。",
  "提案立即出现在规格知识库的待确认更新区，审批独立于当前会话或流程。正式文档在人工批准前保持不变；不要等待审批、请求流程暂停或把审批当作完成门禁。",
  "提交成功后只提示本轮有哪些知识修改建议及审核入口，然后继续完成原任务。不要把未批准内容当作正式知识，不得直接改知识文件。",
].join("\n");

/** 声明文档修改建议工具，保留正式版本校验与人工采用边界。 */
export function buildKnowledgeChangeTool() {
  return knowledgeTool("knowledge.change.propose", "提交现有资产的完整修改建议和来源，立即保存至规格库待确认更新区；不修改正式知识，不等待人工审批。先用 node.read 获取 expectedHash，用 source.read 获取来源指纹。", {
    type: "object", additionalProperties: false,
    properties: {
      nodeId: { type: "string" }, expectedHash: { type: ["string", "null"] },
      summary: { type: "string", description: "说明修正点、原因与证据差异，不复制会话记录。" },
      content: { type: "string", description: "修改后的完整 Markdown 文档。" },
      sources: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: {
        kind: { enum: ["code", "document", "requirement"] }, path: { type: "string" }, contentHash: { type: "string" },
        symbol: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
        requirement: { type: "string" }, relation: { type: "string" },
      }, required: ["kind", "relation"] } },
    }, required: ["nodeId", "expectedHash", "summary", "content", "sources"],
  });
}

/** 使用平台消息做轻量提示，不创建审批交互请求或改变流程控制状态。 */
export function createKnowledgeSuggestionTurn(input: {
  store: KnowledgeAssetStore; workspaceId: string; threadId: string; turnId: string; engine: EngineType;
  origin: "chat" | "workflow"; canPropose: boolean; isActive: () => boolean;
  emit: (event: ConversationEventInput) => void;
  specificationTurn?: ReturnType<typeof createKnowledgeSpecificationTurn> | null;
}) {
  const changes = new Map<string, string>();
  let revision = 0;
  return {
    execute(toolId: string, raw: unknown): HostToolExecutionResult {
      if (toolId === "knowledge.acceptance.record") {
        if (!input.specificationTurn) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_REQUIRED", "当前回合尚未提供可追踪规格，不能记录验收依据", 400);
        return input.specificationTurn.record(raw);
      }
      if (toolId !== "knowledge.change.propose") {
        const result = executeKnowledgeAssetReadTool(input.store, toolId, raw);
        if (toolId === "knowledge.rules.read" && result.ok && input.specificationTurn) {
          const value = raw as { paths?: string[] };
          input.specificationTurn.recordRules(result.output as ReturnType<KnowledgeAssetStore["rules"]>, value.paths ?? []);
        }
        return result;
      }
      if (!input.canPropose) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "当前回合没有提交知识修改建议的可信身份", 403);
      if (!input.isActive()) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "回合已停止，本次建议未保存");
      const change = new KnowledgeChangeStore(input.store).submit(raw, input);
      changes.set(change.id, change.title);
      const href = `/knowledge?view=approvals&workspaceId=${encodeURIComponent(input.workspaceId)}&changeId=${encodeURIComponent(change.id)}`;
      input.emit({
        ts: Date.now(), workspaceId: input.workspaceId as WorkspaceId, threadId: input.threadId as ThreadId, engine: input.engine,
        type: "item.agentMessage.completed",
        payload: { turnId: input.turnId as TurnId, itemId: `knowledge-changes-${input.turnId}`, engineMessageId: `knowledge-changes-${input.turnId}`,
          text: `本轮已提交 ${changes.size} 项文档修改建议：${[...changes.values()].join("、")}。请到[规格知识库 → 待确认更新](${href})审核，正式文档尚未变更。`,
          revision: ++revision },
      });
      return { ok: true, output: { proposalId: change.id, status: "pending", approvalUrl: href, formalKnowledgeChanged: false, continueCurrentTask: true } };
    },
  };
}
