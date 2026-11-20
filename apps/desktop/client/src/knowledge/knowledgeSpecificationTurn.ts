import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ConversationEventInput, EngineType, KnowledgeSpecificationRules } from "@codeflowai/shared";
import { KnowledgeAssetStore } from "./knowledgeAssetStore.js";
import { KnowledgeAssetError, knowledgeHash, knowledgeJson, knowledgeRecord, knowledgeText } from "./knowledgeAssetFiles.js";
import { knowledgeTool } from "./knowledgeAssetTools.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";

type CheckStatus = "failed" | "unverified" | "execution_succeeded" | "needs_recheck";
type Execution = { itemId: string; toolName: string; command: string; status: "running" | "failed" | "completed"; exitCode: number | null; mutation: number; specificationHash: string };

/** 验证记录仅保留去敏命令摘要，完整运行仍由原事件标识定位。 */
function commandSummary(value: unknown): string {
  return redactClientStartupText(String(value ?? "").replace(/(--(?:password|secret|client[_-]?secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[REDACTED]")).slice(0, 4000);
}

/** 不接收通过状态，只将要求原文与宿主已经观察到的命令事件关联。 */
export function buildKnowledgeAcceptanceTool() {
  return knowledgeTool("knowledge.acceptance.record", "交付前关联本轮关键要求与真实命令事件，保留失败和未验证项目。nodeId 为规格节点；本次用户要求用 null 并逐字引用。evidenceItemIds 必须来自本轮实际命令工具事件。不能提交通过状态，执行成功仍需核对断言覆盖与人工验收。", {
    type: "object", additionalProperties: false, required: ["checks"], properties: {
      checks: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["nodeId", "requirement", "method", "evidenceItemIds"], properties: {
        nodeId: { type: ["string", "null"] }, requirement: { type: "string" }, method: { type: "string" },
        evidenceItemIds: { type: "array", maxItems: 30, items: { type: "string" } },
      } } },
    },
  });
}

/** 哈希覆盖正文、来源身份、适用集合；顺序变化不伪造正文变化。 */
function specificationHash(value: KnowledgeSpecificationRules): string {
  return knowledgeHash(knowledgeJson(value.rules.map(rule => ({ ...rule, appliesTo: [...rule.appliesTo].sort() })).sort((a, b) => a.nodeId.localeCompare(b.nodeId))));
}

/** Git 仓库记录 HEAD、实际差异与未跟踪路径；普通目录使用受限文件摘要。读取错误显式失败。 */
function codeFingerprint(store: KnowledgeAssetStore): string {
  const root = store.files.root;
  const excluded = (relative: string) => relative === store.root || relative.startsWith(`${store.root}/`) || relative.startsWith(".codeflowai/")
    || relative.split("/").some(part => [".git", "node_modules", "dist", ".next", ".cache"].includes(part));
  const parts: string[] = [];
  let bytes = 0;
  /** 仅对项目内普通文件读取字节；链接与读取上限由现有安全文件入口校验。 */
  const add = (relative: string) => {
    if (excluded(relative)) return;
    const content = store.files.read(relative, 32 * 1024 * 1024);
    bytes += content.length;
    if (parts.length >= 10_000 || bytes > 64 * 1024 * 1024) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_READ_LIMIT_REACHED", "代码指纹超出读取上限，无法确认验证基线，请缩小工作区");
    parts.push(`${relative}:${knowledgeHash(content)}`);
  };
  let directory = root;
  while (!fs.existsSync(path.join(directory, ".git")) && path.dirname(directory) !== directory) directory = path.dirname(directory);
  if (fs.existsSync(path.join(directory, ".git"))) {
    /** 无 shell 拼接；Git 查询错误不能被当作代码未改变。 */
    const git = (args: string[], allowMissing = false): string | null => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      if (!result.error && allowMissing && result.status === 1 && !result.stderr.trim()) return null;
      if (result.error || result.status !== 0) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_IO_FAILED", `代码基线读取失败：${result.error?.message ?? result.stderr.trim()}`);
      return result.stdout;
    };
    const head = git(["rev-parse", "--verify", "--quiet", "HEAD"], true);
    if (head === null) {
      const branch = git(["symbolic-ref", "--quiet", "HEAD"])!.trim();
      if (git(["show-ref", "--verify", "--quiet", branch], true) !== null) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_IO_FAILED", "Git HEAD 引用异常，不能确认初始仓库基线");
      parts.push(`unborn:${branch}`);
    } else parts.push(head);
    for (const staged of [true, false]) parts.push(git(["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--binary", "--", ".", `:(exclude)${store.root}`, ":(exclude).codeflowai"])!);
    for (const relative of git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])!.split("\0").filter(Boolean).sort()) {
      if (!excluded(relative)) parts.push(`${relative}:untracked`);
    }
  } else {
    /** 无 Git 的工作区仍核对实际源码；排除已知生成目录，不忽略未知读取错误。 */
    const visit = (relative: string) => {
      const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (excluded(next)) continue;
        if (entry.isDirectory()) visit(next);
        else add(next);
      }
    };
    visit("");
  }
  return knowledgeHash(parts.join("\n"));
}

