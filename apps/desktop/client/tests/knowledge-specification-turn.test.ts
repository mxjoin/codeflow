import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { ConversationEventInput } from "@codeflowai/shared";
import { KnowledgeAssetStore, knowledgeCategoryNodes } from "../src/knowledge/knowledgeAssetStore.js";
import { createKnowledgeSpecificationTurn } from "../src/knowledge/knowledgeSpecificationTurn.js";

/** 使用真实文件资产和正式规格，事件仅替代引擎执行边界。 */
function project(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "specification-turn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const value = 1;\n", "utf8");
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), {
    id: "spec", parentId: "knowledge-specifications", title: "业务要求", orderKey: "0", summary: "", instructions: "", tags: [], sourceScope: [], contentMode: "generated", appliesTo: ["src"],
  }] }, null);
  store.saveDocument({ nodeId: "spec", content: "失败时不得继续写入。", sources: [], expectedHash: null, origin: "manual", adopt: true });
  const events: ConversationEventInput[] = [];
  const turn = createKnowledgeSpecificationTurn({ store, specifications: store.rules(["src"]), workspaceId: "ws", threadId: "thread", turnId: "turn", engine: "codex", userRequirements: "修改失败路径，保留旧行为。", isActive: () => true, emit: event => events.push(event) });
  return { root, store, turn, events };
}

/** 事件代表真实引擎回传，结果不可由验收工具参数自行声明。 */
function command(turn: ReturnType<typeof createKnowledgeSpecificationTurn>, id: string, exitCode: number, command = "node --test") {
  const base = { ts: Date.now(), workspaceId: "ws", threadId: "thread", engine: "codex" } as const;
  turn.observe({ ...base, type: "item.tool.started", payload: { itemId: id, toolName: "commandExecution", input: { command } } } as ConversationEventInput);
  turn.observe({ ...base, type: "item.tool.completed", payload: { itemId: id, toolName: "commandExecution", status: exitCode === 0 ? "completed" : "failed", output: { exitCode, stdout: "运行输出" } } } as ConversationEventInput);
}

test("实际提供记录包含正文指纹和适用范围，同内容读取不制造新的加载事件", t => {
  const { store, turn, events } = project(t);
  turn.provided();
  turn.recordRules(store.rules(["src/a.ts"]), ["src/a.ts"]);
  turn.recordRules(store.rules(["src/a.ts"]), ["src/a.ts"]);
  assert.equal(events.filter(event => event.type === "item.tool.completed").length, 2);
  const text = JSON.stringify(events);
  assert.match(text, /contentHash/);
  assert.match(text, /revisionId/);
  assert.match(text, /src\/a.ts/);
  assert.doesNotMatch(text, /验证通过/);
});

test("验收只关联本轮真实命令事件，失败和未验证不能伪造成通过", t => {
  const { turn } = project(t);
  turn.provided();
  command(turn, "failed-test", 1);
  const report = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "失败分支测试", evidenceItemIds: ["failed-test"] }] });
  assert.equal(report.output.checks[0].status, "failed");
  assert.throws(() => turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "失败测试", evidenceItemIds: ["invented"] }] }), /本轮.*执行/);
  const missing = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "人工检查", evidenceItemIds: [] }] });
  assert.equal(missing.output.checks[0].status, "unverified");
  assert.throws(() => turn.record({ checks: [{ nodeId: "spec", requirement: "不存在的业务要求", method: "测试", evidenceItemIds: [] }] }), /原文/);
});

test("执行成功只表示检查运行成功，修复重跑保留旧失败记录", t => {
  const { turn, events } = project(t);
  command(turn, "run-1", 1);
  turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "回归测试", evidenceItemIds: ["run-1"] }] });
  command(turn, "run-2", 0);
  const result = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "回归测试", evidenceItemIds: ["run-2"] }] });
  assert.equal(result.output.checks[0].status, "execution_succeeded");
  assert.equal(result.output.acceptance, "needs_review");
  const reports = events.filter(event => event.type === "item.tool.completed" && event.payload.toolName === "规格验证依据");
  assert.equal(reports.length, 2);
  assert.match(JSON.stringify(reports[0]), /failed/);
});

