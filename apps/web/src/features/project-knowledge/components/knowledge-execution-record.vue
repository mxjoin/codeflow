<script setup lang="ts">
import { computed } from "vue";
import type { ConversationTool } from "@codeflowai/shared";
import { parseKnowledgeExecutionRecord } from "../knowledgeExecutionRecord";

const props = defineProps<{ item: ConversationTool }>();
/** 同一工具记录投影为用户可读状态；不以工具完成推导验收通过。 */
const record = computed(() => parseKnowledgeExecutionRecord(props.item.toolType, props.item.output));
</script>

<template>
  <section class="knowledge-execution-record" data-testid="knowledge-execution-record">
    <a-alert v-if="record?.kind === 'error'" type="error" :message="record.message" show-icon />
    <template v-else-if="record?.kind === 'provided'">
      <p class="boundary">本轮已向引擎提供以下正式规格；局部要求按各自范围适用，是否满足仍需验证。</p>
      <p v-if="record.paths.length" class="scope">本次核对范围：{{ record.paths.join('、') }}</p>
      <div v-for="rule in record.rules" :key="rule.nodeId" class="record-row">
        <strong>{{ rule.title }}</strong><span>适用 {{ rule.scope }}</span>
        <details><summary>版本与来源</summary><p>{{ rule.path }}</p><p>版本：{{ rule.revisionId || '实时引用原文' }}</p><p>正文指纹：{{ rule.contentHash }}</p></details>
      </div>
      <p v-if="!record.rules.length" class="boundary">本轮尚未提供规格正文。局部要求需要按设计或修改范围读取。</p>
      <details v-if="record.pendingScoped.length"><summary>尚需按范围读取的局部规格 · {{ record.pendingScoped.length }} 份</summary><p v-for="scope in record.pendingScoped" :key="scope.title">{{ scope.title }} · {{ scope.scope }}</p></details>
    </template>
    <template v-else-if="record?.kind === 'evidence'">
      <a-alert v-if="record.changed" type="warning" message="规格依据已变化，相关结果需要重新核对。历史执行记录仍保留。" show-icon />
      <p class="boundary">以下状态来自本轮真实执行记录。执行成功仍需核对断言覆盖，不能据此自动判定验收通过。</p>
      <p class="boundary">代码指纹仅在记录时核对，不证明命令执行时的文件完全相同。外部修改与未跟踪文件仍需核对。</p>
      <article v-for="(check, index) in record.checks" :key="index" class="record-row">
        <div class="check-heading"><strong>{{ check.requirement }}</strong><a-tag :color="check.color">{{ check.label }}</a-tag></div>
        <p>验证方式：{{ check.method }}</p>
        <details v-if="check.commands.length"><summary>执行依据 · {{ check.commands.length }} 项</summary><p v-for="command in check.commands" :key="command.itemId"><code>{{ command.command || '命令输入未提供' }}</code><br>事件 {{ command.itemId }} · 退出码 {{ command.exitCode ?? '引擎未提供' }}</p></details>
        <p v-else class="boundary">尚未关联本轮命令执行，人工审查也仍待完成。</p>
      </article>
      <p v-if="!record.checks.length" class="boundary">本次尚未关联关键验收项。</p>
    </template>
  </section>
</template>

<style scoped>
.knowledge-execution-record { font-size: 12px; overflow-wrap: anywhere; }
.boundary, .scope { color: var(--app-muted); margin: 8px 0 12px; }
.record-row { padding: 12px 0; border-top: 1px solid var(--app-divider); }
.record-row > strong { display: inline-block; margin-right: 12px; }
.record-row > span, details { color: var(--app-muted); }
.record-row p { margin: 6px 0; }
.check-heading { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
summary { cursor: pointer; margin-top: 6px; }
code { white-space: pre-wrap; }
</style>
