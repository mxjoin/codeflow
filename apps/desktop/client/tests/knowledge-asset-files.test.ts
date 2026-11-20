import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeAssetStore, knowledgeCategoryNodes, withKnowledgeDocumentDefaults } from "../src/knowledge/knowledgeAssetStore.js";
import { isKnowledgeRateLimitError, KnowledgeAssetError, knowledgeFailure, knowledgeHash, knowledgeJson, requireKnowledgeAssetActorContext } from "../src/knowledge/knowledgeAssetFiles.js";
import { executeKnowledgeAssetReadTool } from "../src/knowledge/knowledgeAssetTools.js";

/** 默认知识树：三个固定分类、八份规格和三份架构文档，读取时自动补齐。 */
function defaultTreeNodes() {
  return withKnowledgeDocumentDefaults({ schemaVersion: 3, instructions: "", nodes: knowledgeCategoryNodes() }).nodes;
}

test("知识资产身份仅接受三种现行账号角色，拒绝退役、缺失和非法身份", () => {
  const actor = { userId: "actor-1", accountRole: "personal_normal", enterpriseId: null, requestId: "identity-test", permissionScope: "account" };
  for (const accountRole of ["personal_normal", "enterprise_admin", "super_admin"]) {
    assert.deepEqual(requireKnowledgeAssetActorContext({ ...actor, accountRole }), { ...actor, accountRole });
  }
  for (const accountRole of ["user", "", null, undefined, "unknown", "system"]) {
    assert.throws(() => requireKnowledgeAssetActorContext({ ...actor, accountRole }), { code: "KNOWLEDGE_ASSET_PERMISSION_DENIED" });
  }
});

function createProject(): { root: string; store: KnowledgeAssetStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-assets-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "members.ts"), "export function inviteMember() { return true; }\n", "utf8");
  return { root, store: new KnowledgeAssetStore(root) };
}

test("人工保存相同正文和来源保留正式版本及候选基线，行尾差异不制造版本", t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: defaultTreeNodes() }, null);
  const source = store.readSource("src/members.ts");
  const sources = [{ kind: "code", path: source.path, contentHash: source.contentHash, relation: "统一实现入口" }];
  const first = store.saveDocument({ nodeId: "knowledge-spec-coding", content: "# 编码规范\n\n复用已有入口。\n", sources, expectedHash: null, origin: "manual", adopt: true });
  const expectedHash = store.currentHash(first.nodeId);
  const saved = store.saveDocument({ nodeId: first.nodeId, content: "# 编码规范\r\n\r\n复用已有入口。\r\n", sources, expectedHash, origin: "manual", summary: "再次保存", adopt: true });
  assert.equal(saved.id, first.id);
  assert.equal(store.currentHash(first.nodeId), expectedHash);
  assert.equal(store.revisions(first.nodeId).length, 1);
  assert.deepEqual(store.detail(first.nodeId).current?.sources, sources);
  assert.throws(() => store.saveDocument({ nodeId: first.nodeId, content: "# 编码规范\n\n复用已有入口。\n", sources, expectedHash: "0".repeat(64), origin: "manual", adopt: true }), { code: "KNOWLEDGE_ASSET_CONFLICT" });
});

test("人工修改正文或来源仍保存新版本，未传生成指令时保留原版本要求", t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: defaultTreeNodes() }, null);
  const first = store.saveDocument({ nodeId: "knowledge-spec-coding", content: "失败明确抛出。", sources: [], instructions: "保留失败边界", expectedHash: null, origin: "manual", adopt: true });
  const updated = store.saveDocument({ nodeId: first.nodeId, content: "失败明确抛出，停止后续副作用。", sources: [], expectedHash: store.currentHash(first.nodeId), origin: "manual", adopt: true });
  assert.notEqual(updated.id, first.id);
  assert.equal(updated.instructions, "保留失败边界");
  assert.equal(updated.baseRevisionId, first.id);
  const evidence = [{ kind: "requirement", requirement: "失败时停止后续副作用。", relation: "用户明确要求" }];
  const changed = store.saveDocument({ nodeId: first.nodeId, content: "失败明确抛出，停止后续副作用。", sources: evidence, expectedHash: store.currentHash(first.nodeId), origin: "manual", adopt: true });
  assert.notEqual(changed.id, updated.id);
  assert.deepEqual(store.detail(first.nodeId).current?.sources, evidence);
});