test("验收核对引用原文和新增规则集合，不只比较文档版本", t => {
  const { root, store, turn } = project(t);
  command(turn, "before", 0);
  store.saveDocument({ nodeId: "spec", content: "失败时不得继续写入。新增金额检查。", sources: [], expectedHash: store.currentHash("spec"), origin: "manual", adopt: true });
  const changed = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "测试", evidenceItemIds: ["before"] }] });
  assert.equal(changed.output.baselineStatus, "changed");
  assert.equal(changed.output.checks[0].status, "needs_recheck");
  fs.writeFileSync(path.join(root, "reference.md"), "引用要求一。", "utf8");
  store.importFile({ path: "reference.md", contentHash: store.readSource("reference.md").contentHash, parentId: "knowledge-specifications", treeHash: store.readTree().hash, category: "specifications" });
  const freshEvents: ConversationEventInput[] = [];
  const referenceTurn = createKnowledgeSpecificationTurn({ store, specifications: store.rules(["src"]), workspaceId: "ws", threadId: "thread", turnId: "reference-turn", engine: "codex", userRequirements: "", isActive: () => true, emit: event => freshEvents.push(event) });
  command(referenceTurn, "reference-test", 0);
  fs.writeFileSync(path.join(root, "reference.md"), "引用要求二。", "utf8");
  assert.equal(referenceTurn.record({ checks: [] }).output.baselineStatus, "changed");
});

test("代码在执行后变化时要求复核，其他回合与助手自述不能作为本轮证据", t => {
  const { root, turn } = project(t);
  command(turn, "before-code-change", 0);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const value = 2;\n", "utf8");
  turn.observe({ ts: Date.now(), workspaceId: "ws", threadId: "thread", engine: "codex", type: "item.tool.completed", payload: { itemId: "write-after-run", toolName: "fileChange", status: "completed", changes: [{ path: "src/a.ts" }] } } as ConversationEventInput);
  turn.observe({ ts: Date.now(), workspaceId: "other", threadId: "other", engine: "codex", type: "item.tool.completed", payload: { itemId: "outside", toolName: "commandExecution", status: "completed", output: { exitCode: 0 } } } as ConversationEventInput);
  const changed = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "回归测试", evidenceItemIds: ["before-code-change"] }] });
  assert.equal(changed.output.checks[0].status, "needs_recheck");
  assert.throws(() => turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "测试", evidenceItemIds: ["outside"] }] }), /本轮.*执行/);
  turn.observe({ ts: Date.now(), workspaceId: "ws", threadId: "thread", engine: "codex", type: "item.tool.started", payload: { turnId: "previous", itemId: "previous-command", toolName: "commandExecution" } } as unknown as ConversationEventInput);
  assert.throws(() => turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "测试", evidenceItemIds: ["previous-command"] }] }), /本轮.*执行/);
});

test("普通命令观察不扫描无关大文件，派发前没有伪造已提供记录", t => {
  const { root, turn, events } = project(t);
  assert.equal(events.length, 0);
  fs.writeFileSync(path.join(root, "unrelated.zip"), Buffer.alloc(33 * 1024 * 1024));
  assert.doesNotThrow(() => command(turn, "status-only", 0, "git status"));
  assert.ok(events.some(event => event.type === "item.tool.completed" && event.payload.toolName === "项目规格已提供"));
});

test("范围补读新版本后后续事件不会用回合初始正文覆盖实际提供记录", t => {
  const { store, turn } = project(t);
  turn.provided();
  store.saveDocument({ nodeId: "spec", content: "失败时必须停止结算。", sources: [], origin: "manual", expectedHash: store.currentHash("spec"), adopt: true });
  turn.recordRules(store.rules(["src/a.ts"]), ["src/a.ts"]);
  command(turn, "new-version-test", 0);
  const result = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时必须停止结算。", method: "新版本回归", evidenceItemIds: ["new-version-test"] }] });
  assert.equal(result.output.baselineStatus, "unchanged");
  assert.equal(result.output.checks[0].status, "execution_succeeded");
});

