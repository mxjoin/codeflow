<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons-vue";
import {
  canMaintainBuiltinSpecAssets,
  canUseRoleKnowledgeAndToolsTabs,
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  normalizeRoleExecutionConfig,
  PRODUCT_DEFAULT_AUTO_COMPACT_PCT,
  normalizeRoleInputDefinition,
  normalizeRoleOutputDefinition,
  type EngineType,
  type KnowledgeBundleDefinition,
  type RoleDefinition,
  type RoleExecutionConfig,
  type RoleExecutionEngineProfile,
  type RoleFieldDefinition,
  type RoleId,
  type RoleOutputFileDefinition,
  type SkillId,
  type SkillDefinition,
  type ToolsetDefinition,
  type ToolRef,
  type WorkspaceId,
} from "@codeflowai/shared";

import { listOrchToolsets } from "../../../api/orchestration";
import { listWorkspaces } from "../../../api/workspaces";
import { useApiContext } from "../../../composables/useApiContext";
import {
  createCatalogRoleExecutionCustomConfig,
  resolveCatalogRoleExecutionConfigForEngine,
} from "../../../composables/runtimeRoleExecutionConfig";
import { useEngineExecutionOptions } from "../../../composables/useEngineExecutionOptions";
import { useConfigStore } from "../../../store/config";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useEngineStore } from "../../../store/engine";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useOrchAssetDirtyState } from "../composables/useOrchAssetDirtyState";

defineOptions({ name: "RoleDefinitionForm" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  roleId: RoleId;
  sourceDefinition?: RoleDefinition | null;
  saveLabel?: string;
  /** 无工作区只读预览：强制只读，且不触发展示以外的任何请求。 */
  previewReadonly?: boolean;
}>();
const emit = defineEmits<{ (event: "dirty-change", dirty: boolean): void }>();
const orch = useOrchestrationStore();
const config = useConfigStore();
const engines = useEngineStore();
const { ctx } = useApiContext();

type FormTab = "basic" | "input" | "output" | "gates" | "knowledge" | "skills" | "tools" | "config";
type OutputDeliveryChannel = "direct" | "file";
const formTabs: FormTab[] = ["basic", "input", "output", "gates", "knowledge", "skills", "tools", "config"];
const formTab = ref<FormTab>("basic");
const selectedInputFieldIndex = ref(0);
const outputFileModalOpen = ref(false);
const outputFieldModalOpen = ref(false);
const editingOutputFileIndex = ref<number | null>(null);
const editingOutputFieldIndex = ref<number | null>(null);
const outputFileDraft = ref<RoleOutputFileDefinition>(createEmptyOutputFile());
const outputFieldDraft = ref<RoleFieldDefinition>(createEmptyField());

const form = ref<Omit<RoleDefinition, "createdAt" | "updatedAt">>({
  id: "" as RoleId,
  workspaceId: props.workspaceId,
  name: "",
  description: "",
  responsibility: "",
  systemPrompt: "",
  inputDefinition: createDefaultRoleInputDefinition(),
  outputDefinition: createDefaultRoleOutputDefinition(),
  gateCriteria: [],
  executionConfig: createDefaultRoleExecutionConfig("codex"),
  defaultKnowledgeBundleIds: [],
  defaultSkillIds: [],
  toolRefs: [],
  kind: "custom",
  builtinGroup: null,
});
const { hasUnsavedChanges, isDirty, markCleanFromCurrentDraft } = useOrchAssetDirtyState(() => form.value);

const selectedExecutionEngine = ref<EngineType>("codex");
const executionEngines: EngineType[] = ["codex", "claude"];
const selectedExecutionProfile = computed<RoleExecutionEngineProfile>(() =>
  form.value.executionConfig.engineProfiles[selectedExecutionEngine.value],
);
const selectedCustomExecutionConfig = computed(() => {
  if (selectedExecutionProfile.value.mode !== "custom") return null;
  return selectedExecutionProfile.value.customConfig ?? null;
});
const engineModels = (engine: EngineType) => engines.byTypeForWorkspace(props.workspaceId).get(engine)?.models ?? [];
const selectedProfileResolvedConfig = computed(() => {
  if (!selectedExecutionProfile.value.enabled) return null;
  return resolveCatalogRoleExecutionConfigForEngine(
    form.value.executionConfig,
    selectedExecutionEngine.value,
    engineModels(selectedExecutionEngine.value),
    form.value.executionConfig.preferredEngine,
  );
});

const { accessModeOptions, effortOptions, hasEffortCatalog, hasModelCatalog, modelOptions, resolvedModelInfo } = useEngineExecutionOptions({
  engine: () => selectedExecutionEngine.value,
  model: () => selectedCustomExecutionConfig.value?.model,
  effort: () => selectedCustomExecutionConfig.value?.effort,
  workspaceId: () => props.workspaceId,
});
const showAutoCompactField = computed(() =>
  selectedExecutionProfile.value.enabled && selectedExecutionProfile.value.mode === "custom",
);
const autoCompactMin = 50;
const autoCompactMax = 99;
const selectedAutoCompactPct = computed<number>({
  get: () => {
    const current = Number(selectedExecutionProfile.value.customConfig?.autoCompactPct);
    if (Number.isFinite(current) && current >= autoCompactMin && current <= autoCompactMax) {
      return Math.round(current);
    }
    return PRODUCT_DEFAULT_AUTO_COMPACT_PCT;
  },
  set: (value: number) => {
    const customConfig = ensureCustomExecutionConfig(selectedExecutionEngine.value);
    if (!customConfig) return;
    customConfig.autoCompactPct = Math.min(autoCompactMax, Math.max(autoCompactMin, Math.round(value)));
  },
});
const selectedToolRefKeys = computed(() => new Set((form.value.toolRefs ?? []).map((item) => `${item.toolsetId}::${item.toolId}`)));
const superAdminExtraCustomToolsets = ref<ToolsetDefinition[]>([]);
const workspaceTitleById = ref<Record<string, string>>({});
const superAdminExtraCustomToolsetsLoadedWorkspaceId = ref<WorkspaceId | null>(null);
const superAdminExtraCustomToolsetsLoadingWorkspaceId = ref<WorkspaceId | null>(null);
let superAdminExtraCustomToolsetsRequestSeq = 0;
const isSuperAdmin = computed(() => config.accountRole === "super_admin" && !isDesktopWorkspace(config, props.workspaceId));
const visibleToolsets = computed<ToolsetDefinition[]>(() => {
  const merged = orch.toolsets.filter(toolset => props.previewReadonly === true
    || !orch.assetListHostIds.toolset.includes(toolset.id) || toolset.kind === "builtin");
  const seen = new Set(merged.map((toolset) => toolset.id));
  for (const toolset of superAdminExtraCustomToolsets.value) {
    if (seen.has(toolset.id)) continue;
    seen.add(toolset.id);
    merged.push(toolset);
  }
  return merged;
});
const visibleKnowledgeBundles = computed(() => orch.knowledgeBundles.filter(bundle => props.previewReadonly === true
  || !orch.assetListHostIds.knowledge_bundle.includes(bundle.id) || bundle.kind === "builtin"));
const visibleSkills = computed(() => orch.skills.filter(skill => props.previewReadonly === true
  || !orch.assetListHostIds.skill.includes(skill.id) || skill.kind === "builtin"));
const groupedTools = computed(() => visibleToolsets.value.map((toolset) => ({
  toolsetId: toolset.id,
  toolsetName: resolveVisibleToolsetName(toolset),
  description: toolset.description,
  tools: toolset.tools,
})));
const selectedToolBindings = computed(() => (form.value.toolRefs ?? []).map((ref, index) => {
  const toolset = visibleToolsets.value.find((item) => item.id === ref.toolsetId) ?? null;
  const tool = toolset?.tools.find((item) => item.id === ref.toolId) ?? null;
  return { index, ref, toolsetName: toolset ? resolveVisibleToolsetName(toolset) : ref.toolsetId, toolName: tool?.name ?? ref.toolId, runtime: tool?.runtime ?? null, description: tool?.description ?? "" };
}));
const outputDeliveryChannel = computed<OutputDeliveryChannel>({
  get: () => (form.value.outputDefinition.deliveryMode === "direct" ? "direct" : "file"),
  set: (value) => setOutputDeliveryChannel(value),
});
const outputFileMode = computed<"file" | "file-set">({
  get: () => (form.value.outputDefinition.deliveryMode === "file-set" ? "file-set" : "file"),
  set: (value) => setOutputFileMode(value),
});
const usesFileDelivery = computed(() => form.value.outputDefinition.deliveryMode !== "direct");
const outputSummaryModeLabel = computed(() => (
  outputDeliveryChannel.value === "direct"
    ? "直接输出"
    : outputFileMode.value === "file"
      ? "文件交付 · 单文件"
      : "文件交付 · 多文件"
));
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
}));
const canUseKnowledgeAndToolsTabs = computed(() => isDesktopWorkspace(config, props.workspaceId) || canUseRoleKnowledgeAndToolsTabs(permissionInput.value));
/**
 * 只读红旗：预览态一律只读；服务端权威模式下的内置资产随服务端分发且只读；
 * 其余沿用既有内置资产口径。
 */
const isBuiltinReadonly = computed(() => props.previewReadonly === true
  || orch.isServerAuthoritativeBuiltinAsset("role", String(props.roleId ?? ""))
  || (form.value.kind === "builtin" && !canMaintainBuiltinSpecAssets(permissionInput.value)));
/** 只读时使用非表单元素承载纯浏览导航，避免被禁用 fieldset 一并拦截。 */
const readonlyNavigationTag = computed(() => (isBuiltinReadonly.value ? "div" : "button"));
const visibleFormTabs = computed(() => formTabs.filter((tab) => canUseKnowledgeAndToolsTabs.value || (tab !== "knowledge" && tab !== "skills" && tab !== "tools")));

watch([() => props.roleId, () => props.sourceDefinition], ([roleId, sourceDefinition]) => {
  const role = sourceDefinition ?? orch.roles.find((item) => item.id === roleId);
  if (!role) return;
  const normalizedOutputDefinition = normalizeRoleOutputDefinition(role.outputDefinition);
  form.value = {
    id: role.id,
    workspaceId: role.workspaceId,
    name: role.name,
    description: role.description,
    responsibility: role.responsibility ?? "",
    systemPrompt: role.systemPrompt,
    inputDefinition: { ...normalizeRoleInputDefinition(role.inputDefinition), requiredFields: cloneRoleFields(role.inputDefinition.requiredFields) },
    outputDefinition: {
      ...normalizedOutputDefinition,
      files: cloneRoleOutputFiles(normalizedOutputDefinition.files),
      requiredFields: cloneRoleFields(role.outputDefinition.requiredFields),
    },
    gateCriteria: role.gateCriteria.map((item) => ({ ...item })),
    executionConfig: normalizeRoleExecutionConfig(role.executionConfig, role.executionConfig.preferredEngine),
    defaultKnowledgeBundleIds: [...(role.defaultKnowledgeBundleIds ?? [])],
    defaultSkillIds: [...(role.defaultSkillIds ?? [])],
    toolRefs: (role.toolRefs ?? []).map((item) => ({ ...item })),
    kind: role.kind,
    builtinGroup: role.builtinGroup ?? null,
  };
  selectedExecutionEngine.value = form.value.executionConfig.preferredEngine;
  sanitizeUnsupportedContextWindowOverrides();
  markCleanFromCurrentDraft();
  selectedInputFieldIndex.value = 0;
}, { immediate: true });

watch(() => form.value.inputDefinition.requiredFields.length, (length) => {
  if (length <= 0) {
    selectedInputFieldIndex.value = 0;
    return;
  }
  if (selectedInputFieldIndex.value >= length) selectedInputFieldIndex.value = length - 1;
});

watch(visibleFormTabs, (tabs) => {
  if (tabs.includes(formTab.value)) return;
  formTab.value = "basic";
}, { immediate: true });

watch([isSuperAdmin, () => props.workspaceId, formTab], () => {
  // 预览态没有工作区上下文，跳过超管跨工作区工具集查询。
  if (props.previewReadonly === true || formTab.value !== "tools") return;
  void refreshSuperAdminVisibleCustomToolsets();
}, { immediate: true });
watch(isDirty, (dirty) => emit("dirty-change", dirty), { immediate: true });

/** 保存角色定义；普通用户在内置角色详情中只能查看，不能提交写操作。 */
async function onSave(): Promise<boolean> {
  if (isBuiltinReadonly.value) {
    message.info("内置 Agent 仅超管可修改");
    return false;
  }
  const gateIssue = validateGateCriteria();
  if (gateIssue) {
    message.error(gateIssue);
    formTab.value = "gates";
    return false;
  }
  const executionIssue = validateExecutionConfig();
  if (executionIssue) {
    message.error(executionIssue);
    formTab.value = "config";
    return false;
  }
  try {
    const payload = buildRolePayload();
    await orch.saveRole(ctx.value, props.workspaceId, payload);
    markCleanFromCurrentDraft();
    message.success("角色已保存");
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
    return false;
  }
}

/** 父级资产切换守卫调用的保存入口，失败时返回 false 阻止切换。 */
async function saveCurrentDraft(): Promise<boolean> {
  return onSave();
}

