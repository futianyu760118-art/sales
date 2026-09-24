<script setup>
// 场景 1 + 场景 2：单个专业中心结论卡片。
// 展示值全部取自中心上报结论快照（payload 原样），EBMS 不重算、不反推。
import MissingDomainNotice from './MissingDomainNotice.vue';

defineProps({
  domain: { type: Object, required: true },
});

function fmt(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}
</script>

<template>
  <article class="domain-card" :class="{ 'domain-card--missing': domain.missing }" :data-center="domain.center" data-testid="domain-card">
    <header class="domain-card__head">
      <h3 class="domain-card__title">{{ domain.center_label }}</h3>
      <span v-if="!domain.missing" class="domain-card__count">{{ domain.metrics_ok_count }} 项指标</span>
    </header>

    <MissingDomainNotice
      v-if="domain.missing"
      :center-label="domain.center_label"
      :label="domain.missing_label"
      :reason-label="domain.missing_reason_label"
    />

    <template v-else>
      <dl class="domain-card__meta">
        <div><dt>结论版本</dt><dd data-testid="domain-version">{{ fmt(domain.version) }}</dd></div>
        <div><dt>结论时间</dt><dd>{{ fmt(domain.as_of) }}</dd></div>
        <div><dt>数据截止</dt><dd data-testid="domain-cutoff">{{ fmt(domain.data_cutoff) }}</dd></div>
        <div><dt>接入方式</dt><dd>{{ domain.source_mode === 'api' ? '接口拉取' : '人工录入' }}</dd></div>
      </dl>

      <table class="metric-table" data-testid="domain-metrics">
        <thead>
          <tr>
            <th>指标</th>
            <th>目标值</th>
            <th>实际值</th>
            <th>偏差</th>
            <th>偏差%</th>
            <th>阈值%</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="metric in domain.metrics" :key="metric.code" :data-metric-code="metric.code" data-testid="metric-row">
            <td>
              <span class="metric-table__name">{{ metric.name }}</span>
              <span class="metric-table__unit">{{ metric.unit ? `（${metric.unit}）` : '' }}</span>
              <span v-if="metric.data_status !== 'ok'" class="metric-table__status">{{ metric.data_status_label }}</span>
            </td>
            <td>{{ fmt(metric.target) }}</td>
            <td data-testid="metric-actual">{{ fmt(metric.actual) }}</td>
            <td :class="{ 'is-negative': metric.is_negative_deviation }" data-testid="metric-deviation">
              {{ fmt(metric.deviation_abs) }}
            </td>
            <td :class="{ 'is-negative': metric.is_negative_deviation }" data-testid="metric-deviation-pct">
              <template v-if="metric.deviation_available">{{ fmt(metric.deviation_pct, '%') }}</template>
              <span v-else class="metric-table__unavailable" data-testid="metric-deviation-unavailable">中心未上报</span>
            </td>
            <td>{{ fmt(metric.threshold_pct) }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="domain.reasons.length" class="domain-card__reasons">
        <h4 class="domain-card__subtitle">该域上报的原因项（{{ domain.reason_count }}）</h4>
        <ul class="cited-reasons" data-testid="domain-reasons">
          <li v-for="(reason, index) in domain.reasons" :key="index" data-testid="domain-reason">
            <span class="cited-reasons__name">{{ reason.name }}</span>
            <span class="cited-reasons__meta">
              {{ reason.metric_code }} · 贡献 {{ fmt(reason.contribution_pct, '%') }} · {{ reason.owner }}
            </span>
          </li>
        </ul>
      </div>
    </template>
  </article>
</template>