test("已核对路径最初没有局部规则时，后来新增适用规格仍标记基线变化", t => {
  const { store, turn } = project(t);
  turn.provided();
  turn.recordRules(store.rules(["other/file.ts"]), ["other/file.ts"]);
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: [...tree.tree.nodes, { id: "new-scope", parentId: "knowledge-specifications", title: "新增范围", orderKey: "2", summary: "", instructions: "", sourceScope: [], tags: [], appliesTo: ["other"], contentMode: "generated" }] }, tree.hash);
  store.saveDocument({ nodeId: "new-scope", content: "新增目录要求。", expectedHash: null, origin: "manual", sources: [], adopt: true });
  assert.equal(turn.record({ checks: [] }).output.baselineStatus, "changed");
});

test("验证依据保留命令事件标识但不复制命令中的凭据", t => {
  const { turn } = project(t);
  command(turn, "secret-command", 0, 'node verify.js --token demo-sensitive-token API_KEY=demo-sensitive-key');
  const record = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "执行检查", evidenceItemIds: ["secret-command"] }] });
  assert.match(JSON.stringify(record), /secret-command/);
  assert.doesNotMatch(JSON.stringify(record), /demo-sensitive-token|demo-sensitive-key/);
});

test("精确文件范围的基线核对不扩大到同一父目录的其他模块规则", t => {
  const { store } = project(t);
  const tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: [...tree.tree.nodes, { id: "sibling", parentId: "knowledge-specifications", title: "其他模块", orderKey: "2", summary: "", instructions: "", sourceScope: [], tags: [], appliesTo: ["src/sibling"], contentMode: "generated" }] }, tree.hash);
  store.saveDocument({ nodeId: "sibling", content: "其他模块的局部约束。", expectedHash: null, origin: "manual", sources: [], adopt: true });
  const turn = createKnowledgeSpecificationTurn({ store, specifications: store.rules(["src/target/a.ts"]), workspaceId: "ws", threadId: "thread", turnId: "turn", engine: "codex", userRequirements: "", isActive: () => true, emit: () => {} });
  command(turn, "target-test", 0);
  const report = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "目标模块测试", evidenceItemIds: ["target-test"] }] });
  assert.equal(report.output.baselineStatus, "unchanged");
  assert.equal(report.output.checks[0].status, "execution_succeeded");
});

test("局部规则归档后重新读取能移除旧基线，同时保留其他已读范围", t => {
  const { store, turn } = project(t);
  turn.provided();
  let tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: [...tree.tree.nodes, { id: "other-scope", parentId: "knowledge-specifications", title: "其他范围", orderKey: "3", summary: "", instructions: "", sourceScope: [], tags: [], appliesTo: ["other"], contentMode: "generated" }] }, tree.hash);
  store.saveDocument({ nodeId: "other-scope", content: "其他范围仍须鉴权。", expectedHash: null, origin: "manual", sources: [], adopt: true });
  turn.recordRules(store.rules(["other/file.ts"]), ["other/file.ts"]);
  tree = store.readTree();
  store.saveTree({ ...tree.tree, nodes: tree.tree.nodes.map(node => node.id === "spec" ? { ...node, archived: true } : node) }, tree.hash);
  assert.equal(turn.record({ checks: [] }).output.baselineStatus, "changed");
  turn.recordRules(store.rules(["src/a.ts"]), ["src/a.ts"]);
  assert.equal(turn.record({ checks: [] }).output.baselineStatus, "unchanged");
  assert.equal(turn.record({ checks: [{ nodeId: "other-scope", requirement: "其他范围仍须鉴权。", method: "待审查", evidenceItemIds: [] }] }).output.checks[0].status, "unverified");
  assert.throws(() => turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "旧要求", evidenceItemIds: [] }] }), /原文/);
});

test("新初始化且尚无提交的 Git 项目仍可记录真实验证依据", t => {
  const { root, turn } = project(t);
  const result = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  command(turn, "new-project-test", 0);
  const report = turn.record({ checks: [{ nodeId: "spec", requirement: "失败时不得继续写入。", method: "新项目测试", evidenceItemIds: ["new-project-test"] }] });
  assert.equal(report.output.checks[0].status, "execution_succeeded");
  assert.match(report.output.codeHash, /^[a-f0-9]{64}$/);
});
