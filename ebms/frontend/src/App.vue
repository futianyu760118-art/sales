<script setup>
// 应用外壳。两个场景化视图：
//   Result → Reason 归因视图（F2 / PAND-80，入口由 F1 结果总览提供）
//   跨域经营判断视图（F13 / PAND-91，入口由 EBMS 首页提供）
// 各自给出一组开发自检入口，便于无上游模块时验证本视图。
import { computed, ref } from 'vue';
import ReasonListView from './views/ReasonListView.vue';
import JudgmentView from './views/JudgmentView.vue';

const params = new URLSearchParams(window.location.search);

const view = ref(params.get('view') === 'judgment' ? 'judgment' : 'reason');

const metricId = ref(params.get('metric_id') ?? '');
const metricInput = ref(metricId.value);
const expandedTrail = ref([]);

const periodType = ref(params.get('period_type') ?? 'month');
const periodValue = ref(params.get('period_value') ?? '2026-08');

// 与 migrations/002_seed_dev.sql 对应的开发自检入口
const DEV_METRICS = [
  { id: 'm-revenue-202608', label: '营业收入（完全归因，含多级原因）' },
  { id: 'm-gross-margin-202608', label: '毛利率（部分归因）' },
  { id: 'm-otd-202608', label: '订单交付率（未归因）' },
];

// 与 migrations/004_seed_cross_domain.sql 对应的开发自检入口
const DEV_PERIODS = [
  { type: 'month', value: '2026-08', label: '2026-08（四域齐全）' },
  { type: 'month', value: '2026-09', label: '2026-09（供应链域数据缺失）' },
];

const hasMetric = computed(() => Boolean(metricId.value));

function syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('view', view.value);
  if (view.value === 'reason') url.searchParams.set('metric_id', metricId.value);
  else {
    url.searchParams.set('period_type', periodType.value);
    url.searchParams.set('period_value', periodValue.value);
  }
  window.history.replaceState({}, '', url);
}

function openView(next) {
  view.value = next;
  syncUrl();
}

function openMetric(id) {
  metricId.value = id;
  metricInput.value = id;
  view.value = 'reason';
  syncUrl();
}

function openPeriod(entry) {
  periodType.value = entry.type;
  periodValue.value = entry.value;
  view.value = 'judgment';
  syncUrl();
}

function onToggleChild(payload) {
  expandedTrail.value.push(payload);
}
</script>

<template>
  <main class="app">
    <h1 class="app__title">EBMS · 经营管理系统</h1>

    <nav class="view-switch" aria-label="视图切换">
      <button
        type="button"
        class="btn"
        :class="{ 'btn--primary': view === 'reason' }"
        data-testid="view-reason"
        @click="openView('reason')"
      >
        结果偏差归因（Result → Reason）
      </button>
      <button
        type="button"
        class="btn"
        :class="{ 'btn--primary': view === 'judgment' }"
        data-testid="view-judgment"
        @click="openView('judgment')"
      >
        跨域经营判断（四专业中心汇聚）
      </button>
    </nav>

    <template v-if="view === 'reason'">
      <section class="picker" aria-label="指标入口">
        <label class="field">
          <span>结果指标 ID</span>
          <input v-model="metricInput" data-testid="metric-input" @keyup.enter="openMetric(metricInput)" />
        </label>
        <button type="button" class="btn btn--primary" data-testid="metric-open" @click="openMetric(metricInput)">打开归因</button>
        <ul class="picker__quick" data-testid="dev-metrics">
          <li v-for="m in DEV_METRICS" :key="m.id">
            <button type="button" class="link" @click="openMetric(m.id)">{{ m.label }}</button>
            <code>{{ m.id }}</code>
          </li>
        </ul>
      </section>

      <ReasonListView v-if="hasMetric" :metric-id="metricId" @toggle-child="onToggleChild" />
      <p v-else class="hint">请选择一个结果指标以查看其偏差归因。</p>
    </template>

    <template v-else>
      <section class="picker" aria-label="判断周期入口">
        <span class="picker__label">开发自检周期</span>
        <ul class="picker__quick" data-testid="dev-periods">
          <li v-for="entry in DEV_PERIODS" :key="entry.value">
            <button type="button" class="link" @click="openPeriod(entry)">{{ entry.label }}</button>
            <code>{{ entry.value }}</code>
          </li>
        </ul>
      </section>

      <JudgmentView :period-type="periodType" :period-value="periodValue" />
    </template>
  </main>
</template>
