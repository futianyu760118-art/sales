<script setup>
// F13 / PAND-91：跨域经营判断视图。
//   场景 1 → 展示跨域判断结论，并列出其引用的各专业中心结论；
//   场景 2 → 展示值与专业中心输出值一致（EBMS 不重算中心内部指标）；
//   边界   → 某域数据缺失时标注「该域数据缺失」，其余域仍可判断。
// PAND-92：引用专业中心结论处标注来源中心与结论时间 / 版本；来源不可用时显示「来源不可用」。
import { computed, ref, watch } from 'vue';
import { api } from '../api/client.js';
import DomainConclusionCard from '../components/DomainConclusionCard.vue';
import ConsistencyPanel from '../components/ConsistencyPanel.vue';
import SourceLabelBadge from '../components/SourceLabelBadge.vue';

const props = defineProps({
  periodType: { type: String, default: 'month' },
  periodValue: { type: String, required: true },
});

const judgment = ref(null);
const references = ref(null);
const sourceLabels = ref(null);
const consistency = ref(null);
const periods = ref([]);

const loading = ref(false);
const error = ref('');
const consistencyError = ref('');
const sourceLabelsError = ref('');
const ingesting = ref(false);
const ingestNote = ref('');

const current = ref({ type: props.periodType, value: props.periodValue });

const periodOptions = computed(() => {
  const options = periods.value.map((p) => ({ type: p.period_type, value: p.period_value, label: `${p.period_value}（${p.period_type}）` }));
  const exists = options.some((o) => o.type === current.value.type && o.value === current.value.value);
  if (!exists && current.value.value) {
    options.unshift({ type: current.value.type, value: current.value.value, label: `${current.value.value}（${current.value.type}）` });
  }
  return options;
});

const missingDetails = computed(() => judgment.value?.missing_domain_details ?? []);

// 每个引用位置的来源标注（含来源不可用的位置），供缺失域与引用明细逐位呈现
const citationByCenter = computed(() => {
  const map = {};
  for (const citation of judgment.value?.source_citations ?? []) map[citation.center] = citation;
  return map;
});

// PAND-92：判断结果已带每个引用位置的来源标注；此处另取核验报告（判定标准入口）。
async function loadSourceLabels(judgmentId) {
  sourceLabelsError.value = '';
  sourceLabels.value = null;
  if (!judgmentId) return;
  try {
    sourceLabels.value = await api.getJudgmentSourceLabels(judgmentId);
  } catch (err) {
    sourceLabelsError.value = err.message;
  }
}

async function load() {
  loading.value = true;
  error.value = '';
  consistencyError.value = '';
  consistency.value = null;
  try {
    const payload = await api.getJudgment({ periodType: current.value.type, periodValue: current.value.value });
    judgment.value = payload;
    // 引用明细：逐条可追溯（跨域结论 → 专业中心结论快照）
    references.value = payload?.judgment_id
      ? await api.getJudgmentReferences(payload.judgment_id)
      : null;
    await loadSourceLabels(payload?.judgment_id);
  } catch (err) {
    error.value = err.message;
    judgment.value = null;
    references.value = null;
    sourceLabels.value = null;
  } finally {
    loading.value = false;
  }
  try {
    consistency.value = await api.getConsistency({ periodType: current.value.type, periodValue: current.value.value });
  } catch (err) {
    consistencyError.value = err.message;
  }
}

async function loadPeriods() {
  try {
    const res = await api.getJudgmentPeriods();
    periods.value = res.periods ?? [];
  } catch {
    periods.value = [];
  }
}

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const payload = await api.getJudgment({
      periodType: current.value.type,
      periodValue: current.value.value,
      refresh: true,
    });
    judgment.value = payload;
    references.value = payload?.judgment_id ? await api.getJudgmentReferences(payload.judgment_id) : null;
    await loadSourceLabels(payload?.judgment_id);
  } catch (err) {
    error.value = err.message;
    judgment.value = null;
  } finally {
    loading.value = false;
  }
}

async function ingest() {
  ingesting.value = true;
  ingestNote.value = '';
  error.value = '';
  try {
    const report = await api.ingestConclusions({
      periodType: current.value.type,
      periodValue: current.value.value,
    });
    ingestNote.value = `已接入 ${report.ingested_count} 个域${
      report.missing_count ? `，${report.missing_count} 个域数据缺失` : ''
    }，跨域判断已按最新快照刷新。`;
    await loadPeriods();
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    ingesting.value = false;
  }
}

function selectPeriod(event) {
  const [type, value] = event.target.value.split('|');
  current.value = { type, value };
}

watch(() => current.value, load, { deep: true, immediate: true });
loadPeriods();
</script>

