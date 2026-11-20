import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeAssetNode, KnowledgeAssetsSnapshot, KnowledgeGenerationRunView } from "@codeflowai/shared";
import { knowledgeOverview } from "../src/features/project-knowledge/knowledgeOverviewModel.js";

/** 构造最小资产，保留目录、归档及正式指针的真实区分。 */
function node(id: string, extra: Partial<KnowledgeAssetNode> = {}): KnowledgeAssetNode {
  return { id, parentId: null, title: id, orderKey: id, summary: "", instructions: "", sourceScope: [], tags: [], ...extra };
}

/** 快照仅由正式树及状态组成，候选正文不能当成已采用内容。 */
function snapshot(nodes: KnowledgeAssetNode[], states: KnowledgeAssetsSnapshot["states"] = []): KnowledgeAssetsSnapshot {
  return { initialized: true, knowledgeId: "kb", root: "codeflow-docs/规格知识库", tree: { schemaVersion: 3, instructions: "", nodes }, treeHash: "tree", canWrite: true, states };
}

/** 构造完成任务，失败和复检状态由用例明确传入。 */
function run(id: string, nodeId: string, extra: Partial<KnowledgeGenerationRunView> = {}): KnowledgeGenerationRunView {
  return { schemaVersion: 1, id, mode: "batch", createdAt: id, nodeId: null, prompt: "", engine: "codex", model: null, effort: null, treeHash: "tree", proposedTree: null,
    rationale: "", gaps: [], phase: "completed", error: null, active: false, activeItemId: null,
    items: [{ id: `item-${id}`, nodeId, title: nodeId, expectedHash: null, instructions: "", inheritedInstructions: "", status: "completed", revisionId: `revision-${id}`, error: null }], ...extra };
}

test("尚未建立规格库不会显示已采用或完整度分数", () => {
  const view = knowledgeOverview(null, [], []);
  assert.equal(view.initialized, false);
  assert.equal(view.documentCount, 0);
  assert.equal(view.adoptedCount, 0);
  assert.deepEqual(view.issues, []);
});

test("正式正文与引用计入已采用，候选仅计入待确认，目录不计文档", () => {
  const view = knowledgeOverview(snapshot([
    node("specs", { contentMode: "directory", category: "specifications" }),
    node("formal", { parentId: "specs" }), node("draft", { parentId: "specs" }),
    node("reference", { contentMode: "reference", reference: { path: "AGENTS.md", adoptedContentHash: "a".repeat(64) } }),
  ], [
    { nodeId: "formal", revisionId: "adopted", draftCount: 0, error: null },
    { nodeId: "draft", revisionId: null, draftCount: 1, error: null },
  ]), [], [{ nodeId: "draft", title: "draft", count: 2 }]);
  assert.equal(view.documentCount, 3);
  assert.equal(view.adoptedCount, 2);
  assert.equal(view.pendingCount, 1);
  assert.equal(view.emptyCount, 1);
  assert.equal(view.specificationCount, 1);
});

test("归档目录的后代不计入概览，活动失败仍保留真实错误", () => {
  const failed = run("2026-11-19", "active");
  failed.items[0]!.status = "failed";
  failed.items[0]!.error = { code: "ENGINE_FAILED", message: "读取来源失败" };
  const view = knowledgeOverview(snapshot([
    node("archived", { archived: true, contentMode: "directory" }), node("hidden", { parentId: "archived" }), node("active"),
  ]), [failed], []);
  assert.equal(view.documentCount, 1);
  assert.deepEqual(view.issues.filter(issue => issue.kind === "generation_failed").map(issue => [issue.nodeId, issue.detail]), [["active", "读取来源失败"]]);
});

test("仅展示最新相关任务复检问题，已通过的新复检不被旧失败覆盖", () => {
  const previous = run("2026-11-18", "rules");
  previous.items[0]!.review = { status: "failed", reportId: null, error: { code: "FAILED", message: "旧复检失败" } };
  const latest = run("2026-11-19", "rules");
  latest.items[0]!.review = { status: "passed", reportId: "passed", error: null };
  const view = knowledgeOverview(snapshot([node("rules")], [{ nodeId: "rules", revisionId: "revision-2026-11-19", draftCount: 0, error: null }]), [previous, latest], []);
  assert.equal(view.issues.some(issue => issue.kind.startsWith("review_")), false);
});

test("复检发现问题、依据过期和节点读取错误分别展示，不宣称代码已验证", () => {
  const review = run("2026-11-19", "rules");
  review.items[0]!.review = { status: "issues", reportId: "report", error: null, stale: true, staleReasons: ["来源内容已变化"] };
  const view = knowledgeOverview(snapshot([node("rules")], [{ nodeId: "rules", revisionId: "current", draftCount: 1, error: { code: "FILE_INVALID", message: "版本指针损坏" } }]), [review], []);
  assert.ok(view.issues.some(issue => issue.kind === "review_stale" && issue.detail.includes("来源内容已变化")));
  assert.ok(view.issues.some(issue => issue.kind === "state_error" && issue.detail === "版本指针损坏"));
  assert.equal(view.adoptedCount, 0);
});

test("已采用或明确不采用的历史候选不会继续制造当前失败待办", () => {
  const previous = run("2026-11-18", "rules", { phase: "failed", error: { code: "OLD", message: "历史批次失败" } });
  previous.items[0]!.review = { status: "issues", reportId: "old-report", error: null };
  previous.dismissals = [{ nodeId: "rules", revisionId: previous.items[0]!.revisionId, baseHash: null, fingerprint: "old", userId: "actor", createdAt: 1 }];
  const latest = run("2026-11-19", "rules");
  latest.items[0]!.review = { status: "passed", reportId: "current-report", error: null };
  const view = knowledgeOverview(snapshot([node("rules")], [{ nodeId: "rules", revisionId: latest.items[0]!.revisionId, draftCount: 0, error: null }]), [previous, latest], []);
  assert.deepEqual(view.issues, []);
  assert.equal(view.pendingCount, 0);
});

test("已停止任务的待复检保留入口，活动复检不重复当作失败", () => {
  const waiting = run("2026-11-19", "rules", { phase: "interrupted" });
  waiting.items[0]!.review = { status: "pending", reportId: null, error: null };
  const data = snapshot([node("rules")], [{ nodeId: "rules", revisionId: null, draftCount: 1, error: null }]);
  assert.ok(knowledgeOverview(data, [waiting], []).issues.some(issue => issue.kind === "review_pending"));
  assert.equal(knowledgeOverview(data, [{ ...waiting, active: true, activeItemId: waiting.items[0]!.id }], []).issues.some(issue => issue.kind === "review_pending"), false);
});