test("同步只读检查复用文件与安全路径，嵌套检查保持读取上限且下次读取外部新内容", t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "src", "members.ts");
  const read = t.mock.method(fs, "readFileSync");
  store.files.withReadCache(() => {
    const first = store.files.read("src/members.ts").toString("utf8");
    store.files.withReadCache(() => assert.equal(store.files.read("src/members.ts").toString("utf8"), first));
    assert.throws(() => store.files.read("src/members.ts", 1), { code: "KNOWLEDGE_ASSET_FILE_INVALID" });
    assert.equal(read.mock.calls.filter(call => call.arguments[0] === file).length, 1);
  });
  fs.writeFileSync(file, "export const changed = true;\n", "utf8");
  assert.match(store.files.withReadCache(() => store.readSource("src/members.ts").content), /changed/);
  fs.unlinkSync(file);
  assert.throws(() => store.files.withReadCache(() => store.readSource("src/members.ts")), { code: "KNOWLEDGE_ASSET_NOT_FOUND" });
});

test("只读检查失败后释放缓存并禁止写入，后续写事务仍能正常执行", t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => store.files.withReadCache(() => {
    store.files.read("src/members.ts");
    assert.throws(() => store.files.write("src/members.ts", "invalid"), { code: "KNOWLEDGE_ASSET_CONFLICT" });
    assert.throws(() => store.files.mutate(() => {}), { code: "KNOWLEDGE_ASSET_CONFLICT" });
    throw new Error("injected read failure");
  }), /injected read failure/);
  store.files.mutate(() => store.files.write("src/members.ts", "export const recovered = true;\n"));
  assert.match(store.files.withReadCache(() => store.readSource("src/members.ts").content), /recovered/);
});

test("后续检查重新校验被替换的目录链接，拒绝项目外目标", t => {
  const { root, store } = createProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-outside-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const alias = path.join(root, "alias"), type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(path.join(root, "src"), alias, type);
  assert.match(store.files.withReadCache(() => store.readSource("alias/members.ts").content), /inviteMember/);
  fs.unlinkSync(alias);
  fs.symlinkSync(outside, alias, type);
  assert.throws(() => store.files.withReadCache(() => store.readSource("alias/members.ts")), { code: "KNOWLEDGE_ASSET_PATH_INVALID" });
});

for (const cacheBody of [false, true]) test(`同次检查${cacheBody ? "已缓存正文" : "仅校验路径"}后替换目录链接，拒绝越界及敏感目标`, t => {
  const { root, store } = createProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-outside-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const sensitive = path.join(root, ".aws"), alias = path.join(root, "alias");
  fs.mkdirSync(sensitive);
  const type = process.platform === "win32" ? "junction" : "dir";
  for (const target of [outside, sensitive]) {
    fs.writeFileSync(path.join(target, "members.ts"), "外部测试内容，不应被读取。\n", "utf8");
    fs.symlinkSync(path.join(root, "src"), alias, type);
    store.files.withReadCache(() => {
      if (cacheBody) store.readSource("alias/members.ts");
      else store.sourcePath("alias/members.ts");
      fs.unlinkSync(alias);
      fs.symlinkSync(target, alias, type);
      assert.throws(() => store.readSource("alias/members.ts"), { code: "KNOWLEDGE_ASSET_PATH_INVALID" });
      assert.throws(() => store.files.read("alias/members.ts"), { code: "KNOWLEDGE_ASSET_PATH_INVALID" });
    });
    fs.unlinkSync(alias);
  }
});