<template>
  <section class="judgment-view">
    <header class="judgment-view__bar">
      <label class="field">
        <span>判断周期</span>
        <select data-testid="period-select" :value="`${current.type}|${current.value}`" @change="selectPeriod">
          <option v-for="option in periodOptions" :key="`${option.type}|${option.value}`" :value="`${option.type}|${option.value}`">
            {{ option.label }}
          </option>
        </select>
      </label>
      <button type="button" class="btn" :disabled="loading" data-testid="refresh-judgment" @click="refresh">按最新快照重算判断</button>
      <button type="button" class="btn btn--primary" :disabled="ingesting" data-testid="ingest-now" @click="ingest">
        {{ ingesting ? '拉取中…' : '拉取各中心结论' }}
      </button>
    </header>

    <p v-if="ingestNote" class="hint" data-testid="ingest-note">{{ ingestNote }}</p>
    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="error" role="alert" data-testid="judgment-error">加载失败：{{ error }}</p>

    <template v-else-if="judgment">
      <section class="judgment-head">
        <div class="judgment-head__top">
          <span class="badge" :class="`badge--${judgment.level}`" data-testid="judgment-level">
            {{ judgment.level_label }}
          </span>
          <span class="judgment-head__period">{{ judgment.period.value }}（{{ judgment.period.type }}）</span>
          <span class="judgment-head__rule">规则版本 {{ judgment.rule_version }}</span>
        </div>
        <p class="judgment-head__conclusion" data-testid="judgment-conclusion">{{ judgment.conclusion }}</p>
        <!-- 场景 2：口径声明——EBMS 只汇聚中心上报值，不重算中心内部指标 -->
        <p class="judgment-head__scope" data-testid="computation-scope">
          判断口径：{{ judgment.computation_scope.note }}（basis={{ judgment.computation_scope.basis }}，recomputed={{
            String(judgment.computation_scope.recomputed)
          }}）
        </p>
      </section>

      <!-- 前置条件：不足 2 个域产出结论时不输出判断 -->
      <p v-if="!judgment.can_judge" class="warn" data-testid="insufficient-notice">
        参与判断的域不足 {{ judgment.min_present_domains }} 个，本期暂不输出跨域判断。
      </p>

      <!-- 边界：缺失域逐条标注「该域数据缺失」 -->
      <section v-if="missingDetails.length" class="missing-summary" data-testid="missing-summary">
        <h3 class="section-title">数据缺失域（{{ missingDetails.length }}）</h3>
        <ul>
          <li v-for="detail in missingDetails" :key="detail.center" data-testid="missing-summary-item">
            <strong>{{ detail.center_label }}</strong> — {{ detail.label }}（{{ detail.reason_label }}）；该域不参与本次判断，其余域判断正常输出。
            <!-- PAND-92 边界：来源不可用时，引用位置显示「来源不可用」 -->
            <SourceLabelBadge
              v-if="citationByCenter[detail.center]"
              :source-label="citationByCenter[detail.center].source_label"
            />
          </li>
        </ul>
      </section>

      <section>
        <h3 class="section-title">各专业中心结论（{{ judgment.present_domains.length }} / 4 域参与判断）</h3>
        <div class="domain-grid" data-testid="domain-list">
          <DomainConclusionCard
            v-for="domain in judgment.domains"
            :key="domain.center"
            :domain="domain"
            :source-label="citationByCenter[domain.center]?.source_label ?? null"
          />
        </div>
      </section>

      <section v-if="references" class="references">
        <h3 class="section-title">
          跨域结论引用的专业中心结论（{{ references.reference_count }}）
        </h3>
        <p class="hint" data-testid="traceability-note">{{ references.traceability.note }}</p>
        <table class="reference-table" data-testid="reference-list">
          <thead>
            <tr>
              <th>专业中心</th>
              <!-- PAND-92 场景 1：引用处标注来源中心与结论时间 / 版本 -->
              <th>来源标注</th>
              <th>结论版本</th>
              <th>结论时间</th>
              <th>数据截止</th>
              <th>引用指标</th>
              <th>引用快照 ID</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ref in references.references" :key="ref.center" data-testid="reference-row" :data-center="ref.center">
              <td>{{ ref.center_label }}</td>
              <td>
                <SourceLabelBadge
                  v-if="ref.source_label"
                  :source-label="ref.source_label"
                />
              </td>
              <td>{{ ref.version ?? '—' }}</td>
              <td>{{ ref.as_of ?? '—' }}</td>
              <td>{{ ref.data_cutoff ?? '—' }}</td>
              <td data-testid="reference-metrics">
                <span v-for="metric in ref.metrics_cited" :key="metric.code" class="reference-table__metric">
                  {{ metric.name }} {{ metric.actual }}{{ metric.unit ? metric.unit : '' }}（{{ metric.deviation_pct }}%）
                </span>
              </td>
              <td><code data-testid="reference-conclusion-id">{{ ref.conclusion_id ?? '—' }}</code></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- PAND-92 判定标准：每条引用均有非空的来源标注 -->
      <section v-if="sourceLabels" class="source-labels" data-testid="source-label-panel">
        <h3 class="section-title">引用来源标注核验（{{ sourceLabels.total }} 条引用位置）</h3>
        <p class="source-labels__counts" data-testid="source-label-counts">
          非空标注 {{ sourceLabels.labeled_count }} 条 · 缺失 {{ sourceLabels.unlabeled_count }} 条 · 可用来源
          {{ sourceLabels.available_count }} 条 · 来源不可用 {{ sourceLabels.unavailable_count }} 条
        </p>
        <p
          class="source-labels__verdict"
          :class="{ 'is-fail': !sourceLabels.passed }"
          data-testid="source-label-verdict"
        >
          {{ sourceLabels.passed ? '判定通过' : '判定不通过' }}
        </p>
        <p class="hint" data-testid="source-label-verdict-text">{{ sourceLabels.verdict }}</p>
        <ul class="source-labels__list" data-testid="source-label-list">
          <li v-for="citation in sourceLabels.citations" :key="citation.center" data-testid="source-label-item">
            <SourceLabelBadge :source-label="citation.source_label" />
          </li>
        </ul>
        <!-- 缺失域仍受 PAND-91 口径约束，不因此处核验而放宽 -->
        <p v-if="sourceLabels.unavailable_count" class="hint" data-testid="source-label-unavailable-note">
          来源不可用的引用位置以「来源不可用」标注，不回落到专业原始表查询。
        </p>
      </section>
      <p v-else-if="sourceLabelsError" class="error" role="alert" data-testid="source-label-error">
        来源标注核验加载失败：{{ sourceLabelsError }}
      </p>

      <ConsistencyPanel :report="consistency" :loading="loading" :error="consistencyError" />
    </template>

    <p v-else class="hint">请选择周期以查看跨域经营判断。</p>
  </section>
</template>
