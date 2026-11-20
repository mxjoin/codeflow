<script setup lang="ts">
import { computed } from "vue";
import type { KnowledgeAssetsSnapshot, KnowledgeGenerationRunView, KnowledgePendingChangeNode } from "@codeflowai/shared";
import { knowledgeOverview } from "../knowledgeOverviewModel";

const props = defineProps<{
  snapshot: KnowledgeAssetsSnapshot | null;
  runs: KnowledgeGenerationRunView[];
  changes: KnowledgePendingChangeNode[];
  loading: boolean;
  stateError: string | null;
  runError: string | null;
  canWrite: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ improve: []; discuss: []; updates: []; select: [nodeId: string]; retry: [] }>();
const overview = computed(() => knowledgeOverview(props.snapshot, props.runs, props.changes));
const categories = computed(() => props.snapshot?.tree.nodes.filter(node => node.parentId === null && node.category && !node.archived) ?? []);
const labels = { state_error: "读取失败", generation_failed: "生成失败", review_failed: "复检失败", review_issues: "复检问题", review_stale: "依据待核对", review_pending: "待完成复检", gap: "记录缺口" };
</script>

<template>
  <section class="knowledge-overview" data-testid="knowledge-overview" aria-label="项目规格概览">
    <header class="overview-intro"><div><span class="eyebrow">项目规格</span><h2>{{ overview.initialized ? '要求有归处，研发有依据' : '建立项目的研发依据' }}</h2><p>维护已确认要求，结合架构与产品资料，指导设计、编码和验证。</p></div><a-tag v-if="snapshot && !canWrite">只读</a-tag></header>
    <a-alert v-if="stateError || runError" type="error" show-icon :message="stateError || runError"><template #description><p>读取失败的部分尚不能判断，请重试后再核对。</p><a-button size="small" @click="emit('retry')">重新读取状态</a-button></template></a-alert>
    <div v-if="loading" class="overview-loading" role="status"><a-spin /><p>正在读取项目规格…</p></div>
    <template v-else>
      <div class="overview-stats" aria-label="规格状态统计">
        <article><strong>{{ overview.adoptedCount }}</strong><span>现行文档</span><small>{{ overview.specificationCount }} 份规格已确认</small></article>
        <article><strong>{{ overview.pendingCount }}</strong><span>文档待确认更新</span><small>候选不替换现行正文</small></article>
        <article><strong>{{ overview.generatingCount }}</strong><span>文档处理中</span><small>生成与复检的实际状态</small></article>
        <article><strong>{{ overview.issues.length }}</strong><span>记录待核对项</span><small>仅代表已检查的范围</small></article>
      </div>
      <div class="overview-actions">
        <a-button :disabled="!canWrite || busy" @click="emit('improve')"><strong>从项目完善</strong><span>结合已有代码和资料，整理必要更新。</span></a-button>
        <a-button :disabled="!canWrite || busy" @click="emit('discuss')"><strong>通过对话补充</strong><span>直接说明要求，确认内容和适用范围。</span></a-button>
        <a-button @click="emit('updates')"><strong>核对待确认更新</strong><span>查看差异和依据，决定是否生效。</span></a-button>
      </div>
      <section class="overview-section"><div class="overview-section-head"><h3>当前需要处理</h3><span>具体问题，不以字数或篇数评分</span></div>
        <div v-if="overview.issues.length" class="overview-issues">
          <article v-for="issue in overview.issues" :key="issue.id"><div><a-tag :color="['gap', 'review_stale', 'review_pending'].includes(issue.kind) ? 'orange' : 'red'">{{ labels[issue.kind] }}</a-tag><strong>{{ issue.title }}</strong><p>{{ issue.detail }}</p></div><a-button size="small" @click="issue.nodeId ? emit('select', issue.nodeId) : emit('updates')">查看详情</a-button></article>
        </div>
        <a-empty v-else :image="undefined" :description="overview.initialized ? '已读取的记录中暂无待核对项；这不代表需求完整或代码已满足规格。' : '尚未建立规格，可以从项目整理或通过对话补充要求。'" />
      </section>
      <section v-if="categories.length" class="overview-section"><div class="overview-section-head"><h3>现行规格与支撑资料</h3><span>按职责阅读，按任务使用</span></div><div class="overview-categories"><a-button v-for="category in categories" :key="category.id" @click="emit('select', category.id)"><strong>{{ category.title }}</strong><span>{{ category.summary }}</span></a-button></div></section>
      <p class="overview-boundary">“现行”表示已确认采用；“本轮已提供”需以研发会话的实际加载记录为准；是否满足要求需看本次验证证据。规格文档复检不等于代码验收。</p>
    </template>
  </section>
</template>

<style scoped>
.knowledge-overview { flex: 1; min-height: 0; overflow: auto; width: min(1100px, 100%); margin: 0 auto; padding: 28px; box-sizing: border-box; color: var(--app-text); }
.overview-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.eyebrow { color: var(--app-accent); font-size: 11px; letter-spacing: 1px; }
h2 { margin: 8px 0; font-size: 24px; line-height: 1.45; } h3 { margin: 0; font-size: 14px; }
p { margin: 8px 0 0; line-height: 1.7; } .overview-intro p, .overview-section-head span { color: var(--app-muted); font-size: 12px; }
.overview-loading { padding: 50px 16px; text-align: center; color: var(--app-muted); }
.overview-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
.overview-stats article { display: flex; flex-direction: column; padding: 16px; border: 1px solid var(--app-border); border-radius: 10px; background: var(--app-panel-bg); }
.overview-stats strong { font-size: 27px; line-height: 1.3; font-weight: 500; } .overview-stats span { font-size: 12px; margin-top: 8px; }.overview-stats small { color: var(--app-muted); font-size: 10px; margin-top: 4px; }
.overview-actions, .overview-categories { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.overview-actions .ant-btn, .overview-categories .ant-btn { display: flex; flex-direction: column; align-items: flex-start; text-align: left; height: auto; min-height: 86px; padding: 16px; white-space: normal; gap: 8px; }
.overview-actions strong, .overview-categories strong { font-size: 13px; }.overview-actions span, .overview-categories span { font-size: 11px; color: var(--app-muted); line-height: 1.6; }
.overview-section { margin-top: 28px; }.overview-section-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.overview-issues { border: 1px solid var(--app-border); border-radius: 10px; overflow: hidden; background: var(--app-panel-bg); }
.overview-issues article { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 18px; border-bottom: 1px solid var(--app-divider); }.overview-issues article:last-child { border: 0; }
.overview-issues strong { font-size: 12px; }.overview-issues p { font-size: 12px; color: var(--app-muted); overflow-wrap: anywhere; }.overview-issues .ant-btn { flex-shrink: 0; }
.overview-boundary { font-size: 11px; color: var(--app-muted); margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--app-divider); }
@media (max-width: 900px) { .knowledge-overview { padding: 22px 18px; }.overview-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }.overview-actions, .overview-categories { grid-template-columns: 1fr; }.overview-actions .ant-btn { min-height: 66px; }.overview-issues article { flex-wrap: wrap; } }
</style>