for (const failedFile of ["knowledge.json", "tree.json"]) {
  test(`引用导入在 ${failedFile} 写入失败时不发布节点，原文件保留且可重试`, t => {
    const { root, store } = createProject();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "README.md"), "# 导入正文\n", "utf8");
    const input = { path: "README.md", contentHash: store.importFiles().files[0]!.contentHash, parentId: null, treeHash: null };
    const write = store.files.write.bind(store.files);
    const mock = t.mock.method(store.files, "write", (relative: string, value: string) => {
      assert.deepEqual(store.readTree().tree.nodes, defaultTreeNodes(), "完整交付前仅默认导航可见");
      if (relative.endsWith(`/${failedFile}`)) throw new Error(`injected ${failedFile} failure`);
      return write(relative, value);
    });
    assert.throws(() => store.importFile(input), new RegExp(`injected ${failedFile}`));
    assert.deepEqual(store.snapshot().tree.nodes, defaultTreeNodes());
    assert.deepEqual(store.files.directories(`${store.root}/assets`), []);
    mock.mock.restore();
    const imported = store.importFile(input);
    assert.equal(store.snapshot().tree.nodes.length, defaultTreeNodes().length + 1);
    assert.equal(store.detail(imported.id).reference!.content, "# 导入正文\n");
    assert.deepEqual(store.revisions(imported.id), []);
  });
}

test("重复导入保留原目录，跨目录时明确提示位置且不新增版本", t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), ...["first", "second"].map(id => ({ id, parentId: "knowledge-product", title: id === "first" ? "原目录" : "新目录", orderKey: id, summary: "", tags: [], instructions: "", sourceScope: [], contentMode: "directory" }))] }, null);
  fs.writeFileSync(path.join(root, "README.md"), "# 文档\n", "utf8");
  const input = { path: "README.md", contentHash: store.importFiles().files[0]!.contentHash, parentId: "first", treeHash: store.readTree().hash };
  const imported = store.importFile(input);
  const hash = store.currentHash(imported.id);
  assert.equal(store.importFile({ ...input, treeHash: store.readTree().hash }).id, imported.id);
  assert.throws(() => store.importFile({ ...input, parentId: "second", treeHash: store.readTree().hash }), /已导入到「产品文档 \/ 原目录」/);
  assert.equal(store.node(imported.id).parentId, "first");
  assert.equal(store.revisions(imported.id).length, 0);
  assert.equal(store.currentHash(imported.id), hash);
  fs.writeFileSync(path.join(root, "README.md"), "# 新版文档\n", "utf8");
  const updated = { ...input, contentHash: store.importFiles().files[0]!.contentHash, treeHash: store.readTree().hash };
  store.importFile(updated);
  store.importFile(updated);
  assert.equal(store.detail(imported.id).drafts.length, 0, "引用不产生正文副本或待采用版本");
  assert.equal(store.detail(imported.id).reference?.content, "# 新版文档\n");
});

test("导入入口拒绝通过项目内别名或大小写变体自导入知识库", t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [] }, null);
  fs.symlinkSync(path.join(root, store.root), path.join(root, "knowledge-alias"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => store.importFiles("knowledge-alias"), /不能从项目知识目录/);
  if (process.platform === "win32") assert.throws(() => store.importFiles(store.root.toUpperCase()), /不能从项目知识目录/);
});

test("来源按链接真实目标过滤敏感目录，正常项目规则链接仍可读取", t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".claude/rules"), { recursive: true });
  fs.symlinkSync(path.join(root, "src"), path.join(root, ".claude/rules/allowed"), process.platform === "win32" ? "junction" : "dir");
  const allowed = ".claude/rules/allowed/members.ts";
  assert.match(store.readSource(allowed).content, /inviteMember/);
  assert.equal(store.listFiles(".claude/rules/allowed").entries[0]!.path, allowed);
  for (const [index, directory] of [".aws", ".env", ".ssh"].entries()) {
    fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, directory, "config.md"), "测试占位内容，不是真实凭据。", "utf8");
    const alias = `.claude/rules/linked-${index}`;
    fs.symlinkSync(path.join(root, directory), path.join(root, alias), process.platform === "win32" ? "junction" : "dir");
    const sourcePath = `${alias}/config.md`;
    const forbidden = { code: "KNOWLEDGE_ASSET_PATH_INVALID" };
    assert.throws(() => executeKnowledgeAssetReadTool(store, "knowledge.source.read", { path: sourcePath }), forbidden);
    assert.throws(() => executeKnowledgeAssetReadTool(store, "knowledge.source.read", { path: alias }), forbidden);
    assert.throws(() => executeKnowledgeAssetReadTool(store, "knowledge.source.list", { directory: alias }), forbidden);
    for (const checkHash of [false, true]) assert.throws(() => store.parseSources([{ kind: "document", path: sourcePath, contentHash: "a".repeat(64), relation: "不可读取的测试来源" }], checkHash), forbidden);
  }
});