/** 放弃当前未保存角色草稿，并恢复为 store 中最近保存态。 */
function discardUnsavedChanges(): void {
  const role = props.sourceDefinition ?? orch.roles.find((item) => item.id === props.roleId);
  if (!role) return;
  const normalizedOutputDefinition = normalizeRoleOutputDefinition(role.outputDefinition);
  form.value = {
    id: role.id,
    workspaceId: role.workspaceId,
    name: role.name,
    description: role.description,
    responsibility: role.responsibility ?? "",
    systemPrompt: role.systemPrompt,
    inputDefinition: { ...normalizeRoleInputDefinition(role.inputDefinition), requiredFields: cloneRoleFields(role.inputDefinition.requiredFields) },
    outputDefinition: {
      ...normalizedOutputDefinition,
      files: cloneRoleOutputFiles(normalizedOutputDefinition.files),
      requiredFields: cloneRoleFields(role.outputDefinition.requiredFields),
    },
    gateCriteria: role.gateCriteria.map((item) => ({ ...item })),
    executionConfig: normalizeRoleExecutionConfig(role.executionConfig, role.executionConfig.preferredEngine),
    defaultKnowledgeBundleIds: [...(role.defaultKnowledgeBundleIds ?? [])],
    defaultSkillIds: [...(role.defaultSkillIds ?? [])],
    toolRefs: (role.toolRefs ?? []).map((item) => ({ ...item })),
    kind: role.kind,
    builtinGroup: role.builtinGroup ?? null,
  };
  selectedExecutionEngine.value = form.value.executionConfig.preferredEngine;
  sanitizeUnsupportedContextWindowOverrides();
  selectedInputFieldIndex.value = 0;
  markCleanFromCurrentDraft();
}

defineExpose({
  hasUnsavedChanges,
  saveCurrentDraft,
  discardUnsavedChanges,
});

/** 构建角色保存请求，并保留内置角色的系统分组归属。 */
function buildRolePayload(): Omit<RoleDefinition, "createdAt" | "updatedAt"> {
  const outputFiles = form.value.outputDefinition.deliveryMode === "direct"
    ? []
    : sanitizeRoleOutputFiles(form.value.outputDefinition.files, form.value.outputDefinition.deliveryMode);
  const outputInstructions = form.value.outputDefinition.deliveryMode === "direct"
    ? form.value.outputDefinition.instructions.replace(/\r\n/g, "\n").trim()
    : "";
  const filePathRule = form.value.outputDefinition.deliveryMode === "direct"
    ? null
    : String(form.value.outputDefinition.filePathRule ?? "").trim()
      || (form.value.outputDefinition.deliveryMode === "file" ? outputFiles[0]?.pathRule ?? null : null);
  return {
    id: form.value.id,
    workspaceId: props.workspaceId,
    name: form.value.name.trim(),
    description: form.value.description.trim(),
    responsibility: form.value.responsibility?.trim() || "",
    systemPrompt: form.value.systemPrompt.replace(/\r\n/g, "\n").trim(),
    inputDefinition: {
      instructions: form.value.inputDefinition.instructions.replace(/\r\n/g, "\n").trim(),
      requiredFields: sanitizeRoleFields(form.value.inputDefinition.requiredFields),
    },
    outputDefinition: {
      instructions: outputInstructions,
      deliveryMode: form.value.outputDefinition.deliveryMode,
      format: form.value.outputDefinition.format,
      resultKey: String(form.value.outputDefinition.resultKey ?? "").trim() || null,
      filePathRule,
      files: outputFiles,
      requiredFields: sanitizeRoleFields(form.value.outputDefinition.requiredFields),
    },
    gateCriteria: form.value.gateCriteria.map((gate, index) => ({
      ...gate,
      id: String(gate.id ?? "").trim() || `gate-${index + 1}`,
      label: String(gate.label ?? "").trim() || `门禁 ${index + 1}`,
      config: String(gate.config ?? "").trim(),
    })),
    executionConfig: normalizeRoleExecutionConfig(form.value.executionConfig, form.value.executionConfig.preferredEngine),
    defaultKnowledgeBundleIds: Array.from(new Set(form.value.defaultKnowledgeBundleIds ?? [])),
    defaultSkillIds: sanitizeSkillIds(form.value.defaultSkillIds ?? []),
    toolRefs: dedupeToolRefs((form.value.toolRefs ?? []).map((toolRef) => ({ ...toolRef, alias: String(toolRef.alias ?? "").trim() || null, usageGuidance: String(toolRef.usageGuidance ?? "").trim() || null, required: Boolean(toolRef.required) }))),
    kind: form.value.kind,
    builtinGroup: form.value.builtinGroup ?? null,
  };
}

function cloneRoleFields(fields: RoleFieldDefinition[] | null | undefined): RoleFieldDefinition[] {
  return (fields ?? []).map((field) => ({ ...field }));
}

function cloneRoleOutputFiles(files: RoleOutputFileDefinition[] | null | undefined): RoleOutputFileDefinition[] {
  return (files ?? []).map((file) => ({ ...file }));
}

function sanitizeRoleFields(fields: RoleFieldDefinition[] | null | undefined): RoleFieldDefinition[] {
  return (fields ?? []).map((field, index) => ({
    key: String(field.key ?? "").trim() || `field_${index + 1}`,
    label: String(field.label ?? "").trim() || `字段 ${index + 1}`,
    valueType: field.valueType,
    required: Boolean(field.required),
    description: String(field.description ?? "").trim() || null,
    example: String(field.example ?? "").trim() || null,
  })).filter((field) => Boolean(field.key));
}

/** 保存前清理交付文件配置，并保留隐藏的 key/allowedExtensions 契约字段。 */
function sanitizeRoleOutputFiles(
  files: RoleOutputFileDefinition[] | null | undefined,
  deliveryMode: RoleDefinition["outputDefinition"]["deliveryMode"],
): RoleOutputFileDefinition[] {
  const sanitized: RoleOutputFileDefinition[] = [];
  (files ?? []).forEach((file, index) => {
    const name = String(file.name ?? "").trim();
    const format = String(file.format ?? "").trim();
    const pathRule = String(file.pathRule ?? "").trim() || null;
    const description = String(file.description ?? "").trim() || null;
    const normalizedFormat = normalizeOutputFormatValue(format);
    const allowedExtensions = Array.isArray(file.allowedExtensions) ? file.allowedExtensions : null;
    const meaningful = Boolean(file.key || name || pathRule || description || normalizedFormat || allowedExtensions?.length);
    if (!meaningful) return;
    sanitized.push({
      key: String(file.key ?? "").trim() || null,
      name: name || (deliveryMode === "file" ? "交付文件" : `交付项 ${index + 1}`),
      format: normalizedFormat,
      allowedExtensions,
      pathRule,
      description,
      required: file.required !== false,
    });
  });
  return deliveryMode === "file" ? sanitized.slice(0, 1) : sanitized;
}

function createEmptyField(): RoleFieldDefinition {
  return { key: "", label: "", valueType: "text", required: false, description: "", example: "" };
}

function createEmptyOutputFile(): RoleOutputFileDefinition {
  return {
    key: null,
    name: "",
    format: null,
    allowedExtensions: null,
    pathRule: null,
    description: null,
    required: true,
  };
}

function normalizeOutputFormatValue(format: string): RoleDefinition["outputDefinition"]["format"] | null {
  switch (format) {
    case "markdown":
    case "text":
    case "json":
    case "yaml":
    case "html":
    case "javascript":
    case "css":
    case "sql":
    case "image":
      return format;
    default:
      return null;
  }
}

function addRoleField(target: "input" | "output") {
  const key = target === "input" ? "inputDefinition" : "outputDefinition";
  form.value[key].requiredFields.push(createEmptyField());
  if (target === "input") {
    selectedInputFieldIndex.value = form.value.inputDefinition.requiredFields.length - 1;
  }
}

function removeRoleField(target: "input" | "output", index: number) {
  const key = target === "input" ? "inputDefinition" : "outputDefinition";
  form.value[key].requiredFields.splice(index, 1);
  if (target === "input" && selectedInputFieldIndex.value > index) selectedInputFieldIndex.value -= 1;
}

function addGate() {
  form.value.gateCriteria.push({ id: `gate-${Date.now()}`, label: "新门禁", type: "regex", config: "", blocking: true });
}

/** 保存前校验 AI 门禁自然语言标准，按 Unicode code point 限制输入预算。 */
function validateGateCriteria(): string | null {
  for (const [index, gate] of form.value.gateCriteria.entries()) {
    if (gate.type !== "ai") continue;
    const config = String(gate.config ?? "").trim();
    if (!config) return `AI 文本描述门禁 ${index + 1} 不能为空`;
    if (Array.from(config).length > 4_000) return `AI 文本描述门禁 ${index + 1} 不能超过 4,000 个字符`;
  }
  return null;
}

/** 返回门禁类型对应的配置提示，避免用户把自然语言标准写成正则或 JSON Schema。 */
function gateConfigPlaceholder(type: string): string {
  if (type === "ai") return "用自然语言描述验收标准，例如：必须包含风险、影响范围和后续动作。";
  return type === "regex" ? "正则表达式" : "JSON Schema";
}

function removeGate(index: number) {
  form.value.gateCriteria.splice(index, 1);
}

function tabLabel(tab: FormTab): string {
  return tab === "basic" ? "基本" : tab === "input" ? "输入" : tab === "output" ? "输出" : tab === "gates" ? "门禁" : tab === "knowledge" ? "知识库" : tab === "skills" ? "Skills" : tab === "tools" ? "工具" : "配置";
}

function selectRoleField(target: "input" | "output", index: number) {
  if (target === "input") selectedInputFieldIndex.value = index;
}

function fieldTitle(field: RoleFieldDefinition, index: number): string {
  return String(field.label ?? "").trim() || String(field.key ?? "").trim() || `字段 ${index + 1}`;
}

function outputFileTitle(file: RoleOutputFileDefinition, index: number): string {
  return String(file.name ?? "").trim()
    || (form.value.outputDefinition.deliveryMode === "file" ? "交付文件" : `交付项 ${index + 1}`);
}

/** 返回交付文件当前会使用的格式展示名。 */
function outputFileFormatLabel(file: RoleOutputFileDefinition): string {
  const format = String(file.format ?? "").trim() || form.value.outputDefinition.format;
  return roleOutputFormatLabel(format);
}

/** 输出格式枚举转为界面展示名，供编辑态和只读态共用。 */
function roleOutputFormatLabel(format: string | null | undefined): string {
  if (format === "json") return "JSON";
  if (format === "yaml") return "YAML";
  if (format === "html") return "HTML";
  if (format === "javascript") return "JavaScript";
  if (format === "css") return "CSS";
  if (format === "sql") return "SQL";
  if (format === "image") return "Image";
  if (format === "text") return "Text";
  return "Markdown";
}

function setOutputDeliveryChannel(value: OutputDeliveryChannel) {
  if (value === "direct") {
    form.value.outputDefinition.deliveryMode = "direct";
    return;
  }
  const nextMode = form.value.outputDefinition.deliveryMode === "file-set" ? "file-set" : "file";
  setOutputFileMode(nextMode);
}

function setOutputFileMode(value: "file" | "file-set") {
  form.value.outputDefinition.deliveryMode = value;
  if (!form.value.outputDefinition.files?.length) {
    const firstFile = createEmptyOutputFile();
    const legacyInstructions = String(form.value.outputDefinition.instructions ?? "").trim();
    if (legacyInstructions) firstFile.description = legacyInstructions;
    form.value.outputDefinition.files = [firstFile];
  }
  if (value === "file" && (form.value.outputDefinition.files?.length ?? 0) > 1) {
    form.value.outputDefinition.files = form.value.outputDefinition.files?.slice(0, 1) ?? [];
  }
}

function addOutputFile() {
  if (!form.value.outputDefinition.files) form.value.outputDefinition.files = [];
  if (form.value.outputDefinition.deliveryMode === "file") {
    if (!form.value.outputDefinition.files.length) form.value.outputDefinition.files = [createEmptyOutputFile()];
    return;
  }
  form.value.outputDefinition.files.push(createEmptyOutputFile());
}

function removeOutputFile(index: number) {
  form.value.outputDefinition.files?.splice(index, 1);
}

function toggleToolRef(toolRef: ToolRef, checked: boolean) {
  const key = `${toolRef.toolsetId}::${toolRef.toolId}`;
  const next = [...(form.value.toolRefs ?? [])];
  const index = next.findIndex((item) => `${item.toolsetId}::${item.toolId}` === key);
  if (checked && index < 0) next.push({ ...toolRef, alias: null, usageGuidance: null, required: false });
  if (!checked && index >= 0) next.splice(index, 1);
  form.value.toolRefs = next;
}

function selectedToolSummaryLines() {
  return (form.value.toolRefs ?? []).map((ref) => {
    const toolset = visibleToolsets.value.find((item) => item.id === ref.toolsetId);
    const tool = toolset?.tools.find((item) => item.id === ref.toolId);
    return toolset && tool ? `${resolveVisibleToolsetName(toolset)} / ${tool.name}` : `${ref.toolsetId} / ${ref.toolId}`;
  });
}

/** 读取知识库的定义源数量。 */
function knowledgeSourceCount(bundle: KnowledgeBundleDefinition): number {
  return bundle.sourceRefs.length;
}

/** 清理角色绑定的 Skill ID，保持顺序并去重。 */
function sanitizeSkillIds(skillIds: SkillId[]): SkillId[] {
  return Array.from(new Set(skillIds.map((id) => String(id ?? "").trim()).filter(Boolean))) as SkillId[];
}