/** 每回合沿用会话事件保存提供记录与验收依据，不创建平行状态库或接受模型伪造结果。 */
export function createKnowledgeSpecificationTurn(input: {
  store: KnowledgeAssetStore; specifications: KnowledgeSpecificationRules; workspaceId: string; threadId: string; turnId: string; engine: EngineType;
  userRequirements: string; isActive: () => boolean; emit: (event: ConversationEventInput) => void;
}) {
  const delivered = new Map(input.specifications.rules.map(rule => [rule.nodeId, rule]));
  const requestedPaths = new Set(input.specifications.paths ?? []);
  const executions = new Map<string, Execution>();
  const emittedSnapshots = new Map<string, string>();
  let reportNumber = 0;
  let snapshotNumber = 0;
  let initialProvided = false;
  let mutation = 0;
  /** 本轮停止后不再追加可被误读为有效交付的记录。 */
  const assertActive = () => { if (!input.isActive()) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "回合已停止，规格记录未保存"); };
  /** 从实际提供集合计算基线，始终使用真实内容指纹。 */
  const deliveredRules = (): KnowledgeSpecificationRules => ({ rules: [...delivered.values()], scoped: [] });
  /** 复用宿主工具事件及既有持久化链，摘要说明提供事实而非验证结论。 */
  const emitRecord = (toolName: string, id: string, summary: string, output: unknown) => {
    assertActive();
    input.emit({ ts: Date.now(), workspaceId: input.workspaceId, threadId: input.threadId, engine: input.engine, type: "item.tool.completed", payload: { itemId: id, toolName, status: "completed", summary, output } } as ConversationEventInput);
  };
  /** 仅保存实际提供的版本和指纹；同范围同内容重复读取不制造噪声。 */
  const recordRules = (rules: KnowledgeSpecificationRules, paths: string[]) => {
    assertActive();
    for (const target of paths) requestedPaths.add(target);
    const key = knowledgeHash(knowledgeJson({ hash: specificationHash(rules), paths: [...paths].sort() }));
    const scopeKey = knowledgeJson([...paths].sort());
    const returnedIds = new Set(rules.rules.map(rule => rule.nodeId));
    for (const [id, rule] of delivered) {
      const reread = !rule.appliesTo.length || paths.some(target => rule.appliesTo.some(scope => target === scope || target.startsWith(`${scope}/`) || scope.startsWith(`${target}/`)));
      if (reread && !returnedIds.has(id)) delivered.delete(id);
    }
    for (const rule of rules.rules) delivered.set(rule.nodeId, rule);
    if (emittedSnapshots.get(scopeKey) === key) return;
    emitRecord("项目规格已提供", `specifications-${input.turnId}-${++snapshotNumber}`, `已提供 ${rules.rules.length} 份正式规格 · ${paths.length ? paths.join("、") : "设计阶段，按各条范围适用"} · 尚未验证`, {
      turnId: input.turnId, paths, fingerprint: specificationHash(rules), acceptance: "unverified",
      rules: rules.rules.map(({ content: _content, ...metadata }) => metadata),
      pendingScoped: rules.scoped.filter(scope => !rules.rules.some(rule => rule.nodeId === scope.nodeId)),
    });
    emittedSnapshots.set(scopeKey, key);
  };
  /** 初始请求正文只确认一次，后续补读不能被初始快照回写。 */
  const provided = () => { if (!initialProvided) { recordRules(input.specifications, input.specifications.paths ?? []); initialProvided = true; } };
  return {
    provided,
    recordRules,
    /** 只观察当前宿主传回的命令事件；其他会话、文本自述及模型参数不是执行证据。 */
    observe(event: ConversationEventInput): void {
      if (event.workspaceId !== input.workspaceId || event.threadId !== input.threadId || event.engine !== input.engine || !input.isActive()) return;
      if ("turnId" in event.payload && event.payload.turnId !== undefined && event.payload.turnId !== input.turnId) return;
      provided();
      if (event.type !== "item.tool.started" && event.type !== "item.tool.completed") return;
      const payload = event.payload;
      const name = payload.toolName ?? executions.get(payload.itemId)?.toolName ?? "";
      if (event.type === "item.tool.completed" && (payload.changes?.length || /^(fileChange|Edit|Write|apply_patch)$/i.test(name))) mutation++;
      if (!/^(commandExecution|Bash|exec_command|shell_command|run_command|exec|shell)$/i.test(name)) return;
      if (event.type === "item.tool.started") {
        const source = event.payload.input;
        const data = source && typeof source === "object" ? source as Record<string, unknown> : {};
        executions.set(payload.itemId, { itemId: payload.itemId, toolName: name, command: commandSummary(data.command ?? data.cmd), status: "running", exitCode: null, mutation, specificationHash: specificationHash(deliveredRules()) });
      } else {
        const previous = executions.get(payload.itemId);
        if (!previous) return;
        const result = event.payload.output;
        const data = result && typeof result === "object" ? result as Record<string, unknown> : {};
        const exitCode = data.exitCode ?? data.exit_code;
        previous.exitCode = typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : null;
        previous.status = event.payload.status === "failed" || previous.exitCode !== null && previous.exitCode !== 0 ? "failed" : "completed";
      }
    },
    /** 保留要求与真实执行引用；源码或规格变化后仅标记需复核，历史事件不删除。 */
    record(raw: unknown) {
      assertActive();
      const value = knowledgeRecord(raw);
      if (!Array.isArray(value.checks) || value.checks.length > 50) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "验收检查必须为不超过50项的数组", 400);
      const nowSpecifications = specificationHash(input.store.rules([...requestedPaths]));
      const baselineStatus = nowSpecifications === specificationHash(deliveredRules()) ? "unchanged" : "changed";
      const codeHash = codeFingerprint(input.store);
      const checks = value.checks.map(rawCheck => {
        const check = knowledgeRecord(rawCheck);
        const nodeId = check.nodeId === null ? null : knowledgeText(check.nodeId, 200, true);
        const requirement = knowledgeText(check.requirement, 8000, true);
        const method = knowledgeText(check.method, 2000, true);
        const body = nodeId === null ? input.userRequirements : delivered.get(nodeId)?.content;
        if (!body || !body.includes(requirement)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "验收要求必须逐字引用实际提供的规格或本次用户原文", 400);
        if (!Array.isArray(check.evidenceItemIds) || check.evidenceItemIds.length > 30) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "执行引用格式无效", 400);
        const evidence = check.evidenceItemIds.map(value => {
          const itemId = knowledgeText(value, 300, true), execution = executions.get(itemId);
          if (!execution) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", `未观察到本轮真实执行：${itemId}`, 400);
          return { ...execution };
        });
        let status: CheckStatus = "unverified";
        if (evidence.some(item => item.status === "failed")) status = "failed";
        else if (baselineStatus === "changed" || evidence.some(item => item.specificationHash !== nowSpecifications || item.mutation !== mutation)) status = "needs_recheck";
        else if (evidence.length && evidence.every(item => item.status === "completed" && item.exitCode === 0)) status = "execution_succeeded";
        return { nodeId, requirement, method, status, evidence };
      });
      const output = { turnId: input.turnId, baselineStatus, specificationHash: nowSpecifications, codeHash, acceptance: "needs_review" as const, checks,
        codeBaseline: "recorded_after_execution", untrackedContentVerified: false,
        boundary: "代码指纹在记录时获取，不证明命令执行时文件一致，也不包含未跟踪文件正文。执行成功仅表示命令结果；外部修改、要求覆盖与人工验收仍需核对，未关联的要求仍未验证。" };
      emitRecord("规格验证依据", `specification-evidence-${input.turnId}-${++reportNumber}`, `已记录 ${checks.length} 项依据 · ${checks.filter(item => item.status === "failed").length} 项执行失败 · 尚需核对覆盖与验收`, output);
      return { ok: true as const, output };
    },
  };
}