test("原始来源排除正式和候选知识产物及其别名，专用版本接口仍可读取", t => {
  for (const docsRoot of ["codeflow-docs", "project-docs"]) {
    const { root } = createProject();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (docsRoot !== "codeflow-docs") {
      fs.mkdirSync(path.join(root, ".codeflowai"));
      fs.writeFileSync(path.join(root, ".codeflowai/codeflowai.json"), JSON.stringify({ paths: { workflowDocsRoot: docsRoot } }), "utf8");
    }
    const store = new KnowledgeAssetStore(root);
    store.saveTree({ schemaVersion: 2, instructions: "", nodes: [{ id: "members", parentId: null, title: "成员", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: ["src"], contentMode: "generated" }] }, null);
    const current = store.saveDocument({ nodeId: "members", content: "# 正式正文", sources: [], expectedHash: null, origin: "manual" });
    const draft = store.saveDocument({ nodeId: "members", content: "# 未采用正文", sources: [], expectedHash: store.currentHash("members"), origin: "ai", adopt: false });
    const currentPath = store.readRevision("members", current.id).path;
    const draftPath = store.readRevision("members", draft.id).path;
    const alias = "knowledge-alias";
    fs.symlinkSync(path.join(root, store.root), path.join(root, alias), process.platform === "win32" ? "junction" : "dir");
    fs.writeFileSync(path.join(root, docsRoot, "guide.md"), "# 原始项目资料", "utf8");
    assert.deepEqual(store.listFiles(docsRoot).entries.map(entry => entry.path), [`${docsRoot}/guide.md`]);
    assert.match(store.readSource(`${docsRoot}/guide.md`).content, /原始项目资料/);
    const forbidden = { code: "KNOWLEDGE_ASSET_PATH_INVALID" };
    for (const sourcePath of [currentPath, draftPath, `${store.root}/tree.json`, `${alias}/tree.json`, draftPath.replace(store.root, alias)]) {
      assert.throws(() => executeKnowledgeAssetReadTool(store, "knowledge.source.read", { path: sourcePath }), forbidden);
      const source = { kind: "document", path: sourcePath, contentHash: "a".repeat(64), relation: "知识产物不能证明原始事实" };
      assert.throws(() => store.parseSources([source], false), forbidden);
      assert.throws(() => store.saveDocument({ nodeId: "members", content: "错误的新版本", sources: [source], expectedHash: store.currentHash("members"), origin: "ai" }), forbidden);
    }
    for (const directory of [store.root, alias]) {
      assert.throws(() => executeKnowledgeAssetReadTool(store, "knowledge.source.list", { directory }), forbidden);
      assert.throws(() => executeKnowledgeAssetReadTool(store, "knowledge.source.read", { path: directory }), forbidden);
    }
    const detail = executeKnowledgeAssetReadTool(store, "knowledge.node.read", { nodeId: "members" }).output as ReturnType<KnowledgeAssetStore["detail"]>;
    assert.equal(detail.current!.revision.id, current.id);
    assert.deepEqual(detail.drafts.map(revision => revision.id), [draft.id]);
    assert.match((executeKnowledgeAssetReadTool(store, "knowledge.revision.read", { nodeId: "members", revisionId: draft.id }).output as { content: string }).content, /未采用正文/);
    assert.equal(store.revisions("members").length, 2);
  }
});