/** 超管打开角色工具页时补充读取其他工作区的自定义工具，避免切换资产 Tab 时提前请求。 */
async function refreshSuperAdminVisibleCustomToolsets(): Promise<void> {
  if (!isSuperAdmin.value) {
    superAdminExtraCustomToolsetsRequestSeq += 1;
    superAdminExtraCustomToolsets.value = [];
    workspaceTitleById.value = {};
    superAdminExtraCustomToolsetsLoadedWorkspaceId.value = null;
    superAdminExtraCustomToolsetsLoadingWorkspaceId.value = null;
    return;
  }
  const requestedWorkspaceId = props.workspaceId;
  if (superAdminExtraCustomToolsetsLoadedWorkspaceId.value === requestedWorkspaceId) return;
  if (superAdminExtraCustomToolsetsLoadingWorkspaceId.value === requestedWorkspaceId) return;
  const requestSeq = ++superAdminExtraCustomToolsetsRequestSeq;
  superAdminExtraCustomToolsets.value = [];
  workspaceTitleById.value = {};
  superAdminExtraCustomToolsetsLoadingWorkspaceId.value = requestedWorkspaceId;

  try {
    const workspaceResult = await listWorkspaces(ctx.value);
    if (requestSeq !== superAdminExtraCustomToolsetsRequestSeq || props.workspaceId !== requestedWorkspaceId || !isSuperAdmin.value) return;
    if (!workspaceResult.ok) {
      superAdminExtraCustomToolsets.value = [];
      workspaceTitleById.value = {};
      message.error(workspaceResult.message || "工作区列表加载失败");
      return;
    }
    const workspaces = workspaceResult.workspaces ?? [];
    workspaceTitleById.value = Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.title || workspace.id]));
    const otherWorkspaces = workspaces.filter((workspace) => workspace.id !== requestedWorkspaceId);
    const toolsetResults = await Promise.all(otherWorkspaces.map(async (workspace) => ({
      workspace,
      result: await listOrchToolsets(ctx.value, workspace.id),
    })));
    if (requestSeq !== superAdminExtraCustomToolsetsRequestSeq || props.workspaceId !== requestedWorkspaceId || !isSuperAdmin.value) return;
    const failed = toolsetResults.find(({ result }) => !result.ok);
    if (failed && !failed.result.ok) {
      superAdminExtraCustomToolsets.value = [];
      message.error(failed.result.message || `工具加载失败：${failed.workspace.title || failed.workspace.id}`);
      return;
    }
    superAdminExtraCustomToolsets.value = toolsetResults.flatMap(({ result }) => {
      if (!result.ok) return [];
      return (result.toolsets ?? []).filter((toolset) => toolset.kind === "custom");
    });
    superAdminExtraCustomToolsetsLoadedWorkspaceId.value = requestedWorkspaceId;
  } finally {
    if (requestSeq === superAdminExtraCustomToolsetsRequestSeq) {
      superAdminExtraCustomToolsetsLoadingWorkspaceId.value = null;
    }
  }
}

/** 超管跨工作区查看时，在工具名称后补工作区名，避免同名工具混淆。 */
function resolveVisibleToolsetName(toolset: Pick<ToolsetDefinition, "name" | "workspaceId">): string {
  if (toolset.workspaceId === props.workspaceId) {
    return toolset.name;
  }
  const workspaceTitle = workspaceTitleById.value[toolset.workspaceId] ?? toolset.workspaceId;
  return `${toolset.name} · ${workspaceTitle}`;
}

function openOutputFileModal(index?: number) {
  editingOutputFileIndex.value = typeof index === "number" ? index : null;
  const source = typeof index === "number"
    ? form.value.outputDefinition.files?.[index] ?? createEmptyOutputFile()
    : createEmptyOutputFile();
  outputFileDraft.value = { ...source };
  outputFileModalOpen.value = true;
}

function closeOutputFileModal() {
  outputFileModalOpen.value = false;
  editingOutputFileIndex.value = null;
  outputFileDraft.value = createEmptyOutputFile();
}

/** 拒绝只读内置 Agent 的交付文件弹窗写入。 */
function saveOutputFileModal() {
  if (isBuiltinReadonly.value) {
    message.info("内置 Agent 仅超管可修改");
    return;
  }
  const next = [...(form.value.outputDefinition.files ?? [])];
  const draft = { ...outputFileDraft.value };
  if (editingOutputFileIndex.value == null) {
    if (form.value.outputDefinition.deliveryMode === "file" && next.length >= 1) next[0] = draft;
    else next.push(draft);
  } else {
    next[editingOutputFileIndex.value] = draft;
  }
  form.value.outputDefinition.files = form.value.outputDefinition.deliveryMode === "file" ? next.slice(0, 1) : next;
  closeOutputFileModal();
}

/** 拒绝只读内置 Agent 的交付文件弹窗删除。 */
function deleteOutputFileFromModal() {
  if (isBuiltinReadonly.value) {
    message.info("内置 Agent 仅超管可修改");
    return;
  }
  if (editingOutputFileIndex.value != null) removeOutputFile(editingOutputFileIndex.value);
  closeOutputFileModal();
}

function openOutputFieldModal(index?: number) {
  editingOutputFieldIndex.value = typeof index === "number" ? index : null;
  const source = typeof index === "number"
    ? form.value.outputDefinition.requiredFields[index] ?? createEmptyField()
    : createEmptyField();
  outputFieldDraft.value = { ...source };
  outputFieldModalOpen.value = true;
}

function closeOutputFieldModal() {
  outputFieldModalOpen.value = false;
  editingOutputFieldIndex.value = null;
  outputFieldDraft.value = createEmptyField();
}

/** 拒绝只读内置 Agent 的输出字段弹窗写入。 */
function saveOutputFieldModal() {
  if (isBuiltinReadonly.value) {
    message.info("内置 Agent 仅超管可修改");
    return;
  }
  const next = [...form.value.outputDefinition.requiredFields];
  const draft = { ...outputFieldDraft.value };
  if (editingOutputFieldIndex.value == null) next.push(draft);
  else next[editingOutputFieldIndex.value] = draft;
  form.value.outputDefinition.requiredFields = next;
  closeOutputFieldModal();
}

/** 拒绝只读内置 Agent 的输出字段弹窗删除。 */
function deleteOutputFieldFromModal() {
  if (isBuiltinReadonly.value) {
    message.info("内置 Agent 仅超管可修改");
    return;
  }
  if (editingOutputFieldIndex.value != null) removeRoleField("output", editingOutputFieldIndex.value);
  closeOutputFieldModal();
}

