import type { KnowledgeAssetsSnapshot, KnowledgeGenerationRunView, KnowledgePendingChangeNode } from "@codeflowai/shared";
import { knowledgeSelectedNodes } from "./knowledgeTreeModel";
import { knowledgeLibraryTree, knowledgeResultRuns } from "./knowledgeWorkTreeModel";

export type KnowledgeOverviewIssue = {
  id: string;
  kind: "state_error" | "generation_failed" | "review_failed" | "review_issues" | "review_stale" | "review_pending" | "gap";
  nodeId: string | null;
  title: string;
  detail: string;
};

/** 概览只投影资产状态与任务事实，不计算主观完整度。 */
export function knowledgeOverview(snapshot: KnowledgeAssetsSnapshot | null, runs: KnowledgeGenerationRunView[], changes: KnowledgePendingChangeNode[]) {
  const nodes = snapshot?.tree.nodes ?? [];
  const visible = knowledgeSelectedNodes(nodes, nodes.map(node => node.id), false);
  const visibleIds = new Set(visible.map(node => node.id));
  const documents = visible.filter(node => node.contentMode !== "directory");
  const states = new Map(snapshot?.states.map(state => [state.nodeId, state]) ?? []);
  const tree = knowledgeLibraryTree(visible, snapshot?.states ?? [], runs, changes);
  const adopted = documents.filter(node => !states.get(node.id)?.error && (node.contentMode === "reference" || states.get(node.id)?.revisionId));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const specificationCount = adopted.filter(node => {
    const seen = new Set<string>();
    let current = node;
    while (current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) return false;
      current = parent;
    }
    return current.category === "specifications";
  }).length;
  const issues: KnowledgeOverviewIssue[] = [];
  for (const node of documents) {
    const error = states.get(node.id)?.error;
    if (error) issues.push({ id: `state:${node.id}`, kind: "state_error", nodeId: node.id, title: `${node.title}读取失败`, detail: error.message });
  }
  const latestNodes = new Set<string>();
  const ordered = knowledgeResultRuns(runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pendingResults = new Set(tree.updates.map(update => `${update.runId}:${update.nodeId}`));
  const latestScopes = new Set<string>();
  for (const run of ordered) {
    const scopeKey = JSON.stringify([run.mode, run.nodeId, [...(run.selectedNodeIds ?? [])].sort()]);
    const latestScope = !latestScopes.has(scopeKey);
    latestScopes.add(scopeKey);
    const unresolvedItems = run.items.some(item => pendingResults.has(`${run.id}:${item.nodeId}`));
    if (run.error && (run.active || latestScope && (!run.items.length || unresolvedItems))) issues.push({ id: `run:${run.id}`, kind: "generation_failed", nodeId: run.nodeId, title: "知识任务未完成", detail: run.error.message });
    for (const item of run.items) {
      if (latestNodes.has(item.nodeId) || !visibleIds.has(item.nodeId)) continue;
      const state = states.get(item.nodeId);
      if (item.revisionId && item.revisionId !== state?.revisionId && !pendingResults.has(`${run.id}:${item.nodeId}`)) continue;
      latestNodes.add(item.nodeId);
      if (item.error) issues.push({ id: `item:${run.id}:${item.id}`, kind: "generation_failed", nodeId: item.nodeId, title: `${item.title}生成失败`, detail: item.error.message });
      const review = item.review;
      if (!review || (item.reviewConfig ?? run.reviewConfig)?.enabled === false) continue;
      if (review.stale) issues.push({ id: `review:${run.id}:${item.id}`, kind: "review_stale", nodeId: item.nodeId, title: `${item.title}复检依据需核对`, detail: review.staleReasons?.join("；") || "正文或来源已变化，旧复检结论需要重新核对。" });
      else if (review.status === "failed") issues.push({ id: `review:${run.id}:${item.id}`, kind: "review_failed", nodeId: item.nodeId, title: `${item.title}复检失败`, detail: review.error?.message || "复检尚未完成，请查看任务记录。" });
      else if (review.status === "issues") issues.push({ id: `review:${run.id}:${item.id}`, kind: "review_issues", nodeId: item.nodeId, title: `${item.title}有复检问题`, detail: "复检报告发现需要处理的问题；请查看具体依据与修订建议。" });
      else if (!run.active && (review.status === "pending" || review.status === "repairing")) issues.push({ id: `review:${run.id}:${item.id}`, kind: "review_pending", nodeId: item.nodeId, title: `${item.title}复检尚未完成`, detail: "任务已停止，正文仍需完成复检；可查看候选并继续原任务。" });
    }
  }
  for (const [index, gap] of (ordered[0]?.gaps ?? []).entries()) {
    issues.push({ id: `gap:${ordered[0]!.id}:${index}`, kind: "gap", nodeId: ordered[0]!.nodeId, title: "检查记录的知识缺口", detail: gap });
  }
  return { initialized: snapshot?.initialized === true, documentCount: documents.length, adoptedCount: adopted.length,
    pendingCount: tree.pendingCount, emptyCount: documents.length - adopted.length, specificationCount,
    generatingCount: tree.generatingCount, issues };
}