test("项目知识文件协议支持跨 Client 读取、来源指纹和变更提示", () => {
  const { root, store } = createProject();
  const tree = {
    schemaVersion: 1 as const,
    instructions: "项目默认要求",
    nodes: [{ id: "members", parentId: null, title: "成员管理", orderKey: "0001", summary: "成员操作", tags: [], instructions: "覆盖按钮和字段", sourceScope: ["src"] }],
  };
  const saved = store.saveTree(tree, null);
  const source = store.readSource("src/members.ts");
  const revision = store.saveDocument({
    nodeId: "members",
    content: "# 成员管理\n\n邀请按钮调用 inviteMember。",
    sources: [{ kind: "code", path: "src/members.ts", symbol: "inviteMember", contentHash: source.contentHash, relation: "邀请成员实现" }],
    expectedHash: null,
    origin: "ai",
    summary: "成员操作文档",
  });
  const secondClient = new KnowledgeAssetStore(root);
  assert.equal(secondClient.snapshot().treeHash, saved.hash);
  assert.equal(secondClient.detail("members").current?.revision.id, revision.id);
  assert.equal(secondClient.search("邀请").items[0]?.nodeId, "members");
  fs.appendFileSync(path.join(root, "src", "members.ts"), "// changed\n", "utf8");
  assert.equal(secondClient.detail("members").freshness[0]?.state, "changed");
});

test("正式版本链精确追溯单篇采纳后的人工编辑，不关联未采纳候选", async t => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "members", parentId: null, title: "成员", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: ["src"] }] }, null);
  store.saveDocument({ nodeId: "members", content: "初始正文", sources: [], expectedHash: null, origin: "manual" });
  assert.equal(store.detail("members").sourceRevision, null);
  const unrelated = store.saveDocument({ nodeId: "members", content: "更早的未采纳版本", sources: [], expectedHash: store.currentHash("members"), origin: "ai", runId: "run-unused", adopt: false });
  await new Promise(resolve => setTimeout(resolve, 5));
  const first = store.saveDocument({ nodeId: "members", content: "生成版本 A", sources: [], expectedHash: store.currentHash("members"), origin: "ai", runId: "run-a", adopt: false });
  store.adopt("members", first.id, store.currentHash("members"));
  const newerUnrelated = store.saveDocument({ nodeId: "members", content: "较新的未采纳版本", sources: [], expectedHash: store.currentHash("members"), origin: "ai", runId: "run-unused-newer", adopt: false });
  store.saveDocument({ nodeId: "members", content: "人工修订 A1", sources: [], expectedHash: store.currentHash("members"), origin: "manual", adopt: true });
  store.saveDocument({ nodeId: "members", content: "人工修订 A2", sources: [], expectedHash: store.currentHash("members"), origin: "manual", runId: "approved-change", adopt: true });
  fs.unlinkSync(path.join(root, store.root, "assets", "members", "revisions", unrelated.id, "content.md"));
  fs.unlinkSync(path.join(root, store.root, "assets", "members", "revisions", newerUnrelated.id, "content.md"));
  assert.deepEqual(new KnowledgeAssetStore(root).detail("members").sourceRevision, { runId: "run-a", revisionId: first.id });
  const manualId = store.currentRevisionId("members")!;
  const metadataFile = path.join(root, store.root, "assets", "members", "revisions", manualId, "revision.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  delete metadata.baseRevisionId;
  const metadataText = knowledgeJson(metadata);
  fs.writeFileSync(metadataFile, metadataText, "utf8");
  fs.writeFileSync(path.join(root, store.root, "assets", "members", "current.json"), knowledgeJson({ revisionId: manualId, revisionHash: knowledgeHash(metadataText) }), "utf8");
  assert.deepEqual(new KnowledgeAssetStore(root).detail("members").sourceRevision, { runId: "run-a", revisionId: first.id });
  const second = store.saveDocument({ nodeId: "members", content: "生成版本 B", sources: [], expectedHash: store.currentHash("members"), origin: "ai", runId: "run-b", adopt: false });
  store.adopt("members", second.id, store.currentHash("members"));
  store.saveDocument({ nodeId: "members", content: "人工修订 B", sources: [], expectedHash: store.currentHash("members"), origin: "manual", adopt: true });
  store.saveDocument({ nodeId: "members", content: "未采纳版本 C", sources: [], expectedHash: store.currentHash("members"), origin: "ai", runId: "run-c", adopt: false });
  assert.deepEqual(store.detail("members").sourceRevision, { runId: "run-b", revisionId: second.id });
});

