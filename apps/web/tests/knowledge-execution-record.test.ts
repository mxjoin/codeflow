import assert from "node:assert/strict";
import test from "node:test";
import { parseKnowledgeExecutionRecord } from "../src/features/project-knowledge/knowledgeExecutionRecord.js";

test("实际提供记录展示范围和版本，不将已提供误标为已验证", () => {
  const record = parseKnowledgeExecutionRecord("项目规格已提供", JSON.stringify({ turnId: "turn", paths: [], rules: [{ nodeId: "rule", title: "业务约束", revisionId: "rev-1", path: "rules.md", contentHash: "a".repeat(64), appliesTo: ["src"] }] }));
  assert.equal(record?.kind, "provided");
  if (record?.kind !== "provided") assert.fail("应返回提供记录");
  assert.equal(record.rules[0]?.scope, "src");
  assert.equal(record.rules[0]?.revisionId, "rev-1");
});

test("执行成功保留待验收语义，失败和需复核分别展示", () => {
  const record = parseKnowledgeExecutionRecord("规格验证依据", JSON.stringify({ baselineStatus: "changed", acceptance: "needs_review", checks: [
    { requirement: "失败即停止", method: "回归测试", status: "failed", evidence: [{ itemId: "run-1", command: "node --test", exitCode: 1 }] },
    { requirement: "账户隔离", method: "测试", status: "execution_succeeded", evidence: [{ itemId: "run-2", command: "node --test", exitCode: 0 }] },
    { requirement: "复用入口", method: "审查", status: "unverified", evidence: [] },
  ] }));
  if (record?.kind !== "evidence") assert.fail("应返回验证依据");
  assert.equal(record.changed, true);
  assert.deepEqual(record.checks.map(check => check.label), ["执行失败", "执行成功，待核对覆盖", "尚未验证"]);
});

test("损坏的专用记录显式返回错误，普通工具不进入规格渲染", () => {
  assert.equal(parseKnowledgeExecutionRecord("commandExecution", "normal output"), null);
  assert.equal(parseKnowledgeExecutionRecord("项目规格已提供", "not json")?.kind, "error");
  assert.equal(parseKnowledgeExecutionRecord("规格验证依据", '{"checks":[{"requirement":"伪造通过","status":"passed"}]}')?.kind, "error");
  for (const status of ["constructor", "toString", "__proto__"]) {
    assert.equal(parseKnowledgeExecutionRecord("规格验证依据", JSON.stringify({ baselineStatus: "unchanged", acceptance: "needs_review", checks: [
      { requirement: "失败即停止", method: "测试", status, evidence: [] },
    ] }))?.kind, "error");
  }
});
