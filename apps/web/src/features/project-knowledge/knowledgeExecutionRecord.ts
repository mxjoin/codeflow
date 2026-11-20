type Rule = { nodeId: string; title: string; revisionId: string | null; path: string; contentHash: string; scope: string };
type Evidence = { requirement: string; method: string; label: string; color: "error" | "warning" | "default"; commands: Array<{ itemId: string; command: string; exitCode: number | null }> };
export type KnowledgeExecutionRecord = { kind: "provided"; rules: Rule[]; paths: string[]; pendingScoped: Array<{ title: string; scope: string }> } | { kind: "evidence"; changed: boolean; checks: Evidence[] } | { kind: "error"; message: string };

/** 专用记录校验失败显式展示错误；普通工具交回原有展示，不猜测验证通过。 */
export function parseKnowledgeExecutionRecord(toolType: string, output?: string): KnowledgeExecutionRecord | null {
  if (!["项目规格已提供", "规格验证依据"].includes(toolType)) return null;
  try {
    const data = JSON.parse(output ?? "") as Record<string, unknown>;
    if (!data || typeof data !== "object") throw new Error("记录不是对象");
    if (toolType === "项目规格已提供") {
      if (!Array.isArray(data.rules) || !Array.isArray(data.paths)) throw new Error("缺少规格范围或版本记录");
      const pendingScoped = data.pendingScoped === undefined ? [] : data.pendingScoped;
      if (!Array.isArray(pendingScoped)) throw new Error("未提供的局部目录格式无效");
      return { kind: "provided", paths: data.paths.map(String), pendingScoped: pendingScoped.map(raw => {
        const scope = raw as Record<string, unknown>;
        if (!scope || typeof scope.title !== "string" || !Array.isArray(scope.appliesTo)) throw new Error("局部目录缺少适用范围");
        return { title: scope.title, scope: scope.appliesTo.join("、") };
      }), rules: data.rules.map(raw => {
        const rule = raw as Record<string, unknown>;
        if (!rule || typeof rule.title !== "string" || typeof rule.nodeId !== "string" || typeof rule.path !== "string" || typeof rule.contentHash !== "string" || !Array.isArray(rule.appliesTo)) throw new Error("规格元数据不完整");
        return { nodeId: rule.nodeId, title: rule.title, path: rule.path, contentHash: rule.contentHash, revisionId: typeof rule.revisionId === "string" ? rule.revisionId : null, scope: rule.appliesTo.length ? rule.appliesTo.join("、") : "全项目" };
      }) };
    }
    if (!Array.isArray(data.checks) || data.acceptance !== "needs_review" || !["changed", "unchanged"].includes(String(data.baselineStatus))) throw new Error("验收记录边界无效");
    const states = { failed: ["执行失败", "error"], execution_succeeded: ["执行成功，待核对覆盖", "warning"], unverified: ["尚未验证", "default"], needs_recheck: ["代码或规格变化，需复核", "warning"] } as const;
    return { kind: "evidence", changed: data.baselineStatus === "changed", checks: data.checks.map(raw => {
      const check = raw as Record<string, unknown>;
      if (!check || typeof check.requirement !== "string" || typeof check.method !== "string" || typeof check.status !== "string" || !Object.hasOwn(states, check.status) || !Array.isArray(check.evidence)) throw new Error("检查项格式或状态无效");
      const state = states[check.status as keyof typeof states];
      return { requirement: check.requirement, method: check.method, label: state[0], color: state[1], commands: check.evidence.map(raw => {
        const execution = raw as Record<string, unknown>;
        if (!execution || typeof execution.itemId !== "string" || typeof execution.command !== "string") throw new Error("执行引用不完整");
        return { itemId: execution.itemId, command: execution.command, exitCode: typeof execution.exitCode === "number" ? execution.exitCode : null };
      }) };
    }) };
  } catch (error) {
    return { kind: "error", message: `规格记录读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