test("知识文件被外部改写成 CRLF 后仍能读取、复检待采用状态并保持版本基线", () => {
  const { store } = createProject();
  const tree = { schemaVersion: 1 as const, instructions: "", nodes: [{ id: "members", parentId: null, title: "成员管理", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] };
  store.saveTree(tree, null);
  const content = "# 成员管理\n\n邀请按钮调用 inviteMember。";
  const revision = store.saveDocument({ nodeId: "members", content, sources: [], expectedHash: null, origin: "ai" });
  const draft = store.saveDocument({ nodeId: "members", content: `${content}\n`, sources: [], expectedHash: store.detail("members").currentHash, origin: "ai", adopt: false });
  const baseline = store.detail("members").currentHash;
  const treeHash = store.readTree().hash;
  assert.equal(store.snapshot().states.find(state => state.nodeId === "members")?.draftCount, 1);

  // 模拟 Windows 检出（core.autocrlf）把行尾全部改成 CRLF。
  const toCrlf = (relative: string) => store.files.write(relative, store.files.read(relative).toString("utf8").replace(/\n/g, "\r\n"));
  for (const id of [revision.id, draft.id]) for (const file of ["content.md", "sources.json", "revision.json"]) toCrlf(`${store.root}/assets/members/revisions/${id}/${file}`);
  toCrlf(`${store.root}/assets/members/current.json`);
  toCrlf(`${store.root}/tree.json`);

  assert.equal(store.detail("members").current?.content, content);
  assert.equal(store.detail("members").currentHash, baseline);
  assert.equal(store.readTree().hash, treeHash);
  assert.equal(store.snapshot().states.find(state => state.nodeId === "members")?.draftCount, 1);
  assert.doesNotThrow(() => store.saveDocument({ nodeId: "members", content: `${content}\n`, sources: [], expectedHash: baseline, origin: "ai" }));
  assert.doesNotThrow(() => store.saveTree(tree, treeHash));
});

test("导入预览默认浏览项目根，无知识目录也能发现根文档和子目录且不创建文件", (t) => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "README.md"), "# 项目说明\n", "utf8");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# 使用指南\n", "utf8");
  const entries = fs.readdirSync(root);

  const listing = store.importFiles();
  assert.deepEqual(listing.files.map(file => file.path), ["README.md"]);
  assert.deepEqual(listing.directories, ["docs", "src"]);
  assert.deepEqual(store.importFiles(""), listing);
  assert.deepEqual(store.importFiles("docs").files.map(file => file.path), ["docs/guide.md"]);
  assert.deepEqual(fs.readdirSync(root), entries);
  assert.equal(fs.existsSync(path.join(root, "codeflow-docs")), false);
});

test("导入预览区分空目录与无效路径，并继续拒绝知识库自身和越界路径", (t) => {
  const { root, store } = createProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "empty"));
  assert.deepEqual(store.importFiles("empty"), { files: [], directories: [], nextOffset: null });
  assert.throws(() => store.importFiles("codeflow-docs"), (error: unknown) => {
    assert.ok(error instanceof KnowledgeAssetError);
    assert.equal(error.code, "KNOWLEDGE_ASSET_NOT_FOUND");
    assert.equal(error.status, 404);
    assert.match(error.message, /检查路径或返回项目根目录/u);
    assert.doesNotMatch(error.message, /knowledge\.source/u);
    return true;
  });
  assert.throws(() => store.importFiles("../outside"), /项目内的相对路径/u);
  fs.mkdirSync(path.join(root, store.root), { recursive: true });
  assert.deepEqual(store.importFiles("codeflow-docs").directories, []);
  assert.throws(() => store.importFiles(store.root), /不能从项目知识目录再次导入/u);
});

