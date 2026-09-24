<script setup>
// 判定标准：抽样不少于 10 条比对「EBMS 展示值」与「专业中心输出值」，一致率须 100%。
// 有效样本不足时明确「判定不成立」，不得静默通过。
import { computed } from 'vue';

const props = defineProps({
  report: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
});

const compared = computed(() => (props.report?.samples ?? []).filter((s) => !s.skipped));
const skipped = computed(() => (props.report?.samples ?? []).filter((s) => s.skipped));
</script>

<template>
  <section class="consistency" aria-label="抽样比对">
    <h3 class="section-title">抽样比对：EBMS 展示值与专业中心输出值</h3>

    <p v-if="loading" class="hint">比对中…</p>
    <p v-else-if="error" class="error" role="alert">比对失败：{{ error }}</p>

    <template v-else-if="report">
      <p
        class="consistency__summary"
        :class="report.passed ? 'is-pass' : 'is-fail'"
        data-testid="consistency-summary"
      >
        <span class="badge" :class="report.passed ? 'badge--stable' : 'badge--critical'" data-testid="consistency-verdict">
          {{ report.passed ? '判定通过' : '判定不成立' }}
        </span>
        <span data-testid="consistency-counts">
          有效比对 {{ report.compared_count }} 条 / 要求不少于 {{ report.minimum_sample_size }} 条 ·
          一致 {{ report.consistent_count }} 条 · 不一致 {{ report.inconsistent_count }} 条 ·
          一致率 {{ report.consistent_rate === null ? '—' : `${(report.consistent_rate * 100).toFixed(0)}%` }}
        </span>
      </p>
      <p class="consistency__verdict" data-testid="consistency-verdict-text">{{ report.verdict }}</p>

      <p v-if="!report.meets_minimum" class="warn" data-testid="consistency-insufficient">
        有效比对样本少于判定要求的 {{ report.minimum_sample_size }} 条，一致率不足以支撑判定结论。
      </p>
      <p v-else-if="!report.all_differences_explained" class="warn" data-testid="consistency-unexplained">
        存在 {{ report.unexplained_difference_count }} 条未给出明确口径说明的差异，判定不通过。
      </p>

      <table class="consistency__table" data-testid="consistency-samples">
        <thead>
          <tr>
            <th>专业中心</th>
            <th>指标</th>
            <th>字段</th>
            <th>中心输出值</th>
            <th>EBMS 展示值</th>
            <th>口径说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(sample, index) in compared" :key="`${sample.center}-${sample.metric_code}-${sample.field}-${index}`" data-testid="consistency-sample">
            <td>{{ sample.center_label }}</td>
            <td>{{ sample.metric_name }}</td>
            <td>{{ sample.field_label }}</td>
            <td data-testid="sample-center-value">{{ sample.center_value }}</td>
            <td data-testid="sample-ebms-value">{{ sample.ebms_value }}</td>
            <td>{{ sample.note ?? '一致' }}</td>
          </tr>
          <tr v-for="(sample, index) in skipped" :key="`skip-${sample.center}-${index}`" class="is-skipped" data-testid="consistency-skipped">
            <td>{{ sample.center_label }}</td>
            <td colspan="3">—</td>
            <td>—</td>
            <td>{{ sample.note }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