function inputValue(event: Event): string {
  return String((event.target as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "");
}

function checkedValue(event: Event): boolean {
  return Boolean((event.target as HTMLInputElement | null)?.checked);
}

function updateToolRefField(index: number, key: "alias" | "usageGuidance", value: string) {
  const next = [...(form.value.toolRefs ?? [])];
  const current = { ...(next[index] ?? {}) };
  current[key] = value || null;
  next[index] = current;
  form.value.toolRefs = next;
}

function updateToolRefFlag(index: number, key: "required", value: boolean) {
  const next = [...(form.value.toolRefs ?? [])];
  const current = { ...(next[index] ?? {}) };
  current[key] = value;
  next[index] = current;
  form.value.toolRefs = next;
}

/** 清除历史角色窗口覆盖，运行时统一使用模型最大容量。 */
function sanitizeUnsupportedContextWindowOverrides(): void {
  for (const engine of executionEngines) {
    const customConfig = ensureExecutionProfile(engine).customConfig;
    if (customConfig) customConfig.contextWindow = null;
  }
}

/** 校验启用引擎、模型及自动压缩配置。 */
function validateExecutionConfig(): string | null {
  sanitizeUnsupportedContextWindowOverrides();
  const cfg = form.value.executionConfig;
  const enabledEngines = executionEngines.filter((engine) => cfg.engineProfiles[engine].enabled);
  if (!enabledEngines.length) return "至少启用一个执行引擎";
  if (!enabledEngines.includes(cfg.preferredEngine)) return "默认执行引擎必须是已启用引擎";
  for (const engine of executionEngines) {
    const profile = cfg.engineProfiles[engine];
    if (!profile.enabled) continue;
    const models = engineModels(engine);
    const engineLabel = engine === "codex" ? "Codex" : "Claude";
    if (!models.length) return `${engineLabel} 模型目录尚未加载或没有可用模型`;
    if (profile.mode === "auto") {
      if (!models.some((model) => model.isDefault)) return `${engineLabel} 模型目录缺少默认模型`;
      continue;
    }
    const customConfig = profile.customConfig;
    if (!customConfig) return `${engineLabel} 的自定义配置缺失`;
    const modelId = String(customConfig.model ?? "").trim();
    if (!modelId) return `请选择 ${engineLabel} 的角色模型`;
    if (!models.some((model) => model.id === modelId)) return `${engineLabel} 模型「${modelId}」已从模型目录移除，请重新选择`;
    if (!String(customConfig.accessMode ?? "").trim()) return `请选择 ${engineLabel} 的访问模式`;
    if (customConfig.autoCompactPct != null) {
      const autoCompactPct = Number(customConfig.autoCompactPct);
      if (!Number.isFinite(autoCompactPct) || autoCompactPct < 50 || autoCompactPct > 99) return "自动压缩阈值必须在 50 到 99 之间";
    }
  }
  return null;
}

function dedupeToolRefs(toolRefs: ToolRef[]): ToolRef[] {
  const seen = new Set<string>();
  const next: ToolRef[] = [];
  for (const toolRef of toolRefs) {
    const key = `${toolRef.toolsetId}::${toolRef.toolId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ ...toolRef });
  }
  return next;
}

function ensureExecutionProfile(engine: EngineType): RoleExecutionEngineProfile {
  return form.value.executionConfig.engineProfiles[engine];
}

function ensureCustomExecutionConfig(engine: EngineType) {
  const profile = ensureExecutionProfile(engine);
  if (profile.mode !== "custom") return null;
  if (!profile.customConfig) {
    profile.customConfig = createCatalogRoleExecutionCustomConfig(engine, engineModels(engine));
  }
  return profile.customConfig;
}

function selectExecutionEngine(engine: EngineType) {
  selectedExecutionEngine.value = engine;
}

function setPreferredExecutionEngine(engine: EngineType) {
  const targetEngine = engine === "claude" ? "claude" : "codex";
  const profile = ensureExecutionProfile(targetEngine);
  if (!profile.enabled) profile.enabled = true;
  form.value.executionConfig.preferredEngine = targetEngine;
}

function updateExecutionProfileEnabled(engine: EngineType, enabled: boolean) {
  const profile = ensureExecutionProfile(engine);
  profile.enabled = enabled;
  if (!enabled) {
    if (form.value.executionConfig.preferredEngine === engine) {
      const fallback = executionEngines.find((item) => item !== engine && ensureExecutionProfile(item).enabled) ?? null;
      if (fallback) {
        form.value.executionConfig.preferredEngine = fallback;
      }
    }
    if (!executionEngines.some((item) => ensureExecutionProfile(item).enabled)) {
      profile.enabled = true;
      form.value.executionConfig.preferredEngine = engine;
    }
  }
}

function updateExecutionProfileMode(engine: EngineType, mode: "auto" | "custom") {
  const profile = ensureExecutionProfile(engine);
  profile.mode = mode;
  profile.customConfig = mode === "custom"
    ? (profile.customConfig ?? createCatalogRoleExecutionCustomConfig(engine, engineModels(engine)))
    : null;
}

function executionProfileSummary(engine: EngineType): string {
  const profile = ensureExecutionProfile(engine);
  if (!profile.enabled) return "未启用";
  if (profile.mode === "auto") return "自动";
  const customConfig = profile.customConfig;
  if (!customConfig) return "自定义";
  return `${customConfig.model} / ${customConfig.effort || "无 effort"} / ${customConfig.accessMode}`;
}

function skillTargetEnginesLabel(values: readonly string[]): string {
  return values.map((value) => value === "claude" ? "Claude" : "Codex").join(" / ");
}

watch(
  () => [
    selectedExecutionEngine.value,
    selectedExecutionProfile.value.mode,
    resolvedModelInfo.value?.id,
    hasEffortCatalog.value,
    form.value.executionConfig,
    engines.lastUpdatedAt,
  ] as const,
  () => {
    sanitizeUnsupportedContextWindowOverrides();
    const customConfig = ensureCustomExecutionConfig(selectedExecutionEngine.value);
    if (!customConfig) return;
    const supportedEfforts = resolvedModelInfo.value?.supportedReasoningEfforts ?? [];
    if (!supportedEfforts.length) {
      customConfig.effort = "";
      return;
    }
    if (!supportedEfforts.some((item) => item.reasoningEffort === customConfig.effort)) {
      customConfig.effort = resolvedModelInfo.value?.defaultReasoningEffort ?? supportedEfforts[0]?.reasoningEffort ?? "";
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="role-form">
    <div class="role-form__header">
      <h3 class="role-form__title">{{ form.name || "未命名角色" }}</h3>
      <div v-if="!isBuiltinReadonly" class="role-form__header-actions">
        <button class="role-form__save-btn" @click="onSave"><SaveOutlined /> {{ props.saveLabel || "保存" }}</button>
      </div>
      <span v-else class="role-form__header-badge">内置只读</span>
    </div>

    <div class="role-form__tabs">
      <button
        v-for="tab in visibleFormTabs"
        :key="tab"
        class="role-form__tab"
        :class="{ 'role-form__tab--active': formTab === tab }"
        @click="formTab = tab"
      >
        {{ tabLabel(tab) }}
      </button>
    </div>

    <fieldset :disabled="isBuiltinReadonly" class="role-form__readonly-fieldset role-form__readonly-fieldset--main">
    <div v-if="formTab === 'basic'" class="role-form__section role-form__section--basic">
      <label class="role-form__field"><span>角色名称</span><input v-model="form.name" class="role-form__input" placeholder="例如：开发工程师 / 测试工程师 / 需求分析师" /></label>
      <div class="role-form__field">
        <label class="role-form__field-label" for="orch-role-description">描述</label>
        <textarea id="orch-role-description" v-model="form.description" class="role-form__textarea" rows="5" placeholder="一句话说明这个角色存在的价值" />
        <small class="role-form__field-help">描述可写多行，建议包含角色摘要、能力与价值说明。</small>
      </div>
      <label class="role-form__field"><span>职责边界</span><textarea v-model="form.responsibility" class="role-form__textarea" rows="4" placeholder="明确这个角色负责什么、不负责什么。" /></label>
      <div class="role-form__field role-form__field--grow">
        <label class="role-form__field-label" for="orch-role-system-prompt">系统提示词</label>
        <textarea id="orch-role-system-prompt" v-model="form.systemPrompt" class="role-form__textarea role-form__textarea--fill" rows="12" placeholder="注入到 system 层的长期规则，例如工程纪律、禁止事项、角色身份约束。" />
        <small class="role-form__field-help">建议至少写清角色身份、必须遵守的规则、边界限制，以及失败或风险时该怎么表达。</small>
      </div>
    </div>

    <div v-if="formTab === 'input'" class="role-form__section">
      <section class="role-form__card">
        <div class="role-form__summary-row">
          <span class="role-form__summary-pill">输入说明</span>
          <span class="role-form__summary-pill">{{ form.inputDefinition.requiredFields.length }} 个字段</span>
        </div>
        <label class="role-form__field">
          <span>输入说明</span>
          <textarea v-model="form.inputDefinition.instructions" class="role-form__textarea" rows="7" placeholder="例如：收到需求、上游方案、关键文件路径和人工反馈后，先总结约束，再进入实现。可使用 {{requirement}}、{{boundFields.designDocPath}} 这类模板变量。" />
          <small class="role-form__field-help">先写整体规则，再补结构化字段。多数角色真正需要维护的是这段说明，不是长表单。</small>
        </label>

        <div class="role-form__section-header">
          <h4>输入字段</h4>
          <button class="role-form__add-field" @click="addRoleField('input')"><PlusOutlined /> 添加字段</button>
        </div>

        <div v-if="form.inputDefinition.requiredFields.length" class="role-form__builder">
          <aside class="role-form__builder-list">
            <component
              v-for="(field, index) in form.inputDefinition.requiredFields"
              :key="`input-${index}`"
              :is="readonlyNavigationTag"
              :type="isBuiltinReadonly ? undefined : 'button'"
              class="role-form__builder-item"
              :class="{ 'role-form__builder-item--active': selectedInputFieldIndex === index }"
              role="button"
              tabindex="0"
              :aria-pressed="selectedInputFieldIndex === index"
              @click="selectRoleField('input', index)"
              @keydown.enter.prevent="selectRoleField('input', index)"
              @keydown.space.prevent="selectRoleField('input', index)"
            >
              <strong>{{ fieldTitle(field, index) }}</strong>
              <span>{{ field.key || "未填写 key" }}</span>
              <small>{{ field.valueType }} · {{ field.required ? "必需" : "可选" }}</small>
            </component>
          </aside>

          <div class="role-form__builder-detail">
            <div v-if="form.inputDefinition.requiredFields[selectedInputFieldIndex]" class="role-form__field-card">
              <div class="role-form__section-header">
                <h4>{{ fieldTitle(form.inputDefinition.requiredFields[selectedInputFieldIndex], selectedInputFieldIndex) }}</h4>
                <button class="role-form__icon-btn" @click="removeRoleField('input', selectedInputFieldIndex)"><DeleteOutlined /></button>
              </div>
              <div class="role-form__field-grid">
                <label class="role-form__field"><span>字段 key</span><input v-model="form.inputDefinition.requiredFields[selectedInputFieldIndex].key" class="role-form__input" placeholder="例如：designDocPath" /></label>
                <label class="role-form__field"><span>显示名称</span><input v-model="form.inputDefinition.requiredFields[selectedInputFieldIndex].label" class="role-form__input" placeholder="例如：设计文档路径" /></label>
                <label class="role-form__field"><span>字段类型</span><select v-model="form.inputDefinition.requiredFields[selectedInputFieldIndex].valueType" class="role-form__select"><option value="text">text</option><option value="markdown">markdown</option><option value="json">json</option><option value="file-path">file-path</option></select></label>
                <label class="role-form__field">
                  <span>是否必需</span>
                  <a-switch class="app-form-switch" v-model:checked="form.inputDefinition.requiredFields[selectedInputFieldIndex].required" :disabled="isBuiltinReadonly" checked-children="必需" un-checked-children="可选" />
                </label>
                <label class="role-form__field role-form__field--full"><span>字段说明</span><textarea v-model="form.inputDefinition.requiredFields[selectedInputFieldIndex].description" class="role-form__textarea" rows="3" placeholder="告诉角色这个字段是干什么的。" /></label>
                <label class="role-form__field role-form__field--full"><span>示例（可选）</span><input v-model="form.inputDefinition.requiredFields[selectedInputFieldIndex].example" class="role-form__input" placeholder="例如：docs/solution-plan.md" /></label>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="role-form__empty-state">
          当前没有输入字段。只有在您确实需要稳定字段名时，才建议在这里添加。
        </div>
      </section>
    </div>

    <div v-if="formTab === 'output'" class="role-form__section">
      <section class="role-form__card">
        <div class="role-form__summary-row">
          <span class="role-form__summary-pill">交付方式：{{ outputSummaryModeLabel }}</span>
          <span class="role-form__summary-pill">默认格式：{{ form.outputDefinition.format }}</span>
          <span v-if="usesFileDelivery" class="role-form__summary-pill">{{ (form.outputDefinition.files ?? []).length }} 个文件配置</span>
          <span class="role-form__summary-pill">{{ form.outputDefinition.requiredFields.length }} 个字段</span>
        </div>
        <div class="role-form__field-grid">
          <label class="role-form__field">
            <span>交付方式</span>
            <select v-model="outputDeliveryChannel" class="role-form__select">
              <option value="direct">直接输出</option>
              <option value="file">文件交付</option>
            </select>
            <small class="role-form__field-help">先决定结果是直接回填到流程，还是先写成正式文件再回传路径。</small>
          </label>
          <label v-if="usesFileDelivery" class="role-form__field">
            <span>文件数量</span>
            <select v-model="outputFileMode" class="role-form__select">
              <option value="file">单文件</option>
              <option value="file-set">多文件</option>
            </select>
            <small class="role-form__field-help">单文件适合一个主文档；多文件适合主文档 + 附件、原型目录、截图索引等成套交付。</small>
          </label>
          <label class="role-form__field">
            <span>{{ usesFileDelivery ? '默认文件格式' : '输出格式' }}</span>
            <select v-model="form.outputDefinition.format" class="role-form__select"><option value="markdown">Markdown</option><option value="text">Text</option><option value="json">JSON</option><option value="yaml">YAML</option><option value="html">HTML</option><option value="javascript">JavaScript</option><option value="css">CSS</option><option value="sql">SQL</option><option value="image">Image</option></select>
          </label>
          <label class="role-form__field role-form__field--full">
            <span>结果名称（供流程引用）</span>
            <input v-model="form.outputDefinition.resultKey" class="role-form__input" placeholder="例如：analysis-report / solution-plan / implementation-report / verification-report" />
            <small class="role-form__field-help">系统会用这个名字归类这类结果；后续节点要引用它、执行详情要展示它，都会按这个名称来识别。</small>
          </label>
          <label v-if="!usesFileDelivery" class="role-form__field role-form__field--full">
            <span>输出说明</span>
            <textarea v-model="form.outputDefinition.instructions" class="role-form__textarea" rows="7" placeholder="例如：请输出 Markdown；必须包含修改文件清单、核心改动、验证结果和风险。可直接写建议结构，如：# 修改文件 # 实现说明 # 测试结果 # 风险与待确认项。" />
            <small class="role-form__field-help">直接输出时，这里定义角色最终正文该怎么写；如果需要文件交付，请把每个文件的内容要求写到下面的文件配置里。</small>
          </label>
          <label v-if="usesFileDelivery" class="role-form__field role-form__field--full">
            <span>整体交付规则（可留空）</span>
            <textarea v-model="form.outputDefinition.filePathRule" class="role-form__textarea" rows="3" placeholder="例如：统一写到 工作流文档根目录/功能/首页改版--a1b2c3d4/开发工程师/ 下；如果是单文件，可直接给出完整文件路径。" />
            <small class="role-form__field-help">这条规则描述整批交付的共同边界；如果每个文件各有路径要求，请在下面的文件配置里逐项补充。</small>
          </label>
        </div>

        <div v-if="usesFileDelivery" class="role-form__section-header">
          <h4>文件配置</h4>
        </div>

        <div v-if="usesFileDelivery" class="role-form__chip-grid">
            <component
              v-for="(file, index) in (form.outputDefinition.files ?? [])"
              :key="`output-file-${index}`"
              :is="readonlyNavigationTag"
              :type="isBuiltinReadonly ? undefined : 'button'"
              class="role-form__chip-btn"
              role="button"
              tabindex="0"
              @click="openOutputFileModal(index)"
              @keydown.enter.prevent="openOutputFileModal(index)"
              @keydown.space.prevent="openOutputFileModal(index)"
            >
              <strong>{{ outputFileTitle(file, index) }}</strong>
              <small>{{ outputFileFormatLabel(file) }}</small>
            </component>
            <button
              class="role-form__chip-btn role-form__chip-btn--add"
              type="button"
              @click="openOutputFileModal()"
            >
              <PlusOutlined />
              <strong>{{ outputFileMode === 'file' ? ((form.outputDefinition.files ?? []).length ? '重新配置文件' : '配置交付文件') : '添加交付项' }}</strong>
            </button>
        </div>

        <div class="role-form__section-header">
          <h4>输出字段</h4>
        </div>

        <div class="role-form__chip-grid">
            <component
              v-for="(field, index) in form.outputDefinition.requiredFields"
              :key="`output-${index}`"
              :is="readonlyNavigationTag"
              :type="isBuiltinReadonly ? undefined : 'button'"
              class="role-form__chip-btn"
              role="button"
              tabindex="0"
              @click="openOutputFieldModal(index)"
              @keydown.enter.prevent="openOutputFieldModal(index)"
              @keydown.space.prevent="openOutputFieldModal(index)"
            >
              <strong>{{ fieldTitle(field, index) }}</strong>
            </component>
            <button class="role-form__chip-btn role-form__chip-btn--add" type="button" @click="openOutputFieldModal()">
              <PlusOutlined />
              <strong>添加字段</strong>
            </button>
        </div>

        <div v-if="!form.outputDefinition.requiredFields.length" class="role-form__empty-inline">
          当前没有输出字段。若想强制角色稳定输出“修改文件清单”“验证结论”等内容，再补这里。
        </div>
      </section>
    </div>

    <a-modal
      :open="outputFileModalOpen"
      :title="editingOutputFileIndex == null ? (outputFileMode === 'file' ? '配置交付文件' : '添加交付项') : (outputFileMode === 'file' ? '配置交付文件' : '编辑交付项')"
      :footer="null"
      width="min(92vw, 1120px)"
      wrap-class-name="orch-asset-modal orch-asset-editor-modal role-form-modal"
      :body-style="{ maxHeight: '88vh', overflowY: 'auto' }"
      @cancel="closeOutputFileModal"
    >
      <fieldset :disabled="isBuiltinReadonly" class="role-form__readonly-fieldset">
      <div class="role-form__field-grid">
        <label class="role-form__field">
          <span>{{ outputFileMode === "file" ? "文件名称" : "交付项名称" }}</span>
          <input
            v-model="outputFileDraft.name"
            class="role-form__input"
            :placeholder="outputFileMode === 'file' ? '例如：implementation-report.md' : '例如：主报告 / 原型目录 / 截图索引'"
          />
        </label>
        <label class="role-form__field">
          <span>文件格式</span>
          <select v-model="outputFileDraft.format" class="role-form__select">
            <option value="">跟随默认格式</option>
            <option value="markdown">Markdown</option>
            <option value="text">Text</option>
            <option value="json">JSON</option>
            <option value="yaml">YAML</option>
            <option value="html">HTML</option>
            <option value="javascript">JavaScript</option>
            <option value="css">CSS</option>
            <option value="sql">SQL</option>
            <option value="image">Image</option>
          </select>
        </label>
        <label class="role-form__field">
          <span>是否必须交付</span>
          <a-switch class="app-form-switch" v-model:checked="outputFileDraft.required" :disabled="isBuiltinReadonly" checked-children="必须" un-checked-children="可选" />
        </label>
        <label class="role-form__field role-form__field--full">
          <span>{{ outputFileMode === "file" ? "文件路径" : "文件路径规则" }}</span>
          <textarea
            v-model="outputFileDraft.pathRule"
            class="role-form__textarea"
            rows="3"
            :placeholder="outputFileMode === 'file' ? '例如：codeflow-docs/功能/首页改版--a1b2c3d4/开发工程师/implementation-report.md' : '例如：写到 codeflow-docs/功能/首页改版--a1b2c3d4/开发工程师/ 下，文件名由该交付项决定'"
          />
        </label>
        <label class="role-form__field role-form__field--full">
          <span>文件内容要求 / 交付骨架</span>
          <textarea v-model="outputFileDraft.description" class="role-form__textarea role-form__textarea--delivery" rows="12" placeholder="例如：这份文件必须包含哪些章节、写到什么粒度、和其它交付项如何配合；如果有固定骨架，也直接写在这里。" />
        </label>
      </div>
      </fieldset>
      <div class="role-form__modal-actions">
        <button v-if="editingOutputFileIndex != null" class="role-form__danger-btn" type="button" :disabled="isBuiltinReadonly" @click="deleteOutputFileFromModal">删除</button>
        <div class="role-form__modal-spacer" />
        <button class="role-form__ghost-btn" type="button" @click="closeOutputFileModal">取消</button>
        <button class="role-form__save-btn" type="button" :disabled="isBuiltinReadonly" @click="saveOutputFileModal"><SaveOutlined /> 保存</button>
      </div>
    </a-modal>

    <a-modal
      :open="outputFieldModalOpen"
      :title="editingOutputFieldIndex == null ? '添加输出字段' : '编辑输出字段'"
      :footer="null"
      width="min(88vw, 960px)"
      wrap-class-name="orch-asset-modal orch-asset-editor-modal role-form-modal"
      :body-style="{ maxHeight: '72vh', overflowY: 'auto' }"
      @cancel="closeOutputFieldModal"
    >
      <fieldset :disabled="isBuiltinReadonly" class="role-form__readonly-fieldset">
      <div class="role-form__field-grid">
        <label class="role-form__field">
          <span>显示名称</span>
          <input v-model="outputFieldDraft.label" class="role-form__input" placeholder="例如：修改文件清单" />
        </label>
        <label class="role-form__field">
          <span>字段标识（供流程引用）</span>
          <input v-model="outputFieldDraft.key" class="role-form__input" placeholder="例如：changedFiles" />
        </label>
        <label class="role-form__field">
          <span>字段类型</span>
          <select v-model="outputFieldDraft.valueType" class="role-form__select"><option value="text">text</option><option value="markdown">markdown</option><option value="json">json</option><option value="file-path">file-path</option></select>
        </label>
        <label class="role-form__field">
          <span>是否必需</span>
          <a-switch class="app-form-switch" v-model:checked="outputFieldDraft.required" :disabled="isBuiltinReadonly" checked-children="必需" un-checked-children="可选" />
        </label>
        <label class="role-form__field role-form__field--full">
          <span>字段说明</span>
          <textarea v-model="outputFieldDraft.description" class="role-form__textarea" rows="4" placeholder="告诉角色这个字段必须如何交付。" />
        </label>
        <label class="role-form__field role-form__field--full">
          <span>示例（可选）</span>
          <input v-model="outputFieldDraft.example" class="role-form__input" placeholder="例如：src/index.ts, tests/index.test.ts" />
        </label>
      </div>
      </fieldset>
      <div class="role-form__modal-actions">
        <button v-if="editingOutputFieldIndex != null" class="role-form__danger-btn" type="button" :disabled="isBuiltinReadonly" @click="deleteOutputFieldFromModal">删除</button>
        <div class="role-form__modal-spacer" />
        <button class="role-form__ghost-btn" type="button" @click="closeOutputFieldModal">取消</button>
        <button class="role-form__save-btn" type="button" :disabled="isBuiltinReadonly" @click="saveOutputFieldModal"><SaveOutlined /> 保存</button>
      </div>
    </a-modal>

    <div v-if="formTab === 'gates'" class="role-form__section">
      <div class="role-form__hint">支持确定性门禁和 AI 文本描述门禁。AI 门禁会在产物落库后独立评估，并要求返回理由与原文证据。</div>
      <div v-for="(gate, index) in form.gateCriteria" :key="gate.id" class="role-form__card">
        <div class="role-form__gate-header">
          <span>#{{ index + 1 }}</span>
          <select v-model="gate.type" class="role-form__select"><option value="regex">regex</option><option value="json-schema">json-schema</option><option value="ai">AI 文本描述</option></select>
          <a-switch class="app-form-switch" v-model:checked="gate.blocking" :disabled="isBuiltinReadonly" checked-children="阻断" un-checked-children="提示" />
          <button class="role-form__icon-btn" @click="removeGate(index)"><DeleteOutlined /></button>
        </div>
        <textarea v-model="gate.config" class="role-form__textarea" rows="4" maxlength="4000" :placeholder="gateConfigPlaceholder(gate.type)" />
      </div>
      <button class="role-form__add-field" @click="addGate"><PlusOutlined /> 添加门禁</button>
    </div>

    <div v-if="canUseKnowledgeAndToolsTabs && formTab === 'knowledge'" class="role-form__section">
      <div class="role-form__hint">这里选择的是角色默认知识库。运行时会与流程默认知识库、节点额外知识库合并，整理成该节点这次执行可访问的知识范围。</div>
      <div v-if="visibleKnowledgeBundles.length" class="role-form__check-grid">
        <label v-for="bundle in visibleKnowledgeBundles" :key="bundle.id" class="role-form__check-card">
          <input v-model="form.defaultKnowledgeBundleIds" type="checkbox" :value="bundle.id" />
          <div><strong>{{ bundle.name }}</strong><p>{{ bundle.scope }} · {{ knowledgeSourceCount(bundle) }} 个来源</p></div>
        </label>
      </div>
      <div v-else class="role-form__hint">当前工作区还没有知识库，请先到“知识库”页创建。</div>
    </div>

    <div v-if="canUseKnowledgeAndToolsTabs && formTab === 'skills'" class="role-form__section">
      <div class="role-form__hint">这里选择的是角色默认 Skill。所有绑定 Skill 必须匹配当前执行引擎；不匹配、缺失或跨工作区会直接失败。</div>
      <div v-if="visibleSkills.length" class="role-form__check-grid">
        <label v-for="skill in visibleSkills" :key="skill.id" class="role-form__check-card">
          <input v-model="form.defaultSkillIds" type="checkbox" :value="skill.id" />
          <div><strong>{{ skill.name }}</strong><p>{{ skillTargetEnginesLabel(skill.targetEngines) }} · {{ skill.description || '无描述' }}</p></div>
        </label>
      </div>
      <div v-else class="role-form__hint">当前工作区还没有 Skill，请先到“Skills”页创建。</div>
    </div>

    <div v-if="canUseKnowledgeAndToolsTabs && formTab === 'tools'" class="role-form__section">
      <div class="role-form__hint">
        这里绑定的是角色可以使用的工具。工具定义里的“通用使用策略与边界”描述这个工具本身怎么用；
        下面“角色工具绑定”里的内容只写这个角色的额外要求，例如必须先看方案再运行、禁止直接改生产配置、优先用它做检索而不是修改。
      </div>
      <div v-if="groupedTools.length" class="role-form__tool-groups">
        <section v-for="group in groupedTools" :key="group.toolsetId" class="role-form__card">
          <div class="role-form__section-header"><strong>{{ group.toolsetName }}</strong><span>{{ group.tools.length }} 个工具</span></div>
          <p v-if="group.description" class="role-form__meta">{{ group.description }}</p>
          <div v-if="group.tools.length" class="role-form__check-grid">
            <label v-for="tool in group.tools" :key="`${group.toolsetId}-${tool.id}`" class="role-form__check-card">
              <input :checked="selectedToolRefKeys.has(`${group.toolsetId}::${tool.id}`)" type="checkbox" @change="toggleToolRef({ toolsetId: group.toolsetId, toolId: tool.id }, Boolean(($event.target as HTMLInputElement).checked))" />
              <div><strong>{{ tool.name }}</strong><p>{{ tool.runtime }} · {{ tool.description || '无描述' }}</p></div>
            </label>
          </div>
        </section>
      </div>
      <div v-if="selectedToolBindings.length" class="role-form__tool-bindings">
        <div class="role-form__section-header"><h4>角色工具绑定</h4><span class="role-form__meta">{{ selectedToolBindings.length }} 个已选工具</span></div>
        <div v-for="binding in selectedToolBindings" :key="`${binding.ref.toolsetId}::${binding.ref.toolId}`" class="role-form__card">
          <div class="role-form__section-header">
            <div><strong>{{ binding.toolsetName }} / {{ binding.toolName }}</strong><p class="role-form__meta">{{ binding.runtime || '-' }} · {{ binding.description || '无描述' }}</p></div>
            <a-switch class="app-form-switch" :checked="Boolean(binding.ref.required)" :disabled="isBuiltinReadonly" checked-children="优先" un-checked-children="普通" @change="(checked: boolean) => updateToolRefFlag(binding.index, 'required', checked)" />
          </div>
          <div class="role-form__field-grid">
            <label class="role-form__field"><span>调用别名</span><input :value="binding.ref.alias ?? ''" class="role-form__input" placeholder="例如：运行测试 / 检索源码" @input="updateToolRefField(binding.index, 'alias', inputValue($event))" /></label>
            <label class="role-form__field">
              <span>角色额外要求</span>
              <textarea
                :value="binding.ref.usageGuidance ?? ''"
                class="role-form__textarea"
                rows="4"
                placeholder="只写这个角色的特殊约束，例如：
1. 必须先阅读上游方案再调用
2. 只允许用于检索，不允许直接执行修改
3. 调用失败后先总结原因，再决定是否重试"
                @input="updateToolRefField(binding.index, 'usageGuidance', inputValue($event))"
              />
            </label>
          </div>
        </div>
      </div>
      <div v-if="selectedToolSummaryLines().length" class="role-form__hint-card"><strong>当前已选工具</strong><p>{{ selectedToolSummaryLines().join("、") }}</p></div>
    </div>

    <div v-if="formTab === 'config'" class="role-form__section">
      <div class="role-form__hint">角色执行配置已经升级为多引擎 profile。您可以分别决定 Claude / Codex 是否启用、走自动还是自定义；自动模式只吃模型清单默认值，自定义模式才覆盖模型、思考强度、访问模式和运行参数。</div>

      <div class="role-form__engine-switcher">
        <component
          v-for="engine in executionEngines"
          :key="engine"
          :is="readonlyNavigationTag"
          :type="isBuiltinReadonly ? undefined : 'button'"
          class="role-form__engine-switch"
          :class="{ 'role-form__engine-switch--active': selectedExecutionEngine === engine }"
          role="button"
          tabindex="0"
          :aria-pressed="selectedExecutionEngine === engine"
          @click="selectExecutionEngine(engine)"
          @keydown.enter.prevent="selectExecutionEngine(engine)"
          @keydown.space.prevent="selectExecutionEngine(engine)"
        >
          <strong>{{ engine === "codex" ? "Codex" : "Claude" }}</strong>
          <span>{{ executionProfileSummary(engine) }}</span>
          <small>{{ form.executionConfig.preferredEngine === engine ? "默认执行引擎" : "可选引擎" }}</small>
        </component>
      </div>

      <div class="role-form__field-grid">
        <label class="role-form__field">
          <span>当前编辑引擎</span>
          <select :value="selectedExecutionEngine" class="role-form__select" @change="selectExecutionEngine(inputValue($event) === 'claude' ? 'claude' : 'codex')">
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label class="role-form__field">
          <span>是否启用</span>
            <a-switch class="app-form-switch" :checked="selectedExecutionProfile.enabled" :disabled="isBuiltinReadonly" checked-children="启用" un-checked-children="停用" @change="(checked: boolean) => updateExecutionProfileEnabled(selectedExecutionEngine, checked)" />
        </label>
        <label class="role-form__field">
          <span>执行模式</span>
          <select :value="selectedExecutionProfile.mode" class="role-form__select" :disabled="!selectedExecutionProfile.enabled" @change="updateExecutionProfileMode(selectedExecutionEngine, inputValue($event) === 'custom' ? 'custom' : 'auto')">
            <option value="auto">自动</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        <div class="role-form__field">
          <span>默认执行引擎</span>
          <button class="role-form__ghost-btn" type="button" :disabled="!selectedExecutionProfile.enabled || form.executionConfig.preferredEngine === selectedExecutionEngine" @click="setPreferredExecutionEngine(selectedExecutionEngine)">
            {{ form.executionConfig.preferredEngine === selectedExecutionEngine ? "当前默认引擎" : "设为默认引擎" }}
          </button>
        </div>
      </div>

      <div v-if="!selectedExecutionProfile.enabled" class="role-form__hint-card">
        <strong>{{ selectedExecutionEngine === "codex" ? "Codex" : "Claude" }} 当前未启用</strong>
        <p>未启用的引擎不会出现在流程强制切换候选里，也不会被该角色实际使用。</p>
      </div>
      <div v-else-if="selectedExecutionProfile.mode === 'auto'" class="role-form__hint-card">
        <strong>自动模式</strong>
        <p>自动模式只使用模型清单默认配置，不继承最近聊天会话配置，确保编排执行可重放。</p>
        <p>当前默认值：模型 {{ selectedProfileResolvedConfig?.model ?? "-" }}，思考强度 {{ selectedProfileResolvedConfig?.effort || "未配置" }}，访问模式 {{ selectedProfileResolvedConfig?.accessMode ?? "-" }}，最大重试 {{ selectedProfileResolvedConfig?.maxRetries ?? 0 }}。</p>
      </div>
      <template v-else-if="selectedExecutionProfile.customConfig">
        <div class="role-form__field-grid">
          <label class="role-form__field">
            <span>模型</span>
            <a-select v-model:value="selectedExecutionProfile.customConfig.model" :disabled="isBuiltinReadonly || !hasModelCatalog" show-search :options="modelOptions" option-filter-prop="label" class="role-form__select-control" :placeholder="hasModelCatalog ? '选择模型' : '模型目录尚未加载'" />
          </label>
          <label class="role-form__field"><span>访问模式</span><a-select v-model:value="selectedExecutionProfile.customConfig.accessMode" :disabled="isBuiltinReadonly" :options="accessModeOptions" class="role-form__select-control" /></label>
          <label class="role-form__field">
            <span>思考强度</span>
            <a-select v-if="hasEffortCatalog" v-model:value="selectedExecutionProfile.customConfig.effort" :disabled="isBuiltinReadonly" :options="effortOptions" class="role-form__select-control" placeholder="选择思考强度" />
            <input v-else class="role-form__input" value="不发送" disabled />
          </label>
          <label class="role-form__field"><span>最大重试次数</span><input v-model.number="selectedExecutionProfile.customConfig.maxRetries" type="number" class="role-form__input" placeholder="0" /></label>
          <label v-if="showAutoCompactField" class="role-form__field">
            <span>自动压缩阈值</span>
            <div class="role-form__range-block">
              <div class="role-form__range-header">
                <strong>{{ selectedAutoCompactPct }}%</strong>
                <span class="role-form__range-hint">默认 {{ PRODUCT_DEFAULT_AUTO_COMPACT_PCT }}%</span>
              </div>
              <div class="role-form__range-slider">
                <span class="role-form__range-bound">{{ autoCompactMin }}%</span>
                <a-slider
                  v-model:value="selectedAutoCompactPct"
                  :disabled="isBuiltinReadonly"
                  :min="autoCompactMin"
                  :max="autoCompactMax"
                  :step="1"
                  :tooltip="{ formatter: (value?: number) => `${value ?? PRODUCT_DEFAULT_AUTO_COMPACT_PCT}%` }"
                />
                <span class="role-form__range-bound">{{ autoCompactMax }}%</span>
              </div>
            </div>
            <small class="role-form__field-help">{{ selectedExecutionEngine === "claude" ? "Claude 会直接使用该百分比控制自动压缩；" : "Codex 会在运行时按当前上下文窗口把该百分比换算成 model_auto_compact_token_limit；" }}默认 {{ PRODUCT_DEFAULT_AUTO_COMPACT_PCT }}%，可按需要提前或延后触发。</small>
          </label>
        </div>
      </template>
    </div>
    </fieldset>
  </div>
</template>

<style scoped>
.role-form {
  --role-form-control-bg: color-mix(in srgb, var(--app-panel-bg,#fff) 88%, #f5f0e6);
  --role-form-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#fff) 78%, #f9f5ed);
  --role-form-control-border: color-mix(in srgb, var(--app-border,#d9d9d9) 82%, #d9cfbf);
  --role-form-control-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 18%, #d3c7b7);
  --role-form-control-shadow: 0 0 0 1px color-mix(in srgb, #f0eee6 88%, transparent), inset 0 1px 0 rgba(255,255,255,0.78);
  --role-form-control-shadow-hover: 0 0 0 1px color-mix(in srgb, #d1cfc5 82%, transparent), inset 0 1px 0 rgba(255,255,255,0.86);
  --role-form-control-focus: #3898ec;
  --role-form-control-focus-ring: inset 0 0 0 1px var(--role-form-control-focus), 0 0 0 3px color-mix(in srgb, #3898ec 18%, transparent);
  --role-form-chip-bg: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #faf5ec), color-mix(in srgb, var(--app-bg,#fff) 96%, #fffaf2));
  --role-form-chip-bg-hover: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 94%, #fffaf2), color-mix(in srgb, var(--app-bg,#fff) 88%, #f7eadc));
  --role-form-chip-border: color-mix(in srgb, var(--app-border,#d9d9d9) 78%, #d8c9b4);
  --role-form-chip-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 26%, #d2bea6);
  --role-form-chip-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 10px 22px rgba(88,58,32,0.04);
  --role-form-chip-shadow-hover: 0 0 0 1px color-mix(in srgb, #d8cec0 74%, transparent), 0 14px 26px rgba(88,58,32,0.1);
  padding: 0;
  height: 100%;
  min-height: 0;
  display:flex;
  flex-direction:column;
  overflow: hidden;
}
.role-form__readonly-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.role-form__readonly-fieldset--main { display:flex; flex:1 1 auto; min-height:0; flex-direction:column; overflow:hidden; }
.role-form__header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.role-form__header-actions { display:flex; align-items:center; gap:10px; }
.role-form__header-badge {
  display:inline-flex;
  align-items:center;
  min-height:28px;
  padding:0 10px;
  border-radius:999px;
  background:color-mix(in srgb, #94a3b8 14%, #fff);
  color:#475569;
  font-size:12px;
  font-weight:600;
}
.role-form__title { margin:0; font-size:16px; font-weight:600; }
.role-form__save-btn,.role-form__add-field,.role-form__icon-btn { cursor:pointer; }
.role-form__save-btn {
  min-height:34px;
  padding:6px 14px;
  border:none;
  border-radius:10px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-accent,#c96442) 90%, #d97757), color-mix(in srgb, var(--app-accent,#c96442) 96%, #bb5737));
  color:#fff;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  font-size:13px;
  line-height:1;
  box-shadow:0 12px 24px rgba(201,100,66,0.18);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}
.role-form__save-btn:not(:disabled):hover {
  transform: translateY(-1px);
  filter: brightness(1.05);
  box-shadow: 0 14px 28px rgba(201,100,66,0.26);
}
.role-form__save-btn:not(:disabled):active {
  transform: translateY(0) scale(0.98);
  filter: brightness(0.94);
  box-shadow: 0 6px 12px rgba(201,100,66,0.16);
}
.role-form__save-btn:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--app-accent,#c96442) 28%, transparent);
  outline-offset: 2px;
}
.role-form__tabs { display:flex; flex-wrap:wrap; border-bottom:1px solid var(--app-border,#e8e8e8); margin-bottom:16px; }
.role-form__tab { padding:8px 14px; border:none; background:none; font-size:13px; color:var(--app-muted,#999); border-bottom:2px solid transparent; cursor:pointer; }
.role-form__tab--active { color:var(--app-primary,#1677ff); border-bottom-color:var(--app-primary,#1677ff); }
.role-form__section { display:flex; flex:1 1 auto; min-height:0; flex-direction:column; gap:14px; overflow:auto; padding-right:4px; }
/* 基本信息 tab 也走默认 overflow:auto，避免视口偏矮时「系统提示词」长 textarea 被外层 overflow:hidden 截掉无法滚动 */
.role-form__subtabs { display:flex; gap:8px; }
.role-form__subtab { padding:8px 14px; border:1px solid var(--app-border,#d9d9d9); border-radius:999px; background:var(--app-bg,#fff); color:var(--app-muted,#666); font-size:13px; cursor:pointer; }
.role-form__subtab--active { border-color:var(--app-primary,#1677ff); background:#eaf3ff; color:var(--app-primary,#1677ff); }
.role-form__card,.role-form__hint,.role-form__hint-card,.role-form__check-card { border:1px solid var(--app-border,#e8e8e8); border-radius:10px; }
.role-form__card { padding:14px; display:flex; flex-direction:column; gap:12px; }
.role-form__hint,.role-form__hint-card { padding:12px; font-size:12px; line-height:1.7; color:var(--app-muted,#666); background:#f5f8fc; }
.role-form__hint strong { display:block; margin-bottom:4px; color:var(--app-text,#333); font-size:12px; }
.role-form__hint p { margin:0; }
.role-form__hint--guide { border-left:4px solid var(--app-primary,#1677ff); border-radius:10px; }
.role-form__hint-card strong { display:block; margin-bottom:4px; color:var(--app-text,#333); }
.role-form__hint-card p,.role-form__meta { margin:0; font-size:12px; color:var(--app-muted,#666); }
.role-form__summary-row { display:flex; flex-wrap:wrap; gap:8px; }
.role-form__summary-pill { padding:5px 10px; border-radius:999px; background:#eef4fb; color:#4c6178; font-size:12px; }
.role-form__engine-switcher { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.role-form__engine-switch { border:1px solid #d7e1ec; border-radius:10px; background:#f8fbff; padding:12px; display:flex; flex-direction:column; gap:4px; text-align:left; cursor:pointer; }
.role-form__engine-switch strong { font-size:13px; color:var(--app-text,#333); }
.role-form__engine-switch span { font-size:12px; color:var(--app-muted,#666); }
.role-form__engine-switch small { font-size:11px; color:var(--app-muted,#8a96a3); }
.role-form__engine-switch--active { border-color:var(--app-primary,#1677ff); background:#eaf3ff; box-shadow: inset 0 0 0 1px rgba(22,119,255,0.08); }
.role-form__field { display:flex; flex-direction:column; gap:4px; }
.role-form__field--grow { flex:0 0 auto; }
.role-form__field-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.role-form__field-label { font-size:12px; color:var(--app-muted,#666); }
.role-form__field span { font-size:12px; color:var(--app-muted,#666); }
.role-form__input,.role-form__select,.role-form__textarea {
  width:100%;
  padding:10px 12px;
  border:1px solid var(--role-form-control-border);
  border-radius:12px;
  font-size:13px;
  background:var(--role-form-control-bg);
  color:var(--app-text,#333);
  box-shadow: var(--role-form-control-shadow);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}
.role-form__textarea { resize:vertical; font-family:monospace; }
.role-form__input:hover,
.role-form__select:hover,
.role-form__textarea:hover {
  border-color: var(--role-form-control-border-hover);
  background: var(--role-form-control-bg-hover);
  box-shadow: var(--role-form-control-shadow-hover);
}
.role-form__input:focus,
.role-form__select:focus,
.role-form__textarea:focus {
  outline:none;
  border-color: var(--role-form-control-focus);
  box-shadow: var(--role-form-control-focus-ring);
  background: color-mix(in srgb, var(--role-form-control-bg-hover) 86%, #ffffff);
}
.role-form__select-control { width:100%; }
.role-form__field-help { font-size:11px; line-height:1.6; color:var(--app-muted,#7a8699); }
.role-form__ghost-btn { padding:4px 12px; border:1px solid var(--app-border,#d9d9d9); border-radius:6px; background:var(--app-bg,#fff); color:var(--app-muted,#666); cursor:pointer; }
.role-form__ai-inline { white-space:nowrap; }
.role-form__section-header,.role-form__gate-header { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.role-form__section-header h4 { margin:0; font-size:14px; }
.role-form__add-field { padding:4px 12px; border:1px dashed var(--app-border,#d9d9d9); border-radius:6px; background:none; color:var(--app-primary,#1677ff); display:inline-flex; align-items:center; gap:4px; }
.role-form__icon-btn { border:none; background:none; color:var(--app-muted,#999); padding:2px; }
.role-form__checkbox { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--app-muted,#666); }
.role-form__choice-group { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.role-form__choice-group--inline { width:min(220px,100%); }
.role-form__choice { position:relative; cursor:pointer; }
.role-form__choice input { position:absolute; opacity:0; pointer-events:none; }
.role-form__choice span {
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:40px;
  padding:0 12px;
  border:1px solid var(--role-form-control-border);
  border-radius:12px;
  background:var(--role-form-control-bg);
  box-shadow:var(--role-form-control-shadow);
  color:color-mix(in srgb, var(--app-text,#1f2937) 78%, #6f553d);
  font-size:12px;
  font-weight:600;
  transition:border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}
.role-form__choice:hover span {
  border-color:var(--role-form-control-border-hover);
  background:var(--role-form-control-bg-hover);
  box-shadow:var(--role-form-control-shadow-hover);
}
.role-form__choice input:checked + span {
  border-color:var(--role-form-control-focus);
  box-shadow:var(--role-form-control-focus-ring);
  background:color-mix(in srgb, var(--role-form-control-bg-hover) 86%, #ffffff);
  color:color-mix(in srgb, var(--app-accent,#c96442) 72%, #38404a);
}
.role-form__field-list,.role-form__tool-groups,.role-form__tool-bindings { display:flex; flex-direction:column; gap:12px; }
.role-form__field-card { border:1px solid var(--app-border,#e8e8e8); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px; }
.role-form__builder { display:grid; grid-template-columns: 260px minmax(0, 1fr); gap:12px; height:min(60vh, 460px); min-height:320px; }
.role-form__builder-list { display:flex; flex-direction:column; gap:8px; min-height:0; overflow-y:auto; padding-right:4px; }
.role-form__builder-item { width:100%; text-align:left; border:1px solid #d7e1ec; border-radius:10px; background:#f8fbff; padding:10px 12px; display:flex; flex-direction:column; gap:4px; cursor:pointer; }
.role-form__builder-item strong { font-size:13px; color:var(--app-text,#333); }
.role-form__builder-item span { font-size:12px; color:var(--app-muted,#666); }
.role-form__builder-item small { font-size:11px; color:var(--app-muted,#8a96a3); }
.role-form__builder-item--active { border-color:var(--app-primary,#1677ff); background:#eaf3ff; box-shadow: inset 0 0 0 1px rgba(22,119,255,0.08); }
.role-form__builder-detail { min-width:0; min-height:0; overflow-y:auto; padding-right:4px; }
.role-form__chip-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
.role-form__chip-btn {
  width:100%;
  min-height:56px;
  padding:12px 14px;
  border:1px solid var(--role-form-chip-border);
  border-radius:12px;
  background:var(--role-form-chip-bg);
  color:var(--app-text,#333);
  text-align:left;
  cursor:pointer;
  box-shadow:var(--role-form-chip-shadow);
  transition:border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease, background 0.16s ease;
}
.role-form__chip-btn strong { font-size:13px; font-weight:600; }
.role-form__chip-btn small {
  display:block;
  margin-top:5px;
  color:color-mix(in srgb, var(--app-muted,#666) 82%, #826850);
}
.role-form__chip-btn :deep(.anticon) { font-size:16px; }
.role-form__chip-btn:hover {
  border-color:var(--role-form-chip-border-hover);
  background:var(--role-form-chip-bg-hover);
  box-shadow:var(--role-form-chip-shadow-hover);
  transform:translateY(-1px);
}
.role-form__chip-btn:focus-visible {
  outline:none;
  border-color:var(--role-form-control-focus);
  box-shadow:inset 0 0 0 1px var(--role-form-control-focus), 0 0 0 4px color-mix(in srgb, var(--role-form-control-focus) 16%, transparent);
}
.role-form__chip-btn--add {
  display:flex;
  align-items:center;
  justify-content:center;
  gap:10px;
  border-style:dashed;
  color:var(--app-accent,#c96442);
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 92%, #fffaf3), color-mix(in srgb, var(--app-bg,#fff) 90%, #f8eee2));
}
.role-form__chip-btn--add strong { color:inherit; }
.role-form__empty-inline {
  margin-top:-2px;
  font-size:12px;
  line-height:1.7;
  color:var(--app-muted,#7a8699);
}
.role-form__field-grid,.role-form__check-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.role-form__field--full { grid-column:1 / -1; }
.role-form__check-card { padding:10px; display:flex; align-items:flex-start; gap:8px; font-size:12px; }
.role-form__check-card strong { display:block; margin-bottom:4px; }
.role-form__check-card p { margin:0; color:var(--app-muted,#999); }
.role-form__empty-state { border:1px dashed #d7e1ec; border-radius:10px; padding:18px; font-size:12px; line-height:1.7; color:var(--app-muted,#7a8699); background:#fbfdff; }
.role-form__modal-actions { display:flex; align-items:center; gap:10px; margin-top:16px; }
.role-form__modal-spacer { flex:1 1 auto; }
.role-form__danger-btn {
  padding:6px 14px;
  border:1px solid #efb7b7;
  border-radius:8px;
  background:#fff5f5;
  color:#cf3f3f;
  cursor:pointer;
}
.role-form__danger-btn:hover {
  border-color:#e98d8d;
  background:#ffeded;
}
@media (max-width: 767px) {
  .role-form__field-grid,
  .role-form__check-grid,
  .role-form__builder { grid-template-columns:1fr; height:auto; min-height:0; }
  .role-form__engine-switcher { grid-template-columns:1fr; }
  .role-form__builder-list,
  .role-form__builder-detail { overflow:visible; max-height:none; padding-right:0; }
  .role-form__section { padding-right:0; }
}
:deep(.role-form__select-control .ant-select-selector) { min-height:38px; border-radius:6px !important; }
:root[data-theme="dark"] .role-form__tabs,:root[data-theme="dark"] .role-form__card,:root[data-theme="dark"] .role-form__hint,:root[data-theme="dark"] .role-form__hint-card,:root[data-theme="dark"] .role-form__check-card,:root[data-theme="dark"] .role-form__field-card,:root[data-theme="dark"] .role-form__subtab,:root[data-theme="dark"] .role-form__builder-item,:root[data-theme="dark"] .role-form__empty-state { border-color:#303030; }
:root[data-theme="dark"] .role-form__hint,:root[data-theme="dark"] .role-form__hint-card { background:#1a2230; }
:root[data-theme="dark"] .role-form__summary-pill { background:#223047; color:#c7d3e1; }
:root[data-theme="dark"] .role-form__subtab { background:#111827; color:#c7d3e1; }
:root[data-theme="dark"] .role-form__engine-switch { background:#182231; border-color:#303030; }
:root[data-theme="dark"] .role-form__builder-item { background:#182231; }
:root[data-theme="dark"] .role-form__chip-btn { background:linear-gradient(180deg, #182231 0%, #152031 100%); border-color:#314055; color:#d6dbe4; }
:root[data-theme="dark"] .role-form__chip-btn--add { background:linear-gradient(180deg, #162335 0%, #13202f 100%); color:#8fbaf8; }
:root[data-theme="dark"] .role-form__builder-item span { color:#9fb0c2; }
:root[data-theme="dark"] .role-form__builder-item small { color:#7f93a8; }
:root[data-theme="dark"] .role-form__subtab--active,:root[data-theme="dark"] .role-form__builder-item--active,:root[data-theme="dark"] .role-form__engine-switch--active { background:#11243f; }
:root[data-theme="dark"] .role-form {
  --role-form-control-bg: color-mix(in srgb, var(--app-panel-bg,#30302e) 92%, #1e1a16);
  --role-form-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#30302e) 84%, #27221c);
  --role-form-control-border: color-mix(in srgb, var(--app-border,#303030) 95%, #544a40);
  --role-form-control-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 22%, #6a5a4b);
  --role-form-control-shadow: 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 1px rgba(0,0,0,0.24);
  --role-form-control-shadow-hover: 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 1px rgba(0,0,0,0.28);
  --role-form-control-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 18%, transparent);
  --role-form-chip-bg: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02));
  --role-form-chip-bg-hover: linear-gradient(180deg, rgba(217,119,87,0.18), rgba(255,255,255,0.03));
  --role-form-chip-border: color-mix(in srgb, var(--app-border,#303030) 92%, #5a4d42);
  --role-form-chip-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 36%, #73604f);
  --role-form-chip-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 12px 28px rgba(0,0,0,0.18);
  --role-form-chip-shadow-hover: inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 30px rgba(0,0,0,0.22);
}
:root[data-theme="dark"] .role-form__input,
:root[data-theme="dark"] .role-form__select,
:root[data-theme="dark"] .role-form__textarea { color:#ece7df; }
:root[data-theme="dark"] .role-form__choice span { color:#ece7df; }
:root[data-theme="dark"] .role-form__chip-btn:hover { border-color:#4f78ad; background:linear-gradient(180deg, #1a2940 0%, #17304f 100%); box-shadow:none; }
:root[data-theme="dark"] .role-form__danger-btn { background:#35191c; border-color:#6c3037; color:#ffb5b5; }

.role-form__field {
  gap: 8px;
}

.role-form__range-block {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--app-primary,#1677ff) 10%, #ccd6e2);
  border-radius: 10px;
  background: linear-gradient(180deg, #ffffff, #f7fbff);
}

.role-form__range-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.role-form__range-header strong {
  font-size: 13px;
  color: var(--app-text,#1f2937);
}

.role-form__range-hint,
.role-form__range-bound {
  font-size: 12px;
  color: color-mix(in srgb, var(--app-muted,#666) 80%, #94a3b8);
}

.role-form__range-slider {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.role-form__field-label,
.role-form__field span {
  font-weight: 600;
  color: color-mix(in srgb, var(--app-text,#1f2937) 82%, #4b5563);
}

.role-form__card,
.role-form__field-card,
.role-form__check-card {
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 92%, #f8f3e9), color-mix(in srgb, var(--app-bg,#fff) 96%, #fdfbf6));
}

.role-form__input,
.role-form__select,
.role-form__textarea {
  min-height: 40px;
  padding: 10px 12px;
  border-radius: 12px;
  border-color: var(--role-form-control-border);
  background: var(--role-form-control-bg);
  box-shadow: var(--role-form-control-shadow);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}

/* 系统提示词等长文本框走稳定最小高度，不参与 flex 撑满；textarea 自带 resize:vertical，需要更高用户可手动拖。
   放在 .role-form__textarea 共用规则之后，避免同等 specificity 下被 min-height:40px 覆盖 */
.role-form__textarea--fill {
  flex: 0 0 auto;
  min-height: 360px;
}

.role-form__textarea--delivery {
  min-height: min(44vh, 520px);
}

.role-form__input:hover,
.role-form__select:hover,
.role-form__textarea:hover {
  border-color: var(--role-form-control-border-hover);
  background: var(--role-form-control-bg-hover);
  box-shadow: var(--role-form-control-shadow-hover);
}

.role-form__input:focus,
.role-form__select:focus,
.role-form__textarea:focus {
  outline: none;
  border-color: var(--role-form-control-focus);
  box-shadow: var(--role-form-control-focus-ring);
  background: color-mix(in srgb, var(--role-form-control-bg-hover) 86%, #ffffff);
}

.role-form__input::placeholder,
.role-form__textarea::placeholder {
  color: color-mix(in srgb, var(--app-muted,#666) 76%, #9aa6b2);
}

:deep(.role-form__select-control .ant-select-selector) {
  min-height: 40px;
  border-radius: 12px !important;
  border-color: var(--role-form-control-border) !important;
  background: var(--role-form-control-bg) !important;
  box-shadow: var(--role-form-control-shadow) !important;
  padding-top: 3px;
  padding-bottom: 3px;
}

:deep(.role-form__select-control.ant-select-focused .ant-select-selector),
:deep(.role-form__select-control:hover .ant-select-selector) {
  border-color: var(--role-form-control-border-hover) !important;
  background: var(--role-form-control-bg-hover) !important;
}

:deep(.role-form__select-control.ant-select-focused .ant-select-selector) {
  border-color: var(--role-form-control-focus) !important;
  box-shadow: var(--role-form-control-focus-ring) !important;
}

:deep(.role-form-modal) {
  --role-form-modal-surface: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf6ee), color-mix(in srgb, var(--app-bg,#fff) 97%, #fffaf4));
  --role-form-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.76));
  --role-form-modal-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #ddceb8);
  --role-form-modal-header-border: color-mix(in srgb, var(--app-border,#d9d9d9) 68%, #eadfce);
  --role-form-modal-shadow: 0 28px 80px rgba(84,57,34,0.18);
  --role-form-modal-control-bg: color-mix(in srgb, var(--app-panel-bg,#fff) 82%, #f7f0e5);
  --role-form-modal-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#fff) 74%, #fbf6ee);
  --role-form-modal-control-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #d5c5ae);
  --role-form-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 24%, #d3bea2);
  --role-form-modal-control-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 10px 22px rgba(88,58,32,0.04);
  --role-form-modal-control-shadow-hover: 0 0 0 1px color-mix(in srgb, #d8cec0 74%, transparent), 0 14px 26px rgba(88,58,32,0.09);
  --role-form-modal-focus: #3898ec;
  --role-form-modal-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 16%, transparent);
}

:deep(.role-form-modal .ant-modal-content) {
  border:1px solid var(--role-form-modal-border);
  border-radius:20px;
  overflow:hidden;
  background:var(--role-form-modal-surface);
  box-shadow:var(--role-form-modal-shadow);
}

:deep(.role-form-modal .ant-modal-header) {
  margin-bottom:0;
  padding:18px 24px 14px;
  border-bottom:1px solid var(--role-form-modal-header-border);
  background:var(--role-form-modal-surface-soft);
}

:deep(.role-form-modal .ant-modal-title) {
  font-size:15px;
  font-weight:700;
  color:color-mix(in srgb, var(--app-text,#1f2937) 88%, #5c4630);
}

:deep(.role-form-modal .ant-modal-body) {
  padding:20px 24px 24px;
  background:transparent;
}

:deep(.role-form-modal .ant-modal-close) {
  inset-inline-end:14px;
  top:14px;
  width:34px;
  height:34px;
  border-radius:999px;
  color:color-mix(in srgb, var(--app-muted,#666) 82%, #826850);
  transition:background-color 0.16s ease, color 0.16s ease;
}

:deep(.role-form-modal .ant-modal-close:hover) {
  background:color-mix(in srgb, var(--app-panel-bg,#fff) 72%, #f5ebde);
  color:color-mix(in srgb, var(--app-text,#1f2937) 82%, #694c34);
}

:deep(.role-form-modal .role-form__field-grid) {
  gap:14px;
}

:deep(.role-form-modal .role-form__field) {
  gap:8px;
}

:deep(.role-form-modal .role-form__field span) {
  font-weight:600;
  color:color-mix(in srgb, var(--app-text,#1f2937) 84%, #594633);
}

:deep(.role-form-modal .role-form__input),
:deep(.role-form-modal .role-form__select),
:deep(.role-form-modal .role-form__textarea) {
  width:100%;
  min-height:42px;
  padding:10px 12px;
  border:1px solid var(--role-form-modal-control-border);
  border-radius:12px;
  background:var(--role-form-modal-control-bg);
  color:var(--app-text,#141413);
  box-shadow:var(--role-form-modal-control-shadow);
  transition:border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}

:deep(.role-form-modal .role-form__textarea) {
  resize:vertical;
  font-family:monospace;
}

:deep(.role-form-modal .role-form__textarea--delivery) {
  min-height:min(46vh, 560px);
}

:deep(.role-form-modal .role-form__input:hover),
:deep(.role-form-modal .role-form__select:hover),
:deep(.role-form-modal .role-form__textarea:hover) {
  border-color:var(--role-form-modal-control-border-hover);
  background:var(--role-form-modal-control-bg-hover);
  box-shadow:var(--role-form-modal-control-shadow-hover);
}

:deep(.role-form-modal .role-form__input:focus),
:deep(.role-form-modal .role-form__select:focus),
:deep(.role-form-modal .role-form__textarea:focus) {
  outline:none;
  border-color:var(--role-form-modal-focus);
  box-shadow:var(--role-form-modal-focus-ring);
  background:color-mix(in srgb, var(--role-form-modal-control-bg-hover) 84%, #ffffff);
}

:deep(.role-form-modal .role-form__input::placeholder),
:deep(.role-form-modal .role-form__textarea::placeholder) {
  color:color-mix(in srgb, var(--app-muted,#666) 74%, #9f8d79);
}

:deep(.role-form-modal .role-form__checkbox) {
  padding:10px 12px;
  border:1px solid var(--role-form-modal-control-border);
  border-radius:12px;
  background:var(--role-form-modal-control-bg);
  box-shadow:var(--role-form-modal-control-shadow);
}

:deep(.role-form-modal .role-form__checkbox input) {
  accent-color:var(--app-accent,#c96442);
}

:deep(.role-form-modal .role-form__ghost-btn) {
  border-radius:10px;
  border-color:color-mix(in srgb, var(--app-border,#d9d9d9) 74%, #d7c7b0);
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf7f0), color-mix(in srgb, var(--app-bg,#fff) 98%, #fffdf9));
}

:deep(.role-form-modal .role-form__ghost-btn:hover) {
  border-color:var(--role-form-modal-control-border-hover);
  background:linear-gradient(180deg, #fffefb, #f9efe4);
}

:deep(.role-form-modal .role-form__save-btn) {
  border-radius:10px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-accent,#c96442) 90%, #d97757), color-mix(in srgb, var(--app-accent,#c96442) 96%, #bb5737));
  box-shadow:0 12px 24px rgba(201,100,66,0.2);
}

:deep(.role-form-modal .role-form__save-btn:hover) {
  filter:brightness(1.03);
}

:deep(.role-form-modal .role-form__danger-btn) {
  border-radius:10px;
}

:root[data-theme="dark"] .role-form__field-label,
:root[data-theme="dark"] .role-form__field span {
  color:#d6dbe4;
}

:root[data-theme="dark"] .role-form__header-badge {
  background:rgba(148,163,184,0.16);
  color:#cbd5e1;
}

:root[data-theme="dark"] .role-form__card,
:root[data-theme="dark"] .role-form__field-card,
:root[data-theme="dark"] .role-form__check-card {
  background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
}

:root[data-theme="dark"] .role-form__input,
:root[data-theme="dark"] .role-form__select,
:root[data-theme="dark"] .role-form__textarea {
  border-color:#3b4c63;
  background: linear-gradient(180deg, #181d24, #13171d);
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.28), 0 0 0 1px rgba(59,76,99,0.14);
}

:root[data-theme="dark"] :deep(.role-form__select-control .ant-select-selector) {
  border-color:#3b4c63 !important;
  background: linear-gradient(180deg, #181d24, #13171d) !important;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.28), 0 0 0 1px rgba(59,76,99,0.14) !important;
}

:root[data-theme="dark"] :deep(.role-form-modal) {
  --role-form-modal-surface: linear-gradient(180deg, rgba(27,24,20,0.96), rgba(18,16,14,0.98));
  --role-form-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
  --role-form-modal-border: color-mix(in srgb, var(--app-border,#303030) 90%, #594c40);
  --role-form-modal-header-border: color-mix(in srgb, var(--app-border,#303030) 82%, #4b4036);
  --role-form-modal-shadow: 0 32px 90px rgba(0,0,0,0.45);
  --role-form-modal-control-bg: linear-gradient(180deg, rgba(31,27,23,0.98), rgba(24,21,18,0.98));
  --role-form-modal-control-bg-hover: linear-gradient(180deg, rgba(38,33,28,0.98), rgba(30,26,22,0.98));
  --role-form-modal-control-border: color-mix(in srgb, var(--app-border,#303030) 86%, #625346);
  --role-form-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 26%, #756152);
  --role-form-modal-control-shadow: inset 0 1px 1px rgba(255,255,255,0.04), 0 12px 24px rgba(0,0,0,0.22);
  --role-form-modal-control-shadow-hover: inset 0 1px 1px rgba(255,255,255,0.06), 0 14px 28px rgba(0,0,0,0.28);
}

:root[data-theme="dark"] :deep(.role-form-modal .ant-modal-title),
:root[data-theme="dark"] :deep(.role-form-modal .role-form__field span) {
  color:#ece7df;
}

:root[data-theme="dark"] :deep(.role-form-modal .ant-modal-close) {
  color:#c3b8aa;
}

:root[data-theme="dark"] :deep(.role-form-modal .ant-modal-close:hover) {
  background:rgba(255,255,255,0.06);
  color:#f3ede4;
}

:root[data-theme="dark"] :deep(.role-form-modal .role-form__input),
:root[data-theme="dark"] :deep(.role-form-modal .role-form__select),
:root[data-theme="dark"] :deep(.role-form-modal .role-form__textarea),
:root[data-theme="dark"] :deep(.role-form-modal .role-form__checkbox) {
  color:#ece7df;
}
</style>

<style>
.role-form-modal {
  --role-form-modal-surface: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf6ee), color-mix(in srgb, var(--app-bg,#fff) 97%, #fffaf4));
  --role-form-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.76));
  --role-form-modal-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #ddceb8);
  --role-form-modal-header-border: color-mix(in srgb, var(--app-border,#d9d9d9) 68%, #eadfce);
  --role-form-modal-shadow: 0 28px 80px rgba(84,57,34,0.18);
  --role-form-modal-control-bg: color-mix(in srgb, var(--app-panel-bg,#fff) 82%, #f7f0e5);
  --role-form-modal-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#fff) 74%, #fbf6ee);
  --role-form-modal-control-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #d5c5ae);
  --role-form-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 24%, #d3bea2);
  --role-form-modal-control-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 10px 22px rgba(88,58,32,0.04);
  --role-form-modal-control-shadow-hover: 0 0 0 1px color-mix(in srgb, #d8cec0 74%, transparent), 0 14px 26px rgba(88,58,32,0.09);
  --role-form-modal-focus: #3898ec;
  --role-form-modal-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 16%, transparent);
}

.role-form-modal .ant-modal-content {
  border:1px solid var(--role-form-modal-border);
  border-radius:20px;
  overflow:hidden;
  background:var(--role-form-modal-surface);
  box-shadow:var(--role-form-modal-shadow);
}

.role-form-modal .ant-modal-header {
  margin-bottom:0;
  padding:18px 24px 14px;
  border-bottom:1px solid var(--role-form-modal-header-border);
  background:var(--role-form-modal-surface-soft);
}

.role-form-modal .ant-modal-title {
  font-size:15px;
  font-weight:700;
  color:color-mix(in srgb, var(--app-text,#1f2937) 88%, #5c4630);
}

.role-form-modal .ant-modal-body {
  padding:20px 24px 24px;
  background:transparent;
}

.role-form-modal .ant-modal-close {
  inset-inline-end:14px;
  top:14px;
  width:34px;
  height:34px;
  border-radius:999px;
  color:color-mix(in srgb, var(--app-muted,#666) 82%, #826850);
  transition:background-color 0.16s ease, color 0.16s ease;
}

.role-form-modal .ant-modal-close:hover {
  background:color-mix(in srgb, var(--app-panel-bg,#fff) 72%, #f5ebde);
  color:color-mix(in srgb, var(--app-text,#1f2937) 82%, #694c34);
}

.role-form-modal .role-form__field-grid {
  gap:14px;
}

.role-form-modal .role-form__field {
  gap:8px;
}

.role-form-modal .role-form__field span {
  font-weight:600;
  color:color-mix(in srgb, var(--app-text,#1f2937) 84%, #594633);
}

.role-form-modal .role-form__input,
.role-form-modal .role-form__select,
.role-form-modal .role-form__textarea {
  width:100%;
  min-height:42px;
  padding:10px 12px;
  border:1px solid var(--role-form-modal-control-border);
  border-radius:12px;
  background:var(--role-form-modal-control-bg);
  color:var(--app-text,#141413);
  box-shadow:var(--role-form-modal-control-shadow);
  transition:border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}

.role-form-modal .role-form__textarea {
  resize:vertical;
  font-family:monospace;
}

.role-form-modal .role-form__textarea--delivery {
  min-height:min(46vh, 560px);
}

.role-form-modal .role-form__input:hover,
.role-form-modal .role-form__select:hover,
.role-form-modal .role-form__textarea:hover {
  border-color:var(--role-form-modal-control-border-hover);
  background:var(--role-form-modal-control-bg-hover);
  box-shadow:var(--role-form-modal-control-shadow-hover);
}

.role-form-modal .role-form__input:focus,
.role-form-modal .role-form__select:focus,
.role-form-modal .role-form__textarea:focus {
  outline:none;
  border-color:var(--role-form-modal-focus);
  box-shadow:var(--role-form-modal-focus-ring);
  background:color-mix(in srgb, var(--role-form-modal-control-bg-hover) 84%, #ffffff);
}

.role-form-modal .role-form__input::placeholder,
.role-form-modal .role-form__textarea::placeholder {
  color:color-mix(in srgb, var(--app-muted,#666) 74%, #9f8d79);
}

.role-form-modal .role-form__checkbox {
  padding:10px 12px;
  border:1px solid var(--role-form-modal-control-border);
  border-radius:12px;
  background:var(--role-form-modal-control-bg);
  box-shadow:var(--role-form-modal-control-shadow);
}

.role-form-modal .role-form__checkbox input {
  accent-color:var(--app-accent,#c96442);
}

.role-form-modal .role-form__choice-group {
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:8px;
}

.role-form-modal .role-form__choice-group--inline {
  width:min(220px,100%);
}

.role-form-modal .role-form__choice {
  position:relative;
  cursor:pointer;
}

.role-form-modal .role-form__choice input {
  position:absolute;
  opacity:0;
  pointer-events:none;
}

.role-form-modal .role-form__choice span {
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:40px;
  padding:0 12px;
  border:1px solid var(--role-form-modal-control-border);
  border-radius:12px;
  background:var(--role-form-modal-control-bg);
  box-shadow:var(--role-form-modal-control-shadow);
  color:color-mix(in srgb, var(--app-text,#1f2937) 78%, #6f553d);
  font-size:12px;
  font-weight:600;
  transition:border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}

.role-form-modal .role-form__choice:hover span {
  border-color:var(--role-form-modal-control-border-hover);
  background:var(--role-form-modal-control-bg-hover);
  box-shadow:var(--role-form-modal-control-shadow-hover);
}

.role-form-modal .role-form__choice input:checked + span {
  border-color:#3898ec;
  box-shadow:var(--role-form-modal-focus-ring);
  background:color-mix(in srgb, var(--role-form-modal-control-bg-hover) 84%, #ffffff);
  color:color-mix(in srgb, var(--app-accent,#c96442) 72%, #38404a);
}


.role-form-modal .role-form__ghost-btn {
  border-radius:10px;
  border-color:color-mix(in srgb, var(--app-border,#d9d9d9) 74%, #d7c7b0);
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf7f0), color-mix(in srgb, var(--app-bg,#fff) 98%, #fffdf9));
}

.role-form-modal .role-form__ghost-btn:hover {
  border-color:var(--role-form-modal-control-border-hover);
  background:linear-gradient(180deg, #fffefb, #f9efe4);
}

.role-form-modal .role-form__save-btn {
  border-radius:10px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-accent,#c96442) 90%, #d97757), color-mix(in srgb, var(--app-accent,#c96442) 96%, #bb5737));
  box-shadow:0 12px 24px rgba(201,100,66,0.2);
}

.role-form-modal .role-form__save-btn:hover {
  filter:brightness(1.03);
}

.role-form-modal .role-form__danger-btn {
  border-radius:10px;
}

:root[data-theme="dark"] .role-form-modal {
  --role-form-modal-surface: linear-gradient(180deg, rgba(27,24,20,0.96), rgba(18,16,14,0.98));
  --role-form-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
  --role-form-modal-border: color-mix(in srgb, var(--app-border,#303030) 90%, #594c40);
  --role-form-modal-header-border: color-mix(in srgb, var(--app-border,#303030) 82%, #4b4036);
  --role-form-modal-shadow: 0 32px 90px rgba(0,0,0,0.45);
  --role-form-modal-control-bg: linear-gradient(180deg, rgba(31,27,23,0.98), rgba(24,21,18,0.98));
  --role-form-modal-control-bg-hover: linear-gradient(180deg, rgba(38,33,28,0.98), rgba(30,26,22,0.98));
  --role-form-modal-control-border: color-mix(in srgb, var(--app-border,#303030) 86%, #625346);
  --role-form-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 26%, #756152);
  --role-form-modal-control-shadow: inset 0 1px 1px rgba(255,255,255,0.04), 0 12px 24px rgba(0,0,0,0.22);
  --role-form-modal-control-shadow-hover: inset 0 1px 1px rgba(255,255,255,0.06), 0 14px 28px rgba(0,0,0,0.28);
}

:root[data-theme="dark"] .role-form-modal .ant-modal-title,
:root[data-theme="dark"] .role-form-modal .role-form__field span {
  color:#ece7df;
}

:root[data-theme="dark"] .role-form-modal .ant-modal-close {
  color:#c3b8aa;
}

:root[data-theme="dark"] .role-form-modal .ant-modal-close:hover {
  background:rgba(255,255,255,0.06);
  color:#f3ede4;
}

:root[data-theme="dark"] .role-form-modal .role-form__input,
:root[data-theme="dark"] .role-form-modal .role-form__select,
:root[data-theme="dark"] .role-form-modal .role-form__textarea,
:root[data-theme="dark"] .role-form-modal .role-form__checkbox {
  color:#ece7df;
}

:root[data-theme="dark"] .role-form-modal .role-form__choice span {
  color:#ece7df;
}
</style>