test("批量导入 Markdown 仅保存引用关系并沿用最新树版本", () => {
  const { root, store } = createProject();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "a.md"), "# A\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "b.md"), "# B\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "notes.txt"), "plain text\n", "utf8");
  store.saveTree({ schemaVersion: 3, instructions: "", nodes: [...knowledgeCategoryNodes(), { id: "root", parentId: "knowledge-product", title: "项目文档", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [], contentMode: "directory" }] }, null);
  const firstHash = store.readTree().hash;
  const a = store.importFile({ path: "docs/a.md", contentHash: store.readSource("docs/a.md").contentHash, parentId: "root", treeHash: firstHash });
  const b = store.importFile({ path: "docs/b.md", contentHash: store.readSource("docs/b.md").contentHash, parentId: "root", treeHash: store.readTree().hash });
  assert.notEqual(a.id, b.id);
  assert.equal(store.detail(a.id).reference?.content, "# A\n");
  assert.equal(store.detail(b.id).reference?.content, "# B\n");
  assert.equal(store.detail(a.id).reference?.path, "docs/a.md");
  assert.equal(store.detail(a.id).current, null);
  assert.equal(store.importFiles("docs").files.some(file => file.path === "docs/notes.txt"), true);
});

test("资产快照保留正式版本与待采用版本状态", () => {
  const { store } = createProject();
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "members", parentId: null, title: "成员管理", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  const first = store.saveDocument({ nodeId: "members", content: "# 正式版本", sources: [], expectedHash: null, origin: "ai" });
  const currentHash = store.detail("members").currentHash;
  store.saveDocument({ nodeId: "members", content: "# 待采用版本", sources: [], expectedHash: currentHash, origin: "ai", adopt: false });
  const state = store.snapshot().states.find(item => item.nodeId === "members");
  assert.equal(state?.revisionId, first.id);
  assert.equal(state?.draftCount, 1);
  assert.equal(state?.error, null);
  assert.equal(store.snapshot(false, false).states.length, 0);
});

test("批量采用在同一写锁内切换选中资产的最新待采用版本", () => {
  const { store } = createProject();
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [
    { id: "members", parentId: null, title: "成员管理", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] },
    { id: "teams", parentId: null, title: "团队管理", orderKey: "2", summary: "", tags: [], instructions: "", sourceScope: [] },
  ] }, null);
  store.saveDocument({ nodeId: "members", content: "# 成员正式版", sources: [], expectedHash: null, origin: "ai" });
  store.saveDocument({ nodeId: "teams", content: "# 团队正式版", sources: [], expectedHash: null, origin: "ai" });
  store.saveDocument({ nodeId: "members", content: "# 成员待采用版", sources: [], expectedHash: store.detail("members").currentHash, origin: "ai", adopt: false });
  store.saveDocument({ nodeId: "teams", content: "# 团队待采用版", sources: [], expectedHash: store.detail("teams").currentHash, origin: "ai", adopt: false });

  store.adoptMany(["members", "teams"]);

  assert.equal(store.detail("members").current?.content, "# 成员待采用版");
  assert.equal(store.detail("teams").current?.content, "# 团队待采用版");
  assert.equal(store.snapshot().states.every(state => state.draftCount === 0), true);
});

