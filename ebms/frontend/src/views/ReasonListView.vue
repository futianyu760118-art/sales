<script setup>
// F2 / PAND-80：从任一结果指标的偏差穿透到原因项，显示影响方向与贡献占比。
// 视图挂载在 Result → Reason → Evidence → Source 链路的 Reason 层。
import { computed, ref, watch } from 'vue';
import { api } from '../api/client.js';
import ChainBreadcrumb from '../components/ChainBreadcrumb.vue';
import AttributionSummary from '../components/AttributionSummary.vue';
import ReasonNode from '../components/ReasonNode.vue';
import LinkReasonDialog from '../components/LinkReasonDialog.vue';

const props = defineProps({
  metricId: { type: String, required: true },
});

const data = ref(null);
const loading = ref(false);
const error = ref('');
const dialog = ref({ open: false, parentId: null, parentName: '' });

const isUnattributed = computed(() => data.value?.attribution?.status === 'unattributed');

function fmt(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.getReasons(props.metricId);
  } catch (err) {
    error.value = err.message;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => props.metricId, load, { immediate: true });

function openLink(parent = null) {
  dialog.value = { open: true, parentId: parent?.id ?? null, parentName: parent?.name ?? '' };
}

function closeLink() {
  dialog.value = { open: false, parentId: null, parentName: '' };
}

async function onLinked(res) {
  // 关联后以后端返回的最新归因结果为准，合计口径由后端计算
  data.value = res.result;
  closeLink();
}
</script>

<template>
  <section class="reason-view">
    <ChainBreadcrumb :layers="data?.chain?.layers" :current="data?.chain?.current ?? 'REASON'" />

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="error" role="alert">加载失败：{{ error }}</p>

    <template v-else-if="data">
      <header class="metric-header">
        <h2 class="metric-header__title">{{ data.result.name }}</h2>
        <dl class="metric-header__grid">
          <div><dt>目标值</dt><dd>{{ fmt(data.result.target, data.result.unit ? ` ${data.result.unit}` : '') }}</dd></div>
          <div><dt>实际值</dt><dd>{{ fmt(data.result.actual, data.result.unit ? ` ${data.result.unit}` : '') }}</dd></div>
          <div>
            <dt>偏差</dt>
            <dd :class="{ 'is-deviated': data.result.is_deviated }">
              {{ fmt(data.result.deviation_abs) }}（{{ fmt(data.result.deviation_pct, '%') }}）
              <template v-if="data.result.is_deviated">· 超阈值 {{ data.result.threshold_pct }}%</template>
            </dd>
          </div>
          <div><dt>期间</dt><dd>{{ data.result.period.value }}（{{ data.result.period.type }}）</dd></div>
          <div><dt>数据截止</dt><dd>{{ data.result.as_of ?? '—' }}</dd></div>
        </dl>
      </header>

      <AttributionSummary :attribution="data.attribution" />

      <!-- 边界：无关联原因时显示「未归因」并提供关联入口，不得显示空列表 -->
      <div v-if="isUnattributed" class="empty-state" data-testid="unattributed-state">
        <h3 class="empty-state__title">{{ data.empty_state.title }}</h3>
        <p class="empty-state__message">{{ data.empty_state.message }}</p>
        <button type="button" class="btn btn--primary" data-testid="link-entry" @click="openLink()">
          {{ data.empty_state.action.label }}
        </button>
      </div>

      <ul v-else class="reason-list" data-testid="reason-list">
        <ReasonNode
          v-for="root in data.reasons"
          :key="root.id"
          :node="root"
          :default-expanded="true"
          @toggle-child="(payload) => $emit('toggle-child', payload)"
        />
      </ul>

      <p v-if="!isUnattributed" class="reason-view__actions">
        <button type="button" class="btn" data-testid="link-more" @click="openLink()">继续关联原因</button>
      </p>

      <p v-if="data.integrity?.orphan_reason_ids?.length" class="warn" data-testid="integrity-warn">
        存在 {{ data.integrity.orphan_reason_ids.length }} 条父项缺失的原因项，未计入合计，请人工确认。
      </p>
    </template>

    <LinkReasonDialog
      v-if="dialog.open"
      :metric-id="metricId"
      :metric-name="data?.result?.name ?? ''"
      :parent-id="dialog.parentId"
      :parent-name="dialog.parentName"
      @linked="onLinked"
      @close="closeLink"
    />
  </section>
</template>