test("批量采用遇到单项冲突时不会部分切换其他资产", () => {
  const { root, store } = createProject();
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [
    { id: "members", parentId: null, title: "成员管理", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] },
    { id: "teams", parentId: null, title: "团队管理", orderKey: "2", summary: "", tags: [], instructions: "", sourceScope: [] },
  ] }, null);
  store.saveDocument({ nodeId: "members", content: "# 成员正式版", sources: [], expectedHash: null, origin: "ai" });
  store.saveDocument({ nodeId: "teams", content: "# 团队正式版", sources: [], expectedHash: null, origin: "ai" });
  store.saveDocument({ nodeId: "members", content: "# 成员待采用版", sources: [], expectedHash: store.detail("members").currentHash, origin: "ai", adopt: false });
  store.saveDocument({ nodeId: "teams", content: "# 团队待采用版", sources: [], expectedHash: store.detail("teams").currentHash, origin: "ai", adopt: false });
  const otherClient = new KnowledgeAssetStore(root);
  const memberDraft = otherClient.detail("members").drafts[0];
  assert.ok(memberDraft);
  otherClient.adopt("members", memberDraft.id, otherClient.detail("members").currentHash);

  assert.throws(() => store.adoptMany(["members", "teams"]), /没有可采用的待采用版本/u);
  assert.equal(store.detail("teams").current?.content, "# 团队正式版");
  assert.equal(store.detail("teams").drafts.length, 1);
});

test("tree.read 一次返回节点轻量状态，避免逐节点读取正文判断状态", () => {
  const { store } = createProject();
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [
    { id: "members", parentId: null, title: "成员管理", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] },
    { id: "empty", parentId: null, title: "空节点", orderKey: "2", summary: "", tags: [], instructions: "", sourceScope: [] },
  ] }, null);
  const current = store.saveDocument({ nodeId: "members", content: "# 成员", sources: [], expectedHash: null, origin: "ai" });
  store.saveDocument({ nodeId: "members", content: "# 成员补充", sources: [], expectedHash: store.detail("members").currentHash, origin: "ai", adopt: false });
  const result = executeKnowledgeAssetReadTool(store, "knowledge.tree.read", { parentId: null });
  assert.equal(result.ok, true);
  if (result.ok) {
    const output = result.output as { nodeStates?: Array<{ nodeId: string; revisionId: string | null; hasCurrent: boolean; draftCount: number; hasDraft: boolean }> };
    assert.deepEqual(output.nodeStates, [
      { nodeId: "members", revisionId: current.id, hasCurrent: true, draftCount: 1, hasDraft: true, error: null },
      { nodeId: "empty", revisionId: null, hasCurrent: false, draftCount: 0, hasDraft: false, error: null },
    ]);
  }
});

test("source.read 遇到目录时返回清单而不是文件读取错误", () => {
  const { root, store } = createProject();
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "nested", "feature.ts"), "export const feature = true;\n", "utf8");
  const result = executeKnowledgeAssetReadTool(store, "knowledge.source.read", { path: "src/nested" });
  assert.equal(result.ok, true);
  if (result.ok) {
    const output = result.output as { kind?: string; path?: string; nextAction?: string; entries?: unknown };
    assert.equal(output.kind, "directory");
    assert.equal(output.path, "src/nested");
    assert.equal(output.nextAction, "knowledge.source.list");
    assert.deepEqual(output.entries, [{ path: "src/nested/feature.ts", directory: false }]);
  }
});

test("源码读取会给出可定位的文件/行号错误，并把过大的读取请求限制到 500 行", () => {
  const { store } = createProject();
  const result = executeKnowledgeAssetReadTool(store, "knowledge.source.read", { path: "src/members.ts", startLine: 1, count: 1000 });
  assert.equal(result.ok, true);
  if (result.ok) {
    const output = result.output as ReturnType<KnowledgeAssetStore["readSource"]>;
    assert.equal(output.content.split(/\r?\n/u).length <= 501, true);
    assert.equal(output.endLine, 2);
  }
  assert.throws(() => store.readSource("src/missing.ts"), /来源文件不存在/u);
  assert.throws(() => store.readSource("src/members.ts", 999), /起始行超出文件范围/u);
});

test("读取上限错误不会被识别为模型限流", () => {
  const error = new KnowledgeAssetError("KNOWLEDGE_ASSET_READ_LIMIT_REACHED", "本轮读取次数已达到上限");
  assert.equal(isKnowledgeRateLimitError(error), false);
});

test("未知项目知识错误保留根因，避免只显示无法分析的固定文案", () => {
  assert.match(knowledgeFailure(new Error("来源文件不存在：src/missing.ts")).message, /来源文件不存在：src\/missing\.ts/u);
});
